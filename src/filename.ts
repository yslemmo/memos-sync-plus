import type { Memo, Settings } from './types';
import type { ClockFormat } from './sync';
import { safeFilename, stableHash } from './utils';

function truncateBytes(value: string, limit: number): string {
  let result = '', size = 0;
  for (const character of value) {
    const bytes = new TextEncoder().encode(character).length;
    if (size + bytes > limit) break;
    result += character; size += bytes;
  }
  return result;
}
export function memoLinkId(memo: Memo): string { return memo.linkId || memo.id.replace(/^memos\//, ''); }
function filenameId(memo: Memo): string {
  const id = memoLinkId(memo), sanitized = safeFilename(id);
  // Valid Memos UIDs remain byte-for-byte unchanged. Nonstandard IDs cannot collide after sanitization.
  return sanitized === id && new TextEncoder().encode(id).length <= 80 ? id : `${truncateBytes(sanitized, 60)}-${stableHash(id)}`;
}
export function memoTitle(memo: Memo): string {
  const source = memo.title?.trim() || memo.content.split(/\r?\n/).find(line => line.trim())?.trim() || '';
  return source.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s*)?)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '').replace(/<[^>]*>/g, '').trim();
}
export function individualFilename(memo: Memo, settings: Settings, dates: ClockFormat): string {
  const id = filenameId(memo);
  const createdDate = dates.date(memo.created, 'YYYY-MM-DD');
  switch (settings.fileNameFormat ?? 'id') {
    case 'created': return `${dates.date(memo.created, 'YYYY-MM-DD HH-mm-ss')} ${id}.md`;
    case 'updated': return `${dates.date(memo.updated, 'YYYY-MM-DD HH-mm-ss')} ${id}.md`;
    case 'title': {
      const title = memoTitle(memo);
      return `${createdDate}${title ? ` ${truncateBytes(safeFilename(title), 100)}` : ''} ${id}.md`;
    }
    case 'id': return `${createdDate} ${id}.md`;
    default: throw new Error('文件名格式无效，请在设置中重新选择。');
  }
}
