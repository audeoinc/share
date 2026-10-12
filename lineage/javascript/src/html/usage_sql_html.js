"use strict";

/**
 * 使用箇所つき SQL を HTML へ描画するレンダラ。
 *
 * Looker Studio のコミュニティ ビジュアライゼーション "Templated Record" に
 * HTML 文字列のカラムを渡して描画させるためのもの。Templated Record は
 * ギャラリー掲載品で公開元がホストしているため、GCS バケットを公開する必要がない
 * （自作ビジュアライゼーションは公開バケットが必須で、それが禁止の環境では使えない）。
 *
 * 描画するもの:
 *   - 行番号つきの SQL 全文
 *   - 該当行の行ハイライト
 *   - 該当箇所（複数可）の文字ハイライト
 *   - SQL の簡易構文ハイライト
 *
 * ハイライト位置は "line:column:length" の文字列で受け取る。line / column は
 * リポジトリの line_number / column_number と同じ 1 始まりで、column は
 * 行頭インデントを含む文字位置（タブは 1 文字）。したがってタブを空白へ展開しては
 * ならない（位置がずれる）。表示側は white-space:pre-wrap で見た目を保つ。
 *
 * このモジュールは BigQuery の JS UDF 本体として埋め込まれる（scripts/
 * build_usage_html_udf.js が 01 の生成ブロックへ差し込む）。BigQuery の
 * インライン コード ブロブは 32KB が上限なので、追加時はサイズに注意すること。
 */

/* 予約語。色分けの対象。網羅ではなく、読みやすさに効くものを選んでいる。 */
const SQL_KEYWORDS = new Set(
  ("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING " +
   "AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME " +
   "GROUP BY HAVING QUALIFY ORDER ASC DESC LIMIT OFFSET " +
   "UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END " +
   "WITH RECURSIVE OVER PARTITION WINDOW UNNEST STRUCT ARRAY " +
   "CREATE OR REPLACE TABLE VIEW FUNCTION TEMP TEMPORARY IF " +
   "INSERT INTO VALUES UPDATE SET DELETE MERGE MATCHED " +
   "CAST SAFE_CAST INTERVAL EXTRACT TRUE FALSE " +
   "INT64 FLOAT64 NUMERIC STRING BYTES BOOL DATE DATETIME TIME TIMESTAMP JSON"
  ).split(/\s+/)
);

const DEFAULTS = {
  mode: "embed",
  contextLines: null,
  maxLines: 5000,
  fontSize: 12,
  lineHeight: 1.45,
  font: "'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",
  text: "#24292F",
  num: "#8C959F",
  numBg: "#F6F8FA",
  border: "#D8DEE4",
  hitBg: "#FFF8C5",
  hitBar: "#D4A72C",
  markBg: "#FFE58F",
  gapBg: "#F6F8FA",
  gapText: "#6E7781",
  keyword: "#CF222E",
  literal: "#098658",
  comment: "#6E7781"
};

const PREFIX = "lnge-sq";

function resolveOptions(optionsJson) {
  const options = Object.assign({}, DEFAULTS);

  if (optionsJson === null || optionsJson === undefined || optionsJson === "") {
    return options;
  }

  let parsed;

  try {
    parsed = JSON.parse(optionsJson);
  } catch (error) {
    /* 壊れた JSON で描画ごと落とさない。既定で描いたほうが運用上ましなので。 */
    return options;
  }

  if (!parsed || typeof parsed !== "object") {
    return options;
  }

  for (const key of Object.keys(DEFAULTS)) {
    if (parsed[key] !== undefined && parsed[key] !== null) {
      options[key] = parsed[key];
    }
  }

  if (parsed.colors && typeof parsed.colors === "object") {
    for (const key of ["hitBg", "hitBar", "markBg", "num", "numBg", "text", "border"]) {
      if (parsed.colors[key]) options[key] = parsed.colors[key];
    }
  }

  if (parsed.syntax && typeof parsed.syntax === "object") {
    for (const key of ["keyword", "literal", "comment"]) {
      if (parsed.syntax[key]) options[key] = parsed.syntax[key];
    }
  }

  if (options.mode !== "class" && options.mode !== "inline" && options.mode !== "embed") {
    options.mode = DEFAULTS.mode;
  }

  return options;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * "line:column:length" を解析し、行番号ごとの範囲一覧へ畳む。
 *
 * 同じ箇所が経路違いで何度も渡ってくる（影響グラフは経路ごとに 1 行なので、
 * 同一の使用箇所が複数回現れる）ため、ここで重複排除と重なりの結合まで行う。
 * 範囲は [start, end) の 0 始まり列オフセットへ正規化する。
 */
function parseHighlights(highlights) {
  const byLine = new Map();

  if (!Array.isArray(highlights)) {
    return byLine;
  }

  for (const entry of highlights) {
    if (entry === null || entry === undefined) continue;

    const parts = String(entry).split(":");
    if (parts.length < 2) continue;

    const line = Number(parts[0]);
    const column = Number(parts[1]);
    const length = parts.length > 2 ? Number(parts[2]) : 0;

    if (!Number.isFinite(line) || !Number.isFinite(column)) continue;
    if (line < 1 || column < 1) continue;

    const start = column - 1;
    const end = start + (Number.isFinite(length) && length > 0 ? length : 1);

    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push([start, end]);
  }

  for (const [line, ranges] of byLine) {
    ranges.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

    const merged = [];

    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) {
        last[1] = Math.max(last[1], range[1]);
      } else {
        merged.push([range[0], range[1]]);
      }
    }

    byLine.set(line, merged);
  }

  return byLine;
}

/** 1 行を、ハイライト範囲で { text, hit } のセグメントへ切り分ける。 */
function segmentLine(line, ranges) {
  if (!ranges || ranges.length === 0) {
    return [{ text: line, hit: false }];
  }

  const segments = [];
  let cursor = 0;

  for (const [start, end] of ranges) {
    const from = Math.max(0, Math.min(start, line.length));
    const to = Math.max(from, Math.min(end, line.length));

    if (from > cursor) segments.push({ text: line.slice(cursor, from), hit: false });
    if (to > from) segments.push({ text: line.slice(from, to), hit: true });

    cursor = Math.max(cursor, to);
  }

  if (cursor < line.length) segments.push({ text: line.slice(cursor), hit: false });

  return segments;
}

/**
 * SQL の簡易構文ハイライト。予約語 / 文字列・数値リテラル / 行コメントのみ。
 *
 * ハイライト セグメントごとに独立して呼ぶため、語がセグメント境界で分断された場合は
 * 色が付かない。位置ハイライトを優先する意図的な割り切り。
 */
function highlightSql(source, options, styles) {
  const length = source.length;
  const isSpace = (c) => c === " " || c === "\t";
  const isDigit = (c) => c >= "0" && c <= "9";
  const isWordStart = (c) => /[A-Za-z_]/.test(c);
  const isWord = (c) => /[A-Za-z0-9_]/.test(c);

  let index = 0;
  let out = "";

  while (index < length) {
    const character = source[index];

    if (isSpace(character)) {
      let end = index + 1;
      while (end < length && isSpace(source[end])) end++;
      out += escapeHtml(source.slice(index, end));
      index = end;
      continue;
    }

    if (character === "-" && source[index + 1] === "-") {
      out += styles.comment(source.slice(index));
      break;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      let end = index + 1;
      while (end < length) {
        if (source[end] === "\\") { end += 2; continue; }
        if (source[end] === quote) {
          if (source[end + 1] === quote) { end += 2; continue; }
          end++;
          break;
        }
        end++;
      }
      out += styles.literal(source.slice(index, end));
      index = end;
      continue;
    }

    if (isDigit(character)) {
      let end = index + 1;
      while (end < length && (isDigit(source[end]) || source[end] === ".")) end++;
      out += styles.literal(source.slice(index, end));
      index = end;
      continue;
    }

    if (isWordStart(character)) {
      let end = index + 1;
      while (end < length && isWord(source[end])) end++;
      const word = source.slice(index, end);
      out += SQL_KEYWORDS.has(word.toUpperCase()) ? styles.keyword(word) : escapeHtml(word);
      index = end;
      continue;
    }

    out += escapeHtml(character);
    index++;
  }

  return out;
}

/** mode に応じて、class 属性かインライン style 属性のどちらかを返す。 */
function makeAttrs(options) {
  const inline = options.mode === "inline";

  const cls = (name) => (inline ? "" : ` class="${PREFIX}-${name}"`);
  const sty = (declaration) => (inline ? ` style="${declaration}"` : "");

  return {
    root: cls("root") + sty(
      `font-family:${options.font};font-size:${options.fontSize}px;` +
      `line-height:${options.lineHeight};color:${options.text};`
    ),
    table: cls("table") + sty(
      `border-collapse:collapse;width:100%;table-layout:fixed;` +
      `border:1px solid ${options.border};`
    ),
    /* 非ハイライト行は装飾しないので属性を出さない（markup を無駄に太らせない）。 */
    row: "",
    rowHit: cls("row-hit") + sty(`background:${options.hitBg};`),
    num: cls("num") + sty(
      `width:52px;padding:0 8px;text-align:right;vertical-align:top;` +
      `color:${options.num};background:${options.numBg};` +
      `border-right:1px solid ${options.border};` +
      `user-select:none;white-space:nowrap;`
    ),
    numHit: cls("num-hit") + sty(
      `width:52px;padding:0 8px;text-align:right;vertical-align:top;` +
      `color:${options.text};background:${options.hitBg};font-weight:600;` +
      `border-right:1px solid ${options.border};` +
      `border-left:3px solid ${options.hitBar};` +
      `user-select:none;white-space:nowrap;`
    ),
    code: cls("code") + sty(
      `padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;`
    ),
    mark: cls("mark") + sty(
      `background:${options.markBg};border-radius:2px;padding:0 1px;`
    ),
    gap: cls("gap") + sty(
      `padding:2px 10px;color:${options.gapText};background:${options.gapBg};` +
      `border-top:1px solid ${options.border};border-bottom:1px solid ${options.border};`
    ),
    keyword: (text) => `<span${cls("kw")}${sty(`color:${options.keyword};`)}>${escapeHtml(text)}</span>`,
    literal: (text) => `<span${cls("li")}${sty(`color:${options.literal};`)}>${escapeHtml(text)}</span>`,
    comment: (text) => `<span${cls("cm")}${sty(`color:${options.comment};font-style:italic;`)}>${escapeHtml(text)}</span>`
  };
}

/** class / embed モードでテンプレートに貼る CSS。inline モードでは使わない。 */
function buildUsageSqlCss(optionsJson) {
  const o = resolveOptions(optionsJson);
  const p = "." + PREFIX;

  return [
    `${p}-root{font-family:${o.font};font-size:${o.fontSize}px;line-height:${o.lineHeight};color:${o.text};}`,
    `${p}-table{border-collapse:collapse;width:100%;table-layout:fixed;border:1px solid ${o.border};}`,
    `${p}-row-hit{background:${o.hitBg};}`,
    `${p}-num{width:52px;padding:0 8px;text-align:right;vertical-align:top;color:${o.num};background:${o.numBg};border-right:1px solid ${o.border};user-select:none;white-space:nowrap;}`,
    `${p}-num-hit{width:52px;padding:0 8px;text-align:right;vertical-align:top;color:${o.text};background:${o.hitBg};font-weight:600;border-right:1px solid ${o.border};border-left:3px solid ${o.hitBar};user-select:none;white-space:nowrap;}`,
    `${p}-code{padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;}`,
    `${p}-mark{background:${o.markBg};border-radius:2px;padding:0 1px;}`,
    `${p}-gap{padding:2px 10px;color:${o.gapText};background:${o.gapBg};border-top:1px solid ${o.border};border-bottom:1px solid ${o.border};}`,
    `${p}-kw{color:${o.keyword};}`,
    `${p}-li{color:${o.literal};}`,
    `${p}-cm{color:${o.comment};font-style:italic;}`
  ].join("\n");
}

/**
 * SQL 全文（または該当行の周辺）を、行番号つき・ハイライトつきの HTML にして返す。
 *
 * @param {string} sqlText 対象オブジェクトの SQL 本文
 * @param {Array<string>} highlights "line:column:length" の配列
 * @param {string} optionsJson 表示オプション JSON（null / '{}' で既定）
 * @returns {string} HTML。sqlText が空なら空文字
 */
function renderUsageSqlHtml(sqlText, highlights, optionsJson) {
  if (sqlText === null || sqlText === undefined || sqlText === "") {
    return "";
  }

  const options = resolveOptions(optionsJson);
  const attrs = makeAttrs(options);
  const byLine = parseHighlights(highlights);
  const lines = String(sqlText).split("\n");

  /*
   * 表示する行を決める。contextLines 未指定なら全行。指定時はハイライト行の前後
   * N 行だけを残し、飛ばした区間には「… N 行省略 …」の行を挟む。
   */
  let visible = null;

  const contextOption = options.contextLines;

  /*
   * Number(null) は 0（有限）なので、null を数値として判定してはならない。
   * 未指定を「前後 0 行」と誤読すると全文が省略されてしまう。
   */
  const hasContext =
    contextOption !== null &&
    contextOption !== undefined &&
    contextOption !== "" &&
    Number.isFinite(Number(contextOption)) &&
    Number(contextOption) >= 0;

  if (hasContext && byLine.size > 0) {
    const context = Number(options.contextLines);
    visible = new Set();

    for (const line of byLine.keys()) {
      for (let n = line - context; n <= line + context; n++) {
        if (n >= 1 && n <= lines.length) visible.add(n);
      }
    }
  }

  const rows = [];
  let rendered = 0;
  let skipped = 0;
  let truncated = false;

  const flushGap = () => {
    if (skipped > 0) {
      rows.push(`<tr><td${attrs.gap} colspan="2">… ${skipped} 行省略 …</td></tr>`);
      skipped = 0;
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;

    if (visible && !visible.has(lineNumber)) {
      skipped++;
      continue;
    }

    if (rendered >= options.maxLines) {
      truncated = true;
      break;
    }

    flushGap();

    const ranges = byLine.get(lineNumber);
    const isHit = Boolean(ranges && ranges.length);
    const segments = segmentLine(lines[index], ranges);

    let code = "";

    for (const segment of segments) {
      const inner = highlightSql(segment.text, options, attrs);
      code += segment.hit ? `<span${attrs.mark}>${inner}</span>` : inner;
    }

    if (code === "") code = "&nbsp;";

    rows.push(
      `<tr${isHit ? attrs.rowHit : attrs.row}>` +
      `<td${isHit ? attrs.numHit : attrs.num}>${lineNumber}</td>` +
      `<td${attrs.code}>${code}</td>` +
      `</tr>`
    );

    rendered++;
  }

  flushGap();

  if (truncated) {
    rows.push(
      `<tr><td${attrs.gap} colspan="2">` +
      `… 以降 ${lines.length - rendered} 行は maxLines (${options.maxLines}) により省略 …` +
      `</td></tr>`
    );
  }

  const body = `<div${attrs.root}><table${attrs.table}>${rows.join("")}</table></div>`;

  if (options.mode === "embed") {
    return `<style>${buildUsageSqlCss(optionsJson)}</style>${body}`;
  }

  return body;
}

module.exports = {
  renderUsageSqlHtml,
  buildUsageSqlCss,
  PREFIX
};
