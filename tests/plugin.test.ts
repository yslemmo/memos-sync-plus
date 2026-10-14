// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MemosSyncPlugin from '../src/main';
import { Plugin, requestUrl, TFile, TFolder } from './obsidian-mock';
import { rewriteLocalAttachmentPath } from '../src/attachments';
import { MemoryVault, rawMemo, response, settings } from './helpers';

function appFor(vault = new MemoryVault()) {
  return {
    vault: {
      getAbstractFileByPath: (path: string) => vault.files.has(path) || vault.binaries.has(path) ? new TFile(path) : vault.folders.has(path) ? new TFolder(path) : null,
      read: (file: TFile) => vault.read(file.path),
      create: (path: string, text: string) => vault.create(path, text),
      process: (file: TFile, fn: (current: string) => string) => vault.process(file.path, fn),
      createFolder: (path: string) => vault.mkdir(path),
      createBinary: (path: string, data: ArrayBuffer) => vault.createBinary(path, data)
    },
    workspace: { onLayoutReady: (fn: () => void) => fn(), getActiveFile: () => null as TFile | null },
    fileManager: { renameFile: (file: TFile, path: string) => vault.rename(file.path, path) },
    internalPlugins: { getPluginById: () => ({ enabled: true, instance: { options: { folder: 'Daily', format: 'YYYY/MM/YYYY-MM-DD', template: '' } } }) },
    plugins: { plugins: {} }
  };
}
describe('Obsidian plugin integration', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T08:00:00Z'));
    Object.assign(HTMLElement.prototype, {
      empty(this: HTMLElement) { this.replaceChildren(); },
      setText(this: HTMLElement, value: string) { this.textContent = value; },
      addClass(this: HTMLElement, value: string) { this.classList.add(value); },
      createEl(this: HTMLElement, tag: string, opts: { text?: string; cls?: string } = {}) { const el = document.createElement(tag); el.textContent = opts.text ?? ''; if (opts.cls) el.className = opts.cls; this.append(el); return el; }
    });
    requestUrl.mockReset();
  });
  afterEach(() => vi.useRealTimers());
  it('loads the real plugin, syncs through requestUrl/Vault, persists state and skips unchanged notes', async () => {
    const vault = new MemoryVault(), app = appFor(vault);
    const plugin = new MemosSyncPlugin(app as any, { id: 'memos-sync' } as any);
    (plugin as unknown as Plugin).data = { settings: settings(), states: {} };
    requestUrl.mockImplementation(async () => response({ memos: [rawMemo()] }));
    await plugin.onload(); await plugin.sync();
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('Memo one');
    expect(plugin.lastReport?.written).toBe(1);
    expect(Object.keys((plugin as unknown as Plugin).data as any)).toEqual(['settings', 'states', 'history']);
    await plugin.sync(); expect(plugin.lastReport?.unchanged).toBe(1);
    plugin.onunload();
  });
  it('saves numeric intervals as numbers and starts/stops timers immediately', async () => {
    const plugin = new MemosSyncPlugin(appFor() as any, {} as any);
    await plugin.onload();
    const tab = (plugin as unknown as Plugin).tabs[0];
    (tab as any).display();
    const input = tab.containerEl.querySelector('[data-name="Sync interval（分钟）"] input') as HTMLInputElement;
    const sync = vi.spyOn(plugin, 'sync').mockResolvedValue();
    input.value = '2'; input.dispatchEvent(new Event('change'));
    expect(plugin.settings.intervalMinutes).toBe(2); expect(typeof plugin.settings.intervalMinutes).toBe('number');
    await vi.advanceTimersByTimeAsync(120000); expect(sync).toHaveBeenCalledTimes(1);
    input.value = '0'; input.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(120000); expect(sync).toHaveBeenCalledTimes(1);
    plugin.onunload();
  });
  it('waits 5 seconds for startup sync and clears schedules on unload', async () => {
    const plugin = new MemosSyncPlugin(appFor() as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ syncOnStartup: true, intervalMinutes: 1 }), states: {} };
    await plugin.onload(); const sync = vi.spyOn(plugin, 'sync').mockResolvedValue();
    await vi.advanceTimersByTimeAsync(4999); expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(sync).toHaveBeenCalledTimes(1);
    plugin.onunload(); await vi.advanceTimersByTimeAsync(120000); expect(sync).toHaveBeenCalledTimes(1);
  });
  it('follows core daily notes and recognizes current-day commands in nested date folders', async () => {
    const app = appFor(); app.workspace.getActiveFile = () => new TFile('Daily/2026/10/2026-10-13.md');
    const plugin = new MemosSyncPlugin(app as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ followDailyNotes: true }), states: {} };
    await plugin.onload(); expect(plugin.effectiveSettings().syncFolder).toBe('Daily');
    const command = (plugin as unknown as Plugin).commands['sync-current-day'];
    const sync = vi.spyOn(plugin, 'sync').mockResolvedValue();
    expect(command.checkCallback(true)).toBe(true); command.checkCallback(false);
    expect(sync).toHaveBeenCalledWith(false, '2026/10/2026-10-13');
    plugin.onunload();
  });
  it('does not overlap sync runs', async () => {
    const plugin = new MemosSyncPlugin(appFor() as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings(), states: {} };
    await plugin.onload();
    let release!: (value: unknown) => void;
    requestUrl.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const first = plugin.sync(); await Promise.resolve(); await Promise.resolve();
    await plugin.sync(); expect(requestUrl).toHaveBeenCalledTimes(1);
    release(response({ memos: [rawMemo()] })); await first; plugin.onunload();
  });
  it('shows the four filename choices and uses FileManager to rename existing individual notes', async () => {
    const vault = new MemoryVault(), app = appFor(vault);
    const plugin = new MemosSyncPlugin(app as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ mode: 'individual' }), states: {} };
    requestUrl.mockImplementation(async () => response({ memos: [rawMemo('one', { content: '# 我的想法' })] }));
    await plugin.onload(); await plugin.sync();
    const tab = (plugin as unknown as Plugin).tabs[0]; (tab as any).display();
    const select = tab.containerEl.querySelector('[data-name="File name format（文件名格式）"] select') as HTMLSelectElement;
    expect([...select.options].map(o => o.value)).toEqual(['id', 'created', 'updated', 'title']);
    select.value = 'title'; select.dispatchEvent(new Event('change')); await Promise.resolve();
    expect(plugin.settings.fileNameFormat).toBe('title');
    const rename = vi.spyOn(app.fileManager, 'renameFile');
    await plugin.sync();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(vault.files.has('Memos/2026-10-13 我的想法 one.md')).toBe(true);
    expect(vault.files.has('Memos/2026-10-13 one.md')).toBe(false);
    plugin.onunload();
  });
  it('preview does not persist data, create notes or download attachments', async () => {
    const io = new MemoryVault(), plugin = new MemosSyncPlugin(appFor(io) as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ mode: 'individual' }), states: {} };
    requestUrl.mockImplementation(async () => response({ memos: [rawMemo('one', { attachments: [{ name: 'attachments/a', filename: 'a.png', type: 'image/png' }] })] }));
    await plugin.onload(); const persist = vi.spyOn(plugin, 'persist');
    await plugin.previewSync();
    expect(persist).not.toHaveBeenCalled(); expect(io.files.size).toBe(0); expect(io.binaries.size).toBe(0);
    expect(requestUrl).toHaveBeenCalledTimes(1); expect(plugin.history).toEqual([]); expect(plugin.states).toEqual({});
    plugin.onunload();
  });
  it('persists failure history across restart and retries only the failed memo', async () => {
    const io = new MemoryVault(), app = appFor(io), plugin = new MemosSyncPlugin(app as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ mode: 'individual' }), states: {} };
    let remote = [rawMemo('one'), rawMemo('two')];
    requestUrl.mockImplementation(async () => response({ memos: remote }));
    await plugin.onload(); await plugin.sync();
    io.failPath = 'Memos/2026-10-13 one.md'; remote = [rawMemo('one', { content: 'updated one' }), rawMemo('two')];
    await plugin.sync(); expect(plugin.history[0].status).toBe('partial'); expect(plugin.history[0].retry.memoIds).toEqual(['memos/one']);
    const saved = (plugin as unknown as Plugin).data; plugin.onunload();
    io.failPath = undefined; remote = [rawMemo('one', { content: 'updated one' }), rawMemo('two', { content: 'unrelated changed two' })];
    const reopened = new MemosSyncPlugin(app as any, {} as any); (reopened as unknown as Plugin).data = saved;
    await reopened.onload(); expect(reopened.lastMessage).toContain('本次范围');
    await reopened.retryLastFailures();
    expect(reopened.history[0].mode).toBe('retry'); expect(reopened.history[0].status).toBe('success'); expect(reopened.history[1].resolved).toBe(true);
    expect(io.files.get('Memos/2026-10-13 one.md')).toContain('updated one');
    expect(io.files.get('Memos/2026-10-13 two.md')).not.toContain('unrelated changed two');
    reopened.onunload();
  });
  it('records whole-request failures and retries them after the server recovers', async () => {
    const plugin = new MemosSyncPlugin(appFor() as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings(), states: {} };
    requestUrl.mockResolvedValue(response({}, 500)); await plugin.onload(); await plugin.sync(true);
    expect(plugin.history[0]).toMatchObject({ status: 'failed', retry: { full: true, force: true } });
    requestUrl.mockResolvedValue(response({ memos: [rawMemo()] })); await plugin.retryLastFailures();
    expect(plugin.history[0].status).toBe('success'); expect(plugin.history[0].mode).toBe('retry');
    expect(JSON.stringify(plugin.history)).not.toContain('test-token');
    plugin.onunload();
  });
  it('refuses retry history from another output folder without a request or mutation', async () => {
    const io = new MemoryVault(), plugin = new MemosSyncPlugin(appFor(io) as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings(), states: {} };
    requestUrl.mockResolvedValue(response({}, 500)); await plugin.onload(); await plugin.sync();
    plugin.settings.syncFolder = 'Other'; requestUrl.mockClear();
    await plugin.retryLastFailures(); expect(requestUrl).not.toHaveBeenCalled(); expect(io.files.size).toBe(0); expect(plugin.history).toHaveLength(1);
    plugin.onunload();
  });
  it('limits stored history and exposes all new commands and template controls', async () => {
    const plugin = new MemosSyncPlugin(appFor() as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ historyLimit: 2 }), states: {} };
    requestUrl.mockResolvedValue(response({ memos: [rawMemo()] })); await plugin.onload();
    await plugin.sync(); await plugin.sync(); await plugin.sync(); expect(plugin.history).toHaveLength(2);
    const commands = (plugin as unknown as Plugin).commands;
    expect(['preview', 'preview-all', 'history', 'retry'].every(key => key in commands)).toBe(true);
    const tab = (plugin as unknown as Plugin).tabs[0]; (tab as any).display();
    const textarea = tab.containerEl.querySelector('textarea')!;
    textarea.value = '{{content}}\n\n{{attachments}}'; textarea.dispatchEvent(new Event('change'));
    expect(plugin.settings.bodyTemplate).toBe('{{content}}\n\n{{attachments}}');
    expect(tab.containerEl.querySelector('[data-name="添加笔记属性"]')).not.toBeNull();
    plugin.showHistory(); plugin.showReport(); plugin.onunload();
  });
  it('records a persistence failure as pending work instead of a successful sync', async () => {
    const plugin = new MemosSyncPlugin(appFor() as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings(), states: {} };
    requestUrl.mockResolvedValue(response({ memos: [rawMemo()] })); await plugin.onload();
    vi.spyOn(plugin, 'persist').mockRejectedValue(new Error('cannot save'));
    await plugin.sync(); expect(plugin.history[0].status).toBe('partial'); expect(plugin.history[0].retry.full).toBe(true);
    plugin.onunload();
  });
  it('ordinary sync clears completed failure queues while preserving the historical result', async () => {
    const io = new MemoryVault(), plugin = new MemosSyncPlugin(appFor(io) as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ mode: 'individual' }), states: {} };
    requestUrl.mockResolvedValue(response({ memos: [rawMemo()] })); await plugin.onload();
    io.failPath = 'Memos/2026-10-13 one.md'; await plugin.sync();
    const failed = plugin.history[0]; expect(failed.retry.memoIds).toEqual(['memos/one']);
    io.failPath = undefined; await plugin.sync();
    expect(failed.status).toBe('partial'); expect(failed.resolved).toBe(true); expect(failed.report?.failures).toHaveLength(1);
    requestUrl.mockClear(); await plugin.retryLastFailures(); expect(requestUrl).not.toHaveBeenCalled();
    plugin.onunload();
  });
  it('waits for Paste Image Rename and tracks later attachment renames without false conflicts', async () => {
    const io = new MemoryVault(), app = appFor(io), listeners = new Set<(file: TFile, old: string) => void>();
    const files = new Map<string, TFile>();
    const v = app.vault as any;
    v.on = (_event: string, callback: (file: TFile, old: string) => void) => { listeners.add(callback); return callback; };
    v.offref = (callback: (file: TFile, old: string) => void) => listeners.delete(callback);
    const originalGet = v.getAbstractFileByPath;
    v.getAbstractFileByPath = (path: string) => files.get(path) || originalGet(path);
    v.createBinary = async (path: string, data: ArrayBuffer) => {
      await io.createBinary(path, data);
      const file = Object.assign(new TFile(path), { extension: 'jpeg' }); files.set(path, file);
      window.setTimeout(() => {
        const actual = 'Memos/attachments/auto-renamed.jpeg';
        io.binaries.set(actual, io.binaries.get(path)!); io.binaries.delete(path); files.delete(path); file.path = actual; files.set(actual, file);
        listeners.forEach(callback => callback(file, path));
      }, 50);
      return file;
    };
    Object.assign(app.plugins.plugins, { 'obsidian-paste-image-rename': { settings: { autoRename: true, handleAllAttachments: true } } });
    app.workspace.getActiveFile = () => new TFile('Memos/active.md');
    const plugin = new MemosSyncPlugin(app as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ mode: 'individual' }), states: {} };
    requestUrl.mockImplementation(async req => req.url.includes('/api/v1/memos?') ? response({ memos: [rawMemo('one', { attachments: [{ name: 'attachments/a', filename: 'photo.jpeg', type: 'image/jpeg' }] })] }) : response({}));
    await plugin.onload(); const job = plugin.sync(); await vi.advanceTimersByTimeAsync(2000); await job;
    const path = 'Memos/2026-10-13 one.md', before = 'Memos/attachments/auto-renamed.jpeg';
    expect(io.files.get(path)).toContain(`![[${before}]]`); expect(plugin.history[0].status).toBe('success');
    const after = 'Memos/attachments/renamed-later.jpeg', file = files.get(before)!;
    io.binaries.set(after, io.binaries.get(before)!); io.binaries.delete(before); files.delete(before); file.path = after; files.set(after, file);
    io.files.set(path, rewriteLocalAttachmentPath(io.files.get(path)!, before, after));
    listeners.forEach(callback => callback(file, before));
    requestUrl.mockClear(); await plugin.sync();
    expect(plugin.lastReport?.conflicts).toEqual([]); expect(plugin.lastReport?.downloaded).toBe(0); expect(requestUrl).toHaveBeenCalledTimes(1);
    plugin.onunload();
  });
  it('finds the correct renamed image by bytes even when another image has the same size', async () => {
    const io = new MemoryVault(), app = appFor(io), data = new Uint8Array([1, 2, 3]).buffer;
    io.binaries.set('Memos/attachments/wrong.jpeg', new Uint8Array([3, 2, 1]).buffer);
    io.binaries.set('Memos/attachments/correct.jpeg', data);
    const v = app.vault as any;
    v.getFiles = () => [...io.binaries].map(([path, bytes]) => Object.assign(new TFile(path), { extension: 'jpeg', stat: { size: bytes.byteLength } }));
    v.readBinary = async (file: TFile) => io.binaries.get(file.path);
    const plugin = new MemosSyncPlugin(app as any, {} as any);
    (plugin as unknown as Plugin).data = { settings: settings({ mode: 'individual' }), states: {} };
    requestUrl.mockImplementation(async req => req.url.includes('/api/v1/memos?') ? response({ memos: [rawMemo('one', { attachments: [{ name: 'attachments/a', filename: 'photo.jpeg', type: 'image/jpeg' }] })] }) : response({}, 200, data));
    await plugin.onload(); await plugin.sync();
    expect(io.files.get('Memos/2026-10-13 one.md')).toContain('![[Memos/attachments/correct.jpeg]]');
    expect(io.binaries.size).toBe(2); expect(plugin.lastReport?.downloaded).toBe(0);
    plugin.onunload();
  });
});
