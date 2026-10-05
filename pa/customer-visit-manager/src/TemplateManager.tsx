import { useState } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components'
import { AddRegular, ArrowDownRegular, ArrowUpRegular, CopyRegular, DeleteRegular, DismissRegular } from '@fluentui/react-icons'
import { AutoTextarea } from './AutoTextarea'
import { useT } from './i18n'
import { MAX_SECTIONS, MAX_SLOTS, deleteTemplate, saveTemplate } from './layoutTemplates'
import { TemplateThumb } from './TemplateThumb'
import { gridColumns, setTemplateManagerOpen, templateOptions, useTemplateManagerOpen, useTemplates, type HeroKind, type Section } from './templates'

interface Draft {
  /** 保存済みの行の ID(新規は undefined) */
  id?: string
  name: string
  description: string
  hero: HeroKind
  sections: Section[]
}

/** 種類の選択肢。3 列のグリッドは、データでは grid + columns: 3 */
type SectionLayout = 'grid' | 'grid3' | 'feature'
const layoutValue = (sec: Section): SectionLayout => (sec.kind === 'feature' ? 'feature' : gridColumns(sec) === 3 ? 'grid3' : 'grid')
/** 3 列にしたときは、横並び 1 行(3 点)になるように枠の数も合わせる。2 列・特集に戻すときは、列の指定を消す */
const layoutPatch = (v: SectionLayout): Partial<Section> =>
  v === 'grid3' ? { kind: 'grid', columns: 3, slots: 3 } : { kind: v, columns: undefined }

/** 構成のプレビューの幅。一覧の見取り図(84px)では、枠の数や列が読み取りにくいため、大きく描く */
const PREVIEW_WIDTH = 220

const NEW_DRAFT: Draft = { name: '', description: '', hero: 'standard', sections: [{ kind: 'grid', slots: 4 }] }

const useStyles = makeStyles({
  surface: { width: '960px', maxWidth: '96vw', height: '82vh', maxHeight: '82vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' },
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, flexGrow: 1, padding: 0, rowGap: 0 },
  head: { display: 'flex', alignItems: 'center', columnGap: '8px', padding: '12px 16px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  grow: { flexGrow: 1 },
  split: { flexGrow: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)' },
  list: { minHeight: 0, overflowY: 'auto', borderRight: `1px solid ${tokens.colorNeutralStroke2}`, padding: '12px', display: 'grid', rowGap: '8px', alignContent: 'start', backgroundColor: tokens.colorNeutralBackground2 },
  listHead: { display: 'flex', alignItems: 'center', columnGap: '6px', flexWrap: 'wrap' },
  groupLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold, marginTop: '6px' },
  item: {
    display: 'flex',
    columnGap: '10px',
    padding: '8px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    minWidth: 0,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  itemSelected: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  itemText: { minWidth: 0, display: 'grid', rowGap: '2px', alignContent: 'start' },
  itemName: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  caption: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, lineHeight: '16px' },
  editor: { minHeight: 0, overflowY: 'auto', padding: '16px', display: 'grid', rowGap: '14px', alignContent: 'start', minWidth: 0 },
  // プレビューの欄は、見取り図の大きさ(枠線・余白を含む)に合わせる。固定の幅だと、見取り図の右端が欠ける
  editorGrid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: '16px', alignItems: 'start' },
  fields: { display: 'grid', rowGap: '14px', minWidth: 0 },
  preview: { display: 'grid', rowGap: '6px', justifyItems: 'start' },
  heroRow: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
  sectionRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: '8px',
    rowGap: '4px',
    padding: '6px 8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  sectionNo: { width: '18px', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  slotSelect: { width: '78px' },
  kindSelect: { width: '140px' },
  actions: { display: 'flex', alignItems: 'center', columnGap: '8px', padding: '10px 16px', borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
})

/** テンプレートの管理(一覧・新規・複製・編集・削除)。標準のテンプレートは編集できず、複製して編集する */
export function TemplateManager() {
  const open = useTemplateManagerOpen()
  useTemplates() // 登録が変わったら、一覧を描き直す
  const t = useT()
  const s = useStyles()
  const options = templateOptions()
  const [selectedId, setSelectedId] = useState<string>('standard4')
  const [draft, setDraft] = useState<Draft | null>(null) // 編集中(新規・複製・編集)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = options.find((o) => o.id === selectedId) ?? options[0]
  const editing = draft !== null

  const heroLabels: Record<HeroKind, string> = {
    standard: t('標準', 'Standard'),
    collab: t('コラボ', 'Collab'),
    offer: t('期間限定', 'Limited offer'),
  }

  const close = () => {
    setTemplateManagerOpen(false)
    setDraft(null)
    setError(null)
  }

  const choose = (id: string) => {
    if (editing && !window.confirm(t('編集中の内容を破棄して、別のテンプレートを開きます。よろしいですか?', 'Discard the current edits and open another template?'))) return
    setDraft(null)
    setError(null)
    setSelectedId(id)
  }

  const startNew = () => {
    setError(null)
    setSelectedId('')
    setDraft({ ...NEW_DRAFT, sections: NEW_DRAFT.sections.map((x) => ({ ...x })) })
  }
  const startDuplicate = () => {
    if (!selected) return
    setError(null)
    setDraft({
      name: t(`${selected.label} のコピー`, `Copy of ${selected.label}`),
      description: selected.description,
      hero: selected.hero,
      sections: selected.sections.map((x) => ({ ...x })),
    })
    setSelectedId('')
  }
  const startEdit = () => {
    if (!selected || selected.builtin) return
    setError(null)
    setDraft({ id: selected.id, name: selected.label, description: selected.description, hero: selected.hero, sections: selected.sections.map((x) => ({ ...x })) })
  }

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d))
  const patchSection = (i: number, p: Partial<Section>) => patch({ sections: (draft?.sections ?? []).map((sec, k) => (k === i ? { ...sec, ...p } : sec)) })
  const moveSection = (i: number, delta: number) => {
    const list = [...(draft?.sections ?? [])]
    const j = i + delta
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    patch({ sections: list })
  }

  const totalSlots = (draft?.sections ?? []).reduce((n, x) => n + x.slots, 0)
  const valid = !!draft && draft.name.trim() !== '' && draft.sections.length > 0

  const save = async () => {
    if (!draft || !valid) return
    setBusy(true)
    setError(null)
    try {
      const id = await saveTemplate({ ...draft })
      setSelectedId(id)
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!selected || selected.builtin || editing) return
    if (!window.confirm(t(`「${selected.label}」を削除します。このテンプレートを使っている配信カードは、Standard4 として扱われます。よろしいですか?`, `Delete "${selected.label}"? Delivery cards that use it will be treated as Standard4.`))) return
    setBusy(true)
    setError(null)
    try {
      await deleteTemplate(selected.id)
      setSelectedId('standard4')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const customs = options.filter((o) => !o.builtin)
  const builtins = options.filter((o) => o.builtin)

  const renderItem = (o: (typeof options)[number]) => (
    <div key={o.id} className={mergeClasses(s.item, !editing && o.id === selected?.id && s.itemSelected)} onClick={() => choose(o.id)} role="button" tabIndex={0}>
      <TemplateThumb hero={o.hero} sections={o.sections} free={o.id === 'free'} />
      <div className={s.itemText}>
        <span className={s.itemName}>{o.label}</span>
        <span className={s.caption}>{o.description}</span>
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface className={s.surface}>
        <DialogBody className={s.body}>
          <div className={s.head}>
            <DialogTitle className={s.grow}>{t('テンプレート', 'Templates')}</DialogTitle>
            <Button appearance="subtle" icon={<DismissRegular />} onClick={close} aria-label={t('閉じる', 'Close')} />
          </div>
          <DialogContent className={s.split} style={{ padding: 0 }}>
            <div className={s.list}>
              <div className={s.listHead}>
                <Button size="small" appearance="primary" icon={<AddRegular />} onClick={startNew}>{t('新規作成', 'New')}</Button>
                <Button size="small" appearance="outline" icon={<CopyRegular />} onClick={startDuplicate} disabled={!selected || (editing && !draft?.id && selectedId === '')}>{t('複製', 'Duplicate')}</Button>
              </div>
              <span className={s.groupLabel}>{t('作成したテンプレート', 'Your templates')}</span>
              {customs.length === 0 && <span className={s.caption}>{t('まだありません。「新規作成」か、標準のテンプレートの「複製」から作れます。', 'None yet. Create one with "New", or duplicate a standard template.')}</span>}
              {customs.map(renderItem)}
              <span className={s.groupLabel}>{t('標準', 'Standard')}</span>
              {builtins.map(renderItem)}
            </div>

            <div className={s.editor}>
              {error && (
                <MessageBar layout="multiline" intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              {draft ? (
                <div className={s.editorGrid}>
                  <div className={s.fields}>
                    <Field label={t('テンプレート名', 'Template name')} required>
                      <Input size="small" value={draft.name} onChange={(_, d) => patch({ name: d.value })} />
                    </Field>
                    <Field label={t('説明', 'Description')}>
                      <AutoTextarea rows={2} size="small" value={draft.description} onChange={(_, d) => patch({ description: d.value })} />
                    </Field>
                    <Field label={t('ヒーローの種類', 'Hero type')}>
                      <div className={s.heroRow}>
                        {(['standard', 'collab', 'offer'] as HeroKind[]).map((h) => (
                          <Button key={h} size="small" appearance={draft.hero === h ? 'primary' : 'outline'} aria-pressed={draft.hero === h} onClick={() => patch({ hero: h })}>
                            {heroLabels[h]}
                          </Button>
                        ))}
                      </div>
                    </Field>
                    <Field label={t(`セクション(商品の枠は合計 ${totalSlots} 点)`, `Sections (${totalSlots} product slots in total)`)}>
                      <div style={{ display: 'grid', rowGap: 6 }}>
                        {draft.sections.map((sec, i) => (
                          <div key={i} className={s.sectionRow}>
                            <span className={s.sectionNo}>{i + 1}</span>
                            <Select
                              size="small"
                              className={s.kindSelect}
                              value={layoutValue(sec)}
                              aria-label={t('種類', 'Type')}
                              onChange={(_, d) => patchSection(i, layoutPatch(d.value as SectionLayout))}
                            >
                              <option value="grid">{t('グリッド(2列)', 'Grid (2 columns)')}</option>
                              <option value="grid3">{t('グリッド(3列)', 'Grid (3 columns)')}</option>
                              <option value="feature">{t('特集', 'Feature')}</option>
                            </Select>
                            <Select
                              size="small"
                              className={s.slotSelect}
                              value={String(sec.slots)}
                              aria-label={t('商品の枠の数', 'Product slots')}
                              onChange={(_, d) => patchSection(i, { slots: Number(d.value) })}
                            >
                              {Array.from({ length: MAX_SLOTS }, (_, k) => k + 1).map((n) => (
                                <option key={n} value={n}>{t(`${n} 点`, `${n} items`)}</option>
                              ))}
                            </Select>
                            <Checkbox label={t('カテゴリ見出し', 'Category heading')} checked={!!sec.categoryHeading} onChange={(_, d) => patchSection(i, { categoryHeading: d.checked === true })} />
                            <span className={s.grow} />
                            <Button size="small" appearance="subtle" icon={<ArrowUpRegular />} disabled={i === 0} onClick={() => moveSection(i, -1)} aria-label={t('上へ', 'Move up')} />
                            <Button size="small" appearance="subtle" icon={<ArrowDownRegular />} disabled={i === draft.sections.length - 1} onClick={() => moveSection(i, 1)} aria-label={t('下へ', 'Move down')} />
                            <Button size="small" appearance="subtle" icon={<DeleteRegular />} disabled={draft.sections.length <= 1} onClick={() => patch({ sections: draft.sections.filter((_, k) => k !== i) })} aria-label={t('このセクションを削除', 'Remove this section')} />
                          </div>
                        ))}
                        <div>
                          <Button size="small" appearance="outline" icon={<AddRegular />} disabled={draft.sections.length >= MAX_SECTIONS} onClick={() => patch({ sections: [...draft.sections, { kind: 'grid', slots: 2 }] })}>
                            {t('セクションを追加', 'Add a section')}
                          </Button>
                        </div>
                      </div>
                    </Field>
                  </div>
                  <div className={s.preview}>
                    <Text size={200} weight="semibold">{t('構成のプレビュー', 'Layout preview')}</Text>
                    <TemplateThumb hero={draft.hero} sections={draft.sections} width={PREVIEW_WIDTH} />
                  </div>
                </div>
              ) : selected ? (
                <div className={s.editorGrid}>
                  <div className={s.fields}>
                    <div style={{ display: 'flex', alignItems: 'center', columnGap: 8, flexWrap: 'wrap' }}>
                      <Text weight="semibold" size={400}>{selected.label}</Text>
                      <Badge size="small" appearance="tint" color={selected.builtin ? 'informative' : 'brand'}>{selected.builtin ? t('標準', 'Standard') : t('作成したテンプレート', 'Your template')}</Badge>
                    </div>
                    <span className={s.caption}>{selected.description || t('(説明なし)', '(No description)')}</span>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 12, rowGap: 4 }}>
                      <span className={s.caption}>{t('ヒーロー', 'Hero')}</span>
                      <span style={{ fontSize: tokens.fontSizeBase200 }}>{heroLabels[selected.hero]}</span>
                      <span className={s.caption}>{t('セクション', 'Sections')}</span>
                      <span style={{ fontSize: tokens.fontSizeBase200 }}>
                        {selected.id === 'free'
                          ? t('自由な並び(枠の数は決まっていません)', 'Free-form (no fixed number of slots)')
                          : selected.sections.map((x) => `${x.kind === 'feature' ? t('特集', 'Feature') : gridColumns(x) === 3 ? t('グリッド(3列)', 'Grid (3 col)') : t('グリッド', 'Grid')}${t(` ${x.slots}点`, ` ×${x.slots}`)}${x.categoryHeading ? t('(見出し付き)', ' (heading)') : ''}`).join(' → ')}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {selected.builtin ? (
                        <Button size="small" appearance="primary" icon={<CopyRegular />} onClick={startDuplicate}>{t('複製して編集', 'Duplicate to edit')}</Button>
                      ) : (
                        <>
                          <Button size="small" appearance="primary" onClick={startEdit}>{t('編集', 'Edit')}</Button>
                          <Button size="small" appearance="outline" icon={<DeleteRegular />} onClick={remove} disabled={busy}>{t('削除', 'Delete')}</Button>
                        </>
                      )}
                    </div>
                    {selected.builtin && <span className={s.caption}>{t('標準のテンプレートは、編集・削除できません。複製して、自分用に作り変えてください。', 'Standard templates cannot be edited or deleted. Duplicate one to make your own version.')}</span>}
                  </div>
                  <div className={s.preview}>
                    <Text size={200} weight="semibold">{t('構成のプレビュー', 'Layout preview')}</Text>
                    <TemplateThumb hero={selected.hero} sections={selected.sections} free={selected.id === 'free'} width={PREVIEW_WIDTH} />
                  </div>
                </div>
              ) : null}
            </div>
          </DialogContent>
          {draft && (
            <div className={s.actions}>
              <span className={s.grow} />
              <Button appearance="secondary" onClick={() => { setDraft(null); setError(null) }} disabled={busy}>{t('キャンセル', 'Cancel')}</Button>
              <Button appearance="primary" onClick={() => void save()} disabled={!valid || busy}>{busy ? t('保存中...', 'Saving...') : t('保存', 'Save')}</Button>
            </div>
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
