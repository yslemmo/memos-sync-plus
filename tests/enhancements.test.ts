import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { MemosClient, normalizeMemo } from '../src/client';
import { SyncEngine } from '../src/sync';
import { renderMemo, validateBodyTemplate, managedBody } from '../src/render';
import { managedProperties, mergeProperties, noteProperties } from '../src/properties';
import { emptyState } from '../src/types';
import { dates, MemoryVault, now, rawMemo, response, settings, transportFor } from './helpers';

const yaml = (text: string) => parse(/^---\n([\s\S]*?)\n---/.exec(text)![1]);
describe('read-only sync preview', () => {
  it('plans notes and attachment downloads without any real vault mutations, downloads or cache changes', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const remote = rawMemo('one', { attachments: [{ name: 'attachments/photo', filename: 'a.png', type: 'image/png' }] });
    const transport = vi.fn(async request => request.url.includes('/api/v1/memos?') ? response({ memos: [remote] }) : response({}, 500));
    const mutations = ['create', 'process', 'mkdir', 'createBinary', 'rename'].map(method => vi.spyOn(io, method as 'create'));
    const previous = emptyState(), snapshot = JSON.stringify(previous);
    const result = await new SyncEngine(io, new MemosClient(s, transport), dates, now).preview(s, previous);
    expect(result.changes.map(c => c.action)).toEqual(['attachment', 'create']);
    expect(result.report.downloaded).toBe(1); expect(result.report.written).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1); mutations.forEach(m => expect(m).not.toHaveBeenCalled());
    expect(JSON.stringify(previous)).toBe(snapshot); expect(io.files.size).toBe(0); expect(io.binaries.size).toBe(0); expect(io.folders.size).toBe(0);
  });
  it('previews rename, metadata and content updates without changing the original note', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const first = await engine.run(s, emptyState()), before = new Map(io.files), cache = JSON.stringify(first.state);
    const preview = await engine.preview({ ...s, fileNameFormat: 'created' }, first.state);
    expect(preview.report.renamed).toBe(1); expect(preview.changes.some(c => c.action === 'rename')).toBe(true);
    expect(io.files).toEqual(before); expect(JSON.stringify(first.state)).toBe(cache);
  });
  it('shows deletion details but retains real notes and state', async () => {
    const io = new MemoryVault(), s = settings({ mirrorDeletions: true });
    const first = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    const before = new Map(io.files);
    const preview = await new SyncEngine(io, new MemosClient(s, transportFor([])), dates, now).preview(s, first.state);
    expect(preview.changes).toContainEqual({ action: 'remove', path: 'Memos/2026-10-13.md', memoId: 'memos/one' });
    expect(io.files).toEqual(before); expect(first.state.memos['memos/one']).toBeDefined();
  });
  it('previews backups for local conflicts without creating a backup', async () => {
    const io = new MemoryVault(), s = settings();
    const engine = new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const first = await engine.run(s, emptyState());
    io.files.set('Memos/2026-10-13.md', io.files.get('Memos/2026-10-13.md')!.replace('Memo one', 'local'));
    const before = new Map(io.files);
    const result = await engine.preview({ ...s, conflictPolicy: 'backup' }, first.state);
    expect(result.changes.some(c => c.action === 'backup')).toBe(true); expect(io.files).toEqual(before);
  });
  it('a subsequent actual sync uses fresh data rather than the preview snapshot', async () => {
    const io = new MemoryVault(), s = settings(); let text = 'preview';
    const transport = vi.fn(async () => response({ memos: [rawMemo('one', { content: text })] }));
    const engine = new SyncEngine(io, new MemosClient(s, transport), dates, now);
    await engine.preview(s, emptyState()); text = 'latest';
    await engine.run(s, emptyState()); expect(io.files.get('Memos/2026-10-13.md')).toContain('latest');
  });
});

describe('structured failures and targeted retry', () => {
  it('does not queue unrelated cached daily records when a targeted write fails', async () => {
    const io = new MemoryVault(), s = settings();
    const first = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one'), rawMemo('two')])), dates, now).run(s, emptyState());
    io.failPath = 'Memos/2026-10-13.md';
    const failed = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one', { content: 'updated one' }), rawMemo('two', { content: 'updated two' })])), dates, now).run(s, first.state, { memoIds: ['memos/one'] });
    expect(failed.report.failures[0].memoIds).toEqual(['memos/one']);
  });
  it('retries only failed memos and keeps unrelated edited notes unchanged', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const first = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one'), rawMemo('two')])), dates, now).run(s, emptyState());
    const oldTwo = io.files.get('Memos/2026-10-13 two.md');
    io.failPath = 'Memos/2026-10-13 one.md';
    const engine = new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one', { content: 'updated one' }), rawMemo('two', { content: 'updated two' })])), dates, now);
    const failed = await engine.run(s, first.state, { force: true, memoIds: ['memos/one'] });
    expect(failed.report.failures).toMatchObject([{ kind: 'note', memoIds: ['memos/one'] }]);
    io.failPath = undefined;
    const retry = await engine.run(s, failed.state, { force: true, memoIds: ['memos/one'] });
    expect(retry.report.selected).toBe(1); expect(io.files.get('Memos/2026-10-13 one.md')).toContain('updated one');
    expect(io.files.get('Memos/2026-10-13 two.md')).toBe(oldTwo);
  });
  it('targeted daily retry retains other records and does not mirror their deletion', async () => {
    const io = new MemoryVault(), s = settings({ mirrorDeletions: true });
    const first = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one'), rawMemo('two')])), dates, now).run(s, emptyState());
    const result = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one', { content: 'updated one' })])), dates, now).run(s, first.state, { force: true, memoIds: ['memos/one'] });
    expect(result.report.removed).toBe(0); expect(result.state.memos['memos/two']).toBeDefined();
    expect(io.files.get('Memos/2026-10-13.md')).toContain('Memo two');
  });
  it('records failed attachment identity and bypasses a changed date limit on retry', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const remote = rawMemo('old', { createTime: '2026-10-01T04:00:00Z', attachments: [{ name: 'attachments/a', filename: 'a.png', type: 'image/png' }] });
    let fail = true;
    const transport = vi.fn(async req => req.url.includes('/api/v1/memos?') ? response({ memos: [remote] }) : response({}, fail ? 500 : 200));
    const engine = new SyncEngine(io, new MemosClient(s, transport), dates, now);
    const first = await engine.run(s, emptyState()); expect(first.report.failures[0]).toMatchObject({ kind: 'attachment', memoIds: ['memos/old'], attachmentId: 'attachments/a' });
    fail = false;
    const retry = await engine.run({ ...s, daysLimit: 1 }, first.state, { force: true, memoIds: ['memos/old'], expectedScope: first.state.scope });
    expect(retry.report.downloaded).toBe(1); expect(retry.report.failures).toEqual([]);
  });
  it('rejects retries for a different actual user before modifying the vault', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const first = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    const before = new Map(io.files), other = settings({ mode: 'individual', creator: 'users/other' });
    await expect(new SyncEngine(io, new MemosClient(other, transportFor([])), dates, now).run(other, first.state, { expectedScope: first.state.scope })).rejects.toThrow('用户');
    expect(io.files).toEqual(before);
  });
});

describe('note properties', () => {
  it('supports empty frontmatter and does not interpret an inner horizontal rule as frontmatter', () => {
    const props = noteProperties(normalizeMemo(rawMemo(), 'https://host'), 'https://host', false);
    expect(yaml(mergeProperties('---\n---\n# 内容', props)).memos_id).toBe('one');
    expect(mergeProperties('# 内容\n---\ninner: value\n---', props)).toContain('# 内容\n---\ninner: value\n---');
  });
  it('adds raw ID, timestamps, origin, creator and API tags to individual notes', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const result = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one', { tags: ['生活', '健康/运动'] })])), dates, now).run(s, emptyState());
    const props = yaml(io.files.get(result.state.memos['memos/one'].path)!);
    expect(props).toMatchObject({ memos_id: 'one', memos_created: '2026-10-13T04:00:00.000Z', memos_updated: '2026-10-13T04:00:00.000Z', memos_source: 'https://memos.example.com/memos/one', memos_creator: 'users/lemmo', tags: ['生活', '健康/运动'] });
  });
  it('preserves custom properties and merges native tags', () => {
    const note = '---\ncategory: 阅读\nrating: 5\ntags:\n  - 本地\n---\n# 内容';
    const props = noteProperties(normalizeMemo(rawMemo('one', { tags: ['远程', '本地'] }), 'https://host'), 'https://host', false);
    const result = mergeProperties(note, props);
    expect(yaml(result)).toMatchObject({ category: '阅读', rating: 5, tags: ['本地', '远程'] }); expect(result).toContain('# 内容');
  });
  it('updates remote properties atomically but skips local changes to owned fields', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const first = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    const path = first.state.memos['memos/one'].path;
    const changed = new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one', { updateTime: '2026-10-14T04:00:00Z' })])), dates, now);
    const second = await changed.run(s, first.state); expect(yaml(io.files.get(path)!).memos_updated).toBe('2026-10-14T04:00:00.000Z');
    io.files.set(path, io.files.get(path)!.replace('memos_id: one', 'memos_id: local'));
    const local = io.files.get(path);
    const skipped = await changed.run(s, second.state); expect(skipped.report.conflicts).toEqual([path]); expect(io.files.get(path)).toBe(local);
  });
  it('backs up before overriding locally changed owned metadata', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const first = await engine.run(s, emptyState()), path = first.state.memos['memos/one'].path;
    io.files.set(path, io.files.get(path)!.replace('memos_id: one', 'memos_id: local'));
    const local = io.files.get(path);
    await engine.run({ ...s, conflictPolicy: 'backup' }, first.state);
    const backup = [...io.files.keys()].find(k => k.includes('Memos Sync Backups'))!;
    expect(io.files.get(backup)).toBe(local); expect(yaml(io.files.get(path)!).memos_id).toBe('one');
  });
  it('preserves concurrent custom fields while detecting concurrent owned-field changes', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const first = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    const engine = new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one', { content: 'new' })])), dates, now);
    io.beforeProcess = path => io.files.set(path, io.files.get(path)!.replace('---\n', '---\ncustom: preserved\n'));
    const second = await engine.run(s, first.state); expect(second.report.conflicts).toEqual([]); expect(yaml(io.files.get(second.state.memos['memos/one'].path)!).custom).toBe('preserved');
    io.beforeProcess = path => io.files.set(path, io.files.get(path)!.replace('memos_id: one', 'memos_id: concurrent'));
    const third = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo('one', { content: 'newer' })])), dates, now).run(s, second.state);
    expect(third.report.conflicts).toHaveLength(1); expect(yaml(io.files.get(third.state.memos['memos/one'].path)!).memos_id).toBe('concurrent');
  });
  it('leaves notes unchanged when properties are disabled and never adds single-memo fields to daily notes', async () => {
    for (const s of [settings({ mode: 'individual', noteProperties: false }), settings({ mode: 'daily', noteProperties: true })]) {
      const io = new MemoryVault(); await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
      expect([...io.files.values()][0]).not.toContain('memos_id:');
    }
  });
  it('reports invalid YAML without overwriting it and can retry after repair', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    io.files.set('Memos/2026-10-13 one.md', '---\ninvalid: [\n---\nlocal');
    const snapshot = io.files.get('Memos/2026-10-13 one.md');
    const result = await new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now).run(s, emptyState());
    expect(result.report.failures[0].kind).toBe('note'); expect(io.files.get('Memos/2026-10-13 one.md')).toBe(snapshot);
  });
  it('reuses property signatures after rename, avoiding false conflicts on a later sync', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const first = await engine.run(s, emptyState());
    const renamed = await engine.run({ ...s, fileNameFormat: 'created' }, first.state);
    const path = renamed.state.memos['memos/one'].path;
    expect(renamed.state.properties?.[path]).toBe(managedProperties(io.files.get(path)!));
    expect((await engine.run({ ...s, fileNameFormat: 'created' }, renamed.state)).report.unchanged).toBe(1);
  });
});

describe('custom body templates', () => {
  it('indents multi-line content in list and callout templates', () => {
    const m = normalizeMemo(rawMemo(), 'https://host');
    const list = renderMemo(m, '# 标题\n- [ ] 待办\n```js\ncode\n```', settings({ bodyTemplate: '- {{time}}\n  {{content}}' }), '12:00', 12, 'https://host');
    expect(list).toContain('  - [ ] 待办\n  ```js\n  code\n  ```');
    const quote = renderMemo(m, '第一行\n第二行', settings({ bodyTemplate: '> [!memo] {{time}}\n> {{content}}' }), '12:00', 12, 'https://host');
    expect(quote).toContain('> 第一行\n> 第二行');
  });
  it('validates supported tokens and requires content before any network or writes', async () => {
    expect(() => validateBodyTemplate('{{content}}\n{{time}}')).not.toThrow();
    expect(() => validateBodyTemplate('{{title}}')).toThrow('content');
    expect(() => validateBodyTemplate('{{content}}\n{{unknown}}')).toThrow('unknown');
    expect(() => validateBodyTemplate('{{content}}\n<!-- memos-sync:bad:start -->')).toThrow('同步标记');
    const transport = vi.fn(), io = new MemoryVault(), s = settings({ bodyTemplate: '{{unknown}}' });
    await expect(new SyncEngine(io, new MemosClient(s, transport), dates, now).run(s, emptyState())).rejects.toThrow('content');
    expect(transport).not.toHaveBeenCalled(); expect(io.files.size).toBe(0);
  });
  it('renders tokens once without interpreting tokens or JavaScript in remote content', () => {
    const m = normalizeMemo(rawMemo('one', { content: '{{updated}}\n<script>test</script>', tags: ['tag'] }), 'https://host');
    const text = renderMemo(m, m.content, settings({ bodyTemplate: '# {{title}}\n{{content}}\n{{id}} {{date}} {{time}} {{tags}}', emoji: false }), '12:00', 12, 'https://host', { date: '2026-10-13' });
    expect(text).toContain('{{updated}}'); expect(text).toContain('one 2026-10-13 12:00 #tag');
  });
  it('separates inline attachments into the chosen position without duplicate images or the default footer', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual', bodyTemplate: '{{attachments}}\n\n{{content}}' });
    const remote = rawMemo('one', { content: '正文\n![image](/file/attachments/a)', attachments: [{ name: 'attachments/a', filename: 'a.png', type: 'image/png' }] });
    const transport = vi.fn(async req => req.url.includes('/api/v1/memos?') ? response({ memos: [remote] }) : response({}));
    const first = await new SyncEngine(io, new MemosClient(s, transport), dates, now).run(s, emptyState());
    const body = first.state.blocks[first.state.memos['memos/one'].path];
    expect(body.startsWith('![[')).toBe(true); expect(body.match(/!\[\[/g)).toHaveLength(1);
    expect(body).toContain('正文'); expect(body).not.toContain('创建：'); expect(body).not.toContain('/file/attachments/a');
  });
  it('retains attachments when only content is used and renders custom templates in daily mode', async () => {
    const io = new MemoryVault(), s = settings({ bodyTemplate: '- {{time}}\n  {{content}}' });
    const remote = rawMemo('one', { attachments: [{ name: 'attachments/a', filename: 'a.png', type: 'image/png' }] });
    const transport = vi.fn(async req => req.url.includes('/api/v1/memos?') ? response({ memos: [remote] }) : response({}));
    const result = await new SyncEngine(io, new MemosClient(s, transport), dates, now).run(s, emptyState());
    const body = managedBody(io.files.get('Memos/2026-10-13.md')!, result.state.scope)!;
    expect(body).toContain('- 12:00'); expect(body).toContain('![[');
  });
  it('changing the body template updates the owned block but retains local additions', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(io, new MemosClient(s, transportFor([rawMemo()])), dates, now);
    const first = await engine.run(s, emptyState()), path = first.state.memos['memos/one'].path;
    io.files.set(path, io.files.get(path)! + '\n## 本地补充\n保留');
    const result = await engine.run({ ...s, bodyTemplate: '{{content}}' }, first.state);
    expect(result.report.written).toBe(1); expect(io.files.get(path)).toContain('保留');
    expect(managedBody(io.files.get(path)!, result.state.scope)).toBe('Memo one');
  });
});
