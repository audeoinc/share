import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogTitle from '@mui/material/DialogTitle'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import CloseIcon from '@mui/icons-material/Close'
import SaveIcon from '@mui/icons-material/Save'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import { Cr854_deliverycardsService } from './generated/services/Cr854_deliverycardsService'
import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { Cr854_deliveryproductsService } from './generated/services/Cr854_deliveryproductsService'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { Candidates } from './Candidates'
import { HeroCandidates } from './HeroCandidates'
import { Preview } from './Preview'
import { Splitter } from './Splitter'
import { DND_ITEM, DND_PRODUCT, SOURCE_AI, SOURCE_MANUAL, type Item } from './items'
import { selectWithAi } from './aiSelect'
import { channelOptions, countryOptions, departmentOptions, statusColor, statusOptions } from './status'

interface Props {
  /** undefined のときは新規作成 */
  card?: Cr854_deliverycards
  products: Cr854_products[]
  heroes: Cr854_heroimages[]
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

const WIDTH_KEY = 'cardDetail.paneWidths'
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
  return [300, 340]
}

const paneSx = { p: 2, overflow: 'auto', minHeight: 0, display: 'grid', gap: 1.5, alignContent: 'start' } as const

export function CardDetail({ card, products, heroes, onBack, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => toForm(card))
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'))
  const [items, setItems] = useState<Item[]>([])
  // 読み込み時点の配信商品(保存時に差分を取る)。読み込めなかったときは保存で消さないよう null のまま
  const [original, setOriginal] = useState<Item[] | null>(card ? null : [])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [previewTab, setPreviewTab] = useState<'email' | 'push'>(() =>
    card?.cr854_channelname === 'プッシュ' ? 'push' : 'email',
  )
  const [showHeadings, setShowHeadings] = useState(true)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiCount, setAiCount] = useState('4')
  const [heroId, setHeroId] = useState<string | undefined>(card?._cr854_heroimage_value)
  const [heroReason, setHeroReason] = useState(card?.cr854_heroreason ?? '')
  const [midTab, setMidTab] = useState<'products' | 'hero'>('products')
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
        const loaded: Item[] = (res.data ?? []).map((r) => ({
          key: r.cr854_deliveryproductid,
          rowId: r.cr854_deliveryproductid,
          productId: r._cr854_product_value ?? '',
          reason: r.cr854_reason ?? '',
          source: r.cr854_source ?? SOURCE_MANUAL,
        }))
        setItems(loaded)
        setOriginal(loaded)
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
    const it: Item = { key: crypto.randomUUID(), productId, reason: '', source: SOURCE_MANUAL }
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

  // テーマに応じて、掲載商品とメイン画像をエージェントに選ばせる(現在の内容は置き換える)
  async function runAi() {
    if (!form.theme.trim()) {
      setError('AI で選定するには、先にテーマを入力してください')
      return
    }
    if ((items.length > 0 || heroId) && !window.confirm('現在の掲載商品とメイン画像を、AI の選定結果で置き換えます。よろしいですか?')) return
    setAiBusy(true)
    setError(null)
    try {
      const label = (opts: { value: number; label: string }[], v: string) => opts.find((o) => String(o.value) === v)?.label ?? ''
      const result = await selectWithAi({
        card: {
          name: form.name,
          scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : '',
          country: label(countryOptions, form.country),
          channel: label(channelOptions, form.channel),
          department: label(departmentOptions, form.department),
          theme: form.theme,
          copy: form.copy,
          instructions: form.instructions,
        },
        productCount: Number(aiCount),
        products,
        heroes,
      })
      setItems(
        result.products.map((p) => ({ key: crypto.randomUUID(), productId: p.productId, reason: p.reason, source: SOURCE_AI })),
      )
      setSelectedKey(null)
      if (result.hero) {
        setHeroId(result.hero.heroId)
        setHeroReason(result.hero.reason)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAiBusy(false)
    }
  }

  const removeItem = (key: string) => {
    setItems(items.filter((i) => i.key !== key))
    if (selectedKey === key) setSelectedKey(null)
  }

  // 差分を配信商品テーブルへ反映する(削除 → 更新/追加。表示順は並び順から採番)
  async function syncItems(cardId: string, cardName: string, before: Item[]) {
    for (const old of before) {
      if (!items.some((i) => i.rowId === old.rowId)) await Cr854_deliveryproductsService.delete(old.rowId!)
    }
    for (const [idx, it] of items.entries()) {
      const fields = { cr854_sortorder: idx + 1, cr854_reason: it.reason, cr854_source: it.source }
      let res
      if (it.rowId) {
        const old = before.find((b) => b.rowId === it.rowId)
        const same = old && old.reason === it.reason && old.source === it.source && before.indexOf(old) === idx
        if (same) continue
        res = await Cr854_deliveryproductsService.update(it.rowId, fields)
      } else {
        res = await Cr854_deliveryproductsService.create({
          ...fields,
          cr854_name: `${cardName} / ${productName(it.productId)}`,
          'cr854_deliverycard@odata.bind': `/cr854_deliverycards(${cardId})`,
          'cr854_product@odata.bind': `/cr854_products(${it.productId})`,
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
        cr854_products: items.map((i) => productName(i.productId)).filter(Boolean).join(' / '),
        cr854_copy: form.copy,
        cr854_instructions: form.instructions,
        cr854_heroreason: heroReason,
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

  const selected = items.find((i) => i.key === selectedKey)
  const selectedProduct = selected && products.find((p) => p.cr854_productid === selected.productId)
  const layersFilled = [form.theme, items.length > 0, form.copy, form.instructions].filter(Boolean).length
  const usedIds = new Set(items.map((i) => i.productId))
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
          sx: { width: { md: 'min(1800px, 98vw)' }, height: { md: '92vh' }, maxHeight: { md: '92vh' } },
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <Box component="span" sx={{ flexGrow: 1 }}>{card ? card.cr854_name : '配信カードの新規作成'}</Box>
        <TextField
          select
          size="small"
          label="商品数"
          value={aiCount}
          onChange={(e) => setAiCount(e.target.value)}
          sx={{ width: 84 }}
          disabled={aiBusy || saving}
        >
          {[2, 3, 4, 5, 6, 8].map((n) => (
            <MenuItem key={n} value={String(n)}>{n}件</MenuItem>
          ))}
        </TextField>
        <Button
          variant="outlined"
          onClick={runAi}
          disabled={aiBusy || saving}
          startIcon={aiBusy ? <CircularProgress size={16} /> : <AutoAwesomeIcon fontSize="small" />}
        >
          {aiBusy ? '選定中...' : 'AIで選定'}
        </Button>
        <Chip size="small" label={`工程 ${layersFilled} / 4`} color={layersFilled === 4 ? 'success' : 'default'} />
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
            label="① テーマ"
            value={form.theme}
            onChange={(e) => set('theme')(e.target.value)}
            color={form.theme ? 'success' : 'primary'}
          />
          <Typography variant="caption" color={items.length ? 'success.main' : 'text.secondary'}>
            ② 掲載商品: {items.length}件(中央の候補から右のプレビューへドラッグ)
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="③ コピー"
            value={form.copy}
            onChange={(e) => set('copy')(e.target.value)}
            color={form.copy ? 'success' : 'primary'}
          />
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="④ 制作指示"
            value={form.instructions}
            onChange={(e) => set('instructions')(e.target.value)}
            color={form.instructions ? 'success' : 'primary'}
          />
        </Box>

        <Splitter onDrag={resize(0)} onDone={saveWidths} />

        {/* 中: 商品の候補 */}
        <Box sx={{ ...paneSx, bgcolor: 'action.hover' }}>
          <Tabs value={midTab} onChange={(_, v) => setMidTab(v)} sx={{ minHeight: 36 }}>
            <Tab value="products" label={`商品(${products.length})`} sx={{ minHeight: 36 }} />
            <Tab value="hero" label={`メイン画像(${heroes.length})`} sx={{ minHeight: 36 }} />
          </Tabs>
          {midTab === 'products' ? (
            <Candidates products={products} usedIds={usedIds} onAdd={(id) => addProduct(id)} />
          ) : (
            <HeroCandidates heroes={heroes} selectedId={heroId} onSelect={setHeroId} />
          )}
        </Box>

        <Splitter onDrag={resize(1)} onDone={saveWidths} />

        {/* 右: プレビュー */}
        <Box sx={{ ...paneSx, gridTemplateRows: 'auto minmax(0, 1fr) auto' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Tabs value={previewTab} onChange={(_, v) => setPreviewTab(v)} sx={{ minHeight: 40, flexGrow: 1 }}>
              <Tab value="email" label="メール" sx={{ minHeight: 40 }} />
              <Tab value="push" label="プッシュ" sx={{ minHeight: 40 }} />
            </Tabs>
            {previewTab === 'email' && (
              <>
                <FormControlLabel
                  control={<Switch size="small" checked={showHeadings} onChange={(e) => setShowHeadings(e.target.checked)} />}
                  label="カテゴリ見出し"
                />
                <Button onClick={groupByCategory} disabled={items.length < 2}>カテゴリでまとめる</Button>
              </>
            )}
          </Box>
          <Box sx={{ overflow: 'auto', minHeight: 0, py: 1 }}>
            <Preview
              channel={previewTab}
              subject={form.name}
              theme={form.theme}
              copy={form.copy}
              items={items}
              products={products}
              selectedKey={selectedKey}
              showHeadings={showHeadings}
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
          <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5, minHeight: 96, display: 'grid', gap: 1.5 }}>
            {hero && (
              <TextField
                fullWidth
                multiline
                label={`メイン画像「${hero.cr854_name}」の選定理由`}
                value={heroReason}
                onChange={(e) => setHeroReason(e.target.value)}
              />
            )}
            {selected && selectedProduct ? (
              <Box sx={{ display: 'grid', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography sx={{ fontWeight: 600 }}>{selectedProduct.cr854_name}</Typography>
                  <Chip size="small" label={selected.source === SOURCE_AI ? 'AI' : '手動'} color={selected.source === SOURCE_AI ? 'secondary' : 'default'} />
                </Box>
                <TextField
                  size="small"
                  fullWidth
                  multiline
                  label="選定理由"
                  value={selected.reason}
                  onChange={(e) => setItems(items.map((i) => (i.key === selected.key ? { ...i, reason: e.target.value } : i)))}
                />
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">
                プレビューの商品をクリックすると、選定理由を編集できます。
              </Typography>
            )}
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
