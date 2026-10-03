import type { Item } from './items'
import { tr } from './i18n'
import { sectionRange, sectionsOf, type EmailTemplateId } from './templates'

const labelsNow = (): string[] => [
  tr('① テーマ', '1. Theme'),
  tr('② テンプレート', '2. Template'),
  tr('③ ヒーロー', '3. Hero'),
  tr('④ セクション', '4. Sections'),
  tr('⑤ 制作指示', '5. Production notes'),
]

/** 工程の名前。読むたびに現在の言語で返す(インデックスのゲッター) */
export const PROGRESS_LABELS: readonly string[] = (() => {
  const a: string[] = []
  for (let i = 0; i < 5; i++) Object.defineProperty(a, i, { get: () => labelsNow()[i], enumerable: true })
  return a
})()

export interface Progress {
  theme: boolean
  template: boolean
  hero: boolean
  sections: boolean
  instructions: boolean
  done: number
  total: number
  /** 未完了の工程の名前 */
  remaining: string[]
}

/** 工程の進み具合。中ペインの ✓ と、ダイアログ右上の「工程 n / 5」で、同じ基準を使う */
export function progressOf(a: {
  theme: string
  template: EmailTemplateId
  heroId?: string
  headline: string
  items: Item[]
  instructions: string
}): Progress {
  const sections = sectionsOf(a.template)
  const sectionsDone =
    a.template === 'free'
      ? a.items.length > 0
      : sections.every((sec) => {
          const [from, to] = sectionRange(sections, sec, a.items.length)
          return Math.max(0, to - from) >= sec.slots
        })

  const flags = [
    !!a.theme.trim(),
    true, // テンプレートは、常にどれかが選ばれている
    !!a.heroId && !!a.headline.trim(), // メイン画像とヘッドラインがそろったら完了
    sectionsDone, // すべてのセクションの枠が埋まったら完了(自由は、1 件以上)
    !!a.instructions.trim(),
  ]
  const [theme, template, hero, sectionsOk, instructions] = flags
  return {
    theme,
    template,
    hero,
    sections: sectionsOk,
    instructions,
    done: flags.filter(Boolean).length,
    total: flags.length,
    remaining: labelsNow().filter((_, i) => !flags[i]),
  }
}
