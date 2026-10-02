import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import DragIndicatorIcon from '@mui/icons-material/DragIndicator'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
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
type Field = 'theme' | 'headline' | 'copy' | 'instructions'

interface Props {
  theme: string
  headline: string
  copy: string
  instructions: string
  onField: (key: Field, value: string) => void
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

// ------------------------------------------------------------------ 共通の部品

/** クリックしたタブを中央へ寄せる(端のタブを選んでも、次のタブが見えて、続けて選べる) */
const revealTab = (e: React.MouseEvent<HTMLElement>) => {
  const el = e.currentTarget
  requestAnimationFrame(() => el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }))
}


function AiButton({ busy, disabled, onClick, children }: { busy: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="outlined"
      onClick={onClick}
      disabled={busy || disabled}
      startIcon={busy ? <CircularProgress size={14} /> : <AutoAwesomeIcon fontSize="small" />}
    >
      {busy ? '考え中...' : children}
    </Button>
  )
}

/** 理由の表示。2 行で省略し、クリックすると全文を編集できる(onChange なしなら読み取り専用) */
function ReasonText({ value, onChange }: { value: string; onChange?: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  if (onChange && editing) {
    return (
      <TextField
        autoFocus
        fullWidth
        multiline
        size="small"
        label="選定理由"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
      />
    )
  }
  return (
    <Typography
      variant="caption"
      color={value ? 'text.secondary' : 'text.disabled'}
      onClick={onChange ? () => setEditing(true) : undefined}
      title={onChange ? 'クリックして編集' : undefined}
      sx={{
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        cursor: onChange ? 'text' : 'default',
        '&:hover': onChange ? { bgcolor: 'action.hover' } : undefined,
      }}
    >
      {value || (onChange ? '(理由を入力)' : '(理由なし)')}
    </Typography>
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
  return (
    <Box
      {...drag}
      sx={{
        display: 'flex',
        gap: 1,
        p: 1,
        border: 2,
        borderColor: highlight ? 'primary.main' : 'divider',
        borderRadius: 2,
        bgcolor: highlight ? 'action.selected' : 'background.paper',
        opacity: dim ? 0.8 : 1,
        cursor: drag?.draggable ? 'grab' : 'default',
      }}
    >
      {drag?.draggable && <DragIndicatorIcon fontSize="small" sx={{ color: 'text.disabled', alignSelf: 'center', ml: -0.5, mr: -0.5 }} />}
      <Avatar variant="rounded" src={image} alt={title} sx={{ width: wide ? 72 : 44, height: wide ? 40 : 44, flexShrink: 0 }} />
      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'grid', gap: 0.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
          <Typography sx={{ fontWeight: 600, fontSize: '0.9rem' }}>{title}</Typography>
          {source !== undefined && <Chip size="small" label={source === SOURCE_AI ? 'AI' : '手動'} color={source === SOURCE_AI ? 'secondary' : 'default'} />}
          {badge && <Chip size="small" label={badge} color="warning" />}
        </Box>
        <Typography variant="caption" color="text.secondary" noWrap>{meta}</Typography>
        <ReasonText value={reason} onChange={onReason} />
      </Box>
      {actions && <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', justifyContent: 'center', flexShrink: 0 }}>{actions}</Box>}
    </Box>
  )
}

const productMeta = (p?: Cr854_products) =>
  p ? `${p.cr854_productcode} ・ ${yen(p.cr854_price)} ・ 在庫${p.cr854_stock ?? '-'} ・ ${p.cr854_salestrendname ?? ''} ・ ★${p.cr854_rating ?? '-'}` : ''

const heroMeta = (h?: Cr854_heroimages) => (h ? `${h.cr854_imagecode} ・ ${h.cr854_purposename ?? ''} ・ ${h.cr854_seasonname ?? ''} ・ ${h.cr854_tags ?? ''}` : '')

/** コピー・ヘッドラインの言語の切り替え(auto は、配信の国に合わせる) */
function LanguageToggle({ value, onChange }: { value: CopyLanguage; onChange: (v: CopyLanguage) => void }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Typography variant="caption" color="text.secondary">言語</Typography>
      <ToggleButtonGroup size="small" exclusive value={value} onChange={(_, v) => v && onChange(v)} aria-label="コピーの言語">
        <ToggleButton value="auto">国に合わせる</ToggleButton>
        <ToggleButton value="ja">日本語</ToggleButton>
        <ToggleButton value="en">English</ToggleButton>
      </ToggleButtonGroup>
    </Box>
  )
}

/** セクションの中の 1 つのブロック(見出し / コピー / 商品)。右上に、そのブロックの AI ボタンなどを置く */
function Block({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gap: 1, p: 1.25, border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
        <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{title}</Typography>
        {right}
      </Box>
      {children}
    </Box>
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
  busy: boolean
  blocked?: string
  onGenerate: () => void
}) {
  const { label, value, onChange, ideas, busy, blocked, onGenerate } = props
  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <AiButton busy={busy} disabled={!!blocked} onClick={onGenerate}>
          {ideas.length ? '案を作り直す' : 'AIで案を出す'}
        </AiButton>
        {blocked && <Typography variant="caption" color="warning.main">{blocked}</Typography>}
      </Box>
      <TextField fullWidth multiline minRows={2} label={`現在の${label}(採用中)`} value={value} onChange={(e) => onChange(e.target.value)} />
      {ideas.length > 0 && (
        <Typography variant="caption" color="text.secondary">AIの案(未採用): 「採用」を押すと、上の内容に反映されます</Typography>
      )}
      {ideas.map((idea) => {
        const adopted = idea.text === value
        return (
          <Box key={idea.text} sx={{ p: 1.25, border: 1, borderColor: adopted ? 'success.main' : 'divider', borderRadius: 2, bgcolor: 'background.paper', display: 'grid', gap: 0.5 }}>
            {idea.chip && <Chip size="small" label={idea.chip} sx={{ justifySelf: 'start' }} />}
            <Typography sx={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>{idea.text}</Typography>
            {idea.note && <Typography variant="caption" color="text.secondary">{idea.note}</Typography>}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              {adopted ? <Chip size="small" label="採用中" color="success" /> : <Button variant="contained" onClick={() => onChange(idea.text)}>採用</Button>}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

// ------------------------------------------------------------------ ヘッドライン + コピー: 案 → 採用

function CopyTab(props: {
  headline: string
  lead: string
  onHeadline: (v: string) => void
  onLead: (v: string) => void
  ideas: { headline: string; lead: string; angle: string }[]
  busy: boolean
  blocked?: string
  language: CopyLanguage
  onLanguage: (v: CopyLanguage) => void
  onGenerate: () => void
}) {
  const { headline, lead, onHeadline, onLead, ideas, busy, blocked, language, onLanguage, onGenerate } = props
  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <AiButton busy={busy} disabled={!!blocked} onClick={onGenerate}>
          {ideas.length ? '案を作り直す' : 'AIで案を出す'}
        </AiButton>
        {blocked && <Typography variant="caption" color="warning.main">{blocked}</Typography>}
        <LanguageToggle value={language} onChange={onLanguage} />
      </Box>
      <TextField fullWidth multiline label="現在のヘッドライン(採用中。メイン画像に載ります)" value={headline} onChange={(e) => onHeadline(e.target.value)} />
      <TextField fullWidth multiline minRows={2} label="現在のコピー(採用中。ヘッドラインの下に入ります)" value={lead} onChange={(e) => onLead(e.target.value)} />
      {ideas.length > 0 && <Typography variant="caption" color="text.secondary">AIの案(未採用): 「採用」を押すと、ヘッドラインとコピーの両方が反映されます</Typography>}
      {ideas.map((idea) => {
        const adopted = idea.headline === headline && idea.lead === lead
        return (
          <Box key={`${idea.headline}|${idea.lead}`} sx={{ p: 1.25, border: 1, borderColor: adopted ? 'success.main' : 'divider', borderRadius: 2, bgcolor: 'background.paper', display: 'grid', gap: 0.5 }}>
            {idea.angle && <Chip size="small" label={idea.angle} sx={{ justifySelf: 'start' }} />}
            <Typography sx={{ fontWeight: 500, fontSize: '1.05rem', letterSpacing: '0.04em', lineHeight: 1.5 }}>{idea.headline}</Typography>
            <Typography variant="body2" color="text.secondary">{idea.lead}</Typography>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              {adopted ? (
                <Chip size="small" label="採用中" color="success" />
              ) : (
                <Button
                  variant="contained"
                  onClick={() => {
                    onHeadline(idea.headline)
                    onLead(idea.lead)
                  }}
                >
                  採用
                </Button>
              )}
            </Box>
          </Box>
        )
      })}
    </Box>
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
  const tpl = EMAIL_TEMPLATES[id]
  return (
    <Box sx={{ width: 84, flexShrink: 0, bgcolor: '#fff', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 0.5, display: 'grid', gap: 0.5, alignContent: 'start' }}>
      <Box sx={{ height: 24, bgcolor: HERO_COLOR[tpl.hero] }} />
      <Box sx={{ height: 4, width: '60%', mx: 'auto', bgcolor: '#8a8f98' }} />
      {id === 'free' ? (
        <Typography variant="caption" align="center" sx={{ color: '#888', fontSize: '0.65rem' }}>自由</Typography>
      ) : (
        tpl.sections.map((sec, i) => (
          <Box key={i}>
            {sec.categoryHeading && <Box sx={{ height: 3, width: '45%', mx: 'auto', bgcolor: '#555', mb: 0.5 }} />}
            <Box sx={{ display: 'grid', gridTemplateColumns: sec.kind === 'feature' ? '1fr' : '1fr 1fr', gap: 0.25 }}>
              {Array.from({ length: sec.slots }, (_, k) => (
                <Box key={k} sx={{ height: sec.kind === 'feature' ? 10 : 14, bgcolor: '#e0e0e6' }} />
              ))}
            </Box>
          </Box>
        ))
      )}
    </Box>
  )
}

function TemplateTab({ template, onTemplate, hasCandidates }: { template: EmailTemplateId; onTemplate: (id: EmailTemplateId) => void; hasCandidates: boolean }) {
  return (
    <Box sx={{ display: 'grid', gap: 1.25 }}>
      <Typography variant="caption" color="text.secondary">
        メールの構成を選びます。選んだテンプレートの枠に、商品が順に入ります。
        {hasCandidates && ' テンプレートを変えると、セクションの構成が変わるため、選定候補は破棄されます(選定済みの商品は残ります)。'}
      </Typography>
      {TEMPLATE_OPTIONS.map((o) => {
        const selected = o.id === template
        return (
          <Box
            key={o.id}
            onClick={() => onTemplate(o.id)}
            sx={{
              display: 'flex',
              gap: 1.5,
              p: 1.25,
              cursor: 'pointer',
              border: 2,
              borderColor: selected ? 'primary.main' : 'divider',
              borderRadius: 2,
              bgcolor: 'background.paper',
              '&:hover': { borderColor: 'primary.main' },
            }}
          >
            <TemplateThumb id={o.id} />
            <Box sx={{ minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                <Typography sx={{ fontWeight: 700, fontSize: '0.9rem' }}>{o.label}</Typography>
                {selected && <Chip size="small" label="選択中" color="primary" />}
              </Box>
              <Typography variant="caption" color="text.secondary">{TEMPLATE_DESC[o.id]}</Typography>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

// ------------------------------------------------------------------ 商品選定タブ(メイン画像 + セクション)

/** mode = hero: メイン画像 / ヘッドライン・コピー。mode = sections: セクション(見出し・コピー・商品) */
function ProductsTab(p: Props & { mode: 'hero' | 'sections' }) {
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
    <Alert
      severity="success"
      onClose={() => setUndo(null)}
      action={
        <Button
          color="inherit"
          size="small"
          onClick={() => {
            undo.run()
            setUndo(null)
          }}
        >
          元に戻す
        </Button>
      }
    >
      AIが{undo.label}をしました(直す場合は、ドラッグ&ドロップで入れ替えられます)
    </Alert>
  )

  // ---- 下段のタブ(ヒーロー: メイン画像 / ヘッドライン・コピー、セクション: 各セクション)
  const subTabs = (
    <Tabs value={active} onChange={(_, v) => { setSub(v); setUndo(null) }} variant="scrollable" scrollButtons="auto" sx={{ minHeight: 36, minWidth: 0, maxWidth: '100%' }}>
      {p.mode === 'hero' && <Tab value="hero" onClick={revealTab} sx={{ minHeight: 36, minWidth: 0, px: 1.25 }} label={`${p.heroId ? '✓ ' : ''}メイン画像`} />}
      {p.mode === 'hero' && <Tab value="copy" onClick={revealTab} sx={{ minHeight: 36, minWidth: 0, px: 1.25 }} label={`${p.headline || p.copy ? '✓ ' : ''}${drafts.copyIdeas.length ? '● ' : ''}ヘッドライン・コピー`} />}
      {p.mode === 'sections' &&
        sections.map((sec) => {
          const title = sec.wantTitle ? sectionTitles[sec.index] || sec.label : sec.label
          const n = listOf(sec).length
          const count = Number.isFinite(sec.slots) ? `${n}/${sec.slots}` : `${n}`
          return <Tab key={sec.index} value={sec.index} onClick={revealTab} sx={{ minHeight: 36, minWidth: 0, px: 1.25 }} label={`${title}(${count})`} />
        })}
    </Tabs>
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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <AiButton busy={busyAll} disabled={noTheme || disabled || anyBusy} onClick={() => selectSection(sec)}>
          このセクションをまとめてAIで選定
        </AiButton>
        {noTheme && <Typography variant="caption" color="warning.main">先にテーマを決めてください</Typography>}
      </Box>
    )

    return (
      <Box sx={{ display: 'grid', gap: 1.25 }}>
        {header}
        {undoAlert}
        {hint && <Alert severity="info" onClose={() => setHint(null)}>{hint}</Alert>}

        {sec.wantTitle && (
          <Block
            title="① 見出し(切り口)"
            right={
              <AiButton busy={busyTitle} disabled={noTheme || disabled || anyBusy} onClick={() => selectTitles(sec)}>
                {titles.length ? '作り直す' : 'AIで作る'}
              </AiButton>
            }
          >
            <Typography sx={{ fontWeight: 700 }}>{currentTitle || '(未設定)'}</Typography>
            {titles.map((t) => {
              const current = currentTitle === t.title
              return (
                <Box
                  key={t.title}
                  onClick={() => changeTitle(sec, t.title)}
                  sx={{ cursor: 'pointer', px: 1, py: 0.5, border: 1, borderRadius: 1.5, borderColor: current ? 'primary.main' : 'divider', bgcolor: current ? 'action.selected' : 'background.paper' }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Typography sx={{ fontWeight: 600, fontSize: '0.9rem' }}>{t.title}</Typography>
                    {current && <Chip size="small" label="設定中" color="primary" />}
                  </Box>
                  <Typography variant="caption" color="text.secondary">{t.reason}</Typography>
                </Box>
              )
            })}
            {titles.length > 0 && <Typography variant="caption" color="text.secondary">クリックで差し替えます。書き換えは、プレビューの見出しから。</Typography>}
          </Block>
        )}

        <Block
          title={`${sec.wantTitle ? '② ' : '① '}コピー`}
          right={
            <AiButton busy={busyCopy} disabled={noTheme || disabled || anyBusy} onClick={() => selectCopies(sec)}>
              {copies.length ? '作り直す' : 'AIで作る'}
            </AiButton>
          }
        >
          <LanguageToggle value={p.language} onChange={p.onLanguage} />
          <TextField
            size="small"
            fullWidth
            multiline
            label="セクションのコピー(見出しの下に入ります)"
            value={currentCopy}
            onChange={(e) => p.onSectionCopy(i, e.target.value)}
          />
          {copies.map((c) => {
            const current = currentCopy === c.copy
            return (
              <Box
                key={c.copy}
                onClick={() => p.onSectionCopy(i, c.copy)}
                sx={{ cursor: 'pointer', px: 1, py: 0.5, border: 1, borderRadius: 1.5, borderColor: current ? 'primary.main' : 'divider', bgcolor: current ? 'action.selected' : 'background.paper' }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                  {c.angle && <Chip size="small" label={c.angle} />}
                  {current && <Chip size="small" label="設定中" color="primary" />}
                </Box>
                <Typography sx={{ fontSize: '0.9rem' }}>{c.copy}</Typography>
              </Box>
            )
          })}
          {copies.length > 0 && <Typography variant="caption" color="text.secondary">クリックで差し替えます。商品を選んだあとに「作り直す」と、商品を踏まえたコピーになります。</Typography>}
        </Block>

        <Block
          title={`${sec.wantTitle ? '③ ' : '② '}商品`}
          right={
            <AiButton busy={busyProducts} disabled={noTheme || disabled || anyBusy} onClick={() => selectProducts(sec)}>
              {list.length ? '選び直す' : 'AIで選ぶ'}
            </AiButton>
          }
        >
        <Typography variant="caption" sx={{ fontWeight: 700 }}>
          選定済み({list.length}{Number.isFinite(sec.slots) ? ` / ${sec.slots}` : ''}件)
        </Typography>
        <Box
          onDragOver={overTarget('sel')}
          onDragLeave={leaveTarget('sel')}
          onDrop={(e) => {
            e.preventDefault()
            setDropKey(null)
            dropOnSelectedArea(sec, e.dataTransfer)
          }}
          sx={{ display: 'grid', gap: 1, borderRadius: 2, outline: dropKey === 'sel' && !isFull(sec) ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: 2 }}
        >
        {list.length === 0 && <Typography variant="caption" color="text.secondary">まだ選定されていません。「AIで案出し」か、下の候補・一覧から選んでください(ドラッグでも追加できます)。</Typography>}
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
                  <Box>
                    <IconButton size="small" disabled={k === 0} onClick={() => moveInSection(sec, it.key, -1)} aria-label="上へ"><ArrowUpwardIcon fontSize="small" /></IconButton>
                    <IconButton size="small" disabled={k === list.length - 1} onClick={() => moveInSection(sec, it.key, 1)} aria-label="下へ"><ArrowDownwardIcon fontSize="small" /></IconButton>
                  </Box>
                  <Button size="small" onClick={() => demote(sec, it)}>外す</Button>
                </>
              }
            />
          )
        })}
        </Box>
        <Box
          onDragOver={overTarget('cands')}
          onDragLeave={leaveTarget('cands')}
          onDrop={(e) => {
            e.preventDefault()
            setDropKey(null)
            dropOnCandidates(sec, e.dataTransfer)
          }}
          sx={{ display: 'grid', gap: 1, borderRadius: 2, outline: dropKey === 'cands' ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: 2 }}
        >
        <Divider textAlign="left"><Typography variant="caption">残りの候補({cands.length}件)</Typography></Divider>
        {cands.length === 0 && <Typography variant="caption" color="text.secondary">候補はありません(選定済みの行をここへドラッグすると、候補へ戻せます)。</Typography>}
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
              actions={<Button size="small" variant="outlined" onClick={() => promote(sec, c)}>選ぶ</Button>}
            />
          )
        })}
        </Box>
        <Accordion disableGutters variant="outlined" sx={{ mt: 1, minWidth: 0 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="body2">すべての商品から探す</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 1.25, minWidth: 0 }}>
            <Candidates products={products} usedIds={usedIds} onAdd={(id) => addManual(sec, id)} />
          </AccordionDetails>
        </Accordion>
        </Block>
      </Box>
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
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <AiButton busy={busy} disabled={noTheme || disabled} onClick={selectHero}>
          メイン画像をAIで選定
        </AiButton>
        {noTheme && <Typography variant="caption" color="warning.main">先にテーマを決めてください</Typography>}
      </Box>
    )

    const current = heroById.get(p.heroId ?? '')
    return (
      <Box sx={{ display: 'grid', gap: 1 }}>
        {header}
        {undoAlert}
        <Typography variant="caption" sx={{ fontWeight: 700 }}>選定済み(メイン画像)</Typography>
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
          <Box
            onDragOver={overTarget('hero-sel')}
            onDragLeave={leaveTarget('hero-sel')}
            onDrop={dropHero((id) => setHero(id, p.heroCandidates.find((c) => c.heroId === id)?.reason ?? ''))}
            sx={{ p: 1.5, border: 2, borderStyle: 'dashed', borderColor: dropKey === 'hero-sel' ? 'primary.main' : 'divider', borderRadius: 2 }}
          >
            <Typography variant="caption" color="text.secondary">まだ選定されていません。「AIで案出し」か、下の候補・一覧から選んでください(ドラッグでも設定できます)。</Typography>
          </Box>
        )}
        <Box
          onDragOver={overTarget('hero-cands')}
          onDragLeave={leaveTarget('hero-cands')}
          onDrop={dropHero((id) => {
            if (id === p.heroId) demoteHero()
          })}
          sx={{ display: 'grid', gap: 1, borderRadius: 2, outline: dropKey === 'hero-cands' ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: 2 }}
        >
        <Divider textAlign="left"><Typography variant="caption">残りの候補({p.heroCandidates.length}件)</Typography></Divider>
        {p.heroCandidates.length === 0 && <Typography variant="caption" color="text.secondary">候補はありません(候補は、AIが案を出したときだけ表示されます。保存はされません。選定中の画像をここへドラッグすると、候補へ戻せます)。</Typography>}
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
              actions={<Button size="small" variant="outlined" onClick={() => setHero(c.heroId, c.reason)}>選ぶ</Button>}
            />
          )
        })}
        </Box>
        <Accordion disableGutters variant="outlined" sx={{ mt: 1, minWidth: 0 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="body2">すべての画像から探す</Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 1.25, minWidth: 0 }}>
            <HeroCandidates heroes={heroes} selectedId={p.heroId} onSelect={(id) => setHero(id, '')} />
          </AccordionDetails>
        </Accordion>
      </Box>
    )
  }

  // ---- ヘッドライン・コピー(メイン画像の上に載るヘッドラインと、その下のコピー。組で案を出す)
  const copyView = (
    <CopyTab
      headline={p.headline}
      lead={p.copy}
      onHeadline={(v) => p.onField('headline', v)}
      onLead={(v) => p.onField('copy', v)}
      ideas={drafts.copyIdeas}
      busy={!!drafts.busy.copy}
      blocked={noTheme ? '先にテーマを決めてください' : undefined}
      language={p.language}
      onLanguage={p.onLanguage}
      onGenerate={drafts.runCopy}
    />
  )

  return (
    <Box sx={{ display: 'grid', gap: 1.25 }}>
      {subTabs}
      {active === 'hero' ? heroView() : active === 'copy' ? copyView : sectionView(sections[active])}
    </Box>
  )
}

// ------------------------------------------------------------------ 中ペイン全体

export function ContentPane(props: Props) {
  const { theme, headline, instructions, onField, drafts, template, onTemplate, candidates } = props
  const [tab, setTab] = useState<TopTab>('theme')
  const pr = progressOf({ theme, template, heroId: props.heroId, headline, items: props.items, instructions })

  const mark = (filled: boolean, hasIdeas: boolean) => `${filled ? '✓ ' : ''}${hasIdeas ? '● ' : ''}`
  const needTheme = theme.trim() ? undefined : '先にテーマを決めてください'

  return (
    <Box sx={{ display: 'grid', gap: 1.25 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>コンテンツ生成</Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ minHeight: 36, minWidth: 0, maxWidth: '100%' }}>
        <Tab value="theme" onClick={revealTab} sx={{ minHeight: 36, minWidth: 0, px: 1.25 }} label={`${mark(pr.theme, drafts.themeIdeas.length > 0)}① テーマ`} />
        <Tab value="template" onClick={revealTab} sx={{ minHeight: 36, minWidth: 0, px: 1.25 }} label={`${mark(pr.template, false)}② テンプレート`} />
        <Tab value="hero" onClick={revealTab} sx={{ minHeight: 36, minWidth: 0, px: 1.25 }} label={`${mark(pr.hero, drafts.copyIdeas.length > 0)}③ ヒーロー`} />
        <Tab value="sections" onClick={revealTab} sx={{ minHeight: 36, minWidth: 0, px: 1.25 }} label={`${mark(pr.sections, false)}④ セクション`} />
        <Tab value="instructions" onClick={revealTab} sx={{ minHeight: 36, minWidth: 0, px: 1.25 }} label={`${mark(pr.instructions, drafts.instructionIdeas.length > 0)}⑤ 制作指示`} />
      </Tabs>

      {tab === 'theme' && (
        <IdeaTab
          label="テーマ(配信全体の前提。メールには出ません)"
          value={theme}
          onChange={(v) => onField('theme', v)}
          ideas={drafts.themeIdeas.map((t) => ({ text: t.theme, note: t.reason }))}
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
          onChange={(v) => onField('instructions', v)}
          ideas={drafts.instructionIdeas.map((c) => ({ text: c.text, chip: c.angle }))}
          busy={!!drafts.busy.instructions}
          blocked={needTheme}
          onGenerate={drafts.runInstructions}
        />
      )}
    </Box>
  )
}
