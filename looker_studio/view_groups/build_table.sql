-- =====================================================================
-- suffix 違い View のロジック グループ比較を事前生成してテーブルに持つ
--
-- ※ このファイルを直接編集する。生成物ではない。
--    設定は CONFIGURATION の DECLARE だけ。ほかに設定を置く場所はない。
--
-- Looker Studio の操作のたびに UDF を回すのは重い（DDL をトークン化 →
-- α 等価判定 → パラメータ化 → 差分 → HTML 生成）。INFORMATION_SCHEMA の中身は
-- View をデプロイしたときしか変わらないので、スケジュールドクエリで作り置きする。
--
-- 持つのは最新の 1 世代だけ。日次の生成は CREATE OR REPLACE TABLE ... AS SELECT で
-- テーブルごと差し替える。**差し替えは 1 文で終わるので、読み手から見て
-- 「空のテーブル」が見える瞬間が無い。** DELETE + INSERT や TRUNCATE + INSERT だと
-- その隙間にレポートを開いた人には何も出ない。
--
-- 前提: view_group_html.sql で 6 つの UDF を作成済み。
--       system_name / udf_dataset / udf_name_prefix / udf_name_suffix は
--       両ファイルで一致させること。食い違うと関数が見つからない。
--
-- 命名と設定の書き方、動的 SQL の組み立ては lineage プロジェクト
-- （lineage/sql/pipeline/03_run_daily_lineage_pipeline.sql）にそろえてある。
--
-- 動的 SQL の書き方（4 手）:
--   1. SET sql_template          … __…__ を含む SQL を置く
--   2. EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template
--   3. ASSERT で未展開のプレースホルダが残っていないことを確かめる
--   4. EXECUTE IMMEDIATE rendered_sql [INTO …] [USING …]
--
-- プレースホルダ（展開は viewlgc_render_dynamic_sql が行う）:
--   __TARGET_PROJECT__     読み取り対象のプロジェクト
--   __JOB_REGION__         region- を除いたロケーション
--   __T_DIFF_SRC__         生成した素のカードのテーブル（project.dataset.table）
--   __T_DIFF__             メモを差し込み済みのテーブル。レポートはこれを読む
--   __T_BASE_NOTE__        base ごとのメモの外部テーブル（同上）
--   __V_DIFF__             __T_DIFF__ をそのまま返すビュー（互換のため）
--   __UDF_ANALYZE__        analyze 関数（project.dataset.function）
--   __UDF_RENDER__         render 関数（同上）
--   __UDF_PAGE__           参照関係を作り差分と束ねる関数（同上）
--   __UDF_MARKDOWN__       メモの Markdown を HTML にする関数（同上）
--   __UDF_CSS__            group_css 関数（同上）
--   __TZ__                 snapshot_date（生成日）の基準タイムゾーン
--   __SUFFIX_PATTERN__     suffix を切り出す正規表現
--   __NOTE_SHEET_URL__     メモのスプレッドシートの URL
--   __NOTE_SHEET_RANGE__   その中の読み取り範囲（シート名!A:E）
--   __SCHEMA_COND__        SCHEMATA 用の絞り込み条件（SQL 片）
--   __VIEW_DATASET_COND__  VIEWS 用のデータセット条件（SQL 片）
--   __VIEW_NAME_COND__     VIEWS 用の View 名条件（SQL 片）
--
-- 識別子（プロジェクト・データセット・テーブル・関数名・正規表現）は
-- クエリ パラメータにできないのでこの目印で渡す。配列や JSON は値なので
-- USING のパラメータで渡す。
--
-- スケジュールドクエリには CONFIGURATION と セクション 2・2b を登録する
-- （1 と 3 は初回だけ、5 は確認用なので不要）。
--
-- メモ（base ごとの補足説明）について:
--   note_sheet_url にスプレッドシートの URL を入れると、その内容を外部テーブル
--   として読み、base で突き合わせてビューに note_html（Markdown を HTML に
--   したもの）として出す。未設定なら空のテーブルを作るので、ビューの形は
--   変わらない（メモ欄が「未登録」になるだけ）。
--   メモを HTML にするのはセクション 2b。**ここは以前ビューの中でやっていた**
--   （書き換えた内容がその場で出るようにするため）が、レポートを開くたびに
--   スプレッドシートの外部テーブルを読んで JS UDF を回すので遅かった。
--   表示速度を採って、日次で焼き込む形に変えてある。
--   シートを直したその場で反映したいときは、セクション 2b だけを流し直す
--   （解析も描画もやり直さないので軽い）。
-- =====================================================================
SET @@location = 'asia-northeast1';

BEGIN
-- ---------------------------------------------------------------------
-- CONFIGURATION（書き換えるのはここだけ）
--
--   [A] 環境ごとに必ず見るもの
--   [B] 既定のままで動くもの
--   [C] 導出・内部用。編集しない
--
--   リージョンは先頭の SET @@location が唯一の置き場所。job_region は
--   そこから受け取る。SET @@location は DECLARE より前に置く。
-- ---------------------------------------------------------------------
-- [A] 環境ごとに必ず見るもの ------------------------------------------
-- プロジェクト ID は実行時に自動検出する（[C]）。別プロジェクトを見る
-- ときだけ [C] の *_project_id にリテラルを入れて固定する。
--
-- プロジェクト トークンの置換
DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
-- このシステムを表す名前。すべてのオブジェクト名の先頭に入る
DECLARE system_name STRING DEFAULT 'viewlgc';
-- データセット（作る先 / UDF）
DECLARE work_dataset STRING DEFAULT 'ops_meta';
DECLARE udf_dataset  STRING DEFAULT 'ops_meta';
-- テーブル・ビューの命名（prefix / suffix）
DECLARE table_name_prefix STRING DEFAULT '';
DECLARE table_name_suffix STRING DEFAULT '';
-- UDF の命名（prefix / suffix）
DECLARE udf_name_prefix STRING DEFAULT '';
DECLARE udf_name_suffix STRING DEFAULT '';
-- 解析対象のデータセット（どのデータセットの View を集めるか）
DECLARE analysis_include_dataset_patterns ARRAY<STRING> DEFAULT [r'_([A-Za-z]{4})$'];
DECLARE analysis_exclude_dataset_patterns ARRAY<STRING> DEFAULT [];
-- 解析対象の View 名（どの View を集めるか）
DECLARE analysis_include_object_patterns ARRAY<STRING> DEFAULT [];
DECLARE analysis_exclude_object_patterns ARRAY<STRING> DEFAULT [];
-- snapshot_date の基準タイムゾーン
DECLARE snapshot_time_zone STRING DEFAULT 'Asia/Tokyo';
-- base ごとのメモ（Markdown）を置くスプレッドシート。空ならメモ機能を使わない
DECLARE note_sheet_url   STRING DEFAULT '';
DECLARE note_sheet_range STRING DEFAULT 'notes!A:E';
--
-- 変数の説明:
--   project_token_pattern
--     自動検出したプロジェクト ID からこの正規表現で切り出したトークン
--     （REGEXP_EXTRACT。キャプチャがあればグループ 1）が、下のデータセット名と
--     prefix / suffix に書いた '{project_token}' をすべて置き換える。例:
--     プロジェクト 'mycompany-prod-123' に r'-([^-]+)-' なら 'prod' になるので、
--     table_name_prefix='{project_token}_' が 'prod_' になる。既定は最初の
--     ハイフン区切り。一致しなければ '' になり、残った '{project_token}' は
--     下の ASSERT で落ちる。view_group_html.sql と合わせること。
--   system_name
--     このシステムを表す名前。テーブルもビューも関数も、この名前と '_' が
--     先頭に入る（既定なら viewlgc_t_diff / viewlgc_analyze）。
--     同じプロジェクトに別のシステムを同居させたときに、どのオブジェクトが
--     どのシステムのものかを名前だけで見分けるためのもの。
--     環境ではなくシステムを表すので、prefix / suffix とは別に持つ。
--     **view_group_html.sql の同名の変数と必ず同じ値にすること。**
--     違う値だと関数が見つからない。英数字と '_' だけ（ルーチン名に '-' は不可）。
--   work_dataset / udf_dataset
--     テーブルとビューを作るデータセット / UDF が置いてあるデータセット。
--     udf_dataset は view_group_html.sql と同じ値にすること。
--   table_name_prefix / table_name_suffix
--     テーブル・ビューの命名。物理名は下の SET で
--       prefix + system_name + '_' + 区分 + 基本名 + suffix
--     と組み立てる。区分は 'm_'（master）/ 't_'（transaction）でリテラル。
--     環境ごとに変わるのは prefix と suffix だけなので、変数はこの 2 つ。
--     区切りの '_' は値に含めて書く。
--     例: prefix='ope_' / suffix='_tky' で ope_viewlgc_t_diff_tky。
--     使える文字は英数字と '_' と '-'（参照はすべてバッククォート引用なので
--     '-tky' のようなハイフンも安全）。データセット名と UDF 名は '-' 不可。
--   note_sheet_url / note_sheet_range
--     base ごとのメモを置くスプレッドシートの URL と、その中の読み取り範囲。
--     URL はアドレスバーのものをそのまま貼ってよい。'/d/<ID>' までを下の SET で
--     自動的に切り出す（'/edit?gid=0#gid=0' は落ちる）。
--     切るのは、'#gid=' が「タブを ID で指定する」意味を持つため。こちらは
--     note_sheet_range でタブを名前で指定しているので、両方あると指定が二重になる。
--     読み取り範囲の左側（既定 'notes'）は**タブの名前**。新規作成した直後の
--     タブは 'シート1' なので、タブをリネームするかこちらを合わせること。
--     1 行目は見出しで、列は左から base / note_md / updated_at / updated_by /
--     is_hidden の順（この順序が唯一の取り決め。見出しの文言は見ない）。
--       base       メモを付ける base の名前。ビューの base と完全一致で突き合わせる
--       note_md    Markdown 本文
--       updated_at 更新時刻。ISO 8601（2026-08-26T09:00:00Z）。同じ base が
--                  複数行あるときは、これがいちばん新しい 1 行だけを採る
--       updated_by 更新者。表示にだけ使う
--       is_hidden  TRUE / 1 / yes なら出さない。消さずに下書きへ戻すためのもの
--     URL を空にすると、外部テーブルの代わりに同じ列を持つ空のテーブルを作る。
--     ビューの形は変わらないので、あとから URL を入れてセクション 1 を流し
--     直せばメモが出るようになる。
--     **注意**: スプレッドシートの外部テーブルを読むには Drive のスコープが要る。
--     スケジュールドクエリを作るときに Drive を許可し、Looker Studio の
--     データソースの認証にもシートを開ける権限を持たせること。
--   udf_name_prefix / udf_name_suffix
--     UDF の命名。関数名は [C] で
--       udf_prefix + system_name + '_' + 基本名 + udf_suffix
--     と組み立て、view_group_html.sql が作った名前と一致させる必要がある。
--     ルーチン名は英数字と '_' しか使えない（'-' 不可）ので、テーブル側の
--     prefix / suffix とは別に持つ。ハイフンは下の ASSERT で落ちる。
--   analysis_include_dataset_patterns / analysis_exclude_dataset_patterns
--   analysis_include_object_patterns  / analysis_exclude_object_patterns
--     対象の絞り込み。4 つとも形は同じ。
--       include … 空配列なら絞らない。指定すると**いずれか**に一致するものだけ
--       exclude … **いずれか**に一致したものを落とす。include のあとに効く
--     正規表現は部分一致（REGEXP_CONTAINS）。完全一致にしたいなら ^…$ を付ける。
--     View 名は INFORMATION_SCHEMA.VIEWS.table_name（suffix を含んだ実際の名前）
--     に効く。base 名ではないので、ある base だけ見たいなら
--     r'^v_daily_sales_' のように書く。
--       include 例: [r'^mart_']  [r'^mart_abjp$', r'^mart_abus$']
--       exclude 例: [r'_tmp$', r'_bk$', r'^wk_']
--   snapshot_time_zone
--     snapshot_date（いつ時点の内容かを表す列）をどの日付で刻むか。
--     このツールはリージョンをまたいで使うので、置き場所によって変える。
--     ジョブのリージョンとは別物で、@@location からは決まらない。
--     履歴を積まなくなったので、ずれても壊れるものは無い。ただし「いつの
--     内容か」を読む人が見るので、運用しているタイムゾーンに合わせること。
--     IANA のタイムゾーン名（'Asia/Tokyo' / 'UTC' / 'America/New_York' など）。

-- [B] 既定のままで動くもの --------------------------------------------
-- suffix の切り出し。1 つ目のキャプチャが suffix になる。
-- analysis_include_dataset_patterns が「どのデータセットを見るか」なのに対し、
-- こちらは「同じ意味を持つ文字列をどう取り出すか」。役割が違う。
DECLARE suffix_pattern STRING DEFAULT r'_([A-Za-z]{4})$';
-- suffix 一覧。空ならデータセット名から suffix_pattern で自動抽出する。
-- View が suffix を持たないデータセットに置いてある場合など、
-- データセット名から導けないときだけ並べる。
DECLARE suffix_list ARRAY<STRING> DEFAULT [];
-- 取り出した suffix の**末尾 n 文字も suffix として扱う**長さの一覧。
-- 既定の [2] で abjp / abus から jp / us が増える。空にすると何も足さない。
--
-- 用途は「データセット名には現れない suffix」。データセットが mart_abjp
-- （suffix = abjp）で、その中に v_x_jp のように地域だけを持つ View がある場合、
-- jp はどのデータセット名の末尾にも出てこないので自動抽出では拾えない。
-- 4 文字の suffix が <系統 2 文字><地域 2 文字> の組になっているなら、
-- その後ろ 2 文字がそのまま地域だけの suffix になる。
--
-- **suffix_pattern を r'_([A-Za-z]{2,4})$' に広げても解決しない。** あれは
-- データセット名に当たるので、mart_abjp からはやはり abjp しか出てこない。
-- そのうえ 2〜3 文字で終わるデータセットの語尾が片端から suffix になる。
DECLARE suffix_tail_lengths ARRAY<INT64> DEFAULT [2];
-- suffix 一覧から落とす値。
--
-- **まず analysis_exclude_dataset_patterns を検討すること。** データセットごと
-- 対象外にすれば、その名前から suffix は取り出されず（末尾の導出も起きず）、
-- 中の View も集められない。「データセットを除外したらその中のオブジェクトも
-- 全部除外」が素直に成り立つ。作業用データセット（既定の条件だと ops_meta が
-- 入ってしまい meta / ta が増える）はこちらで落とすのが筋。
--
--   analysis_exclude_dataset_patterns = [r'^ops_meta$']
--     → suffix から meta と ta が消え、viewlgc 自身の View も対象外になる
--
-- こちらが要るのは、**解析対象にはしたいが名前の語尾が suffix ではない**
-- データセットがある場合だけ。混ざったゴミは全 View 名に ENDS_WITH で当たるので、
-- v_summary_ta のような無関係な View の base が切られる。base が変わると
-- メモ（base で突き合わせている）が黙って外れる。
--
-- **効くのは出来上がった一覧に対してだけ**（導出のあと）。落とした値からの
-- 導出は止まらないので、「4 文字のほうは要らないが末尾は要る」が書ける。
--   ghkr を落とす → 一覧から ghkr だけが消え、kr は残る
--   meta と ta を消したい → 両方並べる（meta だけでは ta が残る）
-- 段階を分けて効かせるほうが短く書けるが、書いた値と消える値が 1 対 1 で
-- 対応しないほうが分かりにくい。5-4 が最終的な一覧を全部出すので、
-- 消したいものはそれを見て並べればよい。
--
-- **正規表現ではなく値そのもの**（完全一致）。ここだけ *_patterns と流儀が違う
-- のは、suffix が短くて部分一致だと巻き添えが大きいため（'ta' を弾くつもりが
-- REGEXP_CONTAINS では 'meta' まで消える）。
DECLARE suffix_exclude_list ARRAY<STRING> DEFAULT [];
-- カラム定義に STRUCT の中身（ネストした項目）を出すか。
-- TRUE なら amount_breakdown の下に amount_breakdown.currency のような行が
-- 並ぶ。型が ARRAY<STRUCT<...>> のままだと中の定義が読めないので既定は TRUE。
-- STRUCT が多い View だと表が縦に伸びるので、最上位だけ見たいときは FALSE。
DECLARE include_nested_fields BOOL DEFAULT TRUE;
-- UDF に渡す解析オプション（JSON）。1 つ以上のキーを持つオブジェクトにすること。
-- 指定できるキーは view_group_html.sql の冒頭に一覧がある。
--   substitutable / equivalentLiterals / suffixAware / includeUnmatched /
--   stripOptions / layout / mode / 表示の調整
--
-- 既定の分類方針: 置換してよいのは FROM / JOIN が指す実体名と値だけ。
-- 列名・別名・CTE 名・ウィンドウ名・関数名が違えば別グループにする
-- （横展開はロジックが同じならコピーで行う運用なので、そこが違えば
-- 環境差ではなく書き換えの差）。バッククォートの有無やパスの部分数も
-- 正規化しないので、意味が同じでも書き方が違えば別グループになる。
--
-- 値の差もロジック差として残したいなら "substitutable":["entity"] を指定する。
-- そのとき効くのが equivalentLiterals（同じとみなす文字列の組の一覧）。
-- suffixList は下の suffixes から自動で入るので、ここには書かない。
-- 綴りを間違えたキーは UDF 側で黙って無視される。
DECLARE analyze_options STRING DEFAULT '{"mode":"class"}';

-- [C] 導出・内部用。編集しない ----------------------------------------
-- リージョンは @@location が唯一の置き場所。
DECLARE job_region STRING DEFAULT @@location;
-- プロジェクトは自動検出した値を使う。役割ごとに別プロジェクトにするときだけ
-- DEFAULT にリテラルを入れて固定する（COALESCE で非 NULL が勝つ）。
DECLARE default_project_id STRING;
DECLARE work_project_id    STRING DEFAULT NULL;  -- テーブル・ビューの置き場所
DECLARE udf_project_id     STRING DEFAULT NULL;  -- UDF の置き場所
DECLARE target_project_id  STRING DEFAULT NULL;  -- 読み取り対象
DECLARE project_token      STRING;

-- 作るオブジェクトの物理名（下の SET で組み立てる）。データセット名は含まない。
-- オブジェクトが増えたらここに 1 行足し、SET と本文の __…__ を対で増やし、
-- viewlgc_render_dynamic_sql にも置換を 1 段足す。
DECLARE table_diff_src  STRING;  -- 生成した素のカード（メモを差し込む前）
DECLARE table_diff      STRING;  -- レポートが読むテーブル（メモ差し込み済み）
DECLARE table_base_note STRING;  -- base ごとのメモ（スプレッドシートの外部テーブル）
DECLARE view_diff       STRING;  -- レポートが読むビュー。メモを差し込む

-- view_group_html.sql が作った関数名。同じ規則で組み立てて突き合わせる。
-- 解析と描画が別の UDF なのは、インラインのコード ブロブが 1 個あたり 32 KB
-- までのため。JS UDF から別の UDF は呼べないので、つなぐのはこの SQL の仕事。
DECLARE udf_analyze_function_name  STRING;
DECLARE udf_render_function_name   STRING;
DECLARE udf_page_function_name     STRING;
DECLARE udf_markdown_function_name STRING;
DECLARE udf_css_function_name      STRING;
DECLARE udf_sql_function_name      STRING;

-- 動的 SQL。render_call_sql は 1 度だけ組み立てて全テンプレートで使い回す。
-- 呼び出しごとに変わるのは @sql_template だけ。
DECLARE render_call_sql STRING;
DECLARE sql_template    STRING;
DECLARE rendered_sql    STRING;

-- include / exclude から組み立てる条件文。見る列が違うので 3 本作る。
DECLARE schema_condition       STRING;  -- SCHEMATA.schema_name
DECLARE view_dataset_condition STRING;  -- VIEWS.table_schema
DECLARE view_name_condition    STRING;  -- VIEWS.table_name
DECLARE target_dataset_count INT64;
DECLARE target_view_count    INT64;
DECLARE udf_found_count      INT64;


-- 実行中のプロジェクトを INFORMATION_SCHEMA.SCHEMATA から自動検出する
-- （catalog_name = ジョブが動いているプロジェクト）。リージョン修飾の
-- 識別子はパラメータにできないので @@location から組み立てる。
EXECUTE IMMEDIATE FORMAT(
  "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
  @@location
) INTO default_project_id;
ASSERT default_project_id IS NOT NULL AS
  'プロジェクト ID を自動検出できません（このリージョンにデータセットが無い？）。work_project_id などにリテラルを入れて固定してください。';
SET work_project_id   = COALESCE(work_project_id,   default_project_id);
SET udf_project_id    = COALESCE(udf_project_id,    default_project_id);
SET target_project_id = COALESCE(target_project_id, default_project_id);

-- 名前を組み立てる前に '{project_token}' を置き換える。
SET project_token =
  COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
SET work_dataset      = REPLACE(work_dataset,      '{project_token}', project_token);
SET udf_dataset       = REPLACE(udf_dataset,       '{project_token}', project_token);
SET table_name_prefix = REPLACE(table_name_prefix, '{project_token}', project_token);
SET table_name_suffix = REPLACE(table_name_suffix, '{project_token}', project_token);
SET udf_name_prefix   = REPLACE(udf_name_prefix,   '{project_token}', project_token);
SET udf_name_suffix   = REPLACE(udf_name_suffix,   '{project_token}', project_token);

ASSERT REGEXP_CONTAINS(work_dataset, r'^[A-Za-z0-9_]+$') AS
  'work_dataset は英数字と _ だけにしてください（置換されていない {project_token} が残っていませんか）。';
ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$') AS
  'udf_dataset は英数字と _ だけにしてください（置換されていない {project_token} が残っていませんか）。';

-- テーブル: prefix + system_name + '_' + 区分 + 基本名 + suffix
-- ビュー  : prefix + system_name + '_' + 'vw_' + 区分 + 基本名 + suffix
-- 区分 't_' は transaction（'m_' は master）。
-- テーブルとビューは基本名が同じ 'diff' で、'vw_' の有無だけで見分ける。
-- 素のカードだけを持つ中間テーブルには '_src' を付ける。
ASSERT REGEXP_CONTAINS(system_name, r'^[A-Za-z0-9_]+$') AS
  'system_name は英数字と _ だけにしてください（ルーチン名に - は使えません）。';
SET table_diff_src =
  table_name_prefix || system_name || '_' || 't_' || 'diff_src' || table_name_suffix;
SET table_diff =
  table_name_prefix || system_name || '_' || 't_' || 'diff' || table_name_suffix;
-- メモは View のデプロイでは変わらない台帳なので 'm_'（master）。
SET table_base_note =
  table_name_prefix || system_name || '_' || 'm_' || 'base_note' || table_name_suffix;
SET view_diff =
  table_name_prefix || system_name || '_' || 'vw_' || 't_' || 'diff' || table_name_suffix;
ASSERT REGEXP_CONTAINS(table_diff_src, r'^[A-Za-z0-9_-]+$') AS
  'table_diff_src の名前が不正です。';
ASSERT REGEXP_CONTAINS(table_diff, r'^[A-Za-z0-9_-]+$') AS
  'table_diff の名前が不正です。';
ASSERT REGEXP_CONTAINS(table_base_note, r'^[A-Za-z0-9_-]+$') AS
  'table_base_note の名前が不正です。';
ASSERT REGEXP_CONTAINS(view_diff, r'^[A-Za-z0-9_-]+$') AS
  'view_diff の名前が不正です。';

-- UDF: udf_prefix + system_name + '_' + 基本名 + udf_suffix
--      （view_group_html.sql と同じ。system_name も同じ値でなければ見つからない）
SET udf_analyze_function_name =
  udf_name_prefix || system_name || '_' || 'analyze' || udf_name_suffix;
SET udf_render_function_name =
  udf_name_prefix || system_name || '_' || 'render' || udf_name_suffix;
SET udf_page_function_name =
  udf_name_prefix || system_name || '_' || 'page' || udf_name_suffix;
SET udf_markdown_function_name =
  udf_name_prefix || system_name || '_' || 'markdown' || udf_name_suffix;
SET udf_css_function_name =
  udf_name_prefix || system_name || '_' || 'group_css' || udf_name_suffix;
SET udf_sql_function_name =
  udf_name_prefix || system_name || '_' || 'render_dynamic_sql' || udf_name_suffix;
ASSERT REGEXP_CONTAINS(udf_analyze_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_analyze_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_render_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_render_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_page_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_page_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_markdown_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_markdown_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_sql_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_sql_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';

ASSERT note_sheet_url = '' OR
  REGEXP_CONTAINS(note_sheet_url, r'^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]+') AS
  'note_sheet_url はスプレッドシートの URL（https://docs.google.com/spreadsheets/d/...）にしてください。メモを使わないなら空にします。';
ASSERT REGEXP_CONTAINS(note_sheet_range, r"^[^'`]+![A-Z]+[0-9]*:[A-Z]+[0-9]*$") AS
  'note_sheet_range は「シート名!A:E」の形にしてください。';
-- アドレスバーの URL をそのまま貼れるように、'/d/<ID>' までに切り詰める。
-- 上の ASSERT を通っていれば必ず取り出せるので、COALESCE が効くのは '' のときだけ。
SET note_sheet_url = COALESCE(
  REGEXP_EXTRACT(note_sheet_url, r'^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]+'),
  note_sheet_url);

ASSERT REGEXP_CONTAINS(TRIM(analyze_options), r'^\{\s*"') AS
  'analyze_options は 1 つ以上のキーを持つ JSON オブジェクトにしてください（例: {"mode":"class"}）。';

-- include / exclude を条件文に組み立てる。3 本とも形は同じで、見る列が違うだけ。
--   データセット名は SCHEMATA では schema_name、VIEWS では table_schema。
--   View 名は VIEWS の table_name。
SET schema_condition = CONCAT(
  IF(ARRAY_LENGTH(analysis_include_dataset_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(schema_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_include_dataset_patterns) AS p)),
  IF(ARRAY_LENGTH(analysis_exclude_dataset_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(schema_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_exclude_dataset_patterns) AS p)));

SET view_dataset_condition = CONCAT(
  IF(ARRAY_LENGTH(analysis_include_dataset_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_schema, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_include_dataset_patterns) AS p)),
  IF(ARRAY_LENGTH(analysis_exclude_dataset_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_schema, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_exclude_dataset_patterns) AS p)));

SET view_name_condition = CONCAT(
  IF(ARRAY_LENGTH(analysis_include_object_patterns) = 0, 'TRUE',
    (SELECT CONCAT('(', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_include_object_patterns) AS p)),
  IF(ARRAY_LENGTH(analysis_exclude_object_patterns) = 0, '',
    (SELECT CONCAT(' AND NOT (', STRING_AGG(FORMAT("REGEXP_CONTAINS(table_name, r'%s')", p), ' OR '), ')')
     FROM UNNEST(analysis_exclude_object_patterns) AS p)));

-- 永続関数への呼び出しを 1 度だけ組み立てて使い回す。関数の場所は
-- udf_project_id / udf_dataset / udf_render_function_name で決まる。
-- 固定の設定はここで焼き込み、テンプレートだけを @sql_template で渡す。
-- 値は %T で埋める。条件文には引用符が入るので、%s だと壊れる。
SET render_call_sql = FORMAT(
  """SELECT `%s.%s.%s`(@sql_template, %T, %T, %T, %T, %T, %T, STRUCT(%T AS diff_src, %T AS diff_table, %T AS diff_view, %T AS base_note, %T AS analyze_function, %T AS render_function, %T AS page_function, %T AS markdown_function, %T AS css_function), STRUCT(%T AS time_zone, %T AS suffix_pattern, %T AS note_sheet_url, %T AS note_sheet_range), STRUCT(%T AS schema_condition, %T AS view_dataset_condition, %T AS view_name_condition))""",
  udf_project_id, udf_dataset, udf_sql_function_name,
  work_project_id, work_dataset, udf_project_id, udf_dataset,
  target_project_id, job_region,
  table_diff_src, table_diff, view_diff, table_base_note,
  udf_analyze_function_name, udf_render_function_name,
  udf_page_function_name, udf_markdown_function_name, udf_css_function_name,
  snapshot_time_zone, suffix_pattern,
  note_sheet_url, note_sheet_range,
  schema_condition, view_dataset_condition, view_name_condition);


-- 前提の確認。UDF を作り直す前にこのファイルを流すと、動的 SQL の展開や
-- 関数の引数が食い違って、原因の分かりにくいエラーになる。先に数えておく。
-- ここは render_call_sql を通さない。その仕組み自体が UDF に依存しているので、
-- 依存する前に確かめる必要がある（プロジェクト自動検出と同じ書き方）。
EXECUTE IMMEDIATE FORMAT(
  "SELECT COUNT(*) FROM `%s.%s.INFORMATION_SCHEMA.ROUTINES` WHERE routine_name IN UNNEST(%T)",
  udf_project_id, udf_dataset,
  [udf_analyze_function_name, udf_render_function_name, udf_page_function_name,
   udf_markdown_function_name, udf_css_function_name, udf_sql_function_name]
) INTO udf_found_count;
ASSERT udf_found_count = 6 AS
  'UDF が 6 つそろっていません。先に view_group_html.sql を実行してください（system_name / udf_dataset / udf_name_prefix / udf_name_suffix は両ファイルで同じ値に）。';


-- 事前チェック。0 件のまま進むと空のテーブルができ、設定の間違いに気づけない。
SET sql_template = """
SELECT
  (SELECT COUNT(*)
   FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
   WHERE REGEXP_CONTAINS(schema_name, r'__SUFFIX_PATTERN__') AND (__SCHEMA_COND__)),
  (SELECT COUNT(*)
   FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
   WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__))
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '事前チェックの SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql INTO target_dataset_count, target_view_count;

ASSERT target_view_count > 0 AS
  '対象の View が 0 件です。@@location / analysis_include_dataset_patterns / analysis_include_object_patterns を確認してください。';
ASSERT target_dataset_count > 0 OR ARRAY_LENGTH(suffix_list) > 0 AS
  'suffix を持つデータセットが 0 件です。suffix_pattern / analysis_include_dataset_patterns を確認するか、suffix_list に直接並べてください。';


-- ---------------------------------------------------------------------
-- 1. base ごとのメモの置き場所（初回とシートを変えたときだけ）
--
--    差分のテーブルはここでは作らない。セクション 2 が毎回
--    CREATE OR REPLACE TABLE ... AS SELECT で作り直すので、置き場所を先に
--    用意しておく必要がない。初回もセクション 2 だけで揃う。
--
--    作るオブジェクトは 4 つ。
--
--      viewlgc_t_diff_src   セクション 2 が作る。素のカード（メモ差し込み前）
--      viewlgc_t_diff       セクション 2b が作る。**レポートが読むのはこれ**
--      viewlgc_vw_t_diff    セクション 3。t_diff の素通し（互換のため残す）
--      viewlgc_m_base_note  ここで作る。メモのスプレッドシート
--
--    【1 回きりの後片付け】名前を変える前・ビューを 2 本作っていた頃の
--    オブジェクトは、名前が違うので新しい実行では触られず、そのまま残る。
--    中身は作り直せるものしか入っていないので、確認のうえ手で消すこと。
--    自動では消さない（消してよいかはこのスクリプトからは判断できない）。
--
--      DROP TABLE IF EXISTS `<project>.<dataset>.viewlgc_t_diff_hist`;
--      DROP VIEW  IF EXISTS `<project>.<dataset>.viewlgc_vw_t_diff_by_ref`;
--
--    prefix / suffix を付けているなら、その名前に読み替える。
-- ---------------------------------------------------------------------
-- base ごとのメモ。実体はスプレッドシートで、ここでは外部テーブルとして
-- 見えるようにするだけ。列はすべて STRING で受けて、型はビューで付ける。
-- シートは書き手が自由に触るので、日付や真偽値の書き方を強制できない。
-- STRING で受けて SAFE_CAST すれば、書き間違いのある 1 行がクエリ全体を
-- 落とすことがない。
--
-- 列は左から base / note_md / updated_at / updated_by / is_hidden の順。
-- この順序が唯一の取り決めで、見出しの文言は見ない（skip_leading_rows = 1）。
--
-- note_sheet_url が空のときは、同じ列を持つ空のテーブルを作る。ビューは
-- どちらでも同じ形になるので、メモを使わない環境でも下のビューがそのまま通る。
-- あとから URL を入れてこのセクションを流し直せば、メモが出るようになる。
-- 分岐の中でも 4 手（template → render → ASSERT → EXECUTE）はそろえてある。
--
-- 空のテーブルと外部テーブルは種別が違う。CREATE OR REPLACE が種別をまたげず
-- 「Cannot replace a table with a different type」になる場合は、先に
--   DROP TABLE IF EXISTS `<work_project>.<work_dataset>.viewlgc_m_base_note`
-- を流してからこのセクションを実行する。中身はシート側にあるので失うものはない。
IF note_sheet_url = '' THEN
  SET sql_template = """
CREATE OR REPLACE TABLE `__T_BASE_NOTE__`
(
  base       STRING,
  note_md    STRING,
  updated_at STRING,
  updated_by STRING,
  is_hidden  STRING
)
OPTIONS (
  description = 'base ごとのメモ（未設定。note_sheet_url を入れると外部テーブルに置き換わる）'
)
""";
  EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
    'メモのテーブル（空）の SQL に未展開のプレースホルダが残っています。';
  EXECUTE IMMEDIATE rendered_sql;
ELSE
  SET sql_template = """
CREATE OR REPLACE EXTERNAL TABLE `__T_BASE_NOTE__`
(
  base       STRING,
  note_md    STRING,
  updated_at STRING,
  updated_by STRING,
  is_hidden  STRING
)
OPTIONS (
  format = 'GOOGLE_SHEETS',
  uris = ['__NOTE_SHEET_URL__'],
  sheet_range = '__NOTE_SHEET_RANGE__',
  skip_leading_rows = 1,
  description = 'base ごとのメモ（Markdown）。実体は Google スプレッドシート'
)
""";
  EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
  ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
    'メモの外部テーブルの SQL に未展開のプレースホルダが残っています。';
  EXECUTE IMMEDIATE rendered_sql;
END IF;


-- ---------------------------------------------------------------------
-- 2. 生成（スケジュールドクエリに登録する本体・その 1）
--
--    出すのは**素のカード**（メモを差し込む前）。メモを繋ぐのはセクション 2b。
--    分けてあるのは、シートを直したときに 2b だけを流し直せるようにするため。
--    こちらは解析も描画もやり直すので重い。
--
--    持つのは最新の 1 世代だけ。テーブルごと作り直す。
--
--    **1 文で差し替わるので、読み手から見て「空のテーブル」が見える瞬間が無い。**
--    DELETE + INSERT や TRUNCATE + INSERT だと、その隙間にレポートを開いた人には
--    何も出ない。以前は履歴を積んでいて、ビューが MAX(snapshot_date) を採って
--    いたので隙間があっても前日分が出ていた。最新しか持たなくなった以上、
--    途中経過を見せない書き方に替える必要がある。
--
--    列の説明（OPTIONS）は列リストに書く。CTAS でもスキーマを明示できるので、
--    作り直すたびに説明が消えることはない。
--
--    初回もこの 1 文でテーブルができる。セクション 1 は要らない。
-- ---------------------------------------------------------------------
SET sql_template = """
CREATE OR REPLACE TABLE `__T_DIFF_SRC__`
(
  snapshot_date   DATE           OPTIONS (description = '生成日。履歴は持たないので、常に最後に実行した日'),
  base            STRING         OPTIONS (description = 'suffix を除いた View 名。Looker のキー。suffix を認識できなかった View は View 名そのもの'),
  ref_index       INT64          OPTIONS (description = '常に 0。基準はカードの中のタブで選ぶようになったため、列としてのみ残っている'),
  ref_label       STRING         OPTIONS (description = '先頭グループの見出し。ref_index と同じく残骸で、絞り込みには使わない'),
  view_count      INT64          OPTIONS (description = 'この base に属する View 数'),
  group_count     INT64          OPTIONS (description = 'ロジックのグループ数。1 なら全部同一'),
  has_multiple    BOOL           OPTIONS (description = 'group_count > 1。ロジック逸脱の検知用'),
  group_labels    ARRAY<STRING>  OPTIONS (description = 'タブ見出し（同一ロジックの suffix 列記）'),
  group_sizes     ARRAY<INT64>   OPTIONS (description = '各グループの View 数'),
  suffixes        ARRAY<STRING>  OPTIONS (description = '認識した suffix 一覧'),
  unmatched_count INT64          OPTIONS (description = 'suffix を認識できなかった View 数。1 ならこの行が単独表示の View'),
  view_desc_md    STRING         OPTIONS (description = 'View 自身の description（Markdown）。note タブの先頭に出す。未設定なら NULL'),
  diff_html       STRING         OPTIONS (description = '比較 HTML。Templated Record に渡す')
)
CLUSTER BY base
OPTIONS (
  description = 'suffix 違い View のロジック グループ比較（素のカード。メモを差し込む前）'
)
AS
WITH
-- suffix 一覧の素。suffix_list が空なら、対象データセットの名前から切り出す。
-- 除外はここでは効かせない。導出のあとに 1 回だけ効かせることで、
-- 「4 文字のほうは落として末尾だけ残す」（ghkr を消して kr は残す）が書ける。
suffix_base AS (
  SELECT DISTINCT suffix
  FROM UNNEST(
    IF(ARRAY_LENGTH(@suffix_list) > 0,
       @suffix_list,
       ARRAY(
         SELECT DISTINCT REGEXP_EXTRACT(schema_name, r'__SUFFIX_PATTERN__')
         FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
         WHERE REGEXP_CONTAINS(schema_name, r'__SUFFIX_PATTERN__')
           AND (__SCHEMA_COND__)
       ))
  ) AS suffix
  WHERE suffix IS NOT NULL AND suffix != ''
),
-- 実際に使う suffix 一覧。素のものに、その末尾 n 文字を足す。
-- データセット名に現れない suffix を拾うため（mart_abjp の中の v_x_jp → 'jp'）。
-- suffix に '_' は入らないので、abjp と jp が同じ一覧に並んでも 1 つの View 名に
-- 両方が当たることは無い（v_x_abjp は '_jp' では終わらない）。
suffixes AS (
  SELECT DISTINCT suffix
  FROM (
    SELECT suffix FROM suffix_base
    UNION ALL
    SELECT SUBSTR(b.suffix, -n) AS suffix
    FROM suffix_base AS b, UNNEST(@suffix_tail_lengths) AS n
    WHERE n > 0 AND LENGTH(b.suffix) > n
  )
  -- 除外はここ 1 か所だけ。書いた値と消える値が 1 対 1 で対応する。
  WHERE suffix NOT IN UNNEST(@suffix_exclude_list)
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
  FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
  WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
),
keyed AS (
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
),
-- カラム定義。INFORMATION_SCHEMA.COLUMNS は View の出力列を持っている。
-- 説明だけは COLUMN_FIELD_PATHS にあるので、最上位の列（field_path = 列名）に
-- 絞って突き合わせる。
--
-- 条件文（__VIEW_*_COND__）は table_schema / table_name を修飾なしで見るので、
-- JOIN してから当てると曖昧になる。それぞれ単独の CTE で絞ってから繋ぐ。
cols_raw AS (
  SELECT table_schema, table_name, column_name, ordinal_position, data_type, is_nullable
  FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.COLUMNS`
  WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
),
-- COLUMN_FIELD_PATHS は STRUCT の中まで 1 行ずつ持っている。
--   amount_breakdown           ARRAY<STRUCT<currency STRING, gross NUMERIC>>
--   amount_breakdown.currency  STRING
--   amount_breakdown.gross     NUMERIC
-- ネストした項目もそれぞれ description を持てるので、論理名もここから取れる。
col_paths AS (
  SELECT table_schema, table_name, column_name, field_path, data_type, description
  FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS`
  WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
),
-- 最上位とネストを 1 本に束ねる。
--
-- **最上位は COLUMNS を軸にする（LEFT JOIN）。** COLUMN_FIELD_PATHS が
-- 権限などで引けない環境でも、型と NULL 制約だけは出るようにするため。
-- 軸を逆にすると、あちらが空のときカラム定義が丸ごと消える。
--
-- ネストの行は型と説明だけ。ordinal_position も is_nullable も COLUMNS に
-- しか無いので、親のものを持ってくると嘘になる（描画側も出さない）。
col_entries AS (
  SELECT
    r.table_name       AS view_name,
    r.column_name      AS field_path,
    r.data_type        AS data_type,
    r.ordinal_position AS ordinal_position,
    r.is_nullable      AS is_nullable,
    COALESCE(p.description, '') AS description
  FROM cols_raw AS r
  LEFT JOIN col_paths AS p
    ON  p.table_schema = r.table_schema
    AND p.table_name   = r.table_name
    AND p.field_path   = r.column_name
  UNION ALL
  SELECT
    p.table_name,
    p.field_path,
    p.data_type,
    r.ordinal_position,
    CAST(NULL AS STRING),
    COALESCE(p.description, '')
  FROM col_paths AS p
  JOIN cols_raw AS r
    ON  r.table_schema = p.table_schema
    AND r.table_name   = p.table_name
    AND r.column_name  = p.column_name
  WHERE p.field_path != p.column_name
    AND @include_nested_fields
),
cols AS (
  SELECT
    view_name,
    ARRAY_AGG(
      STRUCT(
        field_path       AS n,
        data_type        AS t,
        ordinal_position AS o,
        is_nullable      AS u,
        description      AS d
      )
      -- 並びは描画側が決める（ネストは親の型の中での宣言順に並べ替える）。
      -- ここでは同じ入力から同じ並びが出ることだけを保証する。
      ORDER BY ordinal_position, field_path
    ) AS cols
  FROM col_entries
  GROUP BY view_name
),
-- base ごとに束ねる。View 名で引ける形にするのは描画側（JS）の仕事。
base_cols AS (
  SELECT
    k.base,
    TO_JSON_STRING(ARRAY_AGG(STRUCT(c.view_name AS v, c.cols AS cols))) AS columns_json
  FROM keyed AS k
  JOIN cols AS c ON c.view_name = k.view_name
  GROUP BY k.base
),
-- View 自身の description（Markdown）。note タブの先頭に出す。
--
-- description は TABLE_OPTIONS にしか無い（VIEWS にも TABLES にも列が無い）。
-- option_value は JSON 文字列の体裁（"説明文"）で入っているので、剥がして
-- 中身を取り出す。剥がせない形で入っていたら生のまま使う（落とすよりよい）。
view_opts AS (
  SELECT
    table_name AS view_name,
    COALESCE(SAFE.STRING(SAFE.PARSE_JSON(option_value)), option_value) AS desc_md
  FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.TABLE_OPTIONS`
  WHERE option_name = 'description'
    AND (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
),
-- 同じ説明を持つ View をまとめる。base の中で説明が割れているかどうかが
-- ここで分かる（同じロジックの View なのに説明が違えば、それ自体が情報）。
desc_by_base AS (
  SELECT
    k.base,
    d.desc_md,
    STRING_AGG(k.view_name, ', ' ORDER BY k.view_name) AS view_names
  FROM keyed AS k
  JOIN view_opts AS d ON d.view_name = k.view_name
  WHERE TRIM(COALESCE(d.desc_md, '')) != ''
  GROUP BY k.base, d.desc_md
),
base_desc AS (
  SELECT
    base,
    -- base の中で説明が 1 種類なら、そのまま出す（見出しは邪魔）。
    -- 割れていたら、どの View のものかを添えて全部出す。黙って 1 つだけ
    -- 出すと、説明が食い違っていることに気づけない。
    -- 区切りは STRING_AGG ではなく ARRAY_TO_STRING で入れる。STRING_AGG の
    -- 区切り文字はリテラルかクエリ パラメータでなければならず、CHR(10) の
    -- ような式は受け付けない（テンプレートにバックスラッシュを書けないので、
    -- 改行のリテラルも作れない）。ARRAY_TO_STRING にその制限は無い。
    IF(COUNT(*) = 1,
       ANY_VALUE(desc_md),
       ARRAY_TO_STRING(
         ARRAY_AGG('**' || view_names || '**' || CHR(10) || CHR(10) || desc_md
                   ORDER BY view_names),
         CHR(10) || CHR(10))) AS desc_md
  FROM desc_by_base
  GROUP BY base
),
-- 解析は base ごとに 1 回だけ。結果の JSON をこの段で持っておき、
-- メタデータは JSON から取り出し、HTML は描画の UDF に渡す。
-- JS UDF から別の UDF は呼べないので、この 2 段で合成する。
analyzed AS (
  SELECT
    base,
    `__UDF_ANALYZE__`(
      ARRAY_AGG(STRUCT(view_name, ddl) ORDER BY view_name),
      -- suffixes から組み立てた設定（全行で同じ値）
      (SELECT options_json FROM opts)
    ) AS analysis,
    -- SQL タブ用の素のテキスト。解析結果には積んでいない（描画に要らない
    -- ものを UDF 間の JSON で運ぶと 20 倍の大きさになる）ので、ここで
    -- 別に束ねて描画側へ渡す。カラム定義（columns_json）と同じ形。
    TO_JSON_STRING(ARRAY_AGG(STRUCT(view_name AS v, ddl AS s) ORDER BY view_name))
      AS sql_json
  FROM keyed
  GROUP BY base
),
-- 基準はカードの中のタブで選ぶので、行は base ごとに 1 本。
-- 以前は基準ごとに行を作っていたが、基準が意味を持つのはロジック差分だけで、
-- カラム定義にも参照関係にも基準は無い。差分の側に基準ごとのタブを持たせた
-- ことで、レポートのコントロールも 1 レコードに絞る仕掛けも要らなくなった。
--
-- ref_index / ref_label は列としては残してある。消すとテーブルを作り直す
-- ことになり、積んだ履歴まで消えるため。常に 0 と先頭グループのラベルが入る。
refs AS (
  SELECT
    a.base,
    a.analysis,
    a.sql_json,
    -- 取れなかった base でも描画側が落ちないよう、空の並びを渡す
    COALESCE(bc.columns_json, '[]') AS columns_json,
    -- View に description が無い base もある。その場合は NULL のままにして、
    -- ビュー側でシートのメモだけを出す。
    bd.desc_md AS view_desc_md,
    0 AS ref_index,
    JSON_VALUE_ARRAY(a.analysis, '$.groupLabels')[SAFE_OFFSET(0)] AS ref_label
  FROM analyzed AS a
  LEFT JOIN base_cols AS bc ON bc.base = a.base
  LEFT JOIN base_desc AS bd ON bd.base = a.base
)
SELECT
  CURRENT_DATE('__TZ__') AS snapshot_date,
  base,
  ref_index,
  ref_label,
  CAST(JSON_VALUE(analysis, '$.viewCount')  AS INT64) AS view_count,
  CAST(JSON_VALUE(analysis, '$.groupCount') AS INT64) AS group_count,
  CAST(JSON_VALUE(analysis, '$.groupCount') AS INT64) > 1 AS has_multiple,
  JSON_VALUE_ARRAY(analysis, '$.groupLabels') AS group_labels,
  ARRAY(
    SELECT CAST(x AS INT64)
    FROM UNNEST(JSON_VALUE_ARRAY(analysis, '$.groupSizes')) AS x
  ) AS group_sizes,
  JSON_VALUE_ARRAY(analysis, '$.suffixes') AS suffixes,
  CAST(JSON_VALUE(analysis, '$.unmatchedCount') AS INT64) AS unmatched_count,
  view_desc_md,
  -- どのグループを基準にするかを設定に足して渡す。opts と同じ組み立て方
  -- （先頭の '{' を落として前に足す）にそろえてある。
  --
  -- 描画は 2 段。render がロジック差分のカードを作り、page がそれを受け取って
  -- 参照関係の図・カラム定義の表・View ごとの素の SQL を足し、外側タブで
  -- 1 枚に束ねる。
  -- JS UDF から別の UDF は呼べないので、つなぐのは SQL の仕事。
  `__UDF_PAGE__`(
    analysis,
    `__UDF_RENDER__`(analysis, (SELECT options_json FROM opts)),
    columns_json,
    sql_json,
    (SELECT options_json FROM opts)
  ) AS diff_html
FROM refs
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '生成の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql
USING suffix_list AS suffix_list,
      suffix_tail_lengths AS suffix_tail_lengths,
      suffix_exclude_list AS suffix_exclude_list,
      include_nested_fields AS include_nested_fields,
      analyze_options AS analyze_options;


-- ---------------------------------------------------------------------
-- 2b. メモの差し込み（スケジュールドクエリに登録する本体・その 2）
--
--     素のカード（__T_DIFF_SRC__）に base ごとのメモを繋いで、レポートが読む
--     テーブル（__T_DIFF__）を作る。
--
--     **ここは以前ビューの中でやっていた。** シートを直した内容がその場で
--     出るのが利点だったが、レポートを開くたびにスプレッドシートの外部テーブルを
--     読んで JS UDF（Markdown → HTML）を回し、数 MB の文字列に REPLACE を
--     かけるので遅かった。表示速度を採って焼き込む形に変えてある。
--
--     **シートを直したその場で反映したいときは、このセクションだけを流し直す。**
--     解析も描画もやり直さないので軽い（読むのは __T_DIFF_SRC__ とシートだけ）。
--
--     note タブに出すのは 2 つを繋いだもの。View 自身の description（Markdown）
--     が先で、シートのメモが続く。片方しか無ければそれだけを出す。
--       description  View に付いた正式な説明。デプロイでしか変わらない
--       シート       運用中の補足
--     区切りは水平線。出どころが違うことが読み手に分かるようにする。
--
--     列の説明（OPTIONS）は付けない。SELECT * で受けているので列リストを
--     書くと二重管理になる。素のカード側（__T_DIFF_SRC__）には付けてある。
-- ---------------------------------------------------------------------
SET sql_template = """
CREATE OR REPLACE TABLE `__T_DIFF__`
CLUSTER BY base
OPTIONS (
  description = 'suffix 違い View のロジック グループ比較（メモ差し込み済み。レポートはこれを読む）'
)
AS
WITH notes AS (
  -- base ごとに 1 行に絞る。シートは人が手で足すので、同じ base の行が
  -- 増えることがある。落とすのではなく、いちばん新しいものを採る。
  SELECT
    TRIM(base) AS base,
    note_md,
    SAFE_CAST(updated_at AS TIMESTAMP) AS updated_at,
    updated_by
  FROM `__T_BASE_NOTE__`
  WHERE TRIM(COALESCE(base, '')) != ''
    -- 消さずに下書きへ戻せるようにする。書き方は揺れるので広めに読む。
    AND NOT COALESCE(LOWER(TRIM(is_hidden)) IN ('true', '1', 'yes'), FALSE)
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY TRIM(base) ORDER BY SAFE_CAST(updated_at AS TIMESTAMP) DESC
  ) = 1
),
joined AS (
  SELECT
    d.*,
    -- メモ。未登録なら note_html は「未登録」の枠を返す（NULL にすると
    -- レポート側で「値なし」になり、未登録なのか取得に失敗したのか読めない）。
    n.base IS NOT NULL            AS has_note,
    n.note_md                     AS note_md,
    d.view_desc_md IS NOT NULL    AS has_view_desc,
    -- 空のものを落としてから繋ぐ（そうしないと区切り線だけが残る）。
    -- 改行はエスケープ表記で書けない（テンプレートにバックスラッシュを
    -- 禁じているため。node check_sql.mjs が見張る）ので CHR(10) で組み立てる。
    ARRAY_TO_STRING(
      ARRAY(
        SELECT part
        FROM UNNEST([d.view_desc_md, n.note_md]) AS part
        WHERE TRIM(COALESCE(part, '')) != ''
      ),
      CHR(10) || CHR(10) || '---' || CHR(10) || CHR(10)
    )                             AS note_source_md,
    n.updated_at                  AS note_updated_at,
    n.updated_by                  AS note_updated_by
  FROM `__T_DIFF_SRC__` AS d
  LEFT JOIN notes AS n ON n.base = d.base
),
-- Markdown を HTML にするのは 1 回だけ。カードに差し込む側と、単独で置きたい
-- とき用の note_html で同じものを使う。
rendered AS (
  SELECT
    j.*,
    `__UDF_MARKDOWN__`(j.note_source_md) AS note_html
  FROM joined AS j
)
SELECT
  * EXCEPT (diff_html, ref_index, ref_label, note_source_md),
  -- 作り置きしたカードのメモ タブに、いま読んだメモを差し込む。目印は
  -- chrome.js の NOTE_MARK と同じ文字列（node check_sql.mjs が突き合わせる）。
  REPLACE(diff_html, '<!--VG_NOTE-->', note_html) AS diff_html
FROM rendered
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  'メモ差し込みの SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;


-- ---------------------------------------------------------------------
-- 3. Looker Studio が読むビュー（初回のみ）
--
--    中身は __T_DIFF__ をそのまま返すだけ。**残してあるのは互換のため**で、
--    レポートのデータソースがこのビューを指しているから。テーブルを直接
--    指しても同じものが出る（列も並びも同じ）。
--
--    メモの差し込みはセクション 2b に移した。ビューの中でやっていた頃は、
--    レポートを開くたびにスプレッドシートを読んで JS UDF を回していた。
--
--    基準はカードの中のタブで選ぶので、行は base ごとに 1 本しかない。
--    base のコントロール 1 つで 1 レコードに決まる。
--    **レポートの ref_label のコントロールは外してよい**（値が 1 つしか
--    出てこないため）。
-- ---------------------------------------------------------------------
SET sql_template = """
CREATE OR REPLACE VIEW `__V_DIFF__` AS
SELECT * FROM `__T_DIFF__`
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  'CREATE VIEW の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;


-- ---------------------------------------------------------------------
-- 4. テンプレートに貼る CSS（1 回取れば十分。template_style.html と同じ）
--
--    これだけはコメントのまま。毎回 8 KB の CSS を返しても邪魔なので、
--    必要なときに下の 4 行を外して実行する。
-- ---------------------------------------------------------------------
-- SET sql_template = """SELECT `__UDF_CSS__`(@analyze_options)""";
-- EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
-- ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS 'CSS の SQL に未展開のプレースホルダが残っています。';
-- EXECUTE IMMEDIATE rendered_sql USING analyze_options AS analyze_options;


-- ---------------------------------------------------------------------
-- 5. 確認（ここから下は実行される）
--
--    読むのは __V_DIFF__（= __T_DIFF__ の素通し）なので、セクション 2b まで
--    流したあとの状態を見ることになる。
--
--    それぞれ 1 文ずつ結果が出る。BigQuery の結果タブは番号しか出ないので、
--    どのクエリの結果かが分かるよう先頭に check_name を付けてある。上から順に
--      5-1 生成結果の中身
--      5-2 ロジックが割れている base（＝要確認）
--      5-3 suffix を認識できなかった View
--      5-3b 名前が重複する View（複数のデータセットに同じ名前がある）
--      5-4 実際に使う suffix の一覧
--      5-5 データセット別の対象 View 数
--      5-5b View 名の条件で落ちた View
--      5-6 条件から外れたデータセット
--      5-7 メモの登録状況
-- ---------------------------------------------------------------------

-- 5-1 生成結果の中身
SET sql_template = """
SELECT
  '5-1 生成結果の中身'                AS check_name,
  base                              AS base_view_name,
  view_count                        AS views_in_base,
  group_count                       AS logic_group_count,
  group_labels                      AS logic_groups_by_suffix,
  unmatched_count                   AS suffix_unrecognized_views,
  -- 1 レコードの大きさ。基準ごとのタブを全部載せているので、グループが多い
  -- base ほど大きくなる（比較の枚数は group_count x (group_count - 1)）。
  -- 極端に大きい base が出てきたら、描画側の予算で打ち切られていないか見る。
  LENGTH(diff_html)                 AS diff_html_length_chars
FROM `__V_DIFF__` AS v
ORDER BY base_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-1 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-2 ロジックが割れている base（＝要確認のもの）
SET sql_template = """
SELECT
  '5-2 ロジックが割れている base'      AS check_name,
  base                              AS base_view_name,
  view_count                        AS views_in_base,
  group_count                       AS logic_group_count,
  group_labels                      AS logic_groups_by_suffix
FROM `__V_DIFF__`
WHERE has_multiple
ORDER BY logic_group_count DESC, base_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-2 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-3 suffix を認識できなかった View（単独で 1 行ずつ並ぶ）
SET sql_template = """
SELECT
  '5-3 suffix を認識できなかった View' AS check_name,
  base                              AS unrecognized_view_name,
  LENGTH(diff_html)                 AS diff_html_length_chars
FROM `__V_DIFF__`
WHERE unmatched_count > 0
ORDER BY unrecognized_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-3 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-3b 名前が重複する View（複数のデータセットに同じ名前がある）
--      **この作りは View 名がリージョン内で一意である前提。** base の切り出しは
--      PARTITION BY view_name で 1 本だけ残すので、重複していたらどれか 1 本
--      だけを採る（カラム定義も table_name で畳むので混ざる）。
--
--      4 文字 suffix（_abjp / _cdjp）なら名前にデータセットの区別が入るので
--      衝突しないが、suffix_tail_lengths で 2 文字（_jp）を足すと
--      mart_abjp.v_sales_jp と mart_cdjp.v_sales_jp が同じ名前になり得る。
--
--      **同名 View は作らない運用なら 0 件のはずで、これは見張り。**
--      1 本だけ採る挙動はその前提のうえで許容している（0 件でない状態が
--      続くなら、データセットまで含めた識別に作りを変える必要がある）。
SET sql_template = """
SELECT
  '5-3b 名前が重複する View'           AS check_name,
  table_name                        AS view_name,
  COUNT(*)                          AS dataset_count,
  STRING_AGG(table_schema, ', ' ORDER BY table_schema) AS dataset_names
FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
GROUP BY check_name, view_name
HAVING COUNT(*) > 1
ORDER BY dataset_count DESC, view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-3b の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-4 実際に使う suffix の一覧
--     データセット名から取り出したものと、suffix_tail_lengths で末尾から
--     導出したものを並べて出す。「jp が suffix になっているか」はここで確かめる。
--     除外した値も excluded = TRUE で出す（消えた理由が分かるように）。
--     suffix_list を明示している場合は、ここには出ない（一覧がそのまま使われる）。
SET sql_template = """
WITH
src AS (
  SELECT
    REGEXP_EXTRACT(schema_name, r'__SUFFIX_PATTERN__') AS suffix,
    schema_name
  FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
  WHERE REGEXP_CONTAINS(schema_name, r'__SUFFIX_PATTERN__') AND (__SCHEMA_COND__)
),
listed AS (
  SELECT
    suffix                                             AS suffix,
    'データセット名から'                                 AS suffix_origin,
    STRING_AGG(schema_name, ', ' ORDER BY schema_name) AS detail
  FROM src
  GROUP BY suffix
  UNION ALL
  SELECT
    SUBSTR(s.suffix, -n)                             AS suffix,
    FORMAT('末尾 %d 文字', n)                          AS suffix_origin,
    STRING_AGG(DISTINCT s.suffix, ', ' ORDER BY s.suffix) AS detail
  FROM src AS s, UNNEST(@suffix_tail_lengths) AS n
  WHERE n > 0 AND LENGTH(s.suffix) > n
  GROUP BY suffix, suffix_origin
)
SELECT
  '5-4 実際に使う suffix'                  AS check_name,
  suffix                                  AS effective_suffix,
  suffix_origin                           AS suffix_origin,
  detail                                  AS derived_from,
  suffix IN UNNEST(@suffix_exclude_list)  AS excluded
FROM listed
ORDER BY excluded, effective_suffix
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-4 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql
USING suffix_tail_lengths AS suffix_tail_lengths,
      suffix_exclude_list AS suffix_exclude_list;

-- 5-5 データセット別の対象 View 数
SET sql_template = """
SELECT
  '5-5 データセット別の対象 View 数'   AS check_name,
  table_schema                      AS dataset_name,
  COUNT(*)                          AS target_view_count
FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
WHERE (__VIEW_DATASET_COND__) AND (__VIEW_NAME_COND__)
GROUP BY check_name, dataset_name
ORDER BY dataset_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-5 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-5b View 名の条件で落ちた View（対象のつもりのものが落ちていないか）
--      analysis_include_object_patterns / analysis_exclude_object_patterns が
--      空なら 0 件。
SET sql_template = """
SELECT
  '5-5b View 名の条件で落ちた View'    AS check_name,
  table_schema                      AS dataset_name,
  table_name                        AS excluded_view_name
FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.VIEWS`
WHERE (__VIEW_DATASET_COND__) AND NOT (__VIEW_NAME_COND__)
ORDER BY dataset_name, excluded_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-5b の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-6 条件から外れたデータセット（対象のつもりのものが落ちていないか）
SET sql_template = """
SELECT
  '5-6 条件から外れたデータセット'     AS check_name,
  schema_name                       AS excluded_dataset_name
FROM `__TARGET_PROJECT__.region-__JOB_REGION__.INFORMATION_SCHEMA.SCHEMATA`
WHERE NOT (__SCHEMA_COND__)
ORDER BY excluded_dataset_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-6 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;

-- 5-7 メモの登録状況
--     note_sheet_url が未設定なら全部 FALSE になる（＝テーブルが空）。
--     シートの base を書き間違えるとどの行にも当たらないので、
--     「シートにあるのにビューに出ない base」を最後に別立てで出す。
SET sql_template = """
SELECT
  '5-7 メモの登録状況'                 AS check_name,
  base                              AS base_view_name,
  has_note                          AS note_registered,
  note_updated_at                   AS note_updated_at,
  note_updated_by                   AS note_updated_by,
  LENGTH(note_md)                   AS note_length_chars
FROM `__V_DIFF__`
UNION ALL
SELECT
  '5-7 メモの登録状況（当たらない base）', TRIM(n.base), FALSE,
  CAST(NULL AS TIMESTAMP), CAST(NULL AS STRING), CAST(NULL AS INT64)
FROM `__T_BASE_NOTE__` AS n
WHERE TRIM(COALESCE(n.base, '')) != ''
  AND TRIM(n.base) NOT IN (SELECT base FROM `__V_DIFF__`)
ORDER BY note_registered DESC, base_view_name
""";
EXECUTE IMMEDIATE render_call_sql INTO rendered_sql USING sql_template AS sql_template;
ASSERT NOT REGEXP_CONTAINS(rendered_sql, r'__[A-Z0-9_]+__') AS
  '5-7 の SQL に未展開のプレースホルダが残っています。';
EXECUTE IMMEDIATE rendered_sql;
END;
