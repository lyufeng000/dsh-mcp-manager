# MCP 服务器管理器

DSH 插件 `dsh-mcp-manager` 0.1.0。入口：**设置 → MCP 服务器**。

## 功能

- 查看 MCP 管理器配置，以及当前 Loader 中已有的 MCP 客户端条目。
- 添加、编辑、启用、停用、重连、移除第三方 MCP。
- 连接方式：stdio（命令、JSON 参数数组、工作目录、环境变量），Streamable HTTP（URL、请求头）。
- 普通值、密钥与已有凭据引用三种配置项模式。密钥通过 DSH `credentials` 服务保存；只在连接时取出，配置文件仅存引用，界面不回显。
- 已有条目的参数不回显，防止历史配置中的明文密钥泄漏。
- 只允许移除当前 profile `insert` 中显式添加的 MCP 条目。内置、组合包、继承/更高优先级配置只读，需到所属配置/预设中管理。
- profile 移除使用平台文件锁、YAML AST、DSH 配置组合器和重载机制；写回前备份，重载失败回滚，保留 `!!js` 与其他条目。

## 安全与边界

- 启用 stdio 会运行填写的命令；启用 HTTP 会把配置的请求头发送给指定服务器。界面执行前会确认。请只使用可信 MCP。
- 不自动安装 MCP 软件。但用户配置的 npx/uvx 可能按其自身规则联网下载软件。
- 密钥不要放在命令、参数、URL 或普通值里。远程生产服务请用 HTTPS。
- 「密钥」编辑留空保留旧值；配置 `Authorization` 时填入完整值，例如 `Bearer <token>`。
- 「凭据引用」填写现有环境变量/DSH 凭据名称，例如 `MY_API_KEY`。
- 删除配置不卸载命令包，也不删除凭据。备份恢复或其他配置可能仍引用凭据。
- 管理数据：`<profile>/mcp-manager/servers.json`；上一个版本备份为 `servers.json.bak`。密钥存储位置及加密能力遵从 DSH 凭据服务，不额外承诺磁盘加密。
- 「已连接」是初次连接及工具发现成功，不是实时在线健康检查。失败时可使用「重连」。
- 旧式 SSE、OAuth 自动登录、任意 MCP JSON 导入暂不支持。
- 未挂载的 agent preset 中的服务器不在当前 Loader 的列表里。

## 本机安装（须确认后执行）

源码：本仓库根目录（克隆后即为插件目录）。

1. 备份 desktop profile 的 `package.json`、锁文件与 `cordis.patch.yml`。
2. 以 `link:` 本地依赖接入，不从 npm 按包名安装。
3. 把 `dsh-mcp-manager` 加入 `dsh.profile.bundles`。本包自带 bundle patch，不在 profile 再插入重复挂载。
4. 同步治理目录 `Plugins.json`，校验 profile 和账本。
5. 完全退出并重新打开 DSH，再进入设置。首次安装仅刷新页面不会加载 Host。

## 测试

`node --test test/*.test.mjs` 运行模型单元测试。运行完整平台集成测试时设置 `DSH_MCP_TEST_RUNTIME` 为包含真实 DSH `package.json` 和依赖的独立运行时目录。测试临时文件默认写入 `D:/Data/.temp/mcp-manager-tests`，可用 `DSH_MCP_TEST_ROOT` 改为另一临时目录。

已通过 14 项测试，在当前安装版本的隔离依赖运行时验证：Host 激活、独立服务 Fiber 下真实复现 RPC getter 的 webServer 注入故障、改用 Connection.fetch 精确注册 `/api/mcp-manager/*` 后成功读写与释放、官方 HTTP carrier 的真实登录 Cookie 与 POST 请求（200 / 未认证 401 / 异站 403 / 释放后 404）、RPC 请求信封及体积校验、设置 Slot 契约和未加载接口提示、真实 stdio 双实例、真实 Streamable HTTP 与请求头凭据、工具发现、重连和移除、乐观并发、原子写入失败补偿、YAML 表达式与相邻条目保留、移除重载失败回滚、内置及更高优先级保护。界面结构测试使用 hook 适配器，不等同于浏览器视觉或完整点击测试；当前桌面 GUI 验收需完全退出并重新打开 DSH 后进行。

2026-10-12 修正：此前仅把 webServer 加进本插件 inject 仍会在线激活失败。Connection 的 RPC getter shadow 会在其提供方作用域解析 webServer；此前把模拟服务提供在根 Context 的测试掩盖了此约束。现在使用官方已认证 `/api` 下的精确 Fetch 路由，不修改平台或其他插件。
