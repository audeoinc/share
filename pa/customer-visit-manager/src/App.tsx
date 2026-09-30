import { useCallback, useEffect, useMemo, useState } from 'react'
import AppBar from '@mui/material/AppBar'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Container from '@mui/material/Container'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import { Cr854_deliverycardsService } from './generated/services/Cr854_deliverycardsService'
import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { Cr854_productsService } from './generated/services/Cr854_productsService'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import { Calendar } from './Calendar'
import { CardDetail } from './CardDetail'
import { channelOptions, countryOptions, departmentOptions, statusColor, statusOptions } from './status'

interface Filters {
  country: string
  channel: string
  department: string
  status: string
}
const noFilter: Filters = { country: '', channel: '', department: '', status: '' }

function FilterSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: { value: number; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <TextField select size="small" label={label} value={value} onChange={(e) => onChange(e.target.value)} sx={{ minWidth: 130 }}>
      <MenuItem value="">すべて</MenuItem>
      {options.map((o) => (
        <MenuItem key={o.value} value={String(o.value)}>{o.label}</MenuItem>
      ))}
    </TextField>
  )
}

function App() {
  const [cards, setCards] = useState<Cr854_deliverycards[]>([])
  const [products, setProducts] = useState<Cr854_products[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [month, setMonth] = useState<Date | null>(null)
  const [filters, setFilters] = useState<Filters>(noFilter)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await Cr854_deliverycardsService.getAll({ orderBy: ['cr854_scheduledat asc'] })
      if (!res.success) throw new Error(res.error?.message ?? '配信カードの取得に失敗しました')
      const data = res.data ?? []
      setCards(data)
      setError(null)
      // 初回のみ、最初の配信がある月(なければ今月)を表示する
      setMonth((m) => {
        if (m) return m
        const first = data.find((c) => c.cr854_scheduledat)?.cr854_scheduledat
        const base = first ? new Date(first) : new Date()
        return new Date(base.getFullYear(), base.getMonth(), 1)
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    Cr854_productsService.getAll({ orderBy: ['cr854_productcode asc'] })
      .then((res) => {
        if (res.success) setProducts(res.data ?? [])
        else setError(res.error?.message ?? '商品の取得に失敗しました')
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [load])

  const filtered = useMemo(() => {
    const match = (f: string, v?: number) => f === '' || String(v) === f
    return cards.filter(
      (c) =>
        match(filters.country, c.cr854_country) &&
        match(filters.channel, c.cr854_channel) &&
        match(filters.department, c.cr854_department) &&
        match(filters.status, c.cr854_status),
    )
  }, [cards, filters])

  const selected = cards.find((c) => c.cr854_deliverycardid === selectedId)
  const shift = (n: number) => month && setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))
  const setFilter = (k: keyof Filters) => (v: string) => setFilters({ ...filters, [k]: v })
  const filtering = Object.values(filters).some((v) => v !== '')

  return (
    <>
      <AppBar position="sticky" color="primary" elevation={2}>
        <Toolbar>
          <CalendarMonthIcon sx={{ mr: 1.5 }} />
          <Typography variant="h6" sx={{ flexGrow: 1 }}>配信カレンダー</Typography>
          <Button color="inherit" startIcon={<AddIcon />} onClick={() => setCreating(true)}>新規作成</Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 3 }}>
        {loading && <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {!loading && !error && month && (
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 2, alignItems: 'center' }}>
              <FilterSelect label="国" value={filters.country} options={countryOptions} onChange={setFilter('country')} />
              <FilterSelect label="チャネル" value={filters.channel} options={channelOptions} onChange={setFilter('channel')} />
              <FilterSelect label="部署" value={filters.department} options={departmentOptions} onChange={setFilter('department')} />
              <FilterSelect label="ステータス" value={filters.status} options={statusOptions} onChange={setFilter('status')} />
              {filtering && <Button onClick={() => setFilters(noFilter)}>クリア</Button>}
              <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>
                {filtered.length} / {cards.length} 件
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1 }}>
              <IconButton onClick={() => shift(-1)} aria-label="前の月"><ChevronLeftIcon /></IconButton>
              <Typography variant="h6" sx={{ minWidth: 120, textAlign: 'center' }}>
                {month.getFullYear()}年{month.getMonth() + 1}月
              </Typography>
              <IconButton onClick={() => shift(1)} aria-label="次の月"><ChevronRightIcon /></IconButton>
              <Box sx={{ display: 'flex', gap: 0.75, ml: 'auto', flexWrap: 'wrap' }}>
                {statusOptions.map((o) => (
                  <Chip
                    key={o.value}
                    size="small"
                    label={o.label}
                    sx={{ bgcolor: statusColor(o.value), color: '#fff', fontWeight: 600 }}
                  />
                ))}
              </Box>
            </Box>
            <Calendar month={month} cards={filtered} onSelect={setSelectedId} />
          </>
        )}
      </Container>
      {(selected || creating) && (
        <CardDetail
          key={selected?.cr854_deliverycardid ?? 'new'}
          card={selected}
          products={products}
          onBack={() => {
            setSelectedId(null)
            setCreating(false)
          }}
          onSaved={load}
        />
      )}
    </>
  )
}

export default App
