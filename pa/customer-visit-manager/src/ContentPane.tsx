import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Avatar,
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
  ReOrderDotsVerticalRegular,
} from '@fluentui/react-icons'
import { AiIcon } from './AiMark'
import { AutoTextarea } from './AutoTextarea'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { Candidates } from './Candidates'
import { HeroCandidates } from './HeroCandidates'
import { heroImage, productImage } from './images'
import { DND_CAND, DND_HERO, DND_ITEM, DND_PRODUCT, SOURCE_AI, SOURCE_MANUAL, yen, type Candidate, type Item } from './items'
import type { CopyLanguage, ProposedHero } from './aiSelect'
import { progressOf } from './progress'
import { EMAIL_TEMPLATES, TEMPLATE_OPTIONS, sectionRange, sectionsOf, type EmailTemplateId, type SectionInfo } from './templates'
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
  // Row
  reason: {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  reasonEditable: {
    cursor: 'text',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  reasonPlain: { cursor: 'default' },
  row: {
    display: 'flex',
    columnGap: '8px',
    padding: '8px',
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minWidth: 0,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowHighlight: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  rowDim: { opacity: 0.8 },
  rowDraggable: { cursor: 'grab' },
  dragIcon: { alignSelf: 'center', marginLeft: '-4px', marginRight: '-4px', color: tokens.colorNeutralForegroundDisabled, flexShrink: 0 },
  avatar: { flexShrink: 0, height: '44px', width: '44px', borderRadius: tokens.borderRadiusMedium },
  avatarWide: { width: '72px', height: '40px' },
  rowBody: { flexGrow: 1, minWidth: 0, display: 'grid', rowGap: '2px' },
  noWrap: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  rowActions: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center', flexShrink: 0 },
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
  return (
    <Button
      appearance="outline"
      size="small"
      onClick={onClick}
      disabled={busy || disabled}
      icon={busy ? <Spinner size="extra-tiny" /> : <AiIcon />}
    >
      {busy ? '考え中...' : children}
    </Button>
  )
}

/** 理由の表示。2 行で省略し、クリックすると全文を編集できる(onChange なしなら読み取り専用) */
function ReasonText({ value, onChange }: { value: string; onChange?: (v: string) => void }) {
  const s = useStyles()
  const [editing, setEditing] = useState(false)
  if (onChange && editing) {
    return (
      <Field label="選定理由" size="small">
        <AutoTextarea
          autoFocus
          size="small"
                    value={value}
          onChange={(_, d) => onChange(d.value)}
          onBlur={() => setEditing(false)}
        />
      </Field>
    )
  }
  return (
    <span
      className={mergeClasses(s.reason, onChange ? s.reasonEditable : s.reasonPlain)}
      style={{ color: value ? tokens.colorNeutralForeground3 : tokens.colorNeutralForegroundDisabled }}
      onClick={onChange ? () => setEditing(true) : undefined}
      title={onChange ? 'クリックして編集' : undefined}
    >
      {value || (onChange ? '(理由を入力)' : '(理由なし)')}
    </span>
  )
}

interface RowProps {
  image?: string
  wide?: boolean
  title: string
  meta: string
  reason: string
  onReason?: (v: string) => void
  source?: number
  badge?: string
  actions?: ReactNode
  dim?: boolean
  /** ドラッグ&ドロップ(ドラッグ元・ドロップ先) */
  drag?: {
    draggable?: boolean
    onDragStart?: (e: React.DragEvent) => void
    onDragOver?: (e: React.DragEvent) => void
    onDragLeave?: (e: React.DragEvent) => void
    onDrop?: (e: React.DragEvent) => void
  }
  /** ドロップ先として強調する */
  highlight?: boolean
}

function Row({ image, wide, title, meta, reason, onReason, source, badge, actions, dim, drag, highlight }: RowProps) {
  const s = useStyles()
  return (
    <div
      {...drag}
      className={mergeClasses(s.row, highlight && s.rowHighlight, dim && s.rowDim, drag?.draggable && s.rowDraggable)}
    >
      {drag?.draggable && <ReOrderDotsVerticalRegular className={s.dragIcon} />}
      <Avatar shape="square" image={{ src: image, alt: title }} name={title} className={mergeClasses(s.avatar, wide && s.avatarWide)} />
      <div className={s.rowBody}>
        <div className={s.flexRowTight}>
          <Text weight="semibold" size={300}>{title}</Text>
          {source !== undefined && (
            <Badge size="small" appearance="tint" color={source === SOURCE_AI ? 'brand' : 'informative'}>{source === SOURCE_AI ? 'AI' : '手動'}</Badge>
          )}
          {badge && <Badge size="small" appearance="tint" color="warning">{badge}</Badge>}
        </div>
        <span className={s.noWrap}>{meta}</span>
        <ReasonText value={reason} onChange={onReason} />
      </div>
      {actions && <div className={s.rowActions}>{actions}</div>}
    </div>
  )
}

const productMeta = (p?: Cr854_products) =>
  p ? `${p.cr854_productcode} ・ ${yen(p.cr854_price)} ・ 在庫${p.cr854_stock ?? '-'} ・ ${p.cr854_salestrendname ?? ''} ・ ★${p.cr854_rating ?? '-'}` : ''

const heroMeta = (h?: Cr854_heroimages) => (h ? `${h.cr854_imagecode} ・ ${h.cr854_purposename ?? ''} ・ ${h.cr854_seasonname ?? ''} ・ ${h.cr854_tags ?? ''}` : '')

/** コピー・ヘッドラインの言語の切り替え(auto は、配信の国に合わせる) */
function LanguageToggle({ value, onChange }: { value: CopyLanguage; onChange: (v: CopyLanguage) => void }) {
  const s = useStyles()
  const opts: { v: CopyLanguage; label: string }[] = [
    { v: 'auto', label: '国に合わせる' },
    { v: 'ja', label: '日本語' },
    { v: 'en', label: 'English' },
  ]
  return (
    <div className={s.flexRow}>
      <span className={s.caption}>言語</span>
      <div role="group" aria-label="コピーの言語" style={{ display: 'inline-flex' }}>
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
  const { label, value, onChange, ideas, savedNote, savedChip, onAdopt, busy, blocked, onGenerate } = props
  const current = ideas.find((i) => i.text === value)
  const note = savedNote || current?.note
  const chip = savedChip || current?.chip
  return (
    <div className={s.grid12}>
      <div className={s.flexRow}>
        <AiButton busy={busy} disabled={!!blocked} onClick={onGenerate}>
          {ideas.length ? '案を作り直す' : 'AIで案を出す'}
        </AiButton>
        {blocked && <span className={s.warn}>{blocked}</span>}
      </div>
      <div className={s.group}>
        <Field
          label={
            <span className={s.flexRowTight}>
              {`現在の${label}`}
              <Badge size="small" appearance="filled" color="success">採用中</Badge>
            </span>
          }
          size="small"
        >
          <AutoTextarea rows={2} value={value} onChange={(_, d) => onChange(d.value)} />
        </Field>
        {(note || chip) && value && (
          <div className={s.noteBox}>
            {chip && <Badge size="small" appearance="tint" color="informative">{chip}</Badge>}
            {note && <span><span className={s.lead}>AIの理由:</span>{` ${note}`}</span>}
          </div>
        )}
      </div>
      {ideas.length > 0 && <span className={s.listHead}><span className={s.lead}>AIの案(未採用):</span> 「採用」を押すと、上の内容に反映されます</span>}
      {ideas.map((idea) => {
        const adopted = idea.text === value
        return (
          <div key={idea.text} className={mergeClasses(s.card, adopted && s.cardAdopted)}>
            {idea.chip && <Badge className={s.chipStart} size="small" appearance="tint" color="informative">{idea.chip}</Badge>}
            <span className={idea.text.length > 40 ? s.preBody : s.pre}>{idea.text}</span>
            {idea.note && <span className={s.caption}>{idea.note}</span>}
            <div className={s.flexEnd}>
              {adopted ? (
                <Badge size="small" appearance="filled" color="success">採用中</Badge>
              ) : (
                <Button size="small" appearance="primary" onClick={() => onAdopt(idea)}>採用</Button>
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
  const { headline, lead, onHeadline, onLead, ideas, savedAngle, onAdopt, busy, blocked, language, onLanguage, onGenerate } = props
  return (
    <div className={s.grid12}>
      <div className={s.flexRow}>
        <AiButton busy={busy} disabled={!!blocked} onClick={onGenerate}>
          {ideas.length ? '案を作り直す' : 'AIで案を出す'}
        </AiButton>
        {blocked && <span className={s.warn}>{blocked}</span>}
        <LanguageToggle value={language} onChange={onLanguage} />
      </div>
      <div className={s.group}>
      <Field
        label={
          <span className={s.flexRowTight}>
            現在のヘッドライン(メイン画像に載ります)
            <Badge size="small" appearance="filled" color="success">採用中</Badge>
          </span>
        }
        size="small"
      >
        <AutoTextarea rows={1} value={headline} onChange={(_, d) => onHeadline(d.value)} />
      </Field>
      <Field
        label={
          <span className={s.flexRowTight}>
            現在のコピー(ヘッドラインの下に入ります)
            <Badge size="small" appearance="filled" color="success">採用中</Badge>
          </span>
        }
        size="small"
      >
        <AutoTextarea rows={2} value={lead} onChange={(_, d) => onLead(d.value)} />
      </Field>
      {savedAngle && (headline || lead) && (
        <div className={s.noteBox}>
          <span><span className={s.lead}>切り口:</span>{` ${savedAngle}`}</span>
        </div>
      )}
      </div>
      {ideas.length > 0 && <span className={s.listHead}><span className={s.lead}>AIの案(未採用):</span> 「採用」を押すと、ヘッドラインとコピーの両方が反映されます</span>}
      {ideas.map((idea) => {
        const adopted = idea.headline === headline && idea.lead === lead
        return (
          <div key={`${idea.headline}|${idea.lead}`} className={mergeClasses(s.card, adopted && s.cardAdopted)}>
            {idea.angle && <Badge className={s.chipStart} size="small" appearance="tint" color="informative">{idea.angle}</Badge>}
            <span className={s.copyHeadline}>{idea.headline}</span>
            <span className={s.caption}>{idea.lead}</span>
            <div className={s.flexEnd}>
              {adopted ? (
                <Badge size="small" appearance="filled" color="success">採用中</Badge>
              ) : (
                <Button
                  size="small"
                  appearance="primary"
                  onClick={() => onAdopt(idea)}
                >
                  採用
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

const TEMPLATE_DESC: Record<EmailTemplateId, string> = {
  free: 'カテゴリ見出しを自動で付ける、自由な並び。商品の数に決まりはありません。',
  standard4: 'メイン画像 + 2×2 の商品グリッド(4 点)。基本の構成です。',
  collab: 'コラボ用のヒーロー + 特集の商品 2 点 + グリッド 2 点(計 4 点)。',
  offer: '期間限定・お得感を打ち出す赤基調のヒーロー + 価格を強調した 4 点。',
  cat2: 'メイン画像 + カテゴリ 2 つ(各 2 点、計 4 点)。カテゴリごとに見出しが付きます。',
  cat3: 'メイン画像 + カテゴリ 3 つ(各 2 点、計 6 点)。カテゴリごとに見出しが付きます。',
}

const HERO_COLOR = { standard: '#cfd2dc', collab: '#b9a9d6', offer: '#f0a5a0' } as const

/** 構成の見取り図(ヒーロー、見出し、商品の枠) */
function TemplateThumb({ id }: { id: EmailTemplateId }) {
  const s = useStyles()
  const tpl = EMAIL_TEMPLATES[id]
  return (
    <div className={s.thumb}>
      <div style={{ height: 24, background: HERO_COLOR[tpl.hero] }} />
      <div style={{ height: 4, width: '60%', margin: '0 auto', background: '#8a8f98' }} />
      {id === 'free' ? (
        <span className={s.thumbFree}>自由</span>
      ) : (
        tpl.sections.map((sec, i) => (
          <div key={i}>
            {sec.categoryHeading && <div style={{ height: 3, width: '45%', margin: '0 auto 4px', background: '#555' }} />}
            <div style={{ display: 'grid', gridTemplateColumns: sec.kind === 'feature' ? '1fr' : '1fr 1fr', gap: 2 }}>
              {Array.from({ length: sec.slots }, (_, k) => (
                <div key={k} style={{ height: sec.kind === 'feature' ? 10 : 14, background: '#e0e0e6' }} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function TemplateTab({ template, onTemplate, hasCandidates }: { template: EmailTemplateId; onTemplate: (id: EmailTemplateId) => void; hasCandidates: boolean }) {
  const s = useStyles()
  return (
    <div className={s.grid12}>
      <span className={s.caption}>
        メールの構成を選びます。選んだテンプレートの枠に、商品が順に入ります。
        {hasCandidates && ' テンプレートを変えると、セクションの構成が変わるため、選定候補は破棄されます(選定済みの商品は残ります)。'}
      </span>
      {TEMPLATE_OPTIONS.map((o) => {
        const selected = o.id === template
        return (
          <div key={o.id} onClick={() => onTemplate(o.id)} className={mergeClasses(s.tplCard, selected && s.tplCardSelected)}>
            <TemplateThumb id={o.id} />
            <div style={{ minWidth: 0 }}>
              <div className={s.flexRowTight}>
                <span className={s.bold}>{o.label}</span>
                {selected && <Badge size="small" appearance="filled" color="brand">選択中</Badge>}
              </div>
              <span className={s.caption}>{TEMPLATE_DESC[o.id]}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ 商品選定タブ(メイン画像 + セクション)

/** mode = hero: メイン画像 / ヘッドライン・コピー。mode = sections: セクション(見出し・コピー・商品) */
function ProductsTab(p: Props & { mode: 'hero' | 'sections' }) {
  const s = useStyles()
  const { template, sectionTitles, products, heroes, items, setItems, candidates, setCandidates, drafts, disabled } = p
  const sections = sectionsOf(template)
  const [sub, setSub] = useState<number | 'hero' | 'copy'>(p.mode === 'hero' ? 'hero' : 0)
  const active: number | 'hero' | 'copy' =
    p.mode === 'hero' ? (sub === 'copy' ? 'copy' : 'hero') : typeof sub === 'number' ? Math.min(sub, sections.length - 1) : 0
  const productById = new Map(products.map((x) => [x.cr854_productid, x]))
  const heroById = new Map(heroes.map((x) => [x.cr854_heroimageid, x]))
  const noTheme = !p.theme.trim()

  /** そのセクションの選定済み商品(最後のセクションは、枠を超えた分も含める) */
  const listOf = (sec: SectionInfo) => {
    const [from, to] = sectionRange(sections, sec, items.length)
    return items.slice(from, to)
  }
  const isFull = (sec: SectionInfo) => Number.isFinite(sec.slots) && listOf(sec).length >= sec.slots

  const moveInSection = (sec: SectionInfo, key: string, delta: number) =>
    setItems((prev) => {
      const [from, to] = sectionRange(sections, sec, prev.length)
      const i = prev.findIndex((x) => x.key === key)
      const j = i + delta
      if (i < 0 || j < from || j >= to) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const demote = (sec: SectionInfo, item: Item) => {
    setItems((prev) => prev.filter((x) => x.key !== item.key))
    setCandidates((prev) => [{ ...item, section: sec.index }, ...prev])
  }

  /** 候補を選定済みへ。枠がいっぱいなら、そのセクションの最後の商品を候補へ下げる */
  const promote = (sec: SectionInfo, cand: Candidate) => {
    const list = listOf(sec)
    const full = isFull(sec)
    let nextItems = [...items]
    let nextCands = candidates.filter((c) => c.key !== cand.key)
    if (full) {
      const last = list[list.length - 1]
      nextItems = nextItems.filter((x) => x.key !== last.key)
      nextCands = [{ ...last, section: sec.index }, ...nextCands]
    }
    const insertAt = sec.start + (full ? sec.slots - 1 : list.length)
    nextItems.splice(insertAt, 0, { key: cand.key, rowId: cand.rowId, productId: cand.productId, reason: cand.reason, source: cand.source })
    setItems(nextItems)
    setCandidates(nextCands)
  }

  const addManual = (sec: SectionInfo, productId: string) => {
    if (items.some((x) => x.productId === productId)) return
    const existing = candidates.find((c) => c.productId === productId)
    promote(sec, existing ?? { key: crypto.randomUUID(), productId, reason: '', source: SOURCE_MANUAL, section: sec.index })
  }

  // ---- ドラッグ&ドロップ
  const [dropKey, setDropKey] = useState<string | null>(null)
  const startDrag = (kind: 'item' | 'cand', key: string, productId: string) => (e: React.DragEvent) => {
    if (kind === 'item') e.dataTransfer.setData(DND_ITEM, key)
    else {
      e.dataTransfer.setData(DND_CAND, key)
      e.dataTransfer.setData(DND_PRODUCT, productId) // 右のプレビューへも落とせる
    }
    e.dataTransfer.effectAllowed = 'move'
  }
  const overTarget = (id: string) => (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropKey(id)
  }
  const leaveTarget = (id: string) => () => setDropKey((k) => (k === id ? null : k))

  /** 候補(または商品一覧の商品)を、選定済みの target と入れ替える */
  const swapIn = (sec: SectionInfo, target: Item, incoming: Candidate) => {
    setItems((prev) => prev.map((x) => (x.key === target.key ? { key: incoming.key, rowId: incoming.rowId, productId: incoming.productId, reason: incoming.reason, source: incoming.source } : x)))
    setCandidates((prev) => [{ ...target, section: sec.index }, ...prev.filter((c) => c.key !== incoming.key)])
  }

  /** 選定済みの行へのドロップ: 選定済みどうしは並べ替え、候補・商品一覧からは入れ替え */
  const dropOnSelected = (sec: SectionInfo, target: Item, dt: DataTransfer) => {
    const itemKey = dt.getData(DND_ITEM)
    const candKey = dt.getData(DND_CAND)
    const productId = dt.getData(DND_PRODUCT)
    if (itemKey) {
      if (itemKey === target.key) return
      setItems((prev) => {
        const [from, to] = sectionRange(sections, sec, prev.length)
        const a = prev.findIndex((x) => x.key === itemKey)
        const b = prev.findIndex((x) => x.key === target.key)
        if (a < from || a >= to || b < from || b >= to) return prev
        const next = [...prev]
        const [moved] = next.splice(a, 1)
        next.splice(b, 0, moved)
        return next
      })
    } else if (candKey) {
      const c = candidates.find((x) => x.key === candKey)
      if (c) swapIn(sec, target, c)
    } else if (productId && !items.some((x) => x.productId === productId)) {
      const c = candidates.find((x) => x.productId === productId) ?? { key: crypto.randomUUID(), productId, reason: '', source: SOURCE_MANUAL, section: sec.index }
      swapIn(sec, target, c)
    }
  }

  /** 選定済みリストの空きへのドロップ(枠に余裕があるときだけ、候補・商品一覧から追加) */
  const dropOnSelectedArea = (sec: SectionInfo, dt: DataTransfer) => {
    if (isFull(sec)) return
    const candKey = dt.getData(DND_CAND)
    const productId = dt.getData(DND_PRODUCT)
    const c = candKey ? candidates.find((x) => x.key === candKey) : undefined
    if (c) promote(sec, c)
    else if (productId) addManual(sec, productId)
  }

  /** 候補の領域へのドロップ: 選定済みの商品を、候補へ戻す */
  const dropOnCandidates = (sec: SectionInfo, dt: DataTransfer) => {
    const itemKey = dt.getData(DND_ITEM)
    const it = itemKey ? items.find((x) => x.key === itemKey) : undefined
    if (it && listOf(sec).some((x) => x.key === it.key)) demote(sec, it)
  }

  const setItemReason = (key: string, reason: string) => setItems((prev) => prev.map((x) => (x.key === key ? { ...x, reason } : x)))
  const setCandReason = (key: string, reason: string) => setCandidates((prev) => prev.map((x) => (x.key === key ? { ...x, reason } : x)))

  // ---- AI の選定結果は、そのまま設定する。直前の状態は「元に戻す」で復元できる
  const [undo, setUndo] = useState<{ label: string; run: () => void } | null>(null)

  const toItems = (rows: { productId: string; reason: string }[]): Item[] =>
    rows.map((r) => ({ key: crypto.randomUUID(), productId: r.productId, reason: r.reason, source: SOURCE_AI }))

  // 見出しを変えたら、コピー・商品の作り直しをゆるやかに促す(自動では作り直さない)
  const [hint, setHint] = useState<string | null>(null)
  const changeTitle = (sec: SectionInfo, title: string) => {
    p.onSectionTitle(sec.index, title)
    if ((p.sectionCopies[sec.index] ?? '') || listOf(sec).length > 0) setHint('見出しを変更しました。必要なら、② コピー・③ 商品を作り直してください。')
  }

  const sectionLabel = (sec: SectionInfo) => (sec.wantTitle ? sectionTitles[sec.index] || sec.label : sec.label)

  /** セクション 1 つを一括で(見出し・コピー・商品を、それぞれ第 1 候補で設定する) */
  const selectSection = async (sec: SectionInfo) => {
    const prevItems = items
    const prevCands = candidates
    const prevTitle = sectionTitles[sec.index] ?? ''
    const prevCopy = p.sectionCopies[sec.index] ?? ''
    const result = await drafts.runSection(sec.index)
    if (!result) return
    const [from, to] = sectionRange(sections, sec, prevItems.length)
    setItems([...prevItems.slice(0, from), ...toItems(result.selected), ...prevItems.slice(to)])
    setCandidates([...prevCands.filter((c) => c.section !== sec.index), ...toItems(result.candidates).map((c) => ({ ...c, section: sec.index }))])
    if (sec.wantTitle && result.title.trim()) p.onSectionTitle(sec.index, result.title.trim())
    if (result.copy.trim()) p.onSectionCopy(sec.index, result.copy.trim())
    setHint(null)
    setUndo({
      label: `${sectionLabel(sec)}の選定`,
      run: () => {
        setItems(prevItems)
        setCandidates(prevCands)
        if (sec.wantTitle) p.onSectionTitle(sec.index, prevTitle)
        p.onSectionCopy(sec.index, prevCopy)
      },
    })
  }

  /** 見出しだけ作り直す(第 1 候補を設定) */
  const selectTitles = async (sec: SectionInfo) => {
    const prevTitle = sectionTitles[sec.index] ?? ''
    const titles = await drafts.runSectionTitles(sec.index)
    if (!titles?.[0]) return
    changeTitle(sec, titles[0].title)
    setUndo({ label: `${sectionLabel(sec)}の見出しの作り直し`, run: () => p.onSectionTitle(sec.index, prevTitle) })
  }

  /** コピーだけ作り直す(第 1 候補を設定。現在の見出しと、選ばれた商品を踏まえる) */
  const selectCopies = async (sec: SectionInfo) => {
    const prevCopy = p.sectionCopies[sec.index] ?? ''
    const copies = await drafts.runSectionCopies(sec.index)
    if (!copies?.[0]) return
    p.onSectionCopy(sec.index, copies[0].copy)
    setUndo({ label: `${sectionLabel(sec)}のコピーの作り直し`, run: () => p.onSectionCopy(sec.index, prevCopy) })
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
      label: `${sectionLabel(sec)}の商品の選び直し`,
      run: () => {
        setItems(prevItems)
        setCandidates(prevCands)
      },
    })
  }

  const selectHero = async () => {
    const prev = { id: p.heroId, reason: p.heroReason, cands: p.heroCandidates }
    const result = await drafts.runHero()
    if (!result) return
    if (result.hero) {
      p.setHeroId(result.hero.heroId)
      p.setHeroReason(result.hero.reason)
    }
    p.setHeroCandidates(result.candidates)
    setUndo({
      label: 'メイン画像の選定',
      run: () => {
        p.setHeroId(prev.id)
        p.setHeroReason(prev.reason)
        p.setHeroCandidates(prev.cands)
      },
    })
  }

  const undoAlert = undo && (
    <MessageBar layout="multiline" intent="success">
      <MessageBarBody>AIが{undo.label}をしました(直す場合は、ドラッグ&ドロップで入れ替えられます)</MessageBarBody>
      <MessageBarActions
        containerAction={<Button appearance="transparent" size="small" aria-label="閉じる" icon={<DismissRegular />} onClick={() => setUndo(null)} />}
      >
        <Button
          size="small"
          onClick={() => {
            undo.run()
            setUndo(null)
          }}
        >
          元に戻す
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
      {p.mode === 'hero' && <Tab value="hero" onClick={revealTab}>{`${p.heroId ? '✓ ' : ''}メイン画像`}</Tab>}
      {p.mode === 'hero' && <Tab value="copy" onClick={revealTab}>{`${p.headline || p.copy ? '✓ ' : ''}${drafts.copyIdeas.length ? '● ' : ''}ヘッドライン・コピー`}</Tab>}
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
          このセクションをまとめてAIで選定
        </AiButton>
        {noTheme && <span className={s.warn}>先にテーマを決めてください</span>}
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
              containerAction={<Button appearance="transparent" size="small" aria-label="閉じる" icon={<DismissRegular />} onClick={() => setHint(null)} />}
            />
          </MessageBar>
        )}

        {sec.wantTitle && (
          <Block
            title="① 見出し(切り口)"
            right={
              <AiButton busy={busyTitle} disabled={noTheme || disabled || anyBusy} onClick={() => selectTitles(sec)}>
                {titles.length ? '作り直す' : 'AIで作る'}
              </AiButton>
            }
          >
            <span className={s.value}>{currentTitle || '(未設定)'}</span>
            {titles.map((t) => {
              const current = currentTitle === t.title
              return (
                <div key={t.title} onClick={() => changeTitle(sec, t.title)} className={mergeClasses(s.pick, current && s.pickCurrent)}>
                  <div className={s.flexRowTight}>
                    <span className={s.semibold}>{t.title}</span>
                    {current && <Badge size="small" appearance="filled" color="brand">設定中</Badge>}
                  </div>
                  <span className={s.caption}>{t.reason}</span>
                </div>
              )
            })}
            {titles.length > 0 && <span className={s.caption}>クリックで差し替えます。書き換えは、プレビューの見出しから。</span>}
          </Block>
        )}

        <Block
          title={`${sec.wantTitle ? '② ' : '① '}コピー`}
          right={
            <>
              <AiButton busy={busyCopy} disabled={noTheme || disabled || anyBusy} onClick={() => selectCopies(sec)}>
                {copies.length ? '作り直す' : 'AIで作る'}
              </AiButton>
              <LanguageToggle value={p.language} onChange={p.onLanguage} />
            </>
          }
        >
          <Field label="セクションのコピー(見出しの下に入ります)" size="small">
            <AutoTextarea rows={2} size="small" value={currentCopy} onChange={(_, d) => p.onSectionCopy(i, d.value)} />
          </Field>
          {copies.map((c) => {
            const current = currentCopy === c.copy
            return (
              <div key={c.copy} onClick={() => p.onSectionCopy(i, c.copy)} className={mergeClasses(s.pick, current && s.pickCurrent)}>
                <div className={s.flexRowTight}>
                  {c.angle && <Badge size="small" appearance="tint" color="informative">{c.angle}</Badge>}
                  {current && <Badge size="small" appearance="filled" color="brand">設定中</Badge>}
                </div>
                <span style={{ fontSize: tokens.fontSizeBase300 }}>{c.copy}</span>
              </div>
            )
          })}
          {copies.length > 0 && <span className={s.caption}>クリックで差し替えます。商品を選んだあとに「作り直す」と、商品を踏まえたコピーになります。</span>}
        </Block>

        <Block
          title={`${sec.wantTitle ? '③ ' : '② '}商品`}
          right={
            <AiButton busy={busyProducts} disabled={noTheme || disabled || anyBusy} onClick={() => selectProducts(sec)}>
              {list.length ? '選び直す' : 'AIで選ぶ'}
            </AiButton>
          }
        >
          <span className={s.semibold} style={{ fontSize: tokens.fontSizeBase200 }}>
            選定済み({list.length}{Number.isFinite(sec.slots) ? ` / ${sec.slots}` : ''}件)
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
            {list.length === 0 && <span className={s.caption}>まだ選定されていません。「AIで案出し」か、下の候補・一覧から選んでください(ドラッグでも追加できます)。</span>}
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
                  badge={outside ? '枠外' : undefined}
                  actions={
                    <>
                      <div>
                        <Button appearance="subtle" size="small" icon={<ArrowUpRegular />} disabled={k === 0} onClick={() => moveInSection(sec, it.key, -1)} aria-label="上へ" />
                        <Button appearance="subtle" size="small" icon={<ArrowDownRegular />} disabled={k === list.length - 1} onClick={() => moveInSection(sec, it.key, 1)} aria-label="下へ" />
                      </div>
                      <Button appearance="subtle" size="small" onClick={() => demote(sec, it)}>外す</Button>
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
            <Divider alignContent="start"><span className={s.caption}>残りの候補({cands.length}件)</span></Divider>
            {cands.length === 0 && <span className={s.caption}>候補はありません(選定済みの行をここへドラッグすると、候補へ戻せます)。</span>}
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
                  actions={<Button size="small" appearance="outline" onClick={() => promote(sec, c)}>選ぶ</Button>}
                />
              )
            })}
          </div>
          {finder('すべての商品から探す', <Candidates products={products} usedIds={usedIds} onAdd={(id) => addManual(sec, id)} />)}
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
          メイン画像をAIで選定
        </AiButton>
        {noTheme && <span className={s.warn}>先にテーマを決めてください</span>}
      </div>
    )

    const current = heroById.get(p.heroId ?? '')
    return (
      <div className={s.grid8}>
        {header}
        {undoAlert}
        <span className={s.semibold} style={{ fontSize: tokens.fontSizeBase200 }}>選定済み(メイン画像)</span>
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
                外す
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
            <span className={s.caption}>まだ選定されていません。「AIで案出し」か、下の候補・一覧から選んでください(ドラッグでも設定できます)。</span>
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
          <Divider alignContent="start"><span className={s.caption}>残りの候補({p.heroCandidates.length}件)</span></Divider>
          {p.heroCandidates.length === 0 && <span className={s.caption}>候補はありません(候補は、AIが案を出したときだけ表示されます。保存はされません。選定中の画像をここへドラッグすると、候補へ戻せます)。</span>}
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
                actions={<Button size="small" appearance="outline" onClick={() => setHero(c.heroId, c.reason)}>選ぶ</Button>}
              />
            )
          })}
        </div>
        {finder('すべての画像から探す', <HeroCandidates heroes={heroes} selectedId={p.heroId} onSelect={(id) => setHero(id, '')} />)}
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
      blocked={noTheme ? '先にテーマを決めてください' : undefined}
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

export function ContentPane(props: Props) {
  const s = useStyles()
  const { theme, headline, instructions, onField, drafts, template, onTemplate, candidates } = props
  const [tab, setTab] = useState<TopTab>('theme')
  const pr = progressOf({ theme, template, heroId: props.heroId, headline, items: props.items, instructions })

  const mark = (filled: boolean, hasIdeas: boolean) => `${filled ? '✓ ' : ''}${hasIdeas ? '● ' : ''}`
  const needTheme = theme.trim() ? undefined : '先にテーマを決めてください'

  return (
    <div className={s.grid12}>
      <Text weight="semibold" size={300}>コンテンツ生成</Text>
      <TabList size="small" className={s.tabs} selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TopTab)}>
        <Tab value="theme" onClick={revealTab}>{`${mark(pr.theme, drafts.themeIdeas.length > 0)}① テーマ`}</Tab>
        <Tab value="template" onClick={revealTab}>{`${mark(pr.template, false)}② テンプレート`}</Tab>
        <Tab value="hero" onClick={revealTab}>{`${mark(pr.hero, drafts.copyIdeas.length > 0)}③ ヒーロー`}</Tab>
        <Tab value="sections" onClick={revealTab}>{`${mark(pr.sections, false)}④ セクション`}</Tab>
        <Tab value="instructions" onClick={revealTab}>{`${mark(pr.instructions, drafts.instructionIdeas.length > 0)}⑤ 制作指示`}</Tab>
      </TabList>

      {tab === 'theme' && (
        <IdeaTab
          label="テーマ(配信全体の前提。メールには出ません)"
          value={theme}
          onChange={(v) => {
            onField('theme', v)
            onField('themeReason', '')
          }}
          ideas={drafts.themeIdeas.map((t) => ({ text: t.theme, note: t.reason }))}
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
      {tab === 'hero' && <ProductsTab {...props} mode="hero" />}
      {tab === 'sections' && <ProductsTab {...props} mode="sections" />}
      {tab === 'instructions' && (
        <IdeaTab
          label="制作指示"
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
  )
}
