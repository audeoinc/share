import { priceText } from './i18n'
import type { Cr854_deliveryproductscr854_source as Source } from './generated/models/Cr854_deliveryproductsModel'

export const SOURCE_AI: Source = 588230000
export const SOURCE_MANUAL: Source = 588230001

/** 1カードに掲載する商品1件(配信商品テーブルの1行に対応) */
export interface Item {
  key: string
  /** 保存済みの行ID(未保存なら undefined) */
  rowId?: string
  productId: string
  reason: string
  source: Source
}

// ドラッグ&ドロップ用の MIME タイプ
export const DND_PRODUCT = 'application/x-product' // 候補 → プレビュー(値は商品ID)
export const DND_ITEM = 'application/x-item' // プレビュー内の並べ替え(値は Item.key)

// カード類(商品候補・配信カード・プレビュー)の中身の縮尺。枠の大きさは変えず、中身だけを縮める。
// zoom と width(100/縮尺 %)を組み合わせて、見た目の幅を元の枠に合わせる。
export const CARD_SCALE = 0.8
export const scaled = { zoom: CARD_SCALE, width: `${100 / CARD_SCALE}%` } as const

export const yen = (v?: number, market: 'JP' | 'US' = 'JP') => priceText(v, market)
export const DND_HERO = 'application/x-hero' // 候補 → プレビューのメインビジュアル枠(値はメイン画像ID)

/** 選定候補(配信商品テーブルの「候補」の行)。どのセクションの候補かを持つ */
export interface Candidate extends Item {
  section: number
}

// 配信商品テーブルの「state」列(選択肢)の値
export const STATE_SELECTED = 588230000
export const STATE_CANDIDATE = 588230001
export const DND_CAND = 'application/x-candidate' // 中ペインの候補の行(値は Candidate.key)
