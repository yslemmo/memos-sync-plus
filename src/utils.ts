export function vaultPath(value: string, allowEmpty = false): string {
  const path = value.trim().replace(/\/+$/, '');
  if (!path && allowEmpty) return '';
  if (!path || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f:*?"<>|]/.test(path)) {
    throw new Error('请输入库内相对路径，例如 Memos 或 日记/Memos。');
  }
  const parts = path.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) {
    throw new Error('路径不能包含隐藏目录、空目录、.. 或系统保留名称。');
  }
  return path;
}
export const joinPath = (...parts: string[]): string => vaultPath(parts.filter(Boolean).join('/'));
export function serverBase(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请填写完整的 Memos 地址，包含 https:// 或 http://。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务器地址只支持 HTTP(S)，不能包含用户名、密码、查询参数或片段。');
  }
  return url.toString().replace(/\/+$/, '');
}
// Two independent 32-bit hashes: stable names and scope identifiers, not cryptographic security.
export function stableHash(value: string): string {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export function safeFilename(name: string): string {
  let result = name.normalize('NFC').replace(/[\x00-\x1f/\\:*?"<>|#\[\]^]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  if (!result || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(result)) result = `file_${result}`;
  const dot = result.lastIndexOf('.');
  if (result.length > 120) result = result.slice(0, 95) + (dot > 0 ? result.slice(dot, dot + 20) : '');
  return result;
}
export function httpUrl(value: string, base: string): string {
  const url = new URL(value, `${base}/`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('附件地址必须使用 HTTP(S)。');
  return url.toString();
}
export const linkTarget = (value: string): string => value.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
export const linkLabel = (value: string): string => value.replace(/[\[\]\\\r\n]/g, '_');
export async function ensureFolder(io: { exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void> }, folder: string): Promise<void> {
  if (!folder) return;
  let path = '';
  for (const part of vaultPath(folder).split('/')) {
    path = path ? `${path}/${part}` : part;
    if (!await io.exists(path)) {
      try { await io.mkdir(path); } catch (error) { if (!await io.exists(path)) throw error; }
    }
  }
}
export const parentFolder = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
