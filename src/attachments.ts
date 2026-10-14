import type { Attachment } from './types';

/** Rewrite only explicit local wiki targets; aliases and display sizes remain intact. */
export function rewriteLocalAttachmentPath(content: string, from: string, to: string): string {
  return content.replace(/(!?\[\[)([^\]\n]+)(\]\])/g, (match, start: string, target: string, end: string) => {
    const split = target.indexOf('|'), path = split < 0 ? target : target.slice(0, split);
    if (path !== from) return match;
    return `${start}${to}${split < 0 ? '' : target.slice(split)}${end}`;
  });
}

/** Match the canonical URL or a server-local attachment route by resource ID. */
export function matchesAttachmentReference(reference: string, attachment: Attachment, base: string): boolean {
  try {
    const raw = reference.replace(/^<|>$/g, '');
    const resolved = new URL(raw, `${base}/`), canonical = new URL(attachment.url);
    const decode = (value: string) => decodeURIComponent(value);
    if (resolved.origin === canonical.origin && decode(resolved.pathname) === decode(canonical.pathname) && resolved.search === canonical.search) return true;
    // An external website with a coincidentally identical ID must never be rewritten.
    const server = new URL(base);
    if (resolved.origin !== server.origin) return false;
    const prefix = server.pathname.replace(/\/+$/, '');
    const paths = [resolved.pathname];
    if (prefix && resolved.pathname.startsWith(`${prefix}/`)) paths.push(resolved.pathname.slice(prefix.length));
    const resource = /^(attachments|resources)\/([^/]+)$/.exec(attachment.id);
    for (const path of paths) {
      const modern = /^\/file\/(attachments|resources)\/([^/]+)(?:\/.*)?$/.exec(path);
      if (resource && modern && modern[1] === resource[1] && decode(modern[2]) === resource[2]) return true;
      const legacy = /^\/o\/r\/([^/]+)(?:\/.*)?$/.exec(path);
      if (!resource && legacy && decode(legacy[1]) === attachment.id) return true;
    }
  } catch { /* Invalid or unrelated references remain unchanged. */ }
  return false;
}

/** Rewrite known attachments in prose, preserving unrelated links and code samples. */
export function rewriteAttachmentReferences(content: string, attachment: Attachment, replacement: string, base: string): { content: string; referenced: boolean } {
  let referenced = false;
  const rewrite = (prose: string): string => {
    // Memos Markdown images may use /file/attachments/ID without a filename.
    let result = prose.replace(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g, (match, target: string) => {
      if (!matchesAttachmentReference(target, attachment, base)) return match;
      referenced = true; return replacement;
    });
    // Support imported Obsidian-style references to the same server path as well.
    result = result.replace(/!?\[\[([^\]\n]+)\]\]/g, (match, target: string) => {
      if (!matchesAttachmentReference(target.split('|')[0], attachment, base)) return match;
      referenced = true; return replacement;
    });
    return result;
  };
  let fence: { char: string; length: number } | undefined;
  const output = content.split('\n').map(line => {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return line;
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; return line; }
    // Inline code is literal text, even if it contains an attachment URL.
    const inline = /(`+).*?\1/g;
    let end = 0, output = '', match: RegExpExecArray | null;
    while ((match = inline.exec(line))) { output += rewrite(line.slice(end, match.index)) + match[0]; end = match.index + match[0].length; }
    return output + rewrite(line.slice(end));
  }).join('\n');
  return { content: output, referenced };
}
