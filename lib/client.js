window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory: require => {
    const React = require('react');
    const { useState, useEffect, useRef } = React;
    const h = React.createElement;
    const STATUS = { active: '已连接（启动成功）', connecting: '连接中', failed: '连接失败 / 请重连', 'missing-credential': '凭据缺失 / 无效', disabled: '已停用', pending: '等待加载', external: '由 DSH 管理（连接状态未公开）' };
    const empty = () => ({ serverName: '', transport: 'stdio', command: '', args: [], cwd: '', env: [], headers: [], url: '', enabled: true, toolCallTimeoutMs: 60000 });
    const button = (label, onClick, disabled = false, extra = {}) => h('button', { type: 'button', onClick, disabled, ...extra }, label);
    const styles = `
      .mcpm{color:var(--dsw-alias-label-primary);max-width:850px;padding:4px 0 24px;font-size:14px}
      .mcpm *{box-sizing:border-box}.mcpm h2{font-size:20px;margin:4px 0 10px}.mcpm h3{font-size:15px;margin:0}
      .mcpm p{line-height:1.6}.mcpm .muted{color:var(--dsw-alias-label-secondary);font-size:12px}.mcpm .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .mcpm button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:inherit;border-radius:7px;padding:7px 12px;cursor:pointer}.mcpm button:disabled{opacity:.5;cursor:not-allowed}
      .mcpm .primary{background:var(--dsw-alias-label-primary,#222);color:var(--dsw-alias-bg-base,#fff);border-color:var(--dsw-alias-label-primary,#222)}.mcpm .danger{color:var(--dsw-alias-state-error-primary)}
      .mcpm .card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:15px;border-radius:10px;margin:12px 0}.mcpm .title{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
      .mcpm .notice{padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}.mcpm .error{color:var(--dsw-alias-state-error-primary)}
      .mcpm label{display:block;margin:12px 0 5px}.mcpm input:not([type=checkbox]),.mcpm select,.mcpm textarea{width:100%;background:var(--dsw-alias-bg-base);color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;font:inherit}
      .mcpm textarea{min-height:78px;font-family:monospace;resize:vertical}.mcpm .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.mcpm .kv{display:grid;grid-template-columns:minmax(100px,1fr) 110px minmax(120px,1.5fr) auto;gap:6px;margin:7px 0;align-items:center}
      .mcpm .badge{font-size:12px;color:var(--dsw-alias-label-secondary)}.mcpm input:focus,.mcpm select:focus,.mcpm textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
      @media(max-width:600px){.mcpm .grid{grid-template-columns:1fr}.mcpm .kv{grid-template-columns:1fr 100px}.mcpm .kv input:nth-child(3){grid-column:1/2}}
    `;

    function Section({ api }) {
      const [state, setState] = useState({ revision: 0, servers: [], external: [] });
      const [draft, setDraft] = useState(null), [id, setId] = useState(null), [args, setArgs] = useState('[]');
      const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loaded, setLoaded] = useState(false);
      const mounted = useRef(true), request = useRef(0), baseRevision = useRef(0);
      const refresh = async () => {
        const seq = ++request.current;
        try {
          const value = await api('state', {});
          if (mounted.current && seq === request.current) { setState(value); setLoaded(true); }
        } catch (err) { if (mounted.current) setError(err.message); }
      };
      useEffect(() => {
        mounted.current = true; refresh();
        const interval = setInterval(refresh, 5000);
        return () => { mounted.current = false; clearInterval(interval); };
      }, []);
      const run = async (operation, payload, message, close = false) => {
        if (busy) return;
        setBusy(true); setError(''); setNotice('');
        try {
          await api(operation, payload);
          if (!mounted.current) return;
          if (close) { setDraft(null); setId(null); setArgs('[]'); }
          setNotice(message); await refresh();
        } catch (err) { if (mounted.current) setError(err.message); }
        finally { if (mounted.current) setBusy(false); }
      };
      const edit = server => {
        setError(''); setNotice(''); setId(server?.id ?? null); baseRevision.current = state.revision;
        const next = server ? JSON.parse(JSON.stringify(server)) : empty();
        for (const field of ['env', 'headers']) next[field] = (next[field] ?? []).map(row => ({ ...row, value: row.mode === 'literal' ? row.value : '' }));
        setDraft(next); setArgs(JSON.stringify(next.args ?? [], null, 2));
      };
      const patch = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
      const field = (label, key, placeholder = '', type = 'text') => h('div', null,
        h('label', { htmlFor: `mcpm-${key}` }, label),
        h('input', { id: `mcpm-${key}`, type, value: draft[key] ?? '', placeholder, disabled: busy, autoComplete: 'off', onChange: event => patch(key, type === 'number' ? Number(event.target.value) : event.target.value) }));
      const save = () => {
        let parsed;
        try { parsed = JSON.parse(args); if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw Error(); }
        catch { setError('参数必须是 JSON 字符串数组，例如 ["-y", "包名"]'); return; }
        if (!window.confirm('保存此配置？启用后将运行填写的本地命令或连接第三方服务器，并向它传递配置的凭据。请仅使用可信 MCP。')) return;
        if (draft.transport === 'streamable-http' && draft.url.startsWith('http:') && !window.confirm('此连接使用未加密的 HTTP，凭据可能被网络中的其他人读取。仍要继续？')) return;
        run('save', { id, revision: baseRevision.current, server: { ...draft, args: parsed } }, '配置已保存。连接会在后台启动；密钥不会回显。', true);
      };
      const keyValues = () => {
        const key = draft.transport === 'stdio' ? 'env' : 'headers';
        const rows = draft[key] ?? [];
        const change = (index, changes) => patch(key, rows.map((row, i) => i === index ? { ...row, ...changes } : row));
        return h('div', null,
          h('label', null, key === 'env' ? '环境变量' : '请求头（例如 Authorization）'),
          h('p', { className: 'muted' }, '密钥：写入 DSH 凭据存储；编辑时留空表示保留。凭据引用：读取已有环境变量/DSH 凭据，例如 MY_API_KEY。'),
          ...rows.map((row, index) => h('div', { className: 'kv', key: index },
            h('input', { 'aria-label': `第 ${index + 1} 项名称`, value: row.key, placeholder: key === 'env' ? 'API_KEY' : 'Authorization', disabled: busy, onChange: event => change(index, { key: event.target.value }) }),
            h('select', { 'aria-label': `第 ${index + 1} 项类型`, value: row.mode, disabled: busy, onChange: event => change(index, { mode: event.target.value, value: '', ref: '', configured: false }) },
              h('option', { value: 'literal' }, '普通值'), h('option', { value: 'secret' }, '密钥'), h('option', { value: 'ref' }, '凭据引用')),
            h('input', { 'aria-label': `第 ${index + 1} 项值`, type: row.mode === 'secret' ? 'password' : 'text', autoComplete: 'off', value: row.mode === 'ref' ? row.ref ?? '' : row.value ?? '', placeholder: row.mode === 'secret' ? row.configured ? '已配置；留空保留' : '输入密钥（含 Bearer 前缀）' : row.mode === 'ref' ? 'MY_API_KEY' : '值', disabled: busy, onChange: event => change(index, row.mode === 'ref' ? { ref: event.target.value } : { value: event.target.value }) }),
            button('删除项', () => patch(key, rows.filter((_, i) => i !== index)), busy))),
          button('＋ 添加配置项', () => patch(key, [...rows, { key: '', mode: 'secret', value: '' }]), busy));
      };
      const card = (server, external = false) => h('div', { className: 'card', key: server.id },
        h('div', { className: 'title' }, h('h3', null, server.serverName), h('span', { className: 'badge' }, STATUS[server.status] ?? server.status)),
        h('p', { className: 'muted' }, `${server.transport} · ${server.source}`),
        !external && h('p', { className: 'muted' }, (server[server.transport === 'stdio' ? 'env' : 'headers'] ?? []).filter(row => row.mode !== 'literal').map(row => `${row.key}：${row.configured ? '已配置' : '未配置'}`).join('；') || '无凭据配置'),
        external && h('p', { className: 'muted' }, '已有配置内容不回显，以防其中包含明文密钥。'),
        h('div', { className: 'bar' },
          !external && button('编辑', () => edit(server), busy || !!draft),
          !external && button(server.enabled ? '停用' : '启用', () => {
            if (!window.confirm(server.enabled ? `停用 ${server.serverName}？` : `启用 ${server.serverName}？这会连接/运行第三方 MCP。`)) return;
            run('save', { id: server.id, revision: state.revision, server: { ...server, enabled: !server.enabled } }, '启用状态已更新。');
          }, busy || !!draft),
          !external && server.enabled && button('重连', () => {
            if (window.confirm(`重新连接 ${server.serverName}？本地进程将被重新启动。`)) run('restart', { id: server.id, revision: state.revision }, '正在重新连接。');
          }, busy || !!draft),
          server.removable ? button('移除', () => {
            if (window.confirm(`移除 ${server.serverName}？将断开连接并删除该服务器配置（不卸载命令包，保留凭据和备份）。`)) run(external ? 'removeExternal' : 'remove', { id: server.id, revision: state.revision }, '服务器配置已移除，凭据与备份保留。');
          }, busy || !!draft, { className: 'danger' }) : h('span', { className: 'muted' }, '受保护 · 请到所属组合包/预设中管理')));

      return h('section', { className: 'mcpm' },
        h('style', null, styles), h('h2', null, 'MCP 服务器'),
        h('p', { className: 'muted' }, '连接第三方工具服务器。仅信任你了解的命令、服务与权限。支持 stdio 和 Streamable HTTP；旧版 SSE 与 OAuth 自动登录暂不支持。'),
        h('div', { className: 'bar' }, button('＋ 添加服务器', () => edit(null), busy || !!draft || !loaded, { className: 'primary' }), button('刷新', refresh, busy)),
        error && h('div', { className: 'notice error', role: 'alert' }, error), notice && h('div', { className: 'notice', role: 'status' }, notice),
        draft && h('div', { className: 'card' }, h('h3', null, id ? '编辑服务器' : '添加服务器'),
          h('div', { className: 'grid' }, field('服务器名称', 'serverName', '例如 filesystem'),
            h('div', null, h('label', { htmlFor: 'mcpm-transport' }, '连接方式'), h('select', { id: 'mcpm-transport', value: draft.transport, disabled: busy, onChange: event => patch('transport', event.target.value) }, h('option', { value: 'stdio' }, '本地命令 · stdio'), h('option', { value: 'streamable-http' }, '远程服务 · Streamable HTTP')))),
          draft.transport === 'stdio' ? h('div', null, field('可执行命令', 'command', '例如 npx / node / uvx（不是整条 shell 命令）'),
            h('label', { htmlFor: 'mcpm-args' }, '参数 · JSON 数组'), h('textarea', { id: 'mcpm-args', value: args, disabled: busy, spellCheck: false, onChange: event => setArgs(event.target.value) }), field('工作目录（可选）', 'cwd', '留空使用宿主默认目录'),
            h('p', { className: 'muted' }, 'Windows 可使用可执行文件绝对路径。本插件不自行下载/安装 MCP 包；npx/uvx 命令可能按其自身规则联网下载。请勿把密钥放在参数中。')) : field('服务器 URL', 'url', 'https://example.com/mcp'),
          keyValues(), field('工具调用超时（毫秒）', 'toolCallTimeoutMs', '', 'number'),
          h('label', null, h('input', { type: 'checkbox', checked: draft.enabled, disabled: busy, onChange: event => patch('enabled', event.target.checked) }), ' 保存后启用'),
          h('div', { className: 'bar', style: { marginTop: 16 } }, button(busy ? '保存中…' : '保存', save, busy, { className: 'primary' }), button('取消', () => { setDraft(null); setId(null); setArgs('[]'); }, busy))),
        !loaded ? h('p', { className: 'muted' }, error ? '读取失败，请检查上方提示后点击「刷新」。' : '正在读取…') : !state.servers.length && !state.external.length ? h('div', { className: 'card muted' }, '尚未配置 MCP 服务器。点击「添加服务器」开始。') : null,
        ...state.servers.map(server => card(server)),
        state.external.length > 0 && h('h3', { style: { marginTop: 24 } }, '已有 DSH 配置'), ...state.external.map(server => card(server, true)),
        h('p', { className: 'muted' }, '「已连接」表示初次握手和工具发现成功，不是持续健康检查。新增/编辑配置即时应用；删除不会卸载本地 MCP 软件，也不会删除凭据。密钥仅用于服务器环境变量/请求头，不存入浏览器本地存储。'));
    }
    return { inject: ['slots', 'connection'], apply(ctx) {
      const api = async (endpoint, payload) => {
        try {
          const result = await ctx.connection.rpc.call('/api', `mcp-manager/${endpoint}`, payload);
          if (!result.ok) throw new Error(result.error?.message ?? 'MCP 管理操作失败');
          return result.value;
        } catch (error) {
          if (/transport failure.*HTTP (404|405)\b/i.test(error.message)) throw new Error('MCP 管理器 Host 接口未加载。请完全退出并重新打开 DSH（仅刷新页面无效）；若仍失败，请检查插件的激活状态。');
          throw error;
        }
      };
      const face = { api }; // Stable identity: Slot hooks use this face as an external-store snapshot.
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'mcp-manager', order: 17, label: 'MCP 服务器', inject: () => face }, Section));
    } };
  }
});
