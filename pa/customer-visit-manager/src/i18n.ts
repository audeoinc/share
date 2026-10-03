import { useSyncExternalStore } from 'react'

// 画面の言語(日本語 / English)。ブラウザごとに保存し、初期値はブラウザの言語。
// 文言は、その場に「日本語, English」の組で書く: tr('保存', 'Save')。React の外(AI の処理など)でも使える。
export type Lang = 'ja' | 'en'

const KEY = 'ui.lang'

function detect(): Lang {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'ja' || v === 'en') return v
  } catch {
    // 保存を読めないときは、ブラウザの言語に従う
  }
  return navigator.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

let current: Lang = detect()
const listeners = new Set<() => void>()

export const getLang = (): Lang => current

export function setLang(lang: Lang) {
  if (lang === current) return
  current = lang
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    // 保存できなくても動作には影響しない
  }
  document.documentElement.lang = lang
  listeners.forEach((fn) => fn())
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 現在の言語に合う文言を返す */
export const tr = (ja: string, en: string): string => (current === 'ja' ? ja : en)

/** 言語が切り替わったら、再描画する。コンポーネントの先頭で `const t = useT()` と書く */
export function useT(): typeof tr {
  useSyncExternalStore(subscribe, getLang)
  return tr
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang)
}

/** 日付・数値の表記に使うロケール */
export const locale = (): string => (current === 'ja' ? 'ja-JP' : 'en-US')

export type Market = 'JP' | 'US'

/** 価格の表記。US の商品はドル、JP の商品は円 */
export function priceText(v?: number, market: Market = 'JP'): string {
  if (v === undefined) return '-'
  return market === 'US'
    ? `$${v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`
    : `¥${v.toLocaleString('ja-JP')}`
}

// Dataverse の選択肢のラベル(日本語)の、英語表記。値は変えずに、表示だけを切り替える
const OPTION_EN: Record<string, string> = {
  // ステータス
  未起案: 'Not started',
  検討中: 'In review',
  承認済み: 'Approved',
  確定: 'Confirmed',
  // チャネル
  メール: 'Email',
  プッシュ: 'Push',
  // 部署
  販促: 'Promotion',
  // 商品カテゴリ
  アウター: 'Outerwear',
  トップス: 'Tops',
  ボトムス: 'Bottoms',
  シューズ: 'Shoes',
  小物: 'Accessories',
  バッグ: 'Bags',
  ホーム: 'Home',
  // 売上トレンド
  上昇: 'Rising',
  横ばい: 'Flat',
  下降: 'Falling',
  // 季節
  秋: 'Fall',
  冬: 'Winter',
  秋冬: 'Fall/Winter',
  通年: 'All year',
  // 天候適性
  晴れ: 'Sunny',
  雨の日: 'Rainy',
  寒い日: 'Cold',
  // メイン画像の用途
  新作: 'New arrivals',
  特集: 'Feature',
  セール: 'Sale',
  会員: 'Members',
  イベント: 'Event',
  // 掲載商品
  手動: 'Manual',
  選定: 'Selected',
  候補: 'Candidate',
  // メールのテンプレート
  自由: 'Free',
}

/** 選択肢のラベルを、現在の言語で返す(辞書にないものは、そのまま) */
export const optionLabel = (label?: string): string => (label === undefined ? '' : current === 'ja' ? label : (OPTION_EN[label] ?? label))
