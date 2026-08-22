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

const checks = [];
const add = (name, ok, detail) => checks.push([name, ok, detail]);

// --- テンプレートを取り出す -------------------------------------------
// SET sql_template = """ … """; の中身。
// コメント行（-- で始まる例示）は数えない。
const templates = [...table.matchAll(/^SET sql_template = """([\s\S]*?)""";/gm)]
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
  /^EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;/gm) || []).length;
const asserts = (table.match(
  /^ASSERT NOT REGEXP_CONTAINS\(rendered_sql, r'__\[A-Z0-9_\]\+__'\) AS/gm) || []).length;
const execs = (table.match(/^EXECUTE IMMEDIATE rendered_sql/gm) || []).length;
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

// --- 6. 両ファイルで一致させる必要がある値 -----------------------------
for (const base of ['group_info', 'group_css', 'render_dynamic_sql']) {
  const line = `udf_name_prefix || 'viewlgc_' || '${base}' || udf_name_suffix`;
  add(`${base} の名前の組み立てが両ファイルで同じ`,
    table.includes(line) && udf.includes(line));
}

// --- 結果 --------------------------------------------------------------
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  … ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
