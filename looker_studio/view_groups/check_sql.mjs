// build_table.sql と view_group_html.sql の食い違いを機械で見つける。
//
//   node check_sql.mjs
//
// build_table.sql は手で編集するファイルで、動的 SQL のプレースホルダは
// viewlgc_render_dynamic_sql が展開する。両者は別ファイルなので、
// 目印を足したのに関数側に置換を足し忘れる、という壊れ方をする。
// それは実行して初めて分かる（しかも ASSERT が出るのは対象の SQL だけ）ので、
// ここで静的に突き合わせる。
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const table = await readFile(join(here, 'build_table.sql'), 'utf8');
const udf = await readFile(join(here, 'view_group_html.sql'), 'utf8');
const chrome = await readFile(join(here, 'chrome.js'), 'utf8');

const checks = [];
const add = (name, ok, detail) => checks.push([name, ok, detail]);

// --- テンプレートを取り出す -------------------------------------------
// SET sql_template = """ … """; の中身。
// コメント行（-- で始まる例示）は数えない。
// 行頭の空白は許す。IF … THEN の中に置く 4 手は字下げしてあるため。
const templates = [...table.matchAll(/^ *SET sql_template = """([\s\S]*?)""";/gm)]
  .map((m) => m[1]);
add('sql_template が 1 つ以上ある', templates.length > 0, `${templates.length} 個`);

// --- 1. 使っている目印が関数側で展開されるか ---------------------------
// こちらはコメント中の例（セクション 4 の CSS 取得）も対象にする。
// 外して実行したときに落ちては困るので、展開できることは常に保証する。
const allTemplates = [...table.matchAll(/SET sql_template = """([\s\S]*?)""";/g)]
  .map((m) => m[1]);
const used = new Set();
for (const t of allTemplates) {
  for (const m of t.matchAll(/__[A-Z0-9_]+__/g)) used.add(m[0]);
}
// 関数本体の REPLACE(…, '__X__', …) から、展開できる目印を拾う。
const handled = new Set(
  [...udf.matchAll(/'(__[A-Z0-9_]+__)',/g)].map((m) => m[1])
);
const missing = [...used].filter((t) => !handled.has(t));
add('テンプレートの目印はすべて render 関数が展開できる',
  missing.length === 0, missing.join(' '));

// 逆向き。使われていない置換は消し忘れなので落とす。
const unusedTokens = [...handled].filter((t) => !used.has(t));
add('render 関数の置換に使われていないものが無い',
  unusedTokens.length === 0, unusedTokens.join(' '));

// --- 2. 4 手の型を守っているか ----------------------------------------
// SET sql_template → render → ASSERT → EXECUTE の並びを数で確かめる。
const renderCalls = (table.match(
  /^ *EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;/gm) || []).length;
const asserts = (table.match(
  /^ *ASSERT NOT REGEXP_CONTAINS\(rendered_sql, r'__\[A-Z0-9_\]\+__'\) AS/gm) || []).length;
const execs = (table.match(/^ *EXECUTE IMMEDIATE rendered_sql/gm) || []).length;
add('テンプレートと render 呼び出しが同数', templates.length === renderCalls,
  `template ${templates.length} / render ${renderCalls}`);
add('render 呼び出しと未展開チェックが同数', renderCalls === asserts,
  `render ${renderCalls} / assert ${asserts}`);
add('未展開チェックと実行が同数', asserts === execs,
  `assert ${asserts} / exec ${execs}`);

// --- 3. テンプレートに \ が無いか（あれば r""" が要る） ----------------
const withBackslash = templates.filter((t) => t.includes('\\'));
add('テンプレートにバックスラッシュが無い', withBackslash.length === 0,
  `${withBackslash.length} 個のテンプレート`);

// --- 4. 旧い書き方が残っていないか ------------------------------------
add('@@…@@ 形式のプレースホルダが残っていない',
  !/@@[A-Z_]+@@/.test(table) && !/@@[A-Z_]+@@/.test(udf));
add('IF … RAISE ではなく ASSERT を使っている',
  !/RAISE USING MESSAGE/.test(table));

// --- 4b. WITH の CTE がカンマで区切られているか ------------------------
// 直前の CTE を閉じる ')' の後ろにカンマを置き忘れると構文エラーになる。
// CTE の間に説明コメントを挟んでいるので目視では気づきにくい。
{
  const missing = [];
  for (const [i, t] of templates.entries()) {
    const lines = t.split('\n');
    for (let n = 0; n < lines.length; n++) {
      // 列 0 の 'name AS (' だけを見る＝トップレベルの CTE
      if (!/^[A-Za-z_][A-Za-z0-9_]* AS \($/.test(lines[n])) continue;
      let p = n - 1;
      while (p >= 0 && (lines[p].trim() === '' || lines[p].trim().startsWith('--'))) p--;
      const prev = p >= 0 ? lines[p].trim() : '';
      if (prev === 'WITH' || prev.endsWith(',')) continue;
      missing.push(`テンプレート ${i + 1}: ${lines[n].split(' ')[0]}`);
    }
  }
  add('WITH の CTE がカンマで区切られている', missing.length === 0,
    missing.join(' / '));
}

// --- 5. render_call_sql の書式と引数の数が合うか ----------------------
{
  const m = table.match(/SET render_call_sql = FORMAT\(\n\s*"""([\s\S]*?)""",([\s\S]*?)\);\n/);
  if (!m) {
    add('render_call_sql を読み取れる', false);
  } else {
    const spec = (m[1].match(/%[sT]/g) || []).length;
    // 引数は深さ 0 のカンマで区切る（CAST(… AS STRING) の中は数えない）
    let depth = 0, args = 1;
    for (const ch of m[2]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) args++;
    }
    add('render_call_sql の書式と引数の数が合う', spec === args,
      `%s/%T ${spec} 個 / 引数 ${args} 個`);

    // 関数呼び出しの引数の数（@sql_template + %T の並び）と、
    // 関数定義の引数の数が合うか。
    const callArgs = m[1].split('`(')[1];
    let d = 0, callCount = 1;
    for (const ch of callArgs.slice(0, callArgs.lastIndexOf(')'))) {
      if (ch === '(' || ch === '<') d++;
      else if (ch === ')' || ch === '>') d--;
      else if (ch === ',' && d === 0) callCount++;
    }
    // 関数は 3 つあるので、REPLACE 連鎖を持つ render 関数の塊だけを見る。
    const renderChunk = udf.split('CREATE OR REPLACE FUNCTION')
      .find((c) => c.includes('REPLACE(\n    sql_template,'));
    const def = (renderChunk || '').match(
      /^ `%s\.%s\.%s`\(\n([\s\S]*?)\n\)\nRETURNS STRING\nAS \(/);
    let defCount = 0;
    if (def) {
      let dd = 0;
      defCount = 1;
      for (const ch of def[1]) {
        if (ch === '(' || ch === '<') dd++;
        else if (ch === ')' || ch === '>') dd--;
        else if (ch === ',' && dd === 0) defCount++;
      }
    }
    add('render 関数の引数の数が定義と一致', def !== null && callCount === defCount,
      `呼び出し ${callCount} 個 / 定義 ${defCount} 個`);
  }
}

// --- 5a1. テンプレートの @param が USING で渡されているか -----------------
// テンプレートの中で @x を使ったら、その文の
//   EXECUTE IMMEDIATE rendered_sql USING x AS x
// に x が並んでいなければならない。足りないと BigQuery は
//   Query parameter 'x' not found
// で落ちる。設定を 1 つ足したときに片方だけ直す形で必ず起きるうえ、実行して
// 初めて分かる（しかもセクション 2 は重い）ので静的に見る。
// DECLARE してあるかも一緒に確かめる。
{
  // 「SET sql_template = """…""";」から次の「SET sql_template」までを 1 文とみなす。
  const blocks = [...table.matchAll(
    /^ *SET sql_template = """([\s\S]*?)""";([\s\S]*?)(?=^ *SET sql_template = |\nEND;)/gm)];
  const declared = new Set(
    [...table.matchAll(/^DECLARE ([a-z_][a-z0-9_]*) /gm)].map((m) => m[1]));
  const bad = [];
  for (const [i, b] of blocks.entries()) {
    const params = new Set([...b[1].matchAll(/@([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
    if (!params.size) continue;
    // 本文を組み立てる 1 手目（render_call_sql の USING sql_template）は数えない
    const tail = b[2].replace(/EXECUTE IMMEDIATE render_call_sql[\s\S]*?;/, '');
    const m = tail.match(/EXECUTE IMMEDIATE rendered_sql\s*(?:USING([\s\S]*?))?;/);
    const passed = new Set(
      [...((m && m[1]) || '').matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/g)].map((x) => x[1]));
    for (const p of params) {
      if (!passed.has(p)) bad.push(`${i + 1} 文目: @${p} が USING に無い`);
      if (!declared.has(p)) bad.push(`${i + 1} 文目: ${p} が DECLARE されていない`);
    }
  }
  add('テンプレートの @param が USING で渡されている', bad.length === 0,
    bad.join(' / '));
}

// --- 5a2. JS UDF の呼び出しと定義で引数の数が合うか ---------------------
// 描画は 5 本の UDF に分かれていて、SQL 側からは目印（__UDF_PAGE__ など）で
// 呼ぶ。引数を 1 本足したときに片方だけ直すと、**BigQuery は落ちずに
// 「引数が足りない/多い」で関数が見つからないと言う**か、詰めた位置が
// ずれたまま動く（実際、erd_html を足したときに sql_json の位置へ
// 別の値が入ったことがある）。実行するまで分からないので静的に見る。
{
  const NAMES = {
    udf_analyze_function_name: '__UDF_ANALYZE__',
    udf_render_function_name: '__UDF_RENDER__',
    udf_erd_function_name: '__UDF_ERD__',
    udf_page_function_name: '__UDF_PAGE__',
    udf_markdown_function_name: '__UDF_MARKDOWN__',
  };
  // 深さ 0 のカンマで引数を数える。< > も数えるのは STRUCT<…> のため。
  const countArgs = (s) => {
    let d = 0, n = 1;
    for (const ch of s) {
      if (ch === '(' || ch === '<') d++;
      else if (ch === ')' || ch === '>') d--;
      else if (ch === ',' && d === 0) n++;
    }
    return n;
  };
  // 呼び出し側: `__UDF_X__`( … ) の中身を括弧の対応で切り出す
  const callArgs = (mark) => {
    const out = [];
    const open = '`' + mark + '`(';
    let at = table.indexOf(open);
    while (at >= 0) {
      let d = 0, end = -1;
      for (let i = at + open.length - 1; i < table.length; i++) {
        const ch = table.charAt(i);
        if (ch === '(') d++;
        else if (ch === ')' && --d === 0) { end = i; break; }
      }
      if (end < 0) break;
      out.push(countArgs(table.slice(at + open.length, end)));
      at = table.indexOf(open, end);
    }
    return out;
  };
  // 引数が 1 個の markdown だけ 1 行に書いてある（`(md STRING)`）ので、
  // 改行で割る形と 1 行の形の両方を受ける。
  const defs = [...udf.matchAll(
    /CREATE OR REPLACE FUNCTION `%s\.%s\.%s`\((?:\n)?([\s\S]*?)(?:\n)?\)\nRETURNS STRING\nLANGUAGE js AS %s\n''',\n\s*udf_project_id, udf_dataset, (udf_[a-z_]+_function_name)/g)];
  add('JS UDF の定義を 5 本とも読み取れる', defs.length === 5,
    `見つかった定義 ${defs.length} 本`);
  for (const d of defs) {
    const mark = NAMES[d[2]];
    if (!mark) continue;
    const want = countArgs(d[1]);
    const calls = callArgs(mark);
    add(`${mark} の引数の数が定義と一致`,
      calls.length > 0 && calls.every((n) => n === want),
      `定義 ${want} 個 / 呼び出し [${calls.join(', ')}]`);
  }
}

// --- 5b. CTAS の列リストと SELECT の列が一致するか ---------------------
// 生成は CREATE OR REPLACE TABLE (列リスト) ... AS SELECT で、テーブルごと
// 差し替える。列リストは説明（OPTIONS）を持たせるために書いてあるので、
// SELECT 側に列を足したときに片方だけ直すと BigQuery が「列数が合わない」で
// 落ちる。実行するまで分からないので、ここで並びまで突き合わせる。
{
  const m = table.match(
    /CREATE OR REPLACE TABLE `__T_DIFF_SRC__`\n\(\n([\s\S]*?)\n\)\nCLUSTER BY/);
  const declared = m
    ? m[1].split('\n').map((l) => (l.trim().match(/^([a-z_][a-z0-9_]*)\s/) || [])[1])
      .filter(Boolean)
    : [];
  // 最後の SELECT（… AS diff_html まで）を深さ 0 のカンマで割る
  // 'FROM refs' の直前の SELECT。前方から非貪欲に取るとファイル先頭の別の
  // SELECT に当たるので、切り出してから最後の SELECT を採る。
  const upto = table.slice(0, table.indexOf('\nFROM refs\n'));
  const body = upto.slice(upto.lastIndexOf('\nSELECT\n') + '\nSELECT\n'.length);
  const cols = [];
  {
    // 括弧だけを数える。ここは型を書かないので < > は比較演算子
    // （has_multiple の '> 1'）で、型引数の括弧として数えると深さが狂う。
    let depth = 0, cur = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { cols.push(cur); cur = ''; } else cur += ch;
    }
    cols.push(cur);
  }
  // 別名があればそれ、無ければ末尾の識別子が列名になる
  const selected = cols
    .map((c) => c.split('\n').filter((l) => !l.trim().startsWith('--')).join(' ').trim())
    .filter((c) => c !== '')
    .map((c) => {
      const as = c.match(/\sAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      return as ? as[1] : (c.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/) || [])[1];
    });
  add('CTAS の列リストと SELECT の列が同じ並び',
    declared.length > 0 && declared.join(',') === selected.join(','),
    `列リスト [${declared.join(',')}] / SELECT [${selected.join(',')}]`);
}

// --- 5c. 生成が 1 文で差し替わるか ------------------------------------
// 最新の 1 世代しか持たないので、DELETE + INSERT や TRUNCATE + INSERT に
// 戻すと、その隙間にレポートを開いた人には何も出ない。以前はビューが
// MAX(snapshot_date) を採っていたので隙間があっても前日分が出ていた。
for (const t of ['__T_DIFF_SRC__', '__T_DIFF__']) {
  add(`${t} はテーブルごと差し替える（読み手に空を見せない）`,
    new RegExp(`CREATE OR REPLACE TABLE \`${t}\`[\\s\\S]*?\\nAS\\n(WITH|SELECT)`).test(table) &&
    !new RegExp(`DELETE FROM \`${t}\``).test(table) &&
    !new RegExp(`TRUNCATE TABLE \`${t}\``).test(table) &&
    !new RegExp(`INSERT INTO \`${t}\``).test(table));
}

// --- 5d. メモを繋ぐ書き方が 1 か所か ------------------------------------
// メモを繋ぐのはビューの定義だけ。焼き込み（__T_DIFF__）はそれを SELECT * で
// 写すだけにしておく。同じ SQL を 2 か所に書くと、片方だけ直したときに
// 「レポートには出るがリアルタイムには出ない」ような食い違いが起きる。
{
  const vAt = table.indexOf('CREATE OR REPLACE VIEW `__V_DIFF__`');
  const tAt = table.indexOf('CREATE OR REPLACE TABLE `__T_DIFF__`');
  const splice = table.indexOf("REPLACE(diff_html, '<!--VG_NOTE-->'");
  add('メモを繋ぐのはビューだけ（焼き込みは SELECT * で写す）',
    vAt > 0 && tAt > vAt && splice > vAt && splice < tAt &&
    (table.match(/CREATE OR REPLACE VIEW/g) || []).length === 1 &&
    /CREATE OR REPLACE TABLE `__T_DIFF__`[\s\S]*?\nAS\nSELECT \* FROM `__V_DIFF__`/
      .test(table));
}

// --- 5d2. 確認クエリはテーブルを読む ------------------------------------
// 5 系がビューを読むと、確認 1 本ごとにシート（Drive の外部テーブル）の読み取り・
// Markdown の JS UDF・数 MB の diff_html への REPLACE をやり直す。base と
// group_count しか見ない 5-2 でもそれが走る。3b が直前で焼き込んでいるので
// テーブルを読めば中身は同じで、待ち時間だけが消える。
{
  const at = table.indexOf('-- 5. 確認');
  const sec5 = at > 0 ? table.slice(at) : '';
  add('確認（5 系）はビューではなくテーブルを読む',
    at > 0 && !sec5.includes('__V_DIFF__') && sec5.includes('`__T_DIFF__`'));
}

// --- 5e. STRING_AGG の区切りがリテラルか ------------------------------
// BigQuery は STRING_AGG の第 2 引数（区切り文字）にリテラルかクエリ
// パラメータしか許さない。CHR(10) のような式を書くと
//   Argument 2 to STRING_AGG must be a literal or query parameter
// で落ちる。テンプレートにはバックスラッシュを書けない（= 改行のリテラルを
// 作れない）ので、改行を挟みたいときは ARRAY_TO_STRING を使う。あちらに
// この制限は無い。実行して初めて分かる種類の間違いなので静的に見る。
{
  const bad = [];
  for (const [i, t] of templates.entries()) {
    for (const m of t.matchAll(/STRING_AGG\(/g)) {
      // 第 1 引数を読み飛ばして、深さ 0 のカンマの次を見る
      let depth = 0;
      let j = m.index + m[0].length;
      for (; j < t.length; j++) {
        const ch = t[j];
        if (ch === '(') depth++;
        else if (ch === ')') { if (depth === 0) break; depth--; }
        else if (ch === ',' && depth === 0) { j++; break; }
      }
      const arg2 = t.slice(j).replace(/^\s+/, '');
      // 区切りを省いた STRING_AGG(x) は既定の ',' なので問題ない
      if (arg2 === '' || arg2[0] === ')') continue;
      if (arg2[0] === "'" || arg2[0] === '"' || arg2[0] === '@') continue;
      bad.push(`テンプレート ${i + 1}: ${arg2.slice(0, 40)}`);
    }
  }
  add('STRING_AGG の区切りがリテラルかパラメータ', bad.length === 0,
    bad.join(' / '));
}

// --- 5f. ラベルの取り込み ----------------------------------------------
// ラベルは「揃っているかどうか」を見るためのものなので、取り込み方を間違えると
// 静かに嘘をつく。落ちずに間違った絵を出す 3 通りを静的に止める。
{
  const at = table.indexOf('view_labels AS (');
  const sec = at > 0 ? table.slice(at, table.indexOf('analyzed AS (', at)) : '';

  // (1) 付いていない View を落とすと、8 本に付いていて 1 本だけ無い状態が
  //     「全 View に付いている」と読めてしまう。差そのものが消える。
  add('ラベルは LEFT JOIN で取り込む（付いていない View も 1 組として残す）',
    at > 0 && /LEFT JOIN view_labels AS l ON l\.view_name = k\.view_name/.test(sec));

  // (2) option_value は JSON ではなく [STRUCT("k", "v")] というリテラル風の
  //     文字列。PARSE_JSON で読もうとすると NULL になり、ラベルが 1 つも
  //     付いていないのと同じ見え方（何も出ない）になる。
  add('ラベルは option_value を JSON として読まない（[STRUCT(...)] の形）',
    at > 0 && sec.includes("option_name = 'labels'") &&
    sec.includes('REGEXP_EXTRACT_ALL(option_value') &&
    !/PARSE_JSON\(option_value\)/.test(sec));

  // (3) 既に JSON の文字列を STRUCT に入れて TO_JSON_STRING すると、
  //     文字列として再エスケープされ、描画側の JSON.parse で
  //     配列ではなく文字列になる（＝ラベルが 1 つも読めない）。
  add('ラベルの JSON を二重にエンコードしない（labels_text をそのまま埋める）',
    at > 0 && table.includes(`',"l":', labels_text, '}'`) &&
    !/STRUCT\([^)]*labels_text/.test(table));
}

// --- 5g. 別リージョンのメタデータの混ぜ方 -------------------------------
// import_sources が空なら**いままでとまったく同じ SQL** になり、並べたときだけ
// UNION ALL になる。ここを壊すと、混ぜていないつもりで混ざる／混ぜたつもりで
// 混ざらない、のどちらかが静かに起きる。
{
  const srcs = ['schemata', 'views', 'columns', 'field_paths', 'table_opts'];

  // (1) INFORMATION_SCHEMA の直読みがテンプレートに残っていないか。
  //     残っていると、そこだけ拠点のぶんしか見ない（そのリージョンの View が
  //     カードから消えるが、辻褄は合うので画面から気づけない）。
  //     5 系（確認クエリ）は拠点だけを見る診断なので対象外。
  const at5 = table.indexOf('-- 5. 確認');
  const head = at5 > 0 ? table.slice(0, at5) : table;
  const direct = [...head.matchAll(
    /region-__JOB_REGION__\.INFORMATION_SCHEMA\.([A-Z_]+)/g)].map((m) => m[1]);
  add('解析の読み元に INFORMATION_SCHEMA の直読みが残っていない',
    direct.length === 0, direct.join(','));

  // (2) 5 つの読み元がすべて使われているか。
  const unused = srcs.filter((k) => !head.includes(`__SRC_${k.toUpperCase()}__`));
  add('5 つの読み元がすべてテンプレートで使われている',
    unused.length === 0, unused.join(','));

  // (3) 空なら従来どおり、並べたら UNION ALL。両方の枝があるか。
  const bad = srcs.filter((k) => {
    const at = table.indexOf(`SET src_${k} =`);
    if (at < 0) return true;
    const body = table.slice(at, table.indexOf('AS g));', at));
    return !body.includes('IF(ARRAY_LENGTH(import_sources) = 0,') ||
      !body.includes('UNION ALL');
  });
  add('読み元は「空なら従来どおり・並べたら UNION ALL」の 2 枝',
    bad.length === 0, bad.join(','));

  // (3b) 空のときの枝が**リージョン修飾の INFORMATION_SCHEMA そのもの**か。
  //      ここに余計なものが混ざると、import_sources を空にしても
  //      「足す前とまったく同じ」ではなくなる。取り込みテーブルを 1 か所も
  //      参照しないからこそ、テーブルが存在しなくても流せる。
  const IS = { schemata: 'SCHEMATA', views: 'VIEWS', columns: 'COLUMNS',
    field_paths: 'COLUMN_FIELD_PATHS', table_opts: 'TABLE_OPTIONS' };
  const plain = srcs.filter((k) => !new RegExp(
    `SET src_${k} = IF\\(ARRAY_LENGTH\\(import_sources\\) = 0,\\s*\\n\\s*` +
    `FORMAT\\('\`%s\\.region-%s\\.INFORMATION_SCHEMA\\.${IS[k]}\`', ` +
    `target_project_id, job_region\\),`).test(table));
  add('空のときの読み元が INFORMATION_SCHEMA そのもの（従来と同一）',
    plain.length === 0, plain.join(','));

  // (3c) 取り込みテーブルの名前を組み立てている箇所が、想定の 2 か所だけか。
  //      増えると、空判定の外から参照される余地が生まれる（＝空にしても
  //      「そんなテーブルは無い」で落ちる）。名前の組み立ては
  //        ・SET src_*        … 'meta_<種類>' || g.sfx（空判定の内側）
  //        ・取り込みの確認   … 'meta_views'  || s.table_name_suffix
  //                            （IF ARRAY_LENGTH(import_sources) > 0 の内側）
  //      の 2 形しかない。ほかの形が出たら、どこから参照されるか確かめる。
  {
    const shapes = [...table.matchAll(/'meta_[a-z_]+' \|\| ([A-Za-z_.]+)/g)]
      .map((m) => m[1]);
    const unexpected = shapes.filter((v) => v !== 'g.sfx' && v !== 's.table_name_suffix');
    const bySfx = shapes.filter((v) => v === 'g.sfx').length;
    const byTail = shapes.filter((v) => v === 's.table_name_suffix').length;
    // 確認の 1 か所は IF ブロックの内側にあること
    const at = table.indexOf('IF ARRAY_LENGTH(import_sources) > 0 THEN');
    const end = table.indexOf('END IF;', at);
    const tailAt = table.indexOf("'meta_views' || s.table_name_suffix");
    add('取り込みテーブルの参照が想定の 2 形だけ（空にしても参照されない）',
      unexpected.length === 0 && bySfx === srcs.length && byTail === 1 &&
      at > 0 && tailAt > at && tailAt < end,
      unexpected.length ? `想定外: ${unexpected.join(',')}`
        : `g.sfx ${bySfx} 個 / s.table_name_suffix ${byTail} 個`);
  }

  // (4) 運んできたテーブルは**送り元ごとに分かれうる**。
  //     cross_region_import.sql の table_name_suffix に送り元を表す値
  //     （'_sgp' など）を付ける運用ができるので、import_sources の suffix
  //     ごとに枝を出す。1 本決め打ちにすると、2 つ目の送り元が黙って
  //     解析から落ちる（辻褄は合うので画面から気づけない）。
  const fan = srcs.filter((k) => {
    const at = table.indexOf(`SET src_${k} =`);
    const body = at < 0 ? '' : table.slice(at, table.indexOf('AS g));', at));
    return !body.includes('STRING_AGG(') ||
      !body.includes('GROUP BY table_name_suffix') ||
      !body.includes("|| g.sfx");
  });
  add('読み元が送り元ごとのテーブルに枝分かれする', fan.length === 0,
    fan.join(','));

  // (5) 運んできた側を source_region で絞っているか。
  //     絞らないと、import_sources から外したリージョンや、誤って拠点で
  //     書き出した自分のぶんまで解析に入る（＝二重計上）。
  const n = (table.match(/WHERE source_region IN UNNEST\(%T\)/g) || []).length;
  add('運んできた側を source_region で絞っている（5 か所）', n === srcs.length,
    `${n} か所`);

  // (6) テーブル名を変数と規則で組み立てているか。
  //     リテラルで書くと prefix / suffix が効かない。prefix が空の環境では
  //     動いてしまい、リージョンの略称を入れた環境でだけ落ちる。
  const lit = srcs.filter((k) => !new RegExp(
    `table_name_prefix \\|\\| system_name \\|\\| '_' \\|\\| 't_' \\|\\| 'meta_${k}' \\|\\| g\\.sfx`
  ).test(table));
  add('読み元の名前が命名規則どおり組み立てられている（prefix が効く）',
    lit.length === 0, lit.join(','));

  // (7) 拠点自身を並べていないか／同じ送り元を 2 回並べていないか。
  add('拠点自身を import_sources に入れられない',
    /ASSERT job_region NOT IN \(SELECT source_region FROM UNNEST\(import_sources\)\)/
      .test(table));
  add('同じ送り元を 2 回並べられない',
    /ASSERT ARRAY_LENGTH\(import_sources\) = ARRAY_LENGTH\(\s*\n?\s*ARRAY\(SELECT DISTINCT source_region FROM UNNEST\(import_sources\)\)\)/
      .test(table));

  // (8) 並べた送り元の行が無いまま通さないか。
  //     取り込みが落ちても build_table は動くので、ここが最後の砦になる。
  // 止め方は ASSERT ではなく ERROR()。ASSERT の説明文は文字列リテラルしか
  // 書けず、「どのテーブルの、どの source_region を探したか」を埋め込めない。
  // それが無いと、書き方違い／suffix の食い違い／取り込み未実行 のどれかを
  // 落ちた人が自分で切り分けることになる（実際にそうなった）。
  add('並べた送り元の行が無ければ止まる（探したものと実際にあったものを出す）',
    /INTO import_diag;/.test(table) &&
    /IF import_diag IS NOT NULL THEN\s*\n\s*SELECT ERROR\(/.test(table) &&
    // 期待した source_region と、そのテーブルに実際にある値の両方を出す
    /source_region = %%s の行がありません（そのテーブルにあるのは: %%s）/.test(table) &&
    /STRING_AGG\(DISTINCT source_region/.test(table));
}

// --- 5h. 基準を行に分ける ------------------------------------------------
// 全基準を 1 枚のカードに載せると比較ペインは G×(G−1) 枚 ―― **グループ数の
// 二乗**になる。リージョンをまたいで G が伸びたとき、UDF のメモリを使い切って
// 日次の生成ごと落ちた。基準を行に分けると 1 行 G−1 枚の線形に戻る。
// ここが戻ると同じ落ち方をするので、形を固定する。
{
  // (1) 基準ごとに行を立てているか。
  add('基準ごとに行を立てている（1 行 1 基準）',
    /CROSS JOIN UNNEST\(\s*\n\s*IF\(ARRAY_LENGTH\(JSON_VALUE_ARRAY\(a\.analysis, '\$\.groupLabels'\)\) = 0,/
      .test(table) &&
    /\) AS lbl WITH OFFSET AS off/.test(table) &&
    /g\.off AS ref_index/.test(table) && /g\.lbl AS ref_label/.test(table));

  // (2) グループが 0 件の base でも行が消えないか。
  //     空の配列を CROSS JOIN で展開すると base ごと落ちて、**カードが黙って
  //     消える**（解析できなかった base ほど見たいのに）。
  add('グループが 0 件でも base の行が消えない',
    /\[CAST\(NULL AS STRING\)\],/.test(table));

  // (3) 描画に基準を渡しているか。渡さないと全部が先頭基準のカードになる
  //     （落ちないので気づけない）。
  add('描画に基準の番号を渡している',
    /`__UDF_RENDER__`\(analysis, options_json, CAST\(ref_index AS FLOAT64\)\)/
      .test(table));

  // (4) 行数の上限があり、**それを描画側にも渡している**か。
  //     渡さないと、打ち切られたことをカードに書けない ―― 選べないだけなのに
  //     「グループが無い」と読めてしまう。
  add('基準の行数に上限があり、描画側にも渡している',
    /WHERE g\.off < @max_ref_rows/.test(table) &&
    /'.?"maxRefRows":', CAST\(@max_ref_rows AS STRING\)/.test(table) &&
    /^DECLARE max_ref_rows INT64 DEFAULT \d+;$/m.test(table));
}

// --- 6. 両ファイルで一致させる必要がある値 -----------------------------
for (const base of ['analyze', 'render', 'erd', 'page', 'markdown', 'group_css',
  'render_dynamic_sql']) {
  const line = `udf_name_prefix || system_name || '_' || '${base}' || udf_name_suffix`;
  add(`${base} の名前の組み立てが両ファイルで同じ`,
    table.includes(line) && udf.includes(line));
}

// system_name が食い違うと関数が見つからない。既定値まで突き合わせる。
{
  const re = /^DECLARE system_name STRING DEFAULT '([^']*)';$/m;
  const t = table.match(re), u = udf.match(re);
  add('system_name の既定値が両ファイルで同じ',
    t !== null && u !== null && t[1] === u[1],
    `build_table=${t ? t[1] : 'なし'} / view_group_html=${u ? u[1] : 'なし'}`);
}

// メモの差し込み口。カードは作り置き、メモはビューで毎回作るので、
// 外枠に置いた目印をビューが REPLACE で差し替えている。文字列が食い違うと
// 置換が起きず、メモ タブが黙って空になる（エラーにはならない）。
{
  const m = chrome.match(/^const NOTE_MARK = '([^']+)';$/m);
  const mark = m ? m[1] : null;
  // ビューは 1 本。目印が食い違うと置換が起きず、メモ タブが黙って空になる。
  const used = mark ? table.split(`REPLACE(diff_html, '${mark}'`).length - 1 : 0;
  add('メモの目印が chrome.js とビューで同じ', mark !== null && used === 1,
    `chrome.js=${mark || 'なし'} / build_table.sql での使用 ${used} 回`);
}

// 'viewlgc' を直に書いた組み立てが残っていないか（system_name の付け忘れ）
for (const [name, src] of [['build_table.sql', table], ['view_group_html.sql', udf]]) {
  add(`${name} に 'viewlgc_' のリテラル連結が残っていない`,
    !/\|\|\s*'viewlgc_?'/.test(src));
}

// --- 結果 --------------------------------------------------------------
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  … ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
