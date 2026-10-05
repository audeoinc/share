# 配信コンテンツプランナー

メール・プッシュの**配信コンテンツ**(テーマ、メイン画像、ヘッドライン・コピー、セクションごとの商品、制作指示)を、AI の提案を選びながら企画するアプリ。
Power Apps **Code App**(React + TypeScript + Vite)で、データは **Dataverse**、AI は **Copilot Studio** のエージェント(Power Automate 経由)。
US チームと JP チームが、日本語・英語のどちらでも使える。

- 開発環境(Power Platform): `katada_dev`(環境 ID は `power.config.json` の `environmentId`)
- Dataverse の組織: `https://org1d7a6175.crm7.dynamics.com`
- 新しく参加する人は、まず **[docs/ONBOARDING.md](docs/ONBOARDING.md)** を読む。

## 主な機能

- 配信カレンダー(月表示。国・チャネル・部署・ステータスで絞り込み)
- 配信カードの編集: 4 ペイン(配信情報 / コンテンツ生成 + AI チャット / プレビュー / 商品情報)
- AI による案づくり: テーマ、テンプレート、メイン画像、ヘッドライン・コピー、セクションの見出し・コピー・商品、制作指示。「すべてAIで下書き」、開いたときの自動下書き、AI チャット
- メール・プッシュのプレビュー(ドラッグ&ドロップで商品の並べ替え)
- 商品情報(売上・在庫の推移のグラフ、MD の販売方針・販促計画)
- テンプレートの管理(標準 6 種 + ユーザーが作成)
- 日本語 / English の切り替え。US / JP の商品を、配信カードの国で自動的に使い分け

## 技術スタック

React 19 / TypeScript / Vite 7 / **Fluent UI v9**(Fluent 2。MUI は使わない)/ `@microsoft/power-apps`(Dataverse 接続の生成コード)/ フォント: Inter + Noto Sans JP(同梱)

## 開発の始め方

```bash
npm ci                 # 依存関係のインストール
npm run dev            # Vite の開発サーバー(Dataverse には繋がらない。画面の枠の確認用)
npx pa app run         # Power Apps のホスト上でローカルのコードを動かす(Dataverse に繋がる。通常の開発はこちら)
```

確認(コミットの前に、必ず通す):

```bash
npx tsc -b                                        # 型チェック
npx eslint . --ignore-pattern "src/generated/**"  # lint
npm run build                                     # ビルド
```

## 配信(共有の開発用アプリへの反映)

```bash
npm run deploy
```

`main` に取り込まれた変更を、共有のアプリ(`power.config.json` の `appId`)に反映する。**反映してよい状態のときだけ**動く安全装置つき(`scripts/deploy.mjs`): `main` にいる / リモートと同じ / 未コミットの変更がない → 型チェック・lint・ビルド → `pa app push`。
共有のアプリは 1 つで、`pa app push` は上書きになる。反映は、**最新の `main` から、反映の権限を持つ人が行う**(詳しくは [docs/ONBOARDING.md](docs/ONBOARDING.md) の「チームの進め方」)。
反映後、画面に「古いバージョン」と出たら、「最新の情報に更新」を押す。

GitHub Actions(`.github/workflows/ci.yml`)が、`main` への push とプルリクエストで、型チェック・lint・ビルドを自動で行う。`main` へは、PR なしで直接 push してよい(push の前に `npm run verify`)。自動で反映はしない(`pa` CLI は、ブラウザでのサインインが必要なため)。

## ディレクトリ

| パス | 内容 |
|---|---|
| `src/App.tsx` | 画面の入口。ヘッダー、フィルター、カレンダー、テンプレート管理の読み込み |
| `src/CardDetail.tsx` | 配信カードの編集(4 ペイン、保存、AI の下書きの起動) |
| `src/ContentPane.tsx` | 中ペイン(テーマ・テンプレート・ヒーロー・セクション・制作指示のタブ、AI チャット) |
| `src/ChatPanel.tsx` | AI チャットの画面 |
| `src/Preview.tsx` | メール・プッシュのプレビュー |
| `src/ProductInfoPane.tsx` / `ProductDetail.tsx` / `MiniChart.tsx` | 商品情報の一覧、詳細のフロート、グラフ |
| `src/TemplateManager.tsx` / `TemplateThumb.tsx` | テンプレートの管理画面と見取り図 |
| `src/aiSelect.ts` / `aiDraft.ts` / `autoDraft.ts` / `useAiDrafts.ts` | AI の呼び出し、指示文(プロンプト)、結果の整形 |
| `src/templates.ts` / `layoutTemplates.ts` | テンプレートの登録(標準 + Dataverse)、読み書き |
| `src/i18n.ts` | 日英の切り替え(`tr` / `useT` / `optionLabel` など) |
| `src/generated/` | **自動生成**(`pa app add data-source` が作る)。手で編集しない |
| `docs/` | ドキュメントと、サンプルデータ(CSV) |

## ドキュメント

- [docs/ONBOARDING.md](docs/ONBOARDING.md) — 新しいメンバーの最初の手順、チームの進め方
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 構成、AI の仕組み、設計の約束事、落とし穴
- [docs/DATAVERSE.md](docs/DATAVERSE.md) — テーブルと列、セキュリティロール、フロー、サンプルデータの取り込み
- [docs/ai-queue.md](docs/ai-queue.md) — AI 呼び出し(テーブル + フロー)の詳細
- [docs/copilot-agent.md](docs/copilot-agent.md) — Copilot Studio のエージェントの仕様
- [docs/BACKLOG.md](docs/BACKLOG.md) — 検討事項と、状況メモ
- [CLAUDE.md](CLAUDE.md) — AI コーディングアシスタント(Claude Code など)向けの指示書
