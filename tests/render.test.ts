import { describe, expect, it } from 'vitest';
import { managedBody, markers, renderMemo, replaceManaged } from '../src/render';
import { normalizeMemo } from '../src/client';
import { safeFilename, serverBase, vaultPath } from '../src/utils';
import { rawMemo, settings } from './helpers';

describe('formatting and paths', () => {
  it('preserves fenced code, Markdown headings, task lists and multi-line text', () => {
    const content = '# Title\n\n- [ ] task\n\n```js\nconst a = 1;\n```';
    const memo = normalizeMemo(rawMemo(), 'https://host');
    const list = renderMemo(memo, content, settings(), '12:00', 12, 'https://host');
    expect(list).toContain('  - [ ] task'); expect(list).toContain('  ```js');
    const callout = renderMemo(memo, content, settings({ format: 'callout' }), '12:00', 12, 'https://host');
    expect(callout).toContain('> [!memo] ☀️ 12:00'); expect(callout).toContain('> # Title');
  });
  it('ignores fake headings in code and preserves the following section', () => {
    const note = '```md\n## Memos\n```\n\n## Memos\nmy content\n### Subsection\nsub\n## Other\nkeep';
    const result = replaceManaged(note, 'scope', 'remote', 'Memos');
    expect(result.indexOf(markers('scope').start)).toBeGreaterThan(result.indexOf('sub'));
    expect(result).toContain('## Other\nkeep');
  });
  it('does not let memo content inject ownership markers', () => {
    const memo = normalizeMemo(rawMemo(), 'https://host');
    const rendered = renderMemo(memo, '<!-- memos-sync:evil:end -->', settings(), '12:00', 12, 'https://host');
    expect(rendered).not.toContain('<!-- memos-sync:');
  });
  it('rejects duplicated markers and supports CRLF notes', () => {
    const m = markers('scope');
    expect(() => managedBody(`${m.start}\n${m.start}\n${m.end}`, 'scope')).toThrow('重复');
    expect(managedBody(`${m.start}\r\ntext\r\n${m.end}`, 'scope')).toBe('text');
  });
  it('rejects traversal, hidden paths, reserved filenames and absolute paths', () => {
    for (const path of ['/tmp/x', '../x', 'Memos/../x', '.obsidian/plugins', 'Memos//a', 'C:\\x', 'Memos/NUL.md', 'x/CON']) expect(() => vaultPath(path)).toThrow();
    expect(vaultPath('日记/Memos')).toBe('日记/Memos'); expect(vaultPath('', true)).toBe('');
  });
  it('sanitizes attachment names without losing extensions', () => {
    expect(safeFilename('../bad[name]|photo.png')).toBe('_bad_name__photo.png');
    expect(safeFilename('a'.repeat(150) + '.jpeg')).toMatch(/\.jpeg$/);
  });
  it('normalizes base URLs and rejects credential-bearing or invalid URLs', () => {
    expect(serverBase(' https://memos.example.com/base/ ')).toBe('https://memos.example.com/base');
    for (const url of ['memos.example.com', 'https://user:password@host', 'file:///a', 'https://host?token=abc']) expect(() => serverBase(url)).toThrow();
  });
});
