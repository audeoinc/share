'use strict';

/* Webview 側。拡張機能から届いた行データを描画し、操作を返す。 */

/*
 * このファイルは 2 通りの文脈で動く。
 *   1. 拡張機能のパネル … acquireVsCodeApi() があり、拡張機能と双方向にやり取りする
 *   2. 出力した単体 HTML … API が無く、埋め込まれた window.__MFD_EXPORT__ を描画する
 */

(function () {
  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const standalone = !api;
  const $ = (id) => document.getElementById(id);

  const dom = {
    headers: $('headers'),
    headersInner: $('headers-inner'),
    viewport: $('viewport'),
    grid: $('grid'),
    overview: $('overview'),
    status: $('status'),
    summary: $('summary'),
    prev: $('btn-prev'),
    next: $('btn-next'),
    collapse: $('btn-collapse'),
    wrap: $('btn-wrap'),
    ws: $('btn-ws'),
    ic: $('btn-case'),
    refresh: $('btn-refresh'),
    export: $('btn-export'),
  };

  const state = {
    payload: null,
    cols: 0,
    collapse: true,
    wrap: false,
    ignoreTrimWhitespace: true,
    ignoreCase: false,
    contextLines: 3,
    expanded: new Set(),
    anchors: [],
    current: -1,
    renderToken: 0,
    charWidth: 8,
    maxTextPx: 0,
    lnWidth: 48,
  };

  // ---------------------------------------------------------------------
  // 拡張機能とのやり取り
  // ---------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) return;
    switch (message.type) {
      case 'busy':
        setStatus('読み込み中…');
        break;
      case 'error':
        setStatus(message.message, true);
        break;
      case 'status':
        setStatus(message.message);
        break;
      case 'data':
        onData(message.payload);
        break;
      default:
        break;
    }
  });

  function onData(payload) {
    state.payload = payload;
    state.cols = payload.titles.length;
    const options = payload.options || {};
    state.collapse = options.collapseUnchanged !== false;
    state.wrap = options.wordWrap === true;
    state.ignoreTrimWhitespace = options.ignoreTrimWhitespace !== false;
    state.ignoreCase = options.ignoreCase === true;
    state.contextLines = typeof options.contextLines === 'number' ? options.contextLines : 3;
    state.expanded.clear();
    state.current = -1;

    syncToggleButtons();
    renderHeaders();
    measure();
    render();
    setStatus(hintText());
  }

  function post(type, extra) {
    if (!api) return;
    api.postMessage(Object.assign({ type }, extra || {}));
  }

  // ---------------------------------------------------------------------
  // HTML 出力（テーマ色は今表示している値をそのまま持ち出す）
  // ---------------------------------------------------------------------

  function collectExport() {
    const computed = getComputedStyle(document.documentElement);
    const themeVars = {};
    for (const name of state.payload.themeVars || []) {
      const value = computed.getPropertyValue(name).trim();
      if (value) themeVars[name] = value;
    }

    const payload = Object.assign({}, state.payload, {
      options: {
        collapseUnchanged: state.collapse,
        wordWrap: state.wrap,
        ignoreTrimWhitespace: state.ignoreTrimWhitespace,
        ignoreCase: state.ignoreCase,
        contextLines: state.contextLines,
      },
    });
    delete payload.themeVars;

    return { themeVars, payload, expanded: Array.from(state.expanded) };
  }

  // ---------------------------------------------------------------------
  // 計測（列幅・行番号欄の幅）
  // ---------------------------------------------------------------------

  function measure() {
    const probe = document.createElement('div');
    probe.className = 'grid';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.width = 'auto';
    probe.style.minWidth = '0';
    probe.textContent = 'X'.repeat(100);
    document.body.appendChild(probe);
    state.charWidth = probe.getBoundingClientRect().width / 100 || 8;
    document.body.removeChild(probe);

    const maxLine = Math.max.apply(null, state.payload.lineCounts.concat([1]));
    state.lnWidth = Math.max(38, String(maxLine).length * state.charWidth + 20);

    let maxColumns = 0;
    for (const row of state.payload.rows) {
      for (const cell of row.cells) {
        if (cell.t) maxColumns = Math.max(maxColumns, visualWidth(cell.t));
      }
    }
    state.maxTextPx = maxColumns * state.charWidth + 24;
    applyLayout();
  }

  /** タブを 4 桁のタブストップに展開したときの表示幅（文字数） */
  function visualWidth(text) {
    if (text.indexOf('\t') === -1) return text.length;
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\t') width += 4 - (width % 4);
      else width++;
    }
    return width;
  }

  function applyLayout() {
    if (!state.payload) return;
    const available = dom.viewport.clientWidth || 900;
    const even = Math.floor(available / state.cols);
    const needed = state.lnWidth + state.maxTextPx;
    const width = state.wrap ? even : Math.min(Math.max(even, needed), 40000);
    const root = document.documentElement.style;
    root.setProperty('--mfd-col-width', width + 'px');
    root.setProperty('--mfd-ln-width', Math.round(state.lnWidth) + 'px');
    document.body.classList.toggle('wrap', state.wrap);
  }

  // ---------------------------------------------------------------------
  // ヘッダー
  // ---------------------------------------------------------------------

  function renderHeaders() {
    dom.headersInner.textContent = '';
    state.payload.titles.forEach((title, index) => {
      const head = document.createElement('div');
      head.className = 'head';

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(index + 1);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = title.label;

      const path = document.createElement('span');
      path.className = 'path';
      path.textContent = title.detail;
      path.title = title.detail;

      head.append(badge, name, path);
      head.title = `${title.detail}（${state.payload.lineCounts[index]} 行）`;
      dom.headersInner.appendChild(head);
    });
  }

  // ---------------------------------------------------------------------
  // 表示リストの組み立て（一致区間の折りたたみ）
  // ---------------------------------------------------------------------

  function buildDisplayList() {
    const rows = state.payload.rows;
    const list = [];
    if (!state.collapse) {
      for (let i = 0; i < rows.length; i++) list.push({ row: rows[i], index: i });
      return list;
    }

    const context = state.contextLines;
    let i = 0;
    while (i < rows.length) {
      if (rows[i].c) {
        list.push({ row: rows[i], index: i });
        i++;
        continue;
      }
      let j = i;
      while (j < rows.length && !rows[j].c) j++;

      const key = i + ':' + j;
      const head = i === 0 ? 0 : context;
      const tail = j === rows.length ? 0 : context;
      if (state.expanded.has(key) || j - i <= head + tail + 1) {
        for (let k = i; k < j; k++) list.push({ row: rows[k], index: k });
      } else {
        for (let k = i; k < i + head; k++) list.push({ row: rows[k], index: k });
        list.push({ fold: key, hidden: j - tail - (i + head) });
        for (let k = j - tail; k < j; k++) list.push({ row: rows[k], index: k });
      }
      i = j;
    }
    return list;
  }

  // ---------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------

  function render() {
    const token = ++state.renderToken;
    const list = buildDisplayList();
    dom.grid.textContent = '';
    state.anchors = [];

    let previousChanged = false;
    let cursor = 0;
    const CHUNK = 400;

    const step = () => {
      if (token !== state.renderToken) return;
      const fragment = document.createDocumentFragment();
      const end = Math.min(cursor + CHUNK, list.length);
      for (; cursor < end; cursor++) {
        const item = list[cursor];
        if (item.fold) {
          fragment.appendChild(createFold(item));
          previousChanged = false;
          continue;
        }
        const element = createRow(item.row);
        if (item.row.c && !previousChanged) state.anchors.push(element);
        previousChanged = !!item.row.c;
        fragment.appendChild(element);
      }
      dom.grid.appendChild(fragment);
      if (cursor < list.length) {
        requestAnimationFrame(step);
      } else {
        renderOverview();
        updateSummary();
      }
    };
    step();
  }

  function createRow(row) {
    const element = document.createElement('div');
    element.className = row.c ? 'row changed' : 'row';
    for (const cell of row.cells) {
      element.appendChild(createCell(cell));
    }
    return element;
  }

  function createCell(cell) {
    const element = document.createElement('div');
    element.className = 'cell ' + cell.k;

    const number = document.createElement('span');
    number.className = 'ln';
    number.textContent = cell.n === null ? '' : String(cell.n);
    if (cell.n !== null) number.dataset.line = String(cell.n);

    const text = document.createElement('span');
    text.className = 'tx';
    if (cell.s) {
      for (const [changed, chunk] of cell.s) {
        if (changed) {
          const mark = document.createElement('span');
          mark.className = 'w';
          mark.textContent = chunk;
          text.appendChild(mark);
        } else {
          text.appendChild(document.createTextNode(chunk));
        }
      }
    } else {
      text.textContent = cell.t === null ? '' : cell.t;
    }

    element.append(number, text);
    return element;
  }

  function createFold(item) {
    const element = document.createElement('div');
    element.className = 'fold';
    element.dataset.fold = item.fold;
    const label = document.createElement('span');
    label.className = 'fold-label';
    label.textContent = `⌄ 一致している ${item.hidden} 行を表示`;
    element.appendChild(label);
    return element;
  }

  function renderOverview() {
    dom.overview.textContent = '';
    const height = dom.grid.scrollHeight || 1;
    const barHeight = dom.overview.clientHeight;
    if (!barHeight) return;
    for (const anchor of state.anchors) {
      const mark = document.createElement('div');
      mark.className = 'mark';
      mark.style.top = ((anchor.offsetTop / height) * barHeight).toFixed(1) + 'px';
      mark.style.height = Math.max(2, (anchor.offsetHeight / height) * barHeight).toFixed(1) + 'px';
      dom.overview.appendChild(mark);
    }
  }

  function updateSummary() {
    const payload = state.payload;
    const blocks = state.anchors.length;
    dom.summary.textContent =
      `${payload.titles.length} ファイル / 差分 ${blocks} 箇所・${payload.changedCount} 行`;
  }

  // ---------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------

  function goToDiff(delta) {
    if (state.anchors.length === 0) return;
    let index = state.current + delta;
    if (index < 0) index = state.anchors.length - 1;
    if (index >= state.anchors.length) index = 0;
    state.current = index;
    focusAnchor(state.anchors[index]);
  }

  function focusAnchor(element) {
    for (const row of dom.grid.querySelectorAll('.row.focus')) row.classList.remove('focus');
    element.classList.add('focus');
    const top = element.offsetTop - dom.viewport.clientHeight / 3;
    dom.viewport.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function toggle(button, key, needsRecompute) {
    button.addEventListener('click', () => {
      state[key] = !state[key];
      syncToggleButtons();
      if (needsRecompute) {
        const options = {};
        options[key] = state[key];
        post('options', { options });
        return;
      }
      post('options', { options: { collapseUnchanged: state.collapse, wordWrap: state.wrap } });
      applyLayout();
      state.current = -1;
      render();
    });
  }

  function syncToggleButtons() {
    dom.collapse.classList.toggle('on', state.collapse);
    dom.wrap.classList.toggle('on', state.wrap);
    dom.ws.classList.toggle('on', state.ignoreTrimWhitespace);
    dom.ic.classList.toggle('on', state.ignoreCase);
  }

  function setStatus(text, isError) {
    dom.status.textContent = text;
    dom.status.classList.toggle('error', !!isError);
  }

  function hintText() {
    const common =
      'F7 / Shift+F7 で次・前の差分へ移動。' +
      ' 1 番目のファイルを基準に、一致する側を赤系・異なる側を緑系で表示します。';
    if (standalone) return common;
    return '行番号をクリックすると該当ファイルの該当行を開きます。  ' + common;
  }

  // ---------------------------------------------------------------------
  // イベント登録
  // ---------------------------------------------------------------------

  dom.viewport.addEventListener('scroll', () => {
    dom.headers.scrollLeft = dom.viewport.scrollLeft;
  });

  dom.grid.addEventListener('click', (event) => {
    const fold = event.target.closest('.fold');
    if (fold) {
      state.expanded.add(fold.dataset.fold);
      state.current = -1;
      const keepTop = dom.viewport.scrollTop;
      render();
      dom.viewport.scrollTop = keepTop;
      return;
    }
    const number = event.target.closest('.ln');
    if (number && number.dataset.line) {
      const cell = number.parentElement;
      const file = Array.prototype.indexOf.call(cell.parentElement.children, cell);
      post('open', { file, line: Number(number.dataset.line) });
    }
  });

  dom.overview.addEventListener('click', (event) => {
    const rect = dom.overview.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    dom.viewport.scrollTop = ratio * dom.grid.scrollHeight - dom.viewport.clientHeight / 2;
  });

  dom.prev.addEventListener('click', () => goToDiff(-1));
  dom.next.addEventListener('click', () => goToDiff(1));
  dom.refresh.addEventListener('click', () => post('refresh'));
  dom.export.addEventListener('click', () => {
    if (!state.payload) return;
    setStatus('HTML を出力しています…');
    post('export', { data: collectExport() });
  });
  toggle(dom.collapse, 'collapse', false);
  toggle(dom.wrap, 'wrap', false);
  toggle(dom.ws, 'ignoreTrimWhitespace', true);
  toggle(dom.ic, 'ignoreCase', true);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'F7' || (event.altKey && event.key === 'ArrowDown')) {
      event.preventDefault();
      goToDiff(event.shiftKey ? -1 : 1);
    } else if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      goToDiff(-1);
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      applyLayout();
      renderOverview();
    }, 80);
  });

  // ---------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------

  if (standalone) {
    document.body.classList.add('standalone');
    const embedded = window.__MFD_EXPORT__;
    if (embedded) {
      onData(embedded.payload);
      if (embedded.expanded && embedded.expanded.length) {
        for (const key of embedded.expanded) state.expanded.add(key);
        render();
      }
      const sources = (embedded.sources || []).join(' , ');
      setStatus(
        `${embedded.exportedAt} 時点の比較結果${sources ? '（' + sources + '）' : ''}。  ` + hintText()
      );
    } else {
      setStatus('表示するデータが埋め込まれていません。', true);
    }
  } else {
    post('ready');
  }
})();
