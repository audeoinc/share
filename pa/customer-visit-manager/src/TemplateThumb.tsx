import { makeStyles, tokens } from '@fluentui/react-components'
import { useT } from './i18n'
import { gridColumns, type HeroKind, type Section } from './templates'

const HERO_COLOR: Record<HeroKind, string> = { standard: '#cfd2dc', collab: '#b9a9d6', offer: '#f0a5a0' }

const useStyles = makeStyles({
  thumb: {
    width: '84px',
    flexShrink: 0,
    backgroundColor: '#fff',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: '4px',
    display: 'grid',
    rowGap: '4px',
    alignContent: 'start',
  },
  free: { color: '#888', fontSize: '10px', textAlign: 'center' },
})

/** メールの構成の見取り図(ヒーロー、見出し、商品の枠)。free は、自由な並びを示す */
export function TemplateThumb({ hero, sections, free = false }: { hero: HeroKind; sections: Section[]; free?: boolean }) {
  const s = useStyles()
  const t = useT()
  return (
    <div className={s.thumb}>
      <div style={{ height: 24, background: HERO_COLOR[hero] }} />
      <div style={{ height: 4, width: '60%', margin: '0 auto', background: '#8a8f98' }} />
      {free ? (
        <span className={s.free}>{t('自由', 'Free')}</span>
      ) : (
        sections.map((sec, i) => (
          <div key={i}>
            {sec.categoryHeading && <div style={{ height: 3, width: '45%', margin: '0 auto 4px', background: '#555' }} />}
            <div style={{ display: 'grid', gridTemplateColumns: sec.kind === 'feature' ? '1fr' : `repeat(${gridColumns(sec)}, 1fr)`, gap: 2 }}>
              {Array.from({ length: sec.slots }, (_, k) => (
                <div key={k} style={{ height: sec.kind === 'feature' ? 10 : gridColumns(sec) === 3 ? 10 : 14, background: '#e0e0e6' }} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
