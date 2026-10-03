import { Cr854_airequestsService } from './generated/services/Cr854_airequestsService'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { getLang, tr } from './i18n'

// AI要求テーブルの状態(選択肢の値)。エージェントは、フロー「AI要求の処理」が呼ぶ。仕様は docs/ai-queue.md、docs/copilot-agent.md
const STATUS_WAITING = 588230000
const STATUS_DONE = 588230001
const STATUS_ERROR = 588230002
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 180000

/** コピーの言語: auto = 配信の国に合わせる(US は英語、JP は日本語) */
export type CopyLanguage = 'auto' | 'ja' | 'en'

/** 候補として挙げる件数(セクションごと・メイン画像) */
export const CANDIDATE_COUNT = 3
/** 見出し・コピーの候補の件数 */
export const TITLE_CANDIDATE_COUNT = 3

// エージェントの指示欄に頼らず、毎回メッセージに出力形式とルールを含める
// (標準ハーネスのエージェントは、指示欄の「JSON だけ返す」を守らず文章に整形して返すことがあるため)

const INTRO = `あなたは、ファッション通販の配信(メール・プッシュ)を企画するアシスタントです。\n`

const FORMAT_HEAD = `# 出力の形式(厳守)
次の JSON オブジェクト 1 つだけを返す。説明文、見出し、箇条書き、コードフェンス(\`\`\`)、前置き、あとがきは一切付けない。
`

const ERROR_RULE = `- 入力の JSON が不正、または card.theme が空のときは、{"error":"理由を日本語で簡潔に"} だけを返す。\n`

const TITLE_RULES = `# 見出し(title)のルール
1. 日本語で 12 文字以内。そのセクションの商品に共通する切り口を、配信テーマに沿って表す(例:「寒い日のアウター」「重ね着のニット」「足元から秋支度」)。
2. 商品カテゴリ名(「アウター」など)だけの見出しは避け、テーマや使う場面が伝わる言葉にする。
3. 案どうしで、切り口を変える。otherSections にある他のセクションの見出しとも、切り口が重ならないようにする。
4. reason は日本語で 40 文字以内。その見出しがどんな商品のまとまりを表すかを書く。
5. メイン画像(hero)、ヘッドライン(card.headline)、コピー(card.copy)が決まっている場合は、それらの世界観・訴求と整合させる(色味や雰囲気、言葉づかい、季節感)。
`

const COPY_RULES = `# セクションのコピー(copies)のルール
1. そのセクションを紹介する導入文(コピー)。言語は language に従う('ja' は日本語、'en' は英語)。'auto' のときは card.country に合わせる(US は英語、JP は日本語)。
2. 長さは 30 文字前後(25〜35 文字。英語も文字数で数える)。1 文で、そのセクションの見出し(section.title)や商品の魅力、使う場面が伝わるようにする。
3. 案どうしで、切り口を変える。angle には、その切り口を日本語 10 文字以内で書く。
4. 配信全体のヘッドライン(card.headline)やコピー(card.copy)、配信テーマの言い換えだけにならないようにする。otherSections の他のセクションとも、言い回しが重ならないようにする。
5. 誇大な表現や、根拠のない断定(「最安値」「絶対」など)は使わない。
6. メイン画像(hero)、ヘッドライン(card.headline)、コピー(card.copy)が決まっている場合は、それらの世界観・訴求と整合させる(色味や雰囲気、言葉づかい、季節感)。
`

const PRODUCT_RULES = `# 商品選定のルール
1. 商品は products の中からだけ選ぶ。候補にないものを作らない。code は入力のとおりに返す。同じ code を重複させない。
2. 配信テーマ(card.theme)との適合を最優先にする。次に、セクションの見出し(section.title)とコピー(section.copy)、card.headline(ヘッドライン)、card.copy(コピー)と card.instructions の内容、配信日(scheduledAt)の季節、国とチャネルを考慮する。
3. 在庫(stock)が少ない商品(50 未満)は避ける。やむを得ず選ぶときは、理由に在庫が少ないことを書く。
4. 同じ条件なら、売上トレンドが「上昇」の商品、レビュー評価が高い商品を優先する。売上トレンドが「下降」の商品は避ける。
5. 季節(season)が配信日の季節と合わない商品は避ける。「通年」はいつでも使える。
6. 商品は、見出しの切り口(または配信テーマ)に合う、関連性の高いものでまとめる。テーマが特定のカテゴリ(例:「ブーツ特集」)を指す場合は、そのカテゴリを中心にする。
7. 先頭は、このセクションの切り口を最もよく表す商品にする。
8. 理由(reason)は日本語。選定した商品は 60 文字以内で、テーマとの関係や、在庫・売上トレンド・評価などの根拠を、具体的な数値や語を使って書く。候補は 40 文字以内で、選定との違いや、次点である理由を書く。
9. メイン画像(hero)、ヘッドライン(card.headline)、コピー(card.copy)が決まっている場合は、それらの世界観・訴求と整合させる(色味や雰囲気、言葉づかい、季節感)。メイン画像に写る商品の種類や色味とも、調和するものを選ぶ。
`

const PRODUCTS_FORMAT = `- products は、優先度の高い順に並べる。先頭から section.slots 件が「選定」、その続き ${CANDIDATE_COUNT} 件が「残りの候補」。候補が足りなければ、選べた分だけ。\n`
const TITLES_FORMAT = `- titles は、切り口の異なる見出しの案を ${TITLE_CANDIDATE_COUNT} つ。section.wantTitle が false のときは空の配列([])にする。\n`
const COPIES_FORMAT = `- copies は、切り口の異なるコピーの案を ${TITLE_CANDIDATE_COUNT} つ。\n`

/** 1 セクションを一括で(見出し・コピーの候補、商品の選定 + 候補) */
const SECTION_PROMPT = `${INTRO}下の「入力」の JSON を読み、メールの 1 つのセクションの「見出しの候補」「コピーの候補」「掲載商品とその候補」を、JSON だけで返してください。

${FORMAT_HEAD}{"titles":[{"title":"...","reason":"..."}],"copies":[{"copy":"...","angle":"..."}],"products":[{"code":"P01","reason":"..."}]}
${TITLES_FORMAT}${COPIES_FORMAT}${PRODUCTS_FORMAT}${ERROR_RULE}
${TITLE_RULES}
${COPY_RULES}
${PRODUCT_RULES}
# 入力
`

/** 見出しだけ作り直す */
const TITLES_PROMPT = `${INTRO}下の「入力」の JSON を読み、メールの 1 つのセクションの「見出しの候補」を、JSON だけで返してください。

${FORMAT_HEAD}{"titles":[{"title":"...","reason":"..."}]}
${TITLES_FORMAT}${ERROR_RULE}- section.copy や section.productNames がすでにある場合は、それらに合う見出しにする。

${TITLE_RULES}
# 入力
`

/** コピーだけ作り直す(見出しと、選ばれた商品を踏まえる) */
const COPIES_PROMPT = `${INTRO}下の「入力」の JSON を読み、メールの 1 つのセクションの「コピーの候補」を、JSON だけで返してください。

${FORMAT_HEAD}{"copies":[{"copy":"...","angle":"..."}]}
${COPIES_FORMAT}${ERROR_RULE}- section.title(見出し)と section.productNames(選ばれた商品)がある場合は、それらを踏まえる。

${COPY_RULES}
# 入力
`

/** 商品だけ選び直す(見出しとコピーを踏まえる) */
const PRODUCTS_PROMPT = `${INTRO}下の「入力」の JSON を読み、メールの 1 つのセクションに載せる「掲載商品とその候補」を、JSON だけで返してください。

${FORMAT_HEAD}{"products":[{"code":"P01","reason":"..."}]}
${PRODUCTS_FORMAT}${ERROR_RULE}
${PRODUCT_RULES}
# 入力
`

const HERO_PROMPT = `${INTRO}下の「入力」の JSON を読み、メールの「メイン画像」と「その候補」を、理由とともに JSON だけで返してください。

${FORMAT_HEAD}{"hero":{"code":"H01","reason":"..."},"candidates":[{"code":"H02","reason":"..."}]}
- candidates は、hero 以外の候補を、優先度の高い順に ${CANDIDATE_COUNT} 件。
${ERROR_RULE}- 適切なメイン画像がないときは、"hero" を null にする。

# ルール
1. 画像は heroes の中からだけ選ぶ。候補にないものを作らない。code は入力のとおりに返し、重複させない。
2. 配信テーマ(card.theme)との適合を最優先にする。次に、配信日(scheduledAt)の季節、用途(purpose)、タグ(tags)、国とチャネルを考慮する。
3. 掲載商品(products)がすでにある場合は、その雰囲気と合う画像を優先する。
4. 理由(reason)は日本語。選んだ画像は 60 文字以内で、テーマ・季節・用途・タグとの関係を書く。候補は 40 文字以内で、選定との違いや、次点である理由を書く。

# 入力
`

export interface AiCard {
  name: string
  scheduledAt: string
  country: string
  channel: string
  department: string
  /** 配信全体の前提(メールには表示しない) */
  theme: string
  /** メイン画像に載せる大見出し */
  headline: string
  /** ヘッドラインの下の導入文(コピー) */
  copy: string
  instructions: string
}

export interface ProposedRow {
  productId: string
  reason: string
}

export interface ProposedHero {
  heroId: string
  reason: string
}

export interface TitleCandidate {
  title: string
  reason: string
}

export interface CopyCandidate {
  copy: string
  angle: string
}

/** 商品の選定結果(選定 + 候補) */
export interface ProductSelection {
  selected: ProposedRow[]
  candidates: ProposedRow[]
}

/** 1 セクションの AI の結果(一括) */
export interface SectionProposal extends ProductSelection {
  titles: TitleCandidate[]
  /** 設定する見出し(titles の先頭) */
  title: string
  copies: CopyCandidate[]
  /** 設定するコピー(copies の先頭) */
  copy: string
}

/** メイン画像の結果 */
export interface HeroProposal {
  hero: ProposedHero | null
  candidates: ProposedHero[]
}

/** エージェントの応答テキストから JSON 部分を取り出す(前後の説明文やコードフェンスがあっても読む) */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(tr(`エージェントの応答に JSON が含まれていません。応答の冒頭: ${text.slice(0, 300)}`, `The agent's response contains no JSON. Start of response: ${text.slice(0, 300)}`))
  const body = text.slice(start, end + 1)
  try {
    return JSON.parse(body)
  } catch (e) {
    // よくある崩れ(末尾のカンマ)だけは直して読む。直らなければ、もとのエラーを返す
    try {
      return JSON.parse(body.replace(/,(\s*[}\]])/g, '$1'))
    } catch {
      throw e
    }
  }
}

// 文字列の中の半角ダブルクォートは、JSON を壊す原因になる
const JSON_NOTE = '【重要】返答の JSON は、文字列の中に半角のダブルクォート(")を入れないこと。強調や引用には「」を使う。\n\n'
// 画面の言語が英語のときは、画面に表示する説明文を英語で書かせる(コピー・見出しの言語は language が決める)
const EN_NOTE = '【重要】画面に表示する文章(テーマ、見出し、理由、切り口、制作指示など)は、すべて自然な英語で書くこと。以下の指示にある日本語の例は、書式の参考であり、出力は英語にする。\n\n'
const PARSE_ATTEMPTS = 3

// ---- チャット: 案づくりに、ユーザーの指示と、これまでの対話を加える ----
export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

// withChat の実行中だけ有効な、対話の履歴。askAgent が、依頼に加える
let activeChat: ChatTurn[] | null = null
let lastReply = ''
const CHAT_HISTORY_LIMIT = 12

const chatNote = () =>
  `【ユーザーとの対話】入力の chat は、ユーザーとあなたのこれまでの対話(古い順)。最後の user の発言が、最新の依頼。` +
  `その依頼を最優先で反映する。「必ず含める」「〜しない」のような条件は厳守し、前の user の発言にある条件も引き継ぐ。` +
  `以下の通常のルールと矛盾する場合は、ユーザーの依頼を優先する(ただし、出力の形式と、商品は products の中からだけ選ぶ、というルールは守る)。` +
  `返答の JSON のトップレベルに、reply(依頼にどう応えたかを、1〜2 文で。${getLang() === 'en' ? '英語' : '日本語'}で)を加える。\n\n`

/**
 * fn の中の AI への依頼に、対話の履歴(chat)を加える。AI が添えた reply(依頼にどう応えたかの一言)も返す。
 * 同時に複数の依頼を流すと混ざるので、チャットの送信中は、呼び出し側で 1 件ずつにすること。
 */
export async function withChat<T>(turns: ChatTurn[], fn: () => Promise<T>): Promise<{ value: T; reply: string }> {
  activeChat = turns.slice(-CHAT_HISTORY_LIMIT)
  lastReply = ''
  try {
    const value = await fn()
    return { value, reply: lastReply }
  } finally {
    activeChat = null
  }
}

/**
 * 画面が英語のとき、指示文の「日本語で書く」という指定を「英語で書く」に直し、文字数の上限を英語の長さに合わせる。
 * コピーの言語の指定('ja' は日本語、'en' は英語)など、出力の言語を決めない箇所は変えない。
 */
function localizePrompt(prompt: string): string {
  if (getLang() !== 'en') return prompt
  return prompt
    .replace(/日本語で/g, '英語で')
    .replace(/日本語(?= ?\d)/g, '英語')
    .replace(/は日本語。/g, 'は英語。')
    .replace(/200〜240 文字/g, '420〜520 文字')
    .replace(/(\d+) 文字以内/g, (_, n: string) => `${Math.round(Number(n) * 2.2)} 文字以内`)
}

/** プロンプトと入力 JSON をエージェントへ送り、応答の JSON オブジェクトを返す。返答の JSON が壊れていたときは、依頼し直す */
export async function askAgent(prompt: string, payload: unknown): Promise<Record<string, unknown>> {
  let lastError: unknown
  for (let attempt = 0; attempt < PARSE_ATTEMPTS; attempt++) {
    const chat = activeChat
    const body = chat && chat.length > 0 ? { ...(payload as object), chat } : payload
    const text = await askText((getLang() === 'en' ? EN_NOTE : '') + JSON_NOTE + (chat && chat.length > 0 ? chatNote() : '') + localizePrompt(prompt) + JSON.stringify(body))
    try {
      const parsed = extractJson(text) as Record<string, unknown>
      if (typeof parsed.error === 'string') throw new Error(tr(`エージェントからのエラー: ${parsed.error}`, `Error from the agent: ${parsed.error}`))
      if (chat && chat.length > 0) lastReply = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
      return parsed
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
      lastError = e
    }
  }
  throw lastError
}

/** 依頼文をエージェントへ送り、返答のテキストを返す */
async function askText(message: string): Promise<string> {
  // ゲストでも使えるよう、Copilot Studio は直接呼ばない。依頼を AI要求テーブルに書き、フロー(Power Automate)の返答を待つ
  const created = await Cr854_airequestsService.create({
    cr854_name: `req-${new Date().toISOString()}`,
    cr854_prompt: message,
    cr854_status: STATUS_WAITING,
    statecode: 0,
  })
  const id = created.data?.cr854_airequestid
  if (!created.success || !id) throw new Error(created.error?.message ?? tr('AI の依頼を登録できませんでした', 'Could not register the AI request'))
  try {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const got = await Cr854_airequestsService.get(id)
      if (!got.success || !got.data) continue
      const status = got.data.cr854_status
      if (status === STATUS_ERROR) throw new Error(got.data.cr854_response || tr('エージェントの呼び出しに失敗しました', 'Failed to call the agent'))
      if (status !== STATUS_DONE) continue
      return got.data.cr854_response ?? ''
    }
    throw new Error(tr('AI の返答がタイムアウトしました。フロー「AI要求の処理」がオンか確認してください', 'The AI response timed out. Check that the flow "AI要求の処理" is turned on'))
  } finally {
    // 読み取ったあと(失敗時も)、依頼の行は消す
    void Cr854_airequestsService.delete(id).catch(() => undefined)
  }
}

const today = () => new Date().toISOString().slice(0, 10)

const productPayload = (p: Cr854_products) => ({
  code: p.cr854_productcode,
  name: p.cr854_name,
  category: p.cr854_categoryname,
  price: p.cr854_price,
  stock: p.cr854_stock,
  season: p.cr854_seasonname,
  salesTrend: p.cr854_salestrendname,
  rating: p.cr854_rating,
  weather: p.cr854_weathername,
  description: p.cr854_description,
})

export interface SectionRequest {
  slots: number
  wantTitle: boolean
  kind: 'grid' | 'feature'
}

/** 他のセクションの状況(切り口と商品が重ならないようにするための情報) */
export interface OtherSection {
  index: number
  title: string
  copy: string
  productNames: string[]
}

/** 対象セクションの現在の内容(個別の作り直しで、すでに決まっている部分を踏まえるための情報) */
export interface SectionState {
  title?: string
  copy?: string
  productNames?: string[]
}

interface SectionArgs {
  card: AiCard
  section: SectionRequest
  others: OtherSection[]
  current?: SectionState
  /** 設定済みのメイン画像とその選定理由(見出し・コピー・商品の材料) */
  hero?: Cr854_heroimages
  heroReason?: string
  /** コピーの言語 */
  language: CopyLanguage
}

const heroPayload = (h?: Cr854_heroimages, reason?: string) =>
  h
    ? {
        code: h.cr854_imagecode,
        name: h.cr854_name,
        purpose: h.cr854_purposename,
        season: h.cr854_seasonname,
        tags: h.cr854_tags,
        description: h.cr854_description,
        reason: reason || undefined,
      }
    : null

const sectionPayload = (task: string, a: SectionArgs) => ({
  task,
  today: today(),
  card: a.card,
  language: a.language,
  hero: heroPayload(a.hero, a.heroReason),
  section: { ...a.section, ...a.current },
  otherSections: a.others,
})

const toTitles = (raw: unknown, wantTitle: boolean): TitleCandidate[] =>
  wantTitle
    ? ((raw as { title?: string; reason?: string }[] | undefined) ?? [])
        .filter((t) => t.title)
        .map((t) => ({ title: String(t.title), reason: String(t.reason ?? '') }))
        .slice(0, TITLE_CANDIDATE_COUNT)
    : []

const toCopies = (raw: unknown): CopyCandidate[] =>
  ((raw as { copy?: string; angle?: string }[] | undefined) ?? [])
    .filter((c) => c.copy)
    .map((c) => ({ copy: String(c.copy), angle: String(c.angle ?? '') }))
    .slice(0, TITLE_CANDIDATE_COUNT)

/** 商品のコードを ID に変換し、選定 + 候補に分ける(候補にないコードと重複は捨てる) */
/** エージェントの返答を、候補の商品に対応づけられなかった(依頼し直せば解決することが多い) */
class MatchError extends Error {}

/** MatchError のときだけ、依頼し直す(通信の失敗やタイムアウトは、やり直さない) */
async function retryOnMatchError<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof MatchError)) throw e
      last = e
    }
  }
  throw last
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase()

function toSelection(raw: unknown, pool: Cr854_products[], slots: number): ProductSelection {
  // コードの大文字小文字・前後の空白の違い、code 以外のキー名、商品名での返答も受け付ける
  const byCode = new Map(pool.map((p) => [norm(p.cr854_productcode), p.cr854_productid]))
  const byName = new Map(pool.map((p) => [norm(p.cr854_name), p.cr854_productid]))
  const seen = new Set<string>()
  const rows: ProposedRow[] = []
  type Raw = { code?: string; productCode?: string; product_code?: string; id?: string; name?: string; productName?: string; reason?: string }
  const list = Array.isArray(raw) ? (raw as (Raw | string)[]) : []
  for (const entry of list) {
    const it: Raw = typeof entry === 'string' ? { code: entry } : entry
    const id =
      byCode.get(norm(it.code ?? it.productCode ?? it.product_code ?? it.id)) ?? byName.get(norm(it.name ?? it.productName ?? it.code))
    if (!id || seen.has(id)) continue
    seen.add(id)
    rows.push({ productId: id, reason: it.reason ?? '' })
  }
  if (rows.length === 0) throw new MatchError(tr('エージェントが選んだ商品を候補から特定できませんでした', 'Could not match the products the agent chose to the candidates'))
  const n = Number.isFinite(slots) ? slots : rows.length
  return { selected: rows.slice(0, n), candidates: rows.slice(n, n + CANDIDATE_COUNT) }
}

/** 1 つのセクションを一括で提案させる(見出し・コピーの候補 + 商品の選定と候補) */
export async function proposeSection(
  args: SectionArgs & {
    /** 他のセクションですでに使っている商品(候補にも出さない) */
    excludedProductIds: Set<string>
    products: Cr854_products[]
    hero?: Cr854_heroimages
  },
): Promise<SectionProposal> {
  const pool = args.products.filter((p) => !args.excludedProductIds.has(p.cr854_productid))
  return retryOnMatchError(async () => {
    const parsed = await askAgent(SECTION_PROMPT, {
      ...sectionPayload('select_section', args),
      products: pool.map(productPayload),
    })
    const titles = toTitles(parsed.titles, args.section.wantTitle)
    const copies = toCopies(parsed.copies)
    return {
      ...toSelection(parsed.products, pool, args.section.slots),
      titles,
      title: titles[0]?.title ?? '',
      copies,
      copy: copies[0]?.copy ?? '',
    }
  })
}

/** 見出しだけ作り直す */
export async function proposeSectionTitles(args: SectionArgs): Promise<TitleCandidate[]> {
  const parsed = await askAgent(TITLES_PROMPT, sectionPayload('select_section_titles', args))
  const titles = toTitles(parsed.titles, args.section.wantTitle)
  if (titles.length === 0) throw new Error(tr('見出しの候補を取得できませんでした', 'Could not get heading candidates'))
  return titles
}

/** コピーだけ作り直す */
export async function proposeSectionCopies(args: SectionArgs): Promise<CopyCandidate[]> {
  const parsed = await askAgent(COPIES_PROMPT, sectionPayload('select_section_copies', args))
  const copies = toCopies(parsed.copies)
  if (copies.length === 0) throw new Error(tr('コピーの候補を取得できませんでした', 'Could not get copy candidates'))
  return copies
}

/** 商品だけ選び直す */
export async function proposeSectionProducts(
  args: SectionArgs & { excludedProductIds: Set<string>; products: Cr854_products[]; hero?: Cr854_heroimages },
): Promise<ProductSelection> {
  const pool = args.products.filter((p) => !args.excludedProductIds.has(p.cr854_productid))
  return retryOnMatchError(async () => {
    const parsed = await askAgent(PRODUCTS_PROMPT, {
      ...sectionPayload('select_section_products', args),
      products: pool.map(productPayload),
    })
    return toSelection(parsed.products, pool, args.section.slots)
  })
}

/** メイン画像(選定 + 候補)を提案させる */
export async function proposeHero(args: {
  card: AiCard
  heroes: Cr854_heroimages[]
  /** すでに選んでいる商品(画像の雰囲気を合わせるための参考) */
  productNames: string[]
}): Promise<HeroProposal> {
  const { card, heroes, productNames } = args
  const parsed = (await askAgent(HERO_PROMPT, {
    task: 'select_hero',
    today: today(),
    card,
    products: productNames,
    heroes: heroes.map((h) => ({
      code: h.cr854_imagecode,
      name: h.cr854_name,
      purpose: h.cr854_purposename,
      season: h.cr854_seasonname,
      tags: h.cr854_tags,
      description: h.cr854_description,
    })),
  })) as {
    hero?: { code?: string; reason?: string } | null
    candidates?: { code?: string; reason?: string }[]
  }

  const byCode = new Map(heroes.map((h) => [h.cr854_imagecode, h.cr854_heroimageid]))
  const toHero = (it?: { code?: string; reason?: string } | null): ProposedHero | null => {
    const id = it?.code ? byCode.get(it.code) : undefined
    return id ? { heroId: id, reason: it?.reason ?? '' } : null
  }
  const hero = toHero(parsed.hero)
  const candidates: ProposedHero[] = []
  for (const it of parsed.candidates ?? []) {
    const h = toHero(it)
    if (h && h.heroId !== hero?.heroId && !candidates.some((c) => c.heroId === h.heroId)) candidates.push(h)
  }
  if (!hero && candidates.length === 0) throw new Error(tr('メイン画像を候補から特定できませんでした', 'Could not match the hero image to the candidates'))
  return { hero, candidates: candidates.slice(0, CANDIDATE_COUNT) }
}
