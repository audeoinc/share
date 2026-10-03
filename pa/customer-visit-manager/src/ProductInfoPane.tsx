import { Avatar, Badge, Popover, PopoverSurface, PopoverTrigger, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import { productImage } from './images'
import { yen, type Item } from './items'
import { optionLabel, useT } from './i18n'
import { productMarket } from './market'
import { sectionRange, sectionsOf, type EmailTemplateId } from './templates'

interface Props {
  template: EmailTemplateId
  sectionTitles: string[]
  items: Item[]
  products: Cr854_products[]
  /** 行にマウスが乗ったとき(プレビューの該当商品を光らせるため)。外れたら null */
  onHover: (key: string | null) => void
}

/** 在庫が少ないとみなす数(AI の商品選定の基準と同じ) */
const LOW_STOCK = 50

const useStyles = makeStyles({
  root: { display: 'grid', rowGap: '10px', minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', columnGap: '8px', minWidth: 0 },
  caption: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '6px',
    paddingBottom: '4px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    minWidth: 0,
  },
  list: { display: 'grid', minWidth: 0 },
  // 一覧の1行: 一覧性を高めるため、画像・名前・コード・価格・在庫・トレンドだけを、2行で見せる
  item: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '8px',
    padding: '6px 4px',
    minWidth: 0,
    cursor: 'pointer',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
  },
  itemOpen: { backgroundColor: tokens.colorBrandBackground2 },
  avatar: { flexShrink: 0, width: '32px', height: '32px', borderRadius: tokens.borderRadiusMedium },
  main: { minWidth: 0, flexGrow: 1, display: 'grid' },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  sub: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  trend: { flexShrink: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, width: '16px', textAlign: 'center' },
  // フロート(クリックで出る詳細)
  float: { width: '340px', maxWidth: '90vw', display: 'grid', rowGap: '10px', padding: '4px' },
  floatHead: { display: 'flex', alignItems: 'center', columnGap: '10px', minWidth: 0 },
  floatAvatar: { flexShrink: 0, width: '48px', height: '48px', borderRadius: tokens.borderRadiusMedium },
  facts: { display: 'grid', gridTemplateColumns: 'minmax(56px, auto) minmax(0, 1fr)', columnGap: '10px', rowGap: '3px', margin: 0 },
  label: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  value: { margin: 0, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground1, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' },
})

/** 売上トレンドの矢印と色 */
function trendMark(name?: string): { mark: string; color: string } {
  if (name === '上昇') return { mark: '↑', color: tokens.colorPaletteGreenForeground1 }
  if (name === '下降') return { mark: '↓', color: tokens.colorPaletteRedForeground1 }
  return { mark: '→', color: tokens.colorNeutralForeground3 }
}

/**
 * 商品情報: プレビューに載っている商品を、メールの並び順に、コンパクトな一覧で見るための参照用のペイン。
 * 行を押すと、詳細がフロートで開く(今後は、売上・在庫の推移などのグラフもここに載せる)。
 * 操作(選ぶ・並べ替え・直す)は、中ペインで行う。ここには、操作する部品を置かない。
 */
export function ProductInfoPane({ template, sectionTitles, items, products, onHover }: Props) {
  const t = useT()
  const s = useStyles()
  const productById = new Map(products.map((p) => [p.cr854_productid, p]))
  const sections = sectionsOf(template)

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Text weight="semibold" size={300}>{t('商品情報', 'Product info')}</Text>
        <Badge size="small" appearance="tint" color="informative">{items.length}</Badge>
      </div>
      <span className={s.caption}>{t('メールに載せる商品の一覧です。行を押すと詳細が開きます。', 'Products in the email. Click a row for details.')}</span>

      {items.length === 0 && <span className={s.caption}>{t('まだ商品が選定されていません。', 'No products selected yet.')}</span>}

      {sections.map((sec) => {
        const [from, to] = sectionRange(sections, sec, items.length)
        const list = items.slice(from, to)
        if (list.length === 0) return null
        const label = sec.wantTitle ? sectionTitles[sec.index] || sec.label : sec.label
        return (
          <section key={sec.index}>
            <div className={s.sectionHead}>
              <Text weight="semibold" size={200}>{label}</Text>
              <Badge size="small" appearance="outline" color="informative">{list.length}</Badge>
            </div>
            <div className={s.list}>
              {list.map((it) => {
                const p = productById.get(it.productId)
                return p ? <ProductItem key={it.key} product={p} itemKey={it.key} onHover={onHover} /> : null
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function ProductItem({ product: p, itemKey, onHover }: { product: Cr854_products; itemKey: string; onHover: (key: string | null) => void }) {
  const t = useT()
  const s = useStyles()
  const market = productMarket(p)
  const trend = trendMark(p.cr854_salestrendname)
  const low = p.cr854_stock !== undefined && p.cr854_stock < LOW_STOCK
  return (
    <Popover positioning="before" withArrow openOnHover={false}>
      <PopoverTrigger disableButtonEnhancement>
        <div className={mergeClasses(s.item)} onMouseEnter={() => onHover(itemKey)} onMouseLeave={() => onHover(null)} role="button" tabIndex={0}>
          <Avatar shape="square" image={{ src: productImage(p), alt: p.cr854_name }} name={p.cr854_name} className={s.avatar} />
          <div className={s.main}>
            <Text size={200} weight="semibold" className={s.name}>{p.cr854_name}</Text>
            <span className={s.sub}>
              {p.cr854_productcode} ・ {yen(p.cr854_price, market)} ・ {t('在庫', 'Stock ')}{p.cr854_stock ?? '-'}
            </span>
          </div>
          {low && <Badge size="small" appearance="tint" color="warning">{t('残少', 'Low')}</Badge>}
          <span className={s.trend} style={{ color: trend.color }} title={optionLabel(p.cr854_salestrendname)}>{trend.mark}</span>
        </div>
      </PopoverTrigger>
      <PopoverSurface>
        <div className={s.float}>
          <div className={s.floatHead}>
            <Avatar shape="square" image={{ src: productImage(p), alt: p.cr854_name }} name={p.cr854_name} className={s.floatAvatar} />
            <div className={s.main}>
              <Text weight="semibold" size={300}>{p.cr854_name}</Text>
              <span className={s.sub}>{p.cr854_productcode}</span>
            </div>
          </div>
          <dl className={s.facts}>
            <dt className={s.label}>{t('カテゴリ', 'Category')}</dt>
            <dd className={s.value}>{optionLabel(p.cr854_categoryname) || '-'}</dd>
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
        </div>
      </PopoverSurface>
    </Popover>
  )
}
