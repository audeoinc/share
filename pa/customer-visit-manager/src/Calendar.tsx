import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { statusColor } from './status'

interface Props {
  month: Date
  cards: Cr854_deliverycards[]
  onSelect: (id: string) => void
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

export function Calendar({ month, cards, onSelect }: Props) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const weeks = Math.ceil((first.getDay() + daysInMonth) / 7)
  const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay() + i))

  const byDay = new Map<string, Cr854_deliverycards[]>()
  for (const c of cards) {
    if (!c.cr854_scheduledat) continue
    const k = dayKey(new Date(c.cr854_scheduledat))
    byDay.set(k, [...(byDay.get(k) ?? []), c])
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.cr854_scheduledat ?? '').localeCompare(b.cr854_scheduledat ?? ''))
  }

  const today = dayKey(new Date())

  return (
    <div className="calendar">
      {WEEKDAYS.map((w) => (
        <div key={w} className="cal-head">{w}</div>
      ))}
      {days.map((d) => {
        const k = dayKey(d)
        const cls = ['cal-cell', d.getMonth() !== month.getMonth() && 'other', k === today && 'today']
        return (
          <div key={k} className={cls.filter(Boolean).join(' ')}>
            <div className="cal-day">{d.getDate()}</div>
            {(byDay.get(k) ?? []).map((c) => (
              <button
                key={c.cr854_deliverycardid}
                className="cal-item"
                style={{ borderLeftColor: statusColor(c.cr854_status) }}
                title={`${c.cr854_name}(${c.cr854_statusname ?? ''})`}
                onClick={() => onSelect(c.cr854_deliverycardid)}
              >
                <span className="cal-meta">
                  {new Date(c.cr854_scheduledat!).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                  {' '}{c.cr854_countryname}・{c.cr854_channelname}
                </span>
                <span className="cal-name">{c.cr854_name}</span>
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}
