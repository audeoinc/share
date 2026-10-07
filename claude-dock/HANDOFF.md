# cdock 引き継ぎメモ

新しいセッションの Claude は、まずこのファイルと `README.md` を読んでください。

## 目的
ターミナル版 Claude Code を使いやすくする。ファイルエクスプローラの表示、ファイル添付（`@path`）、別ペインでのシェル実行を、**追加パーツをできるだけ増やさず**実現する。別の環境にも持ち出して使えること。

## 現状
ブランチ: `claude/wonderful-noether-suh9zv`（リポジトリ `audeoinc/share`、ディレクトリ `claude-dock/`）

| 版 | 場所 | 依存 | 状態 |
|---|---|---|---|
| tmux 版 (macOS/Linux/WSL) | `bin/cdock`, `lib/` | tmux, python3, claude | Linux で動作確認済み。ペイン配置、`@path` の送信、Alt+1 フォーカス切替を確認 |
| Windows ネイティブ版 | `windows/` | Windows Terminal + PowerShell のみ | **実機未検証**（作成環境に PowerShell がなかった） |

## 設計の要点
- Claude Code 本体は改造しない。ペインを並べ、エクスプローラが入力欄へ `@path` を渡すだけ。
- tmux 版: 専用ソケット `tmux -L cdock` で既存の tmux 設定と干渉しない。添付は `tmux send-keys -l "@path "` で Claude ペインへ直接送る。エクスプローラ (`lib/explorer.py`) は curses 製で標準ライブラリのみ。
- Windows 版: Windows Terminal にペイン間のキー送信がないため、`@path` を**クリップボードへコピー**し、ユーザーが Claude ペインで Ctrl+V で貼る方式。ランチャーは `wt` の `new-tab ; split-pane` で3ペインを構成。
- 複数行入力は Claude Code 標準（Shift+Enter、または `\` + Enter）に任せ、専用の入力欄は作っていない。

## 次にやること（Windows ローカルで）
1. `windows\cdock.cmd <プロジェクトのパス>` を実行し、Files / Claude / Shell の3ペインが開くか確認。
2. `windows/explorer.ps1` の表示崩れ・エラーを直す（ANSI エスケープ描画、全角文字の幅、キー入力の switch まわりが怪しい）。
3. Enter で `@path` がクリップボードにコピーされ、Claude ペインで Ctrl+V で貼れるか確認。
4. `windows/cdock.ps1` の `wt` 引数（`-s` の比率、`--title`、`claude` の起動方法）が実環境で正しいか確認。`claude` が `.cmd` の場合の起動も要確認。
5. 動いたら `README.md` の「実機で未検証」の記述を更新する。

## 将来の候補
- Git 差分ペインの常時表示
- ファジー検索（`/`）
- プロンプトのスニペット挿入
- 追加パーツなしを優先するなら、WSL を使わないネイティブ版の改良。WSL を許容するなら tmux 版が最も快適。

## 注意
- `lib/tmux.conf` は `remain-on-exit` を付けない（デバッグ時のみ一時的に使用した）。
- エクスプローラが狭いペイン幅で落ちた不具合は、全角文字の表示幅を考慮した `clip()` / `put()` で修正済み。Windows 版でも同種の問題が出うる。
- ブランチは PR 化していない。必要になったらユーザーが明示的に依頼する。
