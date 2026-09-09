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
│   └── 03_refresh_reports.sql          集約と fingerprint 次元の再構築（日次、02の後）
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
    └── 07_dry_run.sh                   実行前のスキャン量チェック
```

## クイックスタート

```bash
# 1. 環境構築（初回のみ）。冒頭の SET @@location と [A] ブロックだけ確認する
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
INFORMATION_SCHEMA.JOBS  （履歴 180 日で消える）
   │  02 が日次で増分取り込み。SCRIPT 親を除外して子jobだけを取る
   ▼
bqc_t_job_cost           job 粒度。正規化SQL・fingerprint・参照テーブルを付与
   │  03 が集約
   ▼
bqc_t_daily_cost         日 × fingerprint × 実行者。Looker が読む実体（長期保持）
   │                     ＋ bqc_m_query_fingerprint（first_seen / プレビュー）
   ▼
bqc_vw_t_daily_cost_report   ← Looker Studio のデータソースはこれ 1 本
```

**JOBS は 180 日で消えますが、この3テーブルは消えません。** ここに積むこと自体が、
「いつ最初に現れた SQL か」を 180 日より先まで判定できる唯一の手段です。
`bqc_m_query_fingerprint` は絶対に truncate しないでください。

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
- 時刻はすべて **UTC** です。月次の境界を JST にしたい場合は、02 の `creation_date` を
  `DATE(creation_time, 'Asia/Tokyo')` に変えてバックフィルし直してください。

## 検証状況

| 対象 | 状況 |
|---|---|
| 正規化ロジック | **RE2 実機で 29/29 パス**（`tools/normalize_reference.py`） |
| 埋め込み動的SQLの構文 | **11/11 パース成功**（`tools/check_templates.py`、sqlglot bigquery） |
| BigQuery 実機での実行 | **未実施。** 本セッションに `bq` / `gcloud` と GCP 認証が無いため |

`pipeline/*.sql` は BigQuery スクリプト構文（`BEGIN` / `DECLARE` / `EXECUTE IMMEDIATE`）を
使っているのでファイル全体を静的にパースすることはできません。`tools/check_templates.py` は
動的SQLの中身だけを取り出して検証しています。**実機での初回実行はステージング相当の
プロジェクトか、`initial_lookback_days` を小さくして試すことを推奨します。**

## 単発の調査

パイプラインを立てるまでもない調査は `adhoc/` を使ってください。
INFORMATION_SCHEMA からの推定（01〜04）と、請求データエクスポートからの実額（05〜06）に
分かれています。詳細は各ファイル冒頭のコメントを参照してください。
