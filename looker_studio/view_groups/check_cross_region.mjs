#!/usr/bin/env node
'use strict';
/**
 * cross_region_export.sql / cross_region_import.sql の静的チェック。
 *
 * この 2 本は BigQuery でしか動かせない（手元に BigQuery が無い）。しかも
 * 動的 SQL なので、**間違いのほとんどは実行して初めて分かる形**で出る。
 * とくに FORMAT の書式指定と引数の数の食い違いは、貼って流した瞬間に
 * 落ちるだけで、原因は「引数が足りません」としか出ない。
 *
 * ここで見るのは、目で数えると必ず間違える種類のものだけ。
 *   ・FORMAT の %s / %T / %d の数と引数の数
 *   ・書き出す種類と読み込む種類の一致
 *   ・書き出す列が、build_table.sql が実際に読む列を満たしているか
 *
 * check_sql.mjs と同じ考え方（実行して初めて分かる間違いを静的に止める）。
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exp = await readFile(join(here, 'cross_region_export.sql'), 'utf8');
const imp = await readFile(join(here, 'cross_region_import.sql'), 'utf8');
const table = await readFile(join(here, 'build_table.sql'), 'utf8');

const checks = [];
const add = (name, ok, detail) => checks.push([name, ok, detail]);

/**
 * FORMAT( … ) を 1 つずつ取り出す。括弧の対応を数えるだけの素朴なもので、
 * 文字列の中の括弧も数えてしまうと壊れるので、引用符の中は読み飛ばす。
 * 三重引用符（"""）は BigQuery の raw な複数行文字列。
 */
function formatCalls(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    // **文字列の中の FORMAT( は見ない。** テンプレートの中に書いた
    // FORMAT（実行時に組み立てられる側の SQL）まで数えると、%% で逃がした
    // 書式指定を「0 個」と読んで必ず食い違う。ここで飛ばすのは検査対象の
    // 選別であって、飛ばした中身は生成後の SQL として BigQuery が見る。
    const skip3 = src.startsWith('"""', i) ? '"""'
      : src.startsWith("'''", i) ? "'''" : null;
    if (skip3) {
      const end = src.indexOf(skip3, i + 3);
      i = (end < 0 ? src.length : end + 3) - 1;
      continue;
    }
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let k = i + 1;
      while (k < src.length && src[k] !== q) k += src[k] === '\\' ? 2 : 1;
      i = k;
      continue;
    }
    if (!src.startsWith('FORMAT(', i)) continue;
    // FORMAT_TIMESTAMP など、別の関数の頭に当たらないようにする
    if (i > 0 && /[A-Za-z0-9_]/.test(src[i - 1])) continue;
    let j = i + 'FORMAT('.length;
    let depth = 1;
    const start = j;
    while (j < src.length && depth > 0) {
      // 引用符の中は丸ごと飛ばす
      const q3 = src.startsWith('"""', j) ? '"""'
        : src.startsWith("'''", j) ? "'''" : null;
      if (q3) {
        const end = src.indexOf(q3, j + 3);
        j = end < 0 ? src.length : end + 3;
        continue;
      }
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j];
        j++;
        while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
        j++;
        continue;
      }
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      j++;
    }
    out.push({ at: i, body: src.slice(start, j - 1) });
  }
  return out;
}

/** 深さ 0 のカンマで割る。引用符と括弧の中のカンマは割らない。 */
function topLevelSplit(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let j = 0; j < body.length; j++) {
    const q3 = body.startsWith('"""', j) ? '"""'
      : body.startsWith("'''", j) ? "'''" : null;
    if (q3) {
      const end = body.indexOf(q3, j + 3);
      const stop = end < 0 ? body.length : end + 3;
      cur += body.slice(j, stop);
      j = stop - 1;
      continue;
    }
    if (body[j] === '"' || body[j] === "'") {
      const q = body[j];
      let k = j + 1;
      while (k < body.length && body[k] !== q) k += body[k] === '\\' ? 2 : 1;
      cur += body.slice(j, k + 1);
      j = k;
      continue;
    }
    if (body[j] === '(' || body[j] === '[') depth++;
    else if (body[j] === ')' || body[j] === ']') depth--;
    if (body[j] === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += body[j];
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map((s) => s.trim());
}

/** 書式指定の数。%% は逃がしてある（1 つの % として出る）ので先に消す。 */
function specCount(lit) {
  return (lit.replace(/%%/g, '').match(/%[sTdt]/g) || []).length;
}

/** リテラルの中身を取り出す。リテラルでなければ null。 */
function literalBody(s) {
  let m = s.match(/^"""([\s\S]*)"""$/) || s.match(/^'''([\s\S]*)'''$/);
  if (m) return m[1];
  m = s.match(/^"([\s\S]*)"$/) || s.match(/^'([\s\S]*)'$/);
  return m ? m[1] : null;
}

// --- 1. FORMAT の書式指定と引数の数 ------------------------------------
// 第 1 引数がリテラルでないもの（FORMAT(export_stmt, …) など）は、
// その変数の DECLARE を引いて中身を使う。
for (const [name, src] of [['cross_region_export.sql', exp],
  ['cross_region_import.sql', imp]]) {
  const bad = [];
  let n = 0;
  for (const call of formatCalls(src)) {
    const parts = topLevelSplit(call.body);
    if (parts.length === 0) continue;
    let lit = literalBody(parts[0]);
    if (lit === null) {
      // DECLARE <名前> STRING DEFAULT "…"; を引く
      const m = src.match(new RegExp(
        `DECLARE\\s+${parts[0]}\\s+STRING\\s+DEFAULT\\s*("[\\s\\S]*?"|'[\\s\\S]*?');`));
      if (!m) continue;             // 追えないものは見ない（誤検知を作らない）
      lit = literalBody(m[1]);
      if (lit === null) continue;
    }
    n++;
    const want = specCount(lit);
    const got = parts.length - 1;
    if (want !== got) {
      const line = src.slice(0, call.at).split('\n').length;
      bad.push(`${line} 行目: 書式 ${want} 個に対して引数 ${got} 個`);
    }
  }
  add(`${name}: FORMAT の書式指定と引数の数が合う（${n} 箇所）`,
    bad.length === 0, bad.join(' / '));
}

// --- 2. 書き出す種類と読み込む種類が一致するか -------------------------
// 片方だけ足すと、書き出したのに読まれない（静かに欠ける）か、
// 無いファイルを読もうとして落ちるかのどちらかになる。
{
  // 5 本は parts のループで、マニフェストだけループの後で書き出す。
  const pm = exp.match(/SET parts = \[([\s\S]*?)\n\];/);
  const exported = pm
    ? [...pm[1].matchAll(/STRUCT\('([a-z_]+)'/g)].map((m) => m[1]) : [];
  const manifestAt = exp.indexOf("job_region, 'manifest'");
  if (manifestAt > 0) exported.push('manifest');
  const km = imp.match(/DECLARE kinds ARRAY<STRING> DEFAULT\s*\n?\s*\[([^\]]*)\]/);
  const imported = km ? [...km[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
  add('書き出す種類と読み込む種類が一致する',
    exported.length > 0 && imported.length > 0 &&
    exported.slice().sort().join(',') === imported.slice().sort().join(','),
    `export=${exported.join(',')} / import=${imported.join(',')}`);
  // マニフェストは最後に書く。途中まで届いた状態を拾うための順序。
  add('マニフェストは最後に書き出す（欠けた状態を拾えるように）',
    manifestAt > exp.indexOf('END WHILE;'), `manifest の位置=${manifestAt}`);
}

// --- 2b. INFORMATION_SCHEMA を直に書き出していないか --------------------
// **EXPORT DATA は INFORMATION_SCHEMA を参照できない**（実環境で確認）。
// いったん普通のテーブルに落としてから書き出す 2 段構えでなければならない。
// 戻すと「メタデータのテーブルは参照できない」で落ちる。
{
  add('EXPORT DATA は中継テーブルを読む（INFORMATION_SCHEMA を直に読まない）',
    /"EXPORT DATA OPTIONS\([^"]*\) AS SELECT \* FROM `%s`"/.test(exp) &&
    /"CREATE OR REPLACE TABLE `%s` AS %s"/.test(exp) &&
    // ループの中で CTAS → EXPORT の順に流す
    exp.indexOf('FORMAT(ctas_stmt') < exp.indexOf('FORMAT(export_stmt'));
}

// --- 3. 書き出す列が、拠点側が読む列を満たしているか --------------------
// 列を落とすと、拠点側は「その View には無い」と読んで黙って通す。
// build_table.sql の該当 CTE が使っている列を並べ、書き出しの SELECT に
// 出ているかを見る。ここが上流なので、下流だけ直しても届かない。
{
  const need = {
    sql_schemata: ['schema_name'],
    sql_views: ['table_schema', 'table_name', 'view_definition'],
    sql_columns: ['table_schema', 'table_name', 'column_name', 'ordinal_position',
      'data_type', 'is_nullable'],
    sql_field_paths: ['table_schema', 'table_name', 'column_name', 'field_path',
      'data_type', 'description'],
    sql_table_opts: ['table_schema', 'table_name', 'option_name', 'option_value'],
  };
  const missing = [];
  for (const [v, cols] of Object.entries(need)) {
    const m = exp.match(new RegExp(`SET ${v} = FORMAT\\("""([\\s\\S]*?)"""`));
    if (!m) { missing.push(`${v} が見つかりません`); continue; }
    for (const c of cols) {
      if (!new RegExp(`\\b${c}\\b`).test(m[1])) missing.push(`${v}: ${c}`);
    }
  }
  add('書き出す列が build_table.sql の読む列を満たす', missing.length === 0,
    missing.join(' / '));
}

// --- 4. 拠点自身を送り元に入れていないか -------------------------------
// 入れると同じ行が 2 回入る（拠点のぶんは build_table.sql が直接読む）。
// 既定値の時点で間違えていないかだけ見る。実行時は ASSERT が見る。
{
  const hub = imp.match(/^SET @@location = '([^']+)';$/m);
  const srcs = imp.match(/DECLARE sources ARRAY<STRUCT<source_region STRING, gcs_prefix STRING>> DEFAULT \[([\s\S]*?)\n\];/);
  const list = srcs
    ? [...srcs[1].matchAll(/STRUCT\('([^']+)' AS source_region/g)].map((m) => m[1])
    : [];
  add('既定の sources に拠点自身が入っていない',
    hub !== null && list.length > 0 && !list.includes(hub[1]),
    `拠点=${hub ? hub[1] : 'なし'} / sources=${list.join(',')}`);
  add('書き出し側と読み込み側でリージョンが食い違っていない',
    hub !== null && list.includes((exp.match(/^SET @@location = '([^']+)';$/m) || [])[1]),
    `export=${(exp.match(/^SET @@location = '([^']+)';$/m) || [])[1]} / import の sources=${list.join(',')}`);
  // バケットは送り元ごとに引く。1 本の変数に固定すると、送り元のバケットを
  // 直に読む形（コピーを挟まない形）が書けなくなる。
  add('読み込み元のバケットを送り元ごとに持てる',
    /FORMAT\('%s\/%s\/%s-\*\.avro', s\.gcs_prefix, s\.source_region, kind\)/.test(imp) &&
    !/gcs_import_prefix/.test(imp));
}

// --- 5. 時刻を文字列で運んでいるか -------------------------------------
// TIMESTAMP のまま avro にすると論理型で書かれ、読み込み側が
// use_avro_logical_types を付けないと INT64（マイクロ秒）で戻る。
// **落ちずに比較だけが狂う**ので、往復の仕方に依存しない形にしておく。
{
  add('マニフェストの時刻を STRING で運ぶ（avro の論理型に依存しない）',
    exp.includes('AS collected_at_iso') &&
    /FORMAT_TIMESTAMP\('%Y-%m-%dT%H:%M:%SZ', CURRENT_TIMESTAMP\(\)\)/.test(exp) &&
    imp.includes("PARSE_TIMESTAMP('%%Y-%%m-%%dT%%H:%%M:%%SZ', collected_at_iso)"));
}

// --- 6. 件数の突き合わせが素通りしないか -------------------------------
// 内部結合にすると、ある種類が丸ごと空だったとき実測側に行が立たず、
// 突き合わせる相手が消えて素通りする。いちばん防ぎたい壊れ方がそれ。
{
  add('件数の突き合わせが FULL OUTER JOIN（丸ごと空を素通りさせない）',
    imp.includes('FULL OUTER JOIN') &&
    imp.includes('COALESCE(m.n_rows, 0) != COALESCE(t.actual, 0)'));
}

// --- 7. バケットの取り違えを実行時に止めているか -----------------------
// 書き出し側と読み込み側でバケットのロケーションが違う（同じにできない）。
// 既定値のまま流すと、他人のバケットや存在しないパスに書きに行く。
add('cross_region_export.sql: バケットの既定値のままでは流せない',
  /ASSERT NOT STARTS_WITH\(gcs_export_prefix, 'gs:\/\/CHANGE-ME'\)/.test(exp) &&
  /DECLARE gcs_export_prefix STRING DEFAULT 'gs:\/\/CHANGE-ME/.test(exp));
add('cross_region_import.sql: バケットの既定値のままでは流せない',
  /WHERE STARTS_WITH\(s\.gcs_prefix, 'gs:\/\/CHANGE-ME'\)/.test(imp) &&
  /'gs:\/\/CHANGE-ME[^']*' AS gcs_prefix/.test(imp));

// --- 8. テンプレートにバックスラッシュが無いか --------------------------
// check_sql.mjs と同じ理由。"""…""" は raw な文字列なので、
// バックスラッシュはエスケープとして読まれずそのまま残り、SQL を壊す。
for (const [name, src] of [['cross_region_export.sql', exp],
  ['cross_region_import.sql', imp]]) {
  const tpl = [...src.matchAll(/"""([\s\S]*?)"""/g)].map((m) => m[1]);
  add(`${name}: テンプレートにバックスラッシュが無い`,
    tpl.every((t) => !t.includes('\\')), `${tpl.length} 個中`);
}

// --- 9. build_table.sql との命名の食い違い ------------------------------
// 取り込んだテーブルを拠点側が引くので、名前の組み立て方が食い違うと
// 「見つからない」で落ちる。system_name の既定値だけでも突き合わせておく。
{
  const re = /^DECLARE system_name STRING DEFAULT '([^']*)';$/m;
  const t = table.match(re), i = imp.match(re), e = exp.match(re);
  add('system_name の既定値が 3 ファイルで同じ',
    t !== null && i !== null && e !== null && t[1] === i[1] && t[1] === e[1],
    `build_table=${t ? t[1] : 'なし'} / export=${e ? e[1] : 'なし'} / import=${i ? i[1] : 'なし'}`);
}

// prefix / suffix に書いた '{project_token}' は、プロジェクト ID から
// 切り出したトークンに置き換わる。**この置換を持っていないファイルがあると、
// build_table.sql から prefix をそのまま持ってきたときに
// '{project_token}_viewlgc_…' というテーブルを作りに行って落ちる。**
// 切り出し方が食い違えば、落ちずに別の名前のテーブルを見に行く（もっと悪い）。
{
  const re = /^DECLARE project_token_pattern STRING DEFAULT (r'[^']*');$/m;
  const t = table.match(re), i = imp.match(re), e = exp.match(re);
  add('project_token_pattern の既定値が 3 ファイルで同じ',
    t !== null && i !== null && e !== null && t[1] === i[1] && t[1] === e[1],
    `build_table=${t ? t[1] : 'なし'} / export=${e ? e[1] : 'なし'} / import=${i ? i[1] : 'なし'}`);

  for (const [name, src] of [['cross_region_export.sql', exp],
    ['cross_region_import.sql', imp]]) {
    const need = ['work_dataset', 'table_name_prefix', 'table_name_suffix'];
    const missing = need.filter((v) =>
      !new RegExp(`SET ${v}\\s*= REPLACE\\(${v},\\s*'\\{project_token\\}'`).test(src));
    add(`${name}: '{project_token}' を置き換えている`, missing.length === 0,
      missing.join(' / '));
  }
}

// --- 結果 --------------------------------------------------------------
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  … ${detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
