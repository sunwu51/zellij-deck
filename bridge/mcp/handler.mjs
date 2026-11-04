import { ToolError, SERVER_INSTRUCTIONS } from './tools.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const MAX_BODY_BYTES = 1024 * 1024;
const SWEEP_INTERVAL_MS = 5 * 60_000;

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('Request body too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers });
  res.end(payload);
}

/**
 * Streamable HTTP MCP endpoint (JSON responses, no server-initiated stream).
 * Session rules follow the MCP specification: `initialize` issues Mcp-Session-Id; every
 * later request must carry it (400 if missing, 404 if unknown or expired); DELETE ends it.
 */
export function createMcpHandler({ store, tools, serverInfo, log = console }) {
  async function sweep() {
    const { owners, abandoned } = store.sweep();
    for (const owner of owners) {
      const released = await tools.releaseOwner(owner);
      log.log?.(`MCP session expired after inactivity; released ${released.length} terminal session(s).`);
    }
    for (const name of abandoned) await tools.releaseSession(name);
  }
  const timer = setInterval(() => { void sweep().catch(error => log.error?.(`MCP sweep failed: ${error.message}`)); }, SWEEP_INTERVAL_MS);
  timer.unref();

  async function dispatch(message, owner, signal) {
    const { id, method, params } = message;
    switch (method) {
      case 'ping': return rpcResult(id, {});
      case 'tools/list': return rpcResult(id, { tools: tools.definitions });
      case 'resources/list': return rpcResult(id, { resources: [] });
      case 'resources/templates/list': return rpcResult(id, { resourceTemplates: [] });
      case 'prompts/list': return rpcResult(id, { prompts: [] });
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') return rpcError(id, -32602, 'tools/call requires params.name.');
        if (!tools.has(params.name)) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const result = await tools.call(params.name, params.arguments, { owner, signal });
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
        } catch (error) {
          // Tool failures are results the model can read and react to, not protocol errors.
          const message = error instanceof ToolError ? error.message : `Tool failed: ${error.message || error}`;
          if (!(error instanceof ToolError)) log.error?.(`MCP tool ${params.name} failed:`, error);
          return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
        }
      }
      default: return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  async function handlePost(req, res) {
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); }
    catch (error) { return send(res, error.status || 400, rpcError(null, -32700, error.status ? error.message : 'Parse error.')); }
    const batch = Array.isArray(parsed);
    const messages = batch ? parsed : [parsed];
    if (!messages.length || messages.some(message => !message || typeof message !== 'object' || message.jsonrpc !== '2.0')) {
      return send(res, 400, rpcError(null, -32600, 'Invalid JSON-RPC request.'));
    }

    const initialize = messages.find(message => message.method === 'initialize');
    if (initialize) {
      if (batch && messages.length > 1) return send(res, 400, rpcError(initialize.id, -32600, 'initialize must not be batched.'));
      const requested = initialize.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
      const sessionId = store.create(initialize.params?.clientInfo);
      return send(res, 200, rpcResult(initialize.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: SERVER_INSTRUCTIONS,
      }), { 'Mcp-Session-Id': sessionId });
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !sessionId) {
      return send(res, 400, rpcError(messages[0].id, -32000, 'Missing Mcp-Session-Id header. Send initialize first.'));
    }
    if (!store.touch(sessionId)) {
      // An expired-but-unswept session: release its terminals now rather than at the next sweep.
      if (store.sessions.has(sessionId)) void sweep().catch(error => log.error?.(`MCP sweep failed: ${error.message}`));
      return send(res, 404, rpcError(messages[0].id, -32001, 'Session not found or expired. Send initialize to start a new session.'));
    }

    const requests = messages.filter(message => message.id !== undefined && message.id !== null && typeof message.method === 'string');
    // Notifications and client responses need no reply.
    if (!requests.length) return send(res, 202);

    // Cancel long waits when the client gives up on the HTTP request.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const replies = await Promise.all(requests.map(message => dispatch(message, sessionId, controller.signal)));
    return send(res, 200, batch ? replies : replies[0]);
  }

  async function handleDelete(req, res) {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string' || !sessionId) return send(res, 400, rpcError(null, -32000, 'Missing Mcp-Session-Id header.'));
    if (!store.sessions.has(sessionId)) return send(res, 404, rpcError(null, -32001, 'Session not found.'));
    store.terminate(sessionId);
    const released = await tools.releaseOwner(sessionId);
    return send(res, 200, { terminated: true, released_sessions: released });
  }

  return {
    sweep,
    close() { clearInterval(timer); },
    async handle(req, res) {
      try {
        if (req.method === 'POST') return await handlePost(req, res);
        if (req.method === 'DELETE') return await handleDelete(req, res);
        // No server-initiated SSE stream; the specification allows 405 here.
        return send(res, 405, rpcError(null, -32000, 'Method not allowed.'), { Allow: 'POST, DELETE, OPTIONS' });
      } catch (error) {
        log.error?.('MCP request failed:', error);
        return send(res, 500, rpcError(null, -32603, 'Internal error.'));
      }
    },
  };
}
