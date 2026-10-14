import { describe, expect, it, vi } from 'vitest';
import { MemosClient } from '../src/client';
import { SyncEngine } from '../src/sync';
import { emptyState } from '../src/types';
import { managedBody, replaceManaged } from '../src/render';
import { rewriteLocalAttachmentPath } from '../src/attachments';
import { MemoryVault, settings, dates, now, rawMemo, response } from './helpers';

const remote = () => rawMemo('photo', { content: '正文\n![photo](/file/attachments/a)', attachments: [{ name: 'attachments/a', filename: 'photo.jpeg', type: 'image/jpeg' }] });
const transport = () => vi.fn(async req => req.url.includes('/api/v1/memos?') ? response({ memos: [remote()] }) : response({}, 200, new Uint8Array([1, 2, 3]).buffer));

class RenamingVault extends MemoryVault {
  aliases = new Map<string, string>();
  async createBinary(path: string, data: ArrayBuffer): Promise<string> {
    const actual = 'Memos/attachments/renamed-by-other-plugin.jpeg';
    this.binaries.set(actual, data); this.aliases.set(path, actual); return actual;
  }
  async resolveBinary(path: string): Promise<string | undefined> { const actual = this.aliases.get(path) ?? path; return this.binaries.has(actual) ? actual : undefined; }
  async findBinary(data: ArrayBuffer): Promise<string | undefined> {
    const expected = new Uint8Array(data);
    for (const [path, bytes] of this.binaries) {
      const candidate = new Uint8Array(bytes);
      if (candidate.length === expected.length && candidate.every((v, i) => v === expected[i])) return path;
    }
    return undefined;
  }
}

describe('attachment paths after automatic rename', () => {
  it('uses the actual file name and persists its attachment mapping', async () => {
    const io = new RenamingVault(), s = settings({ mode: 'individual' }), req = transport();
    const engine = new SyncEngine(io, new MemosClient(s, req), dates, now);
    const result = await engine.run(s, emptyState());
    expect(Object.values(result.state.attachments!)).toEqual(['Memos/attachments/renamed-by-other-plugin.jpeg']);
    const path = result.state.memos['memos/photo'].path;
    expect(io.files.get(path)).toContain('![[Memos/attachments/renamed-by-other-plugin.jpeg]]');
    expect(result.report.failures).toEqual([]);
    req.mockClear();
    const second = await engine.run(s, result.state);
    expect(req).toHaveBeenCalledTimes(1); expect(second.report.downloaded).toBe(0); expect(io.binaries.size).toBe(1);
  });
  it('repairs old cached links using byte-identical renamed files instead of duplicating downloads', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const first = await new SyncEngine(io, new MemosClient(s, transport()), dates, now).run(s, emptyState());
    const [original, bytes] = [...io.binaries][0];
    const moved = 'Memos/attachments/UID-1.jpeg'; io.binaries.set(moved, bytes); io.binaries.delete(original);
    const recovered = new RenamingVault(); recovered.files = io.files; recovered.binaries = io.binaries; recovered.folders = io.folders;
    const previous = { ...first.state, attachments: undefined };
    const result = await new SyncEngine(recovered, new MemosClient(s, transport()), dates, now).run(s, previous);
    expect(result.report.conflicts).toEqual([]); expect(result.report.downloaded).toBe(0); expect(recovered.binaries.size).toBe(1);
    expect(recovered.files.get(result.state.memos['memos/photo'].path)).toContain(`![[${moved}]]`);
  });
  it('rechecks delayed rename before committing the note', async () => {
    const io = new RenamingVault(), s = settings({ mode: 'individual' });
    let calls = 0;
    const originalResolve = io.resolveBinary.bind(io);
    io.resolveBinary = async path => {
      calls++;
      if (calls >= 3 && io.binaries.has(path)) {
        const newer = 'Memos/attachments/late-rename.jpeg';
        io.binaries.set(newer, io.binaries.get(path)!); io.binaries.delete(path); io.aliases.set(path, newer);
      }
      return originalResolve(path);
    };
    const result = await new SyncEngine(io, new MemosClient(s, transport()), dates, now).run(s, emptyState());
    const note = io.files.get(result.state.memos['memos/photo'].path)!;
    expect(note).toContain('late-rename.jpeg'); expect(note).not.toContain('renamed-by-other-plugin.jpeg');
    expect(result.state.memos['memos/photo'].body).toContain('late-rename.jpeg');
  });
  it('accepts backlink-only changes made by FileManager after a tracked attachment rename', async () => {
    const io = new RenamingVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(io, new MemosClient(s, transport()), dates, now);
    const first = await engine.run(s, emptyState()), path = first.state.memos['memos/photo'].path;
    const original = Object.values(first.state.attachments!)[0], actual = 'Memos/attachments/renamed-again.jpeg';
    io.binaries.set(actual, io.binaries.get(original)!); io.binaries.delete(original); io.aliases.set(original, actual);
    io.files.set(path, rewriteLocalAttachmentPath(io.files.get(path)!, original, actual));
    const second = await engine.run(s, first.state);
    expect(second.report.conflicts).toEqual([]); expect(Object.values(second.state.attachments!)).toEqual([actual]);
  });
  it('retains protection for genuine edits while repairing missing-image paths', async () => {
    const io = new RenamingVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(io, new MemosClient(s, transport()), dates, now);
    const first = await engine.run(s, emptyState()), path = first.state.memos['memos/photo'].path;
    io.files.set(path, io.files.get(path)!.replace('正文', '本地修改'));
    const second = await engine.run(s, first.state); expect(second.report.conflicts).toEqual([path]);
    expect(io.files.get(path)).toContain('本地修改');
  });
  it('reports a disappeared created file instead of writing a dangling local embed', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    io.createBinary = async () => {};
    const result = await new SyncEngine(io, new MemosClient(s, transport()), dates, now).run(s, emptyState());
    const body = result.state.blocks[result.state.memos['memos/photo'].path];
    expect(result.report.failures[0].kind).toBe('attachment'); expect(body).not.toContain('![[');
    expect(body).toContain('https://memos.example.com/file/attachments/a/photo.jpeg');
  });
  it('keeps preview read-only when actual binary paths are registered', async () => {
    const io = new RenamingVault(), s = settings({ mode: 'individual' });
    const engine = new SyncEngine(io, new MemosClient(s, transport()), dates, now);
    const first = await engine.run(s, emptyState()), before = new Map(io.files);
    const find = vi.spyOn(io, 'findBinary'), create = vi.spyOn(io, 'createBinary');
    await engine.preview(s, first.state);
    expect(find).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(io.files).toEqual(before);
  });
});
