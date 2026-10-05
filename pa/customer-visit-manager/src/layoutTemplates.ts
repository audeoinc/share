import { Cr854_layouttemplatesService } from './generated/services/Cr854_layouttemplatesService'
import { SECTION_KINDS, gridColumns, setCustomTemplates, slotStep, type HeroKind, type HeroText, type Section, type SectionKind, type TemplateLayout } from './templates'
import { tr } from './i18n'

const HERO_KINDS: HeroKind[] = ['standard', 'collab', 'offer']
const HERO_TEXTS: HeroText[] = ['band', 'overlay', 'below']

/** セクションの上限(画面とデータの両方で守る) */
export const MAX_SECTIONS = 6
export const MAX_SLOTS = 8

/** 種類に合わせて、枠の数を整える(モザイクは 3 の倍数) */
export function fitSlots(kind: SectionKind, slots: number): number {
  const step = slotStep(kind)
  const max = Math.floor(MAX_SLOTS / step) * step
  return Math.min(max, Math.max(step, Math.round(slots / step) * step))
}

/** 保存する形に整える。既定の値(2 列、見出しなし、ボタンなし)は書かない(以前の JSON と同じ形を保つため) */
export function toStored(s: Section): Section {
  return {
    kind: s.kind,
    slots: fitSlots(s.kind, s.slots),
    ...(gridColumns(s) === 3 ? { columns: 3 } : {}),
    ...(s.kind === 'mosaic' && s.flip ? { flip: true } : {}),
    ...(s.categoryHeading ? { categoryHeading: true } : {}),
    ...(s.buttons === 1 || s.buttons === 2 ? { buttons: s.buttons } : {}),
  }
}

/**
 * ヒーローの見せ方は、テーブルに列がないので、セクションの JSON の先頭に { "kind": "hero", ... } として入れる。
 * slots を持たないので、以前の版のアプリは、この要素を読み飛ばす(テンプレートは、以前の見た目で使える)
 */
type HeroMeta = { kind: 'hero'; text?: HeroText; buttons?: 1 | 2; topBar?: true }

/** 保存されている JSON から、ヒーローの見せ方と、セクションの一覧を読む(壊れていても、読める分だけ) */
function parseLayout(text?: string): Pick<TemplateLayout, 'heroText' | 'heroButtons' | 'topBar' | 'sections'> {
  const empty = { sections: [] }
  if (!text) return empty
  try {
    const raw = JSON.parse(text) as unknown
    if (!Array.isArray(raw)) return empty
    const meta = raw.find((r) => (r as { kind?: string })?.kind === 'hero') as HeroMeta | undefined
    const sections = raw
      .map((r): Section | null => {
        const o = r as { kind?: string; slots?: number; columns?: number; flip?: boolean; categoryHeading?: boolean; buttons?: number }
        const slots = Math.round(Number(o.slots))
        if (!Number.isFinite(slots) || slots < 1) return null
        // 知らない種類(新しい版で増えたもの)は、グリッドとして読む
        const kind: SectionKind = SECTION_KINDS.includes(o.kind as SectionKind) ? (o.kind as SectionKind) : 'grid'
        return toStored({
          kind,
          slots,
          columns: o.columns === 3 ? 3 : undefined,
          flip: !!o.flip,
          categoryHeading: !!o.categoryHeading,
          buttons: o.buttons === 1 || o.buttons === 2 ? o.buttons : undefined,
        })
      })
      .filter((s): s is Section => s !== null)
      .slice(0, MAX_SECTIONS)
    return {
      sections,
      heroText: meta && HERO_TEXTS.includes(meta.text as HeroText) ? meta.text : undefined,
      heroButtons: meta?.buttons === 1 || meta?.buttons === 2 ? meta.buttons : undefined,
      topBar: meta?.topBar ? true : undefined,
    }
  } catch {
    return empty
  }
}

/** セクションの JSON を作る。ヒーローの見せ方が既定(帯・ボタンなし・お知らせ帯なし)のときは、以前と同じ形(配列だけ) */
function stringifyLayout(layout: Pick<TemplateLayout, 'heroText' | 'heroButtons' | 'topBar' | 'sections'>): string {
  const meta: HeroMeta = {
    kind: 'hero',
    ...(layout.heroText && layout.heroText !== 'band' ? { text: layout.heroText } : {}),
    ...(layout.heroButtons ? { buttons: layout.heroButtons } : {}),
    ...(layout.topBar ? { topBar: true as const } : {}),
  }
  const sections = layout.sections.map(toStored)
  return JSON.stringify(Object.keys(meta).length > 1 ? [meta, ...sections] : sections)
}

export interface TemplateInput extends Pick<TemplateLayout, 'heroText' | 'heroButtons' | 'topBar'> {
  id?: string
  name: string
  description: string
  hero: HeroKind
  sections: Section[]
}

/** Dataverse から、ユーザーが作ったテンプレートを読み込み、登録に反映する */
export async function loadCustomTemplates(): Promise<void> {
  const res = await Cr854_layouttemplatesService.getAll({ orderBy: ['createdon asc'] })
  if (!res.success) throw new Error(res.error?.message ?? tr('テンプレートを取得できませんでした', 'Failed to load templates'))
  setCustomTemplates(
    (res.data ?? [])
      .map((r) => ({
        id: r.cr854_layouttemplateid,
        label: r.cr854_name,
        description: r.cr854_description ?? '',
        hero: (HERO_KINDS.includes(r.cr854_herokind as HeroKind) ? r.cr854_herokind : 'standard') as HeroKind,
        ...parseLayout(r.cr854_sections),
      }))
      // セクションが 1 つもない行は、メールを組めないので、一覧に出さない
      .filter((t) => t.sections.length > 0),
  )
}

/** 新規作成(id なし)または更新。保存後に、登録を読み込み直す。保存した行の ID を返す */
export async function saveTemplate(input: TemplateInput): Promise<string> {
  const fields = {
    cr854_name: input.name.trim(),
    cr854_description: input.description.trim(),
    cr854_herokind: input.hero,
    cr854_sections: stringifyLayout(input),
  }
  const res = input.id
    ? await Cr854_layouttemplatesService.update(input.id, fields)
    : await Cr854_layouttemplatesService.create({ ...fields, statecode: 0 })
  if (!res.success) throw new Error(res.error?.message ?? tr('テンプレートを保存できませんでした', 'Failed to save the template'))
  const id = input.id ?? res.data?.cr854_layouttemplateid
  await loadCustomTemplates()
  if (!id) throw new Error(tr('保存した行の ID を取得できませんでした', 'Could not get the ID of the saved row'))
  return id
}

export async function deleteTemplate(id: string): Promise<void> {
  await Cr854_layouttemplatesService.delete(id)
  await loadCustomTemplates()
}
