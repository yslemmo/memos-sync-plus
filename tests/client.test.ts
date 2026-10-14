import { describe, expect, it, vi } from 'vitest';
import { HttpError, MemosClient, normalizeMemo } from '../src/client';
import { rawMemo, response, settings } from './helpers';

describe('Memos API', () => {
  it('reads all pages, filters the creator, and excludes comments and archives', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response({ memos: [rawMemo(), rawMemo('other', { creator: 'users/other' })], nextPageToken: 'page+2' }))
      .mockResolvedValueOnce(response({ memos: [rawMemo('two'), rawMemo('comment', { parent: 'memos/one' }), rawMemo('archive', { state: 'ARCHIVED' })] }));
    const client = new MemosClient(settings(), transport);
    expect((await client.listAll('users/lemmo')).map(m => m.id)).toEqual(['memos/one', 'memos/two']);
    const secondUrl = new URL(transport.mock.calls[1][0].url);
    expect(secondUrl.searchParams.get('pageToken')).toBe('page+2');
    expect(secondUrl.searchParams.get('filter')).toBe('creator == "users/lemmo"');
  });
  it('does not accept malformed responses as an empty snapshot', async () => {
    for (const data of [null, [], '<html>login</html>', { message: 'error' }, { memos: null }]) {
      const client = new MemosClient(settings(), async () => response(data));
      await expect(client.listAll('users/lemmo')).rejects.toThrow('非预期');
    }
  });
  it('accepts empty proto JSON without memos', async () => {
    const client = new MemosClient(settings(), async () => response({}));
    expect(await client.listAll('users/lemmo')).toEqual([]);
  });
  it('stops on repeated page tokens', async () => {
    const client = new MemosClient(settings(), async () => response({ memos: [rawMemo()], nextPageToken: 'again' }));
    await expect(client.listAll('users/lemmo')).rejects.toThrow('重复分页');
  });
  it('fails the complete snapshot if a later page fails', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response({ memos: [rawMemo()], nextPageToken: 'next' })).mockResolvedValueOnce(response({}, 500));
    await expect(new MemosClient(settings(), transport).listAll('users/lemmo')).rejects.toThrow('HTTP 500');
  });
  it('validates identity and creation time', () => {
    expect(() => normalizeMemo(rawMemo('one', { creator: '' }), 'https://host').creator).not.toThrow();
    expect(() => normalizeMemo(rawMemo('one', { createTime: 'bad' }), 'https://host')).toThrow('无效时间');
    expect(() => normalizeMemo({ content: 'missing' }, 'https://host')).toThrow('缺少 ID');
  });
  it('refuses records without a creator', async () => {
    const client = new MemosClient(settings(), async () => response({ memos: [rawMemo('one', { creator: '' })] }));
    await expect(client.listAll('users/lemmo')).rejects.toThrow('创建者');
  });
  it('uses current identity API and falls back to the older status endpoint only for unavailable routes', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response({ name: 'users/1' }));
    const client = new MemosClient(settings({ creator: '' }), transport);
    expect(await client.resolveCreator()).toBe('users/1');
    expect(transport.mock.calls[1][0].method).toBe('POST');
    const unauth = vi.fn().mockResolvedValue(response({}, 401));
    await expect(new MemosClient(settings({ creator: '' }), unauth).resolveCreator()).rejects.toBeInstanceOf(HttpError);
    expect(unauth).toHaveBeenCalledTimes(1);
  });
  it('supports legacy records and stable binary URLs', async () => {
    const transport = vi.fn().mockResolvedValue(response([{ id: 7, creatorId: 1, createdTs: 1791864000, updatedTs: 1791864000, content: 'legacy', resourceList: [{ id: 5, uid: 'resource-uid', filename: 'photo.png', type: 'image/png' }] }]));
    const client = new MemosClient(settings({ apiMode: 'legacy', creator: 'users/1' }), transport);
    const [memo] = await client.listAll('users/1');
    expect(memo.id).toBe('memos/7');
    expect(memo.attachments[0].url).toBe('https://memos.example.com/o/r/resource-uid');
    expect(transport.mock.calls[0][0].url).toContain('/api/v1/memo?');
  });
  it('uses v0.30 attachment file route with encoded filename', () => {
    const memo = normalizeMemo(rawMemo('one', { attachments: [{ name: 'attachments/abc', filename: 'photo 你好.png', type: 'image/png', size: '42' }] }), 'https://host/base');
    expect(memo.attachments[0].url).toBe('https://host/base/file/attachments/abc/photo%20%E4%BD%A0%E5%A5%BD.png');
    expect(memo.attachments[0].size).toBe(42);
  });
  it('never sends bearer token to external attachment origins', async () => {
    const transport = vi.fn().mockResolvedValue(response({}));
    const client = new MemosClient(settings(), transport);
    await client.download('https://cdn.example.com/file', 10);
    expect(transport.mock.calls[0][0].headers).toEqual({});
    await client.download('https://memos.example.com/file', 10);
    expect(transport.mock.calls[1][0].headers.Authorization).toBe('Bearer test-token');
    await expect(client.download('javascript:alert(1)', 10)).rejects.toThrow('HTTP');
  });
  it('enforces downloaded attachment size', async () => {
    const client = new MemosClient(settings(), async () => response({}, 200, new ArrayBuffer(50)));
    await expect(client.download('https://memos.example.com/file', 10)).rejects.toThrow('大小限制');
  });
});
