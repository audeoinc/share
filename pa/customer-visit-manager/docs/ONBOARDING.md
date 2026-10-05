# 新しいメンバーの手順(オンボーディング)

途中から参加する人が、同じように開発を進められるようにするための手順。

## 1. 先に必要な権限(管理者に依頼)

| 対象 | 内容 |
|---|---|
| GitHub | リポジトリ `hiroshikatada/share` への書き込み権限(コラボレーターに招待) |
| Power Platform の環境 | `katada_dev` への参加と、**環境メーカー**(Environment Maker)のロール。アプリを開発・反映するため |
| Dataverse | 環境のユーザーとして追加し、セキュリティロール **「配信コンテンツプランナー利用者」**(動作確認用)を付ける。テーブルの定義を触る人は、さらに管理者権限 |
| Power Apps | 開発用のライセンス(Developer プラン、または従量課金の対象) |
| Copilot Studio | AI のエージェントを直す人だけ、`katada_dev` のエージェントの編集権限。アプリを開発するだけなら不要(AI の呼び出しは、フロー経由) |

## 2. 環境を整える

1. **Node.js** をインストールする(動作確認済み: Node 24、npm 11)。
2. リポジトリを取得する。
   ```bash
   git clone https://github.com/hiroshikatada/share.git
   cd share/pa/customer-visit-manager
   npm ci
   ```
3. **Power Platform CLI(`pa`)** で、サインインする。CLI は、`@microsoft/power-apps-cli` として、開発用の依存関係に入っている(`npx pa ...` で使える)。
   ```bash
   npx pa auth login      # ブラウザが開くので、Microsoft Entra ID でサインイン
   npx pa auth status     # サインインしたアカウントの確認
   ```
   接続先の環境は、`power.config.json` の `environmentId`(`katada_dev`)から決まるので、別途の選択は不要。使えるコマンドは、`npx pa --help` と `npx pa app --help` で確認できる。
4. 動かして確認する。
   ```bash
   npx pa app run        # 表示される URL(Power Apps のホスト上)を、ブラウザで開く
   ```
   カレンダーに、配信カードが表示されれば成功。
5. コミット前の確認が通ることを確かめる。
   ```bash
   npx tsc -b && npx eslint . --ignore-pattern "src/generated/**" && npm run build
   ```

## 3. 最初に読むもの

1. [README.md](../README.md) — 全体像とディレクトリ
2. [ARCHITECTURE.md](ARCHITECTURE.md) — 設計の約束事(日英の書き方、AI の仕組み、落とし穴)
3. [DATAVERSE.md](DATAVERSE.md) — テーブルとフロー
4. [BACKLOG.md](BACKLOG.md) — いま何が終わっていて、何が残っているか

## 4. チームの進め方

**ブランチと取り込み**
- `main` は、常にビルドが通る状態にする。作業は、ブランチ(`feature/○○`、`fix/○○`)で行い、プルリクエストで `main` に取り込む。
- コミットの前に、「型チェック → lint → ビルド」を通す(上の 2-5)。
- 1 つのコミット・プルリクエストは、1 つのまとまった変更にする。コミットメッセージは、変更の目的が分かる文にする(英語でも日本語でもよい)。

**共有のアプリへの反映(`npm run deploy`)**
- 共有のアプリは **1 つ**。`pa app push` は、そのアプリを上書きする。**複数人が好きなタイミングで push すると、他の人の変更を消してしまう。**
- そのため、次の約束にする。
  1. 日々の開発・動作確認は、**`npx pa app run`**(ローカルのコードを、Power Apps のホスト上で動かす)で行う。push は不要。
  2. 共有のアプリへの反映は、**`npm run deploy`** で行う。`main` にいて、リモートと同じで、未コミットの変更がないときだけ動き、型チェック・lint・ビルドを通してから、`pa app push` する(`scripts/deploy.mjs`)。**`pa app push` を、直接は実行しない。**
  3. **反映できる人は、複数人にしてよい**(権限が必要。下の「反映する人に必要な権限」)。反映する人は、プルリクエストが `main` にマージされたら、チームに声をかけてから、`npm run deploy` を実行する。同じコミットは、反映し直さない(スクリプトが止める)。
  4. 反映したあとは、スクリプトが、**タグ `deployed/日時`**(誰が・どのコミットを反映したか)を GitHub に送る。`git tag --list "deployed/*"` で、反映の履歴を見られる。次の人は、前回の反映が表示されるので、続きから進められる。
- **反映する人に必要な権限**(2 つ):
  1. Power Platform の環境 `katada_dev` の**環境メーカー**のロール。
  2. 共有のアプリへの**編集権限**。アプリの所有者(または、編集権限を持つ人)が、次を実行して付ける。
     ```bash
     npx pa app share --principal <メールアドレス> --access edit
     ```
     (`--access play` は、アプリを使うだけの権限。反映には、`edit` が必要。)
- プルリクエストと `main` には、GitHub Actions(`.github/workflows/ci.yml`)が、型チェック・lint・ビルドを自動で行う。失敗したプルリクエストは、マージしない。
- 自動で反映しない理由: `pa` CLI のサインインは、ブラウザ(または端末コード)でのユーザーのサインインのみで、サービスアカウントでの自動サインインがないため。
- 利用者に見せるデモの直前は、反映しない期間(凍結)を決めておく。

**Dataverse(テーブル・列・フロー)を変えるとき**
- テーブルや列の変更は、環境全体に効く。変更の前に、チームに知らせる。
- 変更したら、`npx pa app add data-source --connector dataverse --table <論理名> --org-url https://org1d7a6175.crm7.dynamics.com` で、生成コード(`src/generated/`)を更新し、**その差分もコミットする**。
- 定義は [DATAVERSE.md](DATAVERSE.md) に反映する。

**ドキュメントの更新**
- 設計の約束事が変わったら、[ARCHITECTURE.md](ARCHITECTURE.md)(と、必要なら [CLAUDE.md](../CLAUDE.md))も更新する。
- 検討事項や、やり残しは、[BACKLOG.md](BACKLOG.md) に書く。

## 5. AI コーディングアシスタント(Claude Code など)を使う場合

- リポジトリの [CLAUDE.md](../CLAUDE.md) に、コードの約束事と、確認の手順が書いてある。アシスタントは、これを読んで作業する。
- アシスタントが、`pa app push` や `git push` を勝手に行わないよう、**反映と push は、人が指示したときだけ**にする(CLAUDE.md にも書いてある)。

## 6. よくある困りごと

| 症状 | 対処 |
|---|---|
| 画面に「古いバージョン」と出る | 「最新の情報に更新」を押す |
| 外部ユーザー(ゲスト)が開けない(0x80095fcd など) | 管理センターで、環境の「ゲスト アクセスのブロック」を解除する |
| カレンダーが空 | セキュリティロールが付いているか確認する |
| AI が、3 分待っても返らない | Power Automate のフロー「AI要求の処理」がオンか、実行履歴に失敗がないか確認する([ai-queue.md](ai-queue.md)) |
| 商品情報のグラフが「実績はまだありません」 | 週次実績・販売方針のテーブルにデータを取り込んだか、ロールの読み取り(範囲: 組織)があるか確認する |
