import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { askAgent, type AiCard, type CopyLanguage } from './aiSelect'

// テーマ・コピー・制作指示の「案」の生成。出力形式はメッセージ内で毎回指定する(aiSelect.ts と同じ理由)

const THEME_PROMPT = `あなたは、ファッション通販の配信(メール・プッシュ)を企画するアシスタントです。
下の「入力」の JSON を読み、この配信にふさわしい「配信テーマ」(配信全体の前提。メールには表示しない)の案を 3 つ、理由とともに JSON だけで返してください。

# 出力の形式(厳守)
次の JSON オブジェクト 1 つだけを返す。説明文、見出し、箇条書き、コードフェンス(\`\`\`)、前置き、あとがきは一切付けない。
{"themes":[{"theme":"...","reason":"..."}]}

# ルール
1. テーマは日本語で 20 文字以内の名詞句(例:「秋の新作を先取り」「雨の日でも快適」)。
2. 配信日(card.scheduledAt)の季節と時期、国、チャネル、部署、配信名(card.name)を手がかりにする。
3. otherThemes(他の配信で使用中のテーマ)と、同じ・似たテーマは避ける。
4. products の中で、在庫(stock)が十分あり、売上トレンド(salesTrend)が「上昇」の商品が活きるテーマを優先する。
5. 3 案は、切り口を変える(例: 季節感、商品カテゴリ、シーンや天候)。
6. 理由(reason)は日本語で 60 文字以内。時期や商品の傾向など、根拠を具体的に書く。

# 入力
`

const COPY_PROMPT = `あなたは、ファッション通販の配信(メール・プッシュ)のコピーライターです。
下の「入力」の JSON を読み、メイン画像に載せる「ヘッドライン」と、その下に入る「コピー」の組を、3 案、JSON だけで返してください。

# 出力の形式(厳守)
次の JSON オブジェクト 1 つだけを返す。説明文、見出し、箇条書き、コードフェンス(\`\`\`)、前置き、あとがきは一切付けない。
{"copies":[{"headline":"...","lead":"...","angle":"..."}]}

# ルール
1. 言語は language に従う('ja' は日本語、'en' は英語)。'auto' のときは card.country に合わせる(US は英語、JP は日本語)。
2. ヘッドラインは、メイン画像の上に大きく載る短い言葉。15 文字前後(10〜18 文字。英語も文字数で数える)で、目を引き、テーマの魅力が一瞬で伝わるようにする。card.theme(配信全体の前提)の文言をそのまま使わず、印象的な表現にする。
3. コピーは、ヘッドラインの下に入る導入の 1 文。30 文字前後(25〜35 文字)で、ヘッドラインを補い、商品や使う場面の魅力が伝わるようにする。ヘッドラインの言い換えだけにしない。
4. ヘッドラインとコピーは、組として自然につながるようにする。3 案は、切り口を変える(例: 季節感、商品の魅力、行動の呼びかけ)。angle には、その切り口を日本語 10 文字以内で書く。
5. 商品名や価格を、そのまま羅列しない。誇大な表現や、根拠のない断定(「最安値」「絶対」など)は使わない。
6. 既存のヘッドライン(card.headline)やコピー(card.copy)がある場合は、それとは別の案にする。

# 入力
`

const INSTRUCTIONS_PROMPT = `あなたは、ファッション通販の配信(メール・プッシュ)の制作ディレクターです。
下の「入力」の JSON を読み、制作担当者向けの「制作指示」の案を 3 つ、JSON だけで返してください。

# 出力の形式(厳守)
次の JSON オブジェクト 1 つだけを返す。説明文、見出し、箇条書き、コードフェンス(\`\`\`)、前置き、あとがきは一切付けない。
{"instructions":[{"text":"...","angle":"..."}]}

# ルール
1. 日本語で、1 案 200〜240 文字。制作担当者に、細かくイメージを伝えられるようにする。
2. レイアウト(メインビジュアルと商品グリッドの構成、商品数)、メイン画像の雰囲気、色やトーン、強調する点、注意点を、具体的に含める。
3. products の並び順(先頭が最も重要)と、hero(メイン画像)の内容を踏まえる。
4. 3 案は、方針を変える(例: 王道の構成、商品を主役にする、世界観を重視する)。angle には、その方針を日本語 10 文字以内で書く。
5. 既存の制作指示(card.instructions)がある場合は、その方針を尊重しつつ、別の案にする。
6. card.headline(ヘッドライン)と card.copy(コピー)がある場合は、その世界観に合わせる。

# 入力
`

export interface ThemeSuggestion {
  theme: string
  reason: string
}

export async function suggestThemes(args: {
  card: AiCard
  otherThemes: string[]
  products: Cr854_products[]
}): Promise<ThemeSuggestion[]> {
  const { card, otherThemes, products } = args
  const parsed = (await askAgent(THEME_PROMPT, {
    task: 'suggest_themes',
    today: new Date().toISOString().slice(0, 10),
    card,
    otherThemes,
    products: products.map((p) => ({
      name: p.cr854_name,
      category: p.cr854_categoryname,
      stock: p.cr854_stock,
      season: p.cr854_seasonname,
      salesTrend: p.cr854_salestrendname,
      weather: p.cr854_weathername,
    })),
  })) as { themes?: { theme?: string; reason?: string }[] }

  const list = (parsed.themes ?? [])
    .filter((t) => t.theme)
    .map((t) => ({ theme: String(t.theme), reason: String(t.reason ?? '') }))
  if (list.length === 0) throw new Error('テーマ案を取得できませんでした')
  return list
}

interface DraftContext {
  card: AiCard
  /** コピー・ヘッドラインの言語 */
  language: CopyLanguage
  items: { product?: Cr854_products; reason: string }[]
  hero?: Cr854_heroimages
}

const contextPayload = ({ card, language, items, hero }: DraftContext) => ({
  card,
  language,
  products: items.map((i) => ({
    name: i.product?.cr854_name,
    category: i.product?.cr854_categoryname,
    price: i.product?.cr854_price,
    reason: i.reason,
  })),
  hero: hero
    ? { name: hero.cr854_name, purpose: hero.cr854_purposename, season: hero.cr854_seasonname, tags: hero.cr854_tags, description: hero.cr854_description }
    : null,
})

export interface CopyIdea {
  headline: string
  lead: string
  angle: string
}

export async function suggestCopies(ctx: DraftContext): Promise<CopyIdea[]> {
  const parsed = (await askAgent(COPY_PROMPT, { task: 'suggest_copies', ...contextPayload(ctx) })) as {
    copies?: { headline?: string; lead?: string; angle?: string }[]
  }
  const list = (parsed.copies ?? [])
    .filter((c) => c.headline)
    .map((c) => ({ headline: String(c.headline), lead: String(c.lead ?? ''), angle: String(c.angle ?? '') }))
  if (list.length === 0) throw new Error('ヘッドラインとコピーの案を取得できませんでした')
  return list
}

export interface InstructionIdea {
  text: string
  angle: string
}

export async function suggestInstructions(ctx: DraftContext): Promise<InstructionIdea[]> {
  const parsed = (await askAgent(INSTRUCTIONS_PROMPT, { task: 'suggest_instructions', ...contextPayload(ctx) })) as {
    instructions?: { text?: string; angle?: string }[]
  }
  const list = (parsed.instructions ?? []).filter((c) => c.text).map((c) => ({ text: String(c.text), angle: String(c.angle ?? '') }))
  if (list.length === 0) throw new Error('制作指示の案を取得できませんでした')
  return list
}
