import { useEffect, useMemo, useState } from 'react'
import { Cr854_deliverycardsService } from './generated/services/Cr854_deliverycardsService'
import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { Calendar } from './Calendar'
import { CardDetail } from './CardDetail'
import { channelOptions, countryOptions, departmentOptions, statusColor, statusOptions } from './status'
import './App.css'

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
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">すべて</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function App() {
  const [cards, setCards] = useState<Cr854_deliverycards[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [month, setMonth] = useState<Date | null>(null)
  const [filters, setFilters] = useState<Filters>(noFilter)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Cr854_deliverycardsService.getAll({ orderBy: ['cr854_scheduledat asc'] })
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          const data = res.data ?? []
          setCards(data)
          // 最初の配信がある月を初期表示にする(なければ今月)
          const first = data.find((c) => c.cr854_scheduledat)?.cr854_scheduledat
          const base = first ? new Date(first) : new Date()
          setMonth(new Date(base.getFullYear(), base.getMonth(), 1))
        } else setError(res.error?.message ?? '配信カードの取得に失敗しました')
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
  if (selected) return <CardDetail card={selected} onBack={() => setSelectedId(null)} />

  const shift = (n: number) => month && setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))
  const setFilter = (k: keyof Filters) => (v: string) => setFilters({ ...filters, [k]: v })

  return (
    <div className="app wide">
      <h1>配信カレンダー</h1>
      {loading && <p>読み込み中...</p>}
      {error && <p className="error">エラー: {error}</p>}
      {!loading && !error && month && (
        <>
          <div className="filters">
            <FilterSelect label="国" value={filters.country} options={countryOptions} onChange={setFilter('country')} />
            <FilterSelect label="チャネル" value={filters.channel} options={channelOptions} onChange={setFilter('channel')} />
            <FilterSelect label="部署" value={filters.department} options={departmentOptions} onChange={setFilter('department')} />
            <FilterSelect label="ステータス" value={filters.status} options={statusOptions} onChange={setFilter('status')} />
            <button onClick={() => setFilters(noFilter)}>クリア</button>
          </div>
          <div className="legend">
            {statusOptions.map((o) => (
              <span key={o.value}><i style={{ background: statusColor(o.value) }} />{o.label}</span>
            ))}
            <span className="count">{filtered.length} / {cards.length} 件</span>
          </div>
          <div className="month-nav">
            <button onClick={() => shift(-1)}>‹</button>
            <strong>{month.getFullYear()}年{month.getMonth() + 1}月</strong>
            <button onClick={() => shift(1)}>›</button>
          </div>
          <Calendar month={month} cards={filtered} onSelect={setSelectedId} />
        </>
      )}
    </div>
  )
}

export default App
