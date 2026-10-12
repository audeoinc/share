# 組み込み手順書 (環境ごとの表示を、アプリの外に足す)

この手順書は、**その環境の Claude** が読んで、Claude Rogue に「利用状況の表示」などを組み込むためのものです。
組み込んだものは、**アプリ本体 (`app\`) の外**に置くので、新しい ZIP を上書きしても**残ります**。新しい PC に入れ直したときは、この手順を、もう一度やります。

依頼の例 (人間が Claude に言う): 「`app\INTEGRATION.md` を読んで、この環境の利用状況プラグインを、画面の左下に組み込んで」

## 1. しくみ

```
%APPDATA%\crogue\extensions\<名前>\      ← 組み込んだものは、ここ (アプリの外)
    manifest.json   名前と、データを集めるコマンド
    collect.mjs     データを集める (JSON を 1 つ、標準出力に出す)  ※名前・言語は自由
    ext.js          画面に描く (ブラウザの JS)
    ext.css         見た目
```

- サーバーが、`manifest.json` の `collect.command` を、一定間隔・会話が終わるたびに実行し、**標準出力の JSON** を、画面の `ext.js` へ渡します。
- `ext.js` は、左ペインの下の「差し込み口」に、好きなものを描きます (HTML / SVG)。外部ライブラリは不要です (棒グラフは SVG の `rect` で足ります)。
- 1 つの拡張が壊れても、アプリ本体や他の拡張は、止まりません。エラーは、画面上のバーの **ⓘ (環境の情報)** の「拡張」に出ます。

## 2. 手順

### 手順 1: 環境を調べる
1. ブラウザで、Claude Rogue の上のバーの **ⓘ (環境の情報)** を開いて、**プラグイン**、**MCP サーバー**、**スキル**を見ます (あなたは画面を見られます)。
2. 利用状況プラグインが、**何で値を出すか**を特定します。たとえば:
   - コマンド / スクリプトがある (`~\.claude\plugins\` の下、PATH 上のコマンドなど)
   - ファイル (JSON / CSV / ログ) に書き出している
   - MCP サーバーや、スキルが返す
   値を**自分で取れるか**、実際に 1 回、実行して確かめます (形・単位・桁も確認)。
3. 取れる値を、次の形に対応づけます (見本: `app\extensions.example\usage-bars\`)。

```json
{ "monthly": { "used": 112.5, "budget": 500 },
  "today":   { "used": 8.4,   "budget": 20  },
  "unit": "USD", "note": "任意の補足 (省略可)" }
```
予算が取れない場合は、設定ファイルなどに持たせます。分からないときは、人間に聞いてください (推測で値を作らない)。

### 手順 2: 拡張のフォルダを作る
見本を、設定フォルダへコピーします。

```powershell
Copy-Item -Recurse "<このアプリの場所>\app\extensions.example\usage-bars" "$env:APPDATA\crogue\extensions\usage-bars"
```
(`CDOCK_CONFIG_DIR` が設定されていれば、そのフォルダの `extensions\` です。場所は ⓘ の「場所」に出ます)

### 手順 3: collect を、実際の値を出すものに書き換える
- `collect.mjs` を、手順 1 で見つけた方法で値を取り、**上の形の JSON を、標準出力に 1 つだけ**出すように書き換えます (言語は、Node.js / PowerShell など、何でも構いません。`manifest.json` の `collect.command` を合わせます)。
- 余計な出力をしないでください。失敗するときは、終了コードを 0 以外にして、理由を標準エラーに出します (ⓘ に出ます)。
- 秘密 (キー・トークン) は、ファイルにベタ書きせず、環境変数や、既存の設定から読みます。

### 手順 4: 点検コマンドを実行する
```
node "<このアプリの場所>\app\check-ext.mjs"
```
`manifest.json`、`ext.js` の構文、collect の実行結果 (JSON か) を調べます。**NG があれば直して、すべて OK になるまで繰り返します。**

### 手順 5: 画面で確かめる (必ず、目で見ます)
1. Claude Rogue を起動 (`start.cmd`)、または、起動中なら **Ctrl+F5**。
2. **左ペインの下**に、「Monthly / Today」の横棒グラフ (1 行 2 列) が出ているか見ます。使用量・予算・消化率 (%) が、手順 1 で確かめた実際の値と合っているか照らします。
3. ライト / ダークの両方 (上のバーの ◐) で、読めるか見ます。
4. ⓘ を開いて、「拡張」が **正常** になっているか見ます。
5. 会話を 1 回して、終わったあとに値が更新されるか見ます。

### 手順 6: 手順を残す
この環境で分かったこと (プラグインの場所、値の取り方、予算の出どころ、つまずいた点) を、拡張のフォルダの `NOTES.md` に、短く書き残します。次に入れ直すときに、役立ちます。

## 3. 更新したとき
新しい ZIP を、`crogue` フォルダに上書きで展開して、`start.cmd` を実行するだけです。拡張は `%APPDATA%\crogue\extensions\` にあるので、そのまま残ります。
画面の API は **版 1** です (`window.crogue.version`)。互換を崩すときは版を上げ、古い版の拡張は、そのまま動くようにします。更新後に表示が消えたら、手順 4 (点検) と ⓘ の「拡張」を見てください。

## 4. ext.js の API (版 1)

```js
window.crogue.register('名前', (api) => {
  const box = api.footer();            // 左ペインの下の、この拡張用の箱 (div)。中は自由に描く
  api.onData((m) => { /* m = { ok, data, error, updated, ms } ; data は collect が出した JSON */ });
  api.onTurnEnd(() => { /* 会話が 1 回終わるたび */ });
  api.session();                       // { cwd, sessionId }
  api.refresh();                       // collect を、いま実行させる
  api.esc('文字');                     // HTML のエスケープ
  api.toast('メッセージ');
});
```
- 色は、画面の CSS 変数 (`--text --muted --rule --ok --warn --bad --accent --panel --bg`) を使うと、ライト / ダークに自動で合います。
- 画面を、別の場所 (チップ・パネルなど) にも出したい場合は、人間に相談してください (API を足します)。

## 5. manifest.json

```json
{ "title": "使用量",
  "collect": { "command": "node collect.mjs", "intervalSec": 60, "timeoutSec": 20, "afterTurn": true } }
```
- `command` は、拡張のフォルダを作業場所として実行されます。環境変数: `CROGUE_CWD` (作業フォルダ) / `CROGUE_SESSION_ID` / `CROGUE_CONFIG_DIR` / `CROGUE_EXT_DIR`。
- `intervalSec` は 15 秒以上、`timeoutSec` は最大 120 秒。
