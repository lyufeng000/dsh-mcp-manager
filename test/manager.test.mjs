import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { McpManager } from '../lib/manager.js';
import { MCP_MODULE } from '../lib/model.js';
import * as hostPlugin from '../lib/index.js';
const runtime = process.env.DSH_MCP_TEST_RUNTIME;
const base = serverName => ({ serverName, transport: 'stdio', command: 'node', args: [], cwd: '', env: [], enabled: false });

async function fixture() {
  const require = createRequire(join(runtime, 'package.json'));
  const load = specifier => import(pathToFileURL(require.resolve(specifier)).href);
  const [cordis, atomic, yaml, jsYaml, mcp, include, realBoot] = await Promise.all(['@deepseek-ai/cordis', '@deepseek-ai/dsh-atomic-write', 'yaml', 'js-yaml', MCP_MODULE, '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/dsh-app-boot'].map(load));
  const ctx = new cordis.Context();
  const registered = new Map(), credentials = new Map(), records = new Map();
  ctx.provide('tools', { register: definition => { registered.set(definition.name, definition); return () => registered.delete(definition.name); } });
  ctx.provide('credentials', {
    modifyRecord: async (key, update) => { const next = await update(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); },
    resolve: async ref => credentials.has(ref) ? { value: credentials.get(ref), source: 'test' } : undefined,
    describe: async ref => ({ configured: credentials.has(ref), writable: true }),
    set: async (ref, value) => { credentials.set(ref, value); }, unset: async ref => { credentials.delete(ref); }
  });
  const root = process.env.DSH_MCP_TEST_ROOT ?? 'D:/Data/.temp/mcp-manager-tests';
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'profile-'));
  const patchPath = join(dir, 'cordis.patch.yml');
  await writeFile(patchPath, '[]\n');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
  const home = join(dir, 'home');
  await mkdir(home);
  ctx.provide('profileContext', { dir, patchPath, home, overlays: [], installAnchor: join(runtime, 'package.json') });
  const entries = [];
  ctx.provide('loader', { entries: () => entries.values(), import: load });
  ctx.provide('configEditor', { entries: () => entries });
  let reconciled;
  const boot = {
    readProfilePatches: realBoot.readProfilePatches,
    loadProfileDirectory: realBoot.loadProfileDirectory, composeEntries: realBoot.composeEntries,
    reconcileProfilePatches: async (_ctx, patches) => { reconciled = patches; }
  };
  const manager = new McpManager(ctx, { atomic, yaml, jsYaml: jsYaml.default, mcp, boot, include });
  return { ctx, manager, registered, credentials, dir, patchPath, entries, get reconciled() { return reconciled; } };
}

const rpcRequest = (endpoint, payload = {}, options = {}) => new Request(`http://127.0.0.1/api/mcp-manager/${endpoint}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'mcp-test', method: `mcp-manager/${endpoint}`, payload }), ...options
});

test('Host exact RPC routes validate envelopes, redact errors and dispose', { skip: !runtime, timeout: 5000 }, async () => {
  const f = await fixture(), routes = new Map();
  f.ctx.provide('connection', { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } } });
  const fiber = f.ctx.plugin(hostPlugin);
  try {
    await fiber.await();
    assert.equal(fiber.state, 2);
    const call = async (endpoint, payload, options) => routes.get(`/api/mcp-manager/${endpoint}`).fetch(rpcRequest(endpoint, payload, options));
    const response = await (await call('state', {})).json();
    assert.equal(response.type, 'server-response'); assert.equal(response.rpcId, 'mcp-test'); assert.equal(response.result.ok, true);
    assert.equal((await (await call('save', { revision: 0, server: base('from-rpc') })).json()).result.ok, true);
    const mismatch = await (await call('state', {}, { body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'save', payload: {} }) })).json();
    assert.equal(mismatch.result.ok, false);
    assert.equal((await call('state', {}, { body: '{' })).status, 400);
    assert.equal((await call('state', {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await call('state', {}, { body: ' '.repeat(263169) })).status, 413);
    assert.equal(routes.size, 5);
    assert.ok(!routes.has('/api/mcp-manager/__proto__'));
  } finally { await fiber.dispose(); }
  assert.equal(routes.size, 0);
});

test('Real Connection provider fiber reproduces getter bug; exact routes work and release', { skip: !runtime, timeout: 5000 }, async () => {
  const f = await fixture();
  const connectionModule = await f.ctx.loader.import('@deepseek-ai/dsh-client-connection');
  const webProvider = f.ctx.plugin({ name: 'web-provider-test', apply(ctx) { ctx.provide('webServer', { register: () => () => {} }); } });
  await webProvider.await();
  let connection;
  const provider = f.ctx.plugin({ name: 'connection-provider-test', inject: ['credentials'], apply(ctx) {
    connection = new connectionModule.HostConnectionService(ctx, ['127.0.0.1'], { isAuthenticated: request => request.headers.cookie === 'test-auth=1' });
  } });
  await provider.await();
  const legacy = f.ctx.plugin({ name: 'legacy-route-test', inject: ['connection', 'webServer'], async apply(ctx) {
    await Promise.resolve();
    ctx.effect(() => ctx.connection.rpc.handle('/legacy-mcp-test', async () => ({ ok: true, value: {} })));
  } });
  await assert.rejects(legacy.await(), /webServer.*without inject/);
  const fiber = f.ctx.plugin(hostPlugin);
  try {
    await fiber.await(); assert.equal(fiber.state, 2);
    const shared = connection.createSharedFetchHandler('/api');
    assert.equal(connection.admit({ headers: { host: '127.0.0.1' } }).rejection, 401);
    assert.equal(connection.admit({ headers: { host: 'evil.invalid', cookie: 'test-auth=1' } }).rejection, 403);
    assert.ok(connection.admit({ headers: { host: '127.0.0.1', cookie: 'test-auth=1' } }).peer);
    const reply = await shared.fetch(rpcRequest('state'));
    assert.equal(reply.status, 200); assert.equal((await reply.json()).result.ok, true);
    assert.equal((await shared.fetch(new Request('http://127.0.0.1/api/mcp-manager/state'))).status, 404);
    assert.equal((await shared.fetch(rpcRequest('__proto__'))).status, 404);
  } finally { await fiber.dispose(); }
  assert.equal((await connection.createSharedFetchHandler('/api').fetch(rpcRequest('state'))).status, 404);
  await legacy.dispose(); await connection.operator.dispose(); await provider.dispose(); await webProvider.dispose();
});

test('Official authenticated HTTP carrier serves manager RPC and rejects unauthenticated/foreign origin', { skip: !runtime, timeout: 10000 }, async () => {
  const f = await fixture(), routes = new Map();
  const module = await f.ctx.loader.import('@deepseek-ai/dsh-client-connection');
  const web = f.ctx.plugin({ name: 'http-web-test', apply(ctx) {
    ctx.provide('webServer', { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } });
  } });
  await web.await();
  const provider = f.ctx.plugin(module, { trustedHosts: ['127.0.0.1'] });
  await provider.await();
  const fiber = f.ctx.plugin(hostPlugin);
  await fiber.await();
  const connection = f.ctx.connection;
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path.startsWith('/api/')) void routes.get('/api').handler(req, res).catch(() => { res.writeHead(500); res.end('test carrier failed'); });
    else if (connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('test index'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(connection.authenticatedUrl(`${baseUrl}/`), { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const request = rpcRequest('state');
    const body = await request.text();
    const post = extra => fetch(`${baseUrl}/api/mcp-manager/state`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ cookie, origin: 'https://evil.invalid' })).status, 403);
    const response = await post({ cookie });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(module.serverResponseSchema.safeParse(message).success, true);
    assert.equal(message.result.ok, true); assert.ok(Array.isArray(message.result.value.servers));
    await fiber.dispose();
    assert.equal((await post({ cookie })).status, 404);
  } finally {
    await fiber.dispose(); await connection.operator.dispose(); await provider.dispose(); await web.dispose();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('real atomic persistence, optimistic concurrency, secret redaction, removal', { skip: !runtime }, async () => {
  const f = await fixture();
  try {
    await f.manager.save({ revision: 0, server: { ...base('one'), env: [{ key: 'API_KEY', mode: 'secret', value: 'synthetic-test-key' }] } });
    const state = await f.manager.state();
    assert.equal(state.revision, 1);
    assert.equal(state.servers[0].env[0].configured, true);
    assert.ok(!JSON.stringify(state).includes('synthetic-test-key'));
    assert.ok(!(await readFile(f.manager.path, 'utf8')).includes('synthetic-test-key'));
    await assert.rejects(f.manager.save({ revision: 0, server: base('two') }), /其他页面/);
    await f.manager.remove({ revision: 1, id: state.servers[0].id });
    assert.equal((await f.manager.state()).servers.length, 0);
    assert.equal(f.credentials.size, 1);
    assert.equal(JSON.parse(await readFile(`${f.manager.path}.bak`, 'utf8')).servers.length, 1);
    await writeFile(f.manager.path, '{broken');
    await assert.rejects(f.manager.save({ revision: 2, server: base('three') }), /不会覆盖/);
    assert.equal(await readFile(f.manager.path, 'utf8'), '{broken');
  } finally { await f.manager.dispose(); }
});

test('failed credential/config commit does not corrupt previous settings', { skip: !runtime }, async () => {
  const f = await fixture();
  try {
    const real = f.manager.atomic;
    f.manager.atomic = { ...real, writeFileAtomic: async () => { throw Error('synthetic disk failure'); } };
    await assert.rejects(f.manager.save({ revision: 0, server: { ...base('one'), env: [{ key: 'TOKEN', mode: 'secret', value: 'synthetic' }] } }));
    assert.equal(f.credentials.size, 0);
    assert.equal((await f.manager.read()).revision, 0);
  } finally { await f.manager.dispose(); }
});

test('profile-owned external removal protects builtins and preserves YAML js expressions', { skip: !runtime }, async () => {
  const f = await fixture();
  try {
    const third = { id: 'include:third', options: { id: 'third', name: MCP_MODULE, config: { serverName: 'third' } }, disabled: false };
    const builtin = { id: 'include:builtin', options: { id: 'builtin', name: MCP_MODULE, config: { serverName: 'builtin' } }, disabled: false };
    f.entries.push(third, builtin);
    await writeFile(f.patchPath, `- insert:\n    - id: third\n      name: '${MCP_MODULE}'\n      config:\n        serverName: third\n    - id: sibling\n      name: another-plugin\n- id: unrelated\n  config:\n    x: !!js 'process.env.TEST'\n    text: 'a: b'\n`);
    assert.equal((await f.manager.state()).external.find(item => item.id === third.id).removable, true);
    await assert.rejects(f.manager.removeExternal({ id: builtin.id }), /受保护/);
    await f.manager.removeExternal({ id: third.id });
    const content = await readFile(f.patchPath, 'utf8');
    const parsed = f.manager.jsYaml.load(content, { schema: f.manager.include.entryListSchema });
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].insert[0].id, 'sibling');
    assert.equal(parsed[0].insert.length, 1);
    assert.equal(parsed[1].id, 'unrelated');
    assert.equal(parsed[1].config.x.__jsExpr, 'process.env.TEST');
    assert.equal(parsed[1].config.text, 'a: b');
  } finally { await f.manager.dispose(); }
});

test('external removal rolls back file on reconciliation failure and protects higher overlays', { skip: !runtime }, async () => {
  const f = await fixture();
  const source = `- insert:\n    - id: third\n      name: '${MCP_MODULE}'\n      config:\n        serverName: third\n`;
  f.entries.push({ id: 'include:third', options: { id: 'third', name: MCP_MODULE, config: { serverName: 'third' } }, disabled: false });
  try {
    await writeFile(f.patchPath, source);
    let calls = 0;
    f.manager.boot = { ...f.manager.boot, reconcileProfilePatches: async () => { if (!calls++) throw new Error('synthetic reconciliation failure'); } };
    await assert.rejects(f.manager.removeExternal({ id: 'include:third' }), /synthetic/);
    assert.equal(await readFile(f.patchPath, 'utf8'), source);
    assert.equal(calls, 2);
    f.ctx.profileContext.overlays.push({ insert: [{ id: 'third', name: MCP_MODULE, config: { serverName: 'third' } }] });
    await assert.rejects(f.manager.removeExternal({ id: 'include:third' }), /更高优先级/);
    assert.equal(await readFile(f.patchPath, 'utf8'), source);
  } finally { await f.manager.dispose(); }
});

test('official Streamable HTTP bridge sends secret header without persisting its value', { skip: !runtime, timeout: 15000 }, async () => {
  const f = await fixture();
  let observedAuthorization;
  const http = createServer(async (request, response) => {
    observedAuthorization = request.headers.authorization;
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const q = JSON.parse(body);
    if (q.id === undefined) { response.writeHead(202).end(); return; }
    let result = {};
    if (q.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } };
    if (q.method === 'tools/list') result = { tools: [{ name: 'hello', inputSchema: { type: 'object', properties: {} } }] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    await f.manager.save({ revision: 0, server: { serverName: 'remote', transport: 'streamable-http', url: `http://127.0.0.1:${http.address().port}/mcp`, enabled: true, headers: [{ key: 'Authorization', mode: 'secret', value: 'Bearer synthetic-http-token' }] } });
    for (let i = 0; i < 100 && !f.registered.size; i++) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(f.registered.has('mcp__remote__hello'));
    assert.equal(observedAuthorization, 'Bearer synthetic-http-token');
    assert.ok(!(await readFile(f.manager.path, 'utf8')).includes('synthetic-http-token'));
    assert.ok(!JSON.stringify(await f.manager.state()).includes('synthetic-http-token'));
  } finally {
    await f.manager.dispose();
    await new Promise(resolve => http.close(resolve));
  }
});

test('official MCP bridge over real stdio, two instances, tool discovery, stop and reconnect', { skip: !runtime, timeout: 20000 }, async () => {
  const f = await fixture();
  const script = join(f.dir, 'fake-mcp.cjs');
  await writeFile(script, `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result={};if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'local-fixture',version:'1'}};if(q.method==='tools/list')result={tools:[{name:'ping',description:'Test ping',inputSchema:{type:'object',properties:{}}}]};if(q.method==='tools/call')result={content:[{type:'text',text:'pong'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
  const wait = async condition => {
    for (let i = 0; i < 150; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('fixture timeout');
  };
  try {
    await f.manager.save({ revision: 0, server: { ...base('one'), enabled: true, command: process.execPath, args: [script] } });
    await f.manager.save({ revision: 1, server: { ...base('two'), enabled: true, command: process.execPath, args: [script] } });
    await wait(() => f.registered.size === 2);
    assert.ok(f.registered.has('mcp__one__ping'));
    assert.ok(f.registered.has('mcp__two__ping'));
    await wait(() => [...f.manager.running.values()].every(item => item.status === 'active'));
    let state = await f.manager.state();
    await f.manager.restart({ revision: state.revision, id: state.servers[0].id });
    await wait(() => f.registered.size === 2 && [...f.manager.running.values()].every(item => item.status === 'active'));
    await f.manager.remove({ revision: state.revision, id: state.servers[0].id });
    await wait(() => f.registered.size === 1);
    assert.ok(f.registered.has('mcp__two__ping'));
    state = await f.manager.state();
    await f.manager.save({ revision: state.revision, id: state.servers[0].id, server: { ...state.servers[0], enabled: false } });
    assert.equal(f.registered.size, 0);
  } finally { await f.manager.dispose(); }
});
