"use strict";

/*
 * src/html/usage_sql_html.js から、01 の UDF 定義ブロックを生成して差し込む。
 *
 *   node scripts/build_usage_html_udf.js          -> 01 の生成ブロックを更新
 *   node scripts/build_usage_html_udf.js --check  -> 差し込まず、整合だけ検査
 *
 * 15KB の JS を手で 01 へコピーすると src/ 側の更新に追従できないので生成にしている。
 * 01 のうち書き換えるのは番兵コメントで挟まれた範囲だけで、それ以外は触らない。
 *
 * BigQuery 側の制約:
 *   - インラインのコード ブロブは 32KB が上限。余裕を見て 30KB で失敗させる。
 *   - JS 本体は raw string リテラルで渡す。よって JS に ''' と """ を含められない。
 *   - JS には `width:100%` のように % が含まれるため、FORMAT のテンプレートに
 *     直接埋め込んではならない（書式指定子と誤読される）。引数として渡せば安全。
 */

const fs = require("fs");
const path = require("path");

const javascriptDir = path.resolve(__dirname, "..");
const sourcePath = path.join(javascriptDir, "src", "html", "usage_sql_html.js");
const setupSqlPath = path.resolve(
  javascriptDir, "..", "sql", "setup", "01_setup_lineage_environment.sql"
);

const BEGIN_MARK = "-- BEGIN GENERATED: usage SQL HTML UDF (build_usage_html_udf.js)";
const END_MARK = "-- END GENERATED: usage SQL HTML UDF";
const SIZE_LIMIT = 30 * 1024;

/** CommonJS の体裁を落として、UDF 本体に置ける素の関数群にする。 */
function toUdfBody(source) {
  const stripped = source
    .replace(/^"use strict";\s*$/m, "")
    .replace(/^module\.exports\s*=\s*\{[\s\S]*?\};\s*$/m, "")
    .trim();

  if (/\brequire\s*\(/.test(stripped) || /\bmodule\.exports\b/.test(stripped)) {
    throw new Error("require / module.exports が残っています");
  }
  if (stripped.includes("'''") || stripped.includes('"""')) {
    throw new Error("JS に ''' または \"\"\" が含まれており raw string を壊します");
  }
  if (Buffer.byteLength(stripped, "utf8") > SIZE_LIMIT) {
    throw new Error(
      `JS が ${Buffer.byteLength(stripped, "utf8")} バイトで上限 ${SIZE_LIMIT} を超えています`
    );
  }

  return stripped;
}

function buildBlock(udfBody) {
  return [
    BEGIN_MARK,
    "-- このブロックは自動生成です。直接編集せず、src/html/usage_sql_html.js を直して",
    "-- `node scripts/build_usage_html_udf.js` で作り直すこと。",
    "--",
    "-- 使用箇所つき SQL を HTML にして返す UDF。Looker Studio の Templated Record に",
    "-- HTML カラムとして渡す用途。GCS も外部ライブラリも使わない自己完結の関数なので、",
    "-- エンジン バンドル (lineage_udf_bundle.js) とは無関係で再デプロイも不要。",
    "--",
    "-- LNGE_USAGE_SQL_HTML(sql_text, highlights, options_json)",
    "--   sql_text     対象オブジェクトの SQL 本文",
    "--   highlights   'line:column:length' の配列。重複と重なりは関数側で畳む",
    "--   options_json 表示オプション。NULL / '{}' で既定",
    "--     mode         'embed'(既定) <style> 同梱で自己完結 / 'class' markup のみ",
    "--                  (CSS は LNGE_USAGE_SQL_CSS() をテンプレートに貼る。最小) /",
    "--                  'inline' すべてインライン CSS",
    "--     contextLines 該当行の前後 N 行だけ描画（既定は指定なし＝全文）",
    "--     maxLines     描画する最大行数（既定 5000）",
    "--     fontSize / lineHeight / colors.* / syntax.*",
    "--",
    "-- LNGE_USAGE_SQL_CSS(options_json)",
    "--   mode='class' のときテンプレートに貼る CSS。色を変えたら同じ options_json を",
    "--   渡して作り直すこと（markup と CSS は同じコードから作られるので食い違わない）。",
    "-- 変数はスクリプト先頭の [C] で DECLARE 済み（BigQuery は DECLARE を",
    "-- 最初の文より前に置く必要があるため、ここでは SET だけを行う）。",
    "SET usage_html_udf_js = r'''",
    udfBody,
    "''';",
    "",
    "EXECUTE IMMEDIATE FORMAT(",
    "  'CREATE OR REPLACE FUNCTION `%s.%s`('",
    "  || 'sql_text STRING, highlights ARRAY<STRING>, options_json STRING'",
    "  || ') RETURNS STRING LANGUAGE js AS r\"\"\"%s',",
    "  repository_dataset_full_name,",
    "  udf_usage_sql_html,",
    "  usage_html_udf_js || '\\nreturn renderUsageSqlHtml(sql_text, highlights, options_json);\\n\"\"\"'",
    ");",
    "",
    "EXECUTE IMMEDIATE FORMAT(",
    "  'CREATE OR REPLACE FUNCTION `%s.%s`(options_json STRING)'",
    "  || ' RETURNS STRING LANGUAGE js AS r\"\"\"%s',",
    "  repository_dataset_full_name,",
    "  udf_usage_sql_css,",
    "  usage_html_udf_js || '\\nreturn buildUsageSqlCss(options_json);\\n\"\"\"'",
    ");",
    END_MARK
  ].join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const source = fs.readFileSync(sourcePath, "utf8");
  const udfBody = toUdfBody(source);
  const block = buildBlock(udfBody);

  const sql = fs.readFileSync(setupSqlPath, "utf8");
  const beginIndex = sql.indexOf(BEGIN_MARK);
  const endIndex = sql.indexOf(END_MARK);

  if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) {
    throw new Error(
      `01 に番兵コメントが見つかりません。次の2行が必要です:\n${BEGIN_MARK}\n${END_MARK}`
    );
  }

  const next = sql.slice(0, beginIndex) + block + sql.slice(endIndex + END_MARK.length);

  if (check) {
    const same = next === sql;
    console.log(JSON.stringify({
      check: "usage SQL HTML UDF block is in sync with src/html/usage_sql_html.js",
      status: same ? "PASS" : "STALE",
      udf_js_bytes: Buffer.byteLength(udfBody, "utf8"),
      size_limit: SIZE_LIMIT
    }, null, 2));
    if (!same) process.exit(1);
    return;
  }

  fs.writeFileSync(setupSqlPath, next, "utf8");
  console.log(JSON.stringify({
    generated: path.relative(path.resolve(javascriptDir, ".."), setupSqlPath),
    udf_js_bytes: Buffer.byteLength(udfBody, "utf8"),
    size_limit: SIZE_LIMIT
  }, null, 2));
}

main();
