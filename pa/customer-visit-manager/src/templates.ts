// メールのテンプレート。ヒーロー(上部)の種類と、商品を並べる枠(セクション)で定義する。
// 掲載商品は並び順に、上のセクションの枠から順に流し込む。

import { tr } from './i18n'

export type EmailTemplateId = 'free' | 'standard4' | 'collab' | 'offer' | 'cat2' | 'cat3'

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
  hero: HeroKind
  sections: Section[]
}

export const EMAIL_TEMPLATES: Record<EmailTemplateId, EmailTemplate> = {
  free: {
    get label() {
      return tr('自由(カテゴリ見出しを自動)', 'Free (auto category headings)')
    },
    hero: 'standard',
    sections: [],
  },
  standard4: { label: 'Standard Hero + 4 Grid Items', hero: 'standard', sections: [{ kind: 'grid', slots: 4 }] },
  collab: {
    label: 'Collaboration Hero + 2 Features + 2 Grid',
    hero: 'collab',
    sections: [
      { kind: 'feature', slots: 2 },
      { kind: 'grid', slots: 2 },
    ],
  },
  offer: { label: 'Price: Limited Offer & Value Hero', hero: 'offer', sections: [{ kind: 'grid', slots: 4 }] },
  cat2: {
    label: 'Standard Hero + 2 Category (2 items each)',
    hero: 'standard',
    sections: [
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true },
    ],
  },
  cat3: {
    label: 'Standard Hero + 3 Category (2 items each)',
    hero: 'standard',
    sections: [
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true },
      { kind: 'grid', slots: 2, categoryHeading: true },
    ],
  },
}

export const TEMPLATE_OPTIONS = (Object.keys(EMAIL_TEMPLATES) as EmailTemplateId[]).map((id) => ({
  id,
  get label() {
    return EMAIL_TEMPLATES[id].label
  },
}))

// Dataverse の選択肢(配信カードの「emailtemplate」列)の値との対応
export const TEMPLATE_VALUES: Record<EmailTemplateId, 588230000 | 588230001 | 588230002 | 588230003 | 588230004 | 588230005> = {
  free: 588230000,
  standard4: 588230001,
  collab: 588230002,
  offer: 588230003,
  cat2: 588230004,
  cat3: 588230005,
}

/** 保存されている選択肢の値からテンプレートを求める(未設定や不明な値は Standard4) */
export const templateFromValue = (v?: number): EmailTemplateId =>
  (Object.keys(TEMPLATE_VALUES) as EmailTemplateId[]).find((id) => TEMPLATE_VALUES[id] === v) ?? 'standard4'

/** テンプレートの商品枠の合計(free は決まっていないので 0) */
export const slotsOf = (id: EmailTemplateId) => EMAIL_TEMPLATES[id].sections.reduce((n, s) => n + s.slots, 0)

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
  const tpl = EMAIL_TEMPLATES[id]
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
