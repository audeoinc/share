// 小さな Markdown レンダラー (依存なし)。出力は必ずエスケープ済み。
// opts: { soft: 段落内の改行を空白にする, resolve(url): 相対パスを作業フォルダ内のパスに解決, rawUrl(path): 画像の配信 URL }
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const FENCE_END = /^\s*(```+|~~~+)\s*$/;
const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const indentOf = (ws) => ws.replace(/\t/g, '    ').length;

// ---------- インライン ----------
function inline(src, o) {
  const holds = [];
  const hold = (html) => { holds.push(html); return `\u0001${holds.length - 1}\u0001`; };
  let s = src;
  // コードスパンは最初に退避 (中身は加工しない)
  s = s.replace(/(`+)([^`]|[^`][^]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${esc(code.trim())}</code>`));
  // 画像
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_, alt, url) => hold(imageHtml(alt, url, o)));
  // リンク (リンクの文字は再帰的に処理)
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_, text, url) => hold(linkHtml(inline(text, o), url, o)));
  // 裸の URL
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, url) => `${pre}${hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`)}`);
  s = esc(s);
  s = s.replace(/\*\*([^*][^]*?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__([^_][^]*?)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s](?:[^*]*?[^*\s])?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\s](?:[^_]*?[^_\s])?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~][^]*?)~~/g, '<del>$1</del>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => holds[Number(i)]);
}
function imageHtml(alt, url, o) {
  if (/^https?:/i.test(url)) return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="imglink">🖼 ${esc(alt || '画像')}</a>`; // 外部画像は自動で読み込まない
  if (o.resolve && o.rawUrl && !SCHEME.test(url) && !url.startsWith('//')) {
    const p = o.resolve(url);
    if (p && IMG_EXT.test(p)) return `<img src="${esc(o.rawUrl(p))}" alt="${esc(alt)}" loading="lazy">`;
  }
  return esc(alt || '');
}
function linkHtml(textHtml, url, o) {
  if (/^https?:\/\//i.test(url)) return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${textHtml}</a>`;
  if (url.startsWith('#') || SCHEME.test(url) || url.startsWith('//')) return textHtml; // ページ内リンクや危険な形式は文字だけにする
  if (o.resolve) { const p = o.resolve(url); if (p) return `<a href="#" data-rel="${esc(p)}">${textHtml}</a>`; }
  return textHtml;
}

// ---------- ブロック ----------
const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEP.test(lines[i + 1]);
const startsBlock = (lines, i) => {
  const l = lines[i];
  return FENCE.test(l) || HEAD.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l) || isTableStart(lines, i);
};
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function tableHtml(lines, i, o) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
  const rows = []; let k = i + 2;
  while (k < lines.length && lines[k].trim() && lines[k].includes('|')) rows.push(splitRow(lines[k++]));
  const cell = (tag, c, n) => `<${tag}${aligns[n] ? ` style="text-align:${aligns[n]}"` : ''}>${inline(c, o)}</${tag}>`;
  const html = `<div class="tbl"><table><thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, n) => cell('td', c, n)).join('')}</tr>`).join('')}</tbody></table></div>`;
  return { html, next: k };
}

function listHtml(lines, i, o) {
  const m0 = ITEM.exec(lines[i]); const base = indentOf(m0[1]); const ordered = /\d/.test(m0[2]);
  const start = ordered ? parseInt(m0[2], 10) : 1; const items = [];
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || HR.test(lines[i]) || indentOf(m[1]) !== base) break;
    let text = m[3]; i++;
    let task = null; const t = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (t) { task = t[1] !== ' '; text = t[2]; }
    const cont = []; let nested = '';
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { // 空行: 次の行がこの項目より深ければ続ける
        const nx = lines[i + 1]; if (nx === undefined) break;
        const ind = indentOf(nx.match(/^\s*/)[0]);
        if (nx.trim() && ind > base) { i++; continue; }
        break;
      }
      const mm = ITEM.exec(l);
      if (mm && indentOf(mm[1]) > base) { const r = listHtml(lines, i, o); nested += r.html; i = r.next; continue; }
      if (mm || startsBlock(lines, i) && indentOf(l.match(/^\s*/)[0]) <= base) break;
      if (indentOf(l.match(/^\s*/)[0]) > base) { cont.push(l.trim()); i++; continue; }
      break;
    }
    const box = task === null ? '' : `<input type="checkbox" disabled${task ? ' checked' : ''}> `;
    items.push(`<li>${box}${inline([text, ...cont].join(o.soft ? ' ' : '\n'), o).replace(/\n/g, '<br>')}${nested}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>`, next: i };
}

function blocks(lines, o) {
  const out = []; let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    let m;
    if ((m = FENCE.exec(ln))) {
      const ch = m[1][0]; const lang = m[2]; const buf = []; i++;
      while (i < lines.length && !(FENCE_END.test(lines[i]) && lines[i].trim()[0] === ch)) buf.push(lines[i++]);
      i++; out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    if ((m = HEAD.exec(ln))) { out.push(`<h${m[1].length}>${inline(m[2], o)}</h${m[1].length}>`); i++; continue; }
    if (HR.test(ln)) { out.push('<hr>'); i++; continue; }
    if (QUOTE.test(ln)) {
      const inner = []; while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${blocks(inner, o)}</blockquote>`); continue;
    }
    if (isTableStart(lines, i)) { const r = tableHtml(lines, i, o); out.push(r.html); i = r.next; continue; }
    if (ITEM.test(ln)) { const r = listHtml(lines, i, o); out.push(r.html); i = r.next; continue; }
    const para = [ln]; i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
    const joined = para.map((l, n) => (n < para.length - 1 ? (/( {2,}|\\)$/.test(l) ? `${l.replace(/( {2,}|\\)$/, '')}\n` : `${l.trimEnd()}${o.soft ? ' ' : '\n'}`) : l.trimEnd())).join('');
    out.push(`<p>${inline(joined, o).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

export function renderMarkdown(src, opts = {}) {
  return blocks(String(src).replace(/\r\n?/g, '\n').split('\n'), opts);
}
