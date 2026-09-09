# BigQuery 実行SQLコストの可視化

実行された SQL のコスト（`total_bytes_billed` と `total_slot_ms`）を
`INFORMATION_SCHEMA.JOBS` から日次で集め、Looker Studio で
「月単位で同じ SQL にいくらかかっているか」「新しくコストを発生させた SQL はどれか」を
確認するための一式です。

```
bigquery-cost/
├── pipeline/                       ← 本体。日次で回す3本
│   ├── 01_setup_cost_environment.sql   データセット・UDF・3テーブル・ビューを作成（初回のみ）
│   ├── 02_load_job_cost.sql            JOBS → bqc_t_job_cost の増分取り込み（日次）
│   └── 03_refresh_reports.sql          集約・fingerprint次元の再構築、刈り取り、
│                                       レポートテーブルの焼き直し（日次、02の後）
├── looker/README.md                Looker Studio の接続手順とレポート構成
├── tools/
│   ├── normalize_reference.py      正規化ロジックの RE2 リファレンス実装＋自己テスト
│   └── check_templates.py          埋め込み動的SQLの構文チェック
└── adhoc/                          パイプラインとは独立した単発調査用クエリ
    ├── 01_query_cost_by_job.sql        ジョブ別のクエリ費用（高い順）
    ├── 02_daily_query_cost.sql         日次推移
    ├── 03_cost_by_user.sql             実行者別
    ├── 04_storage_by_table.sql         テーブル別ストレージ費用
    ├── 05_billing_export_bigquery.sql  請求エクスポートから BQ の実額
    ├── 06_billing_export_all_services.sql  サービス別の実額
    ├── 07_dry_run.sh                   実行前のスキャン量チェック
    ├── 08_inspect_job_hierarchy.sql    親子ジョブ構造の実測（設計確認用）
    ├── 09_top_slot_consumers_of_day.sql   ある1日のスロット消費 上位10（原文SQL＋所属スクリプト）
    └── 10_month_over_month_by_fingerprint.sql  今月 vs 先月（正規化単位、追加/削除/増減＋親）
```

## クイックスタート

> **データセットは事前に用意しておいてください。** `01` はデータセットを作りません
> （作成はインフラチームへの依頼が必要な運用のため）。`repository_dataset` /
> `udf_dataset` が指定リージョンに存在しない場合、`01` は作成せずエラーで停止します。
> 黙って作ってしまうと、データセット名を打ち間違えたときに想定外の場所へ一式ができ
> あがり、しかもエラーにならないので気づけません。
>
> **`01` は破壊的です。** 表を `CREATE OR REPLACE` で作り直すので、流し直すと
> `bqc_t_job_cost` / `bqc_t_daily_cost` / `bqc_m_query_fingerprint` の中身は消えます。
> スキーマ変更を確実に反映させるための意図的な挙動です。流したあとは必ず
> `02` → `03` の順で流し直してください。`02` は表が空なら `initial_lookback_days`
> 分を自動でバックフィルするので元の状態に戻せます（正本は JOBS 側なので、
> 保持期間内であれば失われるものはありません）。
> データセットだけは `CREATE SCHEMA IF NOT EXISTS` のままです。
> `CREATE OR REPLACE SCHEMA` は同居している無関係なテーブルまで消してしまうためです。

```bash
# 1. 環境構築（初回のみ）。冒頭の SET @@location と [A] ブロックだけ確認する
#    表と UDF を別データセットに置く場合は [A] の udf_dataset を 01/02 の両方で揃える
bq query --project_id=audeodb --use_legacy_sql=false < pipeline/01_setup_cost_environment.sql

# 2. 取り込み。表が空なので初回は自動で 120 日バックフィルされる
bq query --project_id=audeodb --use_legacy_sql=false < pipeline/02_load_job_cost.sql

# 3. 集約とディメンションの構築
bq query --project_id=audeodb --use_legacy_sql=false < pipeline/03_refresh_reports.sql
```

2 と 3 をこの順でスケジュールドクエリに登録すれば日次運用になります。
Looker Studio の接続は [`looker/README.md`](looker/README.md) を参照してください。

## データ構成

```
INFORMATION_SCHEMA.JOBS  （履歴 180 日）
   │  02 が日次で増分取り込み。SCRIPT 親を除外して子jobだけを取る
   ▼
bqc_t_job_cost           job 粒度。親 SCRIPT と子文の両方。正規化SQL・fingerprint を付与
   │
bqc_vw_t_job_cost_resolved   親子関係の解決ビュー（job_role / is_cost_countable /
   │                         root_job_id / statement_index）
   │  03 が is_cost_countable の行だけを集約し、保持期間を超えた行を刈り取る
   ▼
bqc_t_daily_cost         日 × fingerprint × 実行者
   │                     ＋ bqc_m_query_fingerprint（first_seen / プレビュー）
   ▼
bqc_vw_t_daily_cost_report   レポート定義の正本（ビュー）
   │  03 が毎回 CREATE OR REPLACE TABLE で焼き直す
   ▼
bqc_t_daily_cost_report      ← Looker Studio のデータソースはこれ 1 本
```

レポートをビューのまま読ませると、開くたびに集約と JOIN が走り、フィルタが計算列
（`is_first_seen_date` など）に当たるためクラスタプルーニングも効きません。中身は
日次でしか変わらないので、`03` が静的テーブルへ焼いています。**列を足したいときは
ビューを直してください。** 次回の `03` でテーブルのスキーマも追従します。
テーブルには `snapshot_at`（焼いた時刻）が付くので、ダッシュボードの鮮度表示に使えます。

### データセットの指定

**どちらも事前に作成されている必要があります。**`01` は存在確認だけを行い、
無ければエラーで停止します（作成はしません）。

表・ビューを置く `repository_dataset` と、UDF を置く `udf_dataset` は
**別々に指定できます**（既定は同じ値）。UDF だけ共有データセットに集約している
運用に合わせるためです。別にする場合は **`01` と `02` の両方**で同じ値に揃えてください。
食い違うと `02` が `Not found: Function` で落ちます。

`01` と `02` の実行結果には解決後の完全修飾名（`normalize_udf` / `job_cost_table`）が
出力されるので、意図した場所を見ているかはそこで確認できます。

### 対象期間と保持期間

**対象は `INFORMATION_SCHEMA.JOBS` が持っている範囲（最大 180 日）だけです。**
それより古い履歴を積み増して保持することは目的にしていないので、`03` が
`retention_days`（既定 180 日）を超えた行を 3 表から削除します。

既定値が 180 なのは JOBS の履歴保持期間と同じだからです。つまり削除されるのは
**JOBS 側でも既に消えている期間だけ**で、元データから作り直せる範囲は失われません。
JOBS より長く持ちたくなったら `03` の `retention_days` を伸ばしてください
（`enable_retention_pruning = FALSE` で刈り取り自体を止められますが、表は際限なく伸びます）。

この方針の帰結として、**「新しくコストを発生させた SQL」は保持期間の中での新規**という
意味になります。それ以前に動いていた SQL でも、保持期間内で初めて現れれば新規として出ます。

## 主要な設計判断

### SQL の正規化と fingerprint

リテラルとコメントを除去した正規化SQLを作り、そのハッシュを識別子にします。

| 列 | 中身 | 用途 |
|---|---|---|
| `raw_fingerprint` | 原文の MD5 | 完全一致の識別 |
| `normalized_fingerprint` | `UPPER(正規化SQL)` の MD5 | **月次の同一SQL集計・新規SQL検出の主キー** |
| `normalized_fingerprint_t` | 上記 + 参照テーブル一覧 の MD5 | 形もテーブルも同じときだけ一致させたい場合 |
| `normalized_preview` | 正規化SQLの先頭100文字 | レポート表示 |
| `normalized_from_preview` | 最初の `FROM` 以降100文字 | 先頭だけだと SELECT 句で終わって識別できないため |

正規化ロジックは `pipeline/01` が作る UDF `bqc_normalize_sql` に実装されています。
実装は `tools/normalize_reference.py` と 1:1 で対応しており、**そちらは BigQuery と
同じ RE2 エンジンで 29 件の自己テストが通ります**。どちらかを直したら両方直してください。

```bash
python3 tools/normalize_reference.py           # 自己テスト
echo "SELECT 1 FROM t WHERE x = 'a'" | python3 tools/normalize_reference.py -
```

**正規化の結果そのものを確かめたいとき**は、`bqc_t_daily_cost` と
`bqc_m_query_fingerprint` の `normalized_query`（全文）を見てください。
次元表のほうが fingerprint あたり1行なので実質の正本で、`daily_cost` 側の同名列は
**開発中に1つの表だけで確かめられるようにした冗長なコピー**です。不要になったら
`01` の daily_cost DDL とその列、`03` STEP 1 の該当行を落としてください。

`daily_cost` には原文 SQL の fingerprint も入れていますが、粒度が違うので形を変えて
います。1 つの `normalized_fingerprint` に対して原文の fingerprint は複数ありうる
（リテラルが違うぶんだけ別物になる）ため、**粒度キーには入れていません**。入れると
日 × リテラル違いで行が膨らみ、正規化した意味が無くなります。

| 列 | 内容 |
|---|---|
| `sample_raw_fingerprint` | 代表1件。`job_cost.raw_fingerprint` で実ジョブに辿る手がかり |
| `distinct_raw_fingerprint_count` | 畳み込まれた原文の異なり数。**大きいほど正規化が効いている指標** |

ロジックを変更したら `normalizer_version` を必ず上げてください。正規化結果が変われば
同じ SQL でも別 fingerprint になるため、この列が無いと履歴の断絶を説明できません。

### バッククォート識別子は既定で「残す」

当初の方針ではバッククォートも `?` に置換する予定でしたが、既定を
**「バッククォート記号だけ外して識別子は残す」**（`mask_backtick_identifiers = FALSE`）に
しています。理由は 2 つです。

1. テーブル名を潰すと `` `p.d.orders_big` `` と `` `p.d.tiny_master` `` が同一
   fingerprint に融合します。「どの SQL が高いか」「新しくコストを出したのはどれか」は
   このレポートの主目的そのものなので、識別力を落とすと成立しません。
2. 置換の動機だった PII 対策は、識別子経由の PII を許容する方針が別途決まったため
   （テーブル名・列名に PII が入りうる点は受容）、ここで潰す必要がなくなりました。

テーブル名にも PII が入りうる環境に移す場合は、`pipeline/01` の
`mask_backtick_identifiers` を `TRUE` にしてください。ただし上記1の副作用と、
スモークテストの期待値の調整が必要です。

### GA4 の日次シャードは畳み込む

`events_20260101` のような `_YYYYMMDD` / `_YYYYMM` サフィックスは `_?` に畳みます。
畳まないと GA4 のクエリが毎日別 fingerprint になり、月次集計が成立しません。
GA プロパティID（`analytics_123456789`）は桁数が違うので影響を受けません。

### 親子ジョブ（SCRIPT と子文）

`bqc_t_job_cost` には **親 SCRIPT と子文の両方**が入っています。親はスクリプト全文・
ラベル・全体の所要時間を持っていて、「このスケジュールドクエリ1本でいくら」という
単位を出すのに要るためです。

ただし実測の結果、**親 SCRIPT の `total_bytes_billed` / `total_slot_ms` は子の合計と
一致します**（親は集計行）。そのまま両方を足すと二重計上になります。

そこで `bqc_vw_t_job_cost_resolved` では、**コスト列を 1 本で持たず 2 系統に分けて**
います。素の `slot_hours` / `tib_billed` などはビューから意図的に外してあります
（原本の値が要るときは `bqc_t_job_cost` を直接見てください）。

| 系統 | 列 | 値が入る行 | 意味 |
|---|---|---|---|
| root | `root_slot_hours` `root_tib_billed` `root_total_slot_ms` `root_total_bytes_billed` | `PARENT` と `STANDALONE` | 作業単位（スクリプト1本／単独クエリ1本）としての消費 |
| statement | `statement_slot_hours` `statement_tib_billed` `statement_total_slot_ms` `statement_total_bytes_billed` | `CHILD` と `STANDALONE` | 実際に計算した文としての消費 |

単独ジョブは両方に同じ値が入るので、次が常に成り立ちます。

```
SUM(root_slot_hours) = SUM(statement_slot_hours) = 総量
```

**どちらの列を合計しても総量は一致し、変わるのは粒度だけです。**
取り込み窓の先頭や保持期間の刈り取りは時刻の途中で切れるため、親だけが落ちて子が
残る「孤児」が端に必ず生じます。root 系は `parent_job_id IS NULL` ではなく
**親の行がこの表に実在するか**で判定しているので、孤児は自分自身が作業単位の代表に
なり、合計から抜け落ちません（`tools/verify_hierarchy_logic.py` で検証しています）。
逆に子が全部消えて親だけ残った場合は root 側にのみ計上されます — 消費自体は実在する
ので、そちらが正しい扱いです。 フィルタの掛け忘れで
壊れないので、フィルタが個々のチャートに散らばる BI ツールから使うときに効きます。
**誤りになるのは 2 つを足したときだけ**です。値の入らない側は 0 ではなく NULL に
してあります（`SUM` は同じ結果になり、`AVG` は構造的なゼロで薄まらないため）。

| 列 | 内容 |
|---|---|
| `job_role` | `PARENT`（子を持つ）/ `CHILD`（親を持つ）/ `STANDALONE` |
| `is_cost_countable` | 葉の行か（＝statement 系に値が入る行）。`NOT has_child_jobs AND statement_type != 'SCRIPT'` |
| `is_root_job` | 作業単位の代表行か（＝root 系に値が入る行）。`NOT has_parent_row` |
| `has_parent_row` | 親の行がこの表に実在するか。孤児の検出に使う |
| `root_job_id` | 作業単位のキー。子なら `parent_job_id`、それ以外は自分の `job_id` |
| `statement_index` | 親の中での実行順。スクリプトのどの文が重いかを見る軸（親・単独は NULL） |
| `root_statement_count` | その作業単位に属する子の本数 |

判定を `02` ではなくビューに置いているのは、`02` が `load_chunk_days` 日ずつに
分けて JOBS をスキャンするためです。親が前のチャンク・子が次のチャンクに落ちると
その時点では親子関係が見えません。表全体が見えるビューで判定すれば、チャンクの
切れ目に影響されません。

`is_cost_countable` を「**葉であること**」で定義しているのも意図的です。
`statement_type != 'SCRIPT'` だけだと、子を持つ別種のジョブ（`CALL` など）が
将来現れたときに素通りします。両方で挟んで安全側に倒しています。

`bqc_t_daily_cost` は葉だけを集める表なので、`statement_*` 系だけを集約しています。
そのため daily_cost 以降のコスト列は 1 本のままで、分ける必要がありません
（親行がそもそも入らないので、二重計上の余地がない）。

**`bqc_t_daily_cost` 以降には集計対象の行しか入りません。** つまり Looker Studio の
利用者は親行に触れないので、二重計上のしようがありません。親を見るのは BigQuery 側で
アドホックに掘るときだけ、という切り分けです。

多段ネスト（親がさらに親を持つ）は実測で 0 件だったため、`root_job_id` は
`parent_job_id` の 1 ホップで解決しています。将来ネストが現れた場合は再帰的な解決が
必要になります。

### 実行者の識別

ジョブラベル `subsystemid` の値、無ければ `user_email` を `executor_id` にします。
どちらから来たかを `executor_source`（`LABEL` / `USER_EMAIL`）に持たせているので、
**LABEL の比率がそのままラベル付与のカバレッジ指標**になります。

ラベルが子ジョブに継承されることは実測で確認済みです（2026-09）。継承されない環境に
移植する場合は、`parent_job_id` で親 SCRIPT のラベルを引く join が必要になります。

### 金額を格納しない

単価はリージョンとエディションで変わるため、金額を格納すると単価改定のたびに
過去データが実態と食い違います。`tib_billed`（TiB）と `slot_hours` を持たせ、
金額は Looker Studio の計算フィールドで掛けてください（`looker/README.md` 参照）。

`pricing_model` 列でオンデマンド（課金の基礎＝バイト）とキャパシティ（＝スロット）を
切り分けられます。**この2つを1つの合計に混ぜないでください。**

## 既知の限界

- **正規化は字句解析ではありません。** コメントを文字列より先に除去しているため、
  文字列リテラルの中に `--` を含む稀なクエリでは fingerprint が本来より粗くなります
  （コメント中のアポストロフィのほうが圧倒的に多く、逆順にすると害が大きいため）。
  コスト額の集計そのものには影響しません。より厳密にしたい場合は、lineage の
  `lnge_fingerprint_sql`（Lexer ベースの JS UDF）に差し替えられます。その場合も
  `normalizer_version` を上げてください。
- **`edition` 列は取っていません。** 環境によって存在しない可能性があるため、
  オンデマンド／キャパシティの切り分けは `reservation_id` の有無で行っています。
  自環境の JOBS に `edition` があるなら列を追加してください。
- **`bqc_t_job_cost.query` に原文を保持しています。** PII を含みうるので、
  不要になった時点でこの列だけ落としてください（fingerprint は残るので分析は継続できます）。
- **単一リージョン運用です。** 別リージョンも見る場合は各スクリプト冒頭の
  `SET @@location` を変えて再実行します。`job_region` 列で混在して蓄積できます。
- **`retained_*` 列は保持期間内の合計**であって通算値ではありません。刈り取りが
  走ると値は減ります。
- 時刻はすべて **UTC** です。月次の境界を JST にしたい場合は、02 の `creation_date` を
  `DATE(creation_time, 'Asia/Tokyo')` に変えてバックフィルし直してください。

## 検証状況

| 対象 | 状況 |
|---|---|
| 正規化ロジック | **RE2 実機で 29/29 パス**（`tools/normalize_reference.py`） |
| 動的SQLの構文 / DECLARE の位置 / LIMIT が定数か / DDL と INSERT 列の整合 | **39/39 パス**（`tools/check_templates.py`、sqlglot bigquery。pipeline と adhoc の両方） |
| 親子分類の不変条件 | **6/6 パス**（`tools/verify_hierarchy_logic.py`、`SUM(root)=SUM(statement)` を孤児込みで検証） |
| BigQuery 実機での実行 | **未実施。** 本セッションに `bq` / `gcloud` と GCP 認証が無いため |

`pipeline/*.sql` は BigQuery スクリプト構文（`BEGIN` / `DECLARE` / `EXECUTE IMMEDIATE`）を
使っているのでファイル全体を静的にパースすることはできません。`tools/check_templates.py` は
動的SQLの中身だけを取り出して検証しています。**実機での初回実行はステージング相当の
プロジェクトか、`initial_lookback_days` を小さくして試すことを推奨します。**

## 単発の調査

パイプラインを立てるまでもない調査は `adhoc/` を使ってください。
INFORMATION_SCHEMA からの推定（01〜04）と、請求データエクスポートからの実額（05〜06）に
分かれています。詳細は各ファイル冒頭のコメントを参照してください。
