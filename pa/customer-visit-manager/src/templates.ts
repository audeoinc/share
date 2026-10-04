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

export interface Section {
  /** grid: 2列の商品グリッド / feature: 1件ずつ大きく見せる特集枠 */
  kind: 'grid' | 'feature'
  slots: number
  /** true のとき、枠内の先頭の商品のカテゴリを見出しに出す */
  categoryHeading?: boolean
}

export interface EmailTemplate {
  label: string
  description: string
  hero: HeroKind
  sections: Section[]
  /** 標準のテンプレート(編集・削除できない) */
  builtin: boolean
}

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
    sections: [{ kind: 'grid', slots: 4 }],
    builtin: true,
  },
  collab: {
    label: 'Collaboration Hero + 2 Features + 2 Grid',
    get description() {
      return tr('コラボ用のヒーロー + 特集の商品 2 点 + グリッド 2 点(計 4 点)。', 'Collab hero + 2 featured products + 2 grid items (4 in total).')
    },
    hero: 'collab',
    sections: [
      { kind: 'feature', slots: 2 },
      { kind: 'grid', slots: 2 },
    ],
    builtin: true,
  },
  offer: {
    label: 'Price: Limited Offer & Value Hero',
    get description() {
      return tr('期間限定・お得感を打ち出す赤基調のヒーロー + 価格を強調した 4 点。', 'A red-toned hero for limited-time deals + 4 items with emphasized prices.')
    },
    hero: 'offer',
    sections: [{ kind: 'grid', slots: 4 }],
    builtin: true,
  },
  cat2: {
    label: 'Standard Hero + 2 Category (2 items each)',
    get description() {
      return tr('メイン画像 + カテゴリ 2 つ(各 2 点、計 4 点)。カテゴリごとに見出しが付きます。', 'Main image + 2 categories (2 items each, 4 in total). Each category gets a heading.')
    },
    hero: 'standard',
    sections: [
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true },
    ],
    builtin: true,
  },
  cat3: {
    label: 'Standard Hero + 3 Category (2 items each)',
    get description() {
      return tr('メイン画像 + カテゴリ 3 つ(各 2 点、計 6 点)。カテゴリごとに見出しが付きます。', 'Main image + 3 categories (2 items each, 6 in total). Each category gets a heading.')
    },
    hero: 'standard',
    sections: [
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true },
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
export function templateOptions(): { id: EmailTemplateId; label: string; description: string; builtin: boolean; hero: HeroKind; sections: Section[] }[] {
  return [...BUILTIN_IDS, ...Object.keys(custom)].map((id) => {
    const tpl = getTemplate(id)
    return { id, label: tpl.label, description: tpl.description, builtin: tpl.builtin, hero: tpl.hero, sections: tpl.sections }
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
  kind: 'grid' | 'feature'
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
  const gridCount = tpl.sections.filter((s) => s.kind === 'grid').length
  return tpl.sections.map((sec, i) => {
    const start = tpl.sections.slice(0, i).reduce((n, s) => n + s.slots, 0)
    const gridNo = tpl.sections.slice(0, i + 1).filter((s) => s.kind === 'grid').length
    const label = sec.categoryHeading
      ? tr(`セクション${i + 1}`, `Section ${i + 1}`)
      : sec.kind === 'feature'
        ? tr('特集', 'Feature')
        : gridCount > 1
          ? tr(`グリッド${gridNo}`, `Grid ${gridNo}`)
          : tr('グリッド', 'Grid')
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
