import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components'
import {
  AddRegular,
  CalendarLtrRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
} from '@fluentui/react-icons'
import { Cr854_deliverycardsService } from './generated/services/Cr854_deliverycardsService'
import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { Cr854_productsService } from './generated/services/Cr854_productsService'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import { Cr854_heroimagesService } from './generated/services/Cr854_heroimagesService'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { Calendar } from './Calendar'
import { CardDetail } from './CardDetail'
import { loadAutoDraft, saveAutoDraft } from './settings'
import { channelOptions, countryOptions, departmentOptions, statusColor, statusOptions } from './status'

interface Filters {
  country: string
  channel: string
  department: string
  status: string
}
const noFilter: Filters = { country: '', channel: '', department: '', status: '' }

const useStyles = makeStyles({
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalXL}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow2,
  },
  headerIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
  title: {
    flexGrow: 1,
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase400,
    letterSpacing: '0.01em',
  },
  // Fluent の標準スイッチは文字の色などを細かく変えにくいので、ヘッダーの設定だけ、自前のスイッチで描く
  autoDraft: {
    display: 'flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
  },
  track: {
    position: 'relative',
    flexShrink: 0,
    width: '32px',
    height: '18px',
    boxSizing: 'border-box',
    borderRadius: tokens.borderRadiusCircular,
    border: `1.5px solid ${tokens.colorNeutralStrokeAccessible}`,
    backgroundColor: 'transparent',
    transitionProperty: 'background-color, border-color',
    transitionDuration: tokens.durationFast,
  },
  trackOn: { backgroundColor: tokens.colorBrandBackground, borderTopColor: tokens.colorBrandBackground, borderRightColor: tokens.colorBrandBackground, borderBottomColor: tokens.colorBrandBackground, borderLeftColor: tokens.colorBrandBackground },
  thumb: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '11px',
    height: '11px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralStrokeAccessible,
    transitionProperty: 'left, background-color',
    transitionDuration: tokens.durationFast,
  },
  thumbOn: { left: '16px', backgroundColor: tokens.colorNeutralForegroundOnBrand },
  autoDraftState: { fontWeight: tokens.fontWeightSemibold, minWidth: '2.2em', color: tokens.colorNeutralForeground1 },
  container: {
    width: '100%',
    boxSizing: 'border-box',
    maxWidth: '1200px',
    margin: '0 auto',
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalL}`,
  },
  center: { textAlign: 'center', padding: `${tokens.spacingVerticalXXXL} 0` },
  alert: { marginBottom: tokens.spacingVerticalL },
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
    alignItems: 'flex-end',
  },
  filterField: { minWidth: '130px' },
  count: {
    marginLeft: 'auto',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  monthRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  monthLabel: {
    minWidth: '120px',
    textAlign: 'center',
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  legend: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    marginLeft: 'auto',
    flexWrap: 'wrap',
  },
  legendPill: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    padding: `2px ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    whiteSpace: 'nowrap',
  },
  legendDot: { width: '8px', height: '8px', borderRadius: tokens.borderRadiusCircular, flexShrink: 0 },
})

function FilterSelect({ label, value, options, onChange }: {
  label: string
  value: string
  options: { value: number; label: string }[]
  onChange: (v: string) => void
}) {
  const styles = useStyles()
  return (
    <Field label={label} size="small" className={styles.filterField}>
      <Select size="small" value={value} onChange={(_, d) => onChange(d.value)}>
        <option value="">すべて</option>
        {options.map((o) => (
          <option key={o.value} value={String(o.value)}>{o.label}</option>
        ))}
      </Select>
    </Field>
  )
}

function App() {
  const styles = useStyles()
  const [cards, setCards] = useState<Cr854_deliverycards[]>([])
  const [products, setProducts] = useState<Cr854_products[]>([])
  const [heroes, setHeroes] = useState<Cr854_heroimages[]>([])
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
    Cr854_heroimagesService.getAll({ orderBy: ['cr854_imagecode asc'] })
      .then((res) => {
        if (res.success) setHeroes(res.data ?? [])
        else setError(res.error?.message ?? 'メイン画像の取得に失敗しました')
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
  const [autoDraft, setAutoDraft] = useState(loadAutoDraft)
  const filtering = Object.values(filters).some((v) => v !== '')

  return (
    <>
      <header className={styles.header}>
        <CalendarLtrRegular fontSize={24} className={styles.headerIcon} />
        <h1 className={styles.title}>配信カレンダー</h1>
        <Tooltip
          content="内容が空の配信カードを開いたとき、AIが自動で下書きを作ります(同じカードでは1回だけ)"
          relationship="description"
        >
          <button
            type="button"
            role="switch"
            aria-checked={autoDraft}
            className={styles.autoDraft}
            onClick={() => {
              setAutoDraft(!autoDraft)
              saveAutoDraft(!autoDraft)
            }}
          >
            <span className={mergeClasses(styles.track, autoDraft && styles.trackOn)}>
              <span className={mergeClasses(styles.thumb, autoDraft && styles.thumbOn)} />
            </span>
            開いたとき自動で下書き
            <span className={styles.autoDraftState}>{autoDraft ? 'オン' : 'オフ'}</span>
          </button>
        </Tooltip>
        <Button appearance="primary" size="small" icon={<AddRegular />} onClick={() => setCreating(true)}>
          新規作成
        </Button>
      </header>
      <div className={styles.container}>
        {loading && <div className={styles.center}><Spinner /></div>}
        {error && (
          <MessageBar layout="multiline" intent="error" className={styles.alert}>
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
        {!loading && !error && month && (
          <>
            <div className={styles.filterRow}>
              <FilterSelect label="国" value={filters.country} options={countryOptions} onChange={setFilter('country')} />
              <FilterSelect label="チャネル" value={filters.channel} options={channelOptions} onChange={setFilter('channel')} />
              <FilterSelect label="部署" value={filters.department} options={departmentOptions} onChange={setFilter('department')} />
              <FilterSelect label="ステータス" value={filters.status} options={statusOptions} onChange={setFilter('status')} />
              {filtering && <Button size="small" appearance="subtle" onClick={() => setFilters(noFilter)}>クリア</Button>}
              <span className={styles.count}>{filtered.length} / {cards.length} 件</span>
            </div>
            <div className={styles.monthRow}>
              <Button appearance="subtle" size="small" icon={<ChevronLeftRegular />} onClick={() => shift(-1)} aria-label="前の月" />
              <span className={styles.monthLabel}>{month.getFullYear()}年{month.getMonth() + 1}月</span>
              <Button appearance="subtle" size="small" icon={<ChevronRightRegular />} onClick={() => shift(1)} aria-label="次の月" />
              <div className={styles.legend}>
                {statusOptions.map((o) => (
                  <span key={o.value} className={styles.legendPill}>
                    <span className={styles.legendDot} style={{ backgroundColor: statusColor(o.value) }} />
                    {o.label}
                  </span>
                ))}
              </div>
            </div>
            <Calendar month={month} cards={filtered} onSelect={setSelectedId} />
          </>
        )}
      </div>
      {(selected || creating) && (
        <CardDetail
          key={selected?.cr854_deliverycardid ?? 'new'}
          card={selected}
          products={products}
          heroes={heroes}
          otherThemes={cards.filter((c) => c.cr854_deliverycardid !== selected?.cr854_deliverycardid && c.cr854_theme).map((c) => c.cr854_theme!)}
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
