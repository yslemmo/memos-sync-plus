import type { VaultIO, Transport, TransportResponse, Settings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';
import type { ClockFormat } from '../src/sync';

export const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, serverUrl: 'https://memos.example.com', token: 'test-token', creator: 'users/lemmo', ...patch });
export const rawMemo = (id = 'one', patch: Record<string, unknown> = {}) => ({
  name: `memos/${id}`, creator: 'users/lemmo', content: `Memo ${id}`,
  createTime: '2026-10-13T04:00:00Z', updateTime: '2026-10-13T04:00:00Z', attachments: [], state: 'NORMAL', ...patch
});
export const response = (json: unknown, status = 200, bytes = new ArrayBuffer(3)): TransportResponse => ({ status, json, text: JSON.stringify(json), arrayBuffer: bytes });
export const transportFor = (memos: unknown[]): Transport => async request => request.url.includes('/api/v1/memos?') ? response({ memos }) : response({}, 404);
export const dates: ClockFormat = {
  date: (iso, format) => {
    const d = new Date(iso);
    const Y = String(d.getFullYear()), M = String(d.getMonth() + 1).padStart(2, '0'), D = String(d.getDate()).padStart(2, '0');
    return format.replace(/YYYY/g, Y).replace(/MM/g, M).replace(/DD/g, D)
      .replace(/HH/g, String(d.getHours()).padStart(2, '0')).replace(/mm/g, String(d.getMinutes()).padStart(2, '0')).replace(/ss/g, String(d.getSeconds()).padStart(2, '0'));
  },
  time: iso => `${String(new Date(iso).getHours()).padStart(2, '0')}:${String(new Date(iso).getMinutes()).padStart(2, '0')}`,
  hour: iso => new Date(iso).getHours()
};
export const now = () => new Date('2026-10-13T08:00:00Z');
export class MemoryVault implements VaultIO {
  files = new Map<string, string>();
  binaries = new Map<string, ArrayBuffer>();
  folders = new Set<string>();
  writes = 0;
  beforeProcess?: (path: string) => void;
  failPath?: string;
  failRename = false;
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.binaries.has(path) || this.folders.has(path); }
  async read(path: string): Promise<string> { if (!this.files.has(path)) throw new Error('missing'); return this.files.get(path)!; }
  async create(path: string, content: string): Promise<void> { if (path === this.failPath) throw new Error('disk full'); if (await this.exists(path)) throw new Error('exists'); this.files.set(path, content); this.writes++; }
  async process(path: string, fn: (current: string) => string): Promise<void> { if (path === this.failPath) throw new Error('disk full'); this.beforeProcess?.(path); const result = fn(await this.read(path)); if (result !== this.files.get(path)) { this.files.set(path, result); this.writes++; } }
  async mkdir(path: string): Promise<void> { this.folders.add(path); }
  async createBinary(path: string, data: ArrayBuffer): Promise<string | void> { if (await this.exists(path)) throw new Error('exists'); this.binaries.set(path, data); }
  async rename(source: string, destination: string): Promise<void> {
    if (this.failRename) throw new Error('rename failed');
    if (await this.exists(destination)) throw new Error('exists');
    const content = await this.read(source); this.files.set(destination, content); this.files.delete(source);
  }
}
