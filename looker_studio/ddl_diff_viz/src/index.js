'use strict';
/**
 * Looker Studio コミュニティ ビジュアライゼーションのエントリポイント。
 *
 * ここは dscc とのつなぎ込みと、失敗を「見える化」する役だけ。
 * HTML の生成は src/viz.js（DOM 非依存）に置き、ローカルプレビュー
 * （scripts/preview.mjs）と同じコードパスを通るようにしている。
 *
 * 真っ白を作らないための方針:
 *   - 読み込み直後にプレースホルダを描く（＝白ければ JS が届いていない）
 *   - 一定時間データが来なければその旨を描く（＝config が読めていない疑い）
 *   - どこで落ちても画面に出す（error / unhandledrejection まで拾う）
 */

const dscc = require('@google/dscc');
const { buildHtml } = require('./viz');

// キャッシュ由来の「古い版を見ている」を切り分けるための版表示。
const BUILD_TAG = 'ddl-diff v0.2.0';
const ROOT_ID = 'ddl-diff-root';
const NO_DATA_TIMEOUT_MS = 8000;

let drawn = false; // 一度データを描けたか（以後はエラー表示で上書きしない）

function root() {
  let el = document.getElementById(ROOT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ROOT_ID;
    // body がまだ無い段階で評価されても落ちないように documentElement へ退避する
    (document.body || document.documentElement).appendChild(el);
  }
  return el;
}

function box(border, bg, fg, text) {
  return (
    '<div style="margin:8px;padding:8px 12px;border:1px solid ' + border + ';' +
    'border-left-width:4px;border-radius:4px;background:' + bg + ';color:' + fg + ';' +
    "font:13px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;white-space:pre-wrap\">" +
    String(text).replace(/[<>&]/g, '') +
    '</div>'
  );
}

function paint(html) {
  try {
    root().innerHTML = html;
  } catch (e) {
    try { console.error('[ddl-diff] paint failed', e); } catch (e2) { /* noop */ }
  }
}

function info(text) { paint(box('#8250DF', '#FBF7FF', '#3B2A57', text)); }
function fail(text) { paint(box('#CF222E', '#FFEBE9', '#82071E', text)); }

// --- 1) 読み込み直後に必ず何か描く -----------------------------------
// これが出ずに真っ白なら、index.js 自体が Looker Studio に届いていない
// （manifest の js パス誤り / GCS の権限 / 古いキャッシュ）。
info(BUILD_TAG + ' を読み込みました。\nLooker Studio からのデータを待っています…');

// --- 2) どこで落ちても画面に出す --------------------------------------
try {
  window.addEventListener('error', function (ev) {
    if (drawn) return;
    fail('JS エラー: ' + ((ev && (ev.message || (ev.error && ev.error.message))) || 'unknown'));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    if (drawn) return;
    fail('未処理の Promise 拒否: ' + ((ev && ev.reason && (ev.reason.message || ev.reason)) || 'unknown'));
  });
} catch (e) { /* noop */ }

// --- 3) データが来ないままなら、その状態だと分かるように上書きする -----
const watchdog = setTimeout(function () {
  if (drawn) return;
  info(
    BUILD_TAG + ': JS は動いていますが、' + (NO_DATA_TIMEOUT_MS / 1000) +
    ' 秒待ってもデータが届きません。\n' +
    '次の順で確認してください。\n' +
    '  1) スタイル設定に「比較する 2 件」などの項目が出ているか\n' +
    '     → 出ていなければ index.json (config) が読めていません。\n' +
    '       manifest の config パスと GCS 上のファイル名を照合してください。\n' +
    '  2) データ設定の「key」「DDL」にフィールドを割り当てたか\n' +
    '  3) 割り当て済みなら、メトリクス欄に Record Count を入れてみる'
  );
}, NO_DATA_TIMEOUT_MS);

function draw(data) {
  clearTimeout(watchdog);
  try { console.log('[ddl-diff] received', data); } catch (e) { /* noop */ }
  try {
    // 生成される HTML は render.js 側でエスケープ済み。
    // また innerHTML で挿入された <script> はブラウザ仕様上実行されない。
    paint(buildHtml(
      (data && data.tables && data.tables[dscc.TableType.DEFAULT]) || [],
      (data && data.style) || {}
    ));
    drawn = true;
  } catch (err) {
    fail('描画に失敗しました: ' + (err && err.message ? err.message : err));
  }
}

// --- 4) 購読そのものが失敗しても分かるように ---------------------------
try {
  dscc.subscribeToData(draw, { transform: dscc.objectTransform });
} catch (err) {
  clearTimeout(watchdog);
  fail('dscc.subscribeToData に失敗しました: ' + (err && err.message ? err.message : err));
}
