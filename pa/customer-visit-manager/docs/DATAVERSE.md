# Dataverse の定義(テーブル・ロール・フロー・サンプルデータ)

環境: `katada_dev`。接頭辞は `cr854_`。組織の URL は、公開リポジトリには書かない(チームの管理者に聞くか、管理センターの環境の詳細で確認し、以降の `<組織の URL>` に入れる)。
テーブルや列を変えたら、このファイルも更新し、生成コード(`src/generated/`)を作り直してコミットする。

```bash
npx pa app add data-source --connector dataverse --table <論理名> --org-url <組織の URL>
```

## 1. テーブル一覧

### 配信カード `cr854_deliverycard`

| 列(論理名) | 種類 | 内容 |
|---|---|---|
| `cr854_name`(主列) | テキスト | 配信名 |
| `cr854_scheduledat` | 日付と時刻 | 配信日時 |
| `cr854_country` | 選択肢 | 国: US(588230000)/ JP(588230001) |
| `cr854_channel` | 選択肢 | チャネル: メール(588230000)/ プッシュ(588230001) |
| `cr854_department` | 選択肢 | 部署: 販促 / CRM / EC |
| `cr854_status` | 選択肢 | ステータス: 未起案 / 検討中 / 承認済み / 確定 |
| `cr854_theme` | 複数行 | テーマ(配信全体の前提。メールには出ない) |
| `cr854_themereason` | 複数行 | 採用したテーマの AI の理由 |
| `cr854_headline` | テキスト | ヘッドライン(メイン画像に載る大見出し) |
| `cr854_copy` | 複数行 | コピー(ヘッドラインの下の導入文) |
| `cr854_copyangle` | テキスト | 採用したヘッドライン・コピーの切り口 |
| `cr854_instructions` | 複数行 | 制作指示 |
| `cr854_instructionsangle` | テキスト | 採用した制作指示の切り口 |
| `cr854_products` | 複数行 | 掲載商品の名前の一覧(表示用のまとめ) |
| `cr854_heroimage` | 検索(参照) | メイン画像 |
| `cr854_heroreason` | 複数行 | メイン画像の選定理由 |
| `cr854_emailtemplate` | 選択肢 | テンプレート(標準の 6 種。互換のために残す) |
| `cr854_layoutkey` | テキスト(100) | テンプレートのキー(標準は ID、作成したものは行の GUID) |
| `cr854_sectiontitles` | 複数行 | セクションの見出し(改行区切り) |
| `cr854_sectioncopies` | 複数行 | セクションのコピー(JSON の配列) |

### 配信商品 `cr854_deliveryproduct`(カードに載せる商品。1 行 = 1 商品)

`cr854_name`(主列)/ `cr854_deliverycard`(参照)/ `cr854_product`(参照)/ `cr854_sortorder`(並び順)/ `cr854_reason`(選定理由)/ `cr854_source`(AI = 588230000、手動 = 588230001)/ `cr854_state`(選定 = 588230000、候補 = 588230001)/ `cr854_section`(セクション番号)

### 商品 `cr854_product`

`cr854_productcode`(商品コード。JP は P01〜、US は U01〜)/ `cr854_name` / `cr854_category`(アウター・トップス・ボトムス・シューズ・小物・バッグ・ホーム)/ `cr854_price`(JP は円、US はドル)/ `cr854_stock` / `cr854_season`(秋・冬・秋冬・通年)/ `cr854_salestrend`(上昇・横ばい・下降)/ `cr854_rating` / `cr854_weather`(晴れ・雨の日・寒い日)/ `cr854_description` / `cr854_imageurl` / `cr854_market`(JP = 588230000、US = 588230001。空は JP とみなす)

### メイン画像 `cr854_heroimage`

`cr854_imagecode`(H01〜、US は UH01〜)/ `cr854_name` / `cr854_purpose`(新作・特集・セール・会員・イベント)/ `cr854_season` / `cr854_tags` / `cr854_description` / `cr854_imageurl` / `cr854_market`

### 週次実績 `cr854_weeklyperformance`

`cr854_name`(主列。「商品コード 週の開始日」)/ `cr854_productcode` / `cr854_weekstart`(日付のみ。月曜)/ `cr854_units`(販売数)/ `cr854_revenue`(売上。小数点数)/ `cr854_stock`(在庫)

### 販売方針 `cr854_productpolicy`

`cr854_name`(主列。商品コード)/ `cr854_productcode` / `cr854_policy`(MD の販売方針)/ `cr854_promoplan`(販促計画。改行区切り)/ `cr854_promoperiod`(期間のテキスト)/ `cr854_stage`(位置づけ: 主力・定番・在庫調整 など)

### テンプレート `cr854_layouttemplate`

`cr854_name`(主列。テンプレート名)/ `cr854_description` / `cr854_herokind`(standard / collab / offer)/ `cr854_sections`(セクションの JSON: `[{"kind":"grid","slots":4,"categoryHeading":true}]`。kind は grid / feature、slots は 1〜8、columns は grid の列の数で 2(省略時)または 3。3 列・3 点で、横並び 1 行になる)

### AI要求 `cr854_airequest`(AI 呼び出しの仲介。行は、読み取り後に削除される)

`cr854_name`(主列)/ `cr854_prompt`(指示文 + 入力の JSON)/ `cr854_response`(エージェントの返答)/ `cr854_status`(待機中 = 588230000、完了 = 588230001、エラー = 588230002)

## 2. セキュリティロール「配信コンテンツプランナー利用者」

「Basic User」をコピーして作成。アプリを使うユーザー(外部ゲストを含む)に付ける。追加した権限(**想定の一覧。実際の設定は、管理センターで確認し、違いがあれば、この表を直すこと**):

| テーブル | 作成 | 読み取り | 書き込み | 削除 |
|---|---|---|---|---|
| 配信カード、配信商品、AI要求 | ユーザー | ユーザー | ユーザー | ユーザー |
| 商品、メイン画像 | — | 組織 | — | — |
| 週次実績、販売方針 | — | **組織** | — | — |
| テンプレート(layouttemplate) | 組織 | 組織 | 組織 | 組織 |

- **取り込んだ行の所有者は、取り込んだ人**。読み取りの範囲が「ユーザー」だと、他の人には見えない。参照データ(商品、画像、実績、方針)は、必ず「組織」にする。
- 新しいテーブルを追加したら、このロールに権限を足す。

## 3. Power Automate フロー「AI要求の処理」

詳細は [ai-queue.md](ai-queue.md)。要点:

- トリガー: Dataverse「行が追加、変更、または削除されたとき」。種類 = **作成**、テーブル = airequest、スコープ = **組織**。
- アクション 1: Copilot Studio「エージェントを実行して待機する」。エージェント = 配信企画エージェント(`new_cr854_deliveryagent`)、メッセージ = `prompt`。
- アクション 2: 「行の更新」(成功時)。`response` = アクション 1 の最後の応答、`status` = 完了。
- アクション 3: 「行の更新 1」(失敗時)。実行条件は、前のアクションが「失敗」「スキップ」「タイムアウト」のとき。`status` = エラー。
- **フローは、作成者(所有者)の接続で動く**。所有者が不在になると止まるので、本番では、サービス用のアカウントに切り替える。

## 4. サンプルデータ(`docs/*.csv`)の取り込み

文字コードは UTF-8(BOM 付き)。**取り込みの機能**で入れる(テーブルの画面の手入力は使わない)。

| ファイル | 取り込み先 | 内容 |
|---|---|---|
| `products.csv` | 商品 | JP の商品 30 点 |
| `products_us.csv` | 商品 | US の商品 30 点(`market` = US) |
| `hero_images.csv` | メイン画像 | JP の画像 20 点 |
| `hero_images_us.csv` | メイン画像 | US の画像 20 点 |
| `delivery_cards.csv` | 配信カード | 主に US の配信 |
| `delivery_cards_jp.csv` | 配信カード | JP の配信 12 件 |
| `product_weekly.csv` | 週次実績 | 60 商品 × 12 週(720 行) |
| `product_policy.csv` | 販売方針 | 60 行 |

- 既存の商品・画像(P01〜、H01〜)の `market` は空のまま(JP とみなす)。
- 商品の画像 URL は、仮の画像(`placehold.co`)。アプリは、仮の画像のときだけ、同梱のイラスト(`src/assets/products`、`src/assets/heroes`)を使う。実際の画像 URL を入れると、そちらが優先される。

## 5. 環境の設定(ゲストを使う場合)

- Power Platform 管理センター → セキュリティ → ID とアクセス → ゲスト アクセスの管理で、「ゲスト ユーザー アクセスをブロックする」を、**オフ**にする(オンだと、ゲストは開けない)。
- ゲストを使う手順: Entra ID で招待 → 環境にユーザーとして追加 → セキュリティロールを付ける → アプリを共有(`npx pa app share --principal <メール>`)。
