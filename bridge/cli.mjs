#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const HELP = `Zellij Deck bridge — local WebSocket bridge for the Zellij Deck Chrome extension.

Usage: npx -y zellij-deck [--port <1024-65535>] [--host <ipv4>]

  --port <n>   Listening port (default 17329; env ZELLIJ_DECK_PORT)
  --host <ip>  IPv4 interface or 0.0.0.0 (default 127.0.0.1; env ZELLIJ_DECK_HOST)
  --version    Print the version
  --help       Show this help

Requires Node.js 22+ and Zellij on PATH (or ZELLIJ_PATH). State, including the pairing token,
lives in ~/.zellij-deck (override with ZELLIJ_DECK_STATE_DIR).
`;

// Handle the package-level flags here; everything else is left for the bridge's own parser.
const args = process.argv.slice(2);
const rest = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); process.exit(0); }
  if (arg === '--version' || arg === '-v') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    process.exit(0);
  }
  if (arg === '--port' || arg.startsWith('--port=')) {
    const value = arg === '--port' ? args[++i] : arg.slice(7);
    if (!value) { console.error('--port requires a number.'); process.exit(1); }
    process.env.ZELLIJ_DECK_PORT = value;
  } else rest.push(arg);
}
process.argv.splice(2, process.argv.length, ...rest);
await import('./server.mjs');
