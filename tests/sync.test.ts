import { describe, expect, it, vi } from 'vitest';
import { MemosClient } from '../src/client';
import { managedBody, markers } from '../src/render';
import { SyncEngine } from '../src/sync';
import { emptyState } from '../src/types';
import { dates, MemoryVault, now, rawMemo, response, settings, transportFor } from './helpers';

describe('sync behavior', () => {
  it('creates daily notes and changes only the managed area, without duplicates', async () => {
    const vault = new MemoryVault(), s = settings();
    vault.files.set('Memos/2026-10-13.md', '# 日记\n\n## Memos\n\n我的补充\n\n## 工作\n\n- [x] 工作完成\n');
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    expect(first.report.written).toBe(1);
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('我的补充');
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('## 工作\n\n- [x] 工作完成');
    const unchanged = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, first.state);
    expect(unchanged.report.unchanged).toBe(1); expect(vault.writes).toBe(1);
    const changed = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo('one', { content: 'new content' })])), dates, now).run(s, unchanged.state);
    expect(changed.report.written).toBe(1);
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('new content');
    expect(vault.files.get('Memos/2026-10-13.md')).not.toContain('Memo one');
  });
  it('groups multiple same-time memos and sorts them without losing identities', async () => {
    const vault = new MemoryVault(), s = settings();
    const r = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo('two'), rawMemo('one')])), dates, now).run(s, emptyState());
    expect(Object.keys(r.state.memos)).toHaveLength(2);
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('Memo one');
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('Memo two');
  });
  it('skips local edits, even during force sync, then backs up before replacing', async () => {
    const vault = new MemoryVault(), s = settings();
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const first = await engine.run(s, emptyState());
    const path = 'Memos/2026-10-13.md';
    const local = vault.files.get(path)!.replace('Memo one', 'local edit'); vault.files.set(path, local);
    const skipped = await engine.run(s, first.state, { force: true });
    expect(skipped.report.conflicts).toEqual([path]); expect(vault.files.get(path)).toBe(local);
    const backup = await engine.run({ ...s, conflictPolicy: 'backup' }, skipped.state);
    expect(backup.report.written).toBe(1);
    const backupFile = [...vault.files.keys()].find(p => p.includes('Memos Sync Backups'))!;
    expect(vault.files.get(backupFile)).toBe(local);
  });
  it('detects deleted or damaged ownership markers', async () => {
    const vault = new MemoryVault(), s = settings();
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const first = await engine.run(s, emptyState());
    const path = 'Memos/2026-10-13.md';
    vault.files.set(path, '# removed markers');
    expect((await engine.run(s, first.state)).report.conflicts).toEqual([path]);
    vault.files.set(path, markers(first.state.scope).start);
    const malformed = await engine.run(s, first.state);
    expect(malformed.report.warnings[0]).toContain('标记损坏');
    expect(vault.files.get(path)).toBe(markers(first.state.scope).start);
  });
  it('keeps remote deleted memos by default and can remove only their managed content', async () => {
    const vault = new MemoryVault(), s = settings();
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(), rawMemo('two')])), dates, now).run(s, emptyState());
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const retained = await engine.run(s, first.state);
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('Memo two');
    const mirrored = await engine.run({ ...s, mirrorDeletions: true }, retained.state);
    expect(mirrored.report.removed).toBe(1);
    expect(vault.files.get('Memos/2026-10-13.md')).not.toContain('Memo two');
    expect(vault.files.has('Memos/2026-10-13.md')).toBe(true);
  });
  it('does not remove records beyond the current date window', async () => {
    const vault = new MemoryVault(), s = settings();
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo('old', { createTime: '2026-10-01T04:00:00Z' }), rawMemo()])), dates, now).run(s, emptyState());
    const limited = settings({ daysLimit: 2, mirrorDeletions: true });
    const r = await new SyncEngine(vault, new MemosClient(limited, transportFor([rawMemo()])), dates, now).run(limited, first.state);
    expect(r.report.removed).toBe(0); expect(r.state.memos['memos/old']).toBeDefined();
    expect(vault.files.get('Memos/2026-10-01.md')).toContain('Memo old');
  });
  it('force sync ignores days limit and current-day sync does not touch other days', async () => {
    const vault = new MemoryVault(), s = settings({ daysLimit: 1 });
    const remote = [rawMemo('old', { createTime: '2026-10-01T04:00:00Z' }), rawMemo()];
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor(remote)), dates, now);
    const limited = await engine.run(s, emptyState()); expect(limited.report.selected).toBe(1);
    const full = await engine.run(s, limited.state, { force: true }); expect(full.report.selected).toBe(2);
    const day = await engine.run(s, full.state, { day: '2026-10-01' }); expect(day.report.selected).toBe(1); expect(day.report.unchanged).toBe(1);
  });
  it('does not modify files if any API page fails', async () => {
    const vault = new MemoryVault(), s = settings({ mirrorDeletions: true });
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    const previous = new Map(vault.files);
    const transport = vi.fn().mockResolvedValueOnce(response({ memos: [], nextPageToken: 'next' })).mockResolvedValueOnce(response({}, 500));
    await expect(new SyncEngine(vault, new MemosClient(s, transport), dates, now).run(s, first.state)).rejects.toThrow('HTTP 500');
    expect(vault.files).toEqual(previous);
  });
  it('rechecks changes during an atomic write', async () => {
    const vault = new MemoryVault(), s = settings();
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    vault.beforeProcess = path => vault.files.set(path, vault.files.get(path)!.replace('Memo one', 'concurrent edit'));
    const r = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo('one', { content: 'remote edit' })])), dates, now).run(s, first.state);
    expect(r.report.conflicts).toHaveLength(1); expect(vault.files.get('Memos/2026-10-13.md')).toContain('concurrent edit');
  });
  it('preserves concurrent changes outside the managed block', async () => {
    const vault = new MemoryVault(), s = settings();
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    vault.beforeProcess = path => vault.files.set(path, `${vault.files.get(path)}\nlocal append`);
    const r = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo('one', { content: 'remote edit' })])), dates, now).run(s, first.state);
    expect(r.report.conflicts).toHaveLength(0); expect(vault.files.get('Memos/2026-10-13.md')).toContain('local append');
  });
  it('only acknowledges successfully written files, allowing retry after disk failure', async () => {
    const vault = new MemoryVault(), s = settings(); vault.failPath = 'Memos/2026-10-13.md';
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const failed = await engine.run(s, emptyState()); expect(failed.state.memos).toEqual({}); expect(failed.state.lastSuccess).toBe('');
    vault.failPath = undefined;
    const retry = await engine.run(s, failed.state); expect(retry.report.written).toBe(1);
  });
  it('supports stable individual notes, templates, and nested paths', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual', syncFolder: '笔记/Memos', templatePath: 'Templates/memo.md' });
    vault.files.set('Templates/memo.md', '---\ntype: memo\n---\n\n本地笔记\n');
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(), rawMemo('two')])), dates, now);
    const first = await engine.run(s, emptyState()); expect(first.report.written).toBe(2);
    const path = first.state.memos['memos/one'].path;
    expect(path).toBe('笔记/Memos/2026-10-13 one.md');
    expect(vault.files.get(path)).toContain('type: memo');
    expect((await engine.run(s, first.state)).report.unchanged).toBe(2);
  });
  it('downloads attachments once, rewrites references, and retains remote links when disabled', async () => {
    const vault = new MemoryVault(), s = settings();
    const memo = rawMemo('one', { content: 'image ![photo](/file/attachments/abc/photo.png)', attachments: [{ name: 'attachments/abc', filename: 'photo.png', type: 'image/png' }] });
    const transport = vi.fn(async req => req.url.includes('/api/v1/memos?') ? response({ memos: [memo] }) : response({}));
    const engine = new SyncEngine(vault, new MemosClient(s, transport), dates, now);
    const first = await engine.run(s, emptyState()); expect(first.report.downloaded).toBe(1); expect(vault.binaries.size).toBe(1);
    const body = managedBody(vault.files.get('Memos/2026-10-13.md')!, first.state.scope)!;
    expect(body.match(/!\[\[/g)).toHaveLength(1); expect(body).not.toContain('https://memos.example.com/file/');
    const next = await engine.run(s, first.state); expect(next.report.downloaded).toBe(0);
    const off = await engine.run({ ...s, downloadAttachments: false }, next.state);
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('https://memos.example.com/file/attachments/abc/photo.png');
    expect(off.report.downloaded).toBe(0);
  });
  it('reports attachment failures, writes remote references, and retries the next run', async () => {
    const vault = new MemoryVault(), s = settings();
    const memo = rawMemo('one', { attachments: [{ name: 'attachments/abc', filename: 'a.png', type: 'image/png' }] });
    let fail = true;
    const transport = vi.fn(async req => req.url.includes('/api/v1/memos?') ? response({ memos: [memo] }) : response({}, fail ? 500 : 200));
    const engine = new SyncEngine(vault, new MemosClient(s, transport), dates, now);
    const first = await engine.run(s, emptyState()); expect(first.report.warnings).toHaveLength(1); expect(first.state.lastSuccess).toBe('');
    expect(vault.files.get('Memos/2026-10-13.md')).toContain('/file/attachments/abc/a.png');
    fail = false;
    const retry = await engine.run(s, first.state); expect(retry.report.downloaded).toBe(1); expect(retry.report.warnings).toHaveLength(0);
  });
  it('cleans an old day when creation time is changed remotely', async () => {
    const vault = new MemoryVault(), s = settings();
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    const next = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo('one', { createTime: '2026-10-12T04:00:00Z' })])), dates, now).run(s, first.state);
    expect(managedBody(vault.files.get('Memos/2026-10-13.md')!, next.state.scope)).toBe('');
    expect(vault.files.get('Memos/2026-10-12.md')).toContain('Memo one');
  });
  it('recovers a written region after state persistence was interrupted', async () => {
    const vault = new MemoryVault(), s = settings();
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    await engine.run(s, emptyState());
    const recovery = await engine.run(s, emptyState()); expect(recovery.report.conflicts).toHaveLength(0); expect(recovery.report.unchanged).toBe(1);
  });
});
