// メールのテンプレート。ヒーロー(上部)の種類と、商品を並べる枠(セクション)で定義する。
// 掲載商品は並び順に、上のセクションの枠から順に流し込む。
//
// テンプレートは、「標準」(コードに持つ。常に使える。編集不可)と、「ユーザーが作ったもの」(Dataverse に保存)の登録型。
// ユーザーが作ったテンプレートの ID は、Dataverse の行の ID。配信カードは、この ID(layoutkey)で、テンプレートを指す。

import { useSyncExternalStore } from 'react'
import { tr } from './i18n'

/** 標準のテンプレートは 'free' | 'standard4' | 'collab' | 'offer' | 'cat2' | 'cat3'。ユーザーが作ったものは、行の ID */
export type EmailTemplateId = string

export type HeroKind = 'standard' | 'collab' | 'offer'

/** ヘッドラインの見せ方。band: 写真の下部に帯で重ねる / overlay: 写真の中央に大きく重ねる / below: 写真の下に置く */
export type HeroText = 'band' | 'overlay' | 'below'

/**
 * セクション(商品を並べる部品)の種類。
 * grid: 名前・価格つきのグリッド / photos: 写真だけのタイル / wide: 全幅で大きく 1 点ずつ /
 * mosaic: 大きい 1 点 + 小さい 2 点(3 点で 1 組) / story: 写真と文を左右交互に / feature: 写真の横に説明を置く特集枠
 */
export type SectionKind = 'grid' | 'photos' | 'wide' | 'mosaic' | 'story' | 'feature'
export const SECTION_KINDS: SectionKind[] = ['grid', 'photos', 'wide', 'mosaic', 'story', 'feature']

export interface Section {
  kind: SectionKind
  slots: number
  /** grid・photos の列の数(省略は 2) */
  columns?: 2 | 3
  /** mosaic: 大きい枠を右に置く */
  flip?: boolean
  /** true のとき、セクションに見出しを付ける(AI が文言を作る。名前は、以前のデータとの互換のため) */
  categoryHeading?: boolean
  /** セクションの後に置くボタンの数(省略は 0) */
  buttons?: 1 | 2
}

/** グリッド・写真タイルの列の数(以前のテンプレートや、列を持たない種類は 2 として扱う) */
export const gridColumns = (sec: Section): 2 | 3 => ((sec.kind === 'grid' || sec.kind === 'photos') && sec.columns === 3 ? 3 : 2)

/** 枠の数の刻み。モザイクは 3 点で 1 組なので、3 の倍数にする */
export const slotStep = (kind: SectionKind): number => (kind === 'mosaic' ? 3 : 1)

/** セクションの種類の表示名(テンプレートの管理画面、構成の説明に使う) */
export function sectionKindLabel(sec: Section): string {
  switch (sec.kind) {
    case 'photos':
      return tr(`写真だけ(${gridColumns(sec)}列)`, `Photos only (${gridColumns(sec)} col)`)
    case 'wide':
      return tr('大きく(全幅)', 'Large (full width)')
    case 'mosaic':
      return sec.flip ? tr('モザイク(右が大)', 'Mosaic (large right)') : tr('モザイク(左が大)', 'Mosaic (large left)')
    case 'story':
      return tr('ストーリー(写真 + 文)', 'Story (photo + text)')
    case 'feature':
      return tr('特集', 'Feature')
    default:
      return tr(`グリッド(${gridColumns(sec)}列)`, `Grid (${gridColumns(sec)} col)`)
  }
}

export interface EmailTemplate {
  label: string
  description: string
  hero: HeroKind
  /** ヘッドラインの見せ方(省略は band。以前のテンプレートと同じ見た目) */
  heroText?: HeroText
  /** ヒーローの下に置くボタンの数(省略は 0) */
  heroButtons?: 0 | 1 | 2
  /** メールの最上部に、お知らせの帯を置く */
  topBar?: boolean
  sections: Section[]
  /** 標準のテンプレート(編集・削除できない) */
  builtin: boolean
}

/** 構成の見た目に関わる部分(見取り図、プレビュー、編集中の内容で共通に使う) */
export type TemplateLayout = Pick<EmailTemplate, 'hero' | 'heroText' | 'heroButtons' | 'topBar' | 'sections'>

// ---- 標準のテンプレート ----

const BUILTIN: Record<string, EmailTemplate> = {
  free: {
    get label() {
      return tr('自由(カテゴリ見出しを自動)', 'Free (auto category headings)')
    },
    get description() {
      return tr('カテゴリ見出しを自動で付ける、自由な並び。商品の数に決まりはありません。', 'A free-form layout with category headings added automatically. No fixed number of products.')
    },
    hero: 'standard',
    sections: [],
    builtin: true,
  },
  standard4: {
    label: 'Standard Hero + 4 Grid Items',
    get description() {
      return tr('メイン画像 + 2×2 の商品グリッド(4 点)。基本の構成です。', 'Main image + a 2x2 product grid (4 items). The basic layout.')
    },
    hero: 'standard',
    heroText: 'below',
    heroButtons: 1,
    sections: [{ kind: 'grid', slots: 4, buttons: 1 }],
    builtin: true,
  },
  collab: {
    label: 'Collaboration Hero + 2 Features + 2 Grid',
    get description() {
      return tr('コラボ用のヒーロー + 特集の商品 2 点 + グリッド 2 点(計 4 点)。', 'Collab hero + 2 featured products + 2 grid items (4 in total).')
    },
    hero: 'collab',
    heroButtons: 1,
    sections: [
      { kind: 'feature', slots: 2 },
      { kind: 'grid', slots: 2, buttons: 1 },
    ],
    builtin: true,
  },
  offer: {
    label: 'Price: Limited Offer & Value Hero',
    get description() {
      return tr('期間限定・お得感を打ち出す赤基調のヒーロー + 価格を強調した 4 点。', 'A red-toned hero for limited-time deals + 4 items with emphasized prices.')
    },
    hero: 'offer',
    heroText: 'overlay',
    heroButtons: 2,
    topBar: true,
    sections: [{ kind: 'grid', slots: 4, buttons: 2 }],
    builtin: true,
  },
  cat2: {
    label: 'Standard Hero + 2 Category (2 items each)',
    get description() {
      return tr('メイン画像 + カテゴリ 2 つ(各 2 点、計 4 点)。カテゴリごとに見出しが付きます。', 'Main image + 2 categories (2 items each, 4 in total). Each category gets a heading.')
    },
    hero: 'standard',
    heroText: 'below',
    heroButtons: 2,
    sections: [
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true, buttons: 2 },
    ],
    builtin: true,
  },
  cat3: {
    label: 'Standard Hero + 3 Category (2 items each)',
    get description() {
      return tr('メイン画像 + カテゴリ 3 つ(各 2 点、計 6 点)。カテゴリごとに見出しが付きます。', 'Main image + 3 categories (2 items each, 6 in total). Each category gets a heading.')
    },
    hero: 'standard',
    heroText: 'below',
    heroButtons: 2,
    sections: [
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true, buttons: 2 },
    ],
    builtin: true,
  },
  // ---- 新しい部品を使う標準(以前の選択肢の列に値がないので、配信カードは layoutkey だけで指す)
  sale: {
    get label() {
      return tr('セール(大きく 1 点 + グリッド)', 'Sale (large single + grid)')
    },
    get description() {
      return tr(
        'お知らせ帯と、文字を大きく重ねたヒーロー。目玉の商品を大きく見せ、2 列のグリッドと交互に並べ、最後に写真だけのタイルで「ほかにも」を見せます(計 12 点)。',
        'A top bar and a hero with large overlaid text. Large picks alternate with 2-column grids, ending with a photo tile "more to love" block (12 items).',
      )
    },
    hero: 'offer',
    heroText: 'overlay',
    heroButtons: 2,
    topBar: true,
    sections: [
      { kind: 'wide', slots: 1 },
      { kind: 'grid', slots: 2 },
      { kind: 'wide', slots: 1 },
      { kind: 'grid', slots: 2 },
      { kind: 'photos', slots: 6, columns: 3, categoryHeading: true, buttons: 2 },
    ],
    builtin: true,
  },
  spotlight: {
    get label() {
      return tr('特集(モザイク + グリッド)', 'Spotlight (mosaic + grid)')
    },
    get description() {
      return tr(
        'ヒーローの下に見出し・コピー・ボタン。大きい 1 点と小さい 2 点のモザイクで主役を見せ、見出し付きのグリッドで組み合わせを提案します(計 7 点)。',
        'Headline, copy, and a button below the hero. A mosaic of one large and two small items leads, then a headed grid suggests pairings (7 items).',
      )
    },
    hero: 'standard',
    heroText: 'below',
    heroButtons: 1,
    sections: [
      { kind: 'mosaic', slots: 3 },
      { kind: 'grid', slots: 4, categoryHeading: true, buttons: 2 },
    ],
    builtin: true,
  },
  story: {
    get label() {
      return tr('ストーリー(写真 + 文)', 'Story (photo + text)')
    },
    get description() {
      return tr(
        '写真と商品の説明を左右交互に並べ、1 点ずつ丁寧に見せます。最後に見出し付きのグリッド(計 7 点)。',
        'Photos and product descriptions alternate left and right to tell each item\'s story, then a headed grid (7 items).',
      )
    },
    hero: 'standard',
    heroText: 'overlay',
    heroButtons: 2,
    sections: [
      { kind: 'story', slots: 3 },
      { kind: 'grid', slots: 4, categoryHeading: true, buttons: 2 },
    ],
    builtin: true,
  },
  editorial: {
    get label() {
      return tr('コレクション(大きな写真中心)', 'Collection (photo-led)')
    },
    get description() {
      return tr(
        '大きな写真とモザイクで世界観を見せ、3 列のグリッドで商品をまとめて紹介します(計 11 点)。新作やコレクションの紹介に。',
        'Large photos and a mosaic set the mood, then a 3-column grid shows the lineup (11 items). For new arrivals and collections.',
      )
    },
    hero: 'standard',
    heroText: 'below',
    heroButtons: 1,
    sections: [
      { kind: 'wide', slots: 1 },
      { kind: 'mosaic', slots: 3, flip: true },
      { kind: 'grid', slots: 6, columns: 3 },
      { kind: 'wide', slots: 1, buttons: 1 },
    ],
    builtin: true,
  },
}

const BUILTIN_IDS = Object.keys(BUILTIN)
export const DEFAULT_TEMPLATE: EmailTemplateId = 'standard4'

// ---- 登録(標準 + ユーザーが作ったもの) ----

let custom: Record<string, EmailTemplate> = {}
let version = 0
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Dataverse から読み込んだ、ユーザーが作ったテンプレートに入れ替える */
export function setCustomTemplates(list: ({ id: string } & Omit<EmailTemplate, 'builtin'>)[]) {
  custom = Object.fromEntries(list.map(({ id, ...rest }) => [id, { ...rest, builtin: false }]))
  version += 1
  listeners.forEach((fn) => fn())
}

/** テンプレートの登録が変わったら、再描画する(読み込み・保存・削除のあと) */
export function useTemplates(): number {
  return useSyncExternalStore(subscribe, () => version)
}

/** テンプレートを求める。登録にない ID(削除された、まだ読み込まれていない)は、Standard4 にする */
export const getTemplate = (id: EmailTemplateId): EmailTemplate => custom[id] ?? BUILTIN[id] ?? BUILTIN[DEFAULT_TEMPLATE]

/** 登録にあるテンプレートか */
export const hasTemplate = (id: string): boolean => id in custom || id in BUILTIN

/** 選べるテンプレートの一覧(標準 → ユーザーが作ったもの) */
export function templateOptions(): ({ id: EmailTemplateId; label: string; description: string; builtin: boolean } & TemplateLayout)[] {
  return [...BUILTIN_IDS, ...Object.keys(custom)].map((id) => {
    const tpl = getTemplate(id)
    return {
      id,
      label: tpl.label,
      description: tpl.description,
      builtin: tpl.builtin,
      hero: tpl.hero,
      heroText: tpl.heroText,
      heroButtons: tpl.heroButtons,
      topBar: tpl.topBar,
      sections: tpl.sections,
    }
  })
}

// ---- 管理の画面を開く(ヘッダーのボタンや、テンプレートのタブから) ----

let managerOpen = false
const managerListeners = new Set<() => void>()
const subscribeManager = (fn: () => void) => {
  managerListeners.add(fn)
  return () => managerListeners.delete(fn)
}
export function setTemplateManagerOpen(open: boolean) {
  managerOpen = open
  managerListeners.forEach((fn) => fn())
}
export const openTemplateManager = () => setTemplateManagerOpen(true)
export function useTemplateManagerOpen(): boolean {
  return useSyncExternalStore(subscribeManager, () => managerOpen)
}

// Dataverse の選択肢(配信カードの「emailtemplate」列)の値との対応(標準のテンプレートだけ。以前のカードとの互換)
export const TEMPLATE_VALUES: Record<string, 588230000 | 588230001 | 588230002 | 588230003 | 588230004 | 588230005> = {
  free: 588230000,
  standard4: 588230001,
  collab: 588230002,
  offer: 588230003,
  cat2: 588230004,
  cat3: 588230005,
}

/** 保存されている選択肢の値から、標準のテンプレートを求める(未設定や不明な値は Standard4) */
export const templateFromValue = (v?: number): EmailTemplateId => BUILTIN_IDS.find((id) => TEMPLATE_VALUES[id] === v) ?? DEFAULT_TEMPLATE

/** テンプレートの商品枠の合計(free は決まっていないので 0) */
export const slotsOf = (id: EmailTemplateId) => getTemplate(id).sections.reduce((n, s) => n + s.slots, 0)

// ---- セクション(商品の枠)の計算

/** free のとき、AI に選ばせる商品数の既定 */
export const FREE_DEFAULT_SLOTS = 4

export interface SectionInfo {
  index: number
  /** 選定済みの商品の並び(items)の中での、先頭の位置 */
  start: number
  /** 枠の数。free は上限なし(Infinity) */
  slots: number
  kind: SectionKind
  /** カテゴリ系: AI が見出しを付ける */
  wantTitle: boolean
  label: string
}

/** テンプレートのセクション一覧。free は、全体で 1 つのセクションとして扱う */
export function sectionsOf(id: EmailTemplateId): SectionInfo[] {
  const tpl = getTemplate(id)
  if (id === 'free') {
    return [{ index: 0, start: 0, slots: Infinity, kind: 'grid', wantTitle: false, label: tr('全体', 'All') }]
  }
  // 同じ種類が複数あるときは、番号を付けて区別する(タブの名前になる)
  const countOf = (kind: SectionKind, upto = tpl.sections.length) => tpl.sections.slice(0, upto).filter((s) => s.kind === kind).length
  const kindName: Record<SectionKind, () => string> = {
    grid: () => tr('グリッド', 'Grid'),
    photos: () => tr('写真', 'Photos'),
    wide: () => tr('大きく', 'Large'),
    mosaic: () => tr('モザイク', 'Mosaic'),
    story: () => tr('ストーリー', 'Story'),
    feature: () => tr('特集', 'Feature'),
  }
  return tpl.sections.map((sec, i) => {
    const start = tpl.sections.slice(0, i).reduce((n, s) => n + s.slots, 0)
    const name = kindName[sec.kind]()
    const label = sec.categoryHeading
      ? tr(`セクション${i + 1}`, `Section ${i + 1}`)
      : countOf(sec.kind) > 1
        ? `${name}${countOf(sec.kind, i + 1)}`
        : name
    return { index: i, start, slots: sec.slots, kind: sec.kind, wantTitle: !!sec.categoryHeading, label }
  })
}

/** 選定済みの並びの位置 idx が、どのセクションに属するか(枠を超えた分は最後のセクション) */
export function sectionIndexAt(sections: SectionInfo[], idx: number): number {
  const found = sections.find((s) => idx >= s.start && idx < s.start + s.slots)
  return found ? found.index : sections.length - 1
}

/** セクションが担当する選定済み商品の範囲 [開始, 終了)。最後のセクションは、枠を超えた分も含める */
export function sectionRange(sections: SectionInfo[], sec: SectionInfo, total: number): [number, number] {
  const last = sec.index === sections.length - 1
  const end = last || !Number.isFinite(sec.slots) ? total : sec.start + sec.slots
  return [sec.start, end]
}
