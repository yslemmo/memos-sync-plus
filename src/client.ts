import type { Attachment, Memo, Settings, Transport, TransportResponse } from './types';
import { httpUrl, serverBase } from './utils';

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => x && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {};
const str = (x: unknown): string => typeof x === 'string' || typeof x === 'number' ? String(x) : '';
const userName = (x: unknown): string => {
  const value = str(x);
  return value.startsWith('users/') ? value : value ? `users/${value}` : '';
};
function timestamp(x: unknown): string {
  const value = typeof x === 'number' ? new Date(x * 1000) : new Date(str(x));
  if (!Number.isFinite(value.getTime())) throw new Error('Memos 返回了无效时间，已停止同步。');
  return value.toISOString();
}
export class HttpError extends Error {
  constructor(public status: number) {
    super(status === 401 || status === 403 ? `HTTP ${status}：令牌无效、已过期或没有访问权限。` : `Memos 请求失败：HTTP ${status}。`);
  }
}
export function normalizeMemo(raw: unknown, base: string): Memo {
  const data = obj(raw);
  const identity = str(data.name || data.uid || data.id);
  if (!identity || typeof data.content !== 'string') throw new Error('Memos 返回了缺少 ID 或正文的记录，已停止同步。');
  const id = identity.startsWith('memos/') ? identity : `memos/${identity}`;
  const created = timestamp(data.createTime || data.create_time || data.createdTs || data.createdAt);
  const updated = timestamp(data.updateTime || data.update_time || data.updatedTs || data.updatedAt || created);
  const resources = data.attachments ?? data.resources ?? data.resourceList ?? [];
  if (!Array.isArray(resources)) throw new Error('Memos 附件列表格式无效。');
  const attachments: Attachment[] = resources.map(item => {
    const r = obj(item);
    const name = str(r.name || r.uid || r.id);
    const filename = str(r.filename) || 'attachment';
    let url = str(r.externalLink || r.external_link);
    if (!url && name) {
      const resourcePath = name.startsWith('attachments/') || name.startsWith('resources/')
        ? name.split('/').map(encodeURIComponent).join('/') : '';
      url = resourcePath ? `${base}/file/${resourcePath}/${encodeURIComponent(filename)}` : `${base}/o/r/${encodeURIComponent(name)}`;
    }
    if (!url) throw new Error('Memos 返回了缺少地址的附件。');
    return { id: name || url, filename, mime: str(r.type || r.mimeType), size: Number(r.size) || 0, url: httpUrl(url, base) };
  });
  return {
    id, linkId: str(data.uid) || id.replace(/^memos\//, ''),
    title: str(obj(data.property).title || data.title), created, updated, content: data.content,
    tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    creator: userName(data.creator || data.creatorId || data.creator_id), attachments,
    archived: data.state === 'ARCHIVED' || data.rowStatus === 'ARCHIVED',
    deleted: Boolean(data.deleteTime || data.delete_time) || data.state === 'DELETED',
    comment: Boolean(data.parent) || (Array.isArray(data.relations) && data.relations.some(r => {
      const rel = obj(r);
      return rel.type === 'COMMENT' && (str(obj(rel.memo).name) === id || str(rel.memo) === id);
    }))
  };
}

export class MemosClient {
  readonly base: string;
  constructor(private settings: Settings, private transport: Transport) { this.base = serverBase(settings.serverUrl); }
  private async request(path: string, method = 'GET'): Promise<TransportResponse> {
    if (!this.settings.token.trim()) throw new Error('请先填写 Memos API 令牌。');
    let response: TransportResponse;
    try {
      response = await this.transport({ url: `${this.base}${path}`, method,
        headers: { Authorization: `Bearer ${this.settings.token.trim()}`, Accept: 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {})
      });
    } catch { throw new Error('无法连接 Memos，请检查服务器地址、网络和证书。'); }
    if (response.status < 200 || response.status >= 300) throw new HttpError(response.status);
    return response;
  }
  async resolveCreator(): Promise<string> {
    if (this.settings.creator.trim()) return userName(this.settings.creator.trim());
    const endpoints = this.settings.apiMode === 'legacy'
      ? [['/api/v1/user/me', 'GET']] : [['/api/v1/auth/me', 'GET'], ['/api/v1/auth/status', 'POST']];
    for (const [path, method] of endpoints) {
      try {
        const data = obj((await this.request(path, method)).json);
        const user = obj(data.user ?? data.data ?? data);
        const creator = userName(user.name || user.id);
        if (creator) return creator;
        throw new Error('身份接口没有返回用户 ID，请在设置中填写 users/用户名或 users/数字ID。');
      } catch (error) {
        if (error instanceof HttpError && [404, 405, 501].includes(error.status)) continue;
        throw error;
      }
    }
    throw new Error('无法自动识别用户，请在设置中填写用户资源名，例如 users/lemmo。');
  }
  async listAll(creator: string): Promise<Memo[]> {
    const result = new Map<string, Memo>();
    let pageToken = '', offset = 0;
    const seenTokens = new Set<string>();
    for (let page = 0; page < 10000; page++) {
      const params = new URLSearchParams();
      const legacy = this.settings.apiMode === 'legacy';
      let path: string;
      if (legacy) {
        params.set('limit', '200'); params.set('offset', String(offset)); params.set('rowStatus', 'NORMAL');
        params.set('creatorId', creator.replace(/^users\//, ''));
        path = '/api/v1/memo';
      } else {
        params.set('pageSize', '200'); params.set('filter', `creator == ${JSON.stringify(creator)}`);
        if (pageToken) params.set('pageToken', pageToken);
        path = '/api/v1/memos';
      }
      const data = (await this.request(`${path}?${params}`)).json;
      const record = obj(data);
      const raw = legacy ? (Array.isArray(data) ? data : record.data) : record.memos;
      // Proto JSON may omit an empty repeated field. Only accept the exact empty response.
      const empty = !legacy && data !== null && typeof data === 'object' && !Array.isArray(data) && raw === undefined && Object.keys(record).every(k => ['nextPageToken', 'next_page_token'].includes(k));
      if (!Array.isArray(raw) && !empty) throw new Error('Memos 返回了非预期数据，未修改任何笔记。请检查 API 类型。');
      const list = empty ? [] : raw as unknown[];
      let added = 0;
      for (const item of list) {
        const memo = normalizeMemo(item, this.base);
        if (!memo.creator) throw new Error('记录缺少创建者，无法确认同步范围，已停止同步。');
        if (memo.creator !== creator || memo.comment || memo.archived || memo.deleted) continue;
        if (!result.has(memo.id)) added++;
        result.set(memo.id, memo);
      }
      if (legacy) {
        if (list.length < 200) return [...result.values()];
        if (!added) throw new Error('旧版接口忽略分页，已停止同步，避免不完整结果。');
        offset += list.length;
      } else {
        const next = str(record.nextPageToken || record.next_page_token);
        if (!next) return [...result.values()];
        if (seenTokens.has(next)) throw new Error('Memos 返回重复分页标记，已停止同步。');
        seenTokens.add(next); pageToken = next;
      }
    }
    throw new Error('Memos 分页超过安全上限，已停止同步。');
  }
  async download(url: string, maxBytes: number): Promise<ArrayBuffer> {
    const resolved = httpUrl(url, this.base);
    const sameOrigin = new URL(resolved).origin === new URL(this.base).origin;
    let response: TransportResponse;
    try { response = await this.transport({ url: resolved, method: 'GET', headers: sameOrigin ? { Authorization: `Bearer ${this.settings.token.trim()}` } : {} }); }
    catch { throw new Error('附件下载连接失败'); }
    if (response.status < 200 || response.status >= 300) throw new HttpError(response.status);
    if (response.arrayBuffer.byteLength > maxBytes) throw new Error('附件超过下载大小限制');
    return response.arrayBuffer;
  }
}
