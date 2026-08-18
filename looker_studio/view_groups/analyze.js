'use strict';
/**
 * suffix 違いの View 群を「SQL ロジックが同じもの」でグループ化し、
 * グループ内で異なるトークンをパラメータ化する。
 *
 *   v_sales_a … v_sales_j (10 本)
 *     → base = v_sales, suffix = a…j
 *     → ロジックが同じもの同士をグループ化   G1: a,c,e  G2: b,d  G3: f,g,h,i,j
 *     → グループ内の差分を {{P1}} … に置換したパラメータ化 SQL を得る
 *     → グループ間はこのパラメータ化 SQL を比較する（＝ロジック差分だけが残る）
 *
 * 「同じロジック」の判定は、トークン列が同じ長さ・同じ種類で並び、異なる箇所が
 * 一貫した 1 対 1 対応（全単射）になっていること（α 等価）で行う。
 * suffix の文字列置換に依存しないので、参照テーブル以外が異なっていても揃う。
 *
 * 判定は強い条件だが万能ではない（構造が同じで意味が違う差も同一視しうる）ので、
 * 何をパラメータとみなしたかを必ず params として返し、画面に出せるようにしている。
 * 隠さず見せることで、判定の当否を人が確認できる。
 */

// ---------------------------------------------------------------------
// トークナイザ
// ---------------------------------------------------------------------

// バッククォート識別子・文字列リテラル・コメントを 1 トークンとして扱う。
// これらを分解してしまうと α 等価の判定が壊れる。
const TOKEN_RE = new RegExp([
  '(`[^`]*`)',                       // 1 バッククォート識別子
  "('(?:\\\\.|[^'\\\\])*')",         // 2 単一引用符リテラル
  '("(?:\\\\.|[^"\\\\])*")',         // 3 二重引用符リテラル
  '(--[^\\n]*|#[^\\n]*)',            // 4 行コメント
  '(/\\*[\\s\\S]*?\\*/)',            // 5 ブロックコメント
  '(\\d+(?:\\.\\d+)?)',              // 6 数値
  '([A-Za-z_][A-Za-z0-9_]*)',        // 7 識別子・予約語
  '(\\s+)',                          // 8 空白
  '([^\\s])',                        // 9 記号
].join('|'), 'g');

const KEYWORDS = new Set((
  'SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING ' +
  'AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME ' +
  'GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW ' +
  'UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END ' +
  'CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS ' +
  'WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY ' +
  'CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP ' +
  'INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE ' +
  'COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW'
).split(/\s+/));

/** SQL を種類つきトークンに分解する。 */
function tokenizeSql(sql) {
  const out = [];
  const s = String(sql == null ? '' : sql);
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s)) !== null) {
    let kind;
    if (m[1]) kind = 'quoted';
    else if (m[2] || m[3]) kind = 'string';
    else if (m[4] || m[5]) kind = 'comment';
    else if (m[6]) kind = 'number';
    else if (m[7]) kind = KEYWORDS.has(m[7].toUpperCase()) ? 'keyword' : 'ident';
    else if (m[8]) kind = 'space';
    else kind = 'punct';
    out.push({ kind, text: m[0] });
  }
  return out;
}

/**
 * CREATE VIEW … OPTIONS( … ) AS … の OPTIONS 句を落とす。
 *
 * BigQuery が返す DDL には description や作成タイムスタンプなどが OPTIONS に
 * 入ることがある。これはメタデータであってロジックではないのに、View ごとに
 * 値が違うので、そのままだと全部が別グループに割れる。
 * ビュー側を書き換えるのではなく、解析側で無視する。
 *
 * 正規表現ではなくトークン列で処理するのは、OPTIONS の値に括弧や引用符が
 * 入っていても対応する ')' を正しく見つけるため。
 */
function stripOptionsClause(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'keyword' && t.text.toUpperCase() === 'OPTIONS') {
      let j = i + 1;
      while (j < tokens.length && tokens[j].kind === 'space') j++;
      if (j < tokens.length && tokens[j].text === '(') {
        let depth = 0;
        let k = j;
        for (; k < tokens.length; k++) {
          if (tokens[k].text === '(') depth++;
          else if (tokens[k].text === ')') {
            depth--;
            if (depth === 0) { k++; break; }
          }
        }
        // OPTIONS の直前の空白も落として、残りの整形を自然に保つ
        while (out.length > 0 && out[out.length - 1].kind === 'space') out.pop();
        i = k;
        continue;
      }
    }
    out.push(t);
    i++;
  }
  return out;
}

/** 比較用に空白を 1 個へ潰す（整形の違いでロジック差と誤認しないため）。 */
function normalizeSpace(tokens) {
  return tokens.map((t) => (t.kind === 'space' ? { kind: 'space', text: ' ' } : t));
}

// ---------------------------------------------------------------------
// suffix 抽出
// ---------------------------------------------------------------------

/**
 * 末尾の "_ + 短い識別子" を suffix とみなす既定規則。
 * v_daily_sales のような通常の複合語を誤って割らないよう、
 * suffix 側の長さと文字種で絞る。
 */
const DEFAULT_SUFFIX_RE = /^(.*?)_([A-Za-z0-9]{1,6})$/;

/**
 * suffixParts（[['ab','cd','ef'], ['jp','us','uk']] のような区分の並び）から
 * 取りうる suffix を全部作る。長いものから試すため長さ降順・辞書順で返す。
 */
function expandSuffixParts(parts) {
  let acc = [''];
  for (const part of parts) {
    const next = [];
    for (const a of acc) for (const b of part) next.push(a + b);
    acc = next;
  }
  return acc.sort((x, y) => y.length - x.length || x.localeCompare(y));
}

/**
 * @returns {{base: string, suffix: string, parts?: string[]} | null}
 */
function extractSuffix(viewName, opts) {
  const o = opts || {};

  // 区分の組み合わせで決まる場合（例: {ab,cd,ef} × {jp,us,uk} の 4 文字）。
  // 規則が最もはっきりするので、これが使えるなら最優先。
  if (Array.isArray(o.suffixParts) && o.suffixParts.length > 0) {
    const list = o._expanded || (o._expanded = expandSuffixParts(o.suffixParts));
    for (const suf of list) {
      if (viewName.length > suf.length + 1 && viewName.endsWith('_' + suf)) {
        // どの区分の値だったかも返す（ペイン見出しや集計に使える）
        const parts = [];
        let rest = suf;
        for (const part of o.suffixParts) {
          const hit = part.find((v) => rest.startsWith(v));
          if (hit === undefined) { parts.length = 0; break; }
          parts.push(hit);
          rest = rest.slice(hit.length);
        }
        return {
          base: viewName.slice(0, -(suf.length + 1)),
          suffix: suf,
          parts: parts.length ? parts : undefined,
        };
      }
    }
    return null;
  }

  if (Array.isArray(o.suffixList) && o.suffixList.length > 0) {
    // 既知の suffix 一覧がある場合は突き合わせが最も確実
    for (const suf of o.suffixList) {
      if (viewName.length > suf.length + 1 && viewName.endsWith('_' + suf)) {
        return { base: viewName.slice(0, -(suf.length + 1)), suffix: suf };
      }
    }
    return null;
  }
  const re = o.suffixPattern ? new RegExp(o.suffixPattern) : DEFAULT_SUFFIX_RE;
  const m = String(viewName).match(re);
  if (!m) return null;
  return { base: m[1], suffix: m[2] };
}

// ---------------------------------------------------------------------
// α 等価判定
// ---------------------------------------------------------------------

/** 既定で置換可能とみなす種類。リテラルは既定で含めない（意味の差である可能性が高いため）。 */
const DEFAULT_SUBSTITUTABLE = ['ident', 'quoted'];

/** suffix を伏せ字にするときの目印。SQL には現れない文字を使う。 */
const SUFFIX_MARK = '\u0000';

/**
 * トークンの中に出てくる「その View 自身の suffix」を伏せ字にする。
 *
 * 参照先の識別子もデータセット名も、View と同じ suffix を持つ運用なら、
 * 伏せ字にした時点で同じ文字列になる。つまり suffix 由来の差が
 * 「差ではない」ものとして扱われ、残った差だけが本当のロジック差になる。
 *
 * 置換可能種別（substitutable）を緩めるのと違い、
 * リテラルでも「suffix を含むから同じ」と「値そのものが違う」を区別できる。
 * WHERE region = 'abjp' と 'abus' は同一視されるが、
 * WHERE status = 'A' と 'B' はロジック差として残る。
 */
function maskSuffix(tokens, suffix) {
  if (!suffix || String(suffix).length < 2) return tokens;
  const s = String(suffix);
  return tokens.map((t) => {
    if (t.kind === 'space' || t.text.indexOf(s) < 0) return t;
    return { kind: t.kind, text: t.text.split(s).join(SUFFIX_MARK) };
  });
}

/**
 * 2 つのトークン列が「一貫した 1 対 1 置換で一致するか」を判定し、
 * 一致しない場合はどこで止まったかも返す。
 *
 * グループが想定より細かく割れたとき、原因が
 * 「リテラル差を既定でロジック差にしている」なのか本物の差なのかを
 * 切り分けられないと詰まるので、理由を出せるようにしている。
 *
 * @returns {{ok:true, fwd:Map, rev:Map} | {ok:false, reason:string, ...}}
 */
function alphaMapDetail(a, b, opts) {
  if (a.length !== b.length) {
    return { ok: false, reason: 'length', aLen: a.length, bLen: b.length };
  }
  const sub = new Set((opts && opts.substitutable) || DEFAULT_SUBSTITUTABLE);
  const fwd = new Map();
  const rev = new Map();
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    const at = (r) => ({ ok: false, reason: r, index: i, kind: x.kind,
      otherKind: y.kind, aText: x.text, bText: y.text });
    if (x.kind !== y.kind) return at('kind');
    if (x.text === y.text) continue;
    // 予約語・記号の違いはロジック差。既定ではリテラルもここで弾く。
    if (!sub.has(x.kind)) return at('not-substitutable');
    if (fwd.has(x.text) && fwd.get(x.text) !== y.text) return at('inconsistent');
    if (rev.has(y.text) && rev.get(y.text) !== x.text) return at('not-injective');
    fwd.set(x.text, y.text);
    rev.set(y.text, x.text);
  }
  return { ok: true, fwd, rev };
}

/**
 * @returns {{fwd: Map, rev: Map} | null}  一致しなければ null
 */
function alphaMap(a, b, opts) {
  const d = alphaMapDetail(a, b, opts);
  return d.ok ? { fwd: d.fwd, rev: d.rev } : null;
}

// ---------------------------------------------------------------------
// グループ化とパラメータ化
// ---------------------------------------------------------------------

/**
 * グループ内で値が割れているトークン位置を {{P1}} … に置換する。
 * 全メンバでトークン数が揃っている（α 等価の前提）ことを利用して添字で突き合わせる。
 * 同じ「値の並び」を持つ位置には同じパラメータ名を割り当てるので、
 * 参照テーブルの suffix のように複数箇所に出るものは 1 つのパラメータにまとまる。
 */
function parameterize(members) {
  const n = members[0].tokens.length;
  const byTuple = new Map();
  const params = [];
  const out = [];
  for (let i = 0; i < n; i++) {
    // 表示は raw（元の空白・改行）を使う。tokens は比較用に空白を潰してあるので、
    // そのまま出すと 1 行に潰れて差分ペインに出せなくなる。
    // 空白は整形の差であってロジックの差ではないため、先頭メンバのものを採用する。
    if (members[0].tokens[i].kind === 'space') {
      out.push(members[0].raw[i].text);
      continue;
    }
    const texts = members.map((m) => m.raw[i].text);
    let allSame = true;
    for (let j = 1; j < texts.length; j++) if (texts[j] !== texts[0]) { allSame = false; break; }
    if (allSame) { out.push(texts[0]); continue; }
    const key = JSON.stringify(texts);
    if (!byTuple.has(key)) {
      const name = 'P' + (params.length + 1);
      byTuple.set(key, name);
      const values = {};
      members.forEach((m, j) => { values[m.suffix] = texts[j]; });
      params.push({ name, kind: members[0].raw[i].kind, values });
    }
    out.push('{{' + byTuple.get(key) + '}}');
  }
  return { sql: out.join(''), params };
}

/**
 * 同じ base を持つ View 群をロジックでグループ化する。
 *
 * @param {Array<{suffix: string, ddl: string, viewName?: string}>} views
 * @param {{substitutable?: string[]}} [opts]
 * @returns {Array<{suffixes: string[], members: object[], sql: string, params: object[]}>}
 */
function groupByLogic(views, opts) {
  const stripOpts = !(opts && opts.stripOptions === false);
  const suffixAware = !(opts && opts.suffixAware === false);
  const prepared = views.map((v) => {
    let raw = tokenizeSql(v.ddl);
    // OPTIONS はメタデータ。既定で落とす（stripOptions: false で無効化）
    if (stripOpts) raw = stripOptionsClause(raw);
    // raw は表示用（元の整形を保つ）、tokens は比較用
    //   空白を潰し、さらに自分の suffix を伏せ字にする
    const tokens = normalizeSpace(raw);
    return {
      ...v,
      raw,
      tokens: suffixAware ? maskSuffix(tokens, v.suffix) : tokens,
    };
  });

  const groups = [];
  for (const v of prepared) {
    // α 等価は推移的（全単射の合成）なので、代表 1 本と比べれば足りる
    let hit = null;
    let firstMiss = null;
    for (const g of groups) {
      const d = alphaMapDetail(g.members[0].tokens, v.tokens, opts);
      if (d.ok) { hit = g; break; }
      if (!firstMiss) firstMiss = { vs: g.members[0].suffix, detail: d };
    }
    if (hit) hit.members.push(v);
    else groups.push({ members: [v], miss: firstMiss });
  }

  // 大きいグループを先頭に（比較の基準に使う）
  groups.sort((a, b) => b.members.length - a.members.length ||
    String(a.members[0].suffix).localeCompare(String(b.members[0].suffix)));

  return groups.map((g) => {
    const members = g.members
      .slice()
      .sort((x, y) => String(x.suffix).localeCompare(String(y.suffix)));
    const p = parameterize(members);
    return {
      suffixes: members.map((m) => m.suffix),
      members,
      sql: p.sql,
      params: p.params,
      // 先頭グループ以外は「なぜ別グループになったか」を持つ
      miss: g.miss || null,
    };
  });
}

/**
 * INFORMATION_SCHEMA 相当の行（view_name, ddl）を base 名ごとに束ねてグループ化する。
 *
 * suffix を認識できなかった View も、既定では単独の base として並べる
 * （base = View 名 / 1 グループ / 1 View）。出さないとソースが画面から消えてしまい、
 * 命名規則から外れた View ほど気づけなくなる。`includeUnmatched: false` で従来どおり
 * 除外できる。どちらの場合も `unmatched` には元の行が入るので、件数は数えられる。
 *
 * @returns {{bases: Array<{base: string, viewCount: number, groupCount: number,
 *            groups: object[], unmatched?: boolean}>, unmatched: object[]}}
 */
function analyze(rows, opts) {
  const includeUnmatched = !(opts && opts.includeUnmatched === false);
  const byBase = new Map();
  const unmatched = [];
  for (const r of rows) {
    const ex = extractSuffix(r.view_name, opts);
    if (!ex) { unmatched.push(r); continue; }
    if (!byBase.has(ex.base)) byBase.set(ex.base, []);
    byBase.get(ex.base).push({
      viewName: r.view_name, suffix: ex.suffix, parts: ex.parts, ddl: r.ddl,
    });
  }
  const out = [];
  for (const [base, views] of byBase) {
    const groups = groupByLogic(views, opts);
    out.push({ base, viewCount: views.length, groupCount: groups.length, groups });
  }
  if (includeUnmatched) {
    for (const r of unmatched) {
      // suffix は null。比較相手がいないので伏せ字もパラメータ化も働かない。
      const views = [{ viewName: r.view_name, suffix: null, parts: null, ddl: r.ddl }];
      out.push({
        base: r.view_name,
        viewCount: 1,
        groupCount: 1,
        groups: groupByLogic(views, opts),
        unmatched: true,
      });
    }
  }
  out.sort((a, b) => b.groupCount - a.groupCount || a.base.localeCompare(b.base));
  return { bases: out, unmatched };
}

module.exports = {
  tokenizeSql, normalizeSpace, stripOptionsClause, maskSuffix,
  extractSuffix, expandSuffixParts, alphaMap, alphaMapDetail,
  parameterize, groupByLogic, analyze,
  DEFAULT_SUFFIX_RE, DEFAULT_SUBSTITUTABLE, KEYWORDS,
};
