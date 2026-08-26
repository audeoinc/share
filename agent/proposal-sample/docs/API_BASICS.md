# API通信の基礎 — JSからPythonを呼び、データを受け取る仕組み

> 対象読者: HTML/JS（`index.html` が `app.js` を読み込む、くらい）は分かるが、
> **「app.js から API を呼んでデータを取得する」「サーバ側で Python を動かし、
> それを API 経由で JS に渡す」** 部分が未経験の人。
>
> このリポジトリの実コード（`web/app.js` / `server/main.py` / `server/pipeline.py`）を例に、
> いちばん基礎の考え方から説明します。

---

## 0. まず、いちばん大事な1つの絵

これまで書いてきた JS は「**1つのブラウザの中**」で完結していました。
API 通信になると、登場人物が **2つの別々のプログラム** になります。

```
[ブラウザ] ← app.js が動く（あなたの画面）
    │
    │  ← この間は「ネットワーク」。手紙を送り合う関係。
    ▼
[サーバ]   ← Python が動く（別のコンピュータ／別プロセス）
```

- この2つは **別の場所で動く別プログラム** で、**メモリを共有できません**。
  JS の変数を Python が直接読む、といったことは絶対にできません。
- だから両者は「**手紙（テキスト）を送り合う**」ことでやり取りします。
  - 手紙の **送り方のルール** ＝ **HTTP**
  - 手紙の **中身の書式** ＝ **JSON**

> **API通信 ＝「別プログラムに手紙(HTTPリクエスト)を送り、返事(HTTPレスポンス=JSON)をもらうこと」**

これが腑に落ちれば9割終わりです。

**レストランの比喩**
- あなた（app.js）＝ 客席の注文係
- 注文票を厨房へ出す ＝ **HTTPリクエスト**
- 厨房（Python）＝ 実際に料理を作る
- 料理が配膳される ＝ **HTTPレスポンス**
- 注文票・伝票の共通フォーマット ＝ **JSON**

---

## 1. 「APIをcallする」の正体

普段ブラウザで URL を開くと **HTMLページ** が返ってきます。
API は同じ仕組みで、URL を叩くと **ページの代わりにデータ（JSON）** が返るだけです。

| URL | 返るもの |
|---|---|
| `http://…/` | HTML（画面） |
| `http://…/api/customers` | **顧客データ（JSON）** |

つまり「API を call する」＝「**データが返ってくる URL に、HTTPリクエストを送る**」。
特別なことではなく、**URLアクセスの一種** です。

**HTTPリクエスト（出す手紙）の中身**
- **メソッド**: `GET`（ちょうだい）/ `POST`（これを渡すから処理して）
- **URL**: どの窓口か（`/api/customers`）
- **本文(body)**: POST のとき付ける材料（JSON）

**HTTPレスポンス（返事）**
- **ステータス**: 200（成功）/ 404（無い）/ 401（認証必要）…
- **本文**: JSON のテキスト

---

## 2. サーバ側：Python は「ずっと立っている受付」

ここが未経験の核心です。ポイントは：

> **サーバの Python は「1回実行して終わるスクリプト」ではなく、
> 「ずっと起動しっぱなしで、手紙(リクエスト)が来るのを待ち続けるプログラム」**

これを実現しているのが **uvicorn** というプログラムです。
`uvicorn server.main:app` で起動すると、uvicorn は **指定ポートで待機し続け**、
リクエストが来るたびに、対応する Python 関数を呼びます。

そして「**URL → どの関数を呼ぶか**」の対応表を作っているのが **FastAPI**（`@app.get(...)` などのデコレータ）。

このリポジトリで `/api/customers` が来たときに呼ばれる関数（`server/main.py`）：

```python
@app.get("/api/customers")     # ← 「GET /api/customers が来たらこの関数」
def api_customers():
    return tools.list_customers()   # ← Python の list/dict を返すだけ
```

`list_customers()` は最終的に `proposal_app/store.py`（メモリ上の顧客データ）を返します。

**ここが変換の要**：関数は Python の `list`/`dict` を `return` するだけ。
でもブラウザに送るにはテキストにしないといけない。
→ **FastAPI が自動で「Python の dict → JSON テキスト」に変換** してレスポンスに詰めてくれます。
あなたは変換コードを書かなくてよい。

---

## 3. JS側：fetch で手紙を出し、返事を待つ

ブラウザ側で「手紙を出して返事を受け取る」道具が **`fetch`** です。
このリポジトリの共通ヘルパー（`web/app.js`）：

```js
async function api(path, options) {
  const res = await fetch(path, options);   // ① 手紙を出して、返事が来るまで待つ
  if (!res.ok) {                            // ② 200番台でなければ失敗扱い
    const t = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${t}`);
  }
  return res.json();                        // ③ 返ってきたJSONテキストをJSオブジェクトに変換
}
```

3つのキーワードだけ押さえればOK：

- **`fetch(path)`** … 指定URLへ HTTPリクエストを送る。
- **`await`** … 「返事が来るまでここで待つ」。ネットワークは時間がかかる（相手は別マシン）ので、
  **待つ** 必要がある。`await` を使う関数は `async function` にする、というセット。
- **`res.json()`** … 返ってきた **JSONテキスト** を **JSのオブジェクト** に変換（パース）。
  ここで初めて `customers[0].name` のように普通に使えるようになる。

呼ぶ側：

```js
const customers = await api("/api/customers");  // customers は JSの配列になっている
// → これを使って画面（顧客一覧）を組み立てる
```

---

## 4. いちばん大事な「JSON という共通言語」

Python と JS は別言語なので、オブジェクトをそのまま渡せません。
間を橋渡しするのが **JSON**（テキスト形式のデータ表現）。

```
Python 側                     ネットワークを流れるもの          JS 側
[{"id":"C001","name":"..."}]  →  '[{"id":"C001","name":"..."}]'  →  [{id:"C001", name:"..."}]
  Python の list/dict            ただのテキスト(JSON)              JS の配列/オブジェクト
   ↑ FastAPIが変換                （手紙の中身）                    ↑ res.json() が変換
```

- Python 側：`dict/list` → **JSON文字列**（FastAPIが自動）
- JS 側：**JSON文字列** → `object/array`（`res.json()`が自動）

**両端が自分の言語のオブジェクトに変換してくれる** ので、あなたは
「Python では dict を返す」「JS では `.json()` で受ける」だけでよい。
これが言語の壁を越える仕組みの正体です。

---

## 5. 実際の1往復を通しで（顧客一覧）

```
① [app.js] await api("/api/customers")
        └ fetch が HTTPリクエストを送る:  GET /api/customers
                    │ （ネットワーク）
② [uvicorn] ポートで待機中 → このリクエストを受信
        └ 認証ミドルウェア(gatekeeper)を通過（Basic認証OK）
        └ FastAPI が対応表を見て api_customers() を呼ぶ
③ [Python] api_customers() 実行
        └ tools.list_customers() → store.py のメモリから顧客リスト取得
        └ return [ {id:"C001", name:"…"}, … ]   ← Python の list
④ [FastAPI] その list を JSONテキストに変換し、レスポンスに詰める
        └ 200 OK + body: '[{"id":"C001",...}, ...]'
                    │ （ネットワークを戻る）
⑤ [app.js] res.json() で JSオブジェクトに変換
        └ customers = [ {id:"C001", name:"…"}, … ]
        └ これで画面（DOM）を組み立てて表示
```

この **①〜⑤の1往復** が、API通信の全てです。ボタンを押すたび、これが起きています。

---

## 6. 生成（Gemini/エージェント）も、実は同じ型

`/api/generate_stream` も **構造は全く同じ** です。
違いは③の Python 関数が「重い仕事（ADKで Gemini を呼ぶ）」をする点だけ：

- **①JS**: `fetch("/api/generate_stream", {method:"POST", body: JSON.stringify({customer_id})})`
  → POST なので **材料(JSON)を手紙に同封**。
- **③Python**: `generate_proposal_stream()`（`server/pipeline.py`）が
  **ADK Runner でエージェントを実行**（ここが「Pythonで書いたプログラムを動かす」実体）。
- **④返す**: 結果を JSON で返す（生成だけは「少しずつ流す」SSEという方式。基本は同じ手紙のやり取り）。
- **⑤JS**: 受け取って画面に描画。

つまり **「JSは fetch で頼む」「Pythonは関数で処理して dict を返す」「間は JSON」**
——この型を、データ参照でも AI 実行でも **使い回しているだけ** です。

---

## 7. まとめ（覚えるのはこれだけ）

1. ブラウザ(JS)とサーバ(Python)は **別プログラム**。**手紙(HTTP)** でやり取りする。
2. サーバの Python は **uvicorn** で **起動しっぱなし**。URLごとに **FastAPI** が担当関数を呼ぶ。
3. Python 関数は **dict を return するだけ** → FastAPI が **JSON** に変換して返す。
4. JS は **`fetch` で頼み、`await` で待ち、`.json()` でJSに戻す**。
5. 言語の壁は **JSON（テキスト）** が橋渡し。

---

## 8. 手を動かして確かめる

- **`/api/customers` を直接ブラウザで開く** → 生の JSON が表示される（「URLを叩くとデータが返る」を体感）。
- **`/docs` を開く**（起動中に `http://localhost:8000/docs`）→ FastAPI が自動生成する画面から、
  各APIを **ボタンで叩いて** 返ってくる JSON を目で見る。
- **開発者ツール → Network タブ** → ボタンを押した時に飛ぶリクエストと、返ってくる JSON を観察する。

> 関連ドキュメント: [TUTORIAL.md](TUTORIAL.md)（全体解説） / [CODE_WALKTHROUGH.md](CODE_WALKTHROUGH.md)（逐行解説）
