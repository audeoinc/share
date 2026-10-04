import { Cr854_layouttemplatesService } from './generated/services/Cr854_layouttemplatesService'
import { setCustomTemplates, type HeroKind, type Section } from './templates'
import { tr } from './i18n'

const HERO_KINDS: HeroKind[] = ['standard', 'collab', 'offer']

/** セクションの上限(画面とデータの両方で守る) */
export const MAX_SECTIONS = 6
export const MAX_SLOTS = 8

/** 保存されている JSON から、セクションの一覧を読む(壊れていても、読める分だけ) */
function parseSections(text?: string): Section[] {
  if (!text) return []
  try {
    const raw = JSON.parse(text) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .map((r): Section | null => {
        const o = r as { kind?: string; slots?: number; categoryHeading?: boolean }
        const slots = Math.round(Number(o.slots))
        if (!Number.isFinite(slots) || slots < 1) return null
        return { kind: o.kind === 'feature' ? 'feature' : 'grid', slots: Math.min(MAX_SLOTS, slots), ...(o.categoryHeading ? { categoryHeading: true } : {}) }
      })
      .filter((s): s is Section => s !== null)
      .slice(0, MAX_SECTIONS)
  } catch {
    return []
  }
}

export interface TemplateInput {
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
        sections: parseSections(r.cr854_sections),
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
    cr854_sections: JSON.stringify(input.sections.map((s) => ({ kind: s.kind, slots: s.slots, ...(s.categoryHeading ? { categoryHeading: true } : {}) }))),
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
