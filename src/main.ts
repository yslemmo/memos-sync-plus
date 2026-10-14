import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, moment, requestUrl } from 'obsidian';
import { MemosClient } from './client';
import { SyncEngine } from './sync';
import { DEFAULT_SETTINGS, emptyState } from './types';
import type { ClockFormat, PreviewResult } from './sync';
import type { Settings, SyncReport, SyncState, Transport, VaultIO, HistoryEntry, RetrySpec } from './types';
import { serverBase, stableHash, vaultPath } from './utils';
import { validateBodyTemplate, TEMPLATE_VARIABLES } from './render';
import { rewriteLocalAttachmentPath } from './attachments';

interface StoredData { settings: Settings; states: Record<string, SyncState>; history: HistoryEntry[] }
interface DailyOptions { folder?: string; format?: string; template?: string }
interface AppInternals {
  setting?: { open(): void; openTabById(id: string): void };
  internalPlugins?: { getPluginById(id: string): { enabled?: boolean; instance?: { options?: DailyOptions } } | undefined };
  plugins?: { plugins: Record<string, { settings?: { daily?: DailyOptions & { enabled?: boolean } } }> };
}

const dates: ClockFormat = {
  date: (iso, format) => moment(iso).format(format),
  time: iso => moment(iso).format('HH:mm'), hour: iso => moment(iso).hour()
};
export default class MemosSyncPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  states: Record<string, SyncState> = {};
  history: HistoryEntry[] = [];
  busy = false;
  lastReport?: SyncReport;
  lastMessage = '尚未同步';
  private timer?: number;
  private startupTimer?: number;
  private active = false;
  private status!: HTMLElement;
  private binaryFiles = new Map<string, TFile>();
  async onload(): Promise<void> {
    const data = await this.loadData() as Partial<StoredData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data?.settings };
    this.states = data?.states ?? {};
    this.history = Array.isArray(data?.history) ? data.history.slice(0, this.settings.historyLimit) : [];
    if (this.history.length) { this.lastReport = this.history[0].report; this.lastMessage = this.history[0].message; }
    this.active = true;
    if (typeof this.app.vault.on === 'function') this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile) || file.extension === 'md') return;
      this.binaryFiles.set(oldPath, file); this.binaryFiles.set(file.path, file);
      let changed = false;
      for (const state of Object.values(this.states)) {
        const tracked = Object.entries(state.attachments ?? {}).filter(([, path]) => path === oldPath);
        if (!tracked.length) continue;
        changed = true;
        for (const [key] of tracked) state.attachments![key] = file.path;
        for (const [path, body] of Object.entries(state.blocks)) state.blocks[path] = rewriteLocalAttachmentPath(body, oldPath, file.path);
        for (const [id, memo] of Object.entries(state.memos)) state.memos[id] = { ...memo, body: rewriteLocalAttachmentPath(memo.body, oldPath, file.path) };
      }
      if (changed && !this.busy) void this.persist().catch(() => { new Notice('附件路径已更新，但同步缓存保存失败。'); });
    }));
    this.status = this.addStatusBarItem();
    this.status.setText('Memos：就绪');
    this.status.addClass('memos-sync-status');
    this.registerDomEvent(this.status, 'click', () => this.showReport());
    this.addRibbonIcon('refresh-cw', '同步 Memos', () => { void this.sync(); });
    this.addCommand({ id: 'sync', name: '立即同步 Memos', callback: () => { void this.sync(); } });
    this.addCommand({ id: 'force-sync', name: '全量同步所有 Memos', callback: () => { void this.sync(true); } });
    this.addCommand({ id: 'preview', name: '预览 Memos 同步', callback: () => { void this.previewSync(); } });
    this.addCommand({ id: 'preview-all', name: '预览全量 Memos 同步', callback: () => { void this.previewSync(true); } });
    this.addCommand({ id: 'history', name: '查看同步历史', callback: () => this.showHistory() });
    this.addCommand({ id: 'retry', name: '重试失败的同步', callback: () => { void this.retryLastFailures(); } });
    this.addCommand({ id: 'sync-current-day', name: '同步当前日记的 Memos', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return false;
      let effective: Settings;
      try { effective = this.effectiveSettings(); } catch { return false; }
      const prefix = effective.syncFolder ? `${effective.syncFolder}/` : '';
      if (!file.path.startsWith(prefix) || !file.path.endsWith('.md')) return false;
      const day = file.path.slice(prefix.length, -3);
      const parsed = moment(day, effective.dateFormat, true);
      if (effective.mode !== 'daily' || !parsed.isValid()) return false;
      if (!checking) void this.sync(false, day);
      return true;
    } });
    this.addCommand({ id: 'test-connection', name: '测试 Memos 连接', callback: () => { void this.testConnection(); } });
    this.addCommand({ id: 'report', name: '查看最近同步结果', callback: () => this.showReport() });
    this.addCommand({ id: 'settings', name: '打开 Memos Sync 设置', callback: () => {
      const internals = this.app as unknown as AppInternals;
      internals.setting?.open(); internals.setting?.openTabById(this.manifest.id);
    } });
    this.addSettingTab(new MemosSyncSettingsTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (!this.active) return;
      this.schedule();
      if (this.settings.syncOnStartup) this.startupTimer = window.setTimeout(() => { void this.sync(false, undefined, true); }, 5000);
    });
  }
  onunload(): void {
    this.active = false;
    if (this.timer) window.clearInterval(this.timer);
    if (this.startupTimer) window.clearTimeout(this.startupTimer);
  }
  async persist(): Promise<void> {
    this.history = this.history.slice(0, Math.max(1, Math.min(200, this.settings.historyLimit || 50)));
    await this.saveData({ settings: this.settings, states: this.states, history: this.history });
  }
  private context() {
    const settings = this.effectiveSettings();
    const key = stableHash(JSON.stringify([serverBase(settings.serverUrl), settings.creator, settings.mode, settings.syncFolder, settings.dateFormat]));
    return { settings, key, engine: new SyncEngine(this.vaultIO(), new MemosClient(settings, this.transport), dates) };
  }
  async previewSync(force = false): Promise<void> {
    if (this.busy || !this.active) { new Notice('Memos 正在处理，请稍候。'); return; }
    this.busy = true;
    try {
      const ctx = this.context();
      const result = await ctx.engine.preview(ctx.settings, this.states[ctx.key] ?? emptyState(), { force });
      if (this.active) new PreviewModal(this.app, result, () => { void this.sync(force); }).open();
    } catch (error) { new Notice(error instanceof Error ? error.message : '预览失败', 8000); }
    finally { this.busy = false; }
  }
  async retryLastFailures(): Promise<void> {
    const entry = this.history.find(h => h.scopeKey && h.status !== 'success' && !h.resolved && (h.retry.full || h.retry.memoIds.length));
    if (!entry) { new Notice('没有待重试的失败记录。'); return; }
    await this.retryHistory(entry);
  }
  async retryHistory(entry: HistoryEntry): Promise<void> {
    try {
      if (entry.resolved) { new Notice('该记录已重试，请查看最新同步历史。'); return; }
      const ctx = this.context();
      if (ctx.key !== entry.scopeKey) throw new Error('此历史记录属于其他服务器或同步目录，请切回对应配置后重试。');
      await this.sync(entry.retry.full ? Boolean(entry.retry.force) : true, entry.retry.full ? entry.retry.day : undefined, false, entry.retry, entry.id);
    } catch (error) { new Notice(error instanceof Error ? error.message : '重试失败', 8000); }
  }
  private addHistory(entry: HistoryEntry, originId?: string): void {
    if (originId) { const origin = this.history.find(h => h.id === originId); if (origin) origin.resolved = true; }
    this.history.unshift(entry);
  }
  schedule(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = undefined;
    if (this.active && Number.isFinite(this.settings.intervalMinutes) && this.settings.intervalMinutes >= 1) {
      this.timer = window.setInterval(() => { void this.sync(false, undefined, true); }, Math.min(1440, this.settings.intervalMinutes) * 60000);
      this.registerInterval(this.timer);
    }
  }
  effectiveSettings(): Settings {
    const s = { ...this.settings };
    if (s.mode === 'daily' && s.followDailyNotes) {
      const internal = this.app as unknown as AppInternals;
      const periodic = internal.plugins?.plugins['periodic-notes']?.settings?.daily;
      const daily = internal.internalPlugins?.getPluginById('daily-notes');
      const options = periodic?.enabled ? periodic : daily?.enabled ? daily.instance?.options : undefined;
      if (!options) throw new Error('请先启用日记插件，或关闭“跟随日记设置”并指定同步目录。');
      s.syncFolder = options.folder ?? '';
      s.dateFormat = options.format || 'YYYY-MM-DD';
      s.templatePath = options.template ? (options.template.endsWith('.md') ? options.template : `${options.template}.md`) : '';
    }
    s.syncFolder = vaultPath(s.syncFolder, true);
    s.attachmentFolder = vaultPath(s.attachmentFolder);
    if (!/[YMD]/.test(s.dateFormat) || /[\r\n]/.test(s.dateFormat)) throw new Error('日期格式需包含年月日，例如 YYYY-MM-DD。');
    // Reject formats that put multiple days into the same file, or produce unsafe paths.
    const sampleA = moment('2026-10-13').format(s.dateFormat), sampleB = moment('2026-10-14').format(s.dateFormat);
    const sampleC = moment('2026-11-13').format(s.dateFormat), sampleD = moment('2027-10-13').format(s.dateFormat);
    if (new Set([sampleA, sampleB, sampleC, sampleD]).size !== 4) throw new Error('日期格式必须区分年、月、日，避免不同日期覆盖。');
    vaultPath(`${sampleA}.md`);
    if (s.templatePath) s.templatePath = vaultPath(s.templatePath);
    return s;
  }
  private transport: Transport = async request => {
    const response = await requestUrl({ ...request, throw: false,
      ...(request.body ? { contentType: 'application/json' } : {})
    });
    let json: unknown = null;
    try { json = response.json; } catch { /* Binary attachments have no JSON body. */ }
    return { status: response.status, text: response.text, json, arrayBuffer: response.arrayBuffer };
  };
  private vaultIO(): VaultIO {
    const vault = this.app.vault;
    const assertActive = () => { if (!this.active) throw new Error('插件已停用，同步已停止。'); };
    const getFile = (path: string): TFile => {
      const file = vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`找不到文件：${path}`);
      return file;
    };
    return {
      exists: async path => { assertActive(); return Boolean(vault.getAbstractFileByPath(path)); },
      read: async path => { assertActive(); return vault.read(getFile(path)); },
      create: async (path, content) => { assertActive(); await vault.create(path, content); },
      process: async (path, fn) => { assertActive(); await vault.process(getFile(path), fn); },
      mkdir: async path => {
        assertActive(); const entry = vault.getAbstractFileByPath(path);
        if (entry && !(entry instanceof TFolder)) throw new Error('目标目录被同名文件占用。');
        if (!entry) await vault.createFolder(path);
      },
      createBinary: async (path, data) => {
        assertActive();
        const created = await vault.createBinary(path, data);
        const file = created instanceof TFile ? created : getFile(path);
        this.binaryFiles.set(path, file);
        const renamer = (this.app as unknown as { plugins?: { plugins?: Record<string, { settings?: { autoRename?: boolean; handleAllAttachments?: boolean } }> } }).plugins?.plugins?.['obsidian-paste-image-rename'];
        if (renamer?.settings?.autoRename && renamer.settings.handleAllAttachments && this.app.workspace.getActiveFile() && file.path === path) {
          await new Promise<void>(resolve => {
            let ended = false;
            const finish = () => { if (ended) return; ended = true; window.clearTimeout(timer); vault.offref(ref); resolve(); };
            const ref = vault.on('rename', renamed => { if (renamed === file) finish(); });
            const timer = window.setTimeout(finish, 1500);
          });
        }
        assertActive(); return file.path;
      },
      rename: async (source, destination) => { assertActive(); await this.app.fileManager.renameFile(getFile(source), destination); },
      resolveBinary: async path => {
        assertActive(); const tracked = this.binaryFiles.get(path);
        const actual = tracked?.path ?? path;
        const file = vault.getAbstractFileByPath(actual);
        return file instanceof TFile ? file.path : undefined;
      },
      findBinary: async (data, folder) => {
        assertActive();
        if (typeof vault.getFiles !== 'function') return undefined;
        const prefix = folder ? `${folder}/` : '';
        const expected = new Uint8Array(data);
        for (const file of vault.getFiles()) {
          if (file.extension === 'md' || !file.path.startsWith(prefix) || file.stat.size !== data.byteLength) continue;
          const existing = new Uint8Array(await vault.readBinary(file));
          if (existing.length === expected.length && existing.every((value, index) => value === expected[index])) return file.path;
        }
        return undefined;
      }
    };
  }
  async testConnection(): Promise<void> {
    if (this.busy) { new Notice('正在同步，请稍后测试连接。'); return; }
    this.busy = true;
    try {
      const client = new MemosClient({ ...this.settings }, this.transport);
      const creator = await client.resolveCreator();
      const memos = await client.listAll(creator);
      new Notice(`连接成功：${creator}，可同步 ${memos.length} 条记录。`, 7000);
    } catch (error) { new Notice(error instanceof Error ? error.message : '连接失败', 8000); }
    finally { this.busy = false; }
  }
  async sync(force = false, day?: string, automatic = false, retry?: RetrySpec, originId?: string): Promise<void> {
    if (this.busy || !this.active) { if (!automatic) new Notice('Memos 正在同步，请稍候。'); return; }
    if (automatic && (!this.settings.serverUrl || !this.settings.token)) return;
    this.busy = true;
    const started = new Date().toISOString();
    const mode: HistoryEntry['mode'] = retry ? 'retry' : day ? 'day' : force ? 'force' : 'sync';
    const id = `${Date.now()}-${stableHash(`${started}-${this.history.length}-${Math.random()}`)}`;
    let scopeKey = '', recorded = false;
    this.status.setText('Memos：同步中…');
    try {
      const ctx = this.context(); scopeKey = ctx.key;
      const result = await ctx.engine.run(ctx.settings, this.states[ctx.key] ?? emptyState(), { force, day, memoIds: retry && !retry.full ? retry.memoIds : undefined, expectedScope: retry?.scope });
      if (!this.active) return;
      this.states[ctx.key] = result.state;
      this.lastReport = result.report;
      const r = result.report;
      this.lastMessage = `读取 ${r.fetched} 条，本次范围 ${r.selected} 条；更新 ${r.written} 个文件，重命名 ${r.renamed} 个，未变 ${r.unchanged} 个，下载 ${r.downloaded} 个附件。`;
      const issues = r.conflicts.length + r.warnings.length;
      const failedIds = [...new Set(r.failures.flatMap(f => f.memoIds))];
      const completed = new Set(r.processedMemoIds.filter(id => !failedIds.includes(id)));
      for (const previous of this.history) {
        if (previous.status === 'success' || previous.resolved || previous.scopeKey !== ctx.key || (previous.retry.scope && previous.retry.scope !== result.state.scope)) continue;
        if (!previous.retry.full) {
          previous.retry.memoIds = previous.retry.memoIds.filter(id => !completed.has(id));
          if (!previous.retry.memoIds.length) previous.resolved = true;
        } else if (!issues && force && !day && !retry) previous.resolved = true;
      }
      this.addHistory({ id, started, ended: new Date().toISOString(), scopeKey, mode, status: issues ? 'partial' : 'success', message: this.lastMessage,
        report: r, retry: { full: Boolean(issues && !failedIds.length), memoIds: failedIds, force, day, scope: result.state.scope } }, originId);
      recorded = true;
      await this.persist();
      this.status.setText(issues ? `Memos：${issues} 项待处理` : `Memos：${moment().format('HH:mm')} 已同步`);
      if (!automatic || issues) new Notice(`${this.lastMessage}${issues ? `\n有 ${issues} 项待处理，点击状态栏查看详情。` : ''}`, 8000);
    } catch (error) {
      this.lastReport = undefined;
      this.lastMessage = error instanceof Error ? error.message : '同步失败';
      if (!recorded && this.active) {
        this.addHistory({ id, started, ended: new Date().toISOString(), scopeKey, mode, status: 'failed', message: this.lastMessage,
          retry: { full: retry ? retry.full : true, memoIds: retry?.memoIds ?? [], force, day, scope: retry?.scope || this.states[scopeKey]?.scope } }, originId);
        try { await this.persist(); } catch { this.lastMessage += '；无法保存同步历史。'; }
      } else if (recorded) {
        const entry = this.history.find(h => h.id === id);
        if (entry) { entry.status = 'partial'; entry.message = `笔记已处理，但状态／历史保存失败：${this.lastMessage}`; entry.retry.full = true; }
      }
      if (this.active) { this.status.setText('Memos：同步失败'); new Notice(this.lastMessage, 8000); }
    } finally { this.busy = false; }
  }
  showReport(): void { new ReportModal(this.app, this.lastMessage, this.lastReport, () => { void this.retryLastFailures(); }).open(); }
  showHistory(): void { new HistoryModal(this.app, this).open(); }
}

class ReportModal extends Modal {
  constructor(app: App, private message: string, private report?: SyncReport, private retry?: () => void) { super(app); }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: 'Memos 同步结果' });
    this.contentEl.createEl('p', { text: this.message });
    if ((!this.report || this.report.failures?.length) && this.retry) new Setting(this.contentEl).addButton(b => b.setButtonText('重试失败记录').setCta().onClick(() => { this.close(); this.retry?.(); }));
    if (this.report) {
      if (this.report.removed) this.contentEl.createEl('p', { text: `已从同步区域移除 ${this.report.removed} 条远端已删除或归档记录。` });
      if (this.report.conflicts.length) {
        this.contentEl.createEl('h3', { text: '本地修改冲突' });
        this.contentEl.createEl('p', { text: '以下文件的同步区域被修改或标记被删除，已跳过。可在设置中选择“先备份再覆盖”，然后重新同步。' });
        const ul = this.contentEl.createEl('ul');
        this.report.conflicts.forEach(path => ul.createEl('li', { text: path }));
      }
      if (this.report.warnings.length) {
        this.contentEl.createEl('h3', { text: '需要处理' });
        const ul = this.contentEl.createEl('ul');
        this.report.warnings.forEach(warning => ul.createEl('li', { text: warning }));
      }
    }
  }
  onClose(): void { this.contentEl.empty(); }
}

class PreviewModal extends Modal {
  constructor(app: App, private result: PreviewResult, private execute: () => void) { super(app); }
  onOpen(): void {
    const r = this.result.report;
    this.contentEl.createEl('h2', { text: 'Memos 同步预览' });
    this.contentEl.createEl('p', { text: `本次范围 ${r.selected} 条；预计更新 ${r.written} 个文件、重命名 ${r.renamed} 个、下载 ${r.downloaded} 个附件、移除 ${r.removed} 条记录。` });
    this.contentEl.createEl('p', { text: '预览没有写入笔记、附件、备份或同步缓存。执行时会重新读取最新内容；附件能否下载将在执行时验证。' });
    const labels = { create: '新增笔记', update: '更新笔记', rename: '重命名', attachment: '下载附件', backup: '创建备份', remove: '移除同步记录' };
    const ul = this.contentEl.createEl('ul');
    this.result.changes.forEach(c => ul.createEl('li', { text: `${labels[c.action]}：${c.from ? `${c.from} → ` : ''}${c.path}${c.memoId ? `（${c.memoId}）` : ''}` }));
    if (r.conflicts.length || r.warnings.length) {
      this.contentEl.createEl('h3', { text: '需要处理' });
      const problems = this.contentEl.createEl('ul');
      [...r.conflicts, ...r.warnings].forEach(text => problems.createEl('li', { text }));
    }
    new Setting(this.contentEl).addButton(b => b.setButtonText('关闭').onClick(() => this.close()))
      .addButton(b => b.setButtonText('执行同步').setCta().onClick(() => { this.close(); this.execute(); }));
  }
  onClose(): void { this.contentEl.empty(); }
}

class HistoryModal extends Modal {
  constructor(app: App, private plugin: MemosSyncPlugin) { super(app); }
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl('h2', { text: 'Memos 同步历史' });
    if (!this.plugin.history.length) this.contentEl.createEl('p', { text: '尚无同步历史。预览不会计入同步历史。' });
    const modes = { sync: '普通同步', force: '全量同步', day: '当前日记', retry: '失败重试' };
    const statuses = { success: '成功', partial: '有待处理项', failed: '失败' };
    for (const entry of this.plugin.history) {
      this.contentEl.createEl('h3', { text: `${moment(entry.started).format('YYYY-MM-DD HH:mm:ss')} · ${modes[entry.mode]} · ${statuses[entry.status]}${entry.resolved ? '（已处理）' : ''}` });
      this.contentEl.createEl('p', { text: entry.message });
      const row = new Setting(this.contentEl);
      row.addButton(b => b.setButtonText('详情').onClick(() => new ReportModal(this.app, entry.message, entry.report).open()));
      if (entry.scopeKey && !entry.resolved && entry.status !== 'success' && (entry.retry.full || entry.retry.memoIds.length)) {
        row.addButton(b => b.setButtonText('重试失败项').onClick(async () => { await this.plugin.retryHistory(entry); this.onOpen(); }));
      }
    }
  }
  onClose(): void { this.contentEl.empty(); }
}

class MemosSyncSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: MemosSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl: el, plugin: p } = this;
    el.empty(); el.addClass('memos-sync-settings');
    el.createEl('h2', { text: 'Memos Sync' });
    el.createEl('p', { text: '将 Memos 同步到当前 Obsidian 库。默认按天汇总，设置保存后即生效。' });
    new Setting(el).setName('操作').setDesc(p.lastMessage)
      .addButton(b => b.setButtonText('测试连接').onClick(() => { void p.testConnection(); }))
      .addButton(b => b.setButtonText('立即同步').setCta().onClick(() => { void p.sync(); }))
      .addButton(b => b.setButtonText('查看结果').onClick(() => p.showReport()));
    new Setting(el).setName('预览与历史')
      .addButton(b => b.setButtonText('同步预览').onClick(() => { void p.previewSync(); }))
      .addButton(b => b.setButtonText('同步历史').onClick(() => p.showHistory()))
      .addButton(b => b.setButtonText('失败重试').onClick(() => { void p.retryLastFailures(); }));
    const section = (text: string) => { el.createEl('h3', { text }); };
    const save = async () => { try { await p.persist(); } catch { new Notice('无法保存插件设置，请检查库目录权限。'); } };
    const text = (key: keyof Settings, name: string, desc: string, placeholder = '', validate?: (value: string) => unknown) => {
      new Setting(el).setName(name).setDesc(desc).addText(t => {
        t.setPlaceholder(placeholder).setValue(String(p.settings[key]));
        // Commit on blur so partially typed paths and URLs are never saved.
        t.inputEl.addEventListener('change', () => {
          if (p.busy) { new Notice('同步中，完成后再修改设置。'); t.setValue(String(p.settings[key])); return; }
          const value = t.getValue().trim();
          try { const normalized = validate?.(value); (p.settings as unknown as Record<string, unknown>)[key] = typeof normalized === 'string' ? normalized : value; void save(); }
          catch (error) { new Notice(error instanceof Error ? error.message : '设置无效'); t.setValue(String(p.settings[key])); }
        });
      });
    };
    const toggle = (key: keyof Settings, name: string, desc: string, redraw = false) => {
      new Setting(el).setName(name).setDesc(desc).addToggle(t => t.setValue(Boolean(p.settings[key])).onChange(async value => {
        if (p.busy) { new Notice('同步中，完成后再修改设置。'); t.setValue(Boolean(p.settings[key])); return; }
        (p.settings as unknown as Record<string, unknown>)[key] = value; await save(); if (redraw) this.display();
      }));
    };
    const number = (key: keyof Settings, name: string, desc: string, min: number, max: number) => {
      new Setting(el).setName(name).setDesc(desc).addText(t => {
        const input = t.inputEl;
        input.type = 'number'; input.min = String(min); input.max = String(max);
        t.setValue(String(p.settings[key]));
        input.addEventListener('change', () => {
          if (p.busy) { new Notice('同步中，完成后再修改设置。'); t.setValue(String(p.settings[key])); return; }
          const value = input.value;
          if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) { new Notice(`请输入 ${min}–${max} 之间的整数。`); t.setValue(String(p.settings[key])); return; }
          (p.settings as unknown as Record<string, unknown>)[key] = Number(value);
          void save(); if (key === 'intervalMinutes') p.schedule();
        });
      });
    };
    const dropdown = (key: keyof Settings, name: string, desc: string, options: Record<string, string>, redraw = false) => {
      new Setting(el).setName(name).setDesc(desc).addDropdown(d => d.addOptions(options).setValue(String(p.settings[key])).onChange(async value => {
        if (p.busy) { new Notice('同步中，完成后再修改设置。'); d.setValue(String(p.settings[key])); return; }
        (p.settings as unknown as Record<string, unknown>)[key] = value; await save(); if (redraw) this.display();
      }));
    };
    section('连接');
    text('serverUrl', 'Memos 服务器', '填写网站根地址，无需添加 /api/v1。', 'https://memos.example.com', value => { if (value) serverBase(value); });
    new Setting(el).setName('API 令牌').setDesc('在 Memos 设置中生成访问令牌。令牌以明文保存在本库的插件 data.json 中，请勿公开该文件。').addText(t => {
      t.inputEl.type = 'password'; t.inputEl.autocomplete = 'off'; t.setValue(p.settings.token);
      t.inputEl.addEventListener('change', () => { if (!p.busy) { p.settings.token = t.getValue().trim(); void save(); } else t.setValue(p.settings.token); });
    });
    dropdown('apiMode', 'API 类型', '新版使用 /api/v1/memos；旧版使用 /api/v1/memo。', { modern: '新版（v0.22+，含 v0.30）', legacy: '旧版（v0.19–v0.21）' });
    text('creator', '用户资源名（可选）', '通常留空自动识别。识别失败时填写 users/lemmo 或 users/1；仅同步该用户的记录。', 'users/lemmo', value => { if (value && !/^(users\/)?[a-zA-Z0-9_.@-]+$/.test(value)) throw new Error('用户资源名格式无效。'); });
    section('笔记');
    dropdown('mode', '保存方式', '日记按日期汇总；独立笔记可选择 ID、创建时间、更新时间或标题命名。', { daily: '按天汇总到日记', individual: '每条 Memos 独立笔记' }, true);
    if (p.settings.mode === 'individual') dropdown('fileNameFormat', 'File name format（文件名格式）',
      'ID 使用“创建日期 + Memos 链接末尾的原始 ID”；其他格式也保留该 ID，避免同名覆盖。切换格式时重命名已跟踪笔记并更新本地链接。',
      { id: 'ID（日期 + Memos 原始 ID）', created: 'Created at（创建时间）', updated: 'Updated at（更新时间）', title: 'Title（标题）' });
    if (p.settings.mode === 'daily') toggle('followDailyNotes', '跟随日记设置', '优先使用已启用的 Periodic Notes 日记配置，其次为 Obsidian 核心日记的目录、日期格式和模板。', true);
    if (!p.settings.followDailyNotes || p.settings.mode === 'individual') {
      text('syncFolder', '同步路径', '库内相对目录，支持子目录；留空表示库根目录。', 'Memos', value => vaultPath(value, true));
      if (p.settings.mode === 'daily') text('dateFormat', '日记日期格式', '使用 Moment 日期格式，可用 YYYY/MM/YYYY-MM-DD 创建分级目录。', 'YYYY-MM-DD');
      text('templatePath', '新笔记模板（可选）', '库内 Markdown 文件路径，支持 {{date}} 与 {{time}}。模板只用于新建文件。', 'Templates/Memos.md', value => { if (value) vaultPath(value); });
    }
    text('heading', 'Memos 区域标题', '标题不存在时自动创建；只更新标记内的 Memos，其他内容保持原样。', 'Memos', value => { if (!value || /[\r\n]/.test(value)) throw new Error('标题不能为空或包含换行。'); });
    number('daysLimit', '同步最近多少天', '0 同步全部；普通同步检查范围内的新增、编辑和附件变化。全量同步命令忽略此限制。', 0, 36500);
    dropdown('format', '展示样式', '日记中使用列表时间线或 Obsidian 原生 Callout；自定义正文模板非空时，以模板为准。', { list: '列表时间线', callout: 'Callout 卡片' });
    toggle('emoji', '显示时间表情', '根据早晨、中午、傍晚和夜晚显示表情。');
    toggle('includeSourceLink', '显示 Memos 来源链接', '方便从 Obsidian 打开原始记录。');
    toggle('newestFirst', '较新的记录在上方', '关闭后按时间从早到晚排列。');
    toggle('noteProperties', '添加笔记属性', '独立笔记添加 Memos ID、创建时间、更新时间、来源、创建者与标签。保留已有自定义属性，标签合并；日记汇总模式不添加单条记录属性。');
    section('正文模板');
    new Setting(el).setName('自定义正文模板').setDesc('留空使用原有样式。需要 {{content}}；包含 {{attachments}} 时将附件单独放到该位置。模板适用于每条记录，不执行脚本。').addTextArea(t => {
      t.setValue(p.settings.bodyTemplate); t.inputEl.rows = 10; t.inputEl.cols = 45;
      t.inputEl.addEventListener('change', () => {
        if (p.busy) { new Notice('同步中，完成后再修改设置。'); t.setValue(p.settings.bodyTemplate); return; }
        try { validateBodyTemplate(t.getValue()); p.settings.bodyTemplate = t.getValue(); void save(); }
        catch (error) { new Notice(error instanceof Error ? error.message : '模板无效'); t.setValue(p.settings.bodyTemplate); }
      });
    });
    el.createEl('p', { text: `可用变量：${TEMPLATE_VARIABLES.map(v => `{{${v}}}`).join('、')}` });
    new Setting(el).setName('模板示例').setDesc('简洁模板只显示正文和附件，可隐藏底部的创建／更新时间。')
      .addButton(b => b.setButtonText('使用简洁模板').onClick(async () => {
        if (p.busy) { new Notice('同步中，完成后再修改设置。'); return; }
        p.settings.bodyTemplate = '{{content}}\n\n{{attachments}}'; await save(); this.display();
      }))
      .addButton(b => b.setButtonText('恢复默认正文').onClick(async () => {
        if (p.busy) { new Notice('同步中，完成后再修改设置。'); return; }
        p.settings.bodyTemplate = ''; await save(); this.display();
      }));
    section('附件');
    toggle('downloadAttachments', '下载附件', '开启后下载 API 附件到本库；关闭时保留远程链接。正文中的其他网页图片不自动下载。');
    text('attachmentFolder', '附件保存路径', '库内相对目录；文件名带稳定 ID，避免同名附件覆盖。', 'Memos/attachments', value => vaultPath(value));
    number('maxAttachmentMB', '单个附件上限（MB）', '超出上限或下载失败时保留远程链接，并在同步结果中提示，下次同步重试。', 1, 1024);
    section('自动同步');
    number('intervalMinutes', 'Sync interval（分钟）', '0 关闭定时同步；1–1440 分钟。修改后立即重新计时，仅在 Obsidian 运行时生效。', 0, 1440);
    toggle('syncOnStartup', '启动后自动同步', '库加载完成后等待 5 秒再开始同步。');
    number('historyLimit', '同步历史保留条数', '保存最近的同步结果及失败记录，重新启动后仍可查看和重试。', 1, 200);
    section('更新与冲突');
    toggle('mirrorDeletions', '移除远端已删除／归档的记录', '默认关闭。开启后仅移除本插件已跟踪、当前时间范围内的记录；不会删除笔记文件或附件。');
    dropdown('conflictPolicy', '同步区域被本地修改时', '同步区域外的本地内容始终保留；全量同步也遵守此选项。备份保存在同步目录的 Memos Sync Backups 中。', { skip: '跳过并提示（默认）', backup: '先备份完整笔记，再更新同步区域' });
    el.createEl('p', { text: '这是 Memos → Obsidian 的单向同步。请在 Memos 编辑原始内容，并将本地补充写在同步标记外。', cls: 'memos-sync-footnote' });
  }
}
