// suffix_config.json から build_table.sql を生成する。
//
//   node build_table.mjs
//
// suffix 規則は SQL 側（base の切り出し）と UDF 側（options_json）の両方で必要になる。
// 手で 2 箇所書くとズレて base の束ね方と解析が食い違うので、1 つの設定から両方を作る。
//
// suffixSource: "schemata" なら suffix 一覧を持たず、データセット名から実行時に
// 取り出す（手運用なし）。この場合 base は動的な正規表現ではなく ENDS_WITH の
// 結合で切る。BigQuery の REGEXP_* はパターンを定数で要求しうるため。
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const A = require(join(here, 'analyze.js'));

const raw = JSON.parse(await readFile(join(here, 'suffix_config.json'), 'utf8'));
// _ で始まるキーは説明用。UDF には渡さない。
const config = Object.fromEntries(
  Object.entries(raw).filter(([k]) => !k.startsWith('_'))
);

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 設定から「base を取り出す BigQuery の正規表現」を作る。
 * analyze.js の抽出規則と同じ意味になるようにする。
 */
function baseRegex(c) {
  if (Array.isArray(c.suffixParts) && c.suffixParts.length > 0) {
    const groups = c.suffixParts
      .map((part) => `(?:${part.map(reEscape).join('|')})`)
      .join('');
    return `^(.*)_${groups}$`;
  }
  if (Array.isArray(c.suffixList) && c.suffixList.length > 0) {
    // 長いものを先に並べる（短い suffix が長い suffix の前半に一致する場合の対策）
    const alts = c.suffixList.slice()
      .sort((a, b) => b.length - a.length || a.localeCompare(b))
      .map(reEscape).join('|');
    return `^(.*)_(?:${alts})$`;
  }
  if (c.suffixPattern) {
    // 2 つ目のキャプチャ（suffix）を非キャプチャに変えて base だけ取る
    return c.suffixPattern;
  }
  throw new Error('suffixParts / suffixList / suffixPattern のいずれかを指定してください');
}

// suffix_config.json に置けるキー。ここと _comment と実装がズレると、
// 綴り違いのキーが黙って無視されて「設定したのに効かない」になる。
// SQL の生成だけに使うもの
const SQL_KEYS = ['suffixSource', 'schemataPattern', 'region'];
// そのまま options_json に入って UDF のオプションになるもの
const UDF_KEYS = [
  'suffixParts', 'suffixList', 'suffixPattern',
  'suffixAware', 'literalSuffixWords', 'literalGroups',
  'includeUnmatched', 'stripOptions', 'substitutable',
  'layout', 'mode',
  'fontSize', 'lineHeight', 'fontFamily', 'colors',
  'diffLineOpacity', 'diffCharOpacity', 'syntax',
];
const unknown = Object.keys(config).filter(
  (k) => !SQL_KEYS.includes(k) && !UDF_KEYS.includes(k));
if (unknown.length > 0) {
  console.log(`  FAIL  suffix_config.json に知らないキーがあります: ${unknown.join(', ')}`);
  console.log('        綴りを確認するか、build_table.mjs の UDF_KEYS に足してください。');
  process.exit(1);
}

const dynamic = config.suffixSource === 'schemata';
// SCHEMATA はリージョン修飾が要る。データセットのロケーションと揃えること。
const region = config.region || 'asia-northeast1';
const regex = dynamic ? null : baseRegex(config);

// UDF に渡す静的オプション（suffixList は動的モードでは SQL 側で足す）
const staticOpts = Object.fromEntries(
  Object.entries(config).filter(([k]) =>
    !SQL_KEYS.includes(k) &&
    !(dynamic && ['suffixParts', 'suffixList', 'suffixPattern'].includes(k)))
);

// --- 検証 --------------------------------------------------------------
if (dynamic) {
  // 動的モードは SQL 側が ENDS_WITH で切るので、同じ規則を JS で再現して照合する。
  const schemataRe = new RegExp(config.schemataPattern);
  const datasets = ['mart_abjp', 'mart_abus', 'raw_cduk', 'staging', 'mart_2024', 'x_efjp'];
  const found = [...new Set(datasets
    .map((d) => (d.match(schemataRe) || [])[1])
    .filter(Boolean))].sort();
  console.log(`  データセット名から抽出される suffix: [${found.join(', ')}]`);

  const names = found.map((f) => 'v_daily_sales_' + f).concat(['v_daily_sales', 'v_x_zzzz']);
  let bad = 0;
  for (const name of names) {
    // SQL 側: 一覧との ENDS_WITH で最長一致
    const hit = found.filter((f) => name.endsWith('_' + f))
      .sort((a, b) => b.length - a.length)[0];
    const sqlBase = hit ? name.slice(0, -(hit.length + 1)) : null;
    const ex = A.extractSuffix(name, { suffixList: found });
    const udfBase = ex ? ex.base : null;
    if (sqlBase !== udfBase) {
      bad++;
      console.log(`  FAIL  ${name}: SQL=${JSON.stringify(sqlBase)} UDF=${JSON.stringify(udfBase)}`);
    }
  }
  console.log(bad === 0
    ? `  PASS  ENDS_WITH の切り出しと analyze.js の抽出が一致（${names.length} 名で確認）`
    : `  ${bad} 件で不一致`);
  if (bad > 0) process.exit(1);
}

// --- 検証: SQL の正規表現と analyze.js の抽出が同じ base を返すか ---------
if (!dynamic) {
// ここが食い違うと、SQL が束ねた base と UDF の解析対象がズレる。
const re = new RegExp(regex);
const samples = [];
if (Array.isArray(config.suffixParts)) {
  for (const suf of A.expandSuffixParts(config.suffixParts)) {
    samples.push('v_daily_sales_' + suf, 'v_other_' + suf);
  }
} else if (Array.isArray(config.suffixList)) {
  for (const suf of config.suffixList) samples.push('v_daily_sales_' + suf);
}
samples.push('v_daily_sales', 'no_suffix', 'v_x_zzzz');

let mismatch = 0;
for (const name of samples) {
  const sqlBase = (name.match(re) || [])[1] ?? null;
  const ex = A.extractSuffix(name, { ...config });
  const udfBase = ex ? ex.base : null;
  if (sqlBase !== udfBase) {
    mismatch++;
    console.log(`  FAIL  ${name}: SQL=${JSON.stringify(sqlBase)} UDF=${JSON.stringify(udfBase)}`);
  }
}
console.log(mismatch === 0
  ? `  PASS  SQL の正規表現と analyze.js の抽出が一致（${samples.length} 名で確認）`
  : `  ${mismatch} 件で不一致`);
if (mismatch > 0) process.exit(1);
}

const optionsJson = JSON.stringify(staticOpts, null, 2)
  .split('\n').map((l, i) => (i === 0 ? l : '        ' + l)).join('\n');
// コメント行に埋めるほうは 1 行にする。整形して複数行にすると 2 行目以降が
// -- で始まらず、スクリプトとして流したときに構文エラーになる。
const optionsJsonInline = JSON.stringify(staticOpts);

// --- モードごとの SQL 断片 ---------------------------------------------
// 静的モード: suffix 一覧を焼き込んだ正規表現で base を切る。
// 動的モード: データセット名から suffix を集め、ENDS_WITH の結合で base を切る。
//             BigQuery の REGEXP_* はパターンに定数を要求しうるので、
//             実行時に決まる suffix 一覧を正規表現に組み立てるのは避ける。

// 動的モードの options_json は SQL 側で組み立てる。
// suffixList だけが実行時に決まり、残りは suffix_config.json 由来で固定。
const staticTail = Object.entries(staticOpts)
  .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',');

const suffixCte = dynamic ? `
-- suffix 一覧。対象 View と同じ条件でデータセット名から拾う。
-- suffix_override を渡したときだけそちらを使う（サンプル環境用）。
suffixes AS (
  SELECT suffix FROM UNNEST(
    IF(ARRAY_LENGTH(@suffix_override) > 0,
       @suffix_override,
       ARRAY(
         SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'${config.schemataPattern}')
         FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA\`
         WHERE REGEXP_CONTAINS(schema_name, r'${config.schemataPattern}')
           AND (@dataset_filter = '' OR REGEXP_CONTAINS(schema_name, @dataset_filter))
       ))
  ) AS suffix
),
-- UDF に渡す設定。suffixList だけ実行時に決まる。
opts AS (
  SELECT CONCAT(
    '{"suffixList":',
    TO_JSON_STRING(ARRAY(SELECT suffix FROM suffixes ORDER BY suffix)),
    -- ↓ suffix_config.json から生成
    ${staticTail ? `',${staticTail}',\n    ` : ''}'}'
  ) AS options_json
),
` : '';

const keyedCte = dynamic ? `keyed AS (
  -- suffix 一覧との ENDS_WITH で base を切る。
  -- 複数一致したら長いほうを採る（短い suffix が長い suffix の末尾に含まれる場合の対策）。
  -- LEFT JOIN なので suffix の付かない View も 1 行残る。
  SELECT
    src.view_name,
    src.ddl,
    -- suffix を認識できない View は自分の名前を base にする。
    -- 束ねる相手がいないので 1 View / 1 グループとして単独で表示される。
    COALESCE(
      SUBSTR(src.view_name, 1, LENGTH(src.view_name) - LENGTH(s.suffix) - 1),
      src.view_name
    ) AS base
  FROM src
  LEFT JOIN suffixes AS s
    ON ENDS_WITH(src.view_name, '_' || s.suffix)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY src.view_name ORDER BY LENGTH(s.suffix) DESC
  ) = 1
)` : `keyed AS (
  SELECT
    view_name,
    ddl,
    -- suffix_config.json から生成。UDF に渡す設定と必ず一致する。
    -- 認識できない View は自分の名前を base にして、単独で表示させる。
    COALESCE(REGEXP_EXTRACT(view_name, r'${regex}'), view_name) AS base
  FROM src
)`;

const udfOptionsArg = dynamic
  ? `      -- suffixes CTE から組み立てた設定（全行で同じ値）
      (SELECT options_json FROM opts)`
  : `      -- suffix_config.json から生成
      '''${optionsJson}'''`;

console.log(`\n  suffixSource : ${config.suffixSource || 'config'}`);
if (dynamic) console.log(`  抽出パターン : ${config.schemataPattern}（region-${region}）`);
else console.log(`  base 正規表現: ${regex}`);
console.log(`  UDF オプション: ${Object.keys(staticOpts).join(', ')}${dynamic ? ' + suffixList（実行時）' : ''}`);

if (process.argv.includes('--check')) process.exit(0);

// --- SQL を書き出す ----------------------------------------------------
// --- セクション 0（設定）と対象の絞り込み ------------------------------
// リージョン単位の INFORMATION_SCHEMA が使えるので、データセットごとの
// UNION ALL を組み立てる必要がない。対象 View も suffix 一覧も 1 つの
// INSERT の中で同じ条件から引く。スクリプト側でやるのは事前チェックだけ。
const configBlock = dynamic ? `DECLARE project_id   STRING DEFAULT 'my-project';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';    -- VIEW_GROUP_INFO / VIEW_GROUP_CSS の置き場所
DECLARE work_dataset STRING DEFAULT 'ops_meta';    -- view_logic_diff の置き場所
DECLARE region       STRING DEFAULT '${region}';   -- 読むリージョン
DECLARE tz           STRING DEFAULT 'Asia/Tokyo';  -- snapshot_date の基準

-- 比較対象のデータセット。
-- 既定は「リージョン内で suffix の条件（${config.schemataPattern}）に一致するもの全部」。
-- 対象 View も suffix 一覧も同じ条件から引くので、両者がズレない。
DECLARE dataset_filter  STRING        DEFAULT '';  -- 追加の絞り込み正規表現。'' なら絞らない（テスト用）
DECLARE source_datasets ARRAY<STRING> DEFAULT [];  -- 空でなければこの一覧だけを対象にする
DECLARE suffix_override ARRAY<STRING> DEFAULT [];  -- 空でなければ suffix はこれを使う（サンプル環境用）

DECLARE n_datasets INT64;
DECLARE n_views    INT64;` : `DECLARE project_id   STRING DEFAULT 'my-project';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';    -- VIEW_GROUP_INFO / VIEW_GROUP_CSS の置き場所
DECLARE work_dataset STRING DEFAULT 'ops_meta';    -- view_logic_diff の置き場所
DECLARE region       STRING DEFAULT '${region}';   -- 読むリージョン
DECLARE tz           STRING DEFAULT 'Asia/Tokyo';  -- snapshot_date の基準

-- 比較対象のデータセット。suffix は suffix_config.json に焼き込んであるので、
-- ここで対象を絞らないとリージョン内の View を全部読むことになる。
DECLARE dataset_filter  STRING        DEFAULT '';  -- 追加の絞り込み正規表現。'' なら絞らない
DECLARE source_datasets ARRAY<STRING> DEFAULT ['mart'];

DECLARE n_views INT64;`;

// 対象 View を選ぶ条件。事前チェックと本体で同じものを使う。
const viewFilter = dynamic ? `IF(ARRAY_LENGTH(@source_datasets) > 0,
       table_schema IN UNNEST(@source_datasets),
       REGEXP_CONTAINS(table_schema, r'${config.schemataPattern}')
         AND (@dataset_filter = '' OR REGEXP_CONTAINS(table_schema, @dataset_filter)))` :
  `IF(ARRAY_LENGTH(@source_datasets) > 0,
       table_schema IN UNNEST(@source_datasets),
       @dataset_filter = '' OR REGEXP_CONTAINS(table_schema, @dataset_filter))`;

// 事前チェック。0 件のまま進むと空のテーブルができて気づけない。
const precheck = dynamic ? `
-- 事前チェック。0 件のまま進むと空のテーブルができ、設定の間違いに気づけない。
EXECUTE IMMEDIATE fill(r"""
SELECT
  (SELECT COUNT(*)
   FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA\`
   WHERE REGEXP_CONTAINS(schema_name, r'${config.schemataPattern}')
     AND (@dataset_filter = '' OR REGEXP_CONTAINS(schema_name, @dataset_filter))),
  (SELECT COUNT(*)
   FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
   WHERE ${viewFilter})
""", project_id, udf_dataset, work_dataset, region, tz)
INTO n_datasets, n_views
USING dataset_filter AS dataset_filter, source_datasets AS source_datasets;

IF n_views = 0 THEN
  RAISE USING MESSAGE = '対象の View が 0 件です。region / dataset_filter / source_datasets を確認してください。';
END IF;
IF n_datasets = 0 AND ARRAY_LENGTH(suffix_override) = 0 THEN
  RAISE USING MESSAGE = 'suffix を持つデータセットが 0 件です。region / dataset_filter を確認してください。';
END IF;
` : `
-- 事前チェック。0 件のまま進むと空のテーブルができ、設定の間違いに気づけない。
EXECUTE IMMEDIATE fill(r"""
SELECT COUNT(*)
FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
WHERE ${viewFilter}
""", project_id, udf_dataset, work_dataset, region, tz)
INTO n_views
USING dataset_filter AS dataset_filter, source_datasets AS source_datasets;

IF n_views = 0 THEN
  RAISE USING MESSAGE = '対象の View が 0 件です。region / dataset_filter / source_datasets を確認してください。';
END IF;
`;

// INSERT に渡す値。識別子はテキスト置換、値は USING のパラメータ。
const insertUsing = dynamic
  ? `USING dataset_filter AS dataset_filter,
      source_datasets AS source_datasets,
      suffix_override AS suffix_override;`
  : `USING dataset_filter AS dataset_filter,
      source_datasets AS source_datasets;`;

// --- SQL を書き出す ----------------------------------------------------
const sql = `-- =====================================================================
-- suffix 違い View のロジック グループ比較を事前生成してテーブルに持つ
--
-- ※ このファイルは build_table.mjs が生成する。直接編集しないこと。
--    suffix 規則や解析オプションは suffix_config.json を直して再生成する。
--    再生成: node looker_studio/view_groups/build_table.mjs
--
-- Looker Studio の操作のたびに UDF を回すのは重い（DDL をトークン化 →
-- α 等価判定 → パラメータ化 → 差分 → HTML 生成）。INFORMATION_SCHEMA の中身は
-- View をデプロイしたときしか変わらないので、スケジュールドクエリで作り置きする。
--
-- パーティションに日付を積むので、履歴が残る。
-- 「いつグループ構成が変わったか」を後から追える＝ロジック逸脱の検知に使える。
--
-- 前提: view_group_html.sql で VIEW_GROUP_INFO / VIEW_GROUP_CSS を作成済み。
-- 環境に合わせるのはセクション 0 の DECLARE だけ。本文の書き換えは要らない。
--
-- suffix の出どころ: ${dynamic
  ? `INFORMATION_SCHEMA.SCHEMATA（データセット名）
--   ${config.schemataPattern} に一致したデータセット名の末尾を suffix として使う。
--   対象 View も同じ条件で選ぶので、suffix と対象がズレない。
--   つまりデータセットが増えても SQL の修正は要らない。`
  : `suffix_config.json（固定）`}
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 設定（書き換えるのはここだけ）
--
--    BigQuery は識別子（プロジェクト・データセット・関数名）をクエリ
--    パラメータにできない。@param が使えるのは値だけ。
--    そこで識別子はスクリプト変数からテキスト置換し（本文の @@PROJECT@@ など）、
--    値は EXECUTE IMMEDIATE の USING で渡す（@dataset_filter など）。
--
--    SET @@location は DECLARE より前に置く。本文の参照はすべて
--    EXECUTE IMMEDIATE の中にあり、ロケーションを推測できるテーブル参照が
--    無いため、指定しないと既定のロケーションで実行される。
--    下の region と同じ値にすること（どちらも suffix_config.json から生成）。
--
--    スケジュールドクエリには セクション 0 と 2 を登録する
--    （1 と 3 は初回だけ実行すればよい）。
-- ---------------------------------------------------------------------
SET @@location = '${region}';

${configBlock}

-- @@…@@ を実際の値に置き換える。EXECUTE IMMEDIATE のたびに通す。
CREATE TEMP FUNCTION fill(
  sql STRING, project STRING, udf_ds STRING, work_ds STRING,
  reg STRING, zone STRING
) AS (
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(sql,
    '@@PROJECT@@', project),
    '@@UDF@@',     udf_ds),
    '@@WORK@@',    work_ds),
    '@@REGION@@',  reg),
    '@@TZ@@',      zone)
);
${precheck}

-- ---------------------------------------------------------------------
-- 1. 格納先（初回のみ）
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE fill(r"""
CREATE TABLE IF NOT EXISTS \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
(
  snapshot_date   DATE           OPTIONS (description = '生成日'),
  base            STRING         OPTIONS (description = 'suffix を除いた View 名。Looker のキー。suffix を認識できなかった View は View 名そのもの'),
  view_count      INT64          OPTIONS (description = 'この base に属する View 数'),
  group_count     INT64          OPTIONS (description = 'ロジックのグループ数。1 なら全部同一'),
  has_multiple    BOOL           OPTIONS (description = 'group_count > 1。ロジック逸脱の検知用'),
  group_labels    ARRAY<STRING>  OPTIONS (description = 'ペイン見出し（同一ロジックの suffix 列記）'),
  group_sizes     ARRAY<INT64>   OPTIONS (description = '各グループの View 数'),
  suffixes        ARRAY<STRING>  OPTIONS (description = '認識した suffix 一覧'),
  unmatched_count INT64          OPTIONS (description = 'suffix を認識できなかった View 数。1 ならこの行が単独表示の View'),
  diff_html       STRING         OPTIONS (description = '比較 HTML。Templated Record に渡す')
)
PARTITION BY snapshot_date
CLUSTER BY base
OPTIONS (
  description = 'suffix 違い View のロジック グループ比較（事前生成）',
  partition_expiration_days = 400
)
""", project_id, udf_dataset, work_dataset, region, tz);


-- ---------------------------------------------------------------------
-- 2. 生成（スケジュールドクエリに登録する本体）
--
--    同じ日に何度実行しても結果が同じになるよう、当日分を消してから入れる。
--    MERGE より DELETE + INSERT のほうが単純で、パーティション単位なので安い。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE fill(r"""
DELETE FROM \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
WHERE snapshot_date = CURRENT_DATE('@@TZ@@')
""", project_id, udf_dataset, work_dataset, region, tz);

EXECUTE IMMEDIATE fill(r"""
INSERT INTO \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
WITH${suffixCte}
-- 対象 View。リージョン単位の INFORMATION_SCHEMA を使うので、
-- データセットごとの UNION ALL は要らない。
--
-- TABLES.ddl ではなく VIEWS.view_definition を使う。
-- TABLES.ddl は BigQuery が組み立てた CREATE VIEW 文で、OPTIONS に
-- description や作成タイムスタンプが自動で入る。View ごとに値が違うので、
-- そのまま比較すると全部が別グループに割れる。
-- view_definition はクエリ本体だけなので、ヘッダも OPTIONS も付いてこない。
-- View 自身の名前も入らないため、パラメータには参照先の差だけが残る。
src AS (
  SELECT table_name AS view_name, view_definition AS ddl
  FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
  WHERE ${viewFilter}
),
${keyedCte}
SELECT
  CURRENT_DATE('@@TZ@@')              AS snapshot_date,
  base,
  CAST(info.view_count      AS INT64) AS view_count,
  CAST(info.group_count     AS INT64) AS group_count,
  info.group_count > 1                AS has_multiple,
  info.group_labels,
  ARRAY(SELECT CAST(x AS INT64) FROM UNNEST(info.group_sizes) AS x) AS group_sizes,
  info.suffixes,
  CAST(info.unmatched_count AS INT64) AS unmatched_count,
  info.html                           AS diff_html
FROM (
  SELECT
    base,
    \`@@PROJECT@@.@@UDF@@.VIEW_GROUP_INFO\`(
      ARRAY_AGG(STRUCT(view_name, ddl) ORDER BY view_name),
${udfOptionsArg}
    ) AS info
  FROM keyed
  GROUP BY base
)
""", project_id, udf_dataset, work_dataset, region, tz)
${insertUsing}


-- ---------------------------------------------------------------------
-- 3. Looker Studio が読むビュー（最新スナップショットだけ・初回のみ）
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE fill(r"""
CREATE OR REPLACE VIEW \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\` AS
SELECT *
FROM \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
WHERE snapshot_date = (
  SELECT MAX(snapshot_date) FROM \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
)
""", project_id, udf_dataset, work_dataset, region, tz);


-- ---------------------------------------------------------------------
-- 4. テンプレートに貼る CSS（1 回取れば十分。template_style.html と同じ）
--
--    ここから下のコメントは単体で実行するクエリ。
--    @@PROJECT@@ / @@UDF@@ / @@WORK@@ / @@REGION@@ は実際の値に置き換えること
--    （EXECUTE IMMEDIATE を通らないので自動では置換されない）。
-- ---------------------------------------------------------------------
-- SELECT \`@@PROJECT@@.@@UDF@@.VIEW_GROUP_CSS\`('''${optionsJsonInline}''');


-- ---------------------------------------------------------------------
-- 5. 確認と使い方
-- ---------------------------------------------------------------------
-- 中身の確認
-- SELECT base, view_count, group_count, group_labels, unmatched_count,
--        LENGTH(diff_html) AS html_len
-- FROM \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\`
-- ORDER BY base;

${dynamic ? `-- 対象データセットと suffix（セクション 0 と同じ条件）
-- 0 件なら region か dataset_filter を疑う。
-- SELECT
--   REGEXP_EXTRACT(schema_name, r'${config.schemataPattern}') AS suffix,
--   COUNT(*) AS dataset_count,
--   STRING_AGG(schema_name, ', ' ORDER BY schema_name) AS datasets
-- FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA\`
-- WHERE REGEXP_CONTAINS(schema_name, r'${config.schemataPattern}')
-- GROUP BY suffix
-- ORDER BY suffix;

-- 対象になる View の数をデータセット別に見る
-- SELECT table_schema, COUNT(*) AS view_count
-- FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
-- WHERE REGEXP_CONTAINS(table_schema, r'${config.schemataPattern}')
-- GROUP BY table_schema
-- ORDER BY table_schema;

-- 拾えなかったデータセット（対象のつもりのものが落ちていないか）
-- SELECT schema_name
-- FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA\`
-- WHERE NOT REGEXP_CONTAINS(schema_name, r'${config.schemataPattern}')
-- ORDER BY schema_name;

` : ''}-- 生成後: UDF が実際に認識した suffix（テーブルに入っている値）
-- SELECT s AS suffix, COUNT(DISTINCT base) AS base_count
-- FROM \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\`, UNNEST(suffixes) AS s
-- GROUP BY s
-- ORDER BY s;

-- suffix を認識できなかった View（単独で 1 行ずつ並ぶ）
-- SELECT base, group_labels
-- FROM \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\`
-- WHERE unmatched_count > 0
-- ORDER BY base;

-- ロジックが割れている base だけ見る（＝要確認のもの）
-- SELECT base, group_count, group_labels
-- FROM \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\`
-- WHERE has_multiple
-- ORDER BY group_count DESC, base;

-- グループ構成が変わった日を探す（ロジック逸脱がいつ入ったか）
-- SELECT base, snapshot_date, group_count, group_labels
-- FROM (
--   SELECT *,
--     LAG(TO_JSON_STRING(group_labels)) OVER w AS prev_labels,
--     TO_JSON_STRING(group_labels)      AS curr_labels
--   FROM \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
--   WINDOW w AS (PARTITION BY base ORDER BY snapshot_date)
-- )
-- WHERE prev_labels IS NOT NULL AND prev_labels != curr_labels
-- ORDER BY snapshot_date DESC, base;
`;

// 生成物の検証。
// 置換トークンは fill() が知っているものだけ、かつ旧いプレースホルダが
// 残っていないこと。EXECUTE IMMEDIATE を通す本文と、手で置換するコメントの
// どちらも同じ綴りにしておく。
// EXECUTE IMMEDIATE の本文は r""" """ で囲む。本文の中に """ が現れると
// そこで文字列が切れるので、区切り以外に出ていないことを確かめる。
const opens = (sql.match(/r"""/g) || []).length;
const triples = (sql.match(/"""/g) || []).length;
if (triples !== opens * 2) {
  console.log(`  FAIL  三重引用符の数が合いません（開始 ${opens} 個に対して ${triples} 個）`);
  process.exit(1);
}
// コメント行以外が -- で始まらないまま埋まっていないか（セクション 4/5 の事故防止）
for (const line of sql.split('\n')) {
  if (/^\s+"[a-zA-Z]+":/.test(line)) {
    console.log(`  FAIL  コメントに入れ損ねた JSON の行があります: ${line.trim()}`);
    process.exit(1);
  }
}

const KNOWN_TOKENS = ['@@PROJECT@@', '@@UDF@@', '@@WORK@@', '@@REGION@@', '@@TZ@@'];
for (const m of sql.match(/@@[A-Z_]+@@/g) || []) {
  if (!KNOWN_TOKENS.includes(m)) {
    console.log(`  FAIL  知らない置換トークンがあります: ${m}`);
    process.exit(1);
  }
}
const stale = sql.match(/`PROJECT\.|\.DATASET\.|TARGET_DATASET/);
if (stale) {
  console.log(`  FAIL  旧いプレースホルダが残っています: ${stale[0]}`);
  process.exit(1);
}
console.log(`  PASS  置換トークンは ${KNOWN_TOKENS.join(' / ')} のみ`);

const out = join(here, 'build_table.sql');
await writeFile(out, sql);
console.log(`\nwrote ${out}`);
