import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'

// ビルドに同梱するイラスト(商品コード・画像コードと同じファイル名。scripts の生成物)
const productAssets = import.meta.glob('./assets/products/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const heroAssets = import.meta.glob('./assets/heroes/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

// Dataverse の画像URLが空、または仮の画像(placehold.co)のときだけ、同梱のイラストを使う。
// 実際の画像URLを入れれば、そちらが優先される。
const isPlaceholder = (url?: string) => !url || url.includes('placehold.co')

export function productImage(p?: Cr854_products): string | undefined {
  if (!p) return undefined
  if (!isPlaceholder(p.cr854_imageurl)) return p.cr854_imageurl
  return productAssets[`./assets/products/${p.cr854_productcode}.svg`] ?? p.cr854_imageurl
}

export function heroImage(h?: Cr854_heroimages): string | undefined {
  if (!h) return undefined
  if (!isPlaceholder(h.cr854_imageurl)) return h.cr854_imageurl
  return heroAssets[`./assets/heroes/${h.cr854_imagecode}.svg`] ?? h.cr854_imageurl
}
