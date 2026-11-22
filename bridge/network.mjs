import { isIPv4 } from 'node:net';
import { setting } from './env.mjs';

// Keep loopback as the default; all-interface listening requires explicit selection.
export function bridgeHost(args, env = process.env) {
  let host = setting(env, 'HOST') || '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host') {
      if (!args[i + 1]) throw new Error('--host requires an IPv4 address.');
      host = args[++i];
    } else if (args[i].startsWith('--host=')) host = args[i].slice(7);
    else throw new Error(`Unknown bridge argument: ${args[i]}`);
  }
  if (host !== '0.0.0.0' && (!isIPv4(host) || host.startsWith('0.') || Number(host.split('.')[0]) >= 224)) {
    throw new Error('Bridge host must be a unicast IPv4 address or 0.0.0.0.');
  }
  return host;
}

// A wildcard bind still accepts only the actual destination IP, never arbitrary Host names.
export function validBridgeHost(req, host, port) {
  const destination = host === '0.0.0.0' ? req.socket.localAddress : host;
  return isIPv4(destination || '') && req.headers.host === `${destination}:${port}`;
}
