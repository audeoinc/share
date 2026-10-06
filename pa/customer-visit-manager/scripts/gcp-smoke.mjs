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
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1600, height: 960, deviceScaleFactor: 1 } })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`)
  })
  await page.authenticate({ username: 'ccp', password: PASSWORD })
  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 60000 })
  await sleep(1500)

  const cards = await page.evaluate(() => document.body.innerText.includes('秋の新作ニット') || document.body.innerText.includes('Fall Arrivals'))
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

  const banner = await page.evaluate(() => [...document.querySelectorAll('[role=alert],.fui-MessageBar')].map((e) => e.textContent?.trim()).filter(Boolean))
  if (banner.length) console.log('お知らせの帯:', banner)
  if (errors.length) {
    console.log('エラー:', errors)
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
