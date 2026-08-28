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

`fetch("/api/...")` を**同一オリジン**で受けたい場合。CORS の設定が不要になる。

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

## 4. 使い分けの目安

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
```
