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

// UDF に渡す解析オプション。SQL では DECLARE の既定値として置き、
// 実行時に手で変えられるようにする（literalGroups の追加など）。
const optionsJsonInline = JSON.stringify(staticOpts);

// --- EXECUTE IMMEDIATE の組み立て --------------------------------------
//
// 識別子はクエリ パラメータにできないので、本文の @@…@@ をスクリプト変数で
// 置き換える。値（配列や JSON）は USING のパラメータで渡す。
//
// 置換を一時 UDF にまとめると、セクション 3 の CREATE VIEW が
// 「Creating views with temporary user defined functions is not supported」で
// 落ちる。永続 UDF にすると今度は関数名自身を置換できない。呼び出しごとに
// 展開するのがいちばん単純で確実。
//
// 使っているトークンだけを並べるので、文ごとに必要な分で済む。
// 置き換えた中身が SQL になるもの（*_COND）は最後に回す。
const TOKENS = [
  ['@@PROJECT@@', 'project_id'],
  ['@@UDF@@', 'udf_dataset'],
  ['@@WORK@@', 'work_dataset'],
  ['@@REGION@@', 'region'],
  ['@@TZ@@', 'tz'],
  ['@@RETENTION@@', 'CAST(partition_expiration_days AS STRING)'],
  ['@@SUFFIX_PATTERN@@', 'suffix_pattern'],
  ['@@BASE_PATTERN@@', 'base_pattern'],
  ['@@SCHEMA_COND@@', 'schema_cond'],
  ['@@VIEW_COND@@', 'view_cond'],
];

/** 本文が使っているトークンだけを置き換える EXECUTE IMMEDIATE を作る。 */
function exec(body, tail = '') {
  const used = TOKENS.filter(([tok]) => body.includes(tok));
  if (used.length === 0) throw new Error('置換トークンを 1 つも使っていません');
  const open = 'REPLACE('.repeat(used.length) + 'r"""';
  const w = Math.max(...used.map(([tok]) => tok.length)) + 4;
  const close = used
    .map(([tok, expr]) => `  ${(`'${tok}',`).padEnd(w)}${expr})`)
    .join(',\n');
  return `EXECUTE IMMEDIATE ${open}\n${body.trim()}\n""",\n${close}${tail};`;
}

// --- SQL の断片 --------------------------------------------------------
const suffixCte = dynamic ? `
-- suffix 一覧。suffix_list が空なら、対象データセットの名前から切り出す。
suffixes AS (
  SELECT suffix FROM UNNEST(
    IF(ARRAY_LENGTH(@suffix_list) > 0,
       @suffix_list,
       ARRAY(
         SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'@@SUFFIX_PATTERN@@')
         FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA\`
         WHERE REGEXP_CONTAINS(schema_name, r'@@SUFFIX_PATTERN@@')
           AND (@@SCHEMA_COND@@)
       ))
  ) AS suffix
),
-- UDF に渡す設定。suffixList だけ実行時に決まるので、analyze_options に足す。
opts AS (
  SELECT CONCAT(
    '{"suffixList":',
    TO_JSON_STRING(ARRAY(SELECT suffix FROM suffixes ORDER BY suffix)),
    ',',
    SUBSTR(TRIM(@analyze_options), 2)
  ) AS options_json
),
` : '';

const keyedCte = dynamic ? `keyed AS (
  -- suffix 一覧との ENDS_WITH で base を切る。区切りは '_' 固定
  -- （UDF 側の抽出も '_' 前提なので、片方だけ変えると食い違う）。
  -- 複数一致したら長いほうを採る。
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
    -- 認識できない View は自分の名前を base にして、単独で表示させる。
    COALESCE(REGEXP_EXTRACT(view_name, r'@@BASE_PATTERN@@'), view_name) AS base
  FROM src
)`;

const udfOptionsArg = dynamic
  ? `      -- suffixes から組み立てた設定（全行で同じ値）
      (SELECT options_json FROM opts)`
  : `      @analyze_options`;

// 対象データセットの条件は dataset_patterns から組み立てる（列名が 2 つあるので 2 本）。
const srcCte = `src AS (
  SELECT table_name AS view_name, view_definition AS ddl
  FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
  WHERE @@VIEW_COND@@
)`;

console.log(`\n  suffixSource : ${config.suffixSource || 'config'}`);
if (dynamic) console.log(`  抽出パターン : ${config.schemataPattern}（region-${region}）`);
else console.log(`  base 正規表現: ${regex}`);
console.log(`  UDF オプション: ${Object.keys(staticOpts).join(', ')}${dynamic ? ' + suffixList（実行時）' : ''}`);

if (process.argv.includes('--check')) process.exit(0);

// --- SQL を書き出す ----------------------------------------------------
const sql = `-- =====================================================================
-- suffix 違い View のロジック グループ比較を事前生成してテーブルに持つ
--
-- ※ このファイルは build_table.mjs が生成する。直接編集しないこと。
--    既定値は suffix_config.json から生成している。恒久的に変えるなら
--    そちらを直して再生成する: node looker_studio/view_groups/build_table.mjs
--    一度だけ変えたいならセクション 0 の DECLARE を書き換えればよい。
--
-- Looker Studio の操作のたびに UDF を回すのは重い（DDL をトークン化 →
-- α 等価判定 → パラメータ化 → 差分 → HTML 生成）。INFORMATION_SCHEMA の中身は
-- View をデプロイしたときしか変わらないので、スケジュールドクエリで作り置きする。
--
-- パーティションに日付を積むので、履歴が残る。
-- 「いつグループ構成が変わったか」を後から追える＝ロジック逸脱の検知に使える。
--
-- 前提: view_group_html.sql で VIEW_GROUP_INFO / VIEW_GROUP_CSS を作成済み。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 設定（書き換えるのはここだけ）
--
--    SET @@location は DECLARE より前に置く。本文の参照はすべて
--    EXECUTE IMMEDIATE の中にあり、ロケーションを推測できるテーブル参照が
--    無いため、指定しないと既定のロケーションで実行される。
--    下の region と同じ値にすること。
--
--    識別子（プロジェクト・データセット・正規表現）は本文の @@…@@ を
--    置き換えて渡す。BigQuery は識別子をクエリ パラメータにできないため。
--    配列や JSON は値なので USING のパラメータで渡す。
--
--    スケジュールドクエリには セクション 0 と 2 を登録する
--    （1 と 3 は初回だけ、5 は確認用なので不要）。
-- ---------------------------------------------------------------------
SET @@location = '${region}';

-- 置き場所
DECLARE project_id   STRING DEFAULT 'my-project';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';   -- VIEW_GROUP_INFO / VIEW_GROUP_CSS
DECLARE work_dataset STRING DEFAULT 'ops_meta';   -- view_logic_diff の置き場所
DECLARE region       STRING DEFAULT '${region}';  -- 読むリージョン（上の @@location と揃える）
DECLARE tz           STRING DEFAULT 'Asia/Tokyo'; -- snapshot_date の基準
DECLARE partition_expiration_days INT64 DEFAULT 400;  -- 履歴の保持日数

-- 対象データセット。**いずれか**の正規表現に一致するものを対象にする。
-- 空配列にするとリージョン内のすべてのデータセットが対象になる。
--   絞る例: [r'^mart_']            mart_ で始まるものだけ
--   並べる例: [r'^mart_abjp$', r'^mart_abus$']
DECLARE dataset_patterns ARRAY<STRING> DEFAULT ${dynamic ? `[r'${config.schemataPattern}']` : '[]'};
${dynamic ? `
-- suffix の切り出し。1 つ目のキャプチャが suffix になる。
DECLARE suffix_pattern STRING DEFAULT r'${config.schemataPattern}';

-- suffix 一覧。空ならデータセット名から suffix_pattern で自動抽出する。
-- View が suffix を持たないデータセットに置いてある場合など、
-- データセット名から導けないときだけ並べる。
DECLARE suffix_list ARRAY<STRING> DEFAULT [];
` : `
-- base の切り出し。1 つ目のキャプチャが base になる。
-- suffix_config.json の suffixParts / suffixList / suffixPattern から生成。
DECLARE base_pattern STRING DEFAULT r'${regex}';
`}
-- UDF に渡す解析オプション（JSON）。suffix_config.json から生成。
-- literalGroups をここで足せば、再生成せずに同値リテラルを増やせる。
-- 1 つ以上のキーを持つ JSON オブジェクトにすること。
DECLARE analyze_options STRING DEFAULT '${optionsJsonInline}';

DECLARE schema_cond STRING;   -- dataset_patterns から組み立てる（SCHEMATA 用）
DECLARE view_cond   STRING;   -- 同上（VIEWS 用。列名が違うので 2 本作る）
DECLARE n_datasets  INT64;
DECLARE n_views     INT64;

IF NOT REGEXP_CONTAINS(TRIM(analyze_options), r'^\\{\\s*"') THEN
  RAISE USING MESSAGE = 'analyze_options は 1 つ以上のキーを持つ JSON オブジェクトにしてください（例: {"mode":"class"}）。';
END IF;

-- dataset_patterns を OR でつないだ条件文にする。空なら TRUE（＝全件）。
SET schema_cond = IF(ARRAY_LENGTH(dataset_patterns) = 0, 'TRUE',
  (SELECT STRING_AGG(FORMAT("REGEXP_CONTAINS(schema_name, r'%s')", p), ' OR ')
   FROM UNNEST(dataset_patterns) AS p));
SET view_cond = IF(ARRAY_LENGTH(dataset_patterns) = 0, 'TRUE',
  (SELECT STRING_AGG(FORMAT("REGEXP_CONTAINS(table_schema, r'%s')", p), ' OR ')
   FROM UNNEST(dataset_patterns) AS p));

-- 事前チェック。0 件のまま進むと空のテーブルができ、設定の間違いに気づけない。
${exec(dynamic ? `
SELECT
  (SELECT COUNT(*)
   FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA\`
   WHERE REGEXP_CONTAINS(schema_name, r'@@SUFFIX_PATTERN@@') AND (@@SCHEMA_COND@@)),
  (SELECT COUNT(*)
   FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
   WHERE @@VIEW_COND@@)
` : `
SELECT
  0,
  (SELECT COUNT(*)
   FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
   WHERE @@VIEW_COND@@)
`, '\nINTO n_datasets, n_views')}

IF n_views = 0 THEN
  RAISE USING MESSAGE = '対象の View が 0 件です。region / dataset_patterns を確認してください。';
END IF;
${dynamic ? `IF n_datasets = 0 AND ARRAY_LENGTH(suffix_list) = 0 THEN
  RAISE USING MESSAGE = 'suffix を持つデータセットが 0 件です。suffix_pattern / dataset_patterns を確認するか、suffix_list に直接並べてください。';
END IF;
` : ''}

-- ---------------------------------------------------------------------
-- 1. 格納先（初回とスキーマを変えたときだけ）
--
--    CREATE OR REPLACE なので、実行すると既存の行はすべて消える。
--    パーティションに積んだ履歴（いつグループ構成が変わったか）も一緒に消える。
--    スケジュールドクエリに登録するのはセクション 0 と 2 だけなので、
--    日次の生成でここが動くことはない。
-- ---------------------------------------------------------------------
${exec(`
CREATE OR REPLACE TABLE \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
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
  partition_expiration_days = @@RETENTION@@
)
`)}


-- ---------------------------------------------------------------------
-- 2. 生成（スケジュールドクエリに登録する本体）
--
--    同じ日に何度実行しても結果が同じになるよう、当日分を消してから入れる。
--    MERGE より DELETE + INSERT のほうが単純で、パーティション単位なので安い。
-- ---------------------------------------------------------------------
${exec(`
DELETE FROM \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
WHERE snapshot_date = CURRENT_DATE('@@TZ@@')
`)}

${exec(`
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
${srcCte},
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
`, dynamic
  ? `\nUSING suffix_list AS suffix_list, analyze_options AS analyze_options`
  : `\nUSING analyze_options AS analyze_options`)}


-- ---------------------------------------------------------------------
-- 3. Looker Studio が読むビュー（最新スナップショットだけ・初回のみ）
-- ---------------------------------------------------------------------
${exec(`
CREATE OR REPLACE VIEW \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\` AS
SELECT *
FROM \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
WHERE snapshot_date = (
  SELECT MAX(snapshot_date) FROM \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
)
`)}


-- ---------------------------------------------------------------------
-- 4. テンプレートに貼る CSS（1 回取れば十分。template_style.html と同じ）
--
--    これだけはコメントのまま。毎回 8 KB の CSS を返しても邪魔なので、
--    必要なときに @@PROJECT@@ / @@UDF@@ を置き換えて実行する。
-- ---------------------------------------------------------------------
-- SELECT \`@@PROJECT@@.@@UDF@@.VIEW_GROUP_CSS\`(@analyze_options);


-- ---------------------------------------------------------------------
-- 5. 確認（ここから下は実行される）
--
--    それぞれ 1 文ずつ結果が出る。上から順に
--      5-1 生成結果の中身
--      5-2 ロジックが割れている base（＝要確認）
--      5-3 suffix を認識できなかった View${dynamic ? `
--      5-4 対象データセットと suffix
--      5-5 データセット別の対象 View 数
--      5-6 条件から外れたデータセット
--      5-7 グループ構成が変わった日` : `
--      5-4 データセット別の対象 View 数
--      5-5 グループ構成が変わった日`}
-- ---------------------------------------------------------------------

-- 5-1 生成結果の中身
${exec(`
SELECT base, view_count, group_count, group_labels, unmatched_count,
       LENGTH(diff_html) AS html_len
FROM \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\`
ORDER BY base
`)}

-- 5-2 ロジックが割れている base（＝要確認のもの）
${exec(`
SELECT base, group_count, group_labels
FROM \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\`
WHERE has_multiple
ORDER BY group_count DESC, base
`)}

-- 5-3 suffix を認識できなかった View（単独で 1 行ずつ並ぶ）
${exec(`
SELECT base, group_labels
FROM \`@@PROJECT@@.@@WORK@@.v_view_logic_diff_latest\`
WHERE unmatched_count > 0
ORDER BY base
`)}
${dynamic ? `
-- 5-4 対象データセットと suffix（セクション 0 と同じ条件）
${exec(`
SELECT
  REGEXP_EXTRACT(schema_name, r'@@SUFFIX_PATTERN@@') AS suffix,
  COUNT(*) AS dataset_count,
  STRING_AGG(schema_name, ', ' ORDER BY schema_name) AS datasets
FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA\`
WHERE REGEXP_CONTAINS(schema_name, r'@@SUFFIX_PATTERN@@') AND (@@SCHEMA_COND@@)
GROUP BY suffix
ORDER BY suffix
`)}

-- 5-5 データセット別の対象 View 数
${exec(`
SELECT table_schema, COUNT(*) AS view_count
FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
WHERE @@VIEW_COND@@
GROUP BY table_schema
ORDER BY table_schema
`)}

-- 5-6 条件から外れたデータセット（対象のつもりのものが落ちていないか）
${exec(`
SELECT schema_name
FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.SCHEMATA\`
WHERE NOT (@@SCHEMA_COND@@)
ORDER BY schema_name
`)}

-- 5-7 グループ構成が変わった日（ロジック逸脱がいつ入ったか）
--     履歴が 1 日分しかなければ 0 件。
` : `
-- 5-4 データセット別の対象 View 数
${exec(`
SELECT table_schema, COUNT(*) AS view_count
FROM \`@@PROJECT@@.region-@@REGION@@.INFORMATION_SCHEMA.VIEWS\`
WHERE @@VIEW_COND@@
GROUP BY table_schema
ORDER BY table_schema
`)}

-- 5-5 グループ構成が変わった日（ロジック逸脱がいつ入ったか）
--     履歴が 1 日分しかなければ 0 件。
`}${exec(`
SELECT base, snapshot_date, group_count, group_labels
FROM (
  SELECT *,
    LAG(TO_JSON_STRING(group_labels)) OVER w AS prev_labels,
    TO_JSON_STRING(group_labels)      AS curr_labels
  FROM \`@@PROJECT@@.@@WORK@@.view_logic_diff\`
  WINDOW w AS (PARTITION BY base ORDER BY snapshot_date)
)
WHERE prev_labels IS NOT NULL AND prev_labels != curr_labels
ORDER BY snapshot_date DESC, base
`)}
`;

// 生成物の検証。
// 置換トークンは既知のものだけ、かつ旧いプレースホルダが
// 残っていないこと。EXECUTE IMMEDIATE を通す本文と、手で置換するコメントの
// どちらも同じ綴りにしておく。
// EXECUTE IMMEDIATE の本文は r""" """ で囲む。本文の中に """ が現れると
// そこで文字列が切れるので、区切り以外に出ていないことを確かめる。
{
  const opens = (sql.match(/r"""/g) || []).length;
  const triples = (sql.match(/"""/g) || []).length;
  if (triples !== opens * 2) {
    console.log(`  FAIL  三重引用符の数が合いません（開始 ${opens} 個に対して ${triples} 個）`);
    process.exit(1);
  }
}
// コメント行以外が -- で始まらないまま埋まっていないか（セクション 4/5 の事故防止）
for (const line of sql.split('\n')) {
  if (/^\s+"[a-zA-Z]+":/.test(line)) {
    console.log(`  FAIL  コメントに入れ損ねた JSON の行があります: ${line.trim()}`);
    process.exit(1);
  }
}

const KNOWN_TOKENS = TOKENS.map(([t]) => t);
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
