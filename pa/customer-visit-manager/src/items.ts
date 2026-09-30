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

export const yen = (v?: number) => (v === undefined ? '-' : `¥${v.toLocaleString('ja-JP')}`)
export const DND_HERO = 'application/x-hero' // 候補 → プレビューのメインビジュアル枠(値はメイン画像ID)
