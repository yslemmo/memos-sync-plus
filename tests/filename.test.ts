import { describe, expect, it } from 'vitest';
import { individualFilename, memoTitle } from '../src/filename';
import { normalizeMemo, MemosClient } from '../src/client';
import { sourceUrl, managedBody } from '../src/render';
import { SyncEngine } from '../src/sync';
import { emptyState } from '../src/types';
import { stableHash } from '../src/utils';
import { MemoryVault, dates, now, rawMemo, settings, transportFor } from './helpers';

const uid = 'XX8aHdgPnV9ioFYrW6yt78';
const memo = (patch: Record<string, unknown> = {}) => normalizeMemo(rawMemo(uid, patch), 'https://host');

describe('individual filenames', () => {
  it('uses the literal ID in the Memos link, with the creation date', () => {
    expect(individualFilename(memo(), settings(), dates)).toBe(`2026-10-13 ${uid}.md`);
    expect(sourceUrl(memo(), 'https://memos.example.com:4443')).toBe(`https://memos.example.com:4443/memos/${uid}`);
  });
  it('prefers a legacy UID for filenames and links while keeping the API identity', () => {
    const legacy = memo({ name: 'memos/7', uid });
    expect(legacy.id).toBe('memos/7');
    expect(individualFilename(legacy, settings(), dates)).toBe(`2026-10-13 ${uid}.md`);
    expect(sourceUrl(legacy, 'https://host', true)).toBe(`https://host/m/${uid}`);
  });
  it('offers creation and update timestamps with literal IDs for collision safety', () => {
    const m = memo({ updateTime: '2026-10-14T03:26:24Z' });
    expect(individualFilename(m, settings({ fileNameFormat: 'created' }), dates)).toBe(`2026-10-13 12-00-00 ${uid}.md`);
    expect(individualFilename(m, settings({ fileNameFormat: 'updated' }), dates)).toBe(`2026-10-14 11-26-24 ${uid}.md`);
  });
  it('uses the API title first, then the first Markdown line, with ID fallback', () => {
    expect(individualFilename(memo({ property: { title: '今日感想' } }), settings({ fileNameFormat: 'title' }), dates)).toBe(`2026-10-13 今日感想 ${uid}.md`);
    expect(memoTitle(memo({ content: '\n# **散步** [记录](https://host)' }))).toBe('散步 记录');
    expect(individualFilename(memo({ content: '' }), settings({ fileNameFormat: 'title' }), dates)).toBe(`2026-10-13 ${uid}.md`);
  });
  it('retains ID uniqueness for same title and same time', () => {
    const a = memo({ content: 'same' }), b = normalizeMemo(rawMemo('different', { content: 'same' }), 'https://host');
    for (const format of ['created', 'updated', 'title'] as const) expect(individualFilename(a, settings({ fileNameFormat: format }), dates)).not.toBe(individualFilename(b, settings({ fileNameFormat: format }), dates));
  });
  it('sanitizes forbidden title characters and limits the full UTF-8 filename size', () => {
    const result = individualFilename(memo({ content: '# ../' + '中文'.repeat(100) + ':?*|<test>' }), settings({ fileNameFormat: 'title' }), dates);
    expect(result).not.toMatch(/[/:?*|<>]/);
    expect(new TextEncoder().encode(result).length).toBeLessThan(255);
    expect(result.endsWith(` ${uid}.md`)).toBe(true);
  });
  it('prevents sanitized nonstandard IDs from colliding', () => {
    expect(individualFilename(memo({ name: 'memos/a:b' }), settings(), dates)).not.toBe(individualFilename(memo({ name: 'memos/a?b' }), settings(), dates));
  });
});

describe('filename migration', () => {
  it('renames v1.0 hashed names in place and preserves content outside the region', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid)])), dates, now);
    const first = await engine.run(s, emptyState());
    const id = `memos/${uid}`, target = first.state.memos[id].path;
    const hashed = `Memos/2026-10-13 ${stableHash(id)}.md`;
    await vault.rename(target, hashed);
    vault.files.set(hashed, vault.files.get(hashed)! + '\n## 本地补充\n保留内容');
    const old = { ...first.state, memos: { [id]: { ...first.state.memos[id], path: hashed } }, blocks: { [hashed]: first.state.blocks[target] } };
    const next = await engine.run(s, old);
    expect(next.report.renamed).toBe(1); expect(vault.files.has(hashed)).toBe(false);
    expect(vault.files.get(target)).toContain('保留内容');
    expect(next.state.memos[id].path).toBe(target); expect(next.state.blocks[hashed]).toBeUndefined();
    expect((await engine.run(s, next.state)).report.renamed).toBe(0);
  });
  it('renames on a title change without leaving an empty old note', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual', fileNameFormat: 'title' });
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid, { content: '# Old title' })])), dates, now).run(s, emptyState());
    const next = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid, { content: '# New title' })])), dates, now).run(s, first.state);
    expect(next.report.renamed).toBe(1); expect(vault.files.size).toBe(1);
    expect(vault.files.has(`Memos/2026-10-13 New title ${uid}.md`)).toBe(true);
    expect(vault.files.has(`Memos/2026-10-13 Old title ${uid}.md`)).toBe(false);
  });
  it('renames when the update time changes and preserves the ID', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual', fileNameFormat: 'updated' });
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid)])), dates, now).run(s, emptyState());
    const next = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid, { updateTime: '2026-10-14T03:26:24Z' })])), dates, now).run(s, first.state);
    expect(next.state.memos[`memos/${uid}`].path).toBe(`Memos/2026-10-14 11-26-24 ${uid}.md`);
    expect(vault.files.size).toBe(1);
  });
  it('skips local modifications before renaming and can back up after moving', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid)])), dates, now);
    const first = await engine.run(s, emptyState());
    const oldPath = first.state.memos[`memos/${uid}`].path;
    vault.files.set(oldPath, vault.files.get(oldPath)!.replace(`Memo ${uid}`, 'my local edit'));
    const localContent = vault.files.get(oldPath);
    const changed = { ...s, fileNameFormat: 'created' as const };
    const skipped = await engine.run(changed, first.state);
    expect(skipped.report.conflicts).toEqual([oldPath]); expect(vault.files.size).toBe(1);
    const backedUp = await engine.run({ ...changed, conflictPolicy: 'backup' }, skipped.state);
    expect(backedUp.report.renamed).toBe(1);
    const backup = [...vault.files.keys()].find(k => k.includes('Memos Sync Backups'))!;
    expect(vault.files.get(backup)).toBe(localContent);
  });
  it('does not overwrite an existing rename destination', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid)])), dates, now);
    const first = await engine.run(s, emptyState());
    const target = `Memos/2026-10-13 12-00-00 ${uid}.md`;
    vault.files.set(target, 'unrelated');
    const result = await engine.run({ ...s, fileNameFormat: 'created' }, first.state);
    expect(result.report.conflicts).toHaveLength(1); expect(vault.files.get(target)).toBe('unrelated');
    expect(result.state.memos[`memos/${uid}`].path).toBe(first.state.memos[`memos/${uid}`].path);
  });
  it('recovers after a completed rename but interrupted state persistence', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid)])), dates, now);
    const first = await engine.run(s, emptyState());
    const target = `Memos/2026-10-13 12-00-00 ${uid}.md`;
    await vault.rename(first.state.memos[`memos/${uid}`].path, target);
    const result = await engine.run({ ...s, fileNameFormat: 'created' }, first.state);
    expect(result.report.conflicts).toHaveLength(0); expect(result.state.memos[`memos/${uid}`].path).toBe(target); expect(vault.files.size).toBe(1);
  });
  it('retains the old tracked path after rename failure and retries safely', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid)])), dates, now);
    const first = await engine.run(s, emptyState());
    vault.failRename = true;
    const failed = await engine.run({ ...s, fileNameFormat: 'created' }, first.state);
    expect(failed.report.warnings).toHaveLength(1); expect(failed.state.memos[`memos/${uid}`].path).toBe(first.state.memos[`memos/${uid}`].path);
    vault.failRename = false;
    const retried = await engine.run({ ...s, fileNameFormat: 'created' }, failed.state);
    expect(retried.report.renamed).toBe(1); expect(vault.files.size).toBe(1);
  });
  it('keeps a renamed path tracked when the subsequent write fails', async () => {
    const vault = new MemoryVault(), s = settings({ mode: 'individual' });
    const first = await new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid)])), dates, now).run(s, emptyState());
    const target = `Memos/2026-10-13 12-00-00 ${uid}.md`; vault.failPath = target;
    const engine = new SyncEngine(vault, new MemosClient(s, transportFor([rawMemo(uid, { content: 'new' })])), dates, now);
    const failed = await engine.run({ ...s, fileNameFormat: 'created' }, first.state);
    expect(failed.report.warnings).toHaveLength(1); expect(failed.state.memos[`memos/${uid}`].path).toBe(target);
    vault.failPath = undefined;
    const retried = await engine.run({ ...s, fileNameFormat: 'created' }, failed.state);
    expect(retried.report.conflicts).toHaveLength(0); expect(managedBody(vault.files.get(target)!, retried.state.scope)).toContain('new');
  });
});
