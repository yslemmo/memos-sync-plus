import { MemosClient } from './client';
import { managedBody, renderMemo, replaceManaged, validateBodyTemplate } from './render';
import type { Memo, Settings, SyncReport, SyncState, VaultIO, PreviewChange } from './types';
import { emptyState } from './types';
import { individualFilename } from './filename';
import { rewriteAttachmentReferences, rewriteLocalAttachmentPath } from './attachments';
import { PreviewVault } from './preview';
import { managedProperties, mergeProperties, noteProperties, propertySignature } from './properties';
import type { NoteProperties } from './properties';
import { ensureFolder, joinPath, linkLabel, linkTarget, parentFolder, safeFilename, stableHash, vaultPath } from './utils';

export interface ClockFormat { date(iso: string, format: string): string; time(iso: string): string; hour(iso: string): number }
export interface SyncOptions { force?: boolean; day?: string; memoIds?: string[]; expectedScope?: string }
export interface SyncResult { state: SyncState; report: SyncReport }
export interface PreviewResult extends SyncResult { changes: PreviewChange[] }

export class SyncEngine {
  constructor(private io: VaultIO, private client: MemosClient, private dates: ClockFormat, private now = () => new Date(), private dryRun = false) {}
  async preview(settings: Settings, previous: SyncState, options: SyncOptions = {}): Promise<PreviewResult> {
    const overlay = new PreviewVault(this.io);
    const result = await new SyncEngine(overlay, this.client, this.dates, this.now, true).run(settings, previous, options);
    if (previous.scope === result.state.scope) for (const [id, tracked] of Object.entries(previous.memos)) {
      if (!result.state.memos[id]) overlay.changes.push({ action: 'remove', path: tracked.path, memoId: id });
    }
    return { ...result, changes: overlay.changes };
  }
  async run(settings: Settings, previous: SyncState, options: SyncOptions = {}): Promise<SyncResult> {
    validateBodyTemplate(settings.bodyTemplate ?? '');
    vaultPath(settings.syncFolder, true); vaultPath(settings.attachmentFolder);
    if (!settings.heading.trim() || /[\r\n]/.test(settings.heading)) throw new Error('同步标题不能为空或包含换行。');
    if (!Number.isInteger(settings.daysLimit) || settings.daysLimit < 0) throw new Error('同步天数必须是大于等于 0 的整数。');
    if (!Number.isFinite(settings.maxAttachmentMB) || settings.maxAttachmentMB < 1) throw new Error('附件大小限制必须大于等于 1 MB。');
    const creator = await this.client.resolveCreator();
    const scope = stableHash(JSON.stringify([this.client.base, creator, settings.mode, settings.syncFolder, settings.dateFormat]));
    if (options.expectedScope && scope !== options.expectedScope) throw new Error('当前 Memos 用户与失败记录不同，请切回原账户后重试。');
    const original = previous.scope === scope ? previous : { ...emptyState(), scope };
    const old: SyncState = { ...original, memos: { ...original.memos }, blocks: { ...original.blocks }, properties: { ...original.properties }, attachments: { ...original.attachments } };
    const state: SyncState = { ...old, memos: { ...old.memos }, blocks: { ...old.blocks }, properties: { ...old.properties }, attachments: { ...old.attachments } };
    const remaps = new Map<string, string>();
    const report: SyncReport = { fetched: 0, selected: 0, written: 0, unchanged: 0, conflicts: [], warnings: [], downloaded: 0, removed: 0, renamed: 0, failures: [], processedMemoIds: [] };
    const start = this.now();
    // Local time filtering avoids incompatible integer/timestamp CEL expressions across Memos versions.
    const cutoff = new Date(start);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - Math.max(0, settings.daysLimit - 1));
    const inRange = (iso: string) => options.day ? this.dates.date(iso, settings.dateFormat) === options.day
      : options.force || settings.daysLimit === 0 || new Date(iso).getTime() >= cutoff.getTime();
    const all = await this.client.listAll(creator);
    report.fetched = all.length;
    const targets = options.memoIds ? new Set(options.memoIds) : undefined;
    const selected = all.filter(m => inRange(m.created) && (!targets || targets.has(m.id)));
    report.selected = selected.length;
    report.processedMemoIds = selected.map(m => m.id);
    const selectedIds = new Set(selected.map(m => m.id));
    const pending = new Map<string, { path: string; created: string; body: string }>();
    const touched = new Set<string>();
    const removedIds = new Set<string>();
    const metadata = new Map<string, NoteProperties>();
    const ordered = selected.sort((a, b) => {
      const order = a.created.localeCompare(b.created) || a.id.localeCompare(b.id);
      return settings.newestFirst ? -order : order;
    });
    // The complete remote snapshot is read before any note changes or deletion decisions.
    for (const memo of ordered) {
      const date = this.dates.date(memo.created, settings.dateFormat);
      const filename = settings.mode === 'daily' ? `${date}.md` : individualFilename(memo, settings, this.dates);
      const path = joinPath(settings.syncFolder, filename);
      if (settings.mode === 'individual' && old.memos[memo.id] && old.memos[memo.id].path !== path) {
        if (!await this.relocateMemo(memo.id, path, scope, old, state, settings, report)) continue;
      }
      const prepared = await this.withAttachments(memo, settings, scope, report, state, remaps);
      const body = renderMemo(memo, prepared.content, settings, this.dates.time(memo.created), this.dates.hour(memo.created), this.client.base,
        { attachments: prepared.attachments, date: this.dates.date(memo.created, 'YYYY-MM-DD') });
      if (settings.mode === 'individual' && settings.noteProperties) metadata.set(path, noteProperties(memo, this.client.base, settings.apiMode === 'legacy'));
      pending.set(memo.id, { path, created: memo.created, body });
      touched.add(path);
      if (old.memos[memo.id] && old.memos[memo.id].path !== path) touched.add(old.memos[memo.id].path);
    }
    for (const [id, tracked] of Object.entries(old.memos)) {
      if (!inRange(tracked.created) || (targets && !targets.has(id))) continue;
      if (!selectedIds.has(id) && settings.mirrorDeletions) { removedIds.add(id); touched.add(tracked.path); }
    }
    const merged = { ...old.memos };
    for (const id of removedIds) delete merged[id];
    for (const [id, memo] of pending) merged[id] = memo;
    const committed = new Set<string>();
    for (const path of [...touched].sort()) {
      const entries = Object.values(merged).filter(m => m.path === path).sort((a, b) => {
        const cmp = a.created.localeCompare(b.created) || a.body.localeCompare(b.body);
        return settings.newestFirst ? -cmp : cmp;
      });
      // Other plugins may rename an attachment after createBinary resolves. Recheck live paths at commit.
      if (this.io.resolveBinary) for (const [key, before] of Object.entries(state.attachments!)) {
        const actual = await this.io.resolveBinary(before);
        if (actual && actual !== before) { state.attachments![key] = actual; remaps.set(before, actual); }
      }
      const remap = (text: string) => {
        let value = text;
        for (const [from, to] of remaps) value = rewriteLocalAttachmentPath(value, from, to);
        return value;
      };
      for (const [id, entry] of pending) {
        const changed = { ...entry, body: remap(entry.body) };
        pending.set(id, changed); merged[id] = changed;
      }
      const body = remap(entries.map(m => m.body).join('\n\n'));
      const affectedIds = [...pending].filter(([id, value]) => value.path === path || old.memos[id]?.path === path).map(([id]) => id);
      const deletedIds = [...removedIds].filter(id => old.memos[id].path === path);
      const memoIds = [...new Set([...affectedIds, ...deletedIds])];
      try {
        const props = metadata.get(path);
        const expected = old.blocks[path];
        const alternative = expected === undefined ? undefined : remap(expected);
        const outcome = await this.writeNote(path, body, scope, expected, settings, report, props, old.properties?.[path], alternative);
        if (outcome) {
          state.blocks[path] = body; committed.add(path);
          if (props) state.properties![path] = propertySignature(props);
        } else report.failures.push({ kind: 'conflict', memoIds, path, message: '本地同步区域或笔记属性有冲突，已跳过。' });
      } catch (error) {
        const message = `${path}：${error instanceof Error ? error.message : '写入失败'}`;
        report.warnings.push(message); report.failures.push({ kind: 'note', memoIds, path, message });
      }
    }
    // Only acknowledge records whose complete update (including an old date) was written successfully.
    for (const [id, memo] of pending) {
      if (committed.has(memo.path) && (!old.memos[id] || old.memos[id].path === memo.path || committed.has(old.memos[id].path))) state.memos[id] = memo;
    }
    for (const id of removedIds) {
      if (committed.has(old.memos[id].path)) { delete state.memos[id]; report.removed++; report.processedMemoIds.push(id); }
    }
    if (!report.conflicts.length && !report.warnings.length) state.lastSuccess = start.toISOString();
    return { state, report };
  }
  private async relocateMemo(id: string, path: string, scope: string, old: SyncState, state: SyncState, settings: Settings, report: SyncReport): Promise<boolean> {
    const tracked = old.memos[id], source = tracked.path;
    try {
      const sourceExists = await this.io.exists(source), targetExists = await this.io.exists(path);
      if (sourceExists && targetExists) {
        const message = `${source} → ${path}：目标文件已存在，未覆盖。`;
        report.conflicts.push(message); report.failures.push({ kind: 'conflict', memoIds: [id], path, message });
        return false;
      }
      if (sourceExists) {
        const content = await this.io.read(source);
        const current = managedBody(content, scope);
        const changedProps = settings.noteProperties && old.properties?.[source] !== undefined && managedProperties(content) !== old.properties[source];
        if ((current !== old.blocks[source] || changedProps) && settings.conflictPolicy === 'skip') {
          report.conflicts.push(source); report.failures.push({ kind: 'conflict', memoIds: [id], path: source, message: '本地修改冲突，未重命名。' }); return false;
        }
        await ensureFolder(this.io, parentFolder(path));
        // Obsidian's FileManager.renameFile preserves the full note and updates local backlinks.
        await this.io.rename(source, path);
        report.renamed++;
      } else if (targetExists) {
        // Recover a rename completed before the sync cache could be persisted.
        if (managedBody(await this.io.read(path), scope) === null) {
          report.conflicts.push(path); report.failures.push({ kind: 'conflict', memoIds: [id], path, message: '无法确认已重命名笔记的同步区域。' }); return false;
        }
      }
      const moved = { ...tracked, path };
      old.memos[id] = moved; state.memos[id] = moved;
      if (old.blocks[source] !== undefined) { old.blocks[path] = old.blocks[source]; state.blocks[path] = old.blocks[source]; }
      delete old.blocks[source]; delete state.blocks[source];
      if (old.properties?.[source] !== undefined) { old.properties[path] = old.properties[source]; state.properties![path] = old.properties[source]; }
      delete old.properties?.[source]; delete state.properties?.[source];
      return true;
    } catch (error) {
      const message = `${source} → ${path}：${error instanceof Error ? error.message : '重命名失败'}`;
      report.warnings.push(message); report.failures.push({ kind: 'rename', memoIds: [id], path, message });
      return false;
    }
  }
  private async withAttachments(memo: Memo, settings: Settings, scope: string, report: SyncReport, state: SyncState, remaps: Map<string, string>): Promise<{ content: string; attachments: string }> {
    let content = memo.content;
    const extras: string[] = [];
    const separate = Boolean(settings.bodyTemplate?.includes('{{attachments}}'));
    for (const attachment of memo.attachments) {
      let target = attachment.url, local = false;
      if (settings.downloadAttachments) {
        const key = stableHash(JSON.stringify([this.client.base, attachment.id, attachment.url]));
        const planned = joinPath(settings.attachmentFolder, `${scope.slice(0, 8)}-${stableHash(attachment.id + attachment.url)}-${safeFilename(attachment.filename)}`);
        const cached = state.attachments![key];
        let path = cached || planned;
        try {
          const live = await this.io.resolveBinary?.(path);
          if (live) path = live;
          if (!await this.io.exists(path)) {
            const maxBytes = settings.maxAttachmentMB * 1024 * 1024;
            if (attachment.size > maxBytes) throw new Error('附件超过下载大小限制');
            const data = this.dryRun ? new ArrayBuffer(0) : await this.client.download(attachment.url, maxBytes);
            const recovered = !this.dryRun ? await this.io.findBinary?.(data, settings.attachmentFolder) : undefined;
            if (recovered) path = recovered;
            else {
              await ensureFolder(this.io, parentFolder(planned));
              path = await this.io.createBinary(planned, data) || planned;
              report.downloaded++;
            }
          }
          path = await this.io.resolveBinary?.(path) || path;
          if (!await this.io.exists(path)) throw new Error('附件创建后已移动或重命名，尚未找到实际文件路径');
          if (cached && cached !== path) remaps.set(cached, path);
          if (planned !== path) remaps.set(planned, path);
          state.attachments![key] = path;
          target = path; local = true;
        } catch (error) {
          const message = `附件 ${linkLabel(attachment.filename)}：${error instanceof Error ? error.message : '下载失败'}；保留远程链接，下次重试。`;
          report.warnings.push(message); report.failures.push({ kind: 'attachment', memoIds: [memo.id], attachmentId: attachment.id, path, message });
        }
      }
      const image = attachment.mime.startsWith('image/');
      const link = local ? `${image ? '!' : ''}[[${target}]]` : `${image ? '!' : ''}[${linkLabel(attachment.filename)}](${linkTarget(target)})`;
      const rewritten = rewriteAttachmentReferences(content, attachment, separate ? '' : link, this.client.base);
      content = rewritten.content;
      if (separate || !rewritten.referenced) extras.push(link);
    }
    const attachments = extras.join('\n\n');
    return { content: separate ? content : content + (attachments ? `\n\n${attachments}` : ''), attachments: separate ? attachments : '' };
  }
  private async writeNote(path: string, body: string, scope: string, expected: string | undefined, settings: Settings, report: SyncReport, props?: NoteProperties, expectedProps?: string, renamedExpected?: string): Promise<boolean> {
    const decorate = (note: string) => props ? mergeProperties(note, props) : note;
    if (!await this.io.exists(path)) {
      if (!body) { report.unchanged++; return true; }
      let template = '';
      if (settings.templatePath.trim()) {
        const templatePath = vaultPath(settings.templatePath);
        template = await this.io.read(templatePath);
        const filenameDate = path.slice(path.lastIndexOf('/') + 1, -3);
        template = template.replace(/\{\{date\}\}/g, filenameDate).replace(/\{\{time\}\}/g, this.dates.time(this.now().toISOString()));
      }
      await ensureFolder(this.io, parentFolder(path));
      await this.io.create(path, decorate(replaceManaged(template, scope, body, settings.heading.trim())));
      report.written++; return true;
    }
    const snapshot = await this.io.read(path);
    const current = managedBody(snapshot, scope);
    const currentProps = props ? managedProperties(snapshot) : null;
    const desiredProps = props ? propertySignature(props) : null;
    const next = decorate(replaceManaged(snapshot, scope, body, settings.heading.trim()));
    if (current === body && (!props || next === snapshot)) { report.unchanged++; return true; }
    const changedLocally = (current !== body && (expected === undefined ? current !== null : current !== expected && current !== renamedExpected)) ||
      Boolean(props && currentProps !== desiredProps && (expectedProps === undefined ? currentProps !== null : currentProps !== expectedProps));
    if (changedLocally && settings.conflictPolicy === 'skip') { report.conflicts.push(path); return false; }
    if (changedLocally) {
      const folder = joinPath(settings.syncFolder, 'Memos Sync Backups');
      await ensureFolder(this.io, folder);
      const key = `${this.now().getTime()}-${stableHash(path + snapshot)}`;
      const backup = joinPath(folder, `${key}-${safeFilename(path.split('/').pop()!)}`);
      if (!await this.io.exists(backup)) await this.io.create(backup, snapshot);
    }
    let conflict = false;
    await this.io.process(path, note => {
      // The atomic Vault.process callback rechecks the region after attachments and backups complete.
      if (managedBody(note, scope) !== current || (props && managedProperties(note) !== currentProps)) { conflict = true; return note; }
      return decorate(replaceManaged(note, scope, body, settings.heading.trim()));
    });
    if (conflict) { report.conflicts.push(path); return false; }
    report.written++; return true;
  }
}
