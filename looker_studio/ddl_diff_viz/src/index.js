'use strict';
/**
 * Looker Studio コミュニティ ビジュアライゼーションのエントリポイント。
 *
 * ここは dscc とのつなぎ込みだけ。HTML の生成は src/viz.js（DOM 非依存）に置き、
 * ローカルプレビュー（scripts/preview.mjs）と同じコードパスを通るようにしている。
 */

const dscc = require('@google/dscc');
const { buildHtml } = require('./viz');

const ROOT_ID = 'ddl-diff-root';

function root() {
  let el = document.getElementById(ROOT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ROOT_ID;
    document.body.appendChild(el);
  }
  return el;
}

function fatal(el, err) {
  el.innerHTML =
    '<div style="margin:8px 0;padding:8px 12px;border:1px solid #CF222E;border-left-width:4px;' +
    "border-radius:4px;background:#FFEBE9;color:#82071E;font:13px/1.5 'Roboto',system-ui,sans-serif\">" +
    '描画に失敗しました: ' +
    String(err && err.message ? err.message : err).replace(/[<>&]/g, '') +
    '</div>';
}

function draw(data) {
  const el = root();
  try {
    // 生成される HTML は render.js 側でエスケープ済み。
    // また innerHTML で挿入された <script> はブラウザ仕様上実行されない。
    el.innerHTML = buildHtml(
      (data.tables && data.tables[dscc.TableType.DEFAULT]) || [],
      data.style || {}
    );
  } catch (err) {
    fatal(el, err);
  }
}

dscc.subscribeToData(draw, { transform: dscc.objectTransform });
