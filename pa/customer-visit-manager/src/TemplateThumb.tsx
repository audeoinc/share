import { makeStyles, tokens } from '@fluentui/react-components'
import { useT } from './i18n'
import { gridColumns, type HeroKind, type Section, type TemplateLayout } from './templates'

// 見取り図は、受信側のメールの見た目を写したものなので、テーマに依らず固定の配色にする
const HERO_COLOR: Record<HeroKind, string> = { standard: '#cfd2dc', collab: '#b9a9d6', offer: '#f0a5a0' }
const IMG = '#d5d9e0'
const TILE = '#e3e6eb'
const LINE = '#a3a9b4'
const INK = '#3a3f47'
const RED = '#e5484d'
const PANEL = '#eef0f3'

const useStyles = makeStyles({
  thumb: {
    flexShrink: 0,
    backgroundColor: '#fff',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    position: 'relative',
    overflow: 'hidden',
  },
  body: { display: 'grid', alignContent: 'start' },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, background: 'linear-gradient(rgba(255,255,255,0), #fff)', pointerEvents: 'none' },
  free: { color: '#888', textAlign: 'center' },
})

/** 一覧で使う、見取り図の基準の幅 */
const BASE_WIDTH = 84

/**
 * メールの構成の見取り図。ヘッダー、お知らせ帯、ヒーロー(ヘッドラインの見せ方・ボタン)、各セクション、フッターを、
 * 実際のメールに近い縦横比で描く(縦長になる)。free は、自由な並びを示す。
 * width で大きく描ける(管理画面のプレビュー用)。maxHeight を指定すると、上の部分だけを見せて、下をぼかす(一覧用)。
 * CSS の zoom ではなく寸法を掛け算するのは、zoom だと枠の幅の計算がずれるため
 */
export function TemplateThumb({ layout, free = false, width = BASE_WIDTH, maxHeight }: { layout: TemplateLayout; free?: boolean; width?: number; maxHeight?: number }) {
  const s = useStyles()
  const t = useT()
  const k = width / BASE_WIDTH
  const px = (n: number) => Math.max(1, Math.round(n * k))
  const offer = layout.hero === 'offer'
  const heroText = layout.heroText ?? 'band'

  const line = (w: string, h = 2, color = LINE) => <div style={{ height: px(h), width: w, margin: '0 auto', background: color }} />
  const pills = (n: number | undefined, outline: boolean) =>
    n ? (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)`, gap: px(3), padding: `${px(1)}px ${px(n === 1 ? 24 : 8)}px` }}>
        {Array.from({ length: n }, (_, i) => (
          <div key={i} style={{ height: px(5), borderRadius: 99, background: outline ? '#fff' : offer ? RED : '#222', border: outline ? '1px solid #222' : 'none' }} />
        ))}
      </div>
    ) : null
  // 名前・価格の 2 行(価格は、セールのヒーローのとき赤)
  const caption = (color = LINE) => (
    <div style={{ display: 'grid', gap: px(1), paddingTop: px(1) }}>
      <div style={{ height: px(1.5), width: '80%', background: color }} />
      <div style={{ height: px(1.5), width: '40%', background: offer ? RED : color }} />
    </div>
  )

  // ---- ヒーロー
  const heroBg = HERO_COLOR[layout.hero]
  const hero =
    heroText === 'overlay' ? (
      <>
        <div style={{ aspectRatio: '4 / 5', background: heroBg, display: 'grid', alignContent: 'center', gap: px(3) }}>
          {line('70%', 4, '#fff')}
          {line('50%', 4, '#fff')}
        </div>
        {line('70%')}
      </>
    ) : heroText === 'below' ? (
      <>
        <div style={{ aspectRatio: '1 / 1', background: heroBg }} />
        {line('55%', 3, INK)}
        {line('70%')}
      </>
    ) : (
      <div style={{ aspectRatio: '8 / 3', background: heroBg, position: 'relative' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '34%', background: 'rgba(0,0,0,0.28)', display: 'grid', alignContent: 'center', paddingLeft: px(4) }}>
          <div style={{ height: px(2), width: '50%', background: '#fff' }} />
        </div>
      </div>
    )

  // ---- セクション(商品の枠の形)
  const section = (sec: Section, i: number) => {
    const n = gridColumns(sec)
    const slots = Array.from({ length: sec.slots }, (_, j) => j)
    let body: React.ReactNode
    switch (sec.kind) {
      case 'photos':
        body = (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)`, gap: px(1) }}>
            {slots.map((j) => (
              <div key={j} style={{ aspectRatio: '4 / 5', background: TILE }} />
            ))}
          </div>
        )
        break
      case 'wide':
        body = slots.map((j) => (
          <div key={j} style={{ aspectRatio: '1 / 1', background: IMG, display: 'grid', alignContent: 'end', padding: px(3) }}>
            {caption('#fff')}
          </div>
        ))
        break
      case 'mosaic': {
        // 3 点で 1 組。大きい 1 点が、縦 2 行分を使う
        const groups = Array.from({ length: Math.ceil(sec.slots / 3) }, (_, g) => g)
        body = groups.map((g) => (
          <div key={g} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: px(2), aspectRatio: '1 / 1' }}>
            <div style={{ background: IMG, gridRow: '1 / 3', gridColumn: sec.flip ? 2 : 1 }} />
            <div style={{ background: TILE, gridColumn: sec.flip ? 1 : 2, gridRow: 1 }} />
            <div style={{ background: TILE, gridColumn: sec.flip ? 1 : 2, gridRow: 2 }} />
          </div>
        ))
        break
      }
      case 'story':
        // 1 点ごとに、写真と文の左右を入れ替える
        body = slots.map((j) => {
          const text = (
            <div style={{ display: 'grid', alignContent: 'center', gap: px(1.5), padding: px(3) }}>
              <div style={{ height: px(1.5), width: '45%', background: LINE }} />
              <div style={{ height: px(2), width: '85%', background: INK }} />
              <div style={{ height: px(1.5), width: '35%', background: offer ? RED : LINE }} />
              <div style={{ height: px(1.5), width: '90%', background: '#c7ccd4', marginTop: px(2) }} />
              <div style={{ height: px(1.5), width: '70%', background: '#c7ccd4' }} />
            </div>
          )
          const img = <div style={{ aspectRatio: '3 / 4', background: IMG }} />
          return (
            <div key={j} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: PANEL }}>
              {j % 2 === 0 ? (
                <>
                  {text}
                  {img}
                </>
              ) : (
                <>
                  {img}
                  {text}
                </>
              )}
            </div>
          )
        })
        break
      case 'feature':
        body = slots.map((j) => (
          <div key={j} style={{ display: 'grid', gridTemplateColumns: '44% 1fr', gap: px(3), alignItems: 'center' }}>
            <div style={{ aspectRatio: '3 / 4', background: TILE }} />
            <div style={{ display: 'grid', gap: px(1.5) }}>
              <div style={{ height: px(2), width: '80%', background: INK }} />
              <div style={{ height: px(1.5), width: '90%', background: LINE }} />
              <div style={{ height: px(1.5), width: '40%', background: offer ? RED : LINE }} />
            </div>
          </div>
        ))
        break
      default:
        body = (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)`, gap: px(2) }}>
            {slots.map((j) => (
              <div key={j}>
                <div style={{ aspectRatio: '3 / 4', background: TILE }} />
                {caption()}
              </div>
            ))}
          </div>
        )
    }
    return (
      <div key={i} style={{ display: 'grid', gap: px(2), paddingTop: px(3) }}>
        {sec.categoryHeading && line('40%', 2.5, INK)}
        {body}
        {pills(sec.buttons, true)}
      </div>
    )
  }

  return (
    <div className={s.thumb} style={{ width, ...(maxHeight ? { maxHeight } : {}) }}>
      <div className={s.body} style={{ padding: px(3), rowGap: px(3) }}>
        <div style={{ height: px(5), background: '#222' }} />
        {layout.topBar && <div style={{ height: px(4), background: '#555' }} />}
        {hero}
        {pills(layout.heroButtons, false)}
        {free ? (
          <span className={s.free} style={{ fontSize: px(10), padding: px(6) }}>{t('自由', 'Free')}</span>
        ) : (
          layout.sections.map(section)
        )}
        <div style={{ height: px(12), background: PANEL, marginTop: px(4) }} />
      </div>
      {maxHeight && <div className={s.fade} style={{ height: px(20) }} />}
    </div>
  )
}
