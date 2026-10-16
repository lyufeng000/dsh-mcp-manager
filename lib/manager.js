import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MCP_MODULE, UserError, validateServer, validateStored, resolvedConfig, publicServer, externalSummary } from './model.js';

export class McpManager {
  constructor(ctx, dependencies) {
    this.ctx = ctx;
    Object.assign(this, dependencies);
    this.directory = join(ctx.profileContext.dir, 'mcp-manager');
    this.path = join(this.directory, 'servers.json');
    this.running = new Map();
    this.closed = false;
    this.queue = Promise.resolve();
  }
  exclusive(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  async read() {
    try { return validateStored(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, servers: [] };
      throw new UserError('MCP 数据文件读取失败，请恢复备份；不会覆盖原文件');
    }
  }
  externalEntries() {
    return [...this.ctx.loader.entries()].filter(entry => entry.options.name === MCP_MODULE);
  }
  async localIds() {
    // Protect all inherited/bundle rows. Only literal MCP insertions in this profile are removable.
    let source;
    try { source = await readFile(this.ctx.profileContext.patchPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
    const document = this.yaml.parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
    if (document.errors.length || !this.yaml.isSeq(document.contents)) throw new UserError('profile YAML 无效，停止配置操作');
    const ids = new Set();
    const visit = list => {
      if (!this.yaml.isSeq(list)) return;
      for (const item of list.items) {
        if (!this.yaml.isMap(item)) continue;
        if (item.get('name') === MCP_MODULE) ids.add(item.get('id'));
        if (item.get('group') === true) visit(item.get('config', true));
      }
    };
    for (const patch of document.contents.items) {
      if (this.yaml.isMap(patch)) visit(patch.get('insert', true));
    }
    return ids;
  }
  async state() {
    const data = await this.read();
    const ids = await this.localIds();
    const managed = await Promise.all(data.servers.map(async server => ({
      ...await publicServer(server, this.ctx.credentials), source: 'MCP 管理器', removable: true,
      status: server.enabled ? this.running.get(server.id)?.status ?? 'pending' : 'disabled'
    })));
    return { revision: data.revision, servers: managed, external: this.externalEntries().map(entry => externalSummary(entry, ids.has(entry.options.id) && this.ctx.configEditor.entries().includes(entry))) };
  }
  async save(payload) {
    return this.exclusive(async () => {
      await mkdir(this.directory, { recursive: true });
      await this.atomic.withFileLock(this.path, async () => {
        const data = await this.read();
        this.checkRevision(payload, data);
        const previous = payload.id ? data.servers.find(item => item.id === payload.id) : undefined;
        if (payload.id && !previous) throw new UserError('该服务器已被移除，请刷新');
        if (!previous && data.servers.length >= 100) throw new UserError('最多管理 100 个服务器');
        const names = [...data.servers.filter(item => item !== previous).map(item => item.serverName), ...this.externalEntries().map(entry => entry.options.config?.serverName)];
        const { server, writes } = validateServer(payload.server, previous, names);
        const written = [];
        try {
          for (const item of writes) { await this.ctx.credentials.set(item.ref, item.value); written.push(item.ref); }
          const servers = previous ? data.servers.map(item => item.id === server.id ? server : item) : [...data.servers, server];
          if (data.revision) await copyFile(this.path, `${this.path}.bak`);
          await this.atomic.writeFileAtomic(this.path, JSON.stringify({ version: 1, revision: data.revision + 1, servers }, null, 2) + '\n', { mode: 0o600 });
        } catch (error) {
          for (const ref of written) await this.ctx.credentials.unset(ref).catch(() => {});
          throw error;
        }
      });
      await this.sync();
      return { saved: true };
    });
  }
  checkRevision(payload, data) {
    if (payload.revision !== data.revision) throw new UserError('配置已被其他页面修改，请刷新后重试');
  }
  async remove(payload) {
    return this.exclusive(async () => {
      await mkdir(this.directory, { recursive: true });
      await this.atomic.withFileLock(this.path, async () => {
        const data = await this.read();
        this.checkRevision(payload, data);
        if (!data.servers.some(item => item.id === payload.id)) throw new UserError('服务器不存在，请刷新');
        await copyFile(this.path, `${this.path}.bak`);
        await this.atomic.writeFileAtomic(this.path, JSON.stringify({ ...data, revision: data.revision + 1, servers: data.servers.filter(item => item.id !== payload.id) }, null, 2) + '\n', { mode: 0o600 });
      });
      // Credentials deliberately retained: references may be reused, and the backup can be restored.
      await this.sync();
      return { removed: true };
    });
  }
  async removeExternal(payload) {
    return this.exclusive(async () => {
      const run = async () => this.atomic.withFileLock(join(this.ctx.profileContext.dir, 'package.json'), async () => {
        const entries = this.externalEntries();
        const entry = entries.find(item => item.id === payload.id);
        const ids = await this.localIds();
        if (!entry || !ids.has(entry.options.id) || !this.ctx.configEditor.entries().includes(entry)) throw new UserError('只能移除当前 profile 显式添加的第三方 MCP；内置与组合包配置受保护');
        const profile = this.ctx.profileContext;
        const before = await readFile(profile.patchPath, 'utf8');
        const doc = this.yaml.parseDocument(before, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
        if (doc.errors.length || !this.yaml.isSeq(doc.contents)) throw new UserError('profile YAML 无效');
        const removeInserted = list => {
          if (!this.yaml.isSeq(list)) return;
          for (let index = list.items.length - 1; index >= 0; index--) {
            const row = list.items[index];
            if (!this.yaml.isMap(row)) continue;
            if (row.get('id') === entry.options.id) {
              if (row.get('name') !== MCP_MODULE) throw new UserError('配置 ID 存在冲突，停止移除');
              list.delete(index);
            } else if (row.get('group') === true) removeInserted(row.get('config', true));
          }
        };
        for (let index = doc.contents.items.length - 1; index >= 0; index--) {
          const patch = doc.contents.items[index];
          if (!this.yaml.isMap(patch)) continue;
          const inserted = patch.get('insert', true);
          removeInserted(inserted);
          if (this.yaml.isSeq(inserted) && inserted.items.length === 0) {
            patch.delete('insert');
            if ([...patch.items].every(pair => ['id', 'name', 'before', 'after'].includes(pair.key?.value))) { doc.delete(index); continue; }
          }
          if (!patch.has('insert') && patch.get('id') === entry.options.id) {
            if (patch.has('name') && patch.get('name') !== MCP_MODULE) throw new UserError('配置 ID 存在冲突，停止移除');
            doc.delete(index);
          }
        }
        const after = String(doc);
        // Use DSH's own schema/composer before touching the profile, then reconcile with rollback.
        const beforePatches = this.boot.readProfilePatches('dsh', profile);
        const patches = this.boot.readProfilePatches('dsh', profile, {
          ...this.boot.loadProfileDirectory('dsh', profile.dir, profile.installAnchor),
          patches: this.jsYaml.load(after, { schema: this.include.entryListSchema })
        });
        const remains = rows => rows.some(row => row.id === entry.options.id || (row.group && Array.isArray(row.config) && remains(row.config)));
        if (remains(this.boot.composeEntries([patches]))) throw new UserError('该服务器仍由更高优先级配置提供，不能在此移除');
        await copyFile(profile.patchPath, `${profile.patchPath}.bak-mcp-manager-${Date.now()}`);
        await this.atomic.writeFileAtomic(profile.patchPath, after, { mode: 0o600 });
        try { await this.boot.reconcileProfilePatches(this.ctx.root, patches, 'dsh'); }
        catch (error) {
          await this.atomic.writeFileAtomic(profile.patchPath, before, { mode: 0o600 });
          await this.boot.reconcileProfilePatches(this.ctx.root, beforePatches, 'dsh');
          throw error;
        }
      });
      const hmr = this.ctx.get('hmr');
      await (hmr ? hmr.runExclusive(run) : run());
      return { removed: true };
    });
  }
  async sync() {
    const data = await this.read();
    for (const [id, running] of this.running) {
      const server = data.servers.find(item => item.id === id && item.enabled);
      if (!server || !isDeepStrictEqual(running.server, server)) {
        await running.fiber.dispose();
        this.running.delete(id);
      }
    }
    for (const server of data.servers.filter(item => item.enabled)) {
      if (this.closed || this.running.has(server.id)) continue;
      const state = { server: structuredClone(server), status: 'connecting', fiber: undefined };
      // Distinct wrapper identities allow multiple instances of the official MCP bridge.
      const wrapper = { name: `managed-mcp-${server.id}`, inject: this.mcp.inject, apply: async inner => {
        try {
          const config = await resolvedConfig(server, this.ctx.credentials);
          const plugin = { ...this.mcp, name: `mcp-${server.id}` };
          const fiber = inner.plugin(plugin, config);
          await fiber.await();
          state.status = fiber.state === 2 ? 'active' : 'failed';
        } catch (error) {
          // Do not leak URLs, command arguments or credential-bearing SDK errors into UI/logs.
          state.status = error instanceof UserError ? 'missing-credential' : 'failed';
        }
      } };
      state.fiber = this.ctx.plugin(wrapper);
      this.running.set(server.id, state);
    }
  }
  async restart(payload) {
    return this.exclusive(async () => {
      const data = await this.read();
      this.checkRevision(payload, data);
      if (!data.servers.some(item => item.id === payload.id && item.enabled)) throw new UserError('请先启用该服务器');
      const state = this.running.get(payload.id);
      if (state) { await state.fiber.dispose(); this.running.delete(payload.id); }
      await this.sync();
      return { restarted: true };
    });
  }
  async dispose() {
    this.closed = true;
    await this.queue;
    for (const state of this.running.values()) await state.fiber.dispose();
    this.running.clear();
  }
}
