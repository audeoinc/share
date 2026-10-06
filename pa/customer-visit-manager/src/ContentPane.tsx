import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Divider,
  Field,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  Tab,
  TabList,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components'
import {
  ArrowDownRegular,
  ArrowUpRegular,
  ChevronDownRegular,
  DismissRegular,
} from '@fluentui/react-icons'
import { AiIcon } from './AiMark'
import { TemplateThumb } from './TemplateThumb'
import { ChatPanel, type ChatMsg } from './ChatPanel'
import { AutoTextarea } from './AutoTextarea'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { Candidates } from './Candidates'
import { HeroCandidates } from './HeroCandidates'
import { heroImage, productImage } from './images'
import { DND_HERO, SOURCE_AI, type Candidate, type Item } from './items'
import { withChat, type CopyLanguage, type ProposedHero } from './aiSelect'
import { optionLabel, tr, useT } from './i18n'
import { Row, productMeta } from './ProductRow'
import { useSelection } from './useSelection'
import { progressOf } from './progress'
import { openTemplateManager, sectionRange, templateOptions, type EmailTemplateId, type SectionInfo } from './templates'
import type { AiDrafts } from './useAiDrafts'

type TopTab = 'theme' | 'template' | 'hero' | 'sections' | 'instructions'
type FieldKey = 'theme' | 'headline' | 'copy' | 'instructions' | 'themeReason' | 'copyAngle' | 'instructionsAngle'

interface Props {
  theme: string
  headline: string
  copy: string
  instructions: string
  /** 採用した案の補足(保存される) */
  themeReason: string
  copyAngle: string
  instructionsAngle: string
  onField: (key: FieldKey, value: string) => void
  template: EmailTemplateId
  onTemplate: (id: EmailTemplateId) => void
  sectionTitles: string[]
  onSectionTitle: (index: number, text: string) => void
  sectionCopies: string[]
  onSectionCopy: (index: number, text: string) => void
  products: Cr854_products[]
  heroes: Cr854_heroimages[]
  /** 選定の対象(配信カードの国に合う市場のもの)。products / heroes は、すでに載せたものの表示用に全件を持つ */
  poolProducts: Cr854_products[]
  poolHeroes: Cr854_heroimages[]
  items: Item[]
  setItems: Dispatch<SetStateAction<Item[]>>
  candidates: Candidate[]
  setCandidates: Dispatch<SetStateAction<Candidate[]>>
  heroId?: string
  setHeroId: (id?: string) => void
  heroReason: string
  setHeroReason: (text: string) => void
  heroCandidates: ProposedHero[]
  setHeroCandidates: Dispatch<SetStateAction<ProposedHero[]>>
  /** コピー・ヘッドラインの言語 */
  language: CopyLanguage
  onLanguage: (v: CopyLanguage) => void
  drafts: AiDrafts
  disabled: boolean
}

// ------------------------------------------------------------------ スタイル

const useStyles = makeStyles({
  // グリッドの子は、中身が長くても列を押し広げない(帯や長い文がペインからはみ出さないように)
  // 中ペイン全体: 上は内容(スクロール)、下は AI チャット(固定)
  shell: { flexGrow: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' },
  // 下端を、余白の高さ(16px)だけ薄く消す: まだ下に続きがあるとき、途中で切れた内容が、はっきり切れずに消えていく(末尾までスクロールしたときは、余白の部分なので、見た目は変わらない)
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '16px',
    maskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent)',
    WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 16px), transparent)',
  },
  grid12: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', rowGap: '12px', minWidth: 0 },
  grid8: { display: 'grid', rowGap: '8px', minWidth: 0 },
  grid4: { display: 'grid', rowGap: '4px', minWidth: 0 },
  grid2: { display: 'grid', rowGap: '2px', minWidth: 0 },
  flexRow: { display: 'flex', alignItems: 'center', columnGap: '8px', rowGap: '4px', flexWrap: 'wrap', minWidth: 0 },
  flexRowTight: { display: 'flex', alignItems: 'center', columnGap: '6px', rowGap: '4px', flexWrap: 'wrap', minWidth: 0 },
  flexEnd: { display: 'flex', justifyContent: 'flex-end' },
  caption: { fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightRegular, lineHeight: tokens.lineHeightBase200, color: tokens.colorNeutralForeground3 },
  lead: { fontWeight: tokens.fontWeightSemibold },
  value: { fontWeight: tokens.fontWeightRegular, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground1 },
  // 値と、それに付く補足(AIの理由など)は 1 つのグループ。補足は小さく薄く、値の真下に寄せる
  group: { display: 'grid', rowGap: '2px', minWidth: 0 },
  noteBox: {
    display: 'flex',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: '6px',
    paddingLeft: '8px',
    borderLeft: `2px solid ${tokens.colorNeutralStroke1}`,
    fontSize: '11px',
    lineHeight: '16px',
    color: tokens.colorNeutralForeground3,
  },
  // 案の一覧の見出し。上の「現在の値」のグループとは、区切って別のグループにする
  listHead: {
    marginTop: '8px',
    paddingTop: '12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  warn: { fontSize: tokens.fontSizeBase200, color: tokens.colorPaletteDarkOrangeForeground1 },
  bold: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  semibold: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  tabs: {
    minWidth: 0,
    maxWidth: '100%',
    overflowX: 'auto',
    overflowY: 'hidden',
    flexWrap: 'nowrap',
    columnGap: '4px',
    '& button': { flexShrink: 0, whiteSpace: 'nowrap' },
  },
  // Block
  block: {
    display: 'grid',
    rowGap: '8px',
    padding: '12px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    minWidth: 0,
  },
  blockHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', columnGap: '8px', rowGap: '4px', flexWrap: 'wrap' },
  // Idea cards
  card: {
    padding: '12px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'grid',
    rowGap: '4px',
    minWidth: 0,
  },
  cardAdopted: { border: `1px solid ${tokens.colorPaletteGreenBorderActive}` },
  pre: { whiteSpace: 'pre-wrap', fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1 },
  // 制作指示のような長文は、タイトルではなく本文なので、太字にしない
  preBody: { whiteSpace: 'pre-wrap', fontSize: tokens.fontSizeBase200, lineHeight: '20px', fontWeight: tokens.fontWeightRegular, color: tokens.colorNeutralForeground1 },
  copyHeadline: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1, letterSpacing: '0.04em', lineHeight: 1.5 },
  chipStart: { justifySelf: 'start' },
  pick: {
    cursor: 'pointer',
    padding: '8px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  pickCurrent: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  // Template
  tplCard: {
    display: 'flex',
    columnGap: '12px',
    padding: '12px',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  tplCardSelected: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2, ':hover': { backgroundColor: tokens.colorBrandBackground2 } },
  thumb: {
    width: '84px',
    flexShrink: 0,
    backgroundColor: '#fff',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: '4px',
    display: 'grid',
    rowGap: '4px',
    alignContent: 'start',
  },
  thumbFree: { color: '#888', fontSize: '10px', textAlign: 'center' },
  // Drop zones
  dropZone: { display: 'grid', rowGap: '8px', borderRadius: tokens.borderRadiusMedium, minWidth: 0 },
  dropActive: { outline: `2px dashed ${tokens.colorBrandStroke1}`, outlineOffset: '2px' },
  heroEmpty: {
    padding: '12px',
    border: `2px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  heroEmptyActive: { border: `2px dashed ${tokens.colorBrandStroke1}` },
  accordion: {
    marginTop: '8px',
    minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  accordionPanel: { padding: '12px', minWidth: 0 },
})

// ------------------------------------------------------------------ 共通の部品

/** クリックしたタブを中央へ寄せる(端のタブを選んでも、次のタブが見えて、続けて選べる) */
const revealTab = (e: React.MouseEvent<HTMLElement>) => {
  const el = e.currentTarget
  requestAnimationFrame(() => el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }))
}

function AiButton({ busy, disabled, onClick, children }: { busy: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  const t = useT()
  return (
    <Button
      appearance="outline"
      size="small"
      onClick={onClick}
      disabled={busy || disabled}
      icon={busy ? <Spinner size="extra-tiny" /> : <AiIcon />}
    >
      {busy ? t('考え中...', 'Thinking...') : children}
    </Button>
  )
}

const heroMeta = (h?: Cr854_heroimages) => (h ? `${h.cr854_imagecode} ・ ${optionLabel(h.cr854_purposename)} ・ ${optionLabel(h.cr854_seasonname)} ・ ${h.cr854_tags ?? ''}` : '')

/** コピー・ヘッドラインの言語の切り替え(auto は、配信の国に合わせる) */
function LanguageToggle({ value, onChange }: { value: CopyLanguage; onChange: (v: CopyLanguage) => void }) {
  const s = useStyles()
  const t = useT()
  const opts: { v: CopyLanguage; label: string }[] = [
    { v: 'auto', label: t('国に合わせる', 'Match country') },
    { v: 'ja', label: t('日本語', 'Japanese') },
    { v: 'en', label: 'English' },
  ]
  return (
    <div className={s.flexRow}>
      <span className={s.caption}>{t('言語', 'Language')}</span>
      <div role="group" aria-label={t('コピーの言語', 'Copy language')} style={{ display: 'inline-flex' }}>
        {opts.map((o) => (
          <Button
            key={o.v}
            size="small"
            appearance={value === o.v ? 'primary' : 'outline'}
            aria-pressed={value === o.v}
            onClick={() => onChange(o.v)}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** セクションの中の 1 つのブロック(見出し / コピー / 商品)。右上に、そのブロックの AI ボタンなどを置く */
function Block({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const s = useStyles()
  return (
    <div className={s.block}>
      <span className={s.bold}>{title}</span>
      {right && <div className={s.flexRow}>{right}</div>}
      {children}
    </div>
  )
}

// ------------------------------------------------------------------ テーマ・コピー・制作指示: 案 → 採用

interface Idea {
  text: string
  chip?: string
  note?: string
}

function IdeaTab(props: {
  label: string
  value: string
  onChange: (v: string) => void
  ideas: Idea[]
  /** 保存済みの、採用した案の補足 */
  savedNote?: string
  savedChip?: string
  /** 案を採用した(手で書き換えたときの onChange とは分ける。補足も一緒に更新するため) */
  onAdopt: (idea: Idea) => void
  busy: boolean
  blocked?: string
  onGenerate: () => void
}) {
  const s = useStyles()
  const t = useT()
  const { label, value, onChange, ideas, savedNote, savedChip, onAdopt, busy, blocked, onGenerate } = props
  const current = ideas.find((i) => i.text === value)
  const note = savedNote || current?.note
  const chip = savedChip || current?.chip
  return (
    <div className={s.grid12}>
      <div className={s.flexRow}>
        <AiButton busy={busy} disabled={!!blocked} onClick={onGenerate}>
          {ideas.length ? t('案を作り直す', 'Regenerate ideas') : t('AIで案を出す', 'Suggest with AI')}
        </AiButton>
        {blocked && <span className={s.warn}>{blocked}</span>}
      </div>
      <div className={s.group}>
        <Field
          label={
            <span className={s.flexRowTight}>
              {t(`現在の${label}`, `Current ${label}`)}
              <Badge size="small" appearance="filled" color="success">{t('採用中', 'In use')}</Badge>
            </span>
          }
          size="small"
        >
          <AutoTextarea rows={2} value={value} onChange={(_, d) => onChange(d.value)} />
        </Field>
        {(note || chip) && value && (
          <div className={s.noteBox}>
            {chip && <Badge size="small" appearance="tint" color="informative">{chip}</Badge>}
            {note && <span><span className={s.lead}>{t('AIの理由:', 'AI rationale:')}</span>{` ${note}`}</span>}
          </div>
        )}
      </div>
      {ideas.length > 0 && <span className={s.listHead}><span className={s.lead}>{t('AIの案(未採用):', 'AI ideas (not adopted):')}</span> {t('「採用」を押すと、上の内容に反映されます', 'Press "Adopt" to apply it above')}</span>}
      {ideas.map((idea) => {
        const adopted = idea.text === value
        return (
          <div key={idea.text} className={mergeClasses(s.card, adopted && s.cardAdopted)}>
            {idea.chip && <Badge className={s.chipStart} size="small" appearance="tint" color="informative">{idea.chip}</Badge>}
            <span className={idea.text.length > 40 ? s.preBody : s.pre}>{idea.text}</span>
            {idea.note && <span className={s.caption}>{idea.note}</span>}
            <div className={s.flexEnd}>
              {adopted ? (
                <Badge size="small" appearance="filled" color="success">{t('採用中', 'In use')}</Badge>
              ) : (
                <Button size="small" appearance="primary" onClick={() => onAdopt(idea)}>{t('採用', 'Adopt')}</Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ ヘッドライン + コピー: 案 → 採用

function CopyTab(props: {
  headline: string
  lead: string
  onHeadline: (v: string) => void
  onLead: (v: string) => void
  ideas: { headline: string; lead: string; angle: string }[]
  /** 保存済みの、採用した案の切り口 */
  savedAngle?: string
  onAdopt: (idea: { headline: string; lead: string; angle: string }) => void
  busy: boolean
  blocked?: string
  language: CopyLanguage
  onLanguage: (v: CopyLanguage) => void
  onGenerate: () => void
}) {
  const s = useStyles()
  const t = useT()
  const { headline, lead, onHeadline, onLead, ideas, savedAngle, onAdopt, busy, blocked, language, onLanguage, onGenerate } = props
  return (
    <div className={s.grid12}>
      <div className={s.flexRow}>
        <AiButton busy={busy} disabled={!!blocked} onClick={onGenerate}>
          {ideas.length ? t('案を作り直す', 'Regenerate ideas') : t('AIで案を出す', 'Suggest with AI')}
        </AiButton>
        {blocked && <span className={s.warn}>{blocked}</span>}
        <LanguageToggle value={language} onChange={onLanguage} />
      </div>
      <div className={s.group}>
      <Field
        label={
          <span className={s.flexRowTight}>
            {t('現在のヘッドライン(メイン画像に載ります)', 'Current headline (shown on the main image)')}
            <Badge size="small" appearance="filled" color="success">{t('採用中', 'In use')}</Badge>
          </span>
        }
        size="small"
      >
        <AutoTextarea rows={1} value={headline} onChange={(_, d) => onHeadline(d.value)} />
      </Field>
      <Field
        label={
          <span className={s.flexRowTight}>
            {t('現在のコピー(ヘッドラインの下に入ります)', 'Current copy (placed below the headline)')}
            <Badge size="small" appearance="filled" color="success">{t('採用中', 'In use')}</Badge>
          </span>
        }
        size="small"
      >
        <AutoTextarea rows={2} value={lead} onChange={(_, d) => onLead(d.value)} />
      </Field>
      {savedAngle && (headline || lead) && (
        <div className={s.noteBox}>
          <span><span className={s.lead}>{t('切り口:', 'Angle:')}</span>{` ${savedAngle}`}</span>
        </div>
      )}
      </div>
      {ideas.length > 0 && <span className={s.listHead}><span className={s.lead}>{t('AIの案(未採用):', 'AI ideas (not adopted):')}</span> {t('「採用」を押すと、ヘッドラインとコピーの両方が反映されます', 'Press "Adopt" to apply both the headline and the copy')}</span>}
      {ideas.map((idea) => {
        const adopted = idea.headline === headline && idea.lead === lead
        return (
          <div key={`${idea.headline}|${idea.lead}`} className={mergeClasses(s.card, adopted && s.cardAdopted)}>
            {idea.angle && <Badge className={s.chipStart} size="small" appearance="tint" color="informative">{idea.angle}</Badge>}
            <span className={s.copyHeadline}>{idea.headline}</span>
            <span className={s.caption}>{idea.lead}</span>
            <div className={s.flexEnd}>
              {adopted ? (
                <Badge size="small" appearance="filled" color="success">{t('採用中', 'In use')}</Badge>
              ) : (
                <Button
                  size="small"
                  appearance="primary"
                  onClick={() => onAdopt(idea)}
                >
                  {t('採用', 'Adopt')}
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ テンプレート

function TemplateTab({ template, onTemplate, hasCandidates }: { template: EmailTemplateId; onTemplate: (id: EmailTemplateId) => void; hasCandidates: boolean }) {
  const s = useStyles()
  const t = useT()
  return (
    <div className={s.grid12}>
      <span className={s.caption}>
        {t('メールの構成を選びます。選んだテンプレートの枠に、商品が順に入ります。', 'Choose the email layout. Products fill the slots of the chosen template in order.')}
        {hasCandidates && t(' テンプレートを変えると、セクションの構成が変わるため、選定候補は破棄されます(選定済みの商品は残ります)。', ' Changing the template changes the section layout, so the candidates will be discarded (selected products are kept).')}
      </span>
      <div>
        <Button size="small" appearance="outline" onClick={openTemplateManager}>{t('テンプレートを管理(作成・編集)', 'Manage templates (create / edit)')}</Button>
      </div>
      {templateOptions().map((o) => {
        const selected = o.id === template
        return (
          <div key={o.id} onClick={() => onTemplate(o.id)} className={mergeClasses(s.tplCard, selected && s.tplCardSelected)}>
            <TemplateThumb layout={o} free={o.id === 'free'} maxHeight={170} />
            <div style={{ minWidth: 0 }}>
              <div className={s.flexRowTight}>
                <span className={s.bold}>{o.label}</span>
                {selected && <Badge size="small" appearance="filled" color="brand">{t('選択中', 'Selected')}</Badge>}
              </div>
              <span className={s.caption}>{o.description}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ 商品選定タブ(メイン画像 + セクション)

/** mode = hero: メイン画像 / ヘッドライン・コピー。mode = sections: セクション(見出し・コピー・商品) */
type ChatTargetInfo = { key: string; title: string }
type RegisterChat = (target: ChatTargetInfo | null, run?: () => Promise<unknown>) => void

function ProductsTab(p: Props & { mode: 'hero' | 'sections'; registerChat: RegisterChat }) {
  const s = useStyles()
  const t = useT()
  const { template, sectionTitles, products, heroes, items, setItems, candidates, setCandidates, drafts, disabled } = p
  const { sections, listOf, isFull, moveInSection, demote, dropKey, setDropKey, startDrag, overTarget, leaveTarget, dropOnSelected, dropOnSelectedArea, dropOnCandidates, promote, addManual, setItemReason, setCandReason, toItems } = useSelection({ template, items, setItems, candidates, setCandidates })
  const [sub, setSub] = useState<number | 'hero' | 'copy'>(p.mode === 'hero' ? 'hero' : 0)
  const active: number | 'hero' | 'copy' =
    p.mode === 'hero' ? (sub === 'copy' ? 'copy' : 'hero') : typeof sub === 'number' ? Math.min(sub, sections.length - 1) : 0
  const productById = new Map(products.map((x) => [x.cr854_productid, x]))
  const heroById = new Map(heroes.map((x) => [x.cr854_heroimageid, x]))
  const noTheme = !p.theme.trim()

  // ---- AI の選定結果は、そのまま設定する。直前の状態は「元に戻す」で復元できる
  const [undo, setUndo] = useState<{ message: string; run: () => void } | null>(null)

  // 見出しを変えたら、コピー・商品の作り直しをゆるやかに促す(自動では作り直さない)
  const [hint, setHint] = useState<string | null>(null)
  const changeTitle = (sec: SectionInfo, title: string) => {
    p.onSectionTitle(sec.index, title)
    if ((p.sectionCopies[sec.index] ?? '') || listOf(sec).length > 0) setHint(t('見出しを変更しました。必要なら、② コピー・③ 商品を作り直してください。', 'The heading was changed. If needed, regenerate (2) Copy and (3) Products.'))
  }

  const sectionLabel = (sec: SectionInfo) => (sec.wantTitle ? sectionTitles[sec.index] || sec.label : sec.label)

  /** セクション 1 つを一括で(見出し・コピー・商品を、それぞれ第 1 候補で設定する) */
  const selectSection = async (sec: SectionInfo) => {
    const prevItems = items
    const prevCands = candidates
    const prevTitle = sectionTitles[sec.index] ?? ''
    const prevCopy = p.sectionCopies[sec.index] ?? ''
    const result = await drafts.runSection(sec.index)
    if (!result) return false
    const [from, to] = sectionRange(sections, sec, prevItems.length)
    setItems([...prevItems.slice(0, from), ...toItems(result.selected), ...prevItems.slice(to)])
    setCandidates([...prevCands.filter((c) => c.section !== sec.index), ...toItems(result.candidates).map((c) => ({ ...c, section: sec.index }))])
    if (sec.wantTitle && result.title.trim()) p.onSectionTitle(sec.index, result.title.trim())
    if (result.copy.trim()) p.onSectionCopy(sec.index, result.copy.trim())
    setHint(null)
    setUndo({
      message: tr(`AIが${sectionLabel(sec)}の選定をしました(直す場合は、ドラッグ&ドロップで入れ替えられます)`, `AI re-selected ${sectionLabel(sec)} (to adjust, swap items by drag & drop)`),
      run: () => {
        setItems(prevItems)
        setCandidates(prevCands)
        if (sec.wantTitle) p.onSectionTitle(sec.index, prevTitle)
        p.onSectionCopy(sec.index, prevCopy)
      },
    })
    return true
  }

  /** 見出しだけ作り直す(第 1 候補を設定) */
  const selectTitles = async (sec: SectionInfo) => {
    const prevTitle = sectionTitles[sec.index] ?? ''
    const titles = await drafts.runSectionTitles(sec.index)
    if (!titles?.[0]) return
    changeTitle(sec, titles[0].title)
    setUndo({ message: tr(`AIが${sectionLabel(sec)}の見出しの作り直しをしました(直す場合は、ドラッグ&ドロップで入れ替えられます)`, `AI regenerated the heading for ${sectionLabel(sec)} (to adjust, swap items by drag & drop)`), run: () => p.onSectionTitle(sec.index, prevTitle) })
  }

  /** コピーだけ作り直す(第 1 候補を設定。現在の見出しと、選ばれた商品を踏まえる) */
  const selectCopies = async (sec: SectionInfo) => {
    const prevCopy = p.sectionCopies[sec.index] ?? ''
    const copies = await drafts.runSectionCopies(sec.index)
    if (!copies?.[0]) return
    p.onSectionCopy(sec.index, copies[0].copy)
    setUndo({ message: tr(`AIが${sectionLabel(sec)}のコピーの作り直しをしました(直す場合は、ドラッグ&ドロップで入れ替えられます)`, `AI regenerated the copy for ${sectionLabel(sec)} (to adjust, swap items by drag & drop)`), run: () => p.onSectionCopy(sec.index, prevCopy) })
  }

  /** 商品だけ選び直す(現在の見出しとコピーを踏まえる) */
  const selectProducts = async (sec: SectionInfo) => {
    const prevItems = items
    const prevCands = candidates
    const result = await drafts.runSectionProducts(sec.index)
    if (!result) return
    const [from, to] = sectionRange(sections, sec, prevItems.length)
    setItems([...prevItems.slice(0, from), ...toItems(result.selected), ...prevItems.slice(to)])
    setCandidates([...prevCands.filter((c) => c.section !== sec.index), ...toItems(result.candidates).map((c) => ({ ...c, section: sec.index }))])
    setUndo({
      message: tr(`AIが${sectionLabel(sec)}の商品の選び直しをしました(直す場合は、ドラッグ&ドロップで入れ替えられます)`, `AI re-selected the products for ${sectionLabel(sec)} (to adjust, swap items by drag & drop)`),
      run: () => {
        setItems(prevItems)
        setCandidates(prevCands)
      },
    })
  }

  const selectHero = async () => {
    const prev = { id: p.heroId, reason: p.heroReason, cands: p.heroCandidates }
    const result = await drafts.runHero()
    if (!result) return false
    if (result.hero) {
      p.setHeroId(result.hero.heroId)
      p.setHeroReason(result.hero.reason)
    }
    p.setHeroCandidates(result.candidates)
    setUndo({
      message: tr('AIがメイン画像の選定をしました(直す場合は、ドラッグ&ドロップで入れ替えられます)', 'AI selected the main image (to adjust, swap items by drag & drop)'),
      run: () => {
        p.setHeroId(prev.id)
        p.setHeroReason(prev.reason)
        p.setHeroCandidates(prev.cands)
      },
    })
    return true
  }

  // チャットの対象: 開いているサブタブ(メイン画像 / ヘッドライン・コピー / 各セクション)
  useEffect(() => {
    if (p.mode === 'hero') {
      if (active === 'copy') p.registerChat({ key: 'hero-copy', title: tr('ヘッドライン・コピー', 'Headline & copy') }, () => drafts.runCopy())
      else p.registerChat({ key: 'hero-image', title: tr('メイン画像', 'Main image') }, selectHero)
    } else {
      const sec = sections[active as number]
      if (sec) p.registerChat({ key: `section-${sec.index}`, title: sectionLabel(sec) }, () => selectSection(sec))
    }
  })

  const undoAlert = undo && (
    <MessageBar layout="multiline" intent="success">
      <MessageBarBody>{undo.message}</MessageBarBody>
      <MessageBarActions
        containerAction={<Button appearance="transparent" size="small" aria-label={t('閉じる', 'Close')} icon={<DismissRegular />} onClick={() => setUndo(null)} />}
      >
        <Button
          size="small"
          onClick={() => {
            undo.run()
            setUndo(null)
          }}
        >
          {t('元に戻す', 'Undo')}
        </Button>
      </MessageBarActions>
    </MessageBar>
  )

  // ---- 下段のタブ(ヒーロー: メイン画像 / ヘッドライン・コピー、セクション: 各セクション)
  const subTabs = (
    <TabList
      size="small"
      className={s.tabs}
      selectedValue={active}
      onTabSelect={(_, d) => {
        setSub(d.value as number | 'hero' | 'copy')
        setUndo(null)
      }}
    >
      {p.mode === 'hero' && <Tab value="hero" onClick={revealTab}>{`${p.heroId ? '✓ ' : ''}${t('メイン画像', 'Main image')}`}</Tab>}
      {p.mode === 'hero' && <Tab value="copy" onClick={revealTab}>{`${p.headline || p.copy ? '✓ ' : ''}${drafts.copyIdeas.length ? '● ' : ''}${t('ヘッドライン・コピー', 'Headline & copy')}`}</Tab>}
      {p.mode === 'sections' &&
        sections.map((sec) => {
          const title = sec.wantTitle ? sectionTitles[sec.index] || sec.label : sec.label
          const n = listOf(sec).length
          const count = Number.isFinite(sec.slots) ? `${n}/${sec.slots}` : `${n}`
          return <Tab key={sec.index} value={sec.index} onClick={revealTab}>{`${title}(${count})`}</Tab>
        })}
    </TabList>
  )

  /** 「すべての…から探す」の折りたたみ */
  const finder = (label: string, body: ReactNode) => (
    <Accordion collapsible className={s.accordion}>
      <AccordionItem value="all">
        <AccordionHeader expandIcon={<ChevronDownRegular />} size="small">{label}</AccordionHeader>
        <AccordionPanel className={s.accordionPanel}>{body}</AccordionPanel>
      </AccordionItem>
    </Accordion>
  )

  // ---- セクションの表示(① 見出し → ② コピー → ③ 商品)
  const sectionView = (sec: SectionInfo) => {
    const i = sec.index
    const busyAll = !!drafts.busy[`section:${i}`]
    const busyTitle = !!drafts.busy[`section:${i}:title`]
    const busyCopy = !!drafts.busy[`section:${i}:copy`]
    const busyProducts = !!drafts.busy[`section:${i}:products`]
    const anyBusy = busyAll || busyTitle || busyCopy || busyProducts

    const list = listOf(sec)
    const cands = candidates.filter((c) => c.section === i)
    const usedIds = new Set([...items, ...candidates].map((x) => x.productId))
    const titles = drafts.titleCandidates[i] ?? []
    const copies = drafts.sectionCopyCandidates[i] ?? []
    const currentTitle = sectionTitles[i] ?? ''
    const currentCopy = p.sectionCopies[i] ?? ''

    const header = (
      <div className={s.flexRow}>
        <AiButton busy={busyAll} disabled={noTheme || disabled || anyBusy} onClick={() => selectSection(sec)}>
          {t('このセクションをまとめてAIで選定', 'Select this whole section with AI')}
        </AiButton>
        {noTheme && <span className={s.warn}>{t('先にテーマを決めてください', 'Set a theme first')}</span>}
      </div>
    )

    return (
      <div className={s.grid12}>
        {header}
        {undoAlert}
        {hint && (
          <MessageBar layout="multiline" intent="info">
            <MessageBarBody>{hint}</MessageBarBody>
            <MessageBarActions
              containerAction={<Button appearance="transparent" size="small" aria-label={t('閉じる', 'Close')} icon={<DismissRegular />} onClick={() => setHint(null)} />}
            />
          </MessageBar>
        )}

        {sec.wantTitle && (
          <Block
            title={t('① 見出し(切り口)', '1. Heading (angle)')}
            right={
              <AiButton busy={busyTitle} disabled={noTheme || disabled || anyBusy} onClick={() => selectTitles(sec)}>
                {titles.length ? t('作り直す', 'Regenerate') : t('AIで作る', 'Generate with AI')}
              </AiButton>
            }
          >
            <span className={s.value}>{currentTitle || t('(未設定)', '(Not set)')}</span>
            {titles.map((ti) => {
              const current = currentTitle === ti.title
              return (
                <div key={ti.title} onClick={() => changeTitle(sec, ti.title)} className={mergeClasses(s.pick, current && s.pickCurrent)}>
                  <div className={s.flexRowTight}>
                    <span className={s.semibold}>{ti.title}</span>
                    {current && <Badge size="small" appearance="filled" color="brand">{t('設定中', 'Current')}</Badge>}
                  </div>
                  <span className={s.caption}>{ti.reason}</span>
                </div>
              )
            })}
            {titles.length > 0 && <span className={s.caption}>{t('クリックで差し替えます。書き換えは、プレビューの見出しから。', 'Click to swap. To rewrite it, edit the heading in the preview.')}</span>}
          </Block>
        )}

        <Block
          title={`${sec.wantTitle ? '② ' : '① '}${t('コピー', 'Copy')}`}
          right={
            <>
              <AiButton busy={busyCopy} disabled={noTheme || disabled || anyBusy} onClick={() => selectCopies(sec)}>
                {copies.length ? t('作り直す', 'Regenerate') : t('AIで作る', 'Generate with AI')}
              </AiButton>
              <LanguageToggle value={p.language} onChange={p.onLanguage} />
            </>
          }
        >
          <Field label={t('セクションのコピー(見出しの下に入ります)', 'Section copy (placed below the heading)')} size="small">
            <AutoTextarea rows={2} size="small" value={currentCopy} onChange={(_, d) => p.onSectionCopy(i, d.value)} />
          </Field>
          {copies.map((c) => {
            const current = currentCopy === c.copy
            return (
              <div key={c.copy} onClick={() => p.onSectionCopy(i, c.copy)} className={mergeClasses(s.pick, current && s.pickCurrent)}>
                <div className={s.flexRowTight}>
                  {c.angle && <Badge size="small" appearance="tint" color="informative">{c.angle}</Badge>}
                  {current && <Badge size="small" appearance="filled" color="brand">{t('設定中', 'Current')}</Badge>}
                </div>
                <span style={{ fontSize: tokens.fontSizeBase200, lineHeight: tokens.lineHeightBase200 }}>{c.copy}</span>
              </div>
            )
          })}
          {copies.length > 0 && <span className={s.caption}>{t('クリックで差し替えます。商品を選んだあとに「作り直す」と、商品を踏まえたコピーになります。', 'Click to swap. After selecting products, press "Regenerate" to get copy based on them.')}</span>}
        </Block>

        <Block
          title={`${sec.wantTitle ? '③ ' : '② '}${t('商品', 'Products')}`}
          right={
            <AiButton busy={busyProducts} disabled={noTheme || disabled || anyBusy} onClick={() => selectProducts(sec)}>
              {list.length ? t('選び直す', 'Re-select') : t('AIで選ぶ', 'Select with AI')}
            </AiButton>
          }
        >
          <span className={s.semibold} style={{ fontSize: tokens.fontSizeBase200 }}>
            {t(`選定済み(${list.length}${Number.isFinite(sec.slots) ? ` / ${sec.slots}` : ''}件)`, `Selected (${list.length}${Number.isFinite(sec.slots) ? ` / ${sec.slots}` : ''})`)}
          </span>
          <div
            onDragOver={overTarget('sel')}
            onDragLeave={leaveTarget('sel')}
            onDrop={(e) => {
              e.preventDefault()
              setDropKey(null)
              dropOnSelectedArea(sec, e.dataTransfer)
            }}
            className={mergeClasses(s.dropZone, dropKey === 'sel' && !isFull(sec) && s.dropActive)}
          >
            {list.length === 0 && <span className={s.caption}>{t('まだ選定されていません。「AIで案出し」か、下の候補・一覧から選んでください(ドラッグでも追加できます)。', 'Nothing selected yet. Use AI suggestions or pick from the candidates and list below (you can also drag to add).')}</span>}
            {list.map((it, k) => {
              const prod = productById.get(it.productId)
              const outside = Number.isFinite(sec.slots) && k >= sec.slots
              return (
                <Row
                  key={it.key}
                  drag={{
                    draggable: true,
                    onDragStart: startDrag('item', it.key, it.productId),
                    onDragOver: overTarget(it.key),
                    onDragLeave: leaveTarget(it.key),
                    onDrop: (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setDropKey(null)
                      dropOnSelected(sec, it, e.dataTransfer)
                    },
                  }}
                  highlight={dropKey === it.key}
                  image={productImage(prod)}
                  title={prod?.cr854_name ?? ''}
                  meta={productMeta(prod)}
                  reason={it.reason}
                  onReason={(v) => setItemReason(it.key, v)}
                  source={it.source}
                  badge={outside ? t('枠外', 'Outside slots') : undefined}
                  actions={
                    <>
                      <div>
                        <Button appearance="subtle" size="small" icon={<ArrowUpRegular />} disabled={k === 0} onClick={() => moveInSection(sec, it.key, -1)} aria-label={t('上へ', 'Move up')} />
                        <Button appearance="subtle" size="small" icon={<ArrowDownRegular />} disabled={k === list.length - 1} onClick={() => moveInSection(sec, it.key, 1)} aria-label={t('下へ', 'Move down')} />
                      </div>
                      <Button appearance="subtle" size="small" onClick={() => demote(sec, it)}>{t('外す', 'Remove')}</Button>
                    </>
                  }
                />
              )
            })}
          </div>
          <div
            onDragOver={overTarget('cands')}
            onDragLeave={leaveTarget('cands')}
            onDrop={(e) => {
              e.preventDefault()
              setDropKey(null)
              dropOnCandidates(sec, e.dataTransfer)
            }}
            className={mergeClasses(s.dropZone, dropKey === 'cands' && s.dropActive)}
          >
            <Divider alignContent="start"><span className={s.caption}>{t(`残りの候補(${cands.length}件)`, `Remaining candidates (${cands.length})`)}</span></Divider>
            {cands.length === 0 && <span className={s.caption}>{t('候補はありません(選定済みの行をここへドラッグすると、候補へ戻せます)。', 'No candidates (drag a selected row here to move it back to candidates).')}</span>}
            {cands.map((c) => {
              const prod = productById.get(c.productId)
              return (
                <Row
                  key={c.key}
                  drag={{ draggable: true, onDragStart: startDrag('cand', c.key, c.productId) }}
                  dim
                  image={productImage(prod)}
                  title={prod?.cr854_name ?? ''}
                  meta={productMeta(prod)}
                  reason={c.reason}
                  onReason={(v) => setCandReason(c.key, v)}
                  source={c.source}
                  actions={<Button size="small" appearance="outline" onClick={() => promote(sec, c)}>{t('選ぶ', 'Select')}</Button>}
                />
              )
            })}
          </div>
          {finder(t('すべての商品から探す', 'Browse all products'), <Candidates products={p.poolProducts} usedIds={usedIds} onAdd={(id) => addManual(sec, id)} />)}
        </Block>
      </div>
    )
  }

  // ---- メイン画像の表示
  const setHero = (heroId: string, reason: string) => {
    // いま設定中の画像は、候補へ回す
    if (p.heroId && p.heroId !== heroId) {
      p.setHeroCandidates((prev) => [{ heroId: p.heroId!, reason: p.heroReason }, ...prev.filter((c) => c.heroId !== heroId && c.heroId !== p.heroId)])
    } else {
      p.setHeroCandidates((prev) => prev.filter((c) => c.heroId !== heroId))
    }
    p.setHeroId(heroId)
    p.setHeroReason(reason)
  }

  const startHeroDrag = (heroId: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DND_HERO, heroId)
    e.dataTransfer.effectAllowed = 'move'
  }
  const dropHero = (onId: (id: string) => void) => (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropKey(null)
    const id = e.dataTransfer.getData(DND_HERO)
    if (id) onId(id)
  }
  /** 選定中のメイン画像を、候補へ戻す */
  const demoteHero = () => {
    const cur = heroById.get(p.heroId ?? '')
    if (!cur) return
    p.setHeroCandidates((prev) => [{ heroId: cur.cr854_heroimageid, reason: p.heroReason }, ...prev])
    p.setHeroId(undefined)
    p.setHeroReason('')
  }

  const heroView = () => {
    const busy = !!drafts.busy.hero
    const header = (
      <div className={s.flexRow}>
        <AiButton busy={busy} disabled={noTheme || disabled} onClick={selectHero}>
          {t('メイン画像をAIで選定', 'Select main image with AI')}
        </AiButton>
        {noTheme && <span className={s.warn}>{t('先にテーマを決めてください', 'Set a theme first')}</span>}
      </div>
    )

    const current = heroById.get(p.heroId ?? '')
    return (
      <div className={s.grid8}>
        {header}
        {undoAlert}
        <span className={s.semibold} style={{ fontSize: tokens.fontSizeBase200 }}>{t('選定済み(メイン画像)', 'Selected (main image)')}</span>
        {current ? (
          <Row
            wide
            drag={{
              draggable: true,
              onDragStart: startHeroDrag(current.cr854_heroimageid),
              onDragOver: overTarget('hero-sel'),
              onDragLeave: leaveTarget('hero-sel'),
              onDrop: dropHero((id) => {
                if (id === current.cr854_heroimageid) return
                setHero(id, p.heroCandidates.find((c) => c.heroId === id)?.reason ?? '')
              }),
            }}
            highlight={dropKey === 'hero-sel'}
            image={heroImage(current)}
            title={current.cr854_name}
            meta={heroMeta(current)}
            reason={p.heroReason}
            onReason={p.setHeroReason}
            actions={
              <Button
                size="small"
                appearance="subtle"
                onClick={() => {
                  p.setHeroCandidates((prev) => [{ heroId: current.cr854_heroimageid, reason: p.heroReason }, ...prev])
                  p.setHeroId(undefined)
                  p.setHeroReason('')
                }}
              >
                {t('外す', 'Remove')}
              </Button>
            }
          />
        ) : (
          <div
            onDragOver={overTarget('hero-sel')}
            onDragLeave={leaveTarget('hero-sel')}
            onDrop={dropHero((id) => setHero(id, p.heroCandidates.find((c) => c.heroId === id)?.reason ?? ''))}
            className={mergeClasses(s.heroEmpty, dropKey === 'hero-sel' && s.heroEmptyActive)}
          >
            <span className={s.caption}>{t('まだ選定されていません。「AIで案出し」か、下の候補・一覧から選んでください(ドラッグでも設定できます)。', 'Nothing selected yet. Use AI suggestions or pick from the candidates and list below (you can also drag to set).')}</span>
          </div>
        )}
        <div
          onDragOver={overTarget('hero-cands')}
          onDragLeave={leaveTarget('hero-cands')}
          onDrop={dropHero((id) => {
            if (id === p.heroId) demoteHero()
          })}
          className={mergeClasses(s.dropZone, dropKey === 'hero-cands' && s.dropActive)}
        >
          <Divider alignContent="start"><span className={s.caption}>{t(`残りの候補(${p.heroCandidates.length}件)`, `Remaining candidates (${p.heroCandidates.length})`)}</span></Divider>
          {p.heroCandidates.length === 0 && <span className={s.caption}>{t('候補はありません(候補は、AIが案を出したときだけ表示されます。保存はされません。選定中の画像をここへドラッグすると、候補へ戻せます)。', 'No candidates (candidates appear only when AI suggests them and are not saved. Drag the selected image here to move it back to candidates).')}</span>}
          {p.heroCandidates.map((c) => {
            const h = heroById.get(c.heroId)
            return (
              <Row
                key={c.heroId}
                wide
                dim
                drag={{ draggable: true, onDragStart: startHeroDrag(c.heroId) }}
                image={heroImage(h)}
                title={h?.cr854_name ?? ''}
                meta={heroMeta(h)}
                reason={c.reason}
                source={SOURCE_AI}
                actions={<Button size="small" appearance="outline" onClick={() => setHero(c.heroId, c.reason)}>{t('選ぶ', 'Select')}</Button>}
              />
            )
          })}
        </div>
        {finder(t('すべての画像から探す', 'Browse all images'), <HeroCandidates heroes={p.poolHeroes} selectedId={p.heroId} onSelect={(id) => setHero(id, '')} />)}
      </div>
    )
  }

  // ---- ヘッドライン・コピー(メイン画像の上に載るヘッドラインと、その下のコピー。組で案を出す)
  const copyView = (
    <CopyTab
      headline={p.headline}
      lead={p.copy}
      onHeadline={(v) => {
        p.onField('headline', v)
        p.onField('copyAngle', '')
      }}
      onLead={(v) => {
        p.onField('copy', v)
        p.onField('copyAngle', '')
      }}
      ideas={drafts.copyIdeas}
      savedAngle={p.copyAngle}
      onAdopt={(idea) => {
        p.onField('headline', idea.headline)
        p.onField('copy', idea.lead)
        p.onField('copyAngle', idea.angle)
      }}
      busy={!!drafts.busy.copy}
      blocked={noTheme ? t('先にテーマを決めてください', 'Set a theme first') : undefined}
      language={p.language}
      onLanguage={p.onLanguage}
      onGenerate={drafts.runCopy}
    />
  )

  return (
    <div className={s.grid12}>
      {subTabs}
      {active === 'hero' ? heroView() : active === 'copy' ? copyView : sectionView(sections[active])}
    </div>
  )
}

// ------------------------------------------------------------------ 中ペイン全体

/** チャットの入力欄の上に出す、よく使う頼み方(対象ごと)。押すと入力欄に入る */
function chatSuggestions(key?: string): string[] {
  if (!key) return []
  if (key === 'theme') return [tr('もっとカジュアルな切り口で', 'Make it more casual'), tr('季節感を強めて', 'Lean harder on the season'), tr('売れ筋の商品を主役にして', 'Center it on best-selling products')]
  if (key === 'hero-image') return [tr('もっと明るい雰囲気の画像に', 'Pick a brighter, lighter image'), tr('商品が目立つ画像に', 'Pick an image where the products stand out')]
  if (key === 'hero-copy') return [tr('もっと短く', 'Make it shorter'), tr('行動を促す言い方に', 'Use a stronger call to action'), tr('上品で落ち着いた言い方に', 'Make the tone calmer and more refined')]
  if (key === 'instructions') return [tr('もっと簡潔に', 'Make it more concise'), tr('色味の指定を足して', 'Add color direction'), tr('CTAを目立たせて', 'Make the call to action stand out')]
  return [tr('必ず入れたい商品: ', 'Must include this product: '), tr('もっと手頃な価格の商品で', 'Use more affordable products'), tr('新作を優先して', 'Prioritize new arrivals')]
}

export function ContentPane(props: Props) {
  const s = useStyles()
  const t = useT()
  const { theme, headline, instructions, onField, drafts, template, onTemplate, candidates } = props
  const [tab, setTab] = useState<TopTab>('theme')

  // ---- AI チャット(開いているタブの案づくりに、指示と対話を加える)。会話は、タブ(対象)ごとに持つ。保存はしない
  const [chats, setChats] = useState<Record<string, ChatMsg[]>>({})
  const [chatTarget, setChatTarget] = useState<{ key: string; title: string } | null>(null)
  const [chatBusy, setChatBusy] = useState(false)
  const chatRun = useRef<(() => Promise<unknown>) | null>(null)
  const registerChat = useCallback<RegisterChat>((target, run) => {
    chatRun.current = run ?? null
    setChatTarget((prev) => (prev?.key === target?.key && prev?.title === target?.title ? prev : target))
  }, [])
  const pr = progressOf({ theme, template, heroId: props.heroId, headline, items: props.items, instructions })

  const mark = (filled: boolean, hasIdeas: boolean) => `${filled ? '✓ ' : ''}${hasIdeas ? '● ' : ''}`
  const needTheme = theme.trim() ? undefined : t('先にテーマを決めてください', 'Set a theme first')

  // テーマ・テンプレート・制作指示のタブの対象(ヒーロー・セクションは、各タブ(ProductsTab)が知らせる)
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (tab === 'theme') registerChat({ key: 'theme', title: t('テーマ', 'Theme') }, () => drafts.runTheme())
    else if (tab === 'instructions') registerChat({ key: 'instructions', title: t('制作指示', 'Production notes') }, () => drafts.runInstructions())
    else if (tab === 'template') registerChat(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  })

  const sendChat = async (text: string) => {
    const run = chatRun.current
    if (!chatTarget || !run || chatBusy) return
    const key = chatTarget.key
    const turns: ChatMsg[] = [...(chats[key] ?? []), { role: 'user', text }]
    setChats((prev) => ({ ...prev, [key]: turns }))
    setChatBusy(true)
    let reply = ''
    try {
      const out = await withChat(turns, () => run())
      reply = out.answered
        ? out.reply || tr('(回答がありませんでした)', '(No answer)')
        : out.value === true
          ? out.reply || tr('反映しました', 'Done.')
          : tr('うまくいきませんでした。画面下のメッセージを確認してください', "That didn't work. Check the message at the bottom of the screen.")
    } catch (e) {
      reply = e instanceof Error ? e.message : String(e)
    } finally {
      setChatBusy(false)
    }
    setChats((prev) => ({ ...prev, [key]: [...turns, { role: 'assistant', text: reply }] }))
  }

  const suggestions = chatSuggestions(chatTarget?.key)

  return (
    <div className={s.shell}>
    <div className={s.scroll}>
    <div className={s.grid12}>
      <Text weight="semibold" size={300}>{t('コンテンツ生成', 'Content generation')}</Text>
      <TabList size="small" className={s.tabs} selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TopTab)}>
        <Tab value="theme" onClick={revealTab}>{`${mark(pr.theme, drafts.themeIdeas.length > 0)}${t('① テーマ', '1. Theme')}`}</Tab>
        <Tab value="template" onClick={revealTab}>{`${mark(pr.template, false)}${t('② テンプレート', '2. Template')}`}</Tab>
        <Tab value="hero" onClick={revealTab}>{`${mark(pr.hero, drafts.copyIdeas.length > 0)}${t('③ ヒーロー', '3. Hero')}`}</Tab>
        <Tab value="sections" onClick={revealTab}>{`${mark(pr.sections, false)}${t('④ セクション', '4. Sections')}`}</Tab>
        <Tab value="instructions" onClick={revealTab}>{`${mark(pr.instructions, drafts.instructionIdeas.length > 0)}${t('⑤ 制作指示', '5. Production notes')}`}</Tab>
      </TabList>

      {tab === 'theme' && (
        <IdeaTab
          label={t('テーマ(配信全体の前提。メールには出ません)', 'Theme (premise for the whole delivery. Not shown in the email)')}
          value={theme}
          onChange={(v) => {
            onField('theme', v)
            onField('themeReason', '')
          }}
          ideas={drafts.themeIdeas.map((th) => ({ text: th.theme, note: th.reason }))}
          savedNote={props.themeReason}
          onAdopt={(idea) => {
            onField('theme', idea.text)
            onField('themeReason', idea.note ?? '')
          }}
          busy={!!drafts.busy.theme}
          onGenerate={drafts.runTheme}
        />
      )}
      {tab === 'template' && <TemplateTab template={template} onTemplate={onTemplate} hasCandidates={candidates.length > 0} />}
      {tab === 'hero' && <ProductsTab {...props} mode="hero" registerChat={registerChat} />}
      {tab === 'sections' && <ProductsTab {...props} mode="sections" registerChat={registerChat} />}
      {tab === 'instructions' && (
        <IdeaTab
          label={t('制作指示', 'Production notes')}
          value={instructions}
          onChange={(v) => {
            onField('instructions', v)
            onField('instructionsAngle', '')
          }}
          ideas={drafts.instructionIdeas.map((c) => ({ text: c.text, chip: c.angle }))}
          savedChip={props.instructionsAngle}
          onAdopt={(idea) => {
            onField('instructions', idea.text)
            onField('instructionsAngle', idea.chip ?? '')
          }}
          busy={!!drafts.busy.instructions}
          blocked={needTheme}
          onGenerate={drafts.runInstructions}
        />
      )}
    </div>
    </div>
    <ChatPanel
      title={chatTarget?.title ?? null}
      messages={chatTarget ? (chats[chatTarget.key] ?? []) : []}
      busy={chatBusy}
      suggestions={suggestions}
      idleHint={t('テンプレートは、AIチャットの対象ではありません。他のタブを開いてください', 'The template is not an AI chat target. Open another tab.')}
      onSend={(text) => void sendChat(text)}
      onClear={() => chatTarget && setChats((prev) => ({ ...prev, [chatTarget.key]: [] }))}
    />
    </div>
  )
}
