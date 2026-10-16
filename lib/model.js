import { randomUUID } from 'node:crypto';

export const MCP_MODULE = '@deepseek-ai/dsh-mcp-client';
export const CHANNEL = '/api';
export class UserError extends Error {}
const fail = message => { throw new UserError(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, label, max = 4096) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(`${label}格式无效或过长`);
  return value;
};
const safeKey = key => !['__proto__', 'constructor', 'prototype'].includes(key);

export function validateServer(input, previous, reservedNames = []) {
  if (!plain(input)) fail('服务器配置必须是对象');
  const serverName = text(input.serverName, '服务器名称', 32).trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) fail('名称限 1–32 个英文字母、数字、下划线或连字符');
  if (reservedNames.includes(serverName)) fail('服务器名称已被使用');
  if (!['stdio', 'streamable-http'].includes(input.transport)) fail('仅支持 stdio 和 Streamable HTTP');
  if (typeof input.enabled !== 'boolean') fail('启用状态必须是布尔值');
  const timeout = input.toolCallTimeoutMs ?? 60000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 2147483647) fail('工具超时必须为 1000–2147483647 毫秒');
  const server = { id: previous?.id ?? randomUUID(), serverName, transport: input.transport, enabled: input.enabled, toolCallTimeoutMs: timeout };
  const field = input.transport === 'stdio' ? 'env' : 'headers';
  if (input.transport === 'stdio') {
    server.command = text(input.command, '命令').trim();
    if (!server.command) fail('请填写可执行命令');
    if (!Array.isArray(input.args) || input.args.length > 256) fail('参数必须是字符串数组，最多 256 项');
    server.args = input.args.map(value => text(value, '命令参数'));
    server.cwd = text(input.cwd ?? '', '工作目录');
  } else {
    server.url = text(input.url, 'URL', 8192).trim();
    let url;
    try { url = new URL(server.url); } catch { fail('URL 格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('请使用不含用户密码或片段的 HTTP(S) URL');
    if ([...url.searchParams.keys()].some(key => /token|secret|password|api.?key|authorization/i.test(key))) fail('请把 URL 中的密钥改为请求头配置，避免明文保存');
  }
  const rows = input[field] ?? [];
  if (!Array.isArray(rows) || rows.length > 128) fail('环境变量或请求头最多 128 项');
  const seen = new Set();
  const writes = [];
  server[field] = rows.map(row => {
    if (!plain(row)) fail('配置项格式无效');
    const key = text(row.key, '配置项名称', 128).trim();
    const valid = field === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    const identity = field === 'headers' ? key.toLowerCase() : key;
    if (!valid.test(key) || !safeKey(key) || seen.has(identity)) fail('配置项名称无效或重复');
    if (field === 'env' && /^DSH_/i.test(key)) fail('不能向 MCP 子进程注入 DSH 内部变量');
    seen.add(identity);
    if (row.mode === 'literal') {
      const value = text(row.value ?? '', '配置项值', 16384);
      if (field === 'headers' && /[\r\n]/.test(value)) fail('请求头不能含换行');
      if (/secret|token|password|api.?key|authorization|cookie/i.test(key)) fail('该配置项可能是密钥，请选择「密钥」或「凭据引用」');
      return { key, mode: 'literal', value };
    }
    if (row.mode === 'ref') {
      const ref = text(row.ref ?? '', '凭据引用', 128).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) fail('凭据引用必须是环境变量名称');
      return { key, mode: 'ref', ref };
    }
    if (row.mode !== 'secret') fail('请选择普通值、密钥或凭据引用');
    const value = text(row.value ?? '', '密钥', 16384);
    if (field === 'headers' && /[\r\n]/.test(value)) fail('请求头不能含换行');
    const old = previous?.[field]?.find(item => item.key === key && item.mode === 'secret');
    // Never overwrite the old reference before the configuration commit succeeds.
    const ref = value ? `MCP_MANAGER_${randomUUID().replaceAll('-', '').toUpperCase()}` : old?.ref;
    if (!ref) fail(`请填写 ${key} 的密钥`);
    if (value) writes.push({ ref, value });
    return { key, mode: 'secret', ref };
  });
  return { server, writes };
}

export function validateStored(data) {
  if (!plain(data) || data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.servers) || data.servers.length > 100) fail('MCP 数据文件格式不正确，请先恢复备份');
  const ids = new Set(), names = [];
  for (const server of data.servers) {
    if (!plain(server) || typeof server.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(server.id) || ids.has(server.id)) fail('MCP 数据中存在无效或重复 ID');
    const field = server.transport === 'stdio' ? 'env' : 'headers';
    for (const row of server[field] ?? []) {
      if (row.mode === 'secret' && !/^MCP_MANAGER_[A-F0-9]{32}$/.test(row.ref ?? '')) fail('密钥引用格式不正确');
    }
    validateServer({ ...server, [field]: (server[field] ?? []).map(row => row.mode === 'secret' ? { ...row, value: '' } : row) }, server, names);
    ids.add(server.id); names.push(server.serverName);
  }
  return data;
}

export async function resolvedConfig(server, credentials) {
  const config = { serverName: server.serverName, transport: server.transport, toolCallTimeoutMs: server.toolCallTimeoutMs, failOnStartupError: true };
  const field = server.transport === 'stdio' ? 'env' : 'headers';
  config[field] = Object.create(null);
  for (const row of server[field]) {
    let value = row.value;
    if (row.mode !== 'literal') {
      const credential = await credentials.resolve(row.ref);
      if (!credential) fail(`凭据未配置：${row.key}`);
      value = credential.value;
    }
    if (field === 'headers' && /[\r\n]/.test(value)) fail('请求头凭据不能含换行');
    config[field][row.key] = value;
  }
  if (server.transport === 'stdio') Object.assign(config, { command: server.command, args: server.args, cwd: server.cwd });
  else config.url = server.url;
  return config;
}

export async function publicServer(server, credentials) {
  const result = structuredClone(server);
  const field = server.transport === 'stdio' ? 'env' : 'headers';
  result[field] = await Promise.all(server[field].map(async row => {
    if (row.mode === 'literal') return { ...row };
    const info = await credentials.describe(row.ref);
    return { key: row.key, mode: row.mode, ...(row.mode === 'ref' ? { ref: row.ref } : {}), configured: info.configured, writable: info.writable };
  }));
  return result;
}

export function externalSummary(entry, removable = false) {
  const config = entry.options.config ?? {};
  return { id: entry.id, serverName: typeof config.serverName === 'string' ? config.serverName : entry.options.id, transport: ['stdio', 'streamable-http'].includes(config.transport) ? config.transport : '未知/表达式', enabled: !entry.disabled, source: removable ? 'profile 第三方配置' : '内置、组合包或不可安全寻址', removable, status: entry.disabled ? 'disabled' : 'external', credentialKeys: Object.keys(config.env ?? config.headers ?? {}) };
}
