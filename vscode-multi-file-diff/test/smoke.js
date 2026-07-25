'use strict';

/*
 * VS Code を起動せずに差分ロジックだけを検証する簡易テスト。
 *   node test/smoke.js
 */

const assert = require('assert');
const { diff, EQUAL, DELETE, INSERT } = require('../src/diff');
const { buildRows } = require('../src/align');

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

// ---------------------------------------------------------------------------
// diff() の不変条件: 出力から a と b を復元できること
// ---------------------------------------------------------------------------

function assertDiffValid(a, b) {
  const ops = diff(a, b);
  const ra = [];
  const rb = [];
  let lastA = -1;
  let lastB = -1;
  for (const [op, ai, bi] of ops) {
    if (op === EQUAL) {
      assert.strictEqual(a[ai], b[bi], '一致とされた行の内容が違う');
      ra.push(a[ai]);
      rb.push(b[bi]);
    } else if (op === DELETE) {
      assert.strictEqual(bi, -1);
      ra.push(a[ai]);
    } else if (op === INSERT) {
      assert.strictEqual(ai, -1);
      rb.push(b[bi]);
    }
    if (ai >= 0) {
      assert.ok(ai > lastA, 'a 側のインデックスが単調増加していない');
      lastA = ai;
    }
    if (bi >= 0) {
      assert.ok(bi > lastB, 'b 側のインデックスが単調増加していない');
      lastB = bi;
    }
  }
  assert.deepStrictEqual(ra, Array.from(a), 'a を復元できない');
  assert.deepStrictEqual(rb, Array.from(b), 'b を復元できない');
  return ops;
}

check('diff: 空同士', () => assertDiffValid([], []));
check('diff: 片側が空', () => {
  assertDiffValid([], ['a', 'b']);
  assertDiffValid(['a', 'b'], []);
});
check('diff: 完全一致', () => {
  const ops = assertDiffValid(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.ok(ops.every(([op]) => op === EQUAL));
});
check('diff: 完全不一致', () => {
  const ops = assertDiffValid(['a', 'b'], ['x', 'y']);
  assert.ok(ops.every(([op]) => op !== EQUAL));
});
check('diff: 中間の 1 行追加', () => {
  const ops = assertDiffValid(['a', 'c'], ['a', 'b', 'c']);
  assert.strictEqual(ops.filter(([op]) => op === INSERT).length, 1);
  assert.strictEqual(ops.filter(([op]) => op === DELETE).length, 0);
});

check('diff: ランダム入力 300 ケース', () => {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (n) => Math.floor(random() * n);
  for (let t = 0; t < 300; t++) {
    const length = pick(60);
    const alphabet = 1 + pick(6);
    const a = Array.from({ length }, () => 'l' + pick(alphabet));
    const b = a.slice();
    const edits = pick(12);
    for (let e = 0; e < edits; e++) {
      const kind = pick(3);
      if (b.length === 0 || kind === 0) b.splice(pick(b.length + 1), 0, 'l' + pick(alphabet));
      else if (kind === 1) b.splice(pick(b.length), 1);
      else b[pick(b.length)] = 'l' + pick(alphabet);
    }
    assertDiffValid(a, b);
  }
});

// ---------------------------------------------------------------------------
// buildRows() の不変条件
// ---------------------------------------------------------------------------

function assertRowsValid(files, result) {
  const { rows } = result;
  // 各ファイルの行が過不足なく、順番どおりに 1 度ずつ現れること
  for (let f = 0; f < files.length; f++) {
    const seen = [];
    for (const row of rows) {
      const cell = row.cells[f];
      assert.strictEqual(row.cells.length, files.length);
      if (cell.n !== null) {
        seen.push(cell.n);
        assert.strictEqual(cell.t, files[f][cell.n - 1], `列 ${f} の本文が行番号と食い違う`);
      } else {
        assert.strictEqual(cell.k, 'none');
      }
    }
    assert.deepStrictEqual(
      seen,
      files[f].map((_, i) => i + 1),
      `列 ${f} の行が欠落または重複している`
    );
  }
  // c=0 の行は全列そろっていて内容が同じ
  for (const row of rows) {
    if (row.c) continue;
    const texts = row.cells.map((cell) => cell.t);
    assert.ok(texts.every((t) => t !== null), '一致行なのに欠けている列がある');
    assert.ok(texts.every((t) => t.trim() === texts[0].trim()), '一致行なのに内容が違う');
  }
}

check('buildRows: 2 ファイル', () => {
  const files = [
    ['line1', 'line2', 'line3'],
    ['line1', 'line2 changed', 'line3', 'line4'],
  ];
  const result = buildRows(files);
  assertRowsValid(files, result);
  assert.strictEqual(result.changedCount, 2);

  const changed = result.rows.find((row) => row.c && row.cells[0].t === 'line2');
  assert.strictEqual(changed.cells[0].k, 'base');
  assert.strictEqual(changed.cells[1].k, 'diff');
  // 単語単位の強調（"changed" だけが差分）
  assert.deepStrictEqual(changed.cells[1].s, [
    [0, 'line2'],
    [1, ' changed'],
  ]);

  const added = result.rows.find((row) => row.cells[1].t === 'line4');
  assert.strictEqual(added.cells[0].k, 'none');
  assert.strictEqual(added.cells[1].k, 'diff');
});

check('buildRows: 3 ファイル（B だけ 1 行削除）', () => {
  const files = [
    ['a', 'b', 'c'],
    ['a', 'c'],
    ['a', 'b', 'c'],
  ];
  const result = buildRows(files);
  assertRowsValid(files, result);
  // A と C の "b" が同じ行に揃い、B は欠落表示になる
  const row = result.rows.find((r) => r.cells[0].t === 'b');
  assert.strictEqual(row.cells[1].k, 'none');
  assert.strictEqual(row.cells[2].t, 'b');
  assert.strictEqual(row.cells[2].k, 'base', '内容が基準と同じなら基準色になる');
});

check('buildRows: 3 ファイル（3 者 3 様）', () => {
  const files = [
    ['共通', 'A の行', '共通2'],
    ['共通', 'B の行', '共通2'],
    ['共通', 'C の行', '共通2'],
  ];
  const result = buildRows(files);
  assertRowsValid(files, result);
  const row = result.rows.find((r) => r.c);
  assert.deepStrictEqual(row.cells.map((c) => c.k), ['base', 'diff', 'diff']);
});

check('buildRows: 空白無視の切り替え', () => {
  const files = [['  x'], ['x  ']];
  assert.strictEqual(buildRows(files, { ignoreTrimWhitespace: true }).changedCount, 0);
  assert.strictEqual(buildRows(files, { ignoreTrimWhitespace: false }).changedCount, 1);
});

check('buildRows: 大小文字無視の切り替え', () => {
  const files = [['Value'], ['value']];
  assert.strictEqual(buildRows(files, { ignoreCase: true }).changedCount, 0);
  assert.strictEqual(buildRows(files, { ignoreCase: false }).changedCount, 1);
});

check('buildRows: ランダムな 3 ファイル 200 ケース', () => {
  let seed = 987654321;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = (n) => Math.floor(random() * n);
  for (let t = 0; t < 200; t++) {
    const base = Array.from({ length: pick(40) }, (_, i) => `行${i % (1 + pick(9))}`);
    const files = [base, mutate(base), mutate(base)];
    assertRowsValid(files, buildRows(files));
  }

  function mutate(source) {
    const out = source.slice();
    const edits = pick(8);
    for (let e = 0; e < edits; e++) {
      const kind = pick(3);
      if (out.length === 0 || kind === 0) out.splice(pick(out.length + 1), 0, '追加' + pick(5));
      else if (kind === 1) out.splice(pick(out.length), 1);
      else out[pick(out.length)] = '変更' + pick(5);
    }
    return out;
  }
});

check('buildRows: 1000 行規模でも現実的な時間で終わる', () => {
  const a = Array.from({ length: 1000 }, (_, i) => `const value${i} = ${i};`);
  const b = a.slice();
  for (let i = 0; i < 100; i++) b[i * 7] = `const value${i * 7} = ${i * 7 + 1};`;
  const c = a.slice();
  c.splice(500, 20);
  const started = process.hrtime.bigint();
  const result = buildRows([a, b, c]);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assertRowsValid([a, b, c], result);
  assert.ok(ms < 3000, `遅すぎる: ${ms.toFixed(0)}ms`);
  console.log(`      (${ms.toFixed(0)}ms, 差分 ${result.changedCount} 行)`);
});

// ---------------------------------------------------------------------------
// HTML 出力
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const {
  buildPanelHtml,
  buildStandaloneHtml,
  collectThemeVariables,
} = require('../src/html');

const cssText = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.css'), 'utf8');
const scriptText = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

check('html: CSS からテーマ変数名を拾える', () => {
  const names = collectThemeVariables(cssText);
  assert.ok(names.includes('--vscode-diffEditor-insertedLineBackground'));
  assert.ok(names.includes('--vscode-diffEditor-diagonalFill'));
  assert.ok(names.includes('--vscode-editor-background'));
  assert.ok(names.length > 20, `変数が少なすぎる: ${names.length}`);
  assert.deepStrictEqual(names, Array.from(new Set(names)), '重複がある');
});

check('html: パネル用 HTML に CSP と nonce が入る', () => {
  const html = buildPanelHtml({
    cspSource: 'https://example.vscode-cdn.net',
    nonce: 'abc123',
    styleUri: 'https://example.vscode-cdn.net/main.css',
    scriptUri: 'https://example.vscode-cdn.net/main.js',
  });
  assert.ok(html.includes("script-src 'nonce-abc123'"));
  assert.ok(html.includes('<script nonce="abc123"'));
  assert.ok(html.includes('id="btn-export"'));
});

function sampleExport() {
  const files = [
    ['a', 'b', 'c'],
    ['a', 'B', 'c'],
    ['a', 'b', 'C</script><script>alert(1)</script>'],
  ];
  const { rows, changedCount } = buildRows(files);
  return buildStandaloneHtml({
    title: '<test> & "quotes"',
    css: cssText,
    script: scriptText,
    themeVars: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-diffEditor-insertedLineBackground': 'rgba(35, 134, 54, 0.2)',
    },
    payload: {
      titles: files.map((_, i) => ({ label: `f${i}.txt`, detail: `dir/f${i}.txt` })),
      lineCounts: files.map((lines) => lines.length),
      rows,
      changedCount,
      options: { collapseUnchanged: true, wordWrap: false, contextLines: 3 },
    },
    expanded: ['0:2'],
    exportedAt: '2026-07-25 12:00:00',
    sources: ['dir/f0.txt', 'dir/f1.txt', 'dir/f2.txt'],
  });
}

check('html: 出力した HTML が自己完結している', () => {
  const html = sampleExport();
  // 外部リソースを一切参照していない
  assert.strictEqual(/\b(?:src|href)\s*=/.test(html), false, '外部参照が残っている');
  // CSS と JS が埋め込まれている
  assert.ok(html.includes('--mfd-line-height'), 'CSS が入っていない');
  assert.ok(html.includes('acquireVsCodeApi'), 'JS が入っていない');
  assert.ok(html.includes('<body class="standalone">'));
  // script タグの数が増えていない ＝ 本文の "</script>" が漏れていない
  assert.strictEqual(html.split('</script>').length - 1, 2, 'script タグの対応が壊れている');
  assert.ok(html.includes('&lt;test&gt;'), 'タイトルがエスケープされていない');
  assert.ok(html.includes('--vscode-editor-background: #1f1f1f;'), 'テーマ色が固定されていない');
});

check('html: 埋め込んだデータを復元できる', () => {
  const html = sampleExport();
  const match = html.match(/window\.__MFD_EXPORT__ = (.*?);<\/script>/s);
  assert.ok(match, '埋め込みデータが見つからない');
  const data = JSON.parse(match[1]);
  assert.strictEqual(data.exportedAt, '2026-07-25 12:00:00');
  assert.deepStrictEqual(data.expanded, ['0:2']);
  assert.strictEqual(data.payload.rows.length, 3);
  // 危険な文字列も中身は保たれている
  assert.ok(data.payload.rows[2].cells[2].t.includes('</script>'));
});

check('html: 埋め込んだスクリプトが構文として正しい', () => {
  const html = sampleExport();
  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  assert.strictEqual(blocks.length, 2);
  for (const block of blocks) {
    const code = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
    // new Function はコンパイルのみ行う（実行はしない）
    assert.doesNotThrow(() => new Function(code), '埋め込みスクリプトが構文エラー');
  }
});

console.log(`\n${checks} 件すべて成功しました。`);
