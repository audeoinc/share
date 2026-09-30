import { MicrosoftCopilotStudioService } from './generated/services/MicrosoftCopilotStudioService'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'

// 公開済みの Copilot Studio エージェント(スキーマ名)。仕様は docs/copilot-agent.md
export const COPILOT_AGENT_NAME = 'new_cr854_deliveryagent'

// エージェントの指示欄に頼らず、毎回メッセージに出力形式とルールを含める
// (標準ハーネスのエージェントは、指示欄の「JSON だけ返す」を守らず文章に整形して返すことがあるため)
const PROMPT = `あなたは、ファッション通販の配信(メール・プッシュ)を企画するアシスタントです。
下の「入力」の JSON を読み、配信テーマに合う「掲載商品」と「メイン画像」を選び、理由とともに JSON だけで返してください。

# 出力の形式(厳守)
次の JSON オブジェクト 1 つだけを返す。説明文、見出し、箇条書き、コードフェンス(\`\`\`)、前置き、あとがきは一切付けない。
{"products":[{"code":"P01","reason":"..."}],"hero":{"code":"H01","reason":"..."}}
- 入力の JSON が不正、または card.theme が空のときは、{"error":"理由を日本語で簡潔に"} だけを返す。
- 適切なメイン画像がないときは、"hero" を null にする。

# 選定のルール
1. 商品は products の中から、メイン画像は heroes の中からだけ選ぶ。候補にないものを作らない。code は入力のとおりに返す。
2. 商品は productCount 件を選ぶ。同じ code を重複して選ばない。候補が足りなければ、選べた分だけ返す。
3. 配信テーマ(card.theme)との適合を最優先にする。次に card.copy と card.instructions の内容、配信日(scheduledAt)の季節、国とチャネルを考慮する。
4. 在庫(stock)が少ない商品(50 未満)は避ける。やむを得ず選ぶときは、理由に在庫が少ないことを書く。
5. 同じ条件なら、売上トレンドが「上昇」の商品、レビュー評価が高い商品を優先する。売上トレンドが「下降」の商品は避ける。
6. 季節(season)が配信日の季節と合わない商品は避ける。「通年」はいつでも使える。
7. 商品は、カテゴリが偏りすぎないように選ぶ。ただし、テーマが特定のカテゴリ(例:「ブーツ特集」)を指す場合は、そのカテゴリを中心にする。
8. 商品は、訴求したい順(先頭ほど重要)に並べる。先頭はテーマを最もよく表す商品にする。
9. メイン画像は、テーマ、季節、用途(purpose)、タグ(tags)から最も合うものを 1 つ選ぶ。
10. 理由(reason)は日本語で 60 文字以内。テーマとの関係や、在庫・売上トレンド・評価などの根拠を、具体的な数値や語を使って書く。

# 入力
`

export interface AiCard {
  name: string
  scheduledAt: string
  country: string
  channel: string
  department: string
  theme: string
  copy: string
  instructions: string
}

export interface AiSelection {
  products: { productId: string; reason: string }[]
  hero: { heroId: string; reason: string } | null
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

export async function selectWithAi(args: {
  card: AiCard
  productCount: number
  products: Cr854_products[]
  heroes: Cr854_heroimages[]
}): Promise<AiSelection> {
  const { card, productCount, products, heroes } = args

  const payload = {
    task: 'select_products_and_hero',
    today: new Date().toISOString().slice(0, 10),
    productCount,
    card,
    products: products.map((p) => ({
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
    })),
    heroes: heroes.map((h) => ({
      code: h.cr854_imagecode,
      name: h.cr854_name,
      purpose: h.cr854_purposename,
      season: h.cr854_seasonname,
      tags: h.cr854_tags,
      description: h.cr854_description,
    })),
  }

  const res = await MicrosoftCopilotStudioService.ExecuteCopilotAsyncV2(COPILOT_AGENT_NAME, {
    message: PROMPT + JSON.stringify(payload),
    notificationUrl: 'https://notificationurlplaceholder',
  })
  if (!res.success) throw new Error(res.error?.message ?? 'エージェントの呼び出しに失敗しました')

  const parsed = extractJson(responseText(res.data)) as {
    products?: { code?: string; reason?: string }[]
    hero?: { code?: string; reason?: string } | null
    error?: string
  }
  if (parsed.error) throw new Error(`エージェントからのエラー: ${parsed.error}`)

  // コードから ID へ変換する。候補にないコードや重複は捨てる
  const byCode = new Map(products.map((p) => [p.cr854_productcode, p.cr854_productid]))
  const seen = new Set<string>()
  const picked: AiSelection['products'] = []
  for (const it of parsed.products ?? []) {
    const id = it.code ? byCode.get(it.code) : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    picked.push({ productId: id, reason: it.reason ?? '' })
  }
  if (picked.length === 0) throw new Error('エージェントが選んだ商品を候補から特定できませんでした')

  const heroId = parsed.hero?.code ? heroes.find((h) => h.cr854_imagecode === parsed.hero!.code)?.cr854_heroimageid : undefined
  return {
    products: picked,
    hero: heroId ? { heroId, reason: parsed.hero?.reason ?? '' } : null,
  }
}
