import type { Memo, Settings } from './types';
import { linkTarget } from './utils';
import { memoLinkId, memoTitle } from './filename';
export function timeEmoji(hour: number): string { return hour >= 5 && hour < 12 ? '🌅' : hour < 17 && hour >= 12 ? '☀️' : hour >= 17 && hour < 21 ? '🌆' : '🌙'; }
export function sourceUrl(memo: Memo, base: string, legacy = false): string { return `${base}/${legacy ? 'm' : 'memos'}/${encodeURIComponent(memoLinkId(memo))}`; }
export const TEMPLATE_VARIABLES = ['content', 'attachments', 'id', 'title', 'date', 'time', 'emoji', 'created', 'updated', 'source', 'source_url', 'tags'];
export function validateBodyTemplate(template: string): void {
  if (!template.trim()) return;
  if (!template.includes('{{content}}')) throw new Error('正文模板需要包含 {{content}}，以免遗漏 Memos 正文。');
  for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) if (!TEMPLATE_VARIABLES.includes(match[1])) throw new Error(`不支持模板变量 {{${match[1]}}}。`);
  if (/<!--\s*memos-sync:/.test(template)) throw new Error('正文模板不能包含插件同步标记。');
}
export function renderMemo(memo: Memo, content: string, settings: Settings, time: string, hour: number, base: string, context: { attachments?: string; date?: string } = {}): string {
  const label = `${settings.emoji ? `${timeEmoji(hour)} ` : ''}${time}`;
  const source = settings.includeSourceLink ? ` [来源](${linkTarget(sourceUrl(memo, base, settings.apiMode === 'legacy'))})` : '';
  // Source text cannot impersonate the plugin's ownership markers.
  const body = content.replace(/<!--\s*memos-sync:/g, '&lt;!-- memos-sync:').replace(/\r\n/g, '\n').trim();
  if (settings.bodyTemplate?.trim()) {
    validateBodyTemplate(settings.bodyTemplate);
    const values: Record<string, string> = {
      content: body, attachments: context.attachments ?? '', id: memoLinkId(memo), title: memoTitle(memo),
      date: context.date ?? memo.created.slice(0, 10), time, emoji: settings.emoji ? timeEmoji(hour) : '',
      created: memo.created, updated: memo.updated, source: settings.includeSourceLink ? `[来源](${linkTarget(sourceUrl(memo, base, settings.apiMode === 'legacy'))})` : '',
      source_url: sourceUrl(memo, base, settings.apiMode === 'legacy'), tags: (memo.tags ?? []).map(tag => `#${tag}`).join(' ')
    };
    return settings.bodyTemplate.replace(/\{\{([^{}]+)\}\}/g, (_, key: string, offset: number) => {
      const prefix = settings.bodyTemplate.slice(settings.bodyTemplate.lastIndexOf('\n', offset - 1) + 1, offset);
      const list = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)/.exec(prefix);
      const indentation = /^[ \t>]*$/.test(prefix) ? prefix : list ? ' '.repeat(list[0].length) : '';
      return values[key].replace(/\n/g, `\n${indentation}`);
    }).replace(/<!--\s*memos-sync:/g, '&lt;!-- memos-sync:').trim();
  }
  if (settings.mode === 'individual') return `# ${label}${source}\n\n${body}\n\n---\n创建：${memo.created}\n更新：${memo.updated}`;
  if (settings.format === 'callout') return `> [!memo] ${label}${source}\n${body.split('\n').map(line => `> ${line}`).join('\n')}`;
  // A time-only first line lets headings, task lists and code blocks retain their structure.
  return `- **${label}**${source}\n${body.split('\n').map(line => `  ${line}`).join('\n')}`;
}
export function markers(scope: string): { start: string; end: string } {
  return { start: `<!-- memos-sync:${scope}:start -->`, end: `<!-- memos-sync:${scope}:end -->` };
}
export function managedBody(note: string, scope: string): string | null {
  const { start, end } = markers(scope);
  const a = note.indexOf(start), b = note.indexOf(end);
  if (a < 0 && b < 0) return null;
  if (a < 0 || b < a || note.indexOf(start, a + start.length) >= 0 || note.indexOf(end, b + end.length) >= 0) {
    throw new Error('同步标记损坏或重复，请修复标记后再同步。');
  }
  return note.slice(a + start.length, b).replace(/^\r?\n|\r?\n$/g, '');
}
function insertionPoint(note: string, heading: string): number {
  const lines = note.split(/\n/);
  let offset = 0, fence = '', level = 0;
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = ''; }
    if (!fence) {
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*\r?$/.exec(line);
      if (h && level && h[1].length <= level) return offset;
      if (h && !level && h[2] === heading) level = h[1].length;
    }
    offset += line.length + 1;
  }
  return level ? note.length : -1;
}
export function replaceManaged(note: string, scope: string, body: string, heading: string): string {
  const { start, end } = markers(scope);
  const existing = managedBody(note, scope);
  const block = `${start}\n${body}\n${end}`;
  if (existing !== null) {
    const a = note.indexOf(start), b = note.indexOf(end) + end.length;
    return note.slice(0, a) + block + note.slice(b);
  }
  const point = insertionPoint(note, heading);
  if (point >= 0) return note.slice(0, point).trimEnd() + `\n\n${block}\n\n` + note.slice(point);
  return note.trimEnd() + `${note.trim() ? '\n\n' : ''}## ${heading}\n\n${block}\n`;
}
