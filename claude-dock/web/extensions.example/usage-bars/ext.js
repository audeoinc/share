// 左ペインの下に、横棒グラフを 1 行 2 列で出す見本。Monthly / Today の「使用量 / 予算」と「消化率」。
// 画面の API (window.crogue, 版 1): api.footer() 差し込み口, api.onData(cb), api.onTurnEnd(cb), api.session(), api.refresh(), api.esc(t)
window.crogue.register('usage-bars', (api) => {
  const root = api.footer(); root.classList.add('ub');
  const fmt = (n, unit) => (unit === 'USD' || unit === '$' ? '$' : '') + (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toString()) + (unit && unit !== 'USD' && unit !== '$' ? ' ' + unit : '');
  const cell = (title, d, unit) => {
    if (!d || !(d.budget > 0)) return `<div class="ub-cell"><div class="ub-t">${api.esc(title)}</div><div class="ub-n">データなし</div></div>`;
    const rate = d.used / d.budget, pct = Math.round(rate * 100), w = Math.max(0, Math.min(100, pct));
    const lv = rate >= 0.9 ? 'bad' : rate >= 0.7 ? 'warn' : 'ok';
    return `<div class="ub-cell" title="${api.esc(title)}: ${fmt(d.used, unit)} / 予算 ${fmt(d.budget, unit)} (${pct}%)">
      <div class="ub-t"><span>${api.esc(title)}</span><b class="${lv}">${pct}%</b></div>
      <svg class="ub-bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${api.esc(title)} ${pct}%"><rect class="ub-bg" x="0" y="0" width="100" height="8" rx="4"/><rect class="ub-fg ${lv}" x="0" y="0" width="${w}" height="8" rx="4"/></svg>
      <div class="ub-n">${fmt(d.used, unit)} / ${fmt(d.budget, unit)}</div></div>`;
  };
  api.onData((m) => {
    if (!m.ok) { root.innerHTML = `<div class="ub-err" title="${api.esc(m.error)}">使用量を取得できません</div>`; return; }
    const d = m.data || {};
    root.innerHTML = `<div class="ub-grid">${cell('Monthly', d.monthly, d.unit)}${cell('Today', d.today, d.unit)}</div>${d.note ? `<div class="ub-note">${api.esc(d.note)}</div>` : ''}`;
  });
});
