import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { askAgent, type AiCard } from './aiSelect'

// テーマ案・コピー・制作指示の生成。出力形式はメッセージ内で毎回指定する(aiSelect.ts と同じ理由)

const THEME_PROMPT = `あなたは、ファッション通販の配信(メール・プッシュ)を企画するアシスタントです。
下の「入力」の JSON を読み、この配信にふさわしい「配信テーマ」の案を 3 つ、理由とともに JSON だけで返してください。

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
下の「入力」の JSON を読み、配信の「コピー」と「制作指示」を作って、JSON だけで返してください。

# 出力の形式(厳守)
次の JSON オブジェクト 1 つだけを返す。説明文、見出し、箇条書き、コードフェンス(\`\`\`)、前置き、あとがきは一切付けない。
{"copy":"...","instructions":"..."}

# コピーのルール
1. 言語は card.country に合わせる(US は英語、JP は日本語)。
2. 長さは、チャネルがメールなら 60 文字以内、プッシュなら 40 文字以内。1 文で、テーマの魅力が伝わるようにする。
3. 商品名や価格を、そのまま羅列しない。誇大な表現や、根拠のない断定(「最安値」「絶対」など)は使わない。
4. 既存のコピー(card.copy)がある場合は、その雰囲気を参考にして、別案を出す。

# 制作指示のルール
1. 日本語で、制作担当者向けに 120 文字以内。
2. レイアウト(メインビジュアルと商品グリッドの構成、商品数)、強調する点、注意点を含める。
3. products の並び順(先頭が最も重要)と、hero(メイン画像)の内容を踏まえる。
4. 既存の制作指示(card.instructions)がある場合は、その方針を尊重して補う。

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

export interface CopyDraft {
  copy: string
  instructions: string
}

export async function draftCopy(args: {
  card: AiCard
  items: { product?: Cr854_products; reason: string }[]
  hero?: Cr854_heroimages
}): Promise<CopyDraft> {
  const { card, items, hero } = args
  const parsed = (await askAgent(COPY_PROMPT, {
    task: 'draft_copy_and_instructions',
    card,
    products: items.map((i) => ({
      name: i.product?.cr854_name,
      category: i.product?.cr854_categoryname,
      price: i.product?.cr854_price,
      reason: i.reason,
    })),
    hero: hero ? { name: hero.cr854_name, tags: hero.cr854_tags, description: hero.cr854_description } : null,
  })) as { copy?: string; instructions?: string }

  if (!parsed.copy && !parsed.instructions) throw new Error('コピーと制作指示を取得できませんでした')
  return { copy: String(parsed.copy ?? ''), instructions: String(parsed.instructions ?? '') }
}
