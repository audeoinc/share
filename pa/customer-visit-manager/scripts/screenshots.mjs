// 各機能のスクリーンショットを docs/screenshots/ に作る(サンプルデータ + 模擬の AI。実データには触れない)。
//   npm run screenshots
// モックのサーバー(vite.mock.config.ts)を自動で起動し、Edge を puppeteer-core で操作して撮影する。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'screenshots')
mkdirSync(out, { recursive: true })
const PORT = 5190
const URL = `http://localhost:${PORT}/`

const EDGES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean)
const executablePath = EDGES.find((p) => existsSync(p))
if (!executablePath) throw new Error('Edge / Chrome が見つかりません(環境変数 BROWSER_PATH で指定できます)')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function up() {
  try {
    return (await fetch(URL)).ok
  } catch {
    return false
  }
}

let server
if (!(await up())) {
  server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--config', 'vite.mock.config.ts'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' })
  for (let i = 0; i < 60 && !(await up()); i++) await sleep(500)
}

const profile = mkdtempSync(join(tmpdir(), 'shots-'))
const DEBUG_PORT = 9333
// puppeteer.launch は Edge で起動に失敗することがあるため、Edge を直接起動して接続する
const edge = spawn(executablePath, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--lang=ja-JP', '--no-first-run', 'about:blank'], {
  stdio: 'ignore',
})
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok) break
  } catch {
    /* 起動待ち */
  }
  await sleep(500)
}
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: { width: 1600, height: 960, deviceScaleFactor: 2 } })

/** 見出しなどの文字(前方一致)を持つ、いちばん内側の要素を押す */
async function click(page, text, { tag = 'button,[role=tab],[role=menuitem],[role=option],div,span', nth = 0, wait = 350 } = {}) {
  const ok = await page.evaluate(
    (text, tag, nth) => {
      const els = [...document.querySelectorAll(tag)].filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && (e.textContent ?? '').trim().replace(/^[✓●\s]+/, '').startsWith(text)
      })
      // いちばん内側(子孫に同じ文字の要素がないもの)
      const inner = els.filter((e) => !els.some((o) => o !== e && e.contains(o)))
      const el = inner[nth]
      if (!el) return false
      el.scrollIntoView({ block: 'center' })
      el.click()
      return true
    },
    text,
    tag,
    nth,
  )
  if (!ok) throw new Error(`見つかりません: ${text}`)
  await sleep(wait)
}

const clickLabel = async (page, label, wait = 350) => {
  const ok = await page.evaluate((label) => {
    const el = [...document.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === label && e.getBoundingClientRect().width > 0)
    if (!el) return false
    el.click()
    return true
  }, label)
  if (!ok) throw new Error(`見つかりません(aria-label): ${label}`)
  await sleep(wait)
}

/** 「AI が考えている」表示が消えるまで待つ */
async function idle(page, extra = 600) {
  await sleep(1500)
  for (let i = 0; i < 60; i++) {
    const busy = await page.evaluate(() => [...document.querySelectorAll('[role=progressbar],.fui-Spinner')].some((e) => e.getBoundingClientRect().width > 0))
    if (!busy) break
    await sleep(500)
  }
  await sleep(extra)
}

const shot = async (page, name, clip) => {
  await page.screenshot({ path: join(out, `${name}.png`), ...(clip ? { clip } : {}) })
  console.log('saved', name)
}

async function fresh(lang) {
  const page = await browser.newPage()
  await page.emulateTimezone('Asia/Tokyo')
  await page.evaluateOnNewDocument((lang) => localStorage.setItem('ui.lang', lang), lang)
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await sleep(800)
  return page
}

const dialogShot = async (page, name) => {
  const rect = await page.evaluate(() => {
    const d = document.querySelector('[role=dialog]')
    if (!d) return null
    const r = d.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  await shot(page, name, rect ?? undefined)
}

const closeDialog = async (page) => {
  await page.keyboard.press('Escape')
  await sleep(500)
  if (await page.$('[role=dialog]')) {
    await click(page, 'キャンセル', { tag: 'button' }).catch(() => undefined)
    await click(page, 'Cancel', { tag: 'button' }).catch(() => undefined)
  }
}

const open = async (page, name) => {
  await click(page, name, { tag: 'div,span,button' })
  await page.waitForSelector('[role=dialog]')
  await sleep(1200)
}

const CARD = (L) => (L === 'ja' ? '秋の新作ニット' : 'Fall Arrivals')
const T = (L, ja, en) => (L === 'ja' ? ja : en)

const SCENES = {
  async calendar(page, L) {
    await shot(page, `${L}-01-calendar`)
  },
  async cardDialog(page, L) {
    await open(page, T(L, '秋の新作ニット', 'Fall Arrivals'))
    await dialogShot(page, `${L}-02-card-dialog`)
    await clickLabel(page, T(L, '商品情報を開く', 'Open product info')).catch(() => undefined)
    await sleep(800)
    await dialogShot(page, `${L}-03-product-info`)
    await closeDialog(page)
  },
  async aiTabs(page, L) {
    await open(page, T(L, '秋の新作ニット', 'Fall Arrivals'))
    for (const [k, tab] of [
      ['04-theme', T(L, '① テーマ', '1. Theme')],
      ['05-template', T(L, '② テンプレート', '2. Template')],
      ['06-hero', T(L, '③ ヒーロー', '3. Hero')],
      ['07-sections', T(L, '④ セクション', '4. Sections')],
    ]) {
      await click(page, tab, { tag: '[role=tab]' })
      await sleep(600)
      await dialogShot(page, `${L}-${k}`)
    }
    await closeDialog(page)
  },
  async aiSuggest(page, L) {
    await open(page, CARD(L))
    await click(page, 'AIチャット', { tag: 'div,span' }).catch(() => click(page, 'AI chat', { tag: 'div,span' }))
    await click(page, T(L, '① テーマ', '1. Theme'), { tag: '[role=tab]' })
    await click(page, T(L, '案を作り直す', 'Regenerate ideas'), { tag: 'button' }).catch(() => click(page, T(L, 'AIで案を出す', 'Suggest with AI'), { tag: 'button' }))
    await idle(page)
    await dialogShot(page, `${L}-08-ai-theme-ideas`)
    await click(page, T(L, '③ ヒーロー', '3. Hero'), { tag: '[role=tab]' })
    await click(page, T(L, 'メイン画像をAIで選定', 'Select main image with AI'), { tag: 'button' })
    await idle(page)
    await dialogShot(page, `${L}-09-ai-hero`)
    await click(page, T(L, '④ セクション', '4. Sections'), { tag: '[role=tab]' })
    await click(page, T(L, 'このセクションをまとめてAIで選定', 'Select this whole section with AI'), { tag: 'button' })
    await idle(page, 1200)
    await dialogShot(page, `${L}-10-ai-section`)
    await closeDialog(page)
  },
  async aiChat(page, L) {
    await open(page, CARD(L))
    await click(page, T(L, '④ セクション', '4. Sections'), { tag: '[role=tab]' })
    await page.type('[role=dialog] textarea[placeholder^="AI"], [role=dialog] textarea[placeholder^="Tell"]', T(L, 'もっと手頃な価格の商品で', 'Use more affordable products'))
    await page.keyboard.press('Enter')
    await idle(page, 1200)
    await dialogShot(page, `${L}-11-ai-chat-update`)
    await page.type('[role=dialog] textarea[placeholder^="AI"], [role=dialog] textarea[placeholder^="Tell"]', T(L, 'この構成をどう思う?', 'What do you think of this lineup?'))
    await page.keyboard.press('Enter')
    await idle(page, 1200)
    await dialogShot(page, `${L}-12-ai-chat-answer`)
    await closeDialog(page)
  },
  async productDetail(page, L) {
    await open(page, CARD(L))
    const code = T(L, 'P07', 'U07')
    const ok = await page.evaluate((code) => {
      const el = [...document.querySelectorAll('[role=dialog] *')].find((e) => e.children.length === 0 && (e.textContent ?? '').startsWith(code) && e.getBoundingClientRect().x > 1000)
      el?.click()
      return !!el
    }, code)
    if (!ok) throw new Error('商品行が見つかりません')
    await sleep(1200)
    await dialogShot(page, `${L}-13-product-detail`)
    await closeDialog(page)
  },
  async templates(page, L) {
    await click(page, T(L, 'テンプレート', 'Templates'), { tag: 'button' })
    await page.waitForSelector('[role=dialog]')
    await sleep(1000)
    await dialogShot(page, `${L}-14-template-manager`)
    await click(page, 'Feature + 3-column grid', { tag: 'div,span' })
    await sleep(600)
    await dialogShot(page, `${L}-15-template-custom`)
    await closeDialog(page)
  },
}

try {
  for (const L of ['ja', 'en']) {
    const page = await fresh(L)
    for (const [name, fn] of Object.entries(SCENES)) {
      try {
        await fn(page, L)
      } catch (e) {
        console.error(`失敗: ${name}:`, e.message)
      }
    }
    await page.close()
  }
} finally {
  await browser.close().catch(() => undefined)
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' })
  else edge.kill()
  await sleep(1000)
  server?.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* 後始末に失敗しても無視 */
  }
}

export { click, clickLabel, idle, dialogShot }
