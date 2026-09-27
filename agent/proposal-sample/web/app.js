// 顧客提案ジェネレーター フロントエンド
// すべて同一オリジン(:8000)の /api/... を叩く（CORS不要）。

const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
const riskLabel = { low: "低", medium: "中", high: "高" };
const SRC_LABEL = { generate: "生成", refine: "再提案", chat: "対話" };
const fmtTime = (iso) => (iso ? iso.replace("T", " ").slice(5, 16) : "");
const prodNames = (ids) =>
  (ids || []).map((id) => (productsById[id] ? productsById[id].name : id)).join(", ");

let productsById = {};
let currentCustomer = null;
let currentProposalId = null; // null=新規 / 数値=既存BQ提案を編集中
let currentAnalysis = ""; // 再提案で使い回すため保持
let currentOrder = []; // 推奨商品の表示順（プレビューのD&Dで並べ替え）
let dragCtx = null; // D&D中の情報 { id, from: "palette"|"preview", index? }
let previewDropHandled = false; // preview発ドラッグが有効な場所にドロップされたか
let compareA = null; // 版比較で1件目に選んだ版
let conversationLog = []; // 会話の流れ: [{kind:'generate'|'refine', instruction, thinking}]
let currentThinking = ""; // 直近生成のモデル思考（版に保存/復元）
let chatMessages = []; // 対話チャット: [{role:'user'|'agent'|'system', text, thinking?}]

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${t}`);
  }
  return res.json();
}

// ---- Markdown → HTML（依存ゼロ・XSS対策込み） -----------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineMd(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split(/\r?\n/);
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) { html += "</ul>"; inList = false; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      html += `<h${lvl}>${inlineMd(m[2])}</h${lvl}>`;
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMd(m[1])}</li>`;
    } else {
      closeList();
      html += `<p>${inlineMd(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function renderConversationLog() {
  const el = document.getElementById("conversation-log");
  if (!el) return;
  if (!conversationLog.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    `<div class="cl-label">会話の流れ（各ターンの指示とモデルの思考）</div>` +
    conversationLog
      .map((t, i) => {
        const label = SRC_LABEL[t.kind] || t.kind;
        const think = (t.thinking || "").trim()
          ? `<details class="cl-think"><summary>🧠 このターンの思考プロセス</summary>` +
            `<div class="cl-think-text">${renderMarkdown(t.thinking)}</div></details>`
          : "";
        return `<div class="cl-item">` +
          `<div class="cl-head"><span class="cl-n">${i + 1}</span>` +
          `<span class="badge src-${t.kind}">${label}</span>` +
          `<span class="cl-instr">${escapeHtml(t.instruction || "")}</span></div>` +
          think +
          `</div>`;
      })
      .join("");
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---- 初期化 ----------------------------------------------------------------

async function init() {
  try {
    const products = await api("/api/products");
    productsById = Object.fromEntries(products.map((p) => [p.id, p]));
    await loadCustomers();
  } catch (e) {
    document.getElementById("customer-list").innerHTML =
      `<div class="loading">読み込み失敗: ${e.message}<br>サーバ(uvicorn)は起動していますか？</div>`;
  }
}

async function loadCustomers() {
  const customers = await api("/api/customers");
  const list = document.getElementById("customer-list");
  list.innerHTML = "";
  customers.forEach((c) => {
    const div = document.createElement("div");
    div.className = "customer-card";
    div.dataset.id = c.id;
    div.innerHTML = `
      <div class="cc-name">${escapeHtml(c.name)}</div>
      <div class="cc-row">
        <span class="cc-seg">${escapeHtml(c.segment)} / ${escapeHtml(c.industry)}</span>
        <span class="badge risk-${c.churn_risk}">解約リスク ${riskLabel[c.churn_risk] || c.churn_risk}</span>
      </div>
      <div class="cc-row"><span class="ltv">LTV ${yen(c.ltv)}</span><span class="ltv">${c.id}</span></div>`;
    div.addEventListener("click", () => selectCustomer(c.id, div));
    list.appendChild(div);
  });
}

// ---- 顧客選択 --------------------------------------------------------------

async function selectCustomer(customerId, cardEl) {
  document.querySelectorAll(".customer-card").forEach((el) => el.classList.remove("active"));
  cardEl.classList.add("active");

  document.getElementById("empty-state").classList.add("hidden");
  document.getElementById("detail-view").classList.remove("hidden");
  document.getElementById("result").classList.add("hidden");
  hideActivity();
  // プレビュー右ペインもリセット（提案が出るまでプレースホルダ）
  document.getElementById("preview-content").classList.add("hidden");
  document.getElementById("preview-empty").classList.remove("hidden");

  // 状態リセット
  currentProposalId = null;
  currentAnalysis = "";
  currentThinking = "";
  document.getElementById("thinking-box").classList.add("hidden");
  conversationLog = []; // 顧客が変わったら会話表示をクリア
  renderConversationLog();
  chatMessages = []; // 対話チャットもクリア（次回の初回送信でサーバ側もリセット）
  renderChatLog();

  const [c, purchases] = await Promise.all([
    api(`/api/customers/${customerId}`),
    api(`/api/customers/${customerId}/purchases`),
  ]);
  currentCustomer = c;

  document.getElementById("cust-name").textContent = c.name;
  document.getElementById("cust-meta").textContent =
    `${c.id} ・ ${c.segment} ・ ${c.industry} ・ 従業員 ${c.employees}名`;

  const attrs = document.getElementById("cust-attrs");
  attrs.innerHTML = `
    <dt>LTV</dt><dd>${yen(c.ltv)}</dd>
    <dt>解約リスク</dt><dd><span class="badge risk-${c.churn_risk}">${riskLabel[c.churn_risk] || c.churn_risk}</span></dd>
    <dt>最終購入日</dt><dd>${escapeHtml(c.last_purchase_date)}</dd>
    <dt>最近の動き</dt><dd>${escapeHtml(c.recent_activity)}</dd>
    <dt>メモ</dt><dd>${escapeHtml(c.notes || "-")}</dd>`;

  const tbody = document.querySelector("#purchase-table tbody");
  tbody.innerHTML = "";
  purchases.forEach((p) => {
    const prod = productsById[p.product_id];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.date}</td><td>${prod ? escapeHtml(prod.name) : p.product_id}</td><td class="num">${yen(p.amount)}</td>`;
    tbody.appendChild(tr);
  });

  await loadSavedProposals(customerId);
  await loadVersions(customerId);
}

// ---- この顧客の保存済み提案（BQ, 顧客で絞り込み） --------------------------

async function loadSavedProposals(customerId) {
  const list = document.getElementById("saved-list");
  try {
    const proposals = await api(`/api/proposals?customer_id=${encodeURIComponent(customerId)}`);
    if (!proposals.length) {
      list.innerHTML = `<div class="empty muted">まだ保存された提案はありません。</div>`;
      return;
    }
    list.innerHTML = "";
    proposals
      .slice()
      .reverse()
      .forEach((p) => {
        const names = (p.recommended_product_ids || [])
          .map((id) => (productsById[id] ? productsById[id].name : id))
          .join(", ");
        const div = document.createElement("div");
        div.className = "saved-item";
        div.innerHTML = `
          <div class="si-main">
            <div class="pi-title">${escapeHtml(p.title || "(無題)")}</div>
            <div class="pi-meta">id ${p.id} ・ 推奨: ${escapeHtml(names || "-")}</div>
          </div>
          <div class="si-actions">
            <button class="btn small btn-edit">✏️ 編集</button>
            <button class="btn small danger btn-del" title="削除">🗑</button>
          </div>`;
        div.querySelector(".btn-edit").addEventListener("click", () => editSavedProposal(p));
        div.querySelector(".btn-del").addEventListener("click", () => deleteSavedProposal(p));
        list.appendChild(div);
      });
  } catch (e) {
    list.innerHTML = `<div class="empty muted">取得失敗: ${e.message}</div>`;
  }
}

async function deleteSavedProposal(p) {
  if (!confirm(`保存済み提案「${p.title || "(無題)"}」を削除しますか？`)) return;
  try {
    await api(`/api/proposals/${p.id}`, { method: "DELETE" });
    toast("保存済み提案を削除しました");
    await loadSavedProposals(currentCustomer.id);
  } catch (e) {
    toast("削除に失敗しました: " + e.message);
  }
}

// ---- 生成履歴（版管理: 表示 / 復元 / 比較） --------------------------------

async function loadVersions(customerId) {
  const list = document.getElementById("history-list");
  document.getElementById("compare-box").classList.add("hidden");
  compareA = null;
  try {
    const versions = await api(`/api/versions?customer_id=${encodeURIComponent(customerId)}`);
    if (!versions.length) {
      list.innerHTML = `<div class="empty muted">まだ生成履歴はありません。「✨生成」すると記録されます。</div>`;
      return;
    }
    list.innerHTML = "";
    versions
      .slice()
      .reverse() // 新しい版を上に
      .forEach((v) => {
        const div = document.createElement("div");
        div.className = "history-item";
        div.dataset.vid = v.id;
        div.innerHTML = `
          <div class="hi-main">
            <div class="hi-head">
              <span class="badge src-${v.source}">${SRC_LABEL[v.source] || v.source}</span>
              <span class="hi-time muted">${fmtTime(v.created_at)}</span>
              <span class="hi-vid muted">v${v.id}</span>
            </div>
            <div class="hi-title">${escapeHtml(v.title || "(無題)")}</div>
            <div class="hi-meta">推奨: ${escapeHtml(prodNames(v.recommended_product_ids) || "-")}</div>
          </div>
          <div class="hi-actions">
            <button class="btn small btn-restore">↩ 復元</button>
            <button class="btn small btn-compare">⇄ 比較</button>
            <button class="btn small danger btn-delv" title="削除">🗑</button>
          </div>`;
        div.querySelector(".btn-restore").addEventListener("click", () => restoreVersion(v));
        div.querySelector(".btn-compare").addEventListener("click", () => pickCompare(v, div));
        div.querySelector(".btn-delv").addEventListener("click", () => deleteVersion(v));
        list.appendChild(div);
      });
  } catch (e) {
    list.innerHTML = `<div class="empty muted">取得失敗: ${e.message}</div>`;
  }
}

async function deleteVersion(v) {
  if (!confirm(`生成履歴 v${v.id}（${SRC_LABEL[v.source] || v.source}）を削除しますか？`)) return;
  try {
    await api(`/api/versions/${v.id}`, { method: "DELETE" });
    toast(`v${v.id} を削除しました`);
    await loadVersions(currentCustomer.id);
  } catch (e) {
    toast("削除に失敗しました: " + e.message);
  }
}

function restoreVersion(v) {
  currentProposalId = null; // 履歴からの復元は“新規”扱い（保存すると新規作成）
  showProposalForm(
    { title: v.title, body: v.body, recommended_product_ids: v.recommended_product_ids },
    { analysisMd: v.analysis || "", thinking: v.thinking || "" }
  );
  document.getElementById("result").scrollIntoView({ behavior: "smooth", block: "start" });
  toast(`v${v.id}（${SRC_LABEL[v.source] || v.source}）を復元しました`);
}

function pickCompare(v, el) {
  const clearHL = () =>
    document.querySelectorAll(".history-item.cmp-a").forEach((x) => x.classList.remove("cmp-a"));
  if (compareA && compareA.id === v.id) {
    // 同じ版を再クリック → 選択解除
    compareA = null;
    clearHL();
    toast("比較の選択を解除しました");
    return;
  }
  if (!compareA) {
    compareA = v;
    clearHL();
    el.classList.add("cmp-a");
    toast(`比較A: v${v.id} を選択。もう1件の「比較」を押してください`);
    return;
  }
  renderCompare(compareA, v);
  compareA = null;
  clearHL();
}

function renderCompare(a, b) {
  const box = document.getElementById("compare-box");
  const aSet = new Set(a.recommended_product_ids || []);
  const bSet = new Set(b.recommended_product_ids || []);
  const added = [...bSet].filter((x) => !aSet.has(x));
  const removed = [...aSet].filter((x) => !bSet.has(x));
  const common = [...bSet].filter((x) => aSet.has(x));
  const chips = (ids) =>
    ids.length
      ? ids
          .map((id) => `<span class="chip">${escapeHtml(productsById[id] ? productsById[id].name : id)}</span>`)
          .join("")
      : '<span class="muted">なし</span>';
  const titleCell =
    a.title === b.title
      ? '<span class="muted">変更なし</span>'
      : `${escapeHtml(a.title || "(無題)")} <b>→</b> ${escapeHtml(b.title || "(無題)")}`;

  box.innerHTML = `
    <div class="cmp-head">
      <span>比較 <b>v${a.id}</b>（${SRC_LABEL[a.source] || a.source} ${fmtTime(a.created_at)}）
        <b>→</b> <b>v${b.id}</b>（${SRC_LABEL[b.source] || b.source} ${fmtTime(b.created_at)}）</span>
      <button class="btn small" id="cmp-close">閉じる</button>
    </div>
    <div class="cmp-row"><span class="cmp-k">タイトル</span><span class="cmp-v">${titleCell}</span></div>
    <div class="cmp-row"><span class="cmp-k">本文文字数</span><span class="cmp-v">${(a.body || "").length} → ${(b.body || "").length} 文字</span></div>
    <div class="cmp-row"><span class="cmp-k">追加された商品</span><span class="cmp-v chips">${chips(added)}</span></div>
    <div class="cmp-row"><span class="cmp-k">削除された商品</span><span class="cmp-v chips">${chips(removed)}</span></div>
    <div class="cmp-row"><span class="cmp-k">共通の商品</span><span class="cmp-v chips">${chips(common)}</span></div>`;
  box.classList.remove("hidden");
  document.getElementById("cmp-close").addEventListener("click", () => box.classList.add("hidden"));
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---- 提案フォーム表示（生成/再提案/編集で共通） ----------------------------

// 商品パレット（画像カード）。クリックで選択トグル / メールへドラッグで追加。
function renderProductPalette() {
  const box = document.getElementById("product-palette");
  const sel = new Set(currentOrder);
  box.innerHTML = "";
  Object.values(productsById).forEach((p) => {
    const card = document.createElement("div");
    card.className = "palette-item" + (sel.has(p.id) ? " selected" : "");
    card.draggable = true;
    card.dataset.id = p.id;
    card.innerHTML = `
      <img class="palette-img" src="${productImageSrc(p)}" alt="${escapeHtml(p.name)}" draggable="false"/>
      <div class="palette-name">${escapeHtml(p.name)}</div>
      <div class="palette-price">${yen(p.price)}</div>
      ${sel.has(p.id) ? '<span class="palette-check">✓</span>' : ""}`;
    card.addEventListener("click", () => toggleProduct(p.id));
    card.addEventListener("dragstart", (e) => {
      dragCtx = { id: p.id, from: "palette" };
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("text/plain", p.id);
    });
    box.appendChild(card);
  });
}

function toggleProduct(id) {
  if (currentOrder.includes(id)) currentOrder = currentOrder.filter((x) => x !== id);
  else currentOrder.push(id);
  syncProducts();
}

function syncProducts() {
  renderProductPalette();
  renderPreviewProducts();
}

function getFormProposal() {
  const title = document.getElementById("prop-title-input").value.trim();
  const body = document.getElementById("prop-body-input").value.trim();
  // 推奨商品は「プレビューの並び順(currentOrder)」を採用（D&Dの結果を保存に反映）
  return { title, body, recommended_product_ids: [...currentOrder] };
}

// ---- 商品サムネイル（カテゴリ別に自動生成するSVG。ネット不要） --------------

function categoryStyle(category) {
  const map = {
    "基本プラン": { c1: "#6d8bff", c2: "#3a52b5", icon: "☁️" },
    "アドオン": { c1: "#3ecf8e", c2: "#1f8f63", icon: "🧩" },
    "サポート": { c1: "#f6c344", c2: "#c9930f", icon: "🛟" },
    "サービス": { c1: "#c07bff", c2: "#7d3fc0", icon: "🎓" },
  };
  return map[category] || { c1: "#8b97b3", c2: "#5b647d", icon: "📦" };
}

function productImageSrc(p) {
  // 本物の画像(image フィールド)があれば優先。無ければカテゴリ別SVGを自動生成（フォールバック）。
  if (p.image) return p.image;
  const s = categoryStyle(p.category);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='96'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${s.c1}'/><stop offset='1' stop-color='${s.c2}'/>` +
    `</linearGradient></defs>` +
    `<rect width='160' height='96' rx='10' fill='url(#g)'/>` +
    `<text x='80' y='60' font-size='42' text-anchor='middle'>${s.icon}</text>` +
    `</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

// ---- メールプレビュー（本文＋おすすめ商品行） ------------------------------

function renderPreview() {
  // 右ペインのプレースホルダを隠して本文を表示
  document.getElementById("preview-empty").classList.add("hidden");
  document.getElementById("preview-content").classList.remove("hidden");

  document.getElementById("pv-to").textContent = currentCustomer
    ? `${currentCustomer.name} 様`
    : "";
  document.getElementById("pv-greeting").textContent = currentCustomer
    ? `${currentCustomer.name} ご担当者様`
    : "";
  document.getElementById("pv-subject").textContent =
    document.getElementById("prop-title-input").value || "(件名未入力)";
  document.getElementById("pv-body").textContent =
    document.getElementById("prop-body-input").value || "";
  renderPreviewProducts();
}

function renderPreviewProducts() {
  const row = document.getElementById("preview-products");
  row.innerHTML = "";
  if (!currentOrder.length) {
    row.innerHTML = `<div class="pv-empty muted">ここに商品画像をドラッグ、または左の一覧をクリックで追加</div>`;
    return;
  }
  currentOrder.forEach((id, idx) => {
    const p = productsById[id];
    if (!p) return;
    const tile = document.createElement("div");
    tile.className = "pv-product";
    tile.draggable = true;
    tile.dataset.index = idx;
    tile.innerHTML = `
      <img class="pv-img" src="${productImageSrc(p)}" alt="${escapeHtml(p.name)}" draggable="false"/>
      <div class="pv-name">${escapeHtml(p.name)}</div>
      <div class="pv-price">${yen(p.price)}</div>`;

    tile.addEventListener("dragstart", (e) => {
      dragCtx = { id, from: "preview", index: idx };
      previewDropHandled = false;
      tile.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    });
    tile.addEventListener("dragend", () => {
      tile.classList.remove("dragging");
      document.querySelectorAll(".drop-target, .drop-zone-active, .remove-zone")
        .forEach((el) => el.classList.remove("drop-target", "drop-zone-active", "remove-zone"));
      // プレビュー外にドロップ（有効なドロップ先で処理されなかった）→ 削除
      if (dragCtx && dragCtx.from === "preview" && !previewDropHandled) {
        currentOrder = currentOrder.filter((x) => x !== dragCtx.id);
        syncProducts();
      }
      dragCtx = null;
    });
    // タイルの上にドロップ = その位置へ挿入/並べ替え
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      tile.classList.add("drop-target");
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("drop-target"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      tile.classList.remove("drop-target");
      dropIntoPreviewAt(idx);
    });

    row.appendChild(tile);
  });
}

// dragCtx の商品を、プレビューの位置 idx に反映（palette=追加 / preview=並べ替え）
function dropIntoPreviewAt(idx) {
  if (!dragCtx) return;
  previewDropHandled = true;
  if (dragCtx.from === "palette") {
    if (!currentOrder.includes(dragCtx.id)) {
      currentOrder.splice(idx, 0, dragCtx.id);
    }
  } else if (dragCtx.from === "preview") {
    const from = dragCtx.index;
    if (from === idx) return;
    const moved = currentOrder.splice(from, 1)[0];
    const to = Math.max(0, Math.min(idx, currentOrder.length));
    currentOrder.splice(to, 0, moved);
  }
  syncProducts();
}

// コンテナ単位のドロップ配線（一度だけ）: プレビュー=追加/末尾、パレット=削除
function initProductDnd() {
  const row = document.getElementById("preview-products");
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    row.classList.add("drop-zone-active");
  });
  row.addEventListener("dragleave", (e) => {
    if (e.target === row) row.classList.remove("drop-zone-active");
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drop-zone-active");
    dropIntoPreviewAt(currentOrder.length); // 空白部分＝末尾に追加/移動
  });

  const palette = document.getElementById("product-palette");
  palette.addEventListener("dragover", (e) => {
    if (dragCtx && dragCtx.from === "preview") {
      e.preventDefault();
      palette.classList.add("remove-zone");
    }
  });
  palette.addEventListener("dragleave", (e) => {
    if (e.target === palette) palette.classList.remove("remove-zone");
  });
  palette.addEventListener("drop", (e) => {
    palette.classList.remove("remove-zone");
    if (dragCtx && dragCtx.from === "preview") {
      e.preventDefault();
      previewDropHandled = true;
      currentOrder = currentOrder.filter((x) => x !== dragCtx.id);
      syncProducts();
    }
  });
}

function updateEditBadge() {
  const b = document.getElementById("edit-mode-badge");
  if (currentProposalId != null) {
    b.textContent = `編集中: proposal_id ${currentProposalId}（保存で上書き）`;
    b.className = "badge editing";
  } else {
    b.textContent = "新規提案（保存で新規作成）";
    b.className = "badge draft";
  }
}

// opts: { analysisMd?, analysisNote?, draftId? }
function showProposalForm(prop, opts = {}) {
  const p = prop || { title: "", body: "", recommended_product_ids: [] };
  document.getElementById("prop-title-input").value = p.title || "";
  document.getElementById("prop-body-input").value = p.body || "";
  currentOrder = [...(p.recommended_product_ids || [])];
  renderProductPalette();
  renderPreview();

  const at = document.getElementById("analysis-text");
  if (opts.analysisMd !== undefined) {
    currentAnalysis = opts.analysisMd || "";
    at.innerHTML = opts.analysisMd ? renderMarkdown(opts.analysisMd) : "(分析結果なし)";
  } else if (opts.analysisNote !== undefined) {
    currentAnalysis = "";
    at.innerHTML = `<p class="muted">${escapeHtml(opts.analysisNote)}</p>`;
  }

  // 思考プロセス（あれば折りたたみで表示、無ければ隠す）
  const tb = document.getElementById("thinking-box");
  const tt = document.getElementById("thinking-text");
  const thinking = opts.thinking || "";
  currentThinking = thinking;
  if (thinking) {
    tt.innerHTML = renderMarkdown(thinking);
    tb.classList.remove("hidden");
    tb.open = true; // 既定で開いて表示（クリックで閉じられる）
  } else {
    tb.classList.add("hidden");
    tt.innerHTML = "";
  }

  document.getElementById("draft-badge").textContent =
    opts.draftId != null ? `GCS下書き保存 (draft_id: ${opts.draftId})` : "";

  // 提案が変わったら前回の評価結果は隠す（内容とズレるため）
  const eb = document.getElementById("eval-result");
  if (eb) { eb.classList.add("hidden"); eb.innerHTML = ""; }

  updateEditBadge();
  document.getElementById("result").classList.remove("hidden");
}

// ---- 提案生成（新規） ------------------------------------------------------

// ---- モデル稼働中インジケータ（画面固定オーバーレイ。生成/再提案 共通） ----
function showActivity(status) {
  document.getElementById("activity-status").textContent = status || "モデルが考えています…";
  document.getElementById("activity").classList.remove("hidden");
}
function setActivityStatus(text) {
  if (text) document.getElementById("activity-status").textContent = text;
}
function hideActivity() {
  document.getElementById("activity").classList.add("hidden");
}

// SSEの1メッセージ(chunk)から {event, data} を取り出す
function parseSSEChunk(chunk) {
  let event = "message";
  let dataStr = "";
  chunk.split("\n").forEach((line) => {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
  });
  let data = {};
  try {
    data = dataStr ? JSON.parse(dataStr) : {};
  } catch (e) {
    data = { raw: dataStr };
  }
  return { event, data };
}

async function generate() {
  if (!currentCustomer) return;
  const btn = document.getElementById("btn-generate");
  btn.disabled = true;

  // ストリーミング表示の準備: 結果エリアを見せ、フォームと分析を初期化
  currentProposalId = null;
  conversationLog = []; // 新規生成＝会話リセット（サーバ側もリセットされる）
  renderConversationLog();
  document.getElementById("prop-title-input").value = "";
  document.getElementById("prop-body-input").value = "";
  currentOrder = [];
  renderProductPalette();
  renderPreview();
  document.getElementById("result").classList.remove("hidden");
  document.getElementById("analysis-text").innerHTML = '<span class="muted">分析を待っています…</span>';
  document.getElementById("thinking-box").classList.add("hidden");
  document.getElementById("thinking-text").innerHTML = "";
  showActivity("生成を開始しています…");

  let analysisAcc = "";
  let thinkingAcc = "";
  try {
    const res = await fetch("/api/generate_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: currentCustomer.id }),
    });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let doneData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.trim()) continue;
        const { event, data } = parseSSEChunk(chunk);
        if (event === "thinking_delta") {
          thinkingAcc += data.text || "";
          const tb = document.getElementById("thinking-box");
          tb.classList.remove("hidden");
          tb.open = true; // 生成中は開いて“考えている様子”を見せる
          document.getElementById("thinking-text").innerHTML = renderMarkdown(thinkingAcc);
        } else if (event === "analysis_delta") {
          analysisAcc += data.text || "";
          document.getElementById("analysis-text").innerHTML = renderMarkdown(analysisAcc);
        } else if (event === "status") {
          setActivityStatus(data.text || "");
        } else if (event === "error") {
          throw new Error(data.text || "server error");
        } else if (event === "done") {
          doneData = data;
        }
      }
    }

    if (!doneData) throw new Error("ストリームが完了しませんでした");
    // 確定値でフォーム・プレビューを埋める
    showProposalForm(doneData.proposal, {
      analysisMd: doneData.analysis,
      thinking: doneData.thinking || "",
      draftId: doneData.draft_id,
    });
    // 会話の流れを初回生成ターンで開始（このターンの思考も保持）
    conversationLog = [{
      kind: "generate",
      instruction: "初回生成",
      thinking: doneData.thinking || thinkingAcc,
    }];
    renderConversationLog();
    await loadVersions(currentCustomer.id); // 履歴を更新
  } catch (e) {
    toast("生成に失敗しました: " + e.message);
  } finally {
    hideActivity();
    btn.disabled = false;
  }
}

// ---- 指示して再提案（AIに作り直させる） ------------------------------------

async function refine() {
  if (!currentCustomer) return;
  const input = document.getElementById("refine-input");
  const instruction = input.value.trim();
  if (!instruction) {
    toast("再提案の指示を入力してください（例: もっと低予算の案で）");
    return;
  }
  const btn = document.getElementById("btn-refine");
  btn.disabled = true;
  showActivity("指示を反映して再提案中…");

  let thinkingAcc = "";
  try {
    // 再提案もSSEでストリーミングし、思考をライブ表示（=反応が見える）。
    const res = await fetch("/api/refine_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: currentCustomer.id,
        analysis: currentAnalysis,
        previous_proposal: getFormProposal(), // 手動修正も反映
        instruction,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let doneData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.trim()) continue;
        const { event, data } = parseSSEChunk(chunk);
        if (event === "thinking_delta") {
          thinkingAcc += data.text || "";
          const tb = document.getElementById("thinking-box");
          tb.classList.remove("hidden");
          tb.open = true;
          document.getElementById("thinking-text").innerHTML = renderMarkdown(thinkingAcc);
        } else if (event === "status") {
          setActivityStatus(data.text || "");
        } else if (event === "error") {
          throw new Error(data.text || "server error");
        } else if (event === "done") {
          doneData = data;
        }
      }
    }

    if (!doneData) throw new Error("ストリームが完了しませんでした");
    // 編集中(currentProposalId)はそのまま維持し、中身だけ差し替え。
    // 思考は今回の再提案で生成したものを表示（従来の“前回の使い回し”を解消）。
    showProposalForm(doneData.proposal, {
      analysisMd: doneData.analysis,
      thinking: doneData.thinking || thinkingAcc,
      draftId: doneData.draft_id,
    });
    // 会話の流れに、この再提案の指示とそのターンの思考を追加
    conversationLog.push({
      kind: "refine",
      instruction,
      thinking: doneData.thinking || thinkingAcc,
    });
    renderConversationLog();
    input.value = "";
    await loadVersions(currentCustomer.id); // 履歴を更新
    toast("指示を反映して再提案しました");
  } catch (e) {
    toast("再提案に失敗しました: " + e.message);
  } finally {
    hideActivity();
    btn.disabled = false;
  }
}

// ---- エージェントと相談して作る（対話・往復） ------------------------------

function renderChatLog() {
  const el = document.getElementById("chat-log");
  if (!el) return;
  if (!chatMessages.length) {
    el.innerHTML =
      `<div class="chat-hint muted">顧客について相談すると、エージェントが必要に応じて質問し、` +
      `要件が固まったら提案を作成して右のフォームに反映します。</div>`;
    return;
  }
  el.innerHTML = chatMessages
    .map((m) => {
      if (m.role === "user") {
        return `<div class="chat-msg user"><div class="bubble">${escapeHtml(m.text)}</div></div>`;
      }
      if (m.role === "system") {
        return `<div class="chat-msg system"><div class="sys">${escapeHtml(m.text)}</div></div>`;
      }
      const think = (m.thinking || "").trim()
        ? `<details class="cl-think"><summary>🧠 このターンの思考プロセス</summary>` +
          `<div class="cl-think-text">${renderMarkdown(m.thinking)}</div></details>`
        : "";
      const text = (m.text || "").trim()
        ? renderMarkdown(m.text)
        : `<span class="muted">…</span>`;
      return `<div class="chat-msg agent"><div class="bubble">${text}</div>${think}</div>`;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}

function resetChat() {
  chatMessages = [];
  renderChatLog();
  // 次回の初回送信で reset=true が付き、サーバ側の会話セッションも破棄される。
  toast("会話をリセットしました");
}

async function sendChat() {
  if (!currentCustomer) {
    toast("先に顧客を選んでください");
    return;
  }
  const input = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message) return;

  const isFirst = chatMessages.length === 0; // 会話の最初＝サーバ側もリセットして開始
  chatMessages.push({ role: "user", text: message });
  const agentMsg = { role: "agent", text: "", thinking: "" }; // ライブ更新用
  chatMessages.push(agentMsg);
  renderChatLog();
  input.value = "";

  const btn = document.getElementById("btn-chat-send");
  btn.disabled = true;
  showActivity("エージェントが考えています…");

  let replyAcc = "";
  let thinkingAcc = "";
  try {
    const res = await fetch("/api/chat_stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer_id: currentCustomer.id, message, reset: isFirst }),
    });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let doneData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.trim()) continue;
        const { event, data } = parseSSEChunk(chunk);
        if (event === "thinking_delta") {
          thinkingAcc += data.text || "";
          agentMsg.thinking = thinkingAcc;
          renderChatLog();
        } else if (event === "reply_delta") {
          replyAcc += data.text || "";
          agentMsg.text = replyAcc;
          renderChatLog();
        } else if (event === "status") {
          setActivityStatus(data.text || "");
        } else if (event === "error") {
          throw new Error(data.text || "server error");
        } else if (event === "done") {
          doneData = data;
        }
      }
    }

    if (!doneData) throw new Error("ストリームが完了しませんでした");

    agentMsg.text =
      doneData.reply ||
      replyAcc ||
      (doneData.proposal ? "提案を作成しました。右のフォームでご確認ください。" : "");
    agentMsg.thinking = doneData.thinking || thinkingAcc;

    // 提案が確定したら、生成/再提案と同じように右のフォーム・プレビューへ反映。
    if (doneData.proposal) {
      currentProposalId = null; // 対話での作成は“新規”扱い（保存すると新規作成）
      showProposalForm(doneData.proposal, {
        analysisNote:
          "対話（チャット）で作成した提案です。AIの分析を見るには「✨生成」または「再提案」してください。",
        thinking: doneData.thinking || thinkingAcc,
        draftId: doneData.draft_id,
      });
      chatMessages.push({ role: "system", text: "✅ 提案を作成し、右のフォームに反映しました。" });
      await loadVersions(currentCustomer.id); // 履歴を更新
    }
    renderChatLog();
  } catch (e) {
    agentMsg.text = `（エラー: ${e.message}）`;
    renderChatLog();
    toast("対話に失敗しました: " + e.message);
  } finally {
    hideActivity();
    btn.disabled = false;
  }
}

// ---- 保存済み提案を編集 ----------------------------------------------------

function editSavedProposal(p) {
  currentProposalId = p.id;
  showProposalForm(
    {
      title: p.title,
      body: p.body,
      recommended_product_ids: p.recommended_product_ids,
    },
    {
      analysisNote:
        "保存済み提案を編集中です。AIの分析を見るには「提案を生成」または「再提案」してください。",
    }
  );
  document.getElementById("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- 提案の評価（LLM-as-judge をその場で表示） -----------------------------

function evalBar(label, score) {
  const s = Number(score) || 0;
  const pct = Math.max(0, Math.min(100, (s / 5) * 100));
  const cls = s >= 4 ? "good" : s >= 3 ? "mid" : "low";
  return `<div class="eval-metric"><span class="em-label">${label}</span>
    <span class="em-bar"><span class="em-fill ${cls}" style="width:${pct}%"></span></span>
    <span class="em-score">${s}/5</span></div>`;
}

function renderEval(j) {
  const box = document.getElementById("eval-result");
  const avg = j.avg != null ? j.avg : 0;
  const cls = avg >= 4 ? "good" : avg >= 3 ? "mid" : "low";
  box.innerHTML = `
    <div class="eval-head"><b>AI評価</b> <span class="badge eval-${cls}">平均 ${avg} / 5</span></div>
    ${evalBar("根拠 grounding", j.grounding)}
    ${evalBar("適合 relevance", j.relevance)}
    ${evalBar("実行性 actionability", j.actionability)}
    <div class="eval-reason">${escapeHtml(j.reason || "")}</div>`;
  box.classList.remove("hidden");
}

async function evaluateProposal() {
  if (!currentCustomer) return;
  const prop = getFormProposal();
  if (!prop.title && !prop.body) {
    toast("先に提案を生成／入力してください");
    return;
  }
  const btn = document.getElementById("btn-evaluate");
  const box = document.getElementById("eval-result");
  btn.disabled = true;
  box.classList.remove("hidden");
  box.innerHTML = '<span class="muted">AI審査員が採点中…</span>';
  try {
    const j = await api("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: currentCustomer.id,
        analysis: currentAnalysis,
        proposal: prop,
      }),
    });
    renderEval(j);
  } catch (e) {
    box.innerHTML = `<span class="muted">評価に失敗: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

// ---- 承認 → BQ保存（新規作成 or 上書き更新） -------------------------------

async function approve() {
  if (!currentCustomer) return;
  const prop = getFormProposal();
  if (!prop.title || !prop.body) {
    toast("タイトルと本文を入力してください");
    return;
  }
  const btn = document.getElementById("btn-approve");
  btn.disabled = true;
  try {
    const saved = await api("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_id: currentCustomer.id,
        title: prop.title,
        body: prop.body,
        recommended_product_ids: prop.recommended_product_ids,
        proposal_id: currentProposalId, // null=新規, 数値=更新
      }),
    });
    const wasUpdate = currentProposalId != null;
    currentProposalId = saved.proposal_id;
    updateEditBadge();
    toast(
      wasUpdate
        ? `BQを更新しました (proposal_id: ${saved.proposal_id})`
        : `BQに保存しました (proposal_id: ${saved.proposal_id})`
    );
    await loadSavedProposals(currentCustomer.id);
  } catch (e) {
    toast("保存に失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---- イベント --------------------------------------------------------------

document.getElementById("btn-generate").addEventListener("click", generate);
document.getElementById("btn-approve").addEventListener("click", approve);
document.getElementById("btn-refine").addEventListener("click", refine);
document.getElementById("btn-evaluate").addEventListener("click", evaluateProposal);
document.getElementById("refine-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") refine();
});
document.getElementById("btn-chat-send").addEventListener("click", sendChat);
document.getElementById("btn-chat-reset").addEventListener("click", resetChat);
document.getElementById("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
// 手動編集をプレビューへライブ反映
document.getElementById("prop-title-input").addEventListener("input", (e) => {
  document.getElementById("pv-subject").textContent = e.target.value || "(件名未入力)";
});
document.getElementById("prop-body-input").addEventListener("input", (e) => {
  document.getElementById("pv-body").textContent = e.target.value || "";
});

// ---- ペイン幅のドラッグ調整 & 左ペイン開閉 ---------------------------------

const layoutEl = document.querySelector(".layout");

function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

function initSplitter(id, varName, sign, min, max) {
  const el = document.getElementById(id);
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = parseFloat(getComputedStyle(layoutEl).getPropertyValue(varName)) || 0;
    document.body.classList.add("resizing");
    const onMove = (ev) => {
      let w = startW + sign * (ev.clientX - startX);
      w = Math.max(min, Math.min(max, w));
      layoutEl.style.setProperty(varName, w + "px");
      positionCollapseTab(); // 閉じタブを仕切りに追従
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      lsSet("pw" + varName, layoutEl.style.getPropertyValue(varName));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

// 左仕切り: 右へドラッグ=左ペイン拡大 / 右仕切り: 右へドラッグ=右ペイン縮小
initSplitter("splitter-left", "--left-w", +1, 180, 520);
initSplitter("splitter-right", "--right-w", -1, 300, 680);

// 保存された幅を復元
const savedLeft = lsGet("pw--left-w");
const savedRight = lsGet("pw--right-w");
if (savedLeft) layoutEl.style.setProperty("--left-w", savedLeft);
if (savedRight) layoutEl.style.setProperty("--right-w", savedRight);

// 閉じタブ（‹）を、左仕切りの水平位置に合わせて配置（縦は画面中央にCSSで固定）
function positionCollapseTab() {
  const sp = document.getElementById("splitter-left");
  const btn = document.getElementById("collapse-left");
  if (layoutEl.classList.contains("left-collapsed") || getComputedStyle(sp).display === "none") {
    return; // 閉じているとき/仕切り非表示のときは何もしない（タブは非表示）
  }
  const r = sp.getBoundingClientRect();
  btn.style.left = r.left + r.width / 2 + "px";
}
window.addEventListener("resize", positionCollapseTab);

// 左ペイン開閉（‹ で閉じる / › で開く）
function setLeftCollapsed(collapsed) {
  layoutEl.classList.toggle("left-collapsed", collapsed);
  document.getElementById("expand-left").classList.toggle("hidden", !collapsed);
  lsSet("leftCollapsed", collapsed ? "1" : "0");
  if (!collapsed) requestAnimationFrame(positionCollapseTab);
}
// 閉じるタブはセパレータ上にあるので、ドラッグ（幅調整）を誤発火させない
document.getElementById("collapse-left").addEventListener("pointerdown", (e) => e.stopPropagation());
document.getElementById("collapse-left").addEventListener("click", (e) => {
  e.stopPropagation();
  setLeftCollapsed(true);
});
document.getElementById("expand-left").addEventListener("click", () => setLeftCollapsed(false));
setLeftCollapsed(lsGet("leftCollapsed") === "1");

// ---- カラーテーマ（light / dark / system） --------------------------------
const themeSelect = document.getElementById("theme-select");
const _mql = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(choice) {
  // system は OS 設定に追従、light/dark は固定
  const resolved = choice === "system" ? (_mql.matches ? "dark" : "light") : choice;
  document.documentElement.dataset.theme = resolved;
  // システム時だけ微妙に色味を変えて、固定Light/Darkと区別できるようにする
  document.documentElement.classList.toggle("theme-system", choice === "system");
  lsSet("themeChoice", choice);
}
themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
_mql.addEventListener("change", () => {
  if ((lsGet("themeChoice") || "system") === "system") applyTheme("system");
});
(() => {
  const choice = lsGet("themeChoice") || "system";
  themeSelect.value = choice;
  applyTheme(choice);
})();

// --- モバイルで「PC版（デスクトップ幅）」表示に切り替えるトグル -----------------
// viewport を width=device-width（モバイル最適化）と固定幅（デスクトップ相当）で
// 切り替える。物理画面が小さい端末でだけリンクを出す（judge は viewport 操作の
// 影響を受けない window.screen.width で行う＝切替後もリンクが消えない）。
const viewportMeta = document.getElementById("viewport-meta");
const viewportToggle = document.getElementById("viewport-toggle");
const VIEWPORT_MOBILE = "width=device-width, initial-scale=1";
const VIEWPORT_DESKTOP = "width=1280";
function applyViewport(mode) {
  const desktop = mode === "desktop";
  viewportMeta.setAttribute("content", desktop ? VIEWPORT_DESKTOP : VIEWPORT_MOBILE);
  viewportToggle.textContent = desktop ? "📱 モバイル版に戻す" : "🖥️ PC版で表示";
  lsSet("viewportMode", desktop ? "desktop" : "mobile");
}
viewportToggle.addEventListener("click", () => {
  applyViewport(lsGet("viewportMode") === "desktop" ? "mobile" : "desktop");
});
(() => {
  const screenW = (window.screen && window.screen.width) || 9999;
  if (screenW > 820) return;  // PC/大画面では何もしない（device-width のまま）
  viewportToggle.classList.remove("hidden");
  applyViewport(lsGet("viewportMode") === "desktop" ? "desktop" : "mobile");
})();

initProductDnd();
init();
