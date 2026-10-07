# cdock (claude-dock)

ターミナル版 Claude Code に **ファイルエクスプローラ / ファイル添付 / 独立 Shell ペイン** を足すランチャー。
Claude Code 本体は改造せず、tmux でペインを並べ、小さなエクスプローラが Claude の入力欄へ `@path` を送り込みます。

```
┌ Files ──┬ Claude Code ─────────────────┐
│ ▾ src   │ > @src/parser.js @schema.sql │
│  parser │   このMERGEを直して           │
│  ✓ sql  ├ Shell ───────────────────────┤
│ lib     │ $ git diff / npm test        │
└─────────┴──────────────────────────────┘
```

## Windows (追加インストール不要)
Windows Terminal + PowerShell だけで動く版が `windows/` にあります (tmux / Python / WSL 不要)。
```
windows\cdock.cmd C:\path\to\project      (省略するとカレント)
```
Files | Claude / Shell の3ペインが開きます。Files で `Enter` すると `@path` を**クリップボードにコピー**するので、
Claude ペインで `Ctrl+V` で貼り付けます (Windows Terminal にはペイン間のキー送信がないため)。
`Space`で複数選択 → `A` で一括コピー。ペイン移動は `Alt+矢印`。
起動時だけ専用プロファイル `cdock` (Claude 風ライト配色・余白・フォント) をペインに適用します。初回は配色の fragment を
`%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\cdock` に設置するので、Windows Terminal を一度閉じてから起動してください
(settings.json は変更しません。通常のタブには影響なし。削除はそのフォルダを消すだけ)。`CDOCK_PROFILE` で別プロファイル名、空文字で無効化。
フォントや余白は `windows/cdock.fragment.json` で変更できます。
Claude ペインのテーマも起動分だけ `windows/claude-settings.json` (`{"theme": "light"}`) で上書きします (`claude --settings`。普段の設定は不変)。
値は `dark` / `auto` など。無効化は `CDOCK_CLAUDE_SETTINGS` を空文字に。Windows 11 / Windows Terminal で動作確認済み。

## 依存 (tmux 版: macOS / Linux / WSL)
`tmux`, `python3` (3.8+・標準ライブラリのみ), `claude` — macOS / Linux / WSL。

## 導入 (別環境へはこのディレクトリごとコピー)
```bash
./install.sh            # ~/.local/bin/cdock にリンク
cd ~/my-project && cdock          # カレントで起動
cdock ~/proj -- --resume          # `--` 以降は claude にそのまま渡す
```
同じディレクトリで再実行すると既存セッションに再接続します (`Ctrl+b d` でデタッチ)。

## 操作
| 場所 | キー | 動作 |
|---|---|---|
| どこでも | `Alt+1/2/3` | Files / Claude / Shell にフォーカス |
| どこでも | `Alt+z` | 現在ペインの拡大/戻す |
| どこでも | `Alt+q` | cdock 全体を終了 |
| Files | `↑↓ jk` / `→← lh` | 移動 / 開閉 |
| Files | `Enter` `a` | ファイルを Claude 入力欄へ `@path` として添付 |
| Files | `Space` → `A` | 複数選択 → 一括添付 |
| Files | `Tab` | Claude ペインへ移動 |
| Files | `.` `r` `q` | 隠しファイル / 更新 / 閉じる |
| マウス | クリック・ダブルクリック・ホイール | 選択 / 添付 / スクロール |

Git の変更状態 (M/A/?/D) がツリーに色付きで出ます。複数行入力は Claude Code 標準の `Shift+Enter`（または `\` + Enter）。
macOS の Terminal.app / iTerm2 で Alt が効かない場合は「Option を Meta として使う」を有効に。

## 設定 (環境変数)
`CDOCK_CLAUDE` (claude コマンド), `CDOCK_EXPLORER_WIDTH` (28), `CDOCK_SHELL_HEIGHT` (30 %), `CDOCK_SHELL_POS` (`bottom`|`right`)

## 構成
- `bin/cdock` ランチャー (専用 tmux ソケット `-L cdock` なので手元の tmux 設定と干渉しない)
- `lib/tmux.conf` 専用設定・キーバインド
- `lib/explorer.py` curses 製ツリー。添付は `tmux send-keys -l "@path "` で Claude ペインへ送るだけ

## 今後の候補
Git 差分ペイン (`git diff` を右に常時表示)、プロンプトのスニペット挿入、ファジー検索 (`/`)。
