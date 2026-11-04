import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pageLines } from './text.mjs';

export const MAX_STREAM_CHARS = 4 * 1024 * 1024;
export const MAX_RUNNING_JOBS = 8;
export const MAX_KEPT_JOBS = 30;

/** Bounded line buffer: drops whole lines from the head while keeping absolute line numbers. */
class StreamBuffer {
  constructor(limit = MAX_STREAM_CHARS) {
    this.limit = limit;
    this.text = '';
    this.dropped = 0; // absolute index of the first retained line
    this.decoder = new TextDecoder();
  }
  push(chunk) {
    this.text += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.text.length > this.limit) {
      const cut = this.text.indexOf('\n', this.text.length - this.limit);
      const removed = cut === -1 ? this.text.slice(0, this.text.length - this.limit) : this.text.slice(0, cut + 1);
      this.dropped += (removed.match(/\n/g) || []).length;
      this.text = this.text.slice(removed.length);
    }
  }
  end() { this.push(this.decoder.decode()); }
  lines() {
    const lines = this.text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  page(options) { return pageLines(this.lines(), options, this.dropped); }
}

/** Windows only: prefer PowerShell 7 when installed. */
function preferredPowerShell(env) {
  try {
    execFileSync('where.exe', ['pwsh.exe'], { stdio: 'ignore', windowsHide: true, timeout: 3000, env });
    return 'pwsh.exe';
  } catch { return 'powershell.exe'; }
}

/** How a shell command string is run on this platform. */
export function shellCommand(command, { platform = process.platform, env = process.env, powershell } = {}) {
  if (platform === 'win32') {
    const exe = powershell || 'powershell.exe';
    // Emit UTF-8 so non-ASCII output survives the pipe.
    return [exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${command}`]];
  }
  return [env.SHELL && /^\/[\w/.-]+$/.test(env.SHELL) ? env.SHELL : '/bin/sh', ['-c', command]];
}

export class JobManager {
  constructor({ cwd, env, platform = process.platform } = {}) {
    this.cwd = cwd;
    this.env = env;
    this.platform = platform;
    this.jobs = new Map();
    this.powershell = platform === 'win32' ? preferredPowerShell(env || process.env) : undefined;
  }

  start(owner, { command, argv, cwd, stdin }) {
    const running = [...this.jobs.values()].filter(job => job.owner === owner && job.status === 'running').length;
    if (running >= MAX_RUNNING_JOBS) throw new Error(`At most ${MAX_RUNNING_JOBS} jobs can run at once per MCP session. Wait for or kill a job first.`);
    let file, args;
    if (Array.isArray(argv)) {
      if (!argv.length || argv.some(item => typeof item !== 'string') || argv.join('').length > 32_768) throw new Error('argv must be a non-empty array of strings.');
      [file, ...args] = argv;
    } else if (typeof command === 'string' && command.trim() && command.length <= 32_768) {
      [file, args] = shellCommand(command, { platform: this.platform, env: this.env, powershell: this.powershell });
    } else throw new Error('Provide either command (a shell command string) or argv (an argument array).');
    const id = `job_${randomBytes(6).toString('hex')}`;
    const child = spawn(file, args, {
      cwd: cwd || this.cwd, env: this.env, windowsHide: true,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // A process group lets job_kill stop the whole tree on macOS/Linux.
      detached: this.platform !== 'win32',
    });
    const job = {
      id, owner, command: command ?? argv.join(' '), cwd: cwd || this.cwd, pid: child.pid,
      status: 'running', exitCode: null, signal: null, error: null,
      started: Date.now(), ended: null, child,
      stdout: new StreamBuffer(), stderr: new StreamBuffer(),
      done: undefined,
    };
    job.done = new Promise(resolve => {
      const finish = () => {
        job.stdout.end();
        job.stderr.end();
        job.ended = Date.now();
        job.child = undefined;
        resolve();
      };
      child.on('error', error => {
        job.error = error.message;
        if (job.status === 'running') job.status = 'failed';
        finish();
      });
      child.on('close', (code, signal) => {
        if (job.ended) return;
        job.exitCode = code;
        job.signal = signal;
        if (job.status === 'running') job.status = 'exited';
        finish();
      });
    });
    child.stdout.on('data', chunk => job.stdout.push(chunk));
    child.stderr.on('data', chunk => job.stderr.push(chunk));
    if (stdin !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(String(stdin));
    }
    this.jobs.set(id, job);
    this.prune(owner);
    return job;
  }

  get(owner, id) {
    const job = this.jobs.get(id);
    return job && job.owner === owner ? job : undefined;
  }
  list(owner) { return [...this.jobs.values()].filter(job => job.owner === owner); }

  async wait(job, ms, signal) {
    if (job.status !== 'running') return true;
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
    const aborted = new Promise(resolve => signal?.addEventListener('abort', () => resolve(false), { once: true }));
    try { return await Promise.race([job.done.then(() => true), timeout, aborted]); }
    finally { clearTimeout(timer); }
  }

  kill(job) {
    if (job.status !== 'running' || !job.child) return false;
    job.status = 'killed';
    const pid = job.child.pid;
    if (this.platform === 'win32') {
      spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { job.child.kill('SIGTERM'); } catch {} }
      setTimeout(() => { if (!job.ended) { try { process.kill(-pid, 'SIGKILL'); } catch {} } }, 3000).unref();
    }
    return true;
  }

  /** Stop and forget every job of an owner (MCP session terminated). */
  dropOwner(owner) {
    for (const job of this.list(owner)) {
      this.kill(job);
      this.jobs.delete(job.id);
    }
  }

  prune(owner) {
    const finished = this.list(owner).filter(job => job.status !== 'running').sort((a, b) => a.started - b.started);
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_KEPT_JOBS))) this.jobs.delete(job.id);
  }

  summary(job, { tail = 100 } = {}) {
    return {
      job_id: job.id,
      status: job.status,
      exit_code: job.exitCode,
      ...(job.signal ? { signal: job.signal } : {}),
      ...(job.error ? { error: job.error } : {}),
      pid: job.pid,
      command: job.command.length > 300 ? `${job.command.slice(0, 300)}…` : job.command,
      cwd: job.cwd,
      duration_ms: (job.ended ?? Date.now()) - job.started,
      stdout: job.stdout.page({ tail }),
      stderr: job.stderr.page({ tail }),
    };
  }

  shutdown() {
    for (const job of this.jobs.values()) this.kill(job);
  }
}
