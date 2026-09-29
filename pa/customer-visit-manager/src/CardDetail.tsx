import type { Cr854_deliverycards } from './generated/models/Cr854_deliverycardsModel'
import { statusColor } from './status'

// 工程レイヤー: 上から順に埋めていく(テーマ → 商品 → コピー → 制作指示)
const layers: { label: string; value: (c: Cr854_deliverycards) => string | undefined }[] = [
  { label: 'テーマ', value: (c) => c.cr854_theme },
  { label: '掲載商品', value: (c) => c.cr854_products },
  { label: 'コピー', value: (c) => c.cr854_copy },
  { label: '制作指示', value: (c) => c.cr854_instructions },
]

export function CardDetail({ card, onBack }: { card: Cr854_deliverycards; onBack: () => void }) {
  return (
    <div className="app">
      <button onClick={onBack}>← カレンダーに戻る</button>
      <h1>{card.cr854_name}</h1>
      <p>
        <span className="badge" style={{ background: statusColor(card.cr854_status) }}>
          {card.cr854_statusname ?? '-'}
        </span>{' '}
        {card.cr854_scheduledat ? new Date(card.cr854_scheduledat).toLocaleString('ja-JP') : '日時未設定'}
        {' / '}{card.cr854_countryname ?? '-'} / {card.cr854_channelname ?? '-'} / {card.cr854_departmentname ?? '-'}
      </p>
      <ol className="layers">
        {layers.map((l) => {
          const v = l.value(card)
          return (
            <li key={l.label} className={v ? 'done' : 'todo'}>
              <h2>{l.label}<small>{v ? '入力済み' : '未入力'}</small></h2>
              <div className="pre">{v || '-'}</div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
