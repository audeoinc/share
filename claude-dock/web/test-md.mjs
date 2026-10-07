// md.js の単体テスト: node test-md.mjs
import { renderMarkdown as md } from './public/md.js';
let fail = 0;
const t = (name, src, opts, ...needles) => {
  const html = md(src, opts);
  for (const n of needles) {
    const ok = n instanceof RegExp ? n.test(html) : html.includes(n);
    if (!ok) { fail++; console.log(`NG  ${name}: ${n}\n    -> ${html.slice(0, 300).replace(/\n/g, '⏎')}`); }
  }
  console.log(`ok  ${name}`);
};
const nt = (name, src, opts, ...needles) => {
  const html = md(src, opts);
  for (const n of needles) if (html.includes(n)) { fail++; console.log(`NG  ${name}: should not contain ${n}\n    -> ${html.slice(0, 300)}`); }
  console.log(`ok  ${name}`);
};

// スクリーンショットで崩れていたケース: 太字が行をまたぐ
t('bold across lines', '**別セッションに\n引き継ぐときの唯一の共有メモ**なので、必要な文脈', { soft: true }, /<strong>別セッションに 引き継ぐ/);
t('soft join', 'a\nb\nc', { soft: true }, '<p>a b c</p>');
t('br join (chat)', 'a\nb', {}, '<p>a<br>b</p>');
t('hard break', 'a  \nb', { soft: true }, '<p>a<br>b</p>');
t('headings 1-6', '# a\n###### f', {}, '<h1>a</h1>', '<h6>f</h6>');
t('hr', 'x\n\n---\n\ny', {}, '<hr>');
t('blockquote', '> 引用\n> 続き\n\n本文', {}, '<blockquote><p>引用<br>続き</p></blockquote>');
t('nested list', '- a\n  - b\n    - c\n- d', {}, '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
t('ordered start', '3. x\n4. y', {}, '<ol start="3">');
t('task list', '- [x] 済\n- [ ] 未', {}, 'checked> 済', '<input type="checkbox" disabled> 未');
t('table align', '| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |', {}, 'text-align:center', 'text-align:right', '<td>1</td>');
t('table no outer pipes', 'a | b\n--|--\n1 | 2', {}, '<th>a</th>', '<td>2</td>');
t('code fence + lang', '```js\nconst a = "<b>";\n```', {}, 'data-lang="js"', '&lt;b&gt;');
t('tilde fence', '~~~\nx\n~~~', {}, '<pre><code>x</code></pre>');
t('inline code protects', '`**not bold**` と **bold**', {}, '<code>**not bold**</code>', '<strong>bold</strong>');
t('italic / strike', '*i* と _j_ と ~~k~~', {}, '<em>i</em>', '<em>j</em>', '<del>k</del>');
nt('snake_case not italic', 'a snake_case_name here', {}, '<em>');
nt('url underscores intact', 'https://x.com/a_b_c/d', {}, '<em>');
t('autolink', 'see https://example.com/a?b=1, ok', {}, 'href="https://example.com/a?b=1"');
t('link http', '[x](https://e.com)', {}, 'target="_blank"', 'rel="noopener noreferrer"');
nt('javascript: link blocked', '[x](javascript:alert(1))', { resolve: (u) => u }, 'href', 'javascript');
nt('data: link blocked', '[x](data:text/html,hi)', { resolve: (u) => u }, 'href');
t('relative link -> data-rel', '[doc](docs/A.md)', { resolve: (u) => `base/${u}` }, 'data-rel="base/docs/A.md"');
nt('anchor link text only', '[top](#top)', { resolve: (u) => u }, 'href');
t('relative image', '![logo](img/a.png)', { resolve: (u) => u, rawUrl: (p) => `/raw?p=${p}` }, '<img src="/raw?p=img/a.png"');
nt('external image not loaded', '![x](https://evil.example/a.png)', { resolve: (u) => u, rawUrl: (p) => p }, '<img');
t('external image -> link', '![x](https://e.com/a.png)', {}, 'class="imglink"');
nt('xss in text', '<script>alert(1)</script> <img src=x onerror=alert(1)>', {}, '<script', '<img');
nt('xss in alt', '![a"onerror="x](img/a.png)', { resolve: (u) => u, rawUrl: (p) => p }, 'onerror="');
nt('xss in code lang', '```"><script>\nx\n```', {}, '<script');
t('table cell inline', '| a |\n|---|\n| `x` **y** |', {}, '<code>x</code>', '<strong>y</strong>');
t('empty input', '', {}, '');
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
