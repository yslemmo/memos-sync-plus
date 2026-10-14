import { describe, expect, it, vi } from 'vitest';
import { matchesAttachmentReference, rewriteAttachmentReferences } from '../src/attachments';
import { MemosClient } from '../src/client';
import { SyncEngine } from '../src/sync';
import { managedBody, replaceManaged } from '../src/render';
import { emptyState } from '../src/types';
import type { Attachment } from '../src/types';
import { dates, MemoryVault, now, rawMemo, response, settings } from './helpers';

const base = 'https://memos.example.com';
const attachment: Attachment = { id: 'attachments/image-id', filename: 'photo.jpeg', mime: 'image/jpeg', size: 123, url: `${base}/file/attachments/image-id/photo.jpeg` };
const local = '![[Memos/attachments/local-photo.jpeg]]';

describe('attachment URL matching', () => {
  it.each([
    '/file/attachments/image-id',
    '/file/attachments/image-id/photo.jpeg',
    '/file/attachments/image-id?thumbnail=true',
    'https://memos.example.com/file/attachments/image-id',
    'https://memos.example.com/file/attachments/image-id/photo.jpeg',
    '<https://memos.example.com/file/attachments/image-id>'
  ])('matches known attachment reference %s', reference => {
    expect(matchesAttachmentReference(reference, attachment, base)).toBe(true);
  });
  it.each([
    '/file/attachments/image-id-other',
    '/file/attachments/other-image-id',
    '/file/resources/image-id',
    'https://other.example.com/file/attachments/image-id',
    'javascript:alert(1)',
    '/file/attachments/%invalid'
  ])('preserves unrelated reference %s', reference => {
    expect(matchesAttachmentReference(reference, attachment, base)).toBe(false);
  });
  it('supports reverse-proxy subpaths, legacy resources and external canonical URLs', () => {
    const subpath = { ...attachment, url: `${base}/notes/file/attachments/image-id/photo.jpeg` };
    expect(matchesAttachmentReference('/notes/file/attachments/image-id', subpath, `${base}/notes`)).toBe(true);
    expect(matchesAttachmentReference('/file/attachments/image-id', subpath, `${base}/notes`)).toBe(true);
    expect(matchesAttachmentReference('/file/resources/legacy-id', { ...attachment, id: 'resources/legacy-id' }, base)).toBe(true);
    expect(matchesAttachmentReference('/o/r/legacy-id', { ...attachment, id: 'legacy-id', url: `${base}/o/r/legacy-id` }, base)).toBe(true);
    const external = { ...attachment, url: 'https://cdn.example.com/photo.jpeg?token=example' };
    expect(matchesAttachmentReference(external.url, external, base)).toBe(true);
    expect(matchesAttachmentReference('https://cdn.example.com/photo.jpeg?token=other', external, base)).toBe(false);
  });
});

describe('attachment reference rewriting', () => {
  it('replaces the filename-less Markdown reference reported in the screenshot', () => {
    const text = '正文\n![IMG](/file/attachments/image-id)';
    expect(rewriteAttachmentReferences(text, attachment, local, base)).toEqual({ content: `正文\n${local}`, referenced: true });
  });
  it('rewrites full URLs, optional titles and wiki-style server references', () => {
    for (const reference of [
      '![photo](/file/attachments/image-id "caption")',
      '![photo](https://memos.example.com/file/attachments/image-id)',
      '![[/file/attachments/image-id]]',
      '![[/file/attachments/image-id|300]]'
    ]) expect(rewriteAttachmentReferences(reference, attachment, local, base).content).toBe(local);
  });
  it('leaves code samples and unknown references unchanged', () => {
    const snippet = '![photo](/file/attachments/image-id)';
    for (const code of [`\`${snippet}\``, `\`\`\`md\n${snippet}\n\`\`\``, `~~~md\n${snippet}\n~~~`, `\`\`\`md\n${snippet}`]) {
      expect(rewriteAttachmentReferences(code, attachment, local, base)).toEqual({ content: code, referenced: false });
    }
    const other = '![other](/file/attachments/other)';
    expect(rewriteAttachmentReferences(other, attachment, local, base).content).toBe(other);
  });
});

describe('sync repair for stale server-relative images', () => {
  const raw = () => rawMemo('reported-memo', { content: '正文 #运动\n![IMG](/file/attachments/image-id)', attachments: [{ name: attachment.id, filename: attachment.filename, type: attachment.mime }] });
  it('writes exactly one local image, and repeated sync does not duplicate it', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const transport = vi.fn(async request => request.url.includes('/api/v1/memos?') ? response({ memos: [raw()] }) : response({}));
    const engine = new SyncEngine(io, new MemosClient(s, transport), dates, now);
    const first = await engine.run(s, emptyState());
    const path = first.state.memos['memos/reported-memo'].path;
    const note = io.files.get(path)!;
    expect(note).not.toContain('](/file/attachments/');
    expect(note.match(/!\[\[/g)).toHaveLength(1);
    expect(first.report.downloaded).toBe(1);
    expect((await engine.run(s, first.state)).report.unchanged).toBe(1);
  });
  it('repairs a note and cache containing the old broken reference plus downloaded image', async () => {
    const io = new MemoryVault(), s = settings({ mode: 'individual' });
    const transport = vi.fn(async request => request.url.includes('/api/v1/memos?') ? response({ memos: [raw()] }) : response({}));
    const engine = new SyncEngine(io, new MemosClient(s, transport), dates, now);
    const first = await engine.run(s, emptyState());
    const id = 'memos/reported-memo', path = first.state.memos[id].path, correctBody = first.state.blocks[path];
    const image = /!\[\[[^\]]+\]\]/.exec(correctBody)![0];
    const buggyBody = correctBody.replace(image, `![IMG](/file/attachments/image-id)\n\n${image}`);
    io.files.set(path, replaceManaged(io.files.get(path)!, first.state.scope, buggyBody, 'Memos') + '\n## 本地补充\n保留我');
    const previous = { ...first.state, blocks: { [path]: buggyBody }, memos: { [id]: { ...first.state.memos[id], body: buggyBody } } };
    const repaired = await engine.run(s, previous);
    expect(repaired.report.conflicts).toEqual([]); expect(repaired.report.written).toBe(1); expect(repaired.report.downloaded).toBe(0);
    expect(managedBody(io.files.get(path)!, repaired.state.scope)).toBe(correctBody);
    expect(io.files.get(path)).toContain('保留我');
  });
  it('replaces short paths with absolute remote URLs when downloading is disabled or fails', async () => {
    for (const download of [false, true]) {
      const io = new MemoryVault(), s = settings({ mode: 'individual', downloadAttachments: download });
      const transport = vi.fn(async request => request.url.includes('/api/v1/memos?') ? response({ memos: [raw()] }) : response({}, 500));
      const result = await new SyncEngine(io, new MemosClient(s, transport), dates, now).run(s, emptyState());
      const body = result.state.blocks[result.state.memos['memos/reported-memo'].path];
      expect(body).not.toContain('](/file/attachments/');
      expect(body).toContain(`](${attachment.url})`); expect(body.match(/!\[/g)).toHaveLength(1);
      expect(result.report.warnings).toHaveLength(download ? 1 : 0);
    }
  });
});
