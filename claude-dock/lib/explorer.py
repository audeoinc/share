#!/usr/bin/env python3
"""cdock explorer — Claude Code ペインへ @ファイル を送るファイルツリー (標準ライブラリのみ)

キー:
  ↑/↓ j/k   移動          →/l/Enter(dir)  開く     ←/h  閉じる/親へ
  Enter/a   ファイルを Claude 入力欄へ @添付
  Space     複数選択のマーク   A  マーク済みを一括添付
  Tab       Claude ペインへフォーカス
  .         隠しファイル表示切替   r  再読込   q  終了(Claudeは落ちません)
"""
import curses
import os
import subprocess
import sys
import unicodedata

TARGET = os.environ.get("CDOCK_TARGET", "")
TMUX = (os.environ.get("CDOCK_TMUX") or "tmux").split()
FOCUS = os.environ.get("CDOCK_FOCUS", TARGET)
IGNORE = {".git", "node_modules", "__pycache__", ".venv", ".DS_Store"}


def tmux(*args):
    try:
        subprocess.run(TMUX + list(args), check=False, capture_output=True)
    except FileNotFoundError:
        pass


def git_status(root):
    out = {}
    try:
        r = subprocess.run(["git", "-C", root, "status", "--porcelain", "-uall"],
                           capture_output=True, text=True, check=False)
        top = subprocess.run(["git", "-C", root, "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, check=False).stdout.strip()
        if r.returncode:
            return out
        for line in r.stdout.splitlines():
            code, path = line[:2].strip() or "M", line[3:].split(" -> ")[-1].strip('"')
            full = os.path.join(top, path)
            out[full] = code[0]
            d = os.path.dirname(full)
            while d.startswith(root) and d != root:
                out.setdefault(d, "•")
                d = os.path.dirname(d)
    except FileNotFoundError:
        pass
    return out


class Tree:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.open = {self.root}
        self.marked = []
        self.hidden = False
        self.sel = 0
        self.top = 0
        self.refresh()

    def refresh(self):
        self.git = git_status(self.root)
        self.rows = []
        self._walk(self.root, 0)
        self.sel = min(self.sel, max(0, len(self.rows) - 1))

    def _walk(self, d, depth):
        try:
            names = os.listdir(d)
        except OSError:
            return
        items = []
        for n in names:
            if n in IGNORE or (n.startswith(".") and not self.hidden):
                continue
            p = os.path.join(d, n)
            items.append((not os.path.isdir(p), n.lower(), n, p))
        for isfile, _, n, p in sorted(items):
            self.rows.append((p, depth, not isfile))
            if not isfile and p in self.open:
                self._walk(p, depth + 1)

    def rel(self, p):
        r = os.path.relpath(p, self.root)
        return f'@"{r}"' if " " in r else f"@{r}"


def clip(text, width):
    """表示幅(全角=2)で切り詰める"""
    out, used = "", 0
    for ch in text:
        cw = 2 if unicodedata.east_asian_width(ch) in "WF" else 1
        if used + cw > width:
            break
        out, used = out + ch, used + cw
    return out


def put(win, y, x, text, width, attr=0):
    try:
        win.addstr(y, x, clip(text, width), attr)
    except curses.error:
        pass


def send(text):
    if TARGET:
        tmux("send-keys", "-t", TARGET, "-l", text)


def main(stdscr, root):
    curses.curs_set(0)
    curses.use_default_colors()
    for i, c in enumerate((curses.COLOR_BLUE, curses.COLOR_YELLOW, curses.COLOR_GREEN,
                           curses.COLOR_RED, curses.COLOR_CYAN), 1):
        curses.init_pair(i, c, -1)
    curses.mousemask(curses.ALL_MOUSE_EVENTS | curses.REPORT_MOUSE_POSITION)
    stdscr.timeout(2000)
    t = Tree(root)
    msg = ""
    while True:
        h, w = stdscr.getmaxyx()
        stdscr.erase()
        put(stdscr, 0, 0, f" {os.path.basename(t.root) or t.root}/", w - 1, curses.A_BOLD | curses.color_pair(1))
        body = h - 3
        if t.sel < t.top:
            t.top = t.sel
        if t.sel >= t.top + body:
            t.top = t.sel - body + 1
        for i in range(body):
            idx = t.top + i
            if idx >= len(t.rows):
                break
            p, depth, isdir = t.rows[idx]
            mark = "✓" if p in t.marked else " "
            icon = ("▾ " if p in t.open else "▸ ") if isdir else "  "
            st = t.git.get(p, "")
            line = f"{mark}{'  ' * depth}{icon}{os.path.basename(p)}"
            attr = curses.color_pair(1) if isdir else 0
            if st:
                attr |= curses.color_pair({"M": 2, "A": 3, "?": 3, "D": 4}.get(st, 2))
            if idx == t.sel:
                attr |= curses.A_REVERSE
            put(stdscr, 1 + i, 0, clip(line, w - 4).ljust(w - 4) + (f" {st}" if st else ""), w - 1, attr)
        status = msg or (f"{len(t.marked)} marked  " if t.marked else "") + "Enter:添付 Space:選択 A:一括 Tab:→Claude ?"
        put(stdscr, h - 1, 0, status, w - 1, curses.A_DIM)
        stdscr.refresh()

        k = stdscr.getch()
        msg = ""
        if k == -1:
            t.refresh()
            continue
        cur = t.rows[t.sel] if t.rows else None
        if k in (ord("q"), 27):
            return
        elif k in (curses.KEY_DOWN, ord("j")):
            t.sel = min(t.sel + 1, len(t.rows) - 1)
        elif k in (curses.KEY_UP, ord("k")):
            t.sel = max(t.sel - 1, 0)
        elif k in (curses.KEY_RIGHT, ord("l")) and cur and cur[2]:
            t.open.add(cur[0]); t.refresh()
        elif k in (curses.KEY_LEFT, ord("h")) and cur:
            if cur[2] and cur[0] in t.open and cur[0] != t.root:
                t.open.discard(cur[0])
            else:
                parent = os.path.dirname(cur[0])
                t.sel = next((i for i, r in enumerate(t.rows) if r[0] == parent), t.sel)
            t.refresh()
        elif k in (10, 13, ord("a")) and cur:
            if cur[2] and k != ord("a"):
                t.open.symmetric_difference_update({cur[0]}); t.refresh()
            else:
                send(t.rel(cur[0]) + " ")
                msg = f"→ {t.rel(cur[0])}"
        elif k == ord(" ") and cur:
            (t.marked.remove if cur[0] in t.marked else t.marked.append)(cur[0])
            t.sel = min(t.sel + 1, len(t.rows) - 1)
        elif k == ord("A"):
            if t.marked:
                send(" ".join(t.rel(p) for p in t.marked) + " ")
                msg = f"→ {len(t.marked)} files"
                t.marked.clear()
        elif k == 9 and FOCUS:
            tmux("select-pane", "-t", FOCUS)
        elif k == ord("."):
            t.hidden = not t.hidden; t.refresh()
        elif k == ord("r"):
            t.refresh()
        elif k == ord("?"):
            msg = "j/k 移動 l/h 開閉 Enter 添付 Space 選択 A 一括 . 隠し r 更新 q 終了"
        elif k == curses.KEY_MOUSE:
            try:
                _, _, y, _, bstate = curses.getmouse()
            except curses.error:
                continue
            idx = t.top + y - 1
            if 0 <= idx < len(t.rows):
                t.sel = idx
                if bstate & (curses.BUTTON1_DOUBLE_CLICKED | curses.BUTTON1_CLICKED):
                    p, _, isdir = t.rows[idx]
                    if isdir:
                        t.open.symmetric_difference_update({p}); t.refresh()
                    elif bstate & curses.BUTTON1_DOUBLE_CLICKED:
                        send(t.rel(p) + " "); msg = f"→ {t.rel(p)}"
            if bstate & curses.BUTTON4_PRESSED:
                t.sel = max(t.sel - 3, 0)
            elif bstate & getattr(curses, "BUTTON5_PRESSED", 0):
                t.sel = min(t.sel + 3, len(t.rows) - 1)


if __name__ == "__main__":
    os.environ.setdefault("ESCDELAY", "25")
    curses.wrapper(main, sys.argv[1] if len(sys.argv) > 1 else ".")
