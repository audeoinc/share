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
  free: { color: '#888', textAlign: 'center' },
})

/** 一覧で使う、見取り図の基準の幅 */
const BASE_WIDTH = 84

/**
 * メールの構成の見取り図(ヒーロー、見出し、商品の枠)。free は、自由な並びを示す。
 * width で大きく描ける(管理画面のプレビュー用)。CSS の zoom ではなく寸法を掛け算するのは、zoom だと枠の幅の計算がずれるため
 */
export function TemplateThumb({ hero, sections, free = false, width = BASE_WIDTH }: { hero: HeroKind; sections: Section[]; free?: boolean; width?: number }) {
  const s = useStyles()
  const t = useT()
  const k = width / BASE_WIDTH
  const px = (n: number) => Math.round(n * k)
  return (
    <div className={s.thumb} style={{ width, padding: px(4), rowGap: px(4) }}>
      <div style={{ height: px(24), background: HERO_COLOR[hero] }} />
      <div style={{ height: px(4), width: '60%', margin: '0 auto', background: '#8a8f98' }} />
      {free ? (
        <span className={s.free} style={{ fontSize: px(10) }}>{t('自由', 'Free')}</span>
      ) : (
        sections.map((sec, i) => (
          <div key={i}>
            {sec.categoryHeading && <div style={{ height: px(3), width: '45%', margin: `0 auto ${px(4)}px`, background: '#555' }} />}
            <div style={{ display: 'grid', gridTemplateColumns: sec.kind === 'feature' ? '1fr' : `repeat(${gridColumns(sec)}, 1fr)`, gap: px(2) }}>
              {Array.from({ length: sec.slots }, (_, j) => (
                <div key={j} style={{ height: px(sec.kind === 'feature' ? 10 : gridColumns(sec) === 3 ? 10 : 14), background: '#e0e0e6' }} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
