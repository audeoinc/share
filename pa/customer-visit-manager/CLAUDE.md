# CLAUDE.md — Campaign Contents Planner(CCP / 配信コンテンツプランナー)(AI コーディングアシスタント向け)

Power Apps Code App(React 19 + TypeScript + Vite + Fluent UI v9)。全体像は [README.md](README.md)、設計の約束事は [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、Dataverse の定義は [docs/DATAVERSE.md](docs/DATAVERSE.md)。作業の前に、この 3 つと [docs/BACKLOG.md](docs/BACKLOG.md) を読むこと。

## 作業の約束

1. **確認してから終わる。** 変更のあとは、必ず次を通す。通らないまま、完了と言わない。
   ```bash
   npx tsc -b
   npx eslint . --ignore-pattern "src/generated/**"
   npm run build
   ```
2. **勝手に反映・公開しない。** `npm run deploy` / `npx pa app push`(共有のアプリの上書き)、`git push`、共有の変更(`pa app share`)、Dataverse のデータの削除は、**人が指示したときだけ**行う。コミットも、指示があったときに行う。
3. **画面の見た目は、確認できていないと正直に伝える。** Power Apps のホスト上では、アプリは別ドメインの iframe の中で動くため、自動操作では確認できないことが多い。「型チェック・lint・ビルドは通った。画面は未確認」のように、確認した範囲を分けて報告する。
4. 小さい変更は、編集ツールで行う。複数ファイルへの一括置換は、スクリプトでもよいが、**改行コード(CRLF / LF の混在)を保つ**こと。
5. `src/generated/` は自動生成。編集しない。テーブルの列を変えたら、`npx pa app add data-source --connector dataverse --table <論理名> --org-url <組織の URL>` で作り直す。
6. **このリポジトリは公開されている。** 組織の URL、パスワード・鍵・トークン、個人のメールアドレス、顧客の実データを、コード・ドキュメント・サンプルデータ・コミットメッセージに、書かない。環境の ID は、ツールが必要とする `power.config.json` だけに置く。
7. 設計や約束事を変えたら、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)(必要なら、このファイル)を更新する。やり残しは [docs/BACKLOG.md](docs/BACKLOG.md) に書く。

## コードの約束

- **UI は Fluent UI v9 のみ**(MUI は使わない)。スタイルは `makeStyles` と `tokens`。色の直書きは避ける(メール・プッシュのプレビュー内の、受信側の見た目だけ例外)。
- **画面の文言は、その場に `t('日本語', 'English')`**(`const t = useT()`)。React の外では `tr(...)`。日本語だけの文言を、画面に書かない。最上位の定数に文言を置かない(関数か getter にする)。日付は `locale()`、価格は `yen(price, market)`、選択肢のラベルは `optionLabel(...)`。
- 商品・メイン画像は、配信カードの国に合う市場のものだけを、AI の選定と検索の対象にする(`poolProducts` / `poolHeroes`)。載せた商品の表示には、全件を使う。
- **AI の呼び出しは `askAgent`(`src/aiSelect.ts`)だけ**を通す。Copilot Studio を直接呼ばない。指示文は日本語で書き、画面が English のときの言い換えは `localizePrompt` が行う。
- 選定した商品の**操作は中ペインだけ**。右端の商品情報(`ProductInfoPane`)は、参照専用で、操作する部品を置かない。
- お知らせの帯は `layout="multiline"`。複数行の入力は `AutoTextarea`。CSS の `zoom` を使うときは、幅を `%` で補正しない。
- コメントは日本語で、**何をしているかより、なぜそうしているか**を書く。既存のコードの密度・書き方に合わせる。
- 文字の階層(ラベル 12px 中太・薄いグレー / 値 12px / 見出し 13px 中太)は、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) の「見た目の約束事」を守る。

## 触る前に知っておくこと

- 標準のテンプレート 10 種はコードに持ち、ユーザーが作ったものは Dataverse(`cr854_layouttemplate`)。`getTemplate(id)` で求める(`EMAIL_TEMPLATES` のような固定の一覧はない)。以前からある標準の 6 種は、**セクションの構成(種類・枠の数・順番)を変えない**(保存済みのカードの、見出し・商品の位置がずれるため。見た目の設定だけ変えてよい)。
- AI の案(テーマ・コピー・制作指示の案、見出し・コピーの候補)は保存しない。保存するのは、採用した内容と、その補足(理由・切り口)。
- チャットの会話は、まだ保存しない(バックログ)。
- 利用者の画面に出る文言・データに、個人情報や機密を、サンプルとして埋め込まない。
