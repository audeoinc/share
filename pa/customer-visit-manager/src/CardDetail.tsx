import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Caption1,
  Dialog,
  DialogSurface,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Select,
  Slider,
  Spinner,
  Switch,
  Tab,
  TabList,
  Text,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components'
import { AddRegular, ChevronLeftRegular, ChevronRightRegular, DismissRegular, SaveRegular, SubtractRegular } from '@fluentui/react-icons'
import { optionLabel, tr, useT } from './i18n'
import { AiIcon } from './AiMark'
import { ProductInfoPane } from './ProductInfoPane'
import { cardMarket, heroMarket, productMarket } from './market'
import { AutoTextarea } from './AutoTextarea'
import { Cr854_deliverycardsService } from './generated/services/Cr854_deliverycardsService'
import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { Cr854_deliveryproductsService } from './generated/services/Cr854_deliveryproductsService'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { ContentPane } from './ContentPane'
import { Preview } from './Preview'
import { TEMPLATE_VALUES, sectionIndexAt, sectionsOf, templateFromValue, type EmailTemplateId } from './templates'
import { Splitter } from './Splitter'
import { DND_ITEM, DND_PRODUCT, SOURCE_AI, SOURCE_MANUAL, STATE_CANDIDATE, STATE_SELECTED, type Candidate, type Item } from './items'
import type { AiCard, CopyLanguage, ProposedHero } from './aiSelect'
import { progressOf } from './progress'
import { loadAutoDraft } from './settings'
import { runAutoDraft, type AutoDraftResult } from './autoDraft'
import { useAiDrafts } from './useAiDrafts'
import { channelOptions, countryOptions, departmentOptions, statusColor, statusOptions } from './status'

/** 新規作成のときに、最初から入れておく値(カレンダーで押した日付、絞り込み中の国・チャネル・部署) */
export type NewCardDefaults = Partial<Pick<Form, 'scheduledAt' | 'country' | 'channel' | 'department'>>

interface Props {
  /** undefined のときは新規作成 */
  card?: Cr854_deliverycards
  /** 新規作成のときだけ使う */
  defaults?: NewCardDefaults
  products: Cr854_products[]
  heroes: Cr854_heroimages[]
  /** 他の配信で使われているテーマ(テーマ案の重複回避用) */
  otherThemes: string[]
  onBack: () => void
  onSaved: () => Promise<void>
}

const pad = (n: number) => String(n).padStart(2, '0')
// ISO文字列 → datetime-local の値(ローカル時刻)
const toLocalInput = (v?: string) => {
  if (!v) return ''
  const d = new Date(v)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface Form {
  name: string
  scheduledAt: string
  country: string
  channel: string
  department: string
  status: string
  theme: string
  headline: string
  copy: string
  instructions: string
  /** 採用したAIの案の補足(テーマの理由、コピー・制作指示の切り口)。手で書き換えたら消す */
  themeReason: string
  copyAngle: string
  instructionsAngle: string
}

const str = (v?: number) => (v === undefined ? '' : String(v))

const toForm = (c?: Cr854_deliverycards): Form => ({
  name: c?.cr854_name ?? '',
  scheduledAt: toLocalInput(c?.cr854_scheduledat),
  country: str(c?.cr854_country),
  channel: str(c?.cr854_channel),
  department: str(c?.cr854_department),
  status: c?.cr854_status === undefined ? String(statusOptions[0].value) : String(c.cr854_status),
  theme: c?.cr854_theme ?? '',
  headline: c?.cr854_headline ?? '',
  copy: c?.cr854_copy ?? '',
  instructions: c?.cr854_instructions ?? '',
  themeReason: c?.cr854_themereason ?? '',
  copyAngle: c?.cr854_copyangle ?? '',
  instructionsAngle: c?.cr854_instructionsangle ?? '',
})

function OptionSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: { value: number; label: string }[]
  onChange: (v: string) => void
}) {
  const t = useT()
  return (
    <Field label={label}>
      <Select size="small" value={value} onChange={(_, d) => onChange(d.value)}>
        <option value="">{t('未設定', 'Not set')}</option>
        {options.map((o) => (
          <option key={o.value} value={String(o.value)}>{optionLabel(o.label)}</option>
        ))}
      </Select>
    </Field>
  )
}

const ZOOM_KEY = 'cardDetail.previewZoom'
const ZOOM_MIN = 0.4
const ZOOM_MAX = 1.2

/** プレビューの倍率: 数値(1 = 現在のサイズ)または 'fit'(メール全体を画面の高さに収める) */
function loadZoom(): number | 'fit' {
  try {
    const v = JSON.parse(localStorage.getItem(ZOOM_KEY) ?? 'null')
    if (v === 'fit') return 'fit'
    if (typeof v === 'number' && v >= ZOOM_MIN && v <= ZOOM_MAX) return v
  } catch {
    // 読めなければ既定値を使う
  }
  return 0.7
}

/** 自動下書きを済ませたカード(同じカードを開き直しても、再実行しない) */
const autoDrafted = new Set<string>()

const WIDTH_KEY = 'cardDetail.paneWidths.v5'
const INFO_KEY = 'cardDetail.infoOpen'
const RAIL_W = 32

/** 商品情報ペインを開くか。保存がなければ、折りたたんでおく */
function loadInfoOpen(): boolean {
  try {
    const v = localStorage.getItem(INFO_KEY)
    if (v === 'open') return true
    if (v === 'closed') return false
  } catch {
    // 保存を読めないときは、既定(折りたたみ)にする
  }
  return false // 既定では折りたたむ
}
const MIN_W = 220
const MAX_W = 640
const clamp = (v: number) => Math.min(MAX_W, Math.max(MIN_W, v))

function loadWidths(): [number, number, number] {
  try {
    const v = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? 'null')
    if (Array.isArray(v) && v.length === 3) return [clamp(Number(v[0])), clamp(Number(v[1])), clamp(Number(v[2]))]
  } catch {
    // 保存値が読めなければ既定値を使う
  }
  // 既定値: ダイアログの幅(最大 1800px)に合わせる。左 22%・中 30%・商品情報(右端)19%・プレビューは残り
  const total = Math.min(1800, window.innerWidth * 0.98)
  return [clamp(Math.round(total * 0.22)), clamp(Math.round(total * 0.3)), clamp(Math.round(total * 0.19))]
}

/** 読み込み時点の配信商品の行(保存時の差分判定用) */
interface RowSnap {
  reason: string
  source: number
  state: number
  section: number
  order: number
}

/** 各セクションのコピーは、改行を含みうるので JSON の配列で保存する(古い形式の改行区切りも読む) */
function parseCopies(v?: string): string[] {
  if (!v) return []
  try {
    const a = JSON.parse(v)
    if (Array.isArray(a)) return a.map(String)
  } catch {
    // JSON でなければ、改行区切りとして読む
  }
  return v.split('\n')
}
const encodeCopies = (a: string[]) => (a.some(Boolean) ? JSON.stringify(a) : '')

const useStyles = makeStyles({
  surface: {
    position: 'relative',
    padding: 0,
    overflow: 'hidden',
    maxWidth: 'none',
    width: 'min(1800px, 98vw)',
    height: '92vh',
    maxHeight: '92vh',
    '@media (max-width: 899px)': {
      width: '100vw',
      height: '100vh',
      maxHeight: '100vh',
      borderRadius: 0,
    },
  },
  form: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  overlay: {
    position: 'absolute',
    inset: 0,
    zIndex: 20,
    display: 'grid',
    placeContent: 'center',
    justifyItems: 'center',
    rowGap: '16px',
    paddingLeft: '24px',
    paddingRight: '24px',
    textAlign: 'center',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  overlayBar: { width: '320px' },
  titleRow: { display: 'flex', alignItems: 'center', columnGap: '8px', padding: '12px 12px 12px 24px', backgroundColor: tokens.colorNeutralBackground1 },
  titleText: { flexGrow: 1, minWidth: 0 },
  panes: {
    flexGrow: 1,
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: '1fr',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'auto',
    '@media (min-width: 900px)': {
      gridTemplateColumns: 'var(--w0) 1px var(--w1) 1px minmax(0, 1fr) 1px var(--w2)',
      gridTemplateRows: 'minmax(0, 1fr)',
      overflow: 'hidden',
    },
  },
  pane: {
    padding: '16px',
    overflow: 'auto',
    minHeight: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    rowGap: '12px',
    backgroundColor: tokens.colorNeutralBackground1,
    alignContent: 'start',
  },
  // 中ペインは、余白と、スクロールを内側(ContentPane)に任せる: 上に内容、下にチャットを固定する
  paneMid: { backgroundColor: tokens.colorNeutralBackground1, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  panePreview: { gridTemplateRows: 'auto minmax(0, 1fr)' },
  infoToolbar: { display: 'flex', justifyContent: 'flex-end', marginBottom: '-8px' },
  // 商品情報ペインを閉じたときの、細い帯(押すと開く)
  rail: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    rowGap: '10px',
    paddingTop: '10px',
    minHeight: 0,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  railLabel: { writingMode: 'vertical-rl', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, letterSpacing: '0.1em' },
  caption: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightRegular },
  lead: { fontWeight: tokens.fontWeightSemibold },
  captionTight: { marginTop: '-4px' },
  success: { color: tokens.colorPaletteGreenForeground1 },
  fullWidth: { width: '100%', flexShrink: 0, minHeight: '32px' },
  sectionHead: { marginTop: '12px' },
  twoCol: { display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '12px', rowGap: '12px' },
  statusRow: { display: 'flex', alignItems: 'center', columnGap: '6px' },
  dot: { width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0 },
  grow: { flexGrow: 1 },
  filled: { borderBottomColor: tokens.colorPaletteGreenBorder2 },
  toolbar: { display: 'flex', alignItems: 'center', columnGap: '8px', rowGap: '4px', flexWrap: 'wrap' },
  zoomBox: { display: 'flex', alignItems: 'center', columnGap: '2px' },
  slider: { width: '90px', minWidth: '90px' },
  zoomLabel: { width: '34px', textAlign: 'right' },
  previewBox: { overflow: 'auto', minHeight: 0, paddingTop: '8px', paddingBottom: '8px' },
  error: { margin: '12px 12px 0' },
  actions: { display: 'flex', justifyContent: 'flex-end', columnGap: '8px', padding: '12px 24px' },
})

export function CardDetail({ card, defaults, products, heroes, otherThemes, onBack, onSaved }: Props) {
  const t = useT()
  const styles = useStyles()
  const [form, setForm] = useState<Form>(() => (card ? toForm(card) : { ...toForm(), ...defaults }))
  const [items, setItems] = useState<Item[]>([])
  // 選定候補(配信商品テーブルの「候補」の行。セクションごと)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  // 読み込み時点の配信商品(保存時に差分を取る)。読み込めなかったときは保存で消さないよう null のまま
  const [original, setOriginal] = useState<Map<string, RowSnap> | null>(card ? null : new Map())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [previewTab, setPreviewTab] = useState<'email' | 'push'>(() =>
    card?.cr854_channelname === 'プッシュ' ? 'push' : 'email',
  )
  const [showHeadings, setShowHeadings] = useState(true)
  // プレビューの倍率(40〜120%)。'fit' は、メール全体が画面の高さに収まる倍率に自動で合わせる
  const [zoom, setZoom] = useState<number | 'fit'>(loadZoom)
  const [fitZoom, setFitZoom] = useState(1)
  // 「すべてAIで下書き」の進み具合(実行中だけ、画面全体に「推論中」を出す)
  const [autoEnabled] = useState(loadAutoDraft) // 設定は、画面上部のバーで切り替える
  const [auto, setAuto] = useState<{ label: string; done: number; total: number } | null>(null)
  const cancelRef = useRef(false)
  const aliveRef = useRef(true)
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const previewInnerRef = useRef<HTMLDivElement>(null)
  // コピー・ヘッドラインの言語(AI に渡す。保存はしない)
  const [language, setLanguage] = useState<CopyLanguage>('auto')
  const [template, setTemplate] = useState<EmailTemplateId>(() => card?.cr854_layoutkey || templateFromValue(card?.cr854_emailtemplate))
  // カテゴリ系テンプレートの見出し(セクションの順。保存は 1 行 1 見出し)
  const [sectionTitles, setSectionTitles] = useState<string[]>(() => (card?.cr854_sectiontitles ? card.cr854_sectiontitles.split('\n') : []))
  // 各セクションのコピー(セクションの順)
  const [sectionCopies, setSectionCopies] = useState<string[]>(() => parseCopies(card?.cr854_sectioncopies))
  // メイン画像の候補(AI が案を出したときの分。保存はしない)
  const [heroCandidates, setHeroCandidates] = useState<ProposedHero[]>([])
  const [heroId, setHeroId] = useState<string | undefined>(card?._cr854_heroimage_value)
  const [heroReason, setHeroReason] = useState(card?.cr854_heroreason ?? '')
  const [widths, setWidths] = useState<[number, number, number]>(loadWidths)
  // 商品情報の行にマウスが乗っている商品(プレビューで光らせる)と、商品情報ペインの開閉
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState<boolean>(loadInfoOpen)
  const toggleInfo = () =>
    setInfoOpen((open) => {
      try {
        localStorage.setItem(INFO_KEY, open ? 'closed' : 'open')
      } catch {
        // 保存できなくても動作には影響しない
      }
      return !open
    })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!card) return
    let cancelled = false
    Cr854_deliveryproductsService.getAll({
      filter: `_cr854_deliverycard_value eq ${card.cr854_deliverycardid}`,
      orderBy: ['cr854_sortorder asc'],
    })
      .then((res) => {
        if (cancelled) return
        if (!res.success) throw new Error(res.error?.message ?? tr('掲載商品の取得に失敗しました', 'Failed to load the products in this delivery'))
        const sel: Item[] = []
        const cands: Candidate[] = []
        const snap = new Map<string, RowSnap>()
        for (const r of res.data ?? []) {
          const state = r.cr854_state ?? STATE_SELECTED
          const section = r.cr854_section ?? 0
          const base: Item = {
            key: r.cr854_deliveryproductid,
            rowId: r.cr854_deliveryproductid,
            productId: r._cr854_product_value ?? '',
            reason: r.cr854_reason ?? '',
            source: r.cr854_source ?? SOURCE_MANUAL,
          }
          snap.set(base.rowId!, { reason: base.reason, source: base.source, state, section, order: r.cr854_sortorder ?? 0 })
          if (state === STATE_CANDIDATE) cands.push({ ...base, section })
          else sel.push(base)
        }
        setItems(sel)
        setCandidates(cands)
        setOriginal(snap)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [card])

  // 左ペインで手で書き換えたら、採用した案の補足は消す
  const STALE: Partial<Record<keyof Form, keyof Form>> = { theme: 'themeReason', headline: 'copyAngle', copy: 'copyAngle', instructions: 'instructionsAngle' }
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => {
    const stale = STALE[k]
    setForm({ ...form, [k]: v, ...(stale ? { [stale]: '' } : {}) })
  }
  const num = (v: string) => (v === '' ? undefined : (Number(v) as never))
  const productName = (id: string) => products.find((p) => p.cr854_productid === id)?.cr854_name ?? ''

  const addProduct = (productId: string, at = items.length) => {
    if (items.some((i) => i.productId === productId)) return
    // 候補にあった商品なら、候補から選定へ移す(理由も引き継ぐ)
    const cand = candidates.find((c) => c.productId === productId)
    if (cand) setCandidates(candidates.filter((c) => c.key !== cand.key))
    const it: Item = cand
      ? { key: cand.key, rowId: cand.rowId, productId, reason: cand.reason, source: cand.source }
      : { key: crypto.randomUUID(), productId, reason: '', source: SOURCE_MANUAL }
    setItems([...items.slice(0, at), it, ...items.slice(at)])
    setSelectedKey(it.key)
  }

  // プレビューへのドロップ: 並べ替え(DND_ITEM)か、候補からの追加(DND_PRODUCT)
  const dropAt = (index: number, dt: DataTransfer) => {
    const itemKey = dt.getData(DND_ITEM)
    const productId = dt.getData(DND_PRODUCT)
    if (itemKey) {
      const from = items.findIndex((i) => i.key === itemKey)
      if (from < 0) return
      moveItem(from, Math.min(index, items.length - 1))
    } else if (productId) {
      addProduct(productId, index)
    }
  }

  // from の商品を to の位置へ移す(間の商品は1つずつずれる)
  const moveItem = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return
    const next = [...items]
    const [it] = next.splice(from, 1)
    next.splice(to, 0, it)
    setItems(next)
  }

  // 同じカテゴリの商品を隣り合わせにする(カテゴリの並びは、現在の登場順を保つ)
  const groupByCategory = () => {
    const cat = (i: Item) => products.find((p) => p.cr854_productid === i.productId)?.cr854_categoryname ?? ''
    const order = [...new Set(items.map(cat))]
    setItems([...items].sort((a, b) => order.indexOf(cat(a)) - order.indexOf(cat(b))))
  }

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_KEY, JSON.stringify(zoom))
    } catch {
      // 保存できなくても動作には影響しない
    }
  }, [zoom])

  // 全体表示: 倍率 1 での高さを測り、プレビューの枠に収まる倍率を求める(内容や窓の大きさが変わったら、測り直す)
  useLayoutEffect(() => {
    const box = previewBoxRef.current
    const inner = previewInnerRef.current
    if (zoom !== 'fit' || !box || !inner) return
    const calc = () => {
      inner.style.zoom = '1'
      const h = inner.offsetHeight
      // 高さだけでなく、幅にも収める(ペインを狭めたとき、横にはみ出さないように)
      const w = (inner.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0
      const byHeight = h > 0 ? (box.clientHeight - 16) / h : 1
      const byWidth = w > 0 ? (box.clientWidth - 8) / w : 1
      const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, byHeight, byWidth))
      inner.style.zoom = String(z)
      setFitZoom(z)
    }
    calc()
    const ro = new ResizeObserver(calc)
    ro.observe(box)
    return () => {
      ro.disconnect()
      inner.style.zoom = ''
    }
  }, [zoom, previewTab, template, items, form.headline, form.copy, sectionTitles, sectionCopies, heroId])

  const shownZoom = zoom === 'fit' ? fitZoom : zoom
  const stepZoom = (d: number) => setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round((shownZoom + d) * 20) / 20)))

  const resize = (i: 0 | 1 | 2) => (dx: number) =>
    setWidths((w) => {
      const next: [number, number, number] = [w[0], w[1], w[2]]
      next[i] = clamp(next[i] + dx)
      return next
    })
  const resizeInfo = (dx: number) => setWidths((w) => [w[0], w[1], clamp(w[2] - dx)])
  const saveWidths = () => {
    try {
      localStorage.setItem(WIDTH_KEY, JSON.stringify(widths))
    } catch {
      // 保存できなくても動作には影響しない
    }
  }

  // エージェントに渡す、配信カードの現在の入力内容
  const buildAiCard = (): AiCard => {
    const label = (opts: { value: number; label: string }[], v: string) => opts.find((o) => String(o.value) === v)?.label ?? ''
    return {
      name: form.name,
      scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : '',
      country: label(countryOptions, form.country),
      channel: label(channelOptions, form.channel),
      department: label(departmentOptions, form.department),
      theme: form.theme,
      headline: form.headline,
      copy: form.copy,
      instructions: form.instructions,
    }
  }

  // 商品・メイン画像は、配信カードの国に合う市場のものだけを、選定の対象にする(すでに載せた他の市場の商品は、表示のために残す)
  const market = cardMarket(form.country)
  const poolProducts = useMemo(() => (market ? products.filter((p) => productMarket(p) === market) : products), [products, market])
  const poolHeroes = useMemo(() => (market ? heroes.filter((h) => heroMarket(h) === market) : heroes), [heroes, market])

  // AI の案の状態と生成(案は採用するまで、配信カードには反映しない)
  const drafts = useAiDrafts(
    { buildCard: buildAiCard, products: poolProducts, heroes: poolHeroes, otherThemes, template, items, candidates, sectionTitles, sectionCopies, heroId, heroReason, language },
    setError,
  )

  // ---- すべてAIで下書き(テーマ → テンプレート・メイン画像 → ヘッドライン・コピー → 各セクション → 制作指示)
  const applyAutoResult = (res: AutoDraftResult) => {
    if (res.template) setTemplate(res.template)
    setForm((f) => ({
      ...f,
      theme: res.theme ?? f.theme,
      themeReason: res.theme ? (res.themeIdeas[0]?.reason ?? '') : f.themeReason,
      headline: res.headline ?? f.headline,
      copy: res.copy ?? f.copy,
      copyAngle: res.headline ? (res.copyIdeas[0]?.angle ?? '') : f.copyAngle,
      instructions: res.instructions ?? f.instructions,
      instructionsAngle: res.instructions ? (res.instructionIdeas[0]?.angle ?? '') : f.instructionsAngle,
    }))
    const toItem = (r: { productId: string; reason: string }): Item => ({ key: crypto.randomUUID(), productId: r.productId, reason: r.reason, source: SOURCE_AI })
    if (res.sections.some((sec) => sec.selected.length > 0)) {
      setItems(res.sections.flatMap((sec) => sec.selected.map(toItem)))
      setCandidates(res.sections.flatMap((sec, i) => sec.candidates.map((r) => ({ ...toItem(r), section: i }))))
    }
    if (res.sections.length > 0) {
      setSectionTitles(res.sections.map((sec) => sec.title))
      setSectionCopies(res.sections.map((sec) => sec.copy))
    }
    if (res.hero) {
      if (res.hero.hero) {
        setHeroId(res.hero.hero.heroId)
        setHeroReason(res.hero.hero.reason)
      }
      setHeroCandidates(res.hero.candidates)
    }
    drafts.applyAuto({
      themeIdeas: res.themeIdeas,
      copyIdeas: res.copyIdeas,
      instructionIdeas: res.instructionIdeas,
      titleCandidates: Object.fromEntries(res.sections.map((sec, i) => [i, sec.titles])),
      sectionCopyCandidates: Object.fromEntries(res.sections.map((sec, i) => [i, sec.copies])),
    })
    setSelectedKey(null)
    if (res.errors.length > 0) setError(t(`一部の工程で失敗しました: ${res.errors.join(' / ')}`, `Some steps failed: ${res.errors.join(' / ')}`))
  }

  async function startAutoDraft() {
    if (!form.scheduledAt) {
      setError(t('すべてAIで下書きするには、先に配信日時を入力してください', 'Enter the send date & time first to draft everything with AI'))
      return
    }
    cancelRef.current = false
    setError(null)
    setAuto({ label: t('準備しています', 'Getting ready'), done: 0, total: 7 })
    const res = await runAutoDraft(
      { card: buildAiCard(), language, otherThemes, products: poolProducts, heroes: poolHeroes },
      (label, done, total) => setAuto({ label, done, total }),
      () => cancelRef.current || !aliveRef.current,
    )
    if (!cancelRef.current && aliveRef.current) applyAutoResult(res)
    setAuto(null)
  }

  const hasContent = !!(form.theme.trim() || form.headline.trim() || form.copy.trim() || form.instructions.trim() || items.length > 0 || heroId)

  function runAllManual() {
    if (hasContent && !window.confirm(t('現在のテーマ・ヘッドライン・コピー・商品・メイン画像・制作指示を、AIの下書きで置き換えます。よろしいですか?', 'This replaces the current theme, headline, copy, products, hero image, and production notes with an AI draft. Continue?'))) return
    void startAutoDraft()
  }

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // 内容が空の既存のカードを開いたときは、自動で下書きを作る(同じカードで、1 回だけ)
  useEffect(() => {
    if (!card || !autoEnabled || original === null) return
    if (products.length === 0 || heroes.length === 0) return
    if (autoDrafted.has(card.cr854_deliverycardid)) return
    autoDrafted.add(card.cr854_deliverycardid)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!hasContent) void startAutoDraft()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, original, products.length, heroes.length])

  // テンプレートを変えると、セクションの構成が変わるので、候補と商品選定の案は破棄する
  const changeTemplate = (id: EmailTemplateId) => {
    if (id === template) return
    setTemplate(id)
    setCandidates([])
    drafts.discardProposals()
  }

  const setSectionTitle = (i: number, text: string) =>
    setSectionTitles((prev) => {
      const next = [...prev]
      while (next.length <= i) next.push('')
      next[i] = text
      return next
    })

  const setSectionCopy = (i: number, text: string) =>
    setSectionCopies((prev) => {
      const next = [...prev]
      while (next.length <= i) next.push('')
      next[i] = text
      return next
    })

  const removeItem = (key: string) => {
    const idx = items.findIndex((i) => i.key === key)
    if (idx >= 0) {
      const section = sectionIndexAt(sectionsOf(template), idx)
      setCandidates([{ ...items[idx], section }, ...candidates])
    }
    setItems(items.filter((i) => i.key !== key))
    if (selectedKey === key) setSelectedKey(null)
  }

  // 差分を配信商品テーブルへ反映する(選定済み + 候補。削除 → 更新/追加)
  async function syncItems(cardId: string, cardName: string, before: Map<string, RowSnap>) {
    const sections = sectionsOf(template)
    const desired: { it: Item; state: typeof STATE_SELECTED | typeof STATE_CANDIDATE; section: number; order: number }[] = [
      ...items.map((it, idx) => ({ it, state: STATE_SELECTED as typeof STATE_SELECTED, section: sectionIndexAt(sections, idx), order: idx + 1 })),
      ...candidates.map((c, i) => ({ it: c as Item, state: STATE_CANDIDATE as typeof STATE_CANDIDATE, section: c.section, order: 1000 + i })),
    ]
    const keep = new Set(desired.map((d) => d.it.rowId).filter((id): id is string => !!id))
    for (const id of before.keys()) {
      if (!keep.has(id)) await Cr854_deliveryproductsService.delete(id)
    }
    for (const d of desired) {
      const fields = {
        cr854_sortorder: d.order,
        cr854_reason: d.it.reason,
        cr854_source: d.it.source,
        cr854_state: d.state,
        cr854_section: d.section,
      }
      let res
      if (d.it.rowId) {
        const old = before.get(d.it.rowId)
        if (old && old.reason === d.it.reason && old.source === d.it.source && old.state === d.state && old.section === d.section && old.order === d.order) continue
        res = await Cr854_deliveryproductsService.update(d.it.rowId, fields)
      } else {
        res = await Cr854_deliveryproductsService.create({
          ...fields,
          cr854_name: `${cardName} / ${productName(d.it.productId)}`,
          'cr854_deliverycard@odata.bind': `/cr854_deliverycards(${cardId})`,
          'cr854_product@odata.bind': `/cr854_products(${d.it.productId})`,
          statecode: 0,
        })
      }
      if (!res.success) throw new Error(res.error?.message ?? tr('掲載商品の保存に失敗しました', 'Failed to save the products in this delivery'))
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const fields = {
        cr854_name: form.name,
        cr854_scheduledat: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
        cr854_country: num(form.country),
        cr854_channel: num(form.channel),
        cr854_department: num(form.department),
        cr854_status: num(form.status),
        cr854_theme: form.theme,
        cr854_headline: form.headline,
        cr854_products: items.map((i) => productName(i.productId)).filter(Boolean).join(' / '),
        cr854_copy: form.copy,
        cr854_instructions: form.instructions,
        cr854_themereason: form.themeReason,
        cr854_copyangle: form.copyAngle,
        cr854_instructionsangle: form.instructionsAngle,
        cr854_heroreason: heroReason,
        // 標準のテンプレートは、以前の選択肢の列にも書く(互換)。作ったテンプレートは、layoutkey だけ
        cr854_emailtemplate: TEMPLATE_VALUES[template],
        cr854_layoutkey: template,
        cr854_sectiontitles: sectionTitles.join('\n').replace(/\n+$/, ''),
        cr854_sectioncopies: encodeCopies(sectionCopies),
        // 外したときは null を送ってルックアップを空にする
        'cr854_heroimage@odata.bind': heroId
          ? `/cr854_heroimages(${heroId})`
          : card?._cr854_heroimage_value
            ? (null as never)
            : undefined,
      }
      const res = card
        ? await Cr854_deliverycardsService.update(card.cr854_deliverycardid, fields)
        : await Cr854_deliverycardsService.create({ ...fields, statecode: 0 })
      if (!res.success) throw new Error(res.error?.message ?? tr('保存に失敗しました', 'Failed to save'))
      const cardId = card?.cr854_deliverycardid ?? res.data?.cr854_deliverycardid
      if (!cardId) throw new Error(tr('配信カードのIDを取得できませんでした', 'Could not get the delivery card ID'))
      if (original) await syncItems(cardId, form.name, original)
      await onSaved()
      onBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const progress = progressOf({ theme: form.theme, template, heroId, headline: form.headline, items, instructions: form.instructions })
  const hero = heroes.find((h) => h.cr854_heroimageid === heroId)

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open && !saving) onBack() }}>
      <DialogSurface className={styles.surface} aria-label={card ? card.cr854_name : t('配信カードの新規作成', 'New delivery card')}>
        <form onSubmit={submit} className={styles.form}>
          {auto && (
            <div className={styles.overlay}>
              <Spinner size="large" />
              <Text as="h2" size={500} weight="semibold">{t('AIが下書きを作っています', 'AI is drafting')}</Text>
              <Text>{auto.label}({Math.min(auto.done + 1, auto.total)} / {auto.total})</Text>
              <ProgressBar className={styles.overlayBar} value={Math.min(1, auto.done / auto.total)} />
              <Caption1 className={styles.caption}>
                {t('結果は画面に反映されるだけで、保存はされません。気に入らなければ、保存せずに閉じられます。', 'Results are only applied on screen and are not saved. If you do not like them, close without saving.')}
              </Caption1>
              <Button
                type="button"
                appearance="subtle"
                onClick={() => {
                  cancelRef.current = true
                  setAuto(null)
                }}
              >
                {t('スキップして開く', 'Skip and open')}
              </Button>
            </div>
          )}
          <div className={styles.titleRow}>
            <Text as="h2" size={500} weight="semibold" className={styles.titleText}>{card ? card.cr854_name : t('配信カードの新規作成', 'New delivery card')}</Text>
            <Tooltip
              relationship="description"
              content={progress.remaining.length ? t(`未完了: ${progress.remaining.join('、')}`, `Incomplete: ${progress.remaining.join(', ')}`) : t('すべての工程が完了しています', 'All steps are complete')}
            >
              <Badge appearance="tint" color={progress.done === progress.total ? 'success' : 'informative'} size="large">
                {t(`工程 ${progress.done} / ${progress.total}`, `Steps ${progress.done} / ${progress.total}`)}
              </Badge>
            </Tooltip>
            <Button type="button" appearance="subtle" icon={<DismissRegular />} onClick={onBack} aria-label={t('閉じる', 'Close')} />
          </div>

          <div className={styles.panes} style={{ '--w0': `${widths[0]}px`, '--w1': `${widths[1]}px`, '--w2': `${infoOpen ? widths[2] : RAIL_W}px` } as React.CSSProperties}>
            {/* 左: 配信の情報 */}
            <div className={styles.pane}>
              <Button
                appearance="primary"
                icon={<AiIcon tone="white" size={18} />}
                onClick={runAllManual}
                disabled={!!auto || saving}
                className={styles.fullWidth}
              >
                {t('すべてAIで下書き', 'Draft everything with AI')}
              </Button>
              <Caption1 className={mergeClasses(styles.caption, styles.captionTight)}>
                {t('テーマ・メイン画像・ヘッドライン・セクション・制作指示を、まとめてAIが下書きします', 'AI drafts the theme, hero image, headline, sections, and production notes all at once')}
              </Caption1>
              <Text weight="semibold" size={300}>{t('配信情報', 'Delivery info')}</Text>
              <Field label={t('配信名', 'Delivery name')} required>
                <Input size="small" required value={form.name} onChange={(_, d) => set('name')(d.value)} />
              </Field>
              <Field label={t('配信日時', 'Send date & time')} required>
                <Input size="small" required type="datetime-local" value={form.scheduledAt} onChange={(_, d) => set('scheduledAt')(d.value)} />
              </Field>
              <div className={styles.twoCol}>
                <OptionSelect label={t('国', 'Country')} value={form.country} options={countryOptions} onChange={set('country')} />
                <OptionSelect label={t('チャネル', 'Channel')} value={form.channel} options={channelOptions} onChange={set('channel')} />
                <OptionSelect label={t('部署', 'Department')} value={form.department} options={departmentOptions} onChange={set('department')} />
                <Field label={t('ステータス', 'Status')}>
                  <div className={styles.statusRow}>
                    <span className={styles.dot} style={{ backgroundColor: statusColor(Number(form.status)) }} />
                    <Select size="small" className={styles.grow} value={form.status} onChange={(_, d) => set('status')(d.value)}>
                      {statusOptions.map((o) => (
                        <option key={o.value} value={String(o.value)}>{optionLabel(o.label)}</option>
                      ))}
                    </Select>
                  </div>
                </Field>
              </div>
              <Text weight="semibold" size={300} className={styles.sectionHead}>{t('工程', 'Steps')}</Text>
              <Field label={t('テーマ(配信全体の前提。メールには出ません)', 'Theme (premise for the whole delivery; not shown in the email)')}>
                <AutoTextarea
                  size="small"
                  rows={2}
                                    className={form.theme ? styles.filled : undefined}
                  value={form.theme}
                  onChange={(_, d) => set('theme')(d.value)}
                />
              </Field>
              {form.theme && form.themeReason && <Caption1 className={styles.caption}><span className={styles.lead}>{t('AIの理由:', 'AI rationale:')}</span>{` ${form.themeReason}`}</Caption1>}
              <Caption1 className={items.length ? styles.success : styles.caption}>
                {t(`掲載商品: ${items.length}件(中央の「セクション」タブで選びます)`, `Products in this delivery: ${items.length} (choose them in the Sections tab in the middle)`)}
              </Caption1>
              <Field label={t('ヘッドライン(メイン画像に載せる大見出し)', 'Headline (the large heading on the hero image)')}>
                <AutoTextarea
                  size="small"
                  rows={1}
                                    className={form.headline ? styles.filled : undefined}
                  value={form.headline}
                  onChange={(_, d) => set('headline')(d.value)}
                />
              </Field>
              <Field label={t('コピー(ヘッドラインの下の導入文)', 'Copy (intro text below the headline)')}>
                <AutoTextarea
                  size="small"
                  rows={2}
                                    className={form.copy ? styles.filled : undefined}
                  value={form.copy}
                  onChange={(_, d) => set('copy')(d.value)}
                />
              </Field>
              {(form.headline || form.copy) && form.copyAngle && <Caption1 className={styles.caption}><span className={styles.lead}>{t('切り口:', 'Angle:')}</span>{` ${form.copyAngle}`}</Caption1>}
              <Field label={t('制作指示', 'Production notes')}>
                <AutoTextarea
                  size="small"
                  rows={2}
                                    className={form.instructions ? styles.filled : undefined}
                  value={form.instructions}
                  onChange={(_, d) => set('instructions')(d.value)}
                />
              </Field>
              {form.instructions && form.instructionsAngle && <Caption1 className={styles.caption}><span className={styles.lead}>{t('切り口:', 'Angle:')}</span>{` ${form.instructionsAngle}`}</Caption1>}
            </div>

            <Splitter onDrag={resize(0)} onDone={saveWidths} />

            {/* 中: コンテンツ生成(テーマ・商品選定・コピー・制作指示) */}
            <div className={mergeClasses(styles.pane, styles.paneMid)}>
              <ContentPane
                theme={form.theme}
                headline={form.headline}
                copy={form.copy}
                instructions={form.instructions}
                themeReason={form.themeReason}
                copyAngle={form.copyAngle}
                instructionsAngle={form.instructionsAngle}
                onField={(key, value) => setForm((f) => ({ ...f, [key]: value }))}
                template={template}
                onTemplate={changeTemplate}
                sectionTitles={sectionTitles}
                onSectionTitle={setSectionTitle}
                sectionCopies={sectionCopies}
                onSectionCopy={setSectionCopy}
                products={products}
                heroes={heroes}
                poolProducts={poolProducts}
                poolHeroes={poolHeroes}
                items={items}
                setItems={setItems}
                candidates={candidates}
                setCandidates={setCandidates}
                heroId={heroId}
                setHeroId={setHeroId}
                heroReason={heroReason}
                setHeroReason={setHeroReason}
                heroCandidates={heroCandidates}
                setHeroCandidates={setHeroCandidates}
                language={language}
                onLanguage={setLanguage}
                drafts={drafts}
                disabled={saving}
              />
            </div>

            <Splitter onDrag={resize(1)} onDone={saveWidths} />

            {/* 右: プレビュー */}
            <div className={mergeClasses(styles.pane, styles.panePreview)}>
              <div className={styles.toolbar}>
                <TabList
                  size="small"
                  className={styles.grow}
                  selectedValue={previewTab}
                  onTabSelect={(_, d) => setPreviewTab(d.value as 'email' | 'push')}
                >
                  <Tab value="email">{t('メール', 'Email')}</Tab>
                  <Tab value="push">{t('プッシュ', 'Push')}</Tab>
                </TabList>
                <div className={styles.zoomBox}>
                  <Button type="button" size="small" appearance="subtle" icon={<SubtractRegular />} onClick={() => stepZoom(-0.1)} aria-label={t('縮小', 'Zoom out')} />
                  <Slider
                    size="small"
                    className={styles.slider}
                    min={ZOOM_MIN * 100}
                    max={ZOOM_MAX * 100}
                    step={5}
                    value={Math.round(shownZoom * 100)}
                    onChange={(_, d) => setZoom(d.value / 100)}
                    aria-label={t('プレビューの倍率', 'Preview zoom')}
                  />
                  <Button type="button" size="small" appearance="subtle" icon={<AddRegular />} onClick={() => stepZoom(0.1)} aria-label={t('拡大', 'Zoom in')} />
                  <Caption1 className={styles.zoomLabel}>{Math.round(shownZoom * 100)}%</Caption1>
                  {/* ボタンの文字は、押したときの動きを表す: 全体表示にする前は「全体」、全体表示のときは「100%」(押すと100%に戻る) */}
                  <Button
                    type="button"
                    size="small"
                    appearance={zoom === 'fit' ? 'primary' : 'outline'}
                    onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')}
                    aria-label={zoom === 'fit' ? t('100% の倍率に戻す', 'Reset to 100%') : t('メール全体を表示', 'Fit the whole email')}
                  >
                    {zoom === 'fit' ? '100%' : t('全体', 'Fit')}
                  </Button>
                </div>
                {previewTab === 'email' && template === 'free' && (
                  <>
                    <Switch label={t('カテゴリ見出し', 'Category headings')} checked={showHeadings} onChange={(_, d) => setShowHeadings(d.checked)} />
                    <Button type="button" size="small" appearance="subtle" onClick={groupByCategory} disabled={items.length < 2}>{t('カテゴリでまとめる', 'Group by category')}</Button>
                  </>
                )}
              </div>
              <div ref={previewBoxRef} className={styles.previewBox}>
                <div ref={previewInnerRef} style={{ zoom: zoom === 'fit' ? undefined : zoom }}>
                  <Preview
                    channel={previewTab}
                    subject={form.name}
                    headline={form.headline}
                    copy={form.copy}
                    items={items}
                    products={products}
                    selectedKey={selectedKey}
                    hoverKey={hoverKey}
                    showHeadings={showHeadings}
                    template={template}
                    scheduledAt={form.scheduledAt}
                    sectionTitles={sectionTitles}
                    onSectionTitle={setSectionTitle}
                    sectionCopies={sectionCopies}
                    onSectionCopy={setSectionCopy}
                    hero={hero}
                    onDropHero={setHeroId}
                    onClearHero={() => setHeroId(undefined)}
                    onSelect={setSelectedKey}
                    onRemove={removeItem}
                    onMove={(key, d) => {
                      const i = items.findIndex((x) => x.key === key)
                      moveItem(i, i + d)
                    }}
                    onDropAt={dropAt}
                  />
                </div>
              </div>
            </div>

            <Splitter onDrag={infoOpen ? resizeInfo : () => undefined} onDone={saveWidths} />

            {/* 右端: 商品情報(参照用。操作はしない) */}
            {infoOpen ? (
              <div className={styles.pane}>
                <div className={styles.infoToolbar}>
                  <Button type="button" size="small" appearance="subtle" icon={<ChevronRightRegular />} onClick={toggleInfo} aria-label={t('商品情報を閉じる', 'Collapse product info')} />
                </div>
                <ProductInfoPane template={template} sectionTitles={sectionTitles} items={items} products={products} onHover={setHoverKey} />
              </div>
            ) : (
              <div className={styles.rail}>
                <Button type="button" size="small" appearance="subtle" icon={<ChevronLeftRegular />} onClick={toggleInfo} aria-label={t('商品情報を開く', 'Open product info')} />
                <span className={styles.railLabel}>{t('商品情報', 'Product info')}</span>
              </div>
            )}
          </div>

          {error && (
            <MessageBar layout="multiline" intent="error" className={styles.error}>
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.actions}>
            <Button type="button" onClick={onBack} disabled={saving}>{t('キャンセル', 'Cancel')}</Button>
            <Button type="submit" appearance="primary" icon={<SaveRegular />} disabled={saving}>
              {saving ? t('保存中...', 'Saving...') : t('保存', 'Save')}
            </Button>
          </div>
        </form>
      </DialogSurface>
    </Dialog>
  )
}
