import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import { AddRegular } from '@fluentui/react-icons'
import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { statusColor } from './status'
import { locale, optionLabel, useT } from './i18n'

interface Props {
  month: Date
  cards: Cr854_deliverycards[]
  onSelect: (id: string) => void
  /** 日付のマスの空いているところ(または「＋」)を押したとき。その日付で新規作成する(値は YYYY-MM-DD) */
  onCreate: (day: string) => void
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
// 日曜始まり。表記は現在の言語に従う(2024-01-07 は日曜日)
const weekdays = () =>
  Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 7 + i).toLocaleDateString(locale(), { weekday: locale() === 'ja-JP' ? 'narrow' : 'short' }),
  )

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
    cursor: 'pointer',
    '@media (min-width: 900px)': { minHeight: '112px' },
    // マスにマウスを乗せたときだけ「＋」を出して、押せば新規作成できることを示す
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    ':hover .cal-add': { opacity: 1 },
  },
  dayHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  add: {
    opacity: 0,
    width: '22px',
    height: '22px',
    display: 'grid',
    placeItems: 'center',
    border: 'none',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: 'transparent',
    color: tokens.colorBrandForeground1,
    cursor: 'pointer',
    fontSize: '16px',
    ':hover': { backgroundColor: tokens.colorBrandBackground2 },
    // キーボードで移動してきたときも見えるようにする
    ':focus-visible': { opacity: 1 },
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

export function Calendar({ month, cards, onSelect, onCreate }: Props) {
  const styles = useStyles()
  const t = useT()
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
        {weekdays().map((w, i) => (
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
              onClick={() => onCreate(k)}
            >
              <div className={styles.dayHead}>
                <span className={mergeClasses(styles.dayNum, isToday && styles.today)}>{d.getDate()}</span>
                <button
                  type="button"
                  className={mergeClasses('cal-add', styles.add)}
                  onClick={(e) => {
                    e.stopPropagation()
                    onCreate(k)
                  }}
                  aria-label={t(`${d.getMonth() + 1}月${d.getDate()}日に新規作成`, `New delivery on ${d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })}`)}
                  title={t('この日に新規作成', 'New delivery on this day')}
                >
                  <AddRegular />
                </button>
              </div>
              {(byDay.get(k) ?? []).map((c) => (
                <button
                  key={c.cr854_deliverycardid}
                  type="button"
                  // マスの「新規作成」まで届かないように止める(既存のカードを開くだけ)
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect(c.cr854_deliverycardid)
                  }}
                  title={`${c.cr854_name}(${optionLabel(c.cr854_statusname)})`}
                  className={styles.pill}
                  style={{
                    backgroundColor: `color-mix(in srgb, ${statusColor(c.cr854_status)} 16%, var(--colorNeutralBackground1))`,
                    borderLeft: `3px solid ${statusColor(c.cr854_status)}`,
                  }}
                >
                  <span className={styles.pillMeta}>
                    {new Date(c.cr854_scheduledat!).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}
                    {' '}{optionLabel(c.cr854_countryname)}・{optionLabel(c.cr854_channelname)}
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
