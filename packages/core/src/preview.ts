// Previews of approved work (W8 phase 3): a small Markdown to HTML renderer with no dependency,
// for `swarmup preview` and `GET /api/tasks/:id/preview`. Every character of the input is
// escaped first and only a fixed set of tags is written, so raw HTML in a post shows as text and
// no script, style, event handler or `javascript:` link can reach the output.

/** Escapes text for HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Options of {@link markdownToHtml}. */
export interface PreviewOptions {
  /**
   * The source an image gets, from its source as written (escaped); null shows its alt text
   * instead. Default: http(s) and relative sources as they are.
   */
  image?: (src: string) => string | null;
}

/** A link or image target that may be written: http(s), mailto, or one without a scheme. */
function safeUrl(url: string): boolean {
  const u = url.replace(/&amp;/g, '&').trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//');
}

/** Inline Markdown of one escaped line or paragraph. */
function inline(escaped: string, opts: PreviewOptions): string {
  const codes: string[] = [];
  // A held piece of HTML is a private-use character around its index, which no escaped text holds.
  const hold = (html: string): string => `${codes.push(html) - 1}`;
  let s = escaped.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) =>
    hold(`<code>${code.trim()}</code>`),
  );
  const title = '(?:\\s+&quot;[^]*?&quot;)?';
  s = s.replace(
    new RegExp(`!\\[([^\\]]*)\\]\\(\\s*([^\\s)]+)${title}\\s*\\)`, 'g'),
    (_m, alt: string, src: string) => {
      const to = opts.image ? opts.image(src) : src;
      const ok = to !== null && (safeUrl(to) || to.startsWith('data:image/'));
      return hold(
        ok
          ? `<img src="${to}" alt="${alt}">`
          : `<span class="image-missing">[image: ${alt || src}]</span>`,
      );
    },
  );
  s = s.replace(
    new RegExp(`\\[([^\\]]+)\\]\\(\\s*([^\\s)]+)${title}\\s*\\)`, 'g'),
    (_m, text: string, href: string) =>
      safeUrl(href) ? `${hold(`<a href="${href}">`)}${text}${hold('</a>')}` : text,
  );
  s = s.replace(/&lt;(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)&gt;/gi, (_m, url: string) =>
    hold(`<a href="${url}">${url}</a>`),
  );
  s = s
    .replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(\S(?:[\s\S]*?\S)?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(\S(?:[\s\S]*?\S)?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(\S(?:[\s\S]*?\S)?)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, '<del>$1</del>')
    .replace(/ {2,}\n/g, '<br>\n');
  // Held pieces may hold others (a link around an image), so restore until none is left.
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/(\d+)/g, (_m, i: string) => codes[Number(i)]!);
  }
  return s;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const QUOTE = /^ {0,3}&gt;\s?(.*)$/;

/** Block Markdown of escaped lines. */
function blocks(lines: string[], opts: PreviewOptions): string {
  const out: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) out.push(`<p>${inline(para.join('\n').trim(), opts)}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1]!;
      const code: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = FENCE.exec(lines[i]!);
        if (
          close &&
          close[1]![0] === mark[0] &&
          close[1]!.length >= mark.length &&
          !close[2]!.trim()
        )
          break;
        code.push(lines[i]!);
      }
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const n = h[1]!.length;
      out.push(`<h${n}>${inline(h[2] ?? '', opts)}</h${n}>`);
      continue;
    }
    if (RULE.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(QUOTE.exec(lines[i++]!)![1]!);
      i--;
      out.push(`<blockquote>${blocks(inner, opts)}</blockquote>`);
      continue;
    }
    const item = ITEM.exec(line);
    if (item && (para.length === 0 || /^\s*$/.test(lines[i - 1] ?? ''))) {
      flush();
      const ordered = /\d/.test(item[2]!);
      const items: string[][] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (m && /\d/.test(m[2]!) === ordered && m[1]!.length < 2) {
          items.push([m[4]!]);
          i++;
          continue;
        }
        const cur = lines[i]!;
        // A continuation: indented, or a blank line before more indented text.
        if (/^\s{2,}\S/.test(cur)) {
          items.at(-1)!.push(cur.replace(/^ {2,4}/, ''));
          i++;
          continue;
        }
        if (!cur.trim() && /^\s{2,}\S/.test(lines[i + 1] ?? '')) {
          items.at(-1)!.push('');
          i++;
          continue;
        }
        break;
      }
      i--;
      const tag = ordered ? 'ol' : 'ul';
      const lis = items.map((body) => {
        const html = blocks(body, opts);
        const one = /^<p>([\s\S]*)<\/p>$/.exec(html);
        return `<li>${one && !one[1]!.includes('<p>') ? one[1] : html}</li>`;
      });
      out.push(`<${tag}>${lis.join('')}</${tag}>`);
      continue;
    }
    const sep = lines[i + 1];
    if (
      line.includes('|') &&
      sep !== undefined &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(sep)
    ) {
      flush();
      const cells = (l: string): string[] =>
        l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => inline(c.trim(), opts));
      const head = cells(line)
        .map((c) => `<th>${c}</th>`)
        .join('');
      const rows: string[] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) {
        rows.push(
          `<tr>${cells(lines[i]!)
            .map((c) => `<td>${c}</td>`)
            .join('')}</tr>`,
        );
      }
      i--;
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Markdown to HTML for a preview: headings, paragraphs, lists, block quotes, fenced code, rules,
 * tables, emphasis, code, links and images. YAML front matter shows as a block of its own. Raw
 * HTML shows as text; a link or image with a scheme other than http(s) or mailto is left out.
 */
export function markdownToHtml(markdown: string, opts: PreviewOptions = {}): string {
  // The characters that mark held HTML never come from the input.
  let src = markdown.replace(/\r\n?/g, '\n').replace(/[\uE000\uE001]/g, '');
  let front = '';
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---', 4);
    if (end >= 0) {
      front = `<pre class="front-matter">${escapeHtml(src.slice(4, end))}</pre>\n`;
      src = src.slice(src.indexOf('\n', end + 4) + 1);
    }
  }
  return front + blocks(escapeHtml(src).split('\n'), opts);
}

/** One file of a preview page. */
export interface PreviewSection {
  path: string;
  /** The section's HTML, from {@link markdownToHtml} or as escaped text. */
  html: string;
}

/**
 * A preview as one HTML page: a heading per file, its HTML, and a policy that lets the page run
 * no script and load nothing but inline styles and `data:` images.
 */
export function previewPage(title: string, note: string, sections: PreviewSection[]): string {
  const body = sections
    .map((s) => `<section><h2 class="path">${escapeHtml(s.path)}</h2>\n${s.html}\n</section>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1d1f24; }
.note { color: #666; font-size: 0.85rem; }
h2.path { font: 600 0.8rem ui-monospace, monospace; color: #666; border-top: 1px solid #ddd; padding-top: 1rem; margin-top: 3rem; }
pre { background: #f4f4f6; padding: 0.75rem; overflow-x: auto; }
pre.front-matter { color: #666; font-size: 0.8rem; }
code { font-family: ui-monospace, monospace; font-size: 0.9em; }
img { max-width: 100%; }
blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1rem; color: #444; }
table { border-collapse: collapse; } th, td { border: 1px solid #ddd; padding: 0.25rem 0.5rem; }
.image-missing { color: #a33; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="note">${escapeHtml(note)}</p>
${body}
</body>
</html>
`;
}
