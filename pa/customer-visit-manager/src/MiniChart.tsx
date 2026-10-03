import { useState } from 'react'
import { makeStyles, tokens } from '@fluentui/react-components'

interface Props {
  /** 値(古い順) */
  values: number[]
  /** 各値の見出し(週の開始日など)。ホバーで読み出しに使う */
  labels: string[]
  kind: 'bar' | 'line'
  /** 値の表記(読み出し・上限の表示) */
  format: (v: number) => string
  /** 基準線(例: 在庫が少ないとみなす数)。指定があれば、破線で引く */
  threshold?: { value: number; label: string }
  /** ホバー時に、読み出しへ添える追加の説明(例: 売上) */
  extra?: (index: number) => string
}

const W = 360
const H = 96
const PAD = { top: 8, right: 4, bottom: 16, left: 4 }

const useStyles = makeStyles({
  root: { display: 'grid', rowGap: '2px', minWidth: 0 },
  readout: { height: '16px', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  svg: { width: '100%', height: 'auto', display: 'block', touchAction: 'none' },
  axis: { fill: tokens.colorNeutralForeground3, fontSize: '9px' },
})

/** 軽い自作のグラフ(棒 / 折れ線)。外部のライブラリは使わない。ホバーで、その週の値を読み出す */
export function MiniChart({ values, labels, kind, format, threshold, extra }: Props) {
  const s = useStyles()
  const [hover, setHover] = useState<number | null>(null)
  if (values.length === 0) return null

  const max = Math.max(...values, threshold?.value ?? 0, 1)
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const step = innerW / values.length
  const x = (i: number) => PAD.left + step * (i + 0.5)
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH
  const base = PAD.top + innerH

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    setHover(Math.max(0, Math.min(values.length - 1, Math.floor((px - PAD.left) / step))))
  }

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(values.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`
  const active = hover ?? values.length - 1

  return (
    <div className={s.root}>
      <div className={s.readout}>
        {labels[active]}: <b>{format(values[active])}</b>
        {extra ? ` ・ ${extra(active)}` : ''}
      </div>
      <svg className={s.svg} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img">
        <line x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} stroke={tokens.colorNeutralStroke1} strokeWidth="1" />
        {threshold && (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(threshold.value)} y2={y(threshold.value)} stroke={tokens.colorPaletteDarkOrangeForeground1} strokeWidth="1" strokeDasharray="3 3" />
            <text x={W - PAD.right} y={y(threshold.value) - 2} textAnchor="end" className={s.axis} style={{ fill: tokens.colorPaletteDarkOrangeForeground1 }}>
              {threshold.label}
            </text>
          </g>
        )}
        {kind === 'bar' ? (
          values.map((v, i) => (
            <rect key={i} x={x(i) - step * 0.34} y={y(v)} width={step * 0.68} height={Math.max(0, base - y(v))} rx="2" fill={i === active ? tokens.colorBrandBackground : tokens.colorBrandBackground2Pressed} />
          ))
        ) : (
          <g>
            <path d={area} fill={tokens.colorBrandBackground2} opacity="0.7" />
            <path d={line} fill="none" stroke={tokens.colorBrandBackground} strokeWidth="1.8" strokeLinejoin="round" />
            <circle cx={x(active)} cy={y(values[active])} r="3.2" fill={tokens.colorBrandBackground} />
          </g>
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={base} stroke={tokens.colorNeutralStroke1} strokeWidth="1" />}
        <text x={PAD.left} y={H - 3} className={s.axis}>{labels[0]}</text>
        <text x={W - PAD.right} y={H - 3} textAnchor="end" className={s.axis}>{labels[labels.length - 1]}</text>
      </svg>
    </div>
  )
}
