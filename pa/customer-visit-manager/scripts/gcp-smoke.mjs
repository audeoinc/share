// GCP 版(サーバー + DB)の動作確認。画面を開いて、カレンダーのカードが出るか、カードを開けるか、エラーが出ていないかを見る。
//   CCP_URL=http://localhost:8080 CCP_PASSWORD=... node scripts/gcp-smoke.mjs [出力する画像のパス]
// Basic 認証は、ユーザー名は何でもよく、パスワードだけを見る(サーバーの APP_PASSWORD)。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.env.CCP_URL ?? 'http://localhost:8080'
const PASSWORD = process.env.CCP_PASSWORD ?? ''
const outImage = process.argv[2]
const PORT = 9334
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const exe = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => p && existsSync(p))
if (!exe) throw new Error('Edge / Chrome が見つかりません(BROWSER_PATH で指定できます)')

const profile = mkdtempSync(join(tmpdir(), 'smoke-'))
const edge = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
let failed = false
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break
    } catch {
      /* 起動待ち */
    }
    await sleep(500)
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1600, height: Number(process.env.CCP_VIEW_H ?? 960), deviceScaleFactor: 1 } })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`)
  })
  await page.authenticate({ username: 'ccp', password: PASSWORD })
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(1500)

  // DB が停止中なら、「準備中」の表示が出て、起動したら自動で読み込み直される(最大 30 分待つ)
  let sawWake = false
  let cards = false
  const waitStarted = Date.now()
  for (let i = 0; i < 1800 && !cards; i++) {
    const st = await page.evaluate(() => ({
      wake: !!document.querySelector('[role=status]') && document.body.innerText.includes('データベースを起動'),
      cards: document.body.innerText.includes('秋の新作ニット') || document.body.innerText.includes('Fall Arrivals'),
    }))
    sawWake ||= st.wake
    cards = st.cards
    if (!cards) await sleep(1000)
  }
  if (sawWake) console.log(`DB の準備中の表示が出て、${Math.round((Date.now() - waitStarted) / 1000)} 秒後に、自動で読み込み直された`)
  console.log('カレンダーに配信カードが出ている:', cards)
  if (!cards) failed = true

  // カードを開く(商品の一覧・メイン画像など、ほかのテーブルの読み込みも確認する)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div,span')].find((e) => e.children.length === 0 && (e.textContent ?? '').trim() === '秋の新作ニット')
    el?.click()
  })
  await sleep(2500)
  const opened = await page.evaluate(() => !!document.querySelector('[role=dialog]') && document.body.innerText.includes('クルーネックニット'))
  console.log('カードを開いて、商品(クルーネックニット)が出ている:', opened)
  if (!opened) failed = true

  // AI(Gemini)の確認。CCP_SMOKE_AI=1(テーマ案だけ)/ full(空のカードを、すべて AI で下書き)のときだけ(実際に Gemini を呼ぶので、費用がかかる)
  if (process.env.CCP_SMOKE_AI === '1' || process.env.CCP_SMOKE_AI === 'full') {
    const started = Date.now()
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('[role=dialog] button')].find((e) => /^(AIで案を出す|案を作り直す)/.test((e.textContent ?? '').trim()))
      b?.click()
    })
    let ideas = false
    for (let i = 0; i < 90 && !ideas; i++) {
      await sleep(1000)
      ideas = await page.evaluate(() => document.body.innerText.includes('AIの案(未採用)'))
    }
    console.log(`AI のテーマ案が出た: ${ideas}(${Math.round((Date.now() - started) / 1000)} 秒)`)
    if (!ideas) failed = true
  }

  if (process.env.CCP_SMOKE_AI === 'full') {
    // 空のカードを開くと、「開いたとき自動で下書き」(既定でオン)が、テーマ → … → 制作指示まで、続けて AI に頼む
    await page.keyboard.press('Escape')
    await sleep(800)
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('div,span')].find((e) => e.children.length === 0 && (e.textContent ?? '').trim() === '冬支度スタート')
      el?.click()
    })
    const started = Date.now()
    let done = false
    for (let i = 0; i < 300 && !done; i++) {
      await sleep(1000)
      done = await page.evaluate(() => /工程 5 \/ 5/.test(document.body.innerText))
    }
    console.log(`すべて AI で下書き: ${done ? '完了(工程 5 / 5)' : '終わらなかった'}(${Math.round((Date.now() - started) / 1000)} 秒)`)
    if (!done) failed = true
    if (outImage) await page.screenshot({ path: outImage.replace(/\.png$/, '-full.png') })
  }

  const banner = await page.evaluate(() => [...document.querySelectorAll('[role=alert],.fui-MessageBar')].map((e) => e.textContent?.trim()).filter(Boolean))
  if (banner.length) console.log('お知らせの帯:', banner)
  // 準備中の表示が出たときの 503(db_starting)は、想定どおりの動きなので、エラーに数えない
  const unexpected = sawWake ? errors.filter((e) => !e.startsWith('503 ')) : errors
  if (unexpected.length) {
    console.log('エラー:', unexpected)
    failed = true
  }
  if (outImage) await page.screenshot({ path: outImage })
  await browser.disconnect()
} finally {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
  else edge.kill()
  await sleep(800)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* 後始末に失敗しても無視 */
  }
}
console.log(failed ? 'NG' : 'OK')
process.exit(failed ? 1 : 0)
