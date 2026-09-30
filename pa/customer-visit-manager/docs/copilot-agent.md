# Copilot Studio エージェント仕様(商品・メイン画像の選定)

アプリ(code app)が `ExecuteCopilotAsyncV2` で呼び出す、公開済みエージェントの仕様。
候補データ(商品・メイン画像)は **アプリが Dataverse から取得してメッセージに直接含める**。エージェントはナレッジ検索やツールを使わず、渡された候補の中から選ぶだけにする。

## 1. エージェントの作成手順(Copilot Studio)

1. Copilot Studio(katada_dev 環境)で **エージェントを作成** → 名前は `配信企画アシスタント` など。
2. **指示**に、下記「3. 指示」をそのまま貼る。
3. **設定 → 生成 AI** がある UI では、次のとおりにする(オーケストレーションは「生成型」にしておく)。「AI と動作」「安全性とアクセス」しかない新しい UI では、この項目はなく既定のままでよい(Web 検索だけ、概要ページの「知識」欄で確認する。モデレーションは「中」でよい)。
   - 「根拠のない応答を許可する」(Allow ungrounded responses): **オンのまま**。このエージェントはナレッジを持たず、メッセージの内容だけで答えるため、オフにすると応答がブロックされる。
   - 「Web からの情報を使用する」(概要ページの「知識」欄の Web 検索も同じ設定): **オフ**。
4. トピックは追加しない(システムトピックは既定のままでよい)。
5. **テスト**パネルで、「4. テスト用メッセージ」を貼って、JSON だけが返るか確認する。
6. **公開**する。
7. **チャネル → Web アプリ**の接続文字列の URL から、エージェント名(`.../bots/{agentName}/conversations` の `{agentName}`、例: `cr3e1_xxxx`)を控える。大文字小文字も含めてそのまま。

## 2. アプリ → エージェント(入力メッセージ)

`message` に次の JSON 文字列を渡す。

```json
{
  "task": "select_products_and_hero",
  "today": "2026-09-30",
  "productCount": 6,
  "card": {
    "name": "Fall Arrivals",
    "scheduledAt": "2026-10-01T10:00:00+09:00",
    "country": "US",
    "channel": "メール",
    "department": "販促",
    "theme": "秋の新作",
    "copy": "Meet the season's new essentials.",
    "instructions": "メインビジュアル1枚+商品3点のグリッド"
  },
  "products": [
    {
      "code": "P01", "name": "ウールコート", "category": "アウター", "price": 29800, "stock": 120,
      "season": "秋冬", "salesTrend": "上昇", "rating": 4.6, "weather": "寒い日",
      "description": "上質なウールを使ったロング丈コート"
    }
  ],
  "heroes": [
    {
      "code": "H01", "name": "秋のコーディネート集合", "purpose": "新作", "season": "秋",
      "tags": "新作,秋,コーディネート,アウター", "description": "秋色のアウターとニットを合わせた全身コーディネート"
    }
  ]
}
```

## 3. 指示(エージェントの「指示」欄に貼る)

```
あなたは、ファッション通販の配信(メール・プッシュ)を企画するアシスタントです。
入力として JSON を受け取り、配信テーマに合う「掲載商品」と「メイン画像」を選び、理由とともに JSON だけで返します。

# 入力
- card: 配信の情報(name, scheduledAt, country, channel, department, theme, copy, instructions)
- productCount: 選ぶ商品の数
- today: 今日の日付
- products: 商品の候補一覧(code, name, category, price, stock, season, salesTrend, rating, weather, description)
- heroes: メイン画像の候補一覧(code, name, purpose, season, tags, description)

# 選定のルール
1. 商品は products の中から、メイン画像は heroes の中からだけ選ぶ。候補にないものを作らない。code は入力のとおりに返す。
2. 商品は productCount 件を選ぶ。同じ code を重複して選ばない。候補が足りなければ、選べた分だけ返す。
3. 配信テーマ(card.theme)との適合を最優先にする。次に card.copy と card.instructions の内容、配信日(scheduledAt)の季節、国とチャネルを考慮する。
4. 在庫(stock)が少ない商品(50 未満)は避ける。やむを得ず選ぶときは、理由に在庫が少ないことを書く。
5. 同じ条件なら、売上トレンドが「上昇」の商品、レビュー評価が高い商品を優先する。売上トレンドが「下降」の商品は避ける。
6. 季節(season)が配信日の季節と合わない商品は避ける。「通年」はいつでも使える。
7. 商品は、カテゴリが偏りすぎないように選ぶ。ただし、テーマが特定のカテゴリ(例:「ブーツ特集」)を指す場合は、そのカテゴリを中心にする。
8. 商品は、訴求したい順(先頭ほど重要)に並べる。先頭はテーマを最もよく表す商品にする。
9. メイン画像は、テーマ、季節、用途(purpose)、タグ(tags)から最も合うものを 1 つ選ぶ。
10. 理由(reason)は日本語で 60 文字以内。テーマとの関係や、在庫・売上トレンド・評価などの根拠を、具体的な数値や語を使って書く。

# 出力の形式
次の JSON だけを返す。前後に説明文、見出し、コードフェンス(```)を付けない。

{"products":[{"code":"P01","reason":"..."}],"hero":{"code":"H01","reason":"..."}}

- 入力の JSON が不正、または card.theme が空のときは、次だけを返す。
  {"error":"理由を日本語で簡潔に"}
- 適切なメイン画像がないときは、"hero" を null にする。
```

## 4. テスト用メッセージ(Copilot Studio のテストパネルに貼る)

```json
{"task":"select_products_and_hero","today":"2026-09-30","productCount":3,"card":{"name":"Fall Arrivals","scheduledAt":"2026-10-01T10:00:00+09:00","country":"US","channel":"メール","department":"販促","theme":"秋の新作","copy":"Meet the season's new essentials.","instructions":"メインビジュアル1枚+商品3点のグリッド"},"products":[{"code":"P01","name":"ウールコート","category":"アウター","price":29800,"stock":120,"season":"秋冬","salesTrend":"上昇","rating":4.6,"weather":"寒い日","description":"上質なウールを使ったロング丈コート"},{"code":"P03","name":"トレンチコート","category":"アウター","price":19800,"stock":200,"season":"秋","salesTrend":"横ばい","rating":4.3,"weather":"雨の日","description":"撥水素材の定番トレンチ"},{"code":"P07","name":"クルーネックニット","category":"トップス","price":9800,"stock":350,"season":"秋冬","salesTrend":"上昇","rating":4.5,"weather":"寒い日","description":"肌触りの良いメリノウールのニット"},{"code":"P20","name":"ムートンブーツ","category":"シューズ","price":17800,"stock":50,"season":"冬","salesTrend":"下降","rating":4.2,"weather":"寒い日","description":"内側ボアで暖かい"},{"code":"P30","name":"ハロウィンギフトセット","category":"ホーム","price":4800,"stock":60,"season":"秋","salesTrend":"下降","rating":4.0,"weather":"晴れ","description":"ハロウィン限定のギフト詰め合わせ"}],"heroes":[{"code":"H01","name":"秋のコーディネート集合","purpose":"新作","season":"秋","tags":"新作,秋,コーディネート,アウター","description":"秋色のアウターとニットを合わせた全身コーディネート"},{"code":"H10","name":"ブラックフライデー","purpose":"セール","season":"秋冬","tags":"ブラックフライデー,大型セール,黒,年末","description":"黒を基調にした大型セール告知"}]}
```

期待する応答の例(P20・P30 は避けられ、H01 が選ばれる):

```json
{"products":[{"code":"P01","reason":"..."},{"code":"P07","reason":"..."},{"code":"P03","reason":"..."}],"hero":{"code":"H01","reason":"..."}}
```

## 5. アプリ側の実装メモ

- 接続: `pa connection create --connector shared_microsoftcopilotstudio`(接続は利用者ごと)。
- データソース: `pa app add data-source --connector shared_microsoftcopilotstudio --connection-id <connectionId>`。
- 呼び出し: `CopilotStudioService.ExecuteCopilotAsyncV2({ message, notificationUrl: 'https://notificationurlplaceholder', agentName })`。
- 応答: `response.data.lastResponse` / `responses[0]` に JSON 文字列。コードフェンスや前後の文が付いても読めるよう、最初の `{` から最後の `}` を切り出して解析する。
- 反映: `products` は配信商品(選定元=AI、理由つき)に、`hero` は配信カードのメイン画像と理由に入れる。ユーザーは反映後にドラッグで入れ替えられる。
