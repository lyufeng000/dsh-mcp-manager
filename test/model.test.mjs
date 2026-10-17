import test from 'node:test';
import assert from 'node:assert/strict';
import { validateServer, validateStored, publicServer, resolvedConfig, externalSummary } from '../lib/model.js';
const base = () => ({ serverName: 'example', transport: 'stdio', command: 'node', args: [], cwd: '', enabled: false, env: [] });

test('stdio + HTTP validation and duplicate-name protection', () => {
  assert.equal(validateServer(base()).server.command, 'node');
  assert.throws(() => validateServer(base(), undefined, ['example']), /已被使用/);
  assert.throws(() => validateServer({ ...base(), serverName: 'bad name' }));
  assert.throws(() => validateServer({ ...base(), args: [1] }));
  assert.throws(() => validateServer({ ...base(), transport: 'sse' }));
  assert.throws(() => validateServer({ ...base(), toolCallTimeoutMs: 0 }));
  assert.equal(validateServer({ ...base(), transport: 'streamable-http', url: 'https://example.com/mcp', headers: [] }).server.url, 'https://example.com/mcp');
  for (const url of ['file:///a', 'https://user:pass@example.com/mcp', 'https://example.com/mcp?api_key=hidden']) assert.throws(() => validateServer({ ...base(), transport: 'streamable-http', url, headers: [] }));
});

test('secrets are references on disk, never returned, and blank preserves previous', async () => {
  const { server, writes } = validateServer({ ...base(), env: [{ key: 'API_KEY', mode: 'secret', value: 'synthetic-secret' }] });
  assert.equal(writes[0].value, 'synthetic-secret');
  assert.ok(!JSON.stringify(server).includes('synthetic-secret'));
  const visible = await publicServer(server, { describe: async () => ({ configured: true, writable: true }) });
  assert.deepEqual(visible.env, [{ key: 'API_KEY', mode: 'secret', configured: true, writable: true }]);
  const preserved = validateServer({ ...base(), env: [{ key: 'API_KEY', mode: 'secret', value: '' }] }, server);
  assert.equal(preserved.server.env[0].ref, server.env[0].ref);
  assert.deepEqual(preserved.writes, []);
  const changed = validateServer({ ...base(), env: [{ key: 'API_KEY', mode: 'secret', value: 'new-value' }] }, server);
  assert.notEqual(changed.server.env[0].ref, server.env[0].ref);
  const config = await resolvedConfig(server, { resolve: async () => ({ value: 'synthetic-secret' }) });
  assert.equal(config.env.API_KEY, 'synthetic-secret');
  await assert.rejects(resolvedConfig(server, { resolve: async () => undefined }), /未配置/);
});

test('header injection, duplicate keys, prototype pollution and plaintext credentials rejected', () => {
  for (const env of [
    [{ key: '__proto__', mode: 'literal', value: 'x' }],
    [{ key: 'DSH_TOKEN', mode: 'secret', value: 'x' }],
    [{ key: 'API_KEY', mode: 'literal', value: 'x' }],
    [{ key: 'A', mode: 'literal', value: 'x' }, { key: 'A', mode: 'literal', value: 'y' }]
  ]) assert.throws(() => validateServer({ ...base(), env }));
  const http = { ...base(), transport: 'streamable-http', url: 'https://example.com/mcp' };
  assert.throws(() => validateServer({ ...http, headers: [{ key: 'Authorization', mode: 'secret', value: 'a\r\nb' }] }));
  assert.throws(() => validateServer({ ...http, headers: [{ key: 'X-Test', mode: 'literal', value: '1' }, { key: 'x-test', mode: 'literal', value: '2' }] }));
});

test('stored documents normalize the validated representation and public rows project only active fields', async () => {
  const { server } = validateServer(base());
  const dirty = { ...server, serverName: ' example ', command: ' node ', headers: [{ key: 'Authorization', value: 'inactive-secret' }], token: 'extra-secret', env: [{ key: ' NORMAL ', mode: 'literal', value: 'ok', hidden: 'row-secret' }] };
  const clean = validateStored({ version: 1, revision: 1, servers: [dirty], hidden: 'document-secret' });
  assert.equal(clean.servers[0].serverName, 'example');
  assert.equal(clean.servers[0].command, 'node');
  assert.deepEqual(clean.servers[0].env, [{ key: 'NORMAL', mode: 'literal', value: 'ok' }]);
  assert.ok(!JSON.stringify(clean).includes('secret'));
  const visible = await publicServer(dirty, {});
  assert.ok(!JSON.stringify(visible).includes('secret'));
  assert.throws(() => validateStored({ version: 1, revision: 1, servers: [dirty, { ...server, id: '00000000-0000-0000-0000-000000000001' }] }), /已被使用/);
});

test('Windows environment keys reject case-insensitive duplicates', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => validateServer({ ...base(), env: [{ key: 'Path', mode: 'literal', value: 'a' }, { key: 'PATH', mode: 'literal', value: 'b' }] }), /重复/);
});

test('stored documents are checked before mutation and external summaries hide secrets', () => {
  const { server } = validateServer(base());
  assert.equal(validateStored({ version: 1, revision: 1, servers: [server] }).servers.length, 1);
  assert.throws(() => validateStored({ version: 1, revision: 1, servers: [server, server] }));
  const summary = externalSummary({ id: 'include:mcp', disabled: false, options: { id: 'mcp', config: { serverName: 'third-party', transport: 'streamable-http', url: 'https://example.com?token=secret', headers: { Authorization: 'hidden-secret' } } } });
  assert.ok(!JSON.stringify(summary).includes('hidden-secret'));
  assert.ok(!JSON.stringify(summary).includes('https://'));
  assert.equal(summary.removable, false);
});
