import { useMemo, useState } from 'react'
import { Avatar, Badge, Button, Caption1, Input, Text, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components'
import { AddRegular, DismissRegular, SearchRegular } from '@fluentui/react-icons'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import { DND_PRODUCT, yen } from './items'
import { productMarket } from './market'
import { optionLabel, useT } from './i18n'
import { productImage } from './images'

interface Props {
  products: Cr854_products[]
  usedIds: Set<string>
  onAdd: (productId: string) => void
}

const useStyles = makeStyles({
  root: { display: 'grid', rowGap: '8px', minWidth: 0 },
  chips: { display: 'flex', flexWrap: 'wrap', columnGap: '4px', rowGap: '4px' },
  caption: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightRegular },
  item: {
    display: 'flex',
    columnGap: '10px',
    alignItems: 'center',
    padding: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'grab',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, ...shorthands.borderColor(tokens.colorNeutralStroke1) },
  },
  itemUsed: {
    opacity: 0.45,
    cursor: 'default',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1, ...shorthands.borderColor(tokens.colorNeutralStroke2) },
  },
  body: { flexGrow: 1, minWidth: 0 },
  line: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
})

/** 一度に表示する件数(商品が大量でも、重くならないように)。続きは「さらに表示」で出す */
const PAGE = 20

const trendMark = (label?: string) => (label === '上昇' ? '▲ ' : label === '下降' ? '▼ ' : '— ') + optionLabel(label === '上昇' || label === '下降' ? label : '横ばい')

export function Candidates({ products, usedIds, onAdd }: Props) {
  const t = useT()
  const styles = useStyles()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const categories = useMemo(() => [...new Set(products.map((p) => p.cr854_categoryname).filter(Boolean))] as string[], [products])
  // 商品が大量にあるので、検索語かカテゴリを指定するまでは、一覧を出さない
  const searching = query.trim() !== '' || category !== ''
  const matched = useMemo(() => {
    if (!searching) return []
    const q = query.trim().toLowerCase()
    return products.filter((p) => {
      if (category && p.cr854_categoryname !== category) return false
      return !q || `${p.cr854_name} ${p.cr854_productcode} ${p.cr854_description ?? ''}`.toLowerCase().includes(q)
    })
  }, [products, query, category, searching])
  const shown = matched.slice(0, limit)

  return (
    <div className={styles.root}>
      <Input
        size="small"
        placeholder={t('商品名・コード・説明で検索', 'Search by name, code or description')}
        value={query}
        onChange={(_, d) => {
          setQuery(d.value)
          setLimit(PAGE)
        }}
        contentBefore={<SearchRegular />}
        contentAfter={
          query ? (
            <Button size="small" appearance="transparent" icon={<DismissRegular />} onClick={() => setQuery('')} aria-label={t('検索語を消す', 'Clear search')} />
          ) : undefined
        }
      />
      <div className={styles.chips}>
        <Button size="small" shape="circular" appearance={category === '' ? 'primary' : 'outline'} onClick={() => { setCategory(''); setLimit(PAGE) }}>{t('すべて', 'All')}</Button>
        {categories.map((c) => (
          <Button key={c} size="small" shape="circular" appearance={category === c ? 'primary' : 'outline'} onClick={() => { setCategory(c === category ? '' : c); setLimit(PAGE) }}>
            {optionLabel(c)}
          </Button>
        ))}
      </div>
      {!searching ? (
        <Caption1 className={styles.caption}>
          {t(`商品名・コードで検索するか、カテゴリを選ぶと、商品が表示されます(対象 ${products.length}件)。`, `Search by name or code, or pick a category, to see products (${products.length} available).`)}
        </Caption1>
      ) : (
        <Caption1 className={styles.caption}>
          {t(`${matched.length}件`, `${matched.length} items`)} ・ {t('右のプレビューへドラッグして掲載', 'Drag to the preview on the right to include')}
        </Caption1>
      )}
      {searching && matched.length === 0 && <Caption1 className={styles.caption}>{t('該当する商品がありません。', 'No matching products.')}</Caption1>}
      {shown.map((p) => {
        const used = usedIds.has(p.cr854_productid)
        return (
          <div
            key={p.cr854_productid}
            draggable={!used}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_PRODUCT, p.cr854_productid)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            className={mergeClasses(styles.item, used && styles.itemUsed)}
          >
            <Avatar shape="square" size={48} name={p.cr854_name} image={{ src: productImage(p), alt: p.cr854_name }} />
            <div className={styles.body}>
              <Text weight="semibold" size={300} truncate wrap={false} block>{p.cr854_name}</Text>
              <Caption1 className={styles.line}>
                {p.cr854_productcode} ・ {yen(p.cr854_price, productMarket(p))} ・ {t('在庫', 'Stock ')}{p.cr854_stock ?? '-'}
              </Caption1>
              <Caption1 className={styles.line}>
                {trendMark(p.cr854_salestrendname)} ・ ★{p.cr854_rating ?? '-'} ・ {optionLabel(p.cr854_weathername)}
              </Caption1>
            </div>
            {used ? (
              <Badge appearance="tint" color="informative">{t('掲載中', 'Included')}</Badge>
            ) : (
              <Button size="small" appearance="subtle" icon={<AddRegular />} onClick={() => onAdd(p.cr854_productid)} aria-label={t('追加', 'Add')} />
            )}
          </div>
        )
      })}
      {matched.length > shown.length && (
        <Button size="small" appearance="outline" onClick={() => setLimit(limit + PAGE)}>
          {t(`さらに表示(残り ${matched.length - shown.length}件)`, `Show more (${matched.length - shown.length} left)`)}
        </Button>
      )}
    </div>
  )
}
