# Airtable × Copilotエージェント連携方式の調査

- 作成日：2026-09-27
- 目的：Copilotのエージェントが推論した結果を、Airtableの配信カードの項目（テーマ・掲載商品・コピー・制作指示など）に設定する方法を、取りうる選択肢としてフラットに洗い出す
- 位置付け：調査結果の整理（特定の方式を推奨するものではない）
- 情報の時点：2026年9月時点の公開情報にもとづく

---

## 0. 前提

### 業務側で決めた前提：AIの回答は「下書き」として扱う
- エージェントの回答は**確定情報とはせず、下書き（ドラフト）として扱う**
- Airtableへの**書き込み自体は可**。ただし書き込み先は下書き用の欄とし、**確定は必ず人が行う**
- このため、以降のすべてのパターンは次のつくりを前提とする
  - カードに**下書き用の欄**（テーマ案・商品案・コピー案・制作指示案など）と、**確定用の欄**を分けて持つ
  - **ステータス欄**で状態を管理する（例：起案待ち → 起案中 → 下書きあり → 修正依頼中 → 確定）
  - 下書きから確定欄への反映（確定操作）は、人の操作でのみ行う

### Copilotのエージェントは2種類あり、できることが大きく違う

| 観点 | Agent Builder（M365 Copilotに含まれる） | Copilot Studio |
|---|---|---|
| 主な用途 | 指示とナレッジを固定したQ&A・文章生成 | Q&Aに加え、外部システムの操作・ワークフロー |
| 外部システムへの書き込み | **できない** | できる（コネクタ、カスタムコネクタ、HTTP、MCP） |
| 自動起動 | できない（人が話しかけて動く） | できる（イベントトリガー、Power Automateからの呼び出し） |
| 追加費用 | なし（M365 Copilotのライセンスに含まれる） | 利用量に応じて課金（契約形態により要確認） |

→ **Airtableへの自動書き込みや自動起動を伴う方式は、Copilot Studioのエージェントが前提**になる。Agent Builderで使えるのは、人が結果を運ぶ方式（下記のP1・P2）に限られる。

### Airtable側で使える主な手段

| 手段 | 概要 | 主な制約 |
|---|---|---|
| REST API | レコードの読み書き。個人アクセストークン（PAT）またはOAuthで認証 | 1ベースあたり毎秒5リクエストまで |
| オートメーション | レコード作成・条件一致・ボタン・定時などをきっかけに処理を実行 | スクリプトの外部通信は30秒が上限（暫定的に120秒へ緩和中） |
| Webhooks API | 変更を外部に通知する | 通知は「変更があった」ことだけ。7日で失効するため定期的な更新が必要 |
| 公式MCPサーバー | MCP対応のAIからレコードの読み書きができる。全プランで利用可 | 通常のAPIのレート制限が適用される。管理者が連携先を許可リストで制御できる |
| Sync API | CSVをAPIで送り、同期テーブルに取り込む | Business／Enterprise Scaleのみ。同期テーブルは手で編集できない。一方向のみ |
| CSVインポート | 画面からCSVを取り込む | 手作業 |

### M365側で使える主な手段

| 手段 | 概要 | 主な制約 |
|---|---|---|
| Power Automate | 定期実行、HTTP受信、ファイル作成などをきっかけに処理 | HTTP受信トリガー・HTTPアクションはPremium。**AirtableのPower Automateコネクタは非推奨**（廃止されたAPIキー認証のため）で、書き込みはHTTPアクション＋PATが基本 |
| Copilot Studioコネクタ「Execute Agent and wait」 | Power Automateやcode appsからエージェントを呼び、応答を受け取る | 呼べるのは公開済みのCopilot Studioエージェントのみ |
| Copilot StudioのMCP対応（GA） | エージェントにMCPサーバーのツールを持たせる | 対応しているのはツールとリソースのみ |
| M365 Copilot connector（Airtable、プレビュー） | Airtableのレコードを取り込み、Copilotから検索・参照できるようにする | **読み取り専用**。AirtableのEnterprise IDが必要 |

---

## 1. 検討の観点（パターンを分ける軸）

トリガー（手動／自動）とインターフェース（ファイル／APIなど）に加えて、次の観点で方式の性格が変わる。

| # | 観点 | 主な選択肢 | 何に影響するか |
|---|---|---|---|
| 1 | **トリガー** | 手動（人がチャット・ボタン）／自動（レコード作成・条件一致・定時） | 自動化の度合い、即時性 |
| 2 | **インターフェース** | 人の手／ファイル（CSV・Excel）／REST API／コネクタ／MCP／iPaaS | 難易度、保守性 |
| 3 | **起点（どちらが呼ぶか）** | Airtable → M365（押し込む）／M365 → Airtable（取りに行く） | 外部からの受け口を公開する必要があるか（セキュリティ） |
| 4 | **エージェントの種類** | Agent Builder／Copilot Studio | 自動化できる範囲、費用 |
| 5 | **書き込み先と反映方法** | **（前提により決定）下書き用の欄に書く**。上書きか履歴を残すかは要検討 | 誤った内容が確定情報に混ざるリスク |
| 6 | **人の確認・承認** | **（前提により決定）書き込み後に人が確認し、人が確定する** | 品質の担保、運用の手間 |
| 7 | **修正指示の出し方** | Airtableの画面内（指示欄＋再生成ボタン／拡張機能）／Airtableから遷移する専用画面／Teams／Copilotのチャット（→第4章） | 使い勝手、実装量、作業の起点との一致 |
| 8 | **入力データの渡し方** | エージェントに探させる／呼び出し側がまとめて渡す | 推論の精度・再現性 |
| 9 | **処理時間の制約** | 応答を待つ（同期）／待たない（非同期） | Airtableスクリプトの30秒制限に当たるか |
| 10 | **認証・ガバナンス** | PAT、OAuth、HTTPトリガーの公開範囲、DLP、MCPの許可リスト | 情シスの承認が必要か、秘密情報の管理 |
| 11 | **ライセンス・費用** | Copilot Studio、Power Automate Premium、Airtableのプラン、iPaaSの契約 | 継続費用 |
| 12 | **運用** | エラー通知、再実行、二重実行の防止（ステータス欄）、レート制限、保守の担い手 | 安定性、属人化 |

---

## 2. 連携パターン一覧（難易度の低い順）

難易度（★）は、開発量・必要なスキル・関係する部署やシステムの数から見た相対的な目安。

| ID | パターン | トリガー | インターフェース | 起点 | エージェント | 修正指示 | 難易度 |
|---|---|---|---|---|---|---|---|
| **P1** | チャットで生成し、人が転記 | 手動 | 人の手 | — | Agent Builder／Studio | チャット | ★ |
| **P2** | エージェントがCSV・Excelを出力し、Airtableに取り込む | 手動 | ファイル（CSVインポート） | — | Agent Builder／Studio | チャット | ★ |
| **P3** | ファイルをSharePointに置き、Power AutomateがAirtableに書き込む | 半自動 | ファイル＋API | M365 → Airtable | Agent Builder／Studio | チャット | ★★ |
| **P4** | ファイルをAirtableのSync APIで同期テーブルに取り込む | 半自動 | ファイル＋Sync API | M365 → Airtable | Agent Builder／Studio | チャット | ★★ |
| **P5** | エージェントに対話で依頼し、エージェント自身がAirtableに書き込む（API） | 手動 | API（カスタムコネクタ・HTTP） | M365 → Airtable | Studio | チャット | ★★ |
| **P6** | P5のツールとしてAirtable公式MCPサーバーを使う | 手動 | MCP | M365 → Airtable | Studio | チャット | ★★ |
| **P7** | Power Automateが定期的にAirtableを確認し、未起案のカードを起案して書き戻す | 自動（定時） | API | M365 → Airtable | Studio | —（P14などと組み合わせる） | ★★ |
| **P8** | P7に、Teamsでの確認・承認を挟む | 自動（定時） | API＋Teams | M365 → Airtable | Studio | Teams | ★★★ |
| **P9** | Airtableのボタン・オートメーションから、Power Automateを呼んで起案・書き戻し | 自動（Airtable起点） | API（HTTPトリガー） | Airtable → M365 | Studio | —（P14などと組み合わせる） | ★★★ |
| **P10** | Airtableから、Copilot Studioのエージェントを自律的に起動し、エージェントが書き戻す | 自動（Airtable起点） | API（イベントトリガー）＋ツール／MCP | Airtable → M365 | Studio | — | ★★★ |
| **P11** | Airtableのスクリプトから、Direct Lineでエージェントを直接呼ぶ | 自動（Airtable起点） | API（Direct Line） | Airtable → M365 | Studio | — | ★★★★ |
| **P12** | AirtableのWebhooks APIで変更を通知し、Power Automateが処理する | 自動（Airtable起点） | Webhook＋API | Airtable → M365 | Studio | — | ★★★★ |
| **P13** | iPaaS（Make・Zapierなど）でAirtableの変更を検知して処理する | 自動（Airtable起点） | iPaaS | 外部サービス経由 | Studio（またはLLMのAPI） | — | ★★ |
| **P14** | Airtable上の「修正指示」欄と再実行ボタンで、再推論して上書きする | 自動＋手動 | API | どちらも可 | Studio | Airtable | ★★★ |
| **P15** | Teamsで下書きを確認し、チャットやカードで修正指示を出す | 自動＋手動 | API＋Teams | M365 → Airtable | Studio | Teams | ★★★★ |
| **P16** | 専用画面（Power Apps code apps）で対話しながら修正し、確定時にAirtableへ書き込む | 手動（画面） | API | M365 → Airtable | Studio | 専用画面 | ★★★★ |
| **P17** | Airtableの画面内に、拡張機能（Interface Extensions）で修正用のパネルを組み込む | 手動（Airtable画面） | API | Airtable → M365 | Studio | Airtable画面内 | ★★★★ |

※前提（第0章）により、どのパターンも書き込み先は下書き用の欄とし、確定は人が行う。

### 参考：Copilotを使わない、または読み取りだけの選択肢

| ID | 選択肢 | 概要 | 位置付け |
|---|---|---|---|
| R1 | Airtable標準のAI（Field Agents） | Airtable内で、レコードの追加・更新をきっかけに項目を自動生成する（AIクレジット制） | Copilotを使わない代替案 |
| R2 | M365 Copilot connector（Airtable） | Airtableのレコードを取り込み、Copilotから検索・参照できるようにする | **読み取り専用**。エージェントがAirtableの内容を参照するための補助手段 |

---

## 3. パターン別の詳細

### レベル0：手作業

#### P1：チャットで生成し、人が転記
- **流れ**：マーケターがCopilot（Agent Builderのエージェントなど）に依頼 → 生成結果を確認 → Airtableの項目にコピー＆ペースト
- **必要なもの**：M365 Copilot（導入済み）
- **長所**：追加の開発・費用がない。すぐに始められる
- **制約・留意点**：転記の手間と転記ミス。件数が増えると負担になる

### レベル1：ファイル経由

#### P2：エージェントがCSV・Excelを出力し、Airtableに取り込む
- **流れ**：エージェントに「カードの項目をCSVで出力して」と依頼 → ファイルをダウンロード → AirtableのCSVインポートで取り込む
- **必要なもの**：ファイルを出力できるエージェント（コードインタープリターなどの機能の有効化状況による）
- **長所**：複数カードを一括で反映できる。開発はほぼ不要
- **制約・留意点**：取り込みは手作業。既存カードの更新（上書き）には、列の対応付けや照合キーの設計が必要

#### P3：ファイルをSharePointに置き、Power AutomateがAirtableに書き込む
- **流れ**：エージェントの出力ファイル（Excel・CSV・JSON）をSharePointに保存 → Power Automateがファイル作成を検知 → 内容を読み取り、AirtableのREST APIでカードを更新
- **必要なもの**：Power Automate Premium（HTTPアクション）、AirtableのPAT
- **長所**：エージェントはAgent Builderでもよい。書き込み処理はPower Automateで一元管理できる
- **制約・留意点**：ファイルの形式を固定する必要がある。ファイルを置く作業は人が行う

#### P4：ファイルをAirtableのSync APIで同期テーブルに取り込む
- **流れ**：エージェントの出力をCSVにする → Power AutomateなどからSync APIへ送る → Airtableの「同期テーブル」に反映 → 配信カードからリンク・ルックアップで参照
- **必要なもの**：AirtableのBusiness／Enterprise Scaleプラン、PAT
- **長所**：Airtableの標準機能で取り込める
- **制約・留意点**：同期テーブルは手で編集できない一方向の同期。配信カード本体の項目に直接書き込む方式ではない。送信は1ベースあたり5分に20回まで

### レベル2：M365側から書き込む（人が起動）

#### P5：エージェントに対話で依頼し、エージェント自身がAirtableに書き込む
- **流れ**：マーケターがCopilot Studioのエージェントに「10/5のカードを起案して」と依頼 → エージェントが推論 → ツール（カスタムコネクタやHTTP）でAirtableのカードを更新
- **必要なもの**：Copilot Studio、Airtable REST API用のカスタムコネクタ（またはPower Automateのフロー）、PAT
- **長所**：対話の中で修正し、納得した時点で書き込める
- **制約・留意点**：書き込むタイミングの判断をエージェントに任せる場合、誤った書き込みの防止策（確認の質問を挟む、下書き欄にだけ書くなど）が必要

#### P6：P5のツールとして、Airtable公式MCPサーバーを使う
- **流れ**：P5と同じ。書き込みにAirtable公式MCPサーバーを使う
- **必要なもの**：Copilot Studio（MCP対応はGA）、Airtable公式MCPサーバーへの接続（OAuthまたはPAT）、Airtable管理者による連携の許可
- **長所**：カスタムコネクタを自作せずに、Airtableの読み書きができる。利用者のAirtable権限の範囲で動く
- **制約・留意点**：Copilot Studioと組み合わせたときの認証方式と動作の検証が必要。APIのレート制限が適用される。MCP経由での操作はエージェントの判断に依存する

### レベル3：自動起動（M365側が起点）

#### P7：Power Automateが定期的にAirtableを確認し、起案して書き戻す
- **流れ**：定期実行（例：15分ごと） → AirtableのAPIで「ステータス＝起案待ち」のカードを取得 → 「Execute Agent and wait」でエージェントを呼ぶ → 応答をHTTPアクションでAirtableに書き戻す → ステータスを更新
- **必要なもの**：Power Automate Premium、Copilot Studio、PAT、Airtable側のステータス欄
- **長所**：外部に受け口を公開しないため、セキュリティ上の論点が少ない。壊れにくい
- **制約・留意点**：即時性は実行間隔による（数分〜）。二重実行の防止（ステータスの管理）が必要

#### P8：P7に、Teamsでの確認・承認を挟む
- **流れ**：P7で生成した下書きを、Teamsの承認機能やアダプティブカードで担当者に送る → 承認されたらAirtableに書き込む（または下書き欄から確定欄へ移す）
- **必要なもの**：P7の一式、Teams承認
- **長所**：人の確認を必ず挟める。確定前の内容がカードに混ざらない
- **制約・留意点**：承認待ちの滞留の扱い。承認時の修正をどう受け付けるか

### レベル4：自動起動（Airtable側が起点）

#### P9：Airtableのボタン・オートメーションから、Power Automateを呼ぶ
- **流れ**：Airtableのボタン、またはレコード作成・条件一致をきっかけにオートメーションを実行 → スクリプトでPower AutomateのHTTPトリガーにPOST → Power Automateがエージェントを呼ぶ → 結果をAirtableに書き戻す
- **必要なもの**：Airtableのオートメーション（スクリプト）、Power Automate Premium（HTTPトリガー）、Copilot Studio、PAT
- **長所**：Airtableの操作から数十秒〜数分で結果が反映される。Airtable側の送信は受付だけで終わるため、30秒制限に当たりにくい
- **制約・留意点**：Airtableから社内のPower Automateを呼べる設定が必要。トリガーの「フローをトリガーできるユーザー」がAnyone（URLの署名だけで呼べる）でないと、Airtableから直接は呼べない。テナント内に限定する場合は、スクリプト側でEntraのトークンを取得する必要がある（クライアントシークレットをAirtable側に置くことになる）。DLPポリシーでHTTPトリガーが禁止されていないかの確認が必要

#### P10：Airtableから、Copilot Studioのエージェントを自律的に起動する
- **流れ**：Airtableのスクリプトからトリガー（Power AutomateのHTTP受信）を呼ぶ → Copilot Studioの自律エージェントがイベントトリガーで起動 → エージェントがツール（カスタムコネクタやMCP）でAirtableに書き戻す
- **必要なもの**：Copilot Studio（イベントトリガー、自律エージェント）、P9と同様のHTTPトリガーの設定、書き込み用のツール
- **長所**：処理の流れをエージェント側に寄せられる
- **制約・留意点**：書き戻しの確実さはエージェントの判断に依存し、フローで書き戻すより制御しにくい。自律実行の費用・監視の設計が必要

#### P11：AirtableのスクリプトからDirect Lineでエージェントを直接呼ぶ
- **流れ**：スクリプトでトークン取得 → 会話開始 → メッセージ送信 → 応答を取得（4段階）→ Airtableを更新
- **必要なもの**：Copilot Studio（Direct Lineのシークレット）、Airtableのオートメーション
- **長所**：Power Automateを介さず、応答をその場で受け取れる
- **制約・留意点**：推論が30秒以内に終わらないとスクリプトが失敗する。シークレットの管理と、4段階の呼び出しの実装が必要

#### P12：AirtableのWebhooks APIで変更を通知する
- **流れ**：Airtableの変更 → Webhookの通知 → Power Automateが差分を取得 → エージェントを呼ぶ → 書き戻す
- **必要なもの**：Webhooks APIの設定と定期的な更新、Power Automate Premium
- **長所**：オートメーションを使わずに変更を検知できる
- **制約・留意点**：通知には変更の中身がなく、差分の取得が必要。Webhookは7日で失効するため更新の仕組みが必要。P9より手間が多い

#### P13：iPaaS（Make・Zapierなど）でAirtableの変更を検知する
- **流れ**：iPaaSがAirtableの作成・更新を標準機能で検知 → LLMのAPI、またはPower Automateを経由してエージェントを呼ぶ → Airtableに書き戻す
- **必要なもの**：iPaaSの契約
- **長所**：Airtableの変更検知と書き戻しが標準機能で組める
- **制約・留意点**：新たな外部SaaSの契約・情報セキュリティの審査が必要。Copilot Studioのエージェントを直接呼ぶ標準の手段は限られ、Power Automateを経由するなどの工夫が必要

### レベル5：修正ループ付き（完全自動＋修正指示）

#### P14：Airtable上の「修正指示」欄と再実行ボタンで再推論する
- **流れ**：自動で書き込まれた下書きを確認 → 修正指示を「修正指示」欄に入力し、再実行ボタンを押す → 前回の下書き＋修正指示をエージェントに送って再推論 → 上書き（P7またはP9の仕組みを流用）
- **必要なもの**：P7またはP9の一式、Airtableの欄（下書き、修正指示、やり取りの履歴）
- **長所**：Airtableの画面だけで、起案 → 修正 → 確定まで完結する
- **制約・留意点**：Airtableの画面はチャットには向かないため、複数回のやり取りは扱いにくい。やり取りの履歴を欄に保存して毎回送る設計が必要

#### P15：Teamsで下書きを確認し、修正指示を出す
- **流れ**：下書きをTeamsのアダプティブカードで通知 → 「承認」または「修正指示」を入力 → 再推論 → 承認時にAirtableへ書き込む
- **必要なもの**：P8の一式、アダプティブカードの設計
- **長所**：普段使っているTeamsの中で確認・修正ができる
- **制約・留意点**：カード上の入力は簡単な指示に向く。商品の入れ替えなど複雑な操作は扱いにくい

#### P16：専用画面（code apps）で対話しながら修正し、確定時にAirtableへ書き込む
- **流れ**：code appで配信カードを開く → エージェントの推奨を確認 → ドラッグで入れ替え、チャットで修正 → 確定時にAirtableのREST APIで書き込む
- **必要なもの**：Power Apps code apps（利用者全員にPower Apps Premium）、Copilot Studio、Airtable用のカスタムコネクタ
- **長所**：候補の入れ替え・プレビュー・チャットなど、柔軟な操作ができる
- **制約・留意点**：開発・保守の負担が最も大きい。Airtableを使い続けたまま画面だけを別に持つ構成になる（データもDataverseに移す案は、別資料「構成の選択肢」のA6を参照）

#### P17：Airtableの画面内に、拡張機能で修正用のパネルを組み込む
- **流れ**：Airtableのインターフェースでカードを開く → 同じ画面内の拡張機能（React）で、修正したい項目を選び、指示を入力 → 拡張機能がPower Automate経由でエージェントを呼ぶ → 返ってきた下書きをパネル上で確認 → 必要に応じて再指示 → 確定ボタンで確定欄に反映
- **必要なもの**：AirtableのInterface Extensions SDK（2026年9月時点ではオープンベータ）、Power Automate Premium、Copilot Studio
- **長所**：Airtableの画面から離れずに、対話的に修正できる
- **制約・留意点**：SDKがベータ版であること。拡張機能から社内のPower Automateを呼ぶため、P9と同じくHTTPトリガーの公開範囲と認証の論点がある。ブラウザから外部を呼ぶ際の制約（CORSなど）の検証が必要

---

## 4. 修正指示のUI（Airtableを作業の起点にする場合）

前提（下書き扱い・人が確定）のもとで、「Airtableで修正したい箇所を選ぶ → その画面上、または自然に遷移した画面で修正を指示 → 返ってきた内容を確認 → 必要に応じて再指示 → 確定してAirtableに戻る」という流れを実現する方法。

| # | 方法 | 画面 | 対話のしやすさ | 実装量 | 主な制約 | 対応するパターン |
|---|---|---|---|---|---|---|
| U1 | **Airtableのインターフェースで完結**：カード詳細に「修正指示」欄と「再生成」ボタン（ボタンからオートメーションを実行）を置く | Airtable（同じ画面） | 低い（1往復ずつ。結果は数十秒後に反映） | 小 | チャットのような連続したやり取りには向かない。反映まで待つ必要がある | P9＋P14 |
| U2 | **Airtableの画面内に拡張機能で修正パネルを組み込む** | Airtable（同じ画面） | 高い | 大 | SDKがベータ版。HTTPトリガーの公開範囲と認証の論点 | P17 |
| U3a | **Airtableのボタンから、エージェントのチャット画面を別タブで開く** → チャットで修正・確認 → 確定の指示でエージェントがPower Automateのフローを呼び、Airtableに書き込む → Airtableに戻る | エージェントのチャット画面（別タブ） | 中〜高（文字のやり取りのみ） | 中 | カードIDの自動受け渡しは公開先によるため要検証。候補の一覧表示やドラッグでの入れ替えはできない | P5・P6の応用 |
| U3b | **Airtableのボタンから、カードIDつきで専用画面（code appsなど）を別タブで開く** → チャット・候補の入れ替え・プレビューで修正・確認 → 確定ボタンでAirtableに書き込む → Airtableに戻る | 専用画面（別タブ） | 高い（チャット、候補の入れ替え、プレビューも可能） | 大 | 画面が2つになる。専用画面の開発・保守が必要。code appsの場合は利用者全員にPower Apps Premium | P16 |
| U4 | **Teamsで確認・修正指示** | Teams | 中（簡単な指示向き） | 中 | 作業の起点（Airtable）から離れる | P15 |

### U3の2つの作り方

#### U3a：エージェントのチャット画面をそのまま使う
```
Airtable（カードの「AIで修正」ボタン）
  → 別タブでエージェントのチャット画面を開く（カードIDを渡す）
  → エージェントがカードの内容と下書きを読み込む（ツール：Power AutomateのフローまたはAirtable公式MCPサーバー）
  → チャットで修正指示 → 結果を確認 → 再指示
  → 利用者が「確定」と明示 → エージェントが書き込み用のフローを呼び、Airtableに書き込む
  → Airtableのタブに戻る（Airtableの画面はほぼリアルタイムで更新される）
```
- **必要なもの**：Copilot Studioのエージェント、読み込み・書き込み用のPower Automateのフロー（エージェントのツールとして登録）、Airtableのボタン（外部URLを開く）
- **長所**：画面の開発が不要。エージェントとフローだけで組める
- **留意点**
  - **カードIDの渡し方**：チャット画面をURLで開いたときに、対象のカードをエージェントへ自動で伝えられるかは、公開先（Teams、Webのチャット画面など）によって異なるため要検証。利用者が最初の発言でIDを伝える運用になる可能性もある
  - **扱えるのは文字のやり取りだけ**：候補の一覧表示、ドラッグでの入れ替え、プレビューはできない
  - **書き込みのタイミング**：エージェントの判断で書き込まないよう、「利用者が確定を明示したときだけフローを呼ぶ」ことを指示とフローの両方で制御する

#### U3b：専用画面（code appsなど）を作る
```
Airtable（カードの「AIで修正」ボタン）
  → 別タブで専用画面を開く（URLにカードIDを付ける）
  → 画面がAirtableからカードを読み込み、エージェントに起案・修正を依頼
  → チャット、候補の入れ替え、プレビューで確認 → 「確定」ボタン
  → Airtableに書き込む（Power Automateのフロー経由、またはコネクタから直接）
  → 「Airtableに戻る」リンクで元のカードへ
```
- **必要なもの**：専用画面（code appsの場合は利用者全員にPower Apps Premium）、Copilot Studioのエージェント、Airtable用のカスタムコネクタまたは書き込み用のフロー
- **長所**：カードIDを確実に受け渡せる。項目の選択、候補の入れ替え、プレビューなど画面を自由に作れる。確定はボタン操作なので、エージェントが勝手に書き込む余地がない
- **留意点**：画面の開発・保守が必要

#### U3a・U3bに共通する点
- **Power Automateで書き込む利点**：AirtableのPATをフローの接続に一元管理できる。書き込み前の形式チェックや、確定した人・日時の記録もまとめて行える
- **Airtableへの戻り方**：元のタブは開いたままなので、書き込んだ内容はAirtableの画面にほぼリアルタイムで反映される
- **書き込み先の選択肢**（前提「確定は人が行う」との関係）

| 選択肢 | 内容 | 長所 | 留意点 |
|---|---|---|---|
| ① 確定欄に直接書き込む | 別タブで利用者が「確定」を明示した時点で、確定欄に書き込む | 手間が少ない。Airtableに戻った時点で完了している | 確定の操作が別タブ側になる。Airtable側では確定の記録（誰が・いつ）を別に残す必要がある |
| ② 下書き欄に書き込み、Airtableで最終確定 | 別タブでは下書きを仕上げるまでとし、Airtableに戻ってから確定ボタンを押す | 確定の操作がAirtableに一本化される。確定前にAirtable上で最終確認できる | 操作が1回増える |

### 設計で考えておくこと
- **修正対象の単位**：項目（テーマ・商品・コピー・制作指示）を選んで、その項目だけを再生成する。他の項目との整合（商品を変えたらコピーも見直すか）の扱いを決めておく
- **やり取りの履歴**：修正の経緯を保存し、再指示のたびに「前回の下書き＋指示＋履歴」をエージェントに渡す
- **待ち時間の見せ方**：ステータス（起案中・修正依頼中）を表示し、反映されたことが分かるようにする
- **確定操作**：確定は人のボタン操作のみで行い、確定した人と日時を記録する
- **同時編集**：同じカードを複数人が同時に修正しないようにする（ステータスでのロックなど）
- **認証の置き場所**：Airtable側（ボタン・拡張機能）から社内のM365を呼ぶ方式（U1・U2）は、外部から呼べる受け口の設定が必要。別タブの画面から呼ぶ方式（U3a・U3b）は、利用者の権限でエージェントを呼び、Airtableへはフローやコネクタ経由で書き込むため、受け口を公開せずに済む（Airtableのボタンは外部URLを開くだけ）

---

## 5. 組み合わせ・段階的な進め方の例

パターンは組み合わせて段階的に進めることもできる（例であり、推奨ではない）。

| 例 | 経路 | 考え方 |
|---|---|---|
| 例1：M365起点で進める | P1 → P5／P6 → P7 → P14 | 受け口を公開せずに、手動から自動へ広げる |
| 例2：Airtable起点で進める | P1 → P9 → P14 | Airtableの操作を起点に、即時性を重視する |
| 例3：確認を重視する | P1 → P7 → P8 → P15 | 人の確認・承認を必ず挟み、Teamsで完結させる |
| 例4：画面を作り込む | P1 → P5 → P16 | 修正のやり取りを専用画面で行う |
| 例5：Airtable起点で別タブに移る | P7またはP9（自動起案）→ U1（軽い修正）＋U3a／U3b（込み入った修正） | 作業の起点と確定の場所をAirtableにそろえ、修正の重さで使い分ける |

**共通して用意しておくとよいもの**
- Airtable側の**ステータス欄**（起案待ち → 起案中 → 下書きあり → 確定）と、**下書き用の欄**（確定欄とは分ける）
- エージェントの**出力形式の固定**（JSONなど）と、書き込み前の形式チェック
- 失敗時の**通知と再実行**の手順

---

## 6. 確認が必要な事項

### 情シス（M365・Power Platform）
- [ ] Power AutomateのHTTPトリガーの「Anyone」設定を使えるか（P9・P10）
- [ ] DLPポリシーで、HTTPトリガー・HTTPアクション・カスタムコネクタが許可されているか
- [ ] Copilot Studioの利用（ライセンス・容量）と、MCPサーバーへの接続が許可されるか（P6）
- [ ] 自律エージェント（イベントトリガー）の利用が許可されるか（P10）
- [ ] iPaaSなど外部SaaSの利用が許可されるか（P13）

### Airtable管理者
- [ ] 契約プラン（Sync APIはBusiness／Enterprise Scaleのみ。オートメーションの実行回数の上限）
- [ ] PATの発行と管理方法（対象ベース・権限を絞れるか）
- [ ] 公式MCPサーバーなど、外部連携の許可リストの設定（P6）
- [ ] Enterprise IDの有無（R2のM365 Copilot connectorを使う場合）

### 業務側
- [ ] 即時性の要件（数分の遅れで困るか）
- [x] AIの回答の扱い → **下書きとして扱い、書き込みは可、確定は人が行う**（第0章）
- [ ] 修正指示をどこで出したいか → Airtableを作業の起点にする方向で検討中（第4章のU1〜U3b）
- [ ] U3の場合、書き込み先をどちらにするか（① 確定欄に直接／② 下書き欄に書き込み、Airtableで最終確定）
- [ ] Airtableのプランと、Interface Extensions（ベータ版）を業務で使ってよいか（U2の場合）

---

## 参考

- [Call Microsoft Copilot Studio agents from Power Automate | Microsoft Learn](https://learn.microsoft.com/en-us/power-automate/call-copilot-studio-agent)
- [Event triggers overview - Microsoft Copilot Studio | Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-triggers-about)
- [Connect your agent to an existing MCP server - Microsoft Copilot Studio | Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent)
- [Model Context Protocol (MCP) is now generally available in Microsoft Copilot Studio | Microsoft Copilot Blog](https://www.microsoft.com/en-us/copilot/blog/copilot-studio/model-context-protocol-mcp-is-now-generally-available-in-microsoft-copilot-studio/)
- [Agent Builder in Microsoft 365 Copilot | Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/agent-builder)
- [Airtable (Independent Publisher) [DEPRECATED] - Connectors | Microsoft Learn](https://learn.microsoft.com/en-us/connectors/airtable/)
- [OAuth authentication for HTTP request triggers | Microsoft Learn](https://learn.microsoft.com/en-us/power-automate/oauth-authentication)
- [Triggering Copilot Studio Agents with HTTP Calls | The Custom Engine](https://microsoft.github.io/mcscatblog/posts/triggering-copilot-studio-http/)
- [Airtable connector overview (preview) - Microsoft 365 Copilot connectors | Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/airtable-overview)
- [Using the Airtable MCP server | Airtable Help Center](https://support.airtable.com/docs/using-the-airtable-mcp-server)
- [Airtable Sync integration: Sync API | Airtable Help Center](https://support.airtable.com/docs/airtable-sync-integration-sync-api)
- [Airtable automation action: Run a script | Airtable Help Center](https://support.airtable.com/docs/run-a-script-action)
- [Guide to Airtable Webhooks | Hookdeck](https://hookdeck.com/webhooks/platforms/guide-to-airtable-webhooks-features-and-best-practices)
- [Using Airtable AI in fields | Airtable Help Center](https://support.airtable.com/articles/8052242094-using-airtable-ai-in-fields)
- [Using buttons in interfaces | Airtable Help Center](https://support.airtable.com/articles/2099494420-using-buttons-in-interfaces)
- [Airtable automation trigger: When a button is clicked | Airtable Help Center](https://support.airtable.com/articles/4600140573-airtable-automation-trigger-when-a-button-is-clicked)
- [New: Interface extensions SDK releasing to open beta | Airtable Community](https://community.airtable.com/announcements-6/new-interface-extensions-sdk-releasing-to-open-beta-46375)
- [Airtable Extensions - Overview | Airtable Support](https://support.airtable.com/docs/airtable-extensions-overview)
