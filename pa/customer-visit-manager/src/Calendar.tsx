import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Paper from '@mui/material/Paper'
import Typography from '@mui/material/Typography'
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
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        {WEEKDAYS.map((w, i) => (
          <Typography
            key={w}
            variant="caption"
            align="center"
            sx={{
              py: 1,
              bgcolor: 'action.hover',
              color: i === 0 ? 'error.main' : i === 6 ? 'primary.main' : 'text.secondary',
              fontWeight: 600,
            }}
          >
            {w}
          </Typography>
        ))}
        {days.map((d) => {
          const k = dayKey(d)
          const isToday = k === today
          return (
            <Box
              key={k}
              sx={{
                minHeight: { xs: 72, md: 112 },
                p: 0.5,
                borderTop: 1,
                borderRight: 1,
                borderColor: 'divider',
                opacity: d.getMonth() === month.getMonth() ? 1 : 0.4,
                display: 'flex',
                flexDirection: 'column',
                gap: 0.5,
                minWidth: 0,
              }}
            >
              <Typography
                variant="caption"
                sx={{
                  alignSelf: 'flex-start',
                  width: 24,
                  height: 24,
                  lineHeight: '24px',
                  textAlign: 'center',
                  borderRadius: '50%',
                  ...(isToday && { bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 700 }),
                }}
              >
                {d.getDate()}
              </Typography>
              {(byDay.get(k) ?? []).map((c) => (
                <ButtonBase
                  key={c.cr854_deliverycardid}
                  onClick={() => onSelect(c.cr854_deliverycardid)}
                  title={`${c.cr854_name}(${c.cr854_statusname ?? ''})`}
                  sx={{
                    display: 'block',
                    textAlign: 'left',
                    px: 0.75,
                    py: 0.25,
                    borderRadius: 1,
                    bgcolor: statusColor(c.cr854_status),
                    color: '#fff',
                    minWidth: 0,
                    width: '100%',
                    '&:hover': { filter: 'brightness(1.1)' },
                  }}
                >
                  <Typography variant="caption" noWrap sx={{ display: { xs: 'none', md: 'block' }, opacity: 0.85, lineHeight: 1.2 }}>
                    {new Date(c.cr854_scheduledat!).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                    {' '}{c.cr854_countryname}・{c.cr854_channelname}
                  </Typography>
                  <Typography variant="caption" noWrap sx={{ display: 'block', fontWeight: 600, lineHeight: 1.3 }}>
                    {c.cr854_name}
                  </Typography>
                </ButtonBase>
              ))}
            </Box>
          )
        })}
      </Box>
    </Paper>
  )
}
