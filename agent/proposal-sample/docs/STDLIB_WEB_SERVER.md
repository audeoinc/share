# Python 標準ライブラリだけで簡易 Web サーバを立てる

外部パッケージを一切入れずに、`web/` の HTML を表示したり、`/api/...` の JSON を返したりする方法。
**開発・確認用**の手段であり、本番の置き換えではない（最後の「注意点」を参照）。

> 本番構成は FastAPI + uvicorn（`server/main.py`）。使い分けの目安は末尾の表にまとめている。

---

## 1. 静的ファイルを配信するだけ — ワンライナー

```bash
python -m http.server 8000 --directory web --bind 127.0.0.1
```

`http://127.0.0.1:8000/` を開くと `web/index.html` が表示される。

Windows（このプロジェクトの venv）の場合:

```powershell
./.venv/Scripts/python.exe -m http.server 8000 --directory web --bind 127.0.0.1
```

| オプション | 意味 |
|---|---|
| `--directory web` | 配信するディレクトリ。省略するとカレントディレクトリ全体が公開される |
| `--bind 127.0.0.1` | **自分の PC からのみアクセス可**にする。省略すると LAN 全体に公開される |

HTML と CSS と JS の見た目を確認したいだけなら、これで足りる。

---

## 2. 静的配信 + JSON API — 40 行

`fetch("/api/...")` を**同一オリジン**で受けたい場合。CORS の設定が不要になる（→ [第4章](#4-cors-とは)）。

```python
"""標準ライブラリだけの簡易サーバ: web/ を配信しつつ /api/... を処理する。"""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8000


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api_get()
        super().do_GET()                      # それ以外は web/ から静的配信

    def do_POST(self):
        if not self.path.startswith("/api/"):
            return self.send_error(404)
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")

        if self.path == "/api/echo":
            return self._json({"received": body, "ok": True})
        self.send_error(404)

    def _api_get(self):
        if self.path == "/api/customers":
            return self._json([{"id": "C001", "name": "サンプル商事"}])
        self.send_error(404)

    def _json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    handler = partial(Handler, directory="web")   # 静的ファイルの場所
    with ThreadingHTTPServer((HOST, PORT), handler) as httpd:
        print(f"http://{HOST}:{PORT} で待機中 (Ctrl+C で停止)")
        httpd.serve_forever()
```

ブラウザ側は普通に叩くだけ。

```javascript
const r = await fetch("/api/echo", {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({text: "hello"}),
});
console.log(await r.json());
```

### 押さえどころ

| 項目 | 理由 |
|---|---|
| `functools.partial` で `directory=` を渡す | `SimpleHTTPRequestHandler` の配信ディレクトリを指定する定石。ハンドラはリクエストごとにインスタンス化されるため、`partial` で引数を束ねる |
| **`ThreadingHTTPServer` を使う** | `HTTPServer` は逐次処理で、1 リクエストが長引くと他が全部待たされる。**Gemini を呼ぶなら必須**（1 リクエストで数十秒かかるため） |
| `ensure_ascii=False` | 付けないと日本語が `\uXXXX` にエスケープされる |
| `Content-Length` を送る | 省略すると接続の終了判定がブラウザ任せになり、レスポンスが途切れて見えることがある |

---

## 3. よく必要になる追加

### 3.1 クエリパラメータを取る

```python
from urllib.parse import urlparse, parse_qs

def do_GET(self):
    u = urlparse(self.path)
    if u.path == "/api/search":
        q = parse_qs(u.query)
        keyword = q.get("q", [""])[0]                 # ?q=商事
        limit    = int(q.get("limit", ["10"])[0])     # &limit=5
        return self._json({"q": keyword, "limit": limit})
    super().do_GET()
```

`self.path` にはクエリ文字列が含まれるため、**前方一致で分岐する場合も `urlparse` で分けてから比較する**。
URL エンコードされた日本語は `parse_qs` が自動でデコードする。

### 3.2 ブラウザキャッシュを無効化する

開発中に「JS を直したのに反映されない」を防ぐ。

```python
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
```

### 3.3 ポートが使用中のとき（Windows）

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## 4. CORS とは

第 2 章で「同一オリジンだから CORS の設定が不要」と書いた、その CORS の話。

### 4.1 一言でいうと

> **CORS（Cross-Origin Resource Sharing）は、「あるオリジンのページから、別のオリジンへのリクエストの結果を
> JavaScript に渡してよいか」をブラウザが判定する仕組み。**

**オリジン**とは `スキーム + ホスト + ポート` の 3 点セットのこと。1 つでも違えば別オリジンになる。

| 比較 | 同一か |
|---|---|
| `http://127.0.0.1:8000/index.html` と `http://127.0.0.1:8000/api/echo` | **同一**（パスが違うだけ） |
| `http://127.0.0.1:8000` と `http://127.0.0.1:5500` | 別（**ポートが違う**） |
| `http://example.com` と `https://example.com` | 別（**スキームが違う**） |
| `file:///C:/work/index.html` と `http://127.0.0.1:8000` | 別（`file://` のオリジンは `null`） |

### 4.2 なぜこんな仕組みがあるのか

ブラウザは、リクエストに**その相手先の Cookie を自動で付ける**。もし制限がなければ、
利用者が悪意あるサイトを開いただけで、そのページの JavaScript が
「利用者がログイン済みの社内システム」に対してリクエストを投げ、**応答の中身を読み取れてしまう**。

これを防ぐのが同一オリジンポリシーで、**CORS はその制限を、サーバ側が明示的に緩めるための仕組み**である。

### 4.3 よくある誤解 — CORS はサーバを守る仕組みではない

**これが最も重要な点。** CORS は「リクエストをブロックする」仕組みではなく、
**ブラウザが応答を JavaScript に渡さない**仕組みである。

実際に、許可していないオリジンから POST を送った場合の挙動を確認すると:

```
--- POST (許可外オリジン) ---
HTTP/1.0 200 OK          ← リクエストはサーバに届き、処理も実行されている
Server: SimpleHTTP/0.6
                         ← Access-Control-Allow-Origin ヘッダが無い
```

**ステータスは 200 で、サーバ側の処理は走っている。** 足りないのは応答ヘッダだけで、
ブラウザはそれを見て「JavaScript に結果を渡さない」と判断する。

ここから導かれる帰結は 2 つ。

- **CORS を設定しても、アクセス制御にはならない。** 認証・認可は別途必要（IAP、Basic 認証、トークン検証など）
- **`curl` では CORS エラーは起きない。** ブラウザの機構なので、CLI からは常に通る。
  「curl では動くのにブラウザだと動かない」という現象の正体はたいていこれ

### 4.4 いつ発生するか

開発中に踏むのは、だいたい次のパターン。

| 状況 | 原因 |
|---|---|
| HTML をエクスプローラからダブルクリックで開いた | `file://` はオリジンが `null` になる |
| VS Code の Live Server（`:5500`）から `:8000` の API を叩いた | **ポートが違う**ので別オリジン |
| フロントを静的ホスティング、API を別ドメインに置いた | ホストが違う |

**逆に、第 2 章の構成（1 つのサーバが静的ファイルと API の両方を返す）では発生しない。**
これが「同一オリジンにまとめる」構成の実用的な利点である。

### 4.5 プリフライトリクエスト

`Content-Type: application/json` を付けた POST は「単純リクエスト」の条件を外れるため、
ブラウザは**本番のリクエストの前に `OPTIONS` メソッドで許可を問い合わせる**。これをプリフライトと呼ぶ。

```
ブラウザ                                サーバ
   │  OPTIONS /api/echo                   │   ← 「POST してよいか？」の問い合わせ
   │  Origin: http://127.0.0.1:5500       │
   │  Access-Control-Request-Method: POST │
   │─────────────────────────────────────►│
   │◄─────────────────────────────────────│   204 + Access-Control-Allow-* ヘッダ
   │                                      │
   │  POST /api/echo （本番のリクエスト）  │
   │─────────────────────────────────────►│
```

**サーバが `OPTIONS` に応答しないと、本番のリクエストは送信すらされない。**
「API を実装したのにサーバのログにリクエストが来ない」という場合、たいていこれである。

### 4.6 標準ライブラリでの実装（開発用）

```python
ALLOWED_ORIGIN = "http://127.0.0.1:5500"   # 許可するフロントのオリジン


class Handler(SimpleHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin")
        if origin == ALLOWED_ORIGIN:                       # 許可リストと照合する
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")             # キャッシュ汚染を防ぐ

    def do_OPTIONS(self):                                  # プリフライトへの応答
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")  # 許可を 600 秒キャッシュ
        self.end_headers()

    def do_POST(self):
        ...
        self.send_response(200)
        self._cors()                                       # 本番の応答にも必要
        self.send_header("Content-Type", "application/json; charset=utf-8")
        ...
```

**注意点**

| 項目 | 内容 |
|---|---|
| `Access-Control-Allow-Origin: *` | 安易に使わない。また、Cookie や認証情報を送る（`credentials: "include"`）場合、**`*` は使用できない**。オリジンを具体的に返す必要がある |
| `Vary: Origin` | オリジンによって応答ヘッダが変わるため、これがないとキャッシュが混線する |
| 本番の応答にもヘッダが必要 | プリフライトにだけ付けても通らない。`OPTIONS` と実リクエストの**両方**に付ける |

### 4.7 結論: 一番の対処は「同一オリジンにする」

CORS の設定は、正しく書いても認証の代わりにはならず、設定項目も多い。
**フロントと API を同じサーバから配信できるなら、そうするのが最も単純で安全**である。

このプロジェクトの `server/main.py` が静的ファイルと `/api/...` の両方を 1 プロセスで返しているのは、この理由による。

---

## 5. 使い分けの目安

| 用途 | 選択 |
|---|---|
| HTML / CSS / JS の表示確認だけ | **1 のワンライナー** |
| API の疎通を試したい、依存を入れたくない | **2 のスクリプト** |
| 本番、SSE ストリーミング、非同期、入力バリデーション | **FastAPI + uvicorn**（`server/main.py`） |

---

## 注意点

**`http.server` は開発専用。** Python の公式ドキュメントにも本番非推奨と明記されている。
セキュリティ上のチェックが最小限で、性能もない。外部に公開してはいけない。

このプロジェクトの `server/main.py` を置き換える用途には向かない。理由は 2 つ。

1. **SSE ストリーミング**（thinking の逐次表示）を標準ライブラリで書くと、`Content-Type: text/event-stream` の手書きと
   フラッシュ制御を自前で管理することになり、割に合わない。
2. **入力バリデーション**（Pydantic）や依存性注入がないため、API が増えるほど手書きの分岐が膨らむ。

「フロントの HTML だけ直したい」「別の PC で画面だけ見せたい」場面で 1 を、
「依存ゼロで API の形だけ試したい」場面で 2 を使う、という切り分けが実用的。

---

## 動作確認

本書のコードは以下を確認済み。

```
GET  /                → 200（web/index.html が返る）
GET  /api/customers   → 200 [{"id": "C001", "name": "サンプル商事"}]
POST /api/echo        → 200 {"received": {"text": "hello"}, "ok": true}
GET  /api/nope        → 404
GET  /api/search?q=商事&limit=5 → 200 {"q": "商事", "limit": 5}
GET  /（3.2 適用時）  → レスポンスヘッダに Cache-Control: no-store

OPTIONS /api/echo（Origin: 許可済み）
  → 204 + Access-Control-Allow-Origin / Allow-Methods / Allow-Headers / Max-Age
POST    /api/echo（Origin: 許可済み）
  → 200 + Access-Control-Allow-Origin、本文 {"received": {"text": "hi"}}
POST    /api/echo（Origin: 許可外）
  → 200（サーバ側の処理は実行される）だが Access-Control-Allow-Origin なし
     → ブラウザ側で応答が JavaScript に渡らない
```
