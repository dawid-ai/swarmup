import { describe, expect, it } from 'vitest';
import { escapeHtml, markdownToHtml, previewPage } from '../src/index.js';

// W8 phase 3: the preview renderer, Markdown to HTML with no dependency and nothing executable.

describe('markdownToHtml', () => {
  it('renders the blocks and inline marks a post uses', () => {
    const md = [
      '---',
      'channel: x',
      '---',
      '# Launch *day*',
      '',
      'We ship **today**, see [the repo](https://github.com/you/repo) and `swarmup next`.',
      '',
      '- one',
      '- two with ~~old~~ _new_',
      '',
      '1. first',
      '2. second',
      '',
      '> quoted',
      '',
      '```sh',
      'echo <b>',
      '```',
      '',
      '---',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n');
    expect(markdownToHtml(md)).toBe(
      [
        '<pre class="front-matter">channel: x</pre>',
        '<h1>Launch <em>day</em></h1>',
        '<p>We ship <strong>today</strong>, see <a href="https://github.com/you/repo">the repo</a> and <code>swarmup next</code>.</p>',
        '<ul><li>one</li><li>two with <del>old</del> <em>new</em></li></ul>',
        '<ol><li>first</li><li>second</li></ol>',
        '<blockquote><p>quoted</p></blockquote>',
        '<pre><code>echo &lt;b&gt;</code></pre>',
        '<hr>',
        '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
      ].join('\n'),
    );
  });

  it('never writes raw HTML, a script, or a link or image with another scheme', () => {
    const html = markdownToHtml(
      [
        '<script>alert(1)</script>',
        '<img src=x onerror="alert(1)">',
        '[click](javascript:alert(1)) [data](data:text/html,x) [rel](../other.md)',
        '![pic](javascript:alert(1)) ![ok](assets/card.png)',
        '0',
      ].join('\n\n'),
    );
    expect(html).not.toMatch(/<script|<img src=x|onerror="|href="javascript|href="data/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<a href="../other.md">rel</a>');
    expect(html).toContain('<span class="image-missing">[image: pic]</span>');
    expect(html).toContain('<img src="assets/card.png" alt="ok">');
    expect(html).not.toContain('');
  });

  it('takes image sources from the hook, and shows alt text for what it refuses', () => {
    const html = markdownToHtml('![a](one.png) ![b](two.png)', {
      image: (src) => (src === 'one.png' ? 'data:image/png;base64,AAAA' : null),
    });
    expect(html).toBe(
      '<p><img src="data:image/png;base64,AAAA" alt="a"> <span class="image-missing">[image: b]</span></p>',
    );
  });
});

describe('previewPage', () => {
  it('is one page with a policy that runs no script', () => {
    const page = previewPage('Preview of <T-1>', 'note', [{ path: 'a.md', html: '<p>x</p>' }]);
    expect(page).toContain(
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`,
    );
    expect(page).toContain('<title>Preview of &lt;T-1&gt;</title>');
    expect(page).toContain('<h2 class="path">a.md</h2>\n<p>x</p>');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });
});
