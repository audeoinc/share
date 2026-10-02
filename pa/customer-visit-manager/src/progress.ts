import type { Item } from './items'
import { sectionRange, sectionsOf, type EmailTemplateId } from './templates'

export const PROGRESS_LABELS = ['① テーマ', '② テンプレート', '③ ヒーロー', '④ セクション', '⑤ 制作指示'] as const

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
    remaining: PROGRESS_LABELS.filter((_, i) => !flags[i]),
  }
}
