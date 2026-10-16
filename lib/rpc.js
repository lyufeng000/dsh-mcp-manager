import { CHANNEL, UserError } from './model.js';

// Exact routes use Connection's authenticated /api carrier. Unlike rpc.handle,
// fetch.register does not resolve webServer through the provider's getter shadow.
export function registerRpcRoutes(ctx, requestSchema, operations) {
  const disposers = [];
  try {
    for (const [endpoint, operation] of Object.entries(operations)) {
      const method = `mcp-manager/${endpoint}`;
      disposers.push(ctx.connection.fetch.register({
        path: `${CHANNEL}/${method}`, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return new Response('content type must be application/json', { status: 415 });
          if (Number(request.headers.get('content-length')) > 263168) return new Response('request too large', { status: 413 });
          let raw;
          try {
            const text = await request.text();
            if (Buffer.byteLength(text, 'utf8') > 263168) return new Response('request too large', { status: 413 });
            raw = JSON.parse(text);
          } catch { return new Response('body is not JSON', { status: 400 }); }
          const parsed = requestSchema.safeParse(raw);
          if (!parsed.success) return new Response('invalid RPC envelope', { status: 400 });
          const message = parsed.data;
          let result;
          try {
            if (message.method !== method) throw new UserError('请求方法与路径不一致');
            if (request.signal.aborted) throw new UserError('操作已取消');
            const payload = message.payload;
            if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 262144) throw new UserError('请求格式无效或过大');
            result = { ok: true, value: await operation(payload) };
          } catch (error) {
            result = { ok: false, error: { code: 'mcp-manager-error', message: error instanceof UserError ? error.message : '操作失败，请检查配置和凭据存储权限；未回显底层错误以保护密钥', details: {} } };
          }
          return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
        }
      }));
    }
  } catch (error) { for (const dispose of disposers.reverse()) void dispose(); throw error; }
  return async () => { for (const dispose of disposers.reverse()) await dispose(); };
}
