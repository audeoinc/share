import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import {
  proposeHero,
  proposeSection,
  type AiCard,
  type CopyLanguage,
  type HeroProposal,
  type OtherSection,
  type SectionProposal,
} from './aiSelect'
import {
  suggestCopies,
  suggestInstructions,
  suggestTemplate,
  suggestThemes,
  type CopyIdea,
  type InstructionIdea,
  type ThemeSuggestion,
} from './aiDraft'
import { FREE_DEFAULT_SLOTS, sectionsOf, type EmailTemplateId } from './templates'

/** 「すべてAIで下書き」の入力。内容(テーマなど)は空から作るので、配信の基本情報だけを渡す */
export interface AutoDraftInput {
  card: AiCard
  language: CopyLanguage
  otherThemes: string[]
  products: Cr854_products[]
  heroes: Cr854_heroimages[]
}

export interface AutoDraftResult {
  theme?: string
  themeIdeas: ThemeSuggestion[]
  template?: EmailTemplateId
  templateReason?: string
  hero?: HeroProposal
  headline?: string
  copy?: string
  copyIdeas: CopyIdea[]
  /** テンプレートのセクション順 */
  sections: SectionProposal[]
  instructions?: string
  instructionIdeas: InstructionIdea[]
  /** 途中で失敗した工程のメッセージ(成功した工程の結果は残る) */
  errors: string[]
  cancelled: boolean
}

export type AutoDraftProgress = (label: string, done: number, total: number) => void

/**
 * テーマ → テンプレートとメイン画像 → ヘッドライン・コピー → 各セクション → 制作指示 の順に、
 * AI の第 1 候補で下書きを作る。React の状態は使わず、結果をまとめて返す(反映は呼び出し側)。
 * 一部の工程が失敗しても、できたところまでの結果を返す。
 */
export async function runAutoDraft(input: AutoDraftInput, onStep: AutoDraftProgress, isCancelled: () => boolean): Promise<AutoDraftResult> {
  const result: AutoDraftResult = { themeIdeas: [], copyIdeas: [], sections: [], instructionIdeas: [], errors: [], cancelled: false }
  const { products, heroes, language } = input
  const base: AiCard = { ...input.card, theme: '', headline: '', copy: '', instructions: '' }
  let total = 7 // テンプレートが決まったら、セクションの数に合わせて数え直す
  let done = 0

  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (isCancelled()) return undefined
    onStep(label, done, total)
    try {
      return await fn()
    } catch (e) {
      result.errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    } finally {
      done += 1
    }
  }
  const finish = () => {
    result.cancelled = isCancelled()
    return result
  }

  // ① テーマ
  const themes = await step('テーマを考えています', () => suggestThemes({ card: base, otherThemes: input.otherThemes, products }))
  if (isCancelled()) return finish()
  if (themes?.length) {
    result.themeIdeas = themes
    result.theme = themes[0].theme
  }
  if (!result.theme) return finish() // テーマがないと、以降の工程は進められない
  const withTheme: AiCard = { ...base, theme: result.theme }

  // ② テンプレートとメイン画像(互いに独立なので、並行して実行する)
  const [tpl, hero] = await Promise.all([
    step('テンプレートとメイン画像を選んでいます', () => suggestTemplate({ card: withTheme })),
    (async () => {
      try {
        return await proposeHero({ card: withTheme, heroes, productNames: [] })
      } catch (e) {
        result.errors.push(`メイン画像: ${e instanceof Error ? e.message : String(e)}`)
        return undefined
      }
    })(),
  ])
  if (isCancelled()) return finish()
  result.template = tpl?.template ?? 'standard4'
  result.templateReason = tpl?.reason
  result.hero = hero
  const heroRow = hero?.hero ? heroes.find((h) => h.cr854_heroimageid === hero.hero!.heroId) : undefined
  const heroReason = hero?.hero?.reason

  const sections = sectionsOf(result.template)
  total = 4 + sections.length

  // ③ ヘッドラインとコピー(組)
  const copies = await step('ヘッドラインとコピーを考えています', () =>
    suggestCopies({ card: withTheme, language, items: [], hero: heroRow }),
  )
  if (isCancelled()) return finish()
  if (copies?.length) {
    result.copyIdeas = copies
    result.headline = copies[0].headline
    result.copy = copies[0].lead
  }
  const withCopy: AiCard = { ...withTheme, headline: result.headline ?? '', copy: result.copy ?? '' }

  // ④ 各セクション(見出し・コピー・商品)。前のセクションで使った商品は、あとのセクションで使わない
  const others: OtherSection[] = []
  const excluded = new Set<string>()
  const productName = (id: string) => products.find((p) => p.cr854_productid === id)?.cr854_name ?? ''
  for (const sec of sections) {
    const proposal = await step(`セクション ${sec.index + 1} / ${sections.length} を選んでいます`, () =>
      proposeSection({
        card: withCopy,
        section: { slots: Number.isFinite(sec.slots) ? sec.slots : FREE_DEFAULT_SLOTS, wantTitle: sec.wantTitle, kind: sec.kind },
        others: [...others],
        hero: heroRow,
        heroReason,
        language,
        excludedProductIds: new Set(excluded),
        products,
      }),
    )
    if (isCancelled()) return finish()
    // 失敗したセクションも、空のまま位置を保つ(セクション番号がずれないように)
    const filled: SectionProposal = proposal ?? { titles: [], title: '', copies: [], copy: '', selected: [], candidates: [] }
    result.sections.push(filled)
    for (const r of [...filled.selected, ...filled.candidates]) excluded.add(r.productId)
    others.push({
      index: sec.index,
      title: filled.title,
      copy: filled.copy,
      productNames: filled.selected.map((r) => productName(r.productId)).filter(Boolean),
    })
  }

  // ⑤ 制作指示(選ばれた商品とメイン画像を踏まえる)
  const instructions = await step('制作指示を考えています', () =>
    suggestInstructions({
      card: withCopy,
      language,
      items: result.sections.flatMap((s) => s.selected).map((r) => ({ product: products.find((p) => p.cr854_productid === r.productId), reason: r.reason })),
      hero: heroRow,
    }),
  )
  if (instructions?.length) {
    result.instructionIdeas = instructions
    result.instructions = instructions[0].text
  }
  onStep('完了', total, total)
  return finish()
}
