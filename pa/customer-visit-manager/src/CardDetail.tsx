import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import MenuItem from '@mui/material/MenuItem'
import FormControlLabel from '@mui/material/FormControlLabel'
import Slider from '@mui/material/Slider'
import Switch from '@mui/material/Switch'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import ToggleButton from '@mui/material/ToggleButton'
import Tooltip from '@mui/material/Tooltip'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import AddIcon from '@mui/icons-material/Add'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import CloseIcon from '@mui/icons-material/Close'
import RemoveIcon from '@mui/icons-material/Remove'
import SaveIcon from '@mui/icons-material/Save'
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
import { runAutoDraft, type AutoDraftResult } from './autoDraft'
import { useAiDrafts } from './useAiDrafts'
import { channelOptions, countryOptions, departmentOptions, statusColor, statusOptions } from './status'

interface Props {
  /** undefined のときは新規作成 */
  card?: Cr854_deliverycards
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
})

function Select({ label, value, options, onChange }: {
  label: string
  value: string
  options: { value: number; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <TextField select fullWidth size="small" label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <MenuItem value="">未設定</MenuItem>
      {options.map((o) => (
        <MenuItem key={o.value} value={String(o.value)}>{o.label}</MenuItem>
      ))}
    </TextField>
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

const AUTO_KEY = 'cardDetail.autoDraft'
/** 開いたときの自動下書きの設定(既定はオン) */
function loadAutoEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== 'off'
  } catch {
    return true
  }
}
/** 自動下書きを済ませたカード(同じカードを開き直しても、再実行しない) */
const autoDrafted = new Set<string>()

const WIDTH_KEY = 'cardDetail.paneWidths.v2'
const MIN_W = 220
const MAX_W = 640
const clamp = (v: number) => Math.min(MAX_W, Math.max(MIN_W, v))

function loadWidths(): [number, number] {
  try {
    const v = JSON.parse(localStorage.getItem(WIDTH_KEY) ?? 'null')
    if (Array.isArray(v) && v.length === 2) return [clamp(Number(v[0])), clamp(Number(v[1]))]
  } catch {
    // 保存値が読めなければ既定値を使う
  }
  return [300, 460]
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

const paneSx = { p: 2, overflow: 'auto', minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 1.5, alignContent: 'start' } as const

export function CardDetail({ card, products, heroes, otherThemes, onBack, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => toForm(card))
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'))
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
  const [autoEnabled, setAutoEnabled] = useState(loadAutoEnabled)
  const [auto, setAuto] = useState<{ label: string; done: number; total: number } | null>(null)
  const cancelRef = useRef(false)
  const aliveRef = useRef(true)
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const previewInnerRef = useRef<HTMLDivElement>(null)
  // コピー・ヘッドラインの言語(AI に渡す。保存はしない)
  const [language, setLanguage] = useState<CopyLanguage>('auto')
  const [template, setTemplate] = useState<EmailTemplateId>(() => templateFromValue(card?.cr854_emailtemplate))
  // カテゴリ系テンプレートの見出し(セクションの順。保存は 1 行 1 見出し)
  const [sectionTitles, setSectionTitles] = useState<string[]>(() => (card?.cr854_sectiontitles ? card.cr854_sectiontitles.split('\n') : []))
  // 各セクションのコピー(セクションの順)
  const [sectionCopies, setSectionCopies] = useState<string[]>(() => parseCopies(card?.cr854_sectioncopies))
  // メイン画像の候補(AI が案を出したときの分。保存はしない)
  const [heroCandidates, setHeroCandidates] = useState<ProposedHero[]>([])
  const [heroId, setHeroId] = useState<string | undefined>(card?._cr854_heroimage_value)
  const [heroReason, setHeroReason] = useState(card?.cr854_heroreason ?? '')
  const [widths, setWidths] = useState<[number, number]>(loadWidths)
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
        if (!res.success) throw new Error(res.error?.message ?? '掲載商品の取得に失敗しました')
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

  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setForm({ ...form, [k]: v })
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
      const z = h > 0 ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (box.clientHeight - 16) / h)) : 1
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
  }, [zoom, previewTab, template, items, form.headline, form.copy, sectionTitles, sectionCopies, heroId, fullScreen])

  const shownZoom = zoom === 'fit' ? fitZoom : zoom
  const stepZoom = (d: number) => setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round((shownZoom + d) * 20) / 20)))

  const resize = (i: 0 | 1) => (dx: number) =>
    setWidths((w) => {
      const next: [number, number] = [w[0], w[1]]
      next[i] = clamp(next[i] + dx)
      return next
    })
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

  // AI の案の状態と生成(案は採用するまで、配信カードには反映しない)
  const drafts = useAiDrafts(
    { buildCard: buildAiCard, products, heroes, otherThemes, template, items, candidates, sectionTitles, sectionCopies, heroId, heroReason, language },
    setError,
  )

  // ---- すべてAIで下書き(テーマ → テンプレート・メイン画像 → ヘッドライン・コピー → 各セクション → 制作指示)
  const applyAutoResult = (res: AutoDraftResult) => {
    if (res.template) setTemplate(res.template)
    setForm((f) => ({
      ...f,
      theme: res.theme ?? f.theme,
      headline: res.headline ?? f.headline,
      copy: res.copy ?? f.copy,
      instructions: res.instructions ?? f.instructions,
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
    if (res.errors.length > 0) setError(`一部の工程で失敗しました: ${res.errors.join(' / ')}`)
  }

  async function startAutoDraft() {
    if (!form.scheduledAt) {
      setError('すべてAIで下書きするには、先に配信日時を入力してください')
      return
    }
    cancelRef.current = false
    setError(null)
    setAuto({ label: '準備しています', done: 0, total: 7 })
    const res = await runAutoDraft(
      { card: buildAiCard(), language, otherThemes, products, heroes },
      (label, done, total) => setAuto({ label, done, total }),
      () => cancelRef.current || !aliveRef.current,
    )
    if (!cancelRef.current && aliveRef.current) applyAutoResult(res)
    setAuto(null)
  }

  const hasContent = !!(form.theme.trim() || form.headline.trim() || form.copy.trim() || form.instructions.trim() || items.length > 0 || heroId)

  function runAllManual() {
    if (hasContent && !window.confirm('現在のテーマ・ヘッドライン・コピー・商品・メイン画像・制作指示を、AIの下書きで置き換えます。よろしいですか?')) return
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
      if (!res.success) throw new Error(res.error?.message ?? '掲載商品の保存に失敗しました')
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
        cr854_heroreason: heroReason,
        cr854_emailtemplate: TEMPLATE_VALUES[template],
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
      if (!res.success) throw new Error(res.error?.message ?? '保存に失敗しました')
      const cardId = card?.cr854_deliverycardid ?? res.data?.cr854_deliverycardid
      if (!cardId) throw new Error('配信カードのIDを取得できませんでした')
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
    <Dialog
      open
      onClose={saving ? undefined : onBack}
      fullScreen={fullScreen}
      fullWidth
      maxWidth={false}
      scroll="paper"
      slotProps={{
        paper: {
          component: 'form',
          onSubmit: submit,
          sx: { position: 'relative', width: { md: 'min(1800px, 98vw)' }, height: { md: '92vh' }, maxHeight: { md: '92vh' } },
        },
      }}
    >
      {auto && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            display: 'grid',
            placeContent: 'center',
            justifyItems: 'center',
            gap: 2,
            px: 3,
            textAlign: 'center',
            bgcolor: 'background.paper',
          }}
        >
          <CircularProgress />
          <Typography variant="h6">AIが下書きを作っています</Typography>
          <Typography>{auto.label}({Math.min(auto.done + 1, auto.total)} / {auto.total})</Typography>
          <LinearProgress variant="determinate" value={Math.min(100, (auto.done / auto.total) * 100)} sx={{ width: 320 }} />
          <Typography variant="caption" color="text.secondary">
            結果は画面に反映されるだけで、保存はされません。気に入らなければ、保存せずに閉じられます。
          </Typography>
          <Button
            onClick={() => {
              cancelRef.current = true
              setAuto(null)
            }}
          >
            スキップして開く
          </Button>
        </Box>
      )}
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <Box component="span" sx={{ flexGrow: 1 }}>{card ? card.cr854_name : '配信カードの新規作成'}</Box>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AutoAwesomeIcon fontSize="small" />}
          onClick={runAllManual}
          disabled={!!auto || saving}
        >
          すべてAIで下書き
        </Button>
        <Tooltip title="テーマも商品も空のカードを開いたとき、AIが自動で下書きを作ります(同じカードでは1回だけ)">
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={autoEnabled}
                onChange={(e) => {
                  setAutoEnabled(e.target.checked)
                  try {
                    localStorage.setItem(AUTO_KEY, e.target.checked ? 'on' : 'off')
                  } catch {
                    // 保存できなくても動作には影響しない
                  }
                }}
              />
            }
            label="開いたとき自動"
            sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: '0.75rem' } }}
          />
        </Tooltip>
        <Tooltip title={progress.remaining.length ? `未完了: ${progress.remaining.join('、')}` : 'すべての工程が完了しています'}>
          <Chip size="small" label={`工程 ${progress.done} / ${progress.total}`} color={progress.done === progress.total ? 'success' : 'default'} />
        </Tooltip>
        <IconButton onClick={onBack} aria-label="閉じる"><CloseIcon /></IconButton>
      </DialogTitle>

      <Box
        sx={{
          flexGrow: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: `${widths[0]}px 1px ${widths[1]}px 1px minmax(0, 1fr)` },
          gridTemplateRows: { md: 'minmax(0, 1fr)' },
          borderTop: 1,
          borderBottom: 1,
          borderColor: 'divider',
          overflow: { xs: 'auto', md: 'hidden' },
        }}
      >
        {/* 左: 配信の情報 */}
        <Box sx={paneSx}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>配信情報</Typography>
          <TextField required fullWidth size="small" label="配信名" value={form.name} onChange={(e) => set('name')(e.target.value)} />
          <TextField
            required
            fullWidth
            size="small"
            type="datetime-local"
            label="配信日時"
            value={form.scheduledAt}
            onChange={(e) => set('scheduledAt')(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
            <Select label="国" value={form.country} options={countryOptions} onChange={set('country')} />
            <Select label="チャネル" value={form.channel} options={channelOptions} onChange={set('channel')} />
            <Select label="部署" value={form.department} options={departmentOptions} onChange={set('department')} />
            <TextField select fullWidth size="small" label="ステータス" value={form.status} onChange={(e) => set('status')(e.target.value)}>
              {statusOptions.map((o) => (
                <MenuItem key={o.value} value={String(o.value)}>
                  <Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: statusColor(o.value), mr: 1 }} />
                  {o.label}
                </MenuItem>
              ))}
            </TextField>
          </Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mt: 1 }}>工程</Typography>
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="テーマ(配信全体の前提。メールには出ません)"
            value={form.theme}
            onChange={(e) => set('theme')(e.target.value)}
            color={form.theme ? 'success' : 'primary'}
          />
          <Typography variant="caption" color={items.length ? 'success.main' : 'text.secondary'}>
            掲載商品: {items.length}件(中央の「商品選定」タブで選びます)
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={1}
            size="small"
            label="ヘッドライン(メイン画像に載せる大見出し)"
            value={form.headline}
            onChange={(e) => set('headline')(e.target.value)}
            color={form.headline ? 'success' : 'primary'}
          />
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="コピー(ヘッドラインの下の導入文)"
            value={form.copy}
            onChange={(e) => set('copy')(e.target.value)}
            color={form.copy ? 'success' : 'primary'}
          />
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="制作指示"
            value={form.instructions}
            onChange={(e) => set('instructions')(e.target.value)}
            color={form.instructions ? 'success' : 'primary'}
          />
        </Box>

        <Splitter onDrag={resize(0)} onDone={saveWidths} />

        {/* 中: コンテンツ生成(テーマ・商品選定・コピー・制作指示) */}
        <Box sx={{ ...paneSx, bgcolor: 'action.hover' }}>
          <ContentPane
            theme={form.theme}
            headline={form.headline}
            copy={form.copy}
            instructions={form.instructions}
            onField={(key, value) => setForm((f) => ({ ...f, [key]: value }))}
            template={template}
            onTemplate={changeTemplate}
            sectionTitles={sectionTitles}
            onSectionTitle={setSectionTitle}
            sectionCopies={sectionCopies}
            onSectionCopy={setSectionCopy}
            products={products}
            heroes={heroes}
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
        </Box>

        <Splitter onDrag={resize(1)} onDone={saveWidths} />

        {/* 右: プレビュー */}
        <Box sx={{ ...paneSx, gridTemplateRows: 'auto minmax(0, 1fr)' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Tabs value={previewTab} onChange={(_, v) => setPreviewTab(v)} sx={{ minHeight: 40, flexGrow: 1 }}>
              <Tab value="email" label="メール" sx={{ minHeight: 40 }} />
              <Tab value="push" label="プッシュ" sx={{ minHeight: 40 }} />
            </Tabs>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <IconButton size="small" onClick={() => stepZoom(-0.1)} aria-label="縮小"><RemoveIcon fontSize="small" /></IconButton>
              <Slider
                size="small"
                min={ZOOM_MIN * 100}
                max={ZOOM_MAX * 100}
                step={5}
                value={Math.round(shownZoom * 100)}
                onChange={(_, v) => setZoom((v as number) / 100)}
                sx={{ width: 90, mx: 0.5 }}
                aria-label="プレビューの倍率"
              />
              <IconButton size="small" onClick={() => stepZoom(0.1)} aria-label="拡大"><AddIcon fontSize="small" /></IconButton>
              <Typography variant="caption" sx={{ width: 34, textAlign: 'right' }}>{Math.round(shownZoom * 100)}%</Typography>
              <ToggleButton size="small" value="fit" selected={zoom === 'fit'} onChange={() => setZoom(zoom === 'fit' ? shownZoom : 'fit')} sx={{ py: 0.25, ml: 0.5 }}>
                全体
              </ToggleButton>
            </Box>
            {previewTab === 'email' && template === 'free' && (
              <>
                <FormControlLabel
                  control={<Switch size="small" checked={showHeadings} onChange={(e) => setShowHeadings(e.target.checked)} />}
                  label="カテゴリ見出し"
                />
                <Button onClick={groupByCategory} disabled={items.length < 2}>カテゴリでまとめる</Button>
              </>
            )}
          </Box>
          <Box ref={previewBoxRef} sx={{ overflow: 'auto', minHeight: 0, py: 1 }}>
            <Box ref={previewInnerRef} sx={{ zoom: zoom === 'fit' ? undefined : zoom }}>
            <Preview
              channel={previewTab}
              subject={form.name}
              headline={form.headline}
              copy={form.copy}
              items={items}
              products={products}
              selectedKey={selectedKey}
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
            </Box>
          </Box>
        </Box>
      </Box>

      {error && <Alert severity="error" sx={{ m: 1.5, mb: 0 }}>{error}</Alert>}
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onBack} disabled={saving}>キャンセル</Button>
        <Button type="submit" variant="contained" startIcon={<SaveIcon />} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
