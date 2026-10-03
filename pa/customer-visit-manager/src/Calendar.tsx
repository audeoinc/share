import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
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

const useStyles = makeStyles({
  root: {
    overflow: 'hidden',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
  },
  weekday: {
    textAlign: 'center',
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  sunday: { color: tokens.colorPaletteRedForeground1 },
  saturday: { color: tokens.colorBrandForeground1 },
  cell: {
    minHeight: '72px',
    padding: tokens.spacingHorizontalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    '@media (min-width: 900px)': { minHeight: '112px' },
  },
  outside: { opacity: 0.4 },
  dayNum: {
    alignSelf: 'flex-start',
    width: '24px',
    height: '24px',
    lineHeight: '24px',
    textAlign: 'center',
    borderRadius: tokens.borderRadiusCircular,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
  today: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    fontWeight: tokens.fontWeightBold,
  },
  // 状態の色は、左の線と薄い色味で示す(塗りつぶしの帯より、落ち着いて読みやすい)
  pill: {
    display: 'block',
    textAlign: 'left',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    paddingLeft: tokens.spacingHorizontalSNudge,
    paddingRight: tokens.spacingHorizontalSNudge,
    paddingTop: '3px',
    paddingBottom: '3px',
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    minWidth: 0,
    width: '100%',
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationFast,
    ':hover': { boxShadow: tokens.shadow4 },
  },
  pillMeta: {
    display: 'none',
    color: tokens.colorNeutralForeground3,
    lineHeight: 1.2,
    fontSize: tokens.fontSizeBase100,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '@media (min-width: 900px)': { display: 'block' },
  },
  pillName: {
    display: 'block',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: 1.3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})

export function Calendar({ month, cards, onSelect }: Props) {
  const styles = useStyles()
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
    <div className={styles.root}>
      <div className={styles.grid}>
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={mergeClasses(styles.weekday, i === 0 && styles.sunday, i === 6 && styles.saturday)}
          >
            {w}
          </div>
        ))}
        {days.map((d) => {
          const k = dayKey(d)
          const isToday = k === today
          return (
            <div
              key={k}
              className={mergeClasses(styles.cell, d.getMonth() !== month.getMonth() && styles.outside)}
            >
              <span className={mergeClasses(styles.dayNum, isToday && styles.today)}>{d.getDate()}</span>
              {(byDay.get(k) ?? []).map((c) => (
                <button
                  key={c.cr854_deliverycardid}
                  type="button"
                  onClick={() => onSelect(c.cr854_deliverycardid)}
                  title={`${c.cr854_name}(${c.cr854_statusname ?? ''})`}
                  className={styles.pill}
                  style={{
                    backgroundColor: `color-mix(in srgb, ${statusColor(c.cr854_status)} 16%, var(--colorNeutralBackground1))`,
                    borderLeft: `3px solid ${statusColor(c.cr854_status)}`,
                  }}
                >
                  <span className={styles.pillMeta}>
                    {new Date(c.cr854_scheduledat!).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                    {' '}{c.cr854_countryname}・{c.cr854_channelname}
                  </span>
                  <span className={styles.pillName}>{c.cr854_name}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
