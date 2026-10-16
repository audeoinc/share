# share リポジトリ

複数のプロジェクトが同居しています。作業対象のディレクトリを確認してから着手してください。
各ディレクトリの内容は、そこにある README や docs を読んで把握してください
（この文書では、確認していないディレクトリについての断定を避けています）。

## agent/content-generator-api/ を触る場合

コンテンツ生成の開始 / 中断 / 再開 API（FastAPI）。**開発中**です。

**何をするより先に
[`agent/content-generator-api/HANDOVER.md`](agent/content-generator-api/HANDOVER.md)
を最後まで読むこと。**
現在地・設計判断とその理由・次にやること・落とし穴がまとまっています。
文脈をまったく持たない状態から読む前提で書かれているので、これだけで作業を再開できます。

**作業を終える前に、同じ文書を更新してからコミットすること**（更新ルールは文書の 10 章）。

このプロジェクトについては、依頼者が Python に詳しくないことが前提です。
前提知識を置かず、用語をその場で定義して説明してください。

## looker_studio/view_groups/ を触る場合

suffix 違いの View をロジックのグループに分けて Looker Studio に出すツール
（BigQuery の JS UDF ＋ スケジュールドクエリ ＋ Templated Record）。**運用中**です。

**何をするより先に
[`looker_studio/view_groups/README.md`](looker_studio/view_groups/README.md)
を読むこと。** 仕組み・設定・なぜその作りなのかが入っています。
レポートの読み方は `usage.md`、導入の背景は `introduction.md` にあります。

この 3 つは読み手が違うので、**直したときは該当するものだけを直すこと**
（README = 作る人 / usage = 見る人 / introduction = 導入を検討する人）。

押さえておくこと。

- **BigQuery にはこの環境から触れない。** SQL は静的な検証しか通せないので、
  `node check_sql.mjs` などの検証スイート 5 本を必ず走らせる
  （README の「検証スイート」の節）。実行は依頼者が手で貼って行う。
- **デプロイに shell は使えない。** 生成物を手で貼る前提なので、貼る順番が変わる
  変更をしたら手順書（`DEPLOY.md`）も直す。
- **`CSS_GEN` を上げたら UDF とテーブルも作り直しが要る**（番号が CSS と
  カードの markup の両方に入る）。README の同名の節を読むこと。
- Looker Studio のコミュニティ ビジュアライゼーションの中では **JavaScript が
  動かない**。タブはすべてラジオ ＋ CSS で切り替えている。

## 共通の約束

- **日本語**でやりとりする。コード内のコメント・docstring も日本語で書く。
- 抽象的な設計論より、**動く成果物と実際の実行結果**を示す。
- **PR は明示的に求められたときだけ**作る。
