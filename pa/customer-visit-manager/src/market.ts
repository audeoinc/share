import type { Market } from './i18n'

// 商品・メイン画像の「市場」(Dataverse の選択肢)。US の値以外(JP、または未設定)は JP とみなす
const US_VALUE = 588230001

export const productMarket = (p?: { cr854_market?: number }): Market => (p?.cr854_market === US_VALUE ? 'US' : 'JP')
export const heroMarket = productMarket

/** 配信カードの「国」(選択肢の値を文字にしたもの)から、使う市場を決める。国が未設定なら null(絞り込まない) */
export function cardMarket(country: string): Market | null {
  if (country === '588230000') return 'US'
  if (country === '588230001') return 'JP'
  return null
}
