// データベースの「準備中」表示(GCP 版だけ)。
//
// Cloud SQL は、普段は停止している。サーバーが「データベースを起動している」と返したら、全画面に準備中の表示を出し、
// 数秒おきに /api/db/status を確認して、使えるようになったら画面を読み込み直す。
// 画面のコード(React)には手を入れず、ここで、画面の上に直接かぶせる(Power Apps 版との同期を保つため)。

const POLL_MS = 4000
const GIVE_UP_MS = 6 * 60 * 1000
let shown = false

const lang = (): 'ja' | 'en' => {
  try {
    return localStorage.getItem('ui.lang') === 'en' ? 'en' : 'ja'
  } catch {
    return 'ja'
  }
}

const TEXT = {
  ja: { title: 'データベースを起動しています', body: '使っていない間は停止しているため、起動に 1〜3 分ほどかかります。準備ができると、自動で読み込み直します。', slow: '時間がかかっています。しばらくしてから、ページを読み込み直してください。' },
  en: { title: 'Starting the database', body: 'The database is stopped while idle, so it takes 1–3 minutes to start. This page reloads automatically when it is ready.', slow: 'This is taking longer than expected. Please reload the page in a little while.' },
}

export function showDbWake(): void {
  if (shown) return
  shown = true
  const t = TEXT[lang()]
  const root = document.createElement('div')
  root.setAttribute('role', 'status')
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.92);font-family:Inter,"Noto Sans JP",system-ui,sans-serif;color:#242424'
  root.innerHTML = `
    <style>@keyframes ccp-spin{to{transform:rotate(360deg)}}</style>
    <div style="max-width:420px;padding:28px 32px;text-align:center">
      <div style="width:28px;height:28px;margin:0 auto 16px;border:3px solid #d1d1d1;border-top-color:#2f4fbf;border-radius:50%;animation:ccp-spin 1s linear infinite"></div>
      <div style="font-size:16px;font-weight:600;margin-bottom:8px">${t.title}</div>
      <div id="ccp-wake-body" style="font-size:13px;line-height:1.7;color:#616161">${t.body}</div>
    </div>`
  document.body.appendChild(root)

  const started = Date.now()
  const timer = window.setInterval(async () => {
    try {
      const res = await fetch('/api/db/status')
      const json = (await res.json()) as { state?: string }
      if (json.state === 'running') {
        window.clearInterval(timer)
        location.reload()
        return
      }
    } catch {
      /* 一時的な通信の失敗は、次の確認でやり直す */
    }
    if (Date.now() - started > GIVE_UP_MS) {
      window.clearInterval(timer)
      const body = root.querySelector('#ccp-wake-body')
      if (body) body.textContent = t.slow
    }
  }, POLL_MS)
}
