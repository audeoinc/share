import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import CloseIcon from '@mui/icons-material/Close'
import SaveIcon from '@mui/icons-material/Save'
import { Cr854_deliverycardsService } from './generated/services/Cr854_deliverycardsService'
import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { channelOptions, countryOptions, departmentOptions, statusColor, statusOptions } from './status'

interface Props {
  /** undefined のときは新規作成 */
  card?: Cr854_deliverycards
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
  products: string
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
  products: c?.cr854_products ?? '',
  copy: c?.cr854_copy ?? '',
  instructions: c?.cr854_instructions ?? '',
})

// 工程レイヤー: 上から順に埋めていく(テーマ → 商品 → コピー → 制作指示)
const layers = [
  { key: 'theme', label: 'テーマ' },
  { key: 'products', label: '掲載商品' },
  { key: 'copy', label: 'コピー' },
  { key: 'instructions', label: '制作指示' },
] as const

function Select({ label, value, options, onChange }: {
  label: string
  value: string
  options: { value: number; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <TextField select fullWidth label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <MenuItem value="">未設定</MenuItem>
      {options.map((o) => (
        <MenuItem key={o.value} value={String(o.value)}>{o.label}</MenuItem>
      ))}
    </TextField>
  )
}

export function CardDetail({ card, onBack, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() => toForm(card))
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setForm({ ...form, [k]: v })
  const num = (v: string) => (v === '' ? undefined : (Number(v) as never))

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
        cr854_products: form.products,
        cr854_copy: form.copy,
        cr854_instructions: form.instructions,
      }
      const res = card
        ? await Cr854_deliverycardsService.update(card.cr854_deliverycardid, fields)
        : await Cr854_deliverycardsService.create({ ...fields, statecode: 0 })
      if (!res.success) throw new Error(res.error?.message ?? '保存に失敗しました')
      await onSaved()
      onBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const filled = layers.filter((l) => form[l.key]).length

  return (
    <Dialog
      open
      onClose={saving ? undefined : onBack}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="md"
      scroll="paper"
      slotProps={{ paper: { component: 'form', onSubmit: submit } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', pr: 1 }}>
        <Box component="span" sx={{ flexGrow: 1 }}>{card ? card.cr854_name : '配信カードの新規作成'}</Box>
        <IconButton onClick={onBack} aria-label="閉じる"><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ display: 'grid', gap: 2, alignContent: 'start' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>基本情報</Typography>
        <TextField required fullWidth label="配信名" value={form.name} onChange={(e) => set('name')(e.target.value)} />
        <TextField
          required
          fullWidth
          type="datetime-local"
          label="配信日時"
          value={form.scheduledAt}
          onChange={(e) => set('scheduledAt')(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 2 }}>
          <Select label="国" value={form.country} options={countryOptions} onChange={set('country')} />
          <Select label="チャネル" value={form.channel} options={channelOptions} onChange={set('channel')} />
          <Select label="部署" value={form.department} options={departmentOptions} onChange={set('department')} />
          <TextField select fullWidth label="ステータス" value={form.status} onChange={(e) => set('status')(e.target.value)}>
            {statusOptions.map((o) => (
              <MenuItem key={o.value} value={String(o.value)}>
                <Box component="span" sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: statusColor(o.value), mr: 1 }} />
                {o.label}
              </MenuItem>
            ))}
          </TextField>
        </Box>

        <Divider sx={{ my: 1 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>工程レイヤー</Typography>
          <Chip size="small" label={`${filled} / ${layers.length}`} color={filled === layers.length ? 'success' : 'default'} />
        </Box>
        {layers.map((l) => (
          <TextField
            key={l.key}
            fullWidth
            multiline
            minRows={2}
            label={l.label}
            value={form[l.key]}
            onChange={(e) => set(l.key)(e.target.value)}
            color={form[l.key] ? 'success' : 'primary'}
          />
        ))}
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onBack} disabled={saving}>キャンセル</Button>
        <Button type="submit" variant="contained" startIcon={<SaveIcon />} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
