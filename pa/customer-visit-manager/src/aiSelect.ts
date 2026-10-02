import { MicrosoftCopilotStudioService } from './generated/services/MicrosoftCopilotStudioService'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'

// 公開済みの Copilot Studio エージェント(スキーマ名)。仕様は docs/copilot-agent.md
export const COPILOT_AGENT_NAME = 'new_cr854_deliveryagent'

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
  if (start < 0 || end < start) throw new Error(`エージェントの応答に JSON が含まれていません。応答の冒頭: ${text.slice(0, 300)}`)
  return JSON.parse(text.slice(start, end + 1))
}

/** 応答オブジェクトから最終応答テキストを取り出す(プロパティの大文字小文字の揺れに対応) */
function responseText(data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>
  const last = d.lastResponse ?? d.LastResponse
  if (typeof last === 'string' && last) return last
  const list = (d.responses ?? d.Responses) as unknown
  if (Array.isArray(list) && list.length > 0) return String(list[list.length - 1])
  const completed = d.completed ?? d.Completed
  if (completed === false) throw new Error('エージェントの処理が完了しませんでした(応答なし)')
  throw new Error('エージェントから応答がありませんでした')
}

/** プロンプトと入力 JSON をエージェントへ送り、応答の JSON オブジェクトを返す */
export async function askAgent(prompt: string, payload: unknown): Promise<Record<string, unknown>> {
  const res = await MicrosoftCopilotStudioService.ExecuteCopilotAsyncV2(COPILOT_AGENT_NAME, {
    message: prompt + JSON.stringify(payload),
    notificationUrl: 'https://notificationurlplaceholder',
  })
  if (!res.success) throw new Error(res.error?.message ?? 'エージェントの呼び出しに失敗しました')
  const parsed = extractJson(responseText(res.data)) as Record<string, unknown>
  if (typeof parsed.error === 'string') throw new Error(`エージェントからのエラー: ${parsed.error}`)
  return parsed
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
function toSelection(raw: unknown, pool: Cr854_products[], slots: number): ProductSelection {
  const byCode = new Map(pool.map((p) => [p.cr854_productcode, p.cr854_productid]))
  const seen = new Set<string>()
  const rows: ProposedRow[] = []
  for (const it of (raw as { code?: string; reason?: string }[] | undefined) ?? []) {
    const id = it.code ? byCode.get(it.code) : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    rows.push({ productId: id, reason: it.reason ?? '' })
  }
  if (rows.length === 0) throw new Error('エージェントが選んだ商品を候補から特定できませんでした')
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
}

/** 見出しだけ作り直す */
export async function proposeSectionTitles(args: SectionArgs): Promise<TitleCandidate[]> {
  const parsed = await askAgent(TITLES_PROMPT, sectionPayload('select_section_titles', args))
  const titles = toTitles(parsed.titles, args.section.wantTitle)
  if (titles.length === 0) throw new Error('見出しの候補を取得できませんでした')
  return titles
}

/** コピーだけ作り直す */
export async function proposeSectionCopies(args: SectionArgs): Promise<CopyCandidate[]> {
  const parsed = await askAgent(COPIES_PROMPT, sectionPayload('select_section_copies', args))
  const copies = toCopies(parsed.copies)
  if (copies.length === 0) throw new Error('コピーの候補を取得できませんでした')
  return copies
}

/** 商品だけ選び直す */
export async function proposeSectionProducts(
  args: SectionArgs & { excludedProductIds: Set<string>; products: Cr854_products[]; hero?: Cr854_heroimages },
): Promise<ProductSelection> {
  const pool = args.products.filter((p) => !args.excludedProductIds.has(p.cr854_productid))
  const parsed = await askAgent(PRODUCTS_PROMPT, {
    ...sectionPayload('select_section_products', args),
    products: pool.map(productPayload),
  })
  return toSelection(parsed.products, pool, args.section.slots)
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
  if (!hero && candidates.length === 0) throw new Error('メイン画像を候補から特定できませんでした')
  return { hero, candidates: candidates.slice(0, CANDIDATE_COUNT) }
}
