import { useCallback, useState } from 'react'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { FREE_DEFAULT_SLOTS, sectionRange, sectionsOf, type EmailTemplateId } from './templates'
import {
  proposeHero,
  proposeSection,
  proposeSectionCopies,
  proposeSectionProducts,
  proposeSectionTitles,
  type AiCard,
  type CopyCandidate,
  type CopyLanguage,
  type HeroProposal,
  type ProductSelection,
  type SectionProposal,
  type TitleCandidate,
} from './aiSelect'
import {
  suggestCopies,
  suggestInstructions,
  suggestThemes,
  type CopyIdea,
  type InstructionIdea,
  type ThemeSuggestion,
} from './aiDraft'
import type { Candidate, Item } from './items'

export interface DraftInputs {
  buildCard: () => AiCard
  products: Cr854_products[]
  heroes: Cr854_heroimages[]
  otherThemes: string[]
  template: EmailTemplateId
  /** 選定済みの商品(並び順) */
  items: Item[]
  candidates: Candidate[]
  sectionTitles: string[]
  sectionCopies: string[]
  heroId?: string
  heroReason?: string
  /** コピー・ヘッドラインの言語 */
  language: CopyLanguage
}

/** 実行中の対象: theme / copy / instructions / hero / section:番号[:title|copy|products] */
export type DraftKey = string

/** AI の結果の状態と生成処理。テーマ・コピー・制作指示は「案」(採用するまで反映しない)。
 *  メイン画像とセクションは、AI の選定を呼び出し側がそのまま設定する(候補は画面上の一時的なもの) */
export function useAiDrafts(inputs: DraftInputs, onError: (message: string | null) => void) {
  const [themeIdeas, setThemeIdeas] = useState<ThemeSuggestion[]>([])
  const [copyIdeas, setCopyIdeas] = useState<CopyIdea[]>([])
  const [instructionIdeas, setInstructionIdeas] = useState<InstructionIdea[]>([])
  // セクションの見出し・コピーの候補(AI が作ったときの分。保存はしない)
  const [titleCandidates, setTitleCandidates] = useState<Record<number, TitleCandidate[]>>({})
  const [sectionCopyCandidates, setSectionCopyCandidates] = useState<Record<number, CopyCandidate[]>>({})
  const [busy, setBusy] = useState<Record<DraftKey, boolean>>({})

  const withBusy = useCallback(
    async <T,>(key: DraftKey, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy((b) => ({ ...b, [key]: true }))
      onError(null)
      try {
        return await fn()
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e))
        return undefined
      } finally {
        setBusy((b) => ({ ...b, [key]: false }))
      }
    },
    [onError],
  )

  const productName = (id: string) => inputs.products.find((p) => p.cr854_productid === id)?.cr854_name ?? ''

  const context = () => ({
    card: inputs.buildCard(),
    language: inputs.language,
    items: inputs.items.map((i) => ({ product: inputs.products.find((p) => p.cr854_productid === i.productId), reason: i.reason })),
    hero: inputs.heroes.find((h) => h.cr854_heroimageid === inputs.heroId),
  })

  const runTheme = () =>
    withBusy('theme', async () => {
      const card = inputs.buildCard()
      if (!card.scheduledAt) throw new Error('テーマ案を出すには、先に配信日時を入力してください')
      setThemeIdeas(await suggestThemes({ card, otherThemes: inputs.otherThemes, products: inputs.products }))
    })

  const runCopy = () =>
    withBusy('copy', async () => {
      const ctx = context()
      if (!ctx.card.theme.trim()) throw new Error('コピー案を出すには、先にテーマを決めてください')
      setCopyIdeas(await suggestCopies(ctx))
    })

  const runInstructions = () =>
    withBusy('instructions', async () => {
      const ctx = context()
      if (!ctx.card.theme.trim()) throw new Error('制作指示の案を出すには、先にテーマを決めてください')
      setInstructionIdeas(await suggestInstructions(ctx))
    })

  /** メイン画像を選ばせる(結果を返す。設定は呼び出し側が行う) */
  const runHero = () =>
    withBusy<HeroProposal>('hero', async () => {
      const card = inputs.buildCard()
      if (!card.theme.trim()) throw new Error('メイン画像を選ぶには、先にテーマを決めてください')
      return proposeHero({ card, heroes: inputs.heroes, productNames: inputs.items.map((i) => productName(i.productId)).filter(Boolean) })
    })

  /** セクション 1 つ分の AI への入力(他のセクションの状況と、このセクションの現在の内容) */
  const sectionArgs = (index: number) => {
    const card = inputs.buildCard()
    if (!card.theme.trim()) throw new Error('先にテーマを決めてください')
    const sections = sectionsOf(inputs.template)
    const sec = sections[index]

    const excluded = new Set<string>()
    const others = sections
      .filter((s) => s.index !== index)
      .map((s) => {
        const [a, b] = sectionRange(sections, s, inputs.items.length)
        const list = inputs.items.slice(a, b)
        list.forEach((i) => excluded.add(i.productId))
        return {
          index: s.index,
          title: inputs.sectionTitles[s.index] ?? '',
          copy: inputs.sectionCopies[s.index] ?? '',
          productNames: list.map((i) => productName(i.productId)).filter(Boolean),
        }
      })
    // 他のセクションの候補も、重複を避けるため除く(このセクション自身の商品と候補は、選び直しの対象に含める)
    inputs.candidates.filter((c) => c.section !== index).forEach((c) => excluded.add(c.productId))

    const [from, to] = sectionRange(sections, sec, inputs.items.length)
    const mine = inputs.items.slice(from, to).map((i) => productName(i.productId)).filter(Boolean)
    return {
      card,
      section: { slots: Number.isFinite(sec.slots) ? sec.slots : FREE_DEFAULT_SLOTS, wantTitle: sec.wantTitle, kind: sec.kind },
      others,
      current: {
        title: inputs.sectionTitles[index] || undefined,
        copy: inputs.sectionCopies[index] || undefined,
        productNames: mine.length ? mine : undefined,
      },
      excludedProductIds: excluded,
      products: inputs.products,
      hero: inputs.heroes.find((h) => h.cr854_heroimageid === inputs.heroId),
      heroReason: inputs.heroReason,
      language: inputs.language,
    }
  }

  /** セクション 1 つを一括で(見出し・コピーの候補と、商品の選定 + 候補)。結果は呼び出し側が設定する */
  const runSection = (index: number) =>
    withBusy<SectionProposal>(`section:${index}`, async () => {
      const proposal = await proposeSection(sectionArgs(index))
      setTitleCandidates((prev) => ({ ...prev, [index]: proposal.titles }))
      setSectionCopyCandidates((prev) => ({ ...prev, [index]: proposal.copies }))
      return proposal
    })

  /** 見出しだけ作り直す */
  const runSectionTitles = (index: number) =>
    withBusy<TitleCandidate[]>(`section:${index}:title`, async () => {
      const titles = await proposeSectionTitles(sectionArgs(index))
      setTitleCandidates((prev) => ({ ...prev, [index]: titles }))
      return titles
    })

  /** コピーだけ作り直す(現在の見出しと、選ばれた商品を踏まえる) */
  const runSectionCopies = (index: number) =>
    withBusy<CopyCandidate[]>(`section:${index}:copy`, async () => {
      const copies = await proposeSectionCopies(sectionArgs(index))
      setSectionCopyCandidates((prev) => ({ ...prev, [index]: copies }))
      return copies
    })

  /** 商品だけ選び直す(現在の見出しとコピーを踏まえる) */
  const runSectionProducts = (index: number) =>
    withBusy<ProductSelection>(`section:${index}:products`, async () => proposeSectionProducts(sectionArgs(index)))

  /** テンプレートを変えたときなど、見出し・コピーの候補を破棄する */
  const discardProposals = useCallback(() => {
    setTitleCandidates({})
    setSectionCopyCandidates({})
  }, [])

  return {
    themeIdeas,
    copyIdeas,
    instructionIdeas,
    titleCandidates,
    sectionCopyCandidates,
    busy,
    runTheme,
    runCopy,
    runInstructions,
    runHero,
    runSection,
    runSectionTitles,
    runSectionCopies,
    runSectionProducts,
    discardProposals,
  }
}

export type AiDrafts = ReturnType<typeof useAiDrafts>
