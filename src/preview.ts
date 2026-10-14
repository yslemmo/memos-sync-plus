import type { PreviewChange, VaultIO } from './types';

/** An overlay that delegates only reads to the real vault. All mutations stay in memory. */
export class PreviewVault implements VaultIO {
  changes: PreviewChange[] = [];
  private files = new Map<string, string>();
  private created = new Set<string>();
  private deleted = new Set<string>();
  constructor(private source: VaultIO) {}
  async exists(path: string): Promise<boolean> { return !this.deleted.has(path) && (this.created.has(path) || await this.source.exists(path)); }
  async read(path: string): Promise<string> { if (this.deleted.has(path)) throw new Error('找不到文件'); return this.files.get(path) ?? await this.source.read(path); }
  async mkdir(path: string): Promise<void> { this.created.add(path); }
  async create(path: string, text: string): Promise<void> {
    if (await this.exists(path)) throw new Error('目标文件已存在');
    this.created.add(path); this.files.set(path, text);
    this.changes.push({ action: path.includes('/Memos Sync Backups/') || path.startsWith('Memos Sync Backups/') ? 'backup' : 'create', path });
  }
  async process(path: string, fn: (current: string) => string): Promise<void> {
    const current = await this.read(path), next = fn(current);
    this.files.set(path, next);
    if (next !== current) this.changes.push({ action: 'update', path });
  }
  async createBinary(path: string, _data: ArrayBuffer): Promise<void> {
    if (await this.exists(path)) throw new Error('目标附件已存在');
    this.created.add(path); this.changes.push({ action: 'attachment', path });
  }
  async rename(source: string, destination: string): Promise<void> {
    if (await this.exists(destination)) throw new Error('目标文件已存在');
    const text = await this.read(source);
    this.deleted.add(source); this.created.add(destination); this.files.set(destination, text);
    this.changes.push({ action: 'rename', from: source, path: destination });
  }
  async resolveBinary(path: string): Promise<string | undefined> {
    if (this.created.has(path) && !this.deleted.has(path)) return path;
    return this.source.resolveBinary ? this.source.resolveBinary(path) : await this.exists(path) ? path : undefined;
  }
}
