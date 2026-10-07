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

## 依存
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
