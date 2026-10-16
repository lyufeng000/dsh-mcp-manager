import { McpManager } from './manager.js';
import { registerRpcRoutes } from './rpc.js';

export const name = 'mcp-manager';
// Exact Fetch routes are carried by Connection's authenticated /api handler.
export const inject = ['connection', 'credentials', 'profileContext', 'configEditor', 'loader', 'tools'];

export async function apply(ctx) {
  // Resolve platform packages through DSH's Loader, not a local Node installation.
  const load = specifier => ctx.loader.import(specifier);
  const [mcp, atomic, yaml, jsYamlModule, boot, include, connection] = await Promise.all([
    load('@deepseek-ai/dsh-mcp-client'), load('@deepseek-ai/dsh-atomic-write'), load('yaml'),
    load('js-yaml'), load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/cordis-plugin-include'), load('@deepseek-ai/dsh-client-connection')
  ]);
  const manager = new McpManager(ctx, { mcp, atomic, yaml, jsYaml: jsYamlModule.default ?? jsYamlModule, boot, include });
  ctx.effect(() => () => manager.dispose());
  const operations = {
    state: () => manager.state(), save: payload => manager.save(payload), remove: payload => manager.remove(payload),
    removeExternal: payload => manager.removeExternal(payload), restart: payload => manager.restart(payload)
  };
  ctx.effect(() => registerRpcRoutes(ctx, connection.clientRequestSchema, operations));
  try { await manager.sync(); }
  catch { ctx.logger.warn('MCP 管理数据读取失败，原文件保持不变，请在设置中检查。'); }
}
