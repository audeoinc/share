// 撮影・デモ用の、サンプルデータ(docs/*.csv から作る)。本番のビルドには含めない(src/mock は、撮影用の設定だけが読み込む)。
import {
  Cr854_deliverycardscr854_channel,
  Cr854_deliverycardscr854_country,
  Cr854_deliverycardscr854_department,
  Cr854_deliverycardscr854_status,
} from '../generated/models/Cr854_deliverycardsModel'
import {
  Cr854_productscr854_category,
  Cr854_productscr854_salestrend,
  Cr854_productscr854_season,
  Cr854_productscr854_weather,
} from '../generated/models/Cr854_productsModel'
import { Cr854_heroimagescr854_purpose, Cr854_heroimagescr854_season } from '../generated/models/Cr854_heroimagesModel'
import { parseCsv } from './csv'

export type Row = Record<string, unknown>

const raw = import.meta.glob('../../docs/*.csv', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const csv = (name: string) => parseCsv(raw[`../../docs/${name}`] ?? '')

/** 文字(キー)から、同じ文字なら、同じ ID になる GUID 形式の ID を作る */
export function guid(key: string): string {
  const parts: string[] = []
  for (let seed = 0; seed < 4; seed++) {
    let h = 2166136261 ^ (seed * 16777619)
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    parts.push((h >>> 0).toString(16).padStart(8, '0'))
  }
  const hex = parts.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const inverse = (map: Record<number, string>) => Object.fromEntries(Object.entries(map).map(([v, l]) => [l, Number(v)])) as Record<string, number>
const CATEGORY = inverse(Cr854_productscr854_category)
const TREND = inverse(Cr854_productscr854_salestrend)
const SEASON = inverse(Cr854_productscr854_season)
const WEATHER = inverse(Cr854_productscr854_weather)
const PURPOSE = inverse(Cr854_heroimagescr854_purpose)
const HERO_SEASON = inverse(Cr854_heroimagescr854_season)
const COUNTRY = inverse(Cr854_deliverycardscr854_country)
const CHANNEL = inverse(Cr854_deliverycardscr854_channel)
const DEPARTMENT = inverse(Cr854_deliverycardscr854_department)
const STATUS = inverse(Cr854_deliverycardscr854_status)

const US_MARKET = 588230001
const JP_MARKET = 588230000

// ---- 商品・メイン画像
export const products: Row[] = [...csv('products.csv'), ...csv('products_us.csv')].map((r) => ({
  cr854_productid: guid(`product:${r['商品コード']}`),
  cr854_productcode: r['商品コード'],
  cr854_name: r['商品名'],
  cr854_category: CATEGORY[r['カテゴリ']],
  cr854_price: Number(r['価格']),
  cr854_stock: Number(r['在庫数']),
  cr854_season: SEASON[r['季節']],
  cr854_salestrend: TREND[r['売上トレンド']],
  cr854_rating: Number(r['レビュー評価']),
  cr854_weather: WEATHER[r['天候適性']],
  cr854_description: r['商品説明'],
  cr854_imageurl: r['画像URL'],
  cr854_market: r['market'] === 'US' ? US_MARKET : JP_MARKET,
}))

export const heroes: Row[] = [...csv('hero_images.csv'), ...csv('hero_images_us.csv')].map((r) => ({
  cr854_heroimageid: guid(`hero:${r['画像コード']}`),
  cr854_imagecode: r['画像コード'],
  cr854_name: r['画像名'],
  cr854_purpose: PURPOSE[r['用途']],
  cr854_season: HERO_SEASON[r['季節']],
  cr854_tags: r['タグ'],
  cr854_description: r['説明'],
  cr854_imageurl: r['画像URL'],
  cr854_market: r['market'] === 'US' ? US_MARKET : JP_MARKET,
}))

const productId = (code: string) => guid(`product:${code}`)
const heroId = (code: string) => guid(`hero:${code}`)

// ---- 配信カード
const iso = (s: string) => new Date(`${s.replace(' ', 'T')}:00+09:00`).toISOString()

export const cards: Row[] = [...csv('delivery_cards.csv'), ...csv('delivery_cards_jp.csv')].map((r) => ({
  cr854_deliverycardid: guid(`card:${r['配信名']}:${r['配信日']}`),
  cr854_name: r['配信名'],
  cr854_scheduledat: iso(r['配信日']),
  cr854_country: COUNTRY[r['国']],
  cr854_channel: CHANNEL[r['チャネル']],
  cr854_department: DEPARTMENT[r['部署']],
  cr854_status: STATUS[r['ステータス']],
  cr854_theme: r['テーマ'],
  cr854_copy: r['コピー'],
  cr854_instructions: r['制作指示'],
}))

export const deliveryProducts: Row[] = []

type Pick = { code: string; reason: string }
/** 中身を入れた、見せ用の配信カード(テンプレートの選択、メイン画像、商品の選定まで) */
function fill(
  name: string,
  fields: Row,
  items: { section: number; picks: Pick[]; candidates?: Pick[] },
  hero: { code: string; reason: string },
) {
  const card = cards.find((c) => c.cr854_name === name)
  if (!card) return
  const id = card.cr854_deliverycardid as string
  Object.assign(card, fields, { _cr854_heroimage_value: heroId(hero.code), cr854_heroreason: hero.reason })
  let order = 0
  const add = (p: Pick, state: number, section: number) => {
    deliveryProducts.push({
      cr854_deliveryproductid: guid(`dp:${id}:${p.code}:${state}`),
      cr854_name: p.code,
      _cr854_deliverycard_value: id,
      _cr854_product_value: productId(p.code),
      cr854_sortorder: order++,
      cr854_reason: p.reason,
      cr854_source: 588230000,
      cr854_state: state,
      cr854_section: section,
    })
  }
  void items
  return { add }
}

// US: Fall Arrivals(カテゴリ見出し 2 セクション)
{
  const f = fill(
    'Fall Arrivals',
    {
      cr854_theme: 'Layered Comfort for Crisp Days',
      cr854_themereason: 'Early October brings cooler mornings and evenings; light jackets and knits are well stocked and trending up.',
      cr854_headline: 'Embrace the Autumn Layers',
      cr854_copy: 'Discover cozy blends and structured essentials that redefine effortless warmth.',
      cr854_copyangle: 'Seasonal feel',
      cr854_instructions:
        'Lead with a full-width autumn outfit visual in warm brown and terracotta tones. Present outerwear first (Light Jacket, Trench Coat), then knits (Crewneck, Cable Knit) in a clean two-by-two rhythm. Keep generous white space and a calm, premium mood; make the call-to-action buttons quiet and dark.',
      cr854_instructionsangle: 'Classic layout',
      cr854_layoutkey: 'cat2',
      cr854_emailtemplate: 588230004,
      cr854_sectiontitles: 'Outerwear for Crisp Days\nKnits That Layer Well',
      cr854_sectioncopies: JSON.stringify(['Light layers that move with the weather.', 'Soft textures for cooler mornings.']),
    },
    { section: 0, picks: [] },
    { code: 'UH01', reason: 'Matches the fall outerwear and knits story; warm tones suit the early-October timing.' },
  )
  const sel = 588230000
  const cand = 588230001
  f?.add({ code: 'U05', reason: 'Stock 150 and a light, breathable layer for shifting temperatures.' }, sel, 0)
  f?.add({ code: 'U03', reason: 'Rising interest in rain-ready outerwear; stock 200.' }, sel, 0)
  f?.add({ code: 'U07', reason: 'Top-rated crewneck (4.7) with strong stock and rising sales.' }, sel, 1)
  f?.add({ code: 'U09', reason: 'Textured cable knit that pairs with the outerwear above.' }, sel, 1)
  f?.add({ code: 'U01', reason: 'Premium alternative with strong rating; stock 120.' }, cand, 0)
  f?.add({ code: 'U04', reason: 'Packable parka for rainy days.' }, cand, 0)
  f?.add({ code: 'U06', reason: 'Soft cardigan that layers over anything.' }, cand, 1)
}

// JP: 秋の新作ニット(標準 4 点)
{
  const f = fill(
    '秋の新作ニット',
    {
      cr854_theme: 'ニットで重ねる、秋の新作',
      cr854_themereason: '10月初旬で肌寒くなる時期。売上上昇中のニット類が主役になる、季節感重視のテーマ。',
      cr854_headline: 'ぬくもりを纏う、秋のニット',
      cr854_copy: '重ねるほどに表情が変わる、やさしい手ざわりの新作ニットが届きました。',
      cr854_copyangle: '商品の魅力',
      cr854_instructions:
        'メインビジュアルはニットの質感が伝わる近接のカットを全幅で配置し、温かみのあるベージュ〜ブラウン系で統一する。商品は上から順に、クルーネック、ケーブル、カーディガン、タートルの4点を2×2のグリッドで表示。余白を多めに取り、ボタンは落ち着いた濃色にして、素材の魅力を前面に出す。',
      cr854_instructionsangle: '商品を主役に',
      cr854_layoutkey: 'standard4',
      cr854_emailtemplate: 588230001,
      cr854_sectioncopies: JSON.stringify(['やわらかな素材で、秋の始まりを心地よく。']),
    },
    { section: 0, picks: [] },
    { code: 'H05', reason: 'ニットの編み目と質感を近接で見せる画像。テーマと商品の世界観に合う。' },
  )
  const sel = 588230000
  const cand = 588230001
  f?.add({ code: 'P07', reason: '在庫220、売上上昇中。評価も高い定番のクルーネック。' }, sel, 0)
  f?.add({ code: 'P09', reason: '編み柄で表情が出る、秋らしい一枚。' }, sel, 0)
  f?.add({ code: 'P06', reason: '重ね着の羽織りとして、ニットと相性がよい。' }, sel, 0)
  f?.add({ code: 'P08', reason: '首元まで暖かく、秋冬のはじめに需要が伸びる。' }, sel, 0)
  f?.add({ code: 'P13', reason: 'ウールスラックスで、きれいめのコーディネートに。' }, cand, 0)
}

// ---- 週次実績・販売方針
export const weekly: Row[] = csv('product_weekly.csv').map((r) => ({
  cr854_weeklyperformanceid: guid(`weekly:${r.name}`),
  cr854_name: r.name,
  cr854_productcode: r.productcode,
  cr854_weekstart: r.weekstart,
  cr854_units: Number(r.units),
  cr854_revenue: Number(r.revenue),
  cr854_stock: Number(r.stock),
}))

export const policies: Row[] = csv('product_policy.csv').map((r) => ({
  cr854_productpolicyid: guid(`policy:${r.productcode}`),
  cr854_name: r.name,
  cr854_productcode: r.productcode,
  cr854_policy: r.policy,
  cr854_promoplan: r.promoplan,
  cr854_promoperiod: r.promoperiod,
  cr854_stage: r.stage,
}))

// ---- ユーザーが作ったテンプレート(1 件)
export const layoutTemplates: Row[] = [
  {
    cr854_layouttemplateid: guid('layout:feature-grid3'),
    cr854_name: 'Feature + 3-column grid',
    cr854_description: 'One featured product, then a three-across row. Good for a focused story with a quick shop-the-look.',
    cr854_herokind: 'collab',
    cr854_sections: JSON.stringify([
      { kind: 'feature', slots: 1 },
      { kind: 'grid', slots: 3, columns: 3 },
    ]),
  },
]
