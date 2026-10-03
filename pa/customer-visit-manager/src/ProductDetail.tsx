import { useState } from 'react'
import { Avatar, Badge, Spinner, Tab, TabList, Text, makeStyles, tokens } from '@fluentui/react-components'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import { productImage } from './images'
import { yen } from './items'
import { optionLabel, useT } from './i18n'
import { productMarket } from './market'
import { MiniChart } from './MiniChart'
import { useProductData } from './useProductData'

/** 在庫が少ないとみなす数(AI の商品選定の基準と同じ) */
const LOW_STOCK = 50

const useStyles = makeStyles({
  // タブを切り替えても、フロートの大きさが変わらないよう、高さを揃える(はみ出すときは、中でスクロール)
  root: { width: '420px', maxWidth: '90vw', minHeight: '400px', maxHeight: '80vh', overflowY: 'auto', display: 'grid', rowGap: '10px', padding: '4px', minWidth: 0, alignContent: 'start' },
  head: { display: 'flex', alignItems: 'center', columnGap: '10px', minWidth: 0 },
  avatar: { flexShrink: 0, width: '48px', height: '48px', borderRadius: tokens.borderRadiusMedium },
  title: { minWidth: 0, display: 'grid', flexGrow: 1 },
  sub: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  kpis: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: '8px' },
  kpi: { display: 'grid', rowGap: '1px', padding: '6px 8px', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2 },
  kpiLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase100 },
  kpiValue: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  section: { display: 'grid', rowGap: '4px' },
  sectionTitle: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  text: { margin: 0, fontSize: tokens.fontSizeBase200, lineHeight: '18px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  facts: { display: 'grid', gridTemplateColumns: 'minmax(56px, auto) minmax(0, 1fr)', columnGap: '10px', rowGap: '3px', margin: 0 },
  label: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  value: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground1, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' },
  center: { display: 'flex', justifyContent: 'center', padding: '24px 0' },
})

type TabId = 'trend' | 'plan' | 'details'

/** 週の開始日(YYYY-MM-DD)を「M/D」にする */
const weekLabel = (iso: string) => {
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** 商品の詳細(クリックで開くフロートの中身): 売上・在庫の推移、MD の販売方針と販促計画、商品の基本情報 */
export function ProductDetail({ product: p }: { product: Cr854_products }) {
  const t = useT()
  const s = useStyles()
  const [tab, setTab] = useState<TabId>('trend')
  const { data, loading, error } = useProductData(p.cr854_productcode)
  const market = productMarket(p)
  const weekly = data?.weekly ?? []

  // 指標: 直近 4 週の販売数と、その前の 4 週との比較。在庫で何週分売れるか。12 週の売上
  const last4 = weekly.slice(-4).reduce((n, w) => n + w.units, 0)
  const prev4 = weekly.slice(-8, -4).reduce((n, w) => n + w.units, 0)
  const change = prev4 > 0 ? Math.round(((last4 - prev4) / prev4) * 100) : undefined
  const latestStock = weekly.length > 0 ? weekly[weekly.length - 1].stock : p.cr854_stock
  const cover = last4 > 0 && latestStock !== undefined ? Math.round((latestStock / (last4 / 4)) * 10) / 10 : undefined
  const revenue = weekly.reduce((n, w) => n + w.revenue, 0)

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Avatar shape="square" image={{ src: productImage(p), alt: p.cr854_name }} name={p.cr854_name} className={s.avatar} />
        <div className={s.title}>
          <Text weight="semibold" size={300}>{p.cr854_name}</Text>
          <span className={s.sub}>{p.cr854_productcode} ・ {optionLabel(p.cr854_categoryname)} ・ {yen(p.cr854_price, market)}</span>
        </div>
        {data?.policy?.stage && <Badge size="small" appearance="tint" color="brand">{data.policy.stage}</Badge>}
      </div>

      <TabList size="small" selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as TabId)}>
        <Tab value="trend">{t('売上・在庫', 'Sales & stock')}</Tab>
        <Tab value="plan">{t('販売方針・販促', 'MD plan')}</Tab>
        <Tab value="details">{t('基本情報', 'Details')}</Tab>
      </TabList>

      {tab !== 'details' && loading && <div className={s.center}><Spinner size="small" /></div>}
      {tab !== 'details' && error && <span className={s.muted}>{error}</span>}

      {tab === 'trend' && !loading && !error && (
        weekly.length === 0 ? (
          <span className={s.muted}>{t('この商品の売上・在庫の実績は、まだありません。', 'No sales or stock data for this product yet.')}</span>
        ) : (
          <>
            <div className={s.kpis}>
              <div className={s.kpi}>
                <span className={s.kpiLabel}>{t('直近4週の販売数', 'Last 4 weeks')}</span>
                <span className={s.kpiValue}>
                  {last4}
                  {change !== undefined && (
                    <span style={{ marginLeft: 6, fontSize: tokens.fontSizeBase200, color: change >= 0 ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1 }}>
                      {change >= 0 ? '+' : ''}{change}%
                    </span>
                  )}
                </span>
              </div>
              <div className={s.kpi}>
                <span className={s.kpiLabel}>{t('在庫の持ち', 'Weeks of stock')}</span>
                <span className={s.kpiValue}>{cover !== undefined ? t(`約${cover}週`, `~${cover} wk`) : '-'}</span>
              </div>
              <div className={s.kpi}>
                <span className={s.kpiLabel}>{t('12週の売上', '12-week revenue')}</span>
                <span className={s.kpiValue}>{yen(revenue, market)}</span>
              </div>
            </div>
            <div className={s.section}>
              <span className={s.sectionTitle}>{t('週ごとの販売数', 'Weekly units sold')}</span>
              <MiniChart
                kind="bar"
                values={weekly.map((w) => w.units)}
                labels={weekly.map((w) => weekLabel(w.week))}
                format={(v) => t(`${v}個`, `${v} units`)}
                extra={(i) => `${t('売上', 'Revenue')} ${yen(weekly[i].revenue, market)}`}
              />
            </div>
            <div className={s.section}>
              <span className={s.sectionTitle}>{t('在庫の推移', 'Stock level')}</span>
              <MiniChart
                kind="line"
                values={weekly.map((w) => w.stock)}
                labels={weekly.map((w) => weekLabel(w.week))}
                format={(v) => t(`${v}個`, `${v} units`)}
                threshold={{ value: LOW_STOCK, label: t(`残少 ${LOW_STOCK}`, `Low ${LOW_STOCK}`) }}
              />
            </div>
          </>
        )
      )}

      {tab === 'plan' && !loading && !error && (
        data?.policy ? (
          <>
            <div className={s.section}>
              <span className={s.sectionTitle}>{t('MDの販売方針', 'MD sales policy')}</span>
              <p className={s.text}>{data.policy.policy || '-'}</p>
            </div>
            <div className={s.section}>
              <span className={s.sectionTitle}>{t('販促計画', 'Promotion plan')}</span>
              {data.policy.promoPeriod && <span className={s.muted}>{t('期間', 'Period')}: {data.policy.promoPeriod}</span>}
              <p className={s.text}>{data.policy.promoPlan || '-'}</p>
            </div>
          </>
        ) : (
          <span className={s.muted}>{t('この商品の販売方針は、まだ登録されていません。', 'No MD policy registered for this product yet.')}</span>
        )
      )}

      {tab === 'details' && (
        <dl className={s.facts}>
          <dt className={s.label}>{t('価格', 'Price')}</dt>
          <dd className={s.value}>{yen(p.cr854_price, market)}</dd>
          <dt className={s.label}>{t('在庫', 'Stock')}</dt>
          <dd className={s.value}>{p.cr854_stock ?? '-'}</dd>
          <dt className={s.label}>{t('売上トレンド', 'Sales trend')}</dt>
          <dd className={s.value}>{optionLabel(p.cr854_salestrendname) || '-'}</dd>
          <dt className={s.label}>{t('評価', 'Rating')}</dt>
          <dd className={s.value}>{p.cr854_rating !== undefined ? `★${p.cr854_rating}` : '-'}</dd>
          <dt className={s.label}>{t('季節', 'Season')}</dt>
          <dd className={s.value}>{optionLabel(p.cr854_seasonname) || '-'}</dd>
          <dt className={s.label}>{t('天候適性', 'Weather')}</dt>
          <dd className={s.value}>{optionLabel(p.cr854_weathername) || '-'}</dd>
          <dt className={s.label}>{t('説明', 'Description')}</dt>
          <dd className={s.value}>{p.cr854_description || '-'}</dd>
        </dl>
      )}
    </div>
  )
}
