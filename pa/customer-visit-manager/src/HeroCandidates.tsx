import { useMemo, useState } from 'react'
import { Badge, Button, Caption1, Input, Text, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components'
import { SearchRegular } from '@fluentui/react-icons'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { DND_HERO } from './items'
import { heroImage } from './images'

interface Props {
  heroes: Cr854_heroimages[]
  selectedId?: string
  onSelect: (id: string) => void
}

const useStyles = makeStyles({
  root: { display: 'grid', rowGap: '8px', minWidth: 0 },
  chips: { display: 'flex', flexWrap: 'wrap', columnGap: '4px', rowGap: '4px' },
  caption: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightRegular },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', columnGap: '8px', rowGap: '8px' },
  card: {
    position: 'relative',
    minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
    cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, ...shorthands.borderColor(tokens.colorNeutralStroke1) },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}` },
  },
  cardUsed: {
    cursor: 'default',
    backgroundColor: tokens.colorBrandBackground2,
    ...shorthands.borderColor(tokens.colorBrandStroke1),
    ':hover': { backgroundColor: tokens.colorBrandBackground2, ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  img: { width: '100%', aspectRatio: '8 / 3', objectFit: 'cover', display: 'block', backgroundColor: tokens.colorNeutralBackground3 },
  badge: { position: 'absolute', top: '6px', right: '6px' },
  info: { padding: '8px', minWidth: 0 },
  line: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
})

/** すべてのメイン画像から探す。サムネイルの一覧で、クリックするだけで設定できる(ドラッグ&ドロップでも設定できる) */
export function HeroCandidates({ heroes, selectedId, onSelect }: Props) {
  const styles = useStyles()
  const [query, setQuery] = useState('')
  const [purpose, setPurpose] = useState('')

  const purposes = useMemo(() => [...new Set(heroes.map((h) => h.cr854_purposename).filter(Boolean))] as string[], [heroes])
  const shown = heroes.filter((h) => {
    if (purpose && h.cr854_purposename !== purpose) return false
    const q = query.trim().toLowerCase()
    return !q || `${h.cr854_name} ${h.cr854_imagecode} ${h.cr854_tags ?? ''} ${h.cr854_description ?? ''}`.toLowerCase().includes(q)
  })

  return (
    <div className={styles.root}>
      <Input
        size="small"
        placeholder="画像名・タグ・説明で検索"
        value={query}
        onChange={(_, d) => setQuery(d.value)}
        contentBefore={<SearchRegular />}
      />
      <div className={styles.chips}>
        <Button size="small" shape="circular" appearance={purpose === '' ? 'primary' : 'outline'} onClick={() => setPurpose('')}>すべて</Button>
        {purposes.map((c) => (
          <Button key={c} size="small" shape="circular" appearance={purpose === c ? 'primary' : 'outline'} onClick={() => setPurpose(c === purpose ? '' : c)}>
            {c}
          </Button>
        ))}
      </div>
      <Caption1 className={styles.caption}>
        {shown.length}件 ・ クリックで設定(ドラッグ&ドロップでも設定できます)
      </Caption1>
      <div className={styles.grid}>
        {shown.map((h) => {
          const used = h.cr854_heroimageid === selectedId
          const select = () => {
            if (!used) onSelect(h.cr854_heroimageid)
          }
          return (
            <div
              key={h.cr854_heroimageid}
              role="button"
              tabIndex={0}
              title={[h.cr854_name, h.cr854_tags, h.cr854_description].filter(Boolean).join('\n')}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_HERO, h.cr854_heroimageid)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={select}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  select()
                }
              }}
              className={mergeClasses(styles.card, used && styles.cardUsed)}
            >
              <img draggable={false} src={heroImage(h)} alt={h.cr854_name} className={styles.img} />
              {used && <Badge appearance="filled" color="brand" className={styles.badge}>設定中</Badge>}
              <div className={styles.info}>
                <Text weight="semibold" size={300} truncate wrap={false} block>{h.cr854_name}</Text>
                <Caption1 className={styles.line}>
                  {h.cr854_imagecode} ・ {h.cr854_purposename} ・ {h.cr854_seasonname}
                </Caption1>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
