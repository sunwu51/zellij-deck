import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { bridgeHost, validBridgeHost } from '../bridge/network.mjs';
const bundle = await build({ entryPoints: ['extension/network.ts'], bundle: true, write: false, format: 'esm' });
const { validBridgeIp } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('bridge defaults to loopback and accepts explicit interface selection', () => {
  assert.equal(bridgeHost([], {}), '127.0.0.1');
  assert.equal(bridgeHost([], { ZELLIJ_DECK_HOST: '192.168.1.10' }), '192.168.1.10');
  assert.equal(bridgeHost(['--host', '10.0.0.2'], { ZELLIJ_DECK_HOST: '192.168.1.10' }), '10.0.0.2');
  assert.equal(bridgeHost(['--host=10.0.0.3'], {}), '10.0.0.3');
  assert.equal(bridgeHost(['--host', '0.0.0.0'], {}), '0.0.0.0');
  assert.equal(bridgeHost([], { ZELLIJ_DECK_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(validBridgeIp('0.0.0.0'), false);
  assert.throws(() => bridgeHost(['--host'], {}));
  assert.throws(() => bridgeHost(['--other'], {}));
});
test('server and extension reject malformed and non-unicast addresses', () => {
  for (const ip of ['0.1.2.3', '224.0.0.1', '255.255.255.255', 'localhost', '::1', '192.168.1.256', '192.168.01.1', 'http://192.168.1.1', '1.2.3.4:17329', '']) {
    assert.throws(() => bridgeHost(['--host', ip], {}), ip);
    assert.equal(validBridgeIp(ip), false, ip);
  }
  for (const ip of ['127.0.0.1', '192.168.1.10', '10.0.0.2']) assert.equal(validBridgeIp(ip), true);
});

test('wildcard listener validates Host against the connection destination', () => {
  const request = host => ({ headers: { host }, socket: { localAddress: '192.168.1.10' } });
  assert.equal(validBridgeHost(request('192.168.1.10:17329'), '0.0.0.0', 17329), true);
  for (const host of ['evil.example:17329', '0.0.0.0:17329', '192.168.1.11:17329', '192.168.1.10:1234', undefined]) {
    assert.equal(validBridgeHost(request(host), '0.0.0.0', 17329), false);
  }
  assert.equal(validBridgeHost(request('127.0.0.1:17329'), '127.0.0.1', 17329), true);
  assert.equal(validBridgeHost(request('192.168.1.10:17329'), '127.0.0.1', 17329), false);
});
