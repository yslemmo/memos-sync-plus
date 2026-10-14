import { parseYaml, stringifyYaml } from 'obsidian';
import type { Memo } from './types';
import { memoLinkId } from './filename';
import { sourceUrl } from './render';

const KEYS = ['memos_id', 'memos_created', 'memos_updated', 'memos_source', 'memos_creator'] as const;
export interface NoteProperties { memos_id: string; memos_created: string; memos_updated: string; memos_source: string; memos_creator: string; tags: string[] }
export function noteProperties(memo: Memo, base: string, legacy: boolean): NoteProperties {
  return { memos_id: memoLinkId(memo), memos_created: memo.created, memos_updated: memo.updated,
    memos_source: sourceUrl(memo, base, legacy), memos_creator: memo.creator, tags: memo.tags ?? [] };
}
function frontmatter(note: string): { data: Record<string, unknown>; rest: string } {
  const opening = /^(?:\uFEFF)?---\r?\n/.exec(note);
  if (!opening) return { data: {}, rest: note };
  const tail = note.slice(opening[0].length), closing = /^---[ \t]*(?:\r?\n|$)/m.exec(tail);
  if (!closing) throw new Error('笔记属性 YAML 缺少结束标记，请修复后同步。');
  let data: unknown;
  try { data = parseYaml(tail.slice(0, closing.index)); } catch { throw new Error('笔记属性 YAML 格式无效，请修复后同步。'); }
  if (data != null && (typeof data !== 'object' || Array.isArray(data))) throw new Error('笔记属性必须是 YAML 对象。');
  return { data: (data ?? {}) as Record<string, unknown>, rest: tail.slice(closing.index + closing[0].length) };
}
export function managedProperties(note: string): string | null {
  const { data } = frontmatter(note);
  if (!KEYS.some(key => key in data)) return null;
  return JSON.stringify(Object.fromEntries(KEYS.filter(key => key in data).map(key => [key, data[key]])));
}
export function propertySignature(properties: NoteProperties): string { return JSON.stringify(Object.fromEntries(KEYS.map(key => [key, properties[key]]))); }
export function mergeProperties(note: string, properties: NoteProperties): string {
  const { data, rest } = frontmatter(note);
  const existingTags = Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' ? data.tags.split(/[,\s]+/) : [];
  const tags = [...new Set([...existingTags, ...properties.tags].filter((tag): tag is string => typeof tag === 'string' && Boolean(tag)).map(tag => tag.replace(/^#/, '')))];
  const merged = { ...data, ...properties, tags };
  return `---\n${stringifyYaml(merged).trimEnd()}\n---\n${rest}`;
}
