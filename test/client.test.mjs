import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const runtime = process.env.DSH_MCP_TEST_RUNTIME;

test('Primary buttons use contrasting theme text/surface colors, never fixed white text', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const rule = source.match(/\.mcpm \.primary\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  assert.match(rule, /background:var\(--dsw-alias-label-primary,#222\)/);
  assert.match(rule, /(?:^|;)color:var\(--dsw-alias-bg-base,#fff\)/);
  assert.doesNotMatch(rule, /color:\s*(?:white|#fff)\s*[;}]/i);
});

test('Client registers the additive Settings slot with stable injected face and sanitized RPC', { skip: !runtime }, async () => {
  // DSH ships React in the browser bundle, not as a Node package. Exercise the
  // dynamic-module/Slot contract with a minimal hook adapter; visual testing is separate.
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => [initial, () => {}], useEffect: () => {}, useRef: initial => ({ current: initial }) };
  const require = name => { assert.equal(name, 'react'); return React; };
  let bundle, registration, component;
  const timers = [];
  const sandbox = { window: { __ModuleLoader__: { load: value => { bundle = value; } }, confirm: () => true }, setInterval: (...args) => { timers.push(args); return 1; }, clearInterval: () => {}, console };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  assert.equal(bundle.id, 'dsh-mcp-manager');
  const plugin = bundle.factory(require);
  let calls = 0, bad = false;
  plugin.apply({
    slots: { inject: (name, callback) => { assert.equal(name, 'settings.section'); return callback(); }, register: (options, view) => { registration = options; component = view; } },
    connection: { rpc: { call: async (channel, endpoint) => {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'mcp-manager/state'); calls++;
      if (bad === 'transport') throw new Error('transport failure for /api/mcp-manager/state: HTTP 404');
      return bad ? { ok: false, error: { message: 'safe error' } } : { ok: true, value: { revision: 0, servers: [], external: [] } };
    } } }
  });
  assert.equal(registration.id, 'mcp-manager');
  assert.equal(registration.label, 'MCP 服务器');
  assert.equal(registration.inject(), registration.inject());
  const face = registration.inject();
  await face.api('state', {});
  assert.equal(calls, 1);
  bad = true;
  await assert.rejects(face.api('state', {}), /safe error/);
  bad = 'transport';
  await assert.rejects(face.api('state', {}), /完全退出并重新打开 DSH/);
  const tree = component(face);
  const markup = JSON.stringify(tree);
  assert.ok(markup.includes('MCP 服务器'));
  assert.ok(markup.includes('添加服务器'));
  assert.ok(markup.includes('正在读取'));
  assert.ok(!markup.includes('localStorage'));
});
