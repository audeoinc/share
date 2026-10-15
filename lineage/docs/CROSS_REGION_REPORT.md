# リージョン横断レポート（1つの Looker Studio データソースに集約する）

> 対象: `sql/pipeline/14_export_report_tables.sql` と
> `sql/pipeline/15_build_cross_region_report.sql`。
> 既存の 01 / 03 の動作は変わりません（03 のクラスタキーのみ変更。後述）。

---

## 1. 何のための仕組みか

01 と 03 はリージョンごとに実行するので、レポート用の static テーブルも**リージョンごとに
別物**です。

```
region-a: lineage_repository.lnge_t_column_usage_impact   ← 03 が作る
region-b: lineage_repository.lnge_t_column_usage_impact   ← 03 が作る
```

1ページで全リージョンを見ようとすると Looker Studio 側でブレンド（UNION）することに
なり、**結合が BI 層で起きるためフィルタがテーブルスキャンまで届きません**。クラスタ
プルーニングが効かず、リージョンを足すほど遅くなります。

そこで**テーブル側で UNION した状態**を作り、Looker Studio はその1テーブルだけを見ます。

```
region-b, region-c …  --14-->  GCS (Parquet)  --15-->  集約リージョン
region-a（集約リージョン自身）  ------------------------>  lineage_report.lnge_t_column_usage_impact
```

**集約リージョン自身は GCS を経由しません。** 自分のテーブルはローカルにあるので、15 が
直接読みます。GCS を通るのは他のリージョンだけです。

## 2. なぜ既存テーブルに相乗りしないのか

03 STEP 4b は `lnge_t_column_usage_impact` を **`CREATE OR REPLACE`** でローカル行だけ
から作り直します。他リージョンの行を同じテーブルに流し込むと、**次の 03 実行で消えます**。
03 は日次で回り、途中で再実行もされるので、「集約 → 03 が走って消える」が普通に起きます。

集約テーブルを別に持つことで、

- 各リージョンのテーブルは**そのリージョンの原子的な正本**のまま
- 集約テーブルは**純粋な派生物**（毎回全置換）
- **03 はリージョン配置を知らなくて済む**（`[A]` に分岐を持ち込まない）

ビュー＝定義 / static テーブル＝派生スナップショット、という既存の役割分担と揃います。

## 3. セットアップ

### 3.1 前提の確認（1回だけ）

**クロスリージョンの `EXPORT DATA` が許可されているか**を先に確かめます。通らない環境では
この構成は成立しません（バケット間コピーが必要になり、SQL だけでは閉じません）。

```sql
-- 送出側リージョンで実行。uri は「集約リージョンの」バケット
EXPORT DATA OPTIONS (
  uri = 'gs://<集約リージョンのバケット>/lineage/probe/*.parquet',
  format = 'PARQUET',
  overwrite = true
) AS
SELECT 1 AS probe;
```

### 3.2 バケット

**集約リージョンに1つ**作ります。送出側は全部ここへ書き込みます。パスは
`<prefix>/<region>/<table>/` に分かれるので、リージョンが互いを上書きすることはありません。

### 3.3 `14_export_report_tables.sql`

**集約リージョン以外の各リージョン**にスケジュールクエリとして登録します。

| `[A]` の変数 | 設定 |
|---|---|
| `repository_dataset` / `table_name_prefix` / `_suffix` | そのリージョンの 01・03 と同じ値 |
| `export_uri_prefix` | 集約リージョンのバケット。末尾スラッシュなし |

冒頭の `SET @@location` をそのリージョンに変えてください。

### 3.4 `15_build_cross_region_report.sql`

**集約リージョン**に1本だけ登録します。

| `[A]` の変数 | 設定 |
|---|---|
| `repository_dataset` | 集約リージョンの 03 の出力先（読むだけ） |
| `report_dataset` | 集約テーブルの置き場所。**`repository_dataset` と別にすること**（ASSERT で検査） |
| `export_uri_prefix` | 14 と**完全に同じ文字列** |
| `remote_regions` | **集約リージョン以外**の全リージョン。自分を入れると二重計上（ASSERT で検査） |

`report_dataset` は 15 が所有するので、無ければ作成します（03 がリポジトリテーブルを
再作成しないのとは逆の方針ですが、こちらは**このスクリプト以外に書き手がいない**ためです）。

### 3.5 Looker Studio

データソースを `lineage_report.lnge_t_column_usage_impact` に向け替えます。**テーブル名は
リージョン版と同じ**なので、フィールド名は変わりません（`source_region` が増えるだけ）。

- **データソースは「テーブル」を選ぶこと。** カスタムクエリにするとフィルタが外側に付き、
  プルーニングが効かなくなる場合があります
- **計算フィールドでフィルタしないこと。** `origin_full_name` のような連結列に条件を
  当てると、式に対する条件になるのでプルーニングは効きません。`origin_dataset` など
  **ネイティブ列**で絞ります

## 4. 実行順と鮮度

```
各リージョン: 03 → 14（export）
集約リージョン: 03 → 15（検査 → 集約）
```

15 は**時刻を信用しません**。実行順の余裕は取るべきですが、それだけに頼ると「あるリージョン
の export が失敗していた」ことに気づけず、古い行がそのままレポートに出ます。

15 は公開前に全ソースを検査します。

| 検査 | 挙動 |
|---|---|
| **ソースの `updated_at` が2種類以上** | **即停止**。03 の1回の再構築は全行同じ `CURRENT_TIMESTAMP()` を持つので、2種類あるのは「2回分の export を読んでいる」＝ export prefix に古いシャードが残っている状態。そのまま公開すると**そのリージョンが二重に出る** |
| **ソースが `max_staleness_hours` より古い** | 既定は**警告のみ**で公開（`fail_on_stale = TRUE` で停止に変更）。`source_region` と `updated_at` は集約テーブルの列なので、レポート上で「どのリージョンが遅れているか」が見える |
| **export が存在しない** | 検査クエリ自体が失敗。**リージョンが黙って欠けるより落ちるほうがよい**ため意図的 |

検査は公開より前に走るので、**失敗しても集約テーブルは前回の内容のまま**です。

## 5. 制約

**全リージョンが同じ 01 / 03 で動いていること。** UNION は `SELECT *` なので、列が1つ
違えば失敗します。`static_tables_include_usage_sql` も揃える必要があります（この値で
`usage_definition_text` / `usage_definition_html` の2列が増減する）。

これは面倒というより**安全側**です。黙って形の違うテーブルができるより、15 が落ちて
気づけるほうがよい。

## 6. クラスタキー（03 の変更点）

03 STEP 4b の static テーブルから **`origin_project` をクラスタキーから外しました**。

```sql
-- 変更前
CLUSTER BY origin_project, origin_dataset, origin_object, origin_column
-- 変更後
CLUSTER BY origin_dataset, origin_object, origin_column
```

**クラスタプルーニングはキーの先頭からの連続した並びで効きます。** 単一プロジェクト運用で
`origin_project` が1値かつフィルタにも使わない場合、それを先頭に置くと**1本目の枠を
無駄にする**ことになります。レポートが実際に絞るのは `origin_dataset` なので、そこを
先頭にします。

集約テーブル（15 が作る側）も同じ順序です。**Looker Studio の体感を決めるのはこちら**で、
03 側の変更は各リージョンで直接 static テーブルを見る用途と export の読み取りに効きます。

> STRING 列を `PARTITION BY` にはできません（partition は DATE/TIMESTAMP/DATETIME 列・
> 取り込み時刻・INT64 範囲のみ）。文字列での絞り込みに効かせる手段は clustering です。

## 7. サイズを先に見ておくこと

`static_tables_include_usage_sql` が既定の `TRUE` だと、`usage_definition_text` /
`usage_definition_html` が**対象オブジェクトの SQL 全文を行ごとに複製**します。ここが
サイズの支配要因で、**export の転送量・GCS 費用・LOAD 時間・集約テーブルのサイズのすべて**に
効きます。レポートで SQL 本文を表示していないなら `FALSE` にしてください。

```sql
SELECT table_name,
       ROUND(SUM(total_logical_bytes)/1048576, 1) AS mb,
       SUM(row_count) AS rows
FROM `project_id.lineage_repository.INFORMATION_SCHEMA.TABLE_STORAGE`
WHERE table_name LIKE '%column_usage_impact%'
   OR table_name LIKE '%object_dependency%'
GROUP BY table_name
```

なお、clustering のプルーニングはブロック単位で切れる程度の大きさがあって初めて効きます。
**全リージョン合計で数百 MB なら、テーブル側 UNION にするだけで体感は解決**し、キー順の
調整は誤差です。

## 8. 未検証

**14 と 15 は BigQuery 実機で未実行です。** オフラインでは次の静的検査のみ通しています
（**単一ブロックのスクリプトにしか通用しない検査**です。03 のように入れ子 BEGIN や
テンプレートの文字列連結、`ARRAY<STRUCT<a, b>>` 型を含むスクリプトでは誤検出が大量に
出るため、03 には当てていません）。

- `FORMAT` のプレースホルダ数と引数数の一致
- `EXECUTE IMMEDIATE ... USING` の名前付きパラメータが対応する SQL で使われていること
  （未使用のパラメータは BigQuery がエラーにする）
- `DECLARE` がブロックの最初の文より前にあること
- `''` をエスケープとして使っていないこと

初回実行時に特に確認したい点：

1. **`EXECUTE IMMEDIATE` で `EXPORT DATA` が実行できるか。** `EXPORT DATA` の `OPTIONS` は
   定数しか受け取らず URI に変数を使えないため、14 は文を組み立てて `EXECUTE IMMEDIATE`
   しています。ここが通らない場合は、URI をリテラル直書きにする（＝リージョンごとに
   ファイルを複製する）必要があります
2. **`overwrite = TRUE` が古いシャードを消すか。** 消さない場合、前回より小さい export の
   あとに余分なシャードが残ります。15 の `updated_at` 検査がこれを検出して停止するので
   事故にはなりませんが、運用上は prefix を事前に空にする手当てが必要になります
3. **外部テーブル越しの `COUNT(DISTINCT updated_at)` の挙動**（Parquet の TIMESTAMP 変換）
