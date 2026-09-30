import { useState } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import CloseIcon from '@mui/icons-material/Close'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import { DND_ITEM, yen, type Item } from './items'

interface Props {
  channel: 'email' | 'push'
  subject: string
  theme: string
  copy: string
  items: Item[]
  products: Cr854_products[]
  selectedKey: string | null
  showHeadings: boolean
  onSelect: (key: string) => void
  onRemove: (key: string) => void
  /** 1つ前/後ろへ移す(delta は -1 か 1) */
  onMove: (key: string, delta: number) => void
  /** index の位置へドロップされた(末尾は items.length) */
  onDropAt: (index: number, dt: DataTransfer) => void
}

// メール・プッシュは受信側の見た目なので、テーマに依らず固定の配色にする
const INK = '#222'
const SUB = '#666'

export function Preview(props: Props) {
  return props.channel === 'email' ? <EmailPreview {...props} /> : <PushPreview {...props} />
}

function useDropTarget(onDropAt: Props['onDropAt']) {
  const [over, setOver] = useState<number | null>(null)
  const handlers = (index: number) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DND_ITEM) ? 'move' : 'copy'
      setOver(index)
    },
    onDragLeave: () => setOver((o) => (o === index ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setOver(null)
      onDropAt(index, e.dataTransfer)
    },
  })
  return { over, handlers, clear: () => setOver(null) }
}

function EmailPreview({ subject, theme, copy, items, products, selectedKey, showHeadings, onSelect, onRemove, onMove, onDropAt }: Props) {
  const { over, handlers, clear } = useDropTarget(onDropAt)
  const byId = new Map(products.map((p) => [p.cr854_productid, p]))

  // 連続する同カテゴリの商品ごとに見出しを付ける(並び順はそのまま)
  const runs: { category?: string; start: number; items: Item[] }[] = []
  items.forEach((it, idx) => {
    const category = byId.get(it.productId)?.cr854_categoryname
    const last = runs[runs.length - 1]
    if (last && last.category === category) last.items.push(it)
    else runs.push({ category, start: idx, items: [it] })
  })


  const renderTile = (it: Item, idx: number) => {
            const p = byId.get(it.productId)
            const selected = it.key === selectedKey
            return (
              <Box
                key={it.key}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_ITEM, it.key)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={clear}
                onClick={() => onSelect(it.key)}
                {...handlers(idx)}
                sx={{
                  position: 'relative',
                  cursor: 'grab',
                  p: 0.75,
                  borderRadius: 1.5,
                  border: '2px solid',
                  borderColor: over === idx ? 'primary.main' : selected ? '#6750a4' : 'transparent',
                  bgcolor: over === idx ? 'rgba(103,80,164,0.08)' : 'transparent',
                  '&:hover .remove': { opacity: 1 },
                }}
              >
                <Box component="img" draggable={false} src={p?.cr854_imageurl} alt={p?.cr854_name} sx={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 1, bgcolor: '#eee', display: 'block' }} />
                <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, mt: 0.5, color: INK }} noWrap>{p?.cr854_name}</Typography>
                <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, color: INK }}>{yen(p?.cr854_price)}</Typography>
                <Box sx={{ mt: 0.75, py: 0.5, textAlign: 'center', bgcolor: '#222', color: '#fff', fontSize: '0.75rem', borderRadius: 0.5 }}>
                  詳細はこちら
                </Box>
                <Box
                  className="remove"
                  sx={{ position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', justifyContent: 'space-between', opacity: 0, pointerEvents: 'none' }}
                >
                  <Box sx={{ display: 'flex', gap: 0.5, pointerEvents: 'auto' }}>
                    <IconButton
                      size="small"
                      disabled={idx === 0}
                      onClick={(e) => {
                        e.stopPropagation()
                        onMove(it.key, -1)
                      }}
                      sx={{ bgcolor: 'rgba(255,255,255,0.9)', '&:hover': { bgcolor: '#fff' } }}
                      aria-label="前へ"
                    >
                      <ChevronLeftIcon fontSize="small" sx={{ color: INK }} />
                    </IconButton>
                    <IconButton
                      size="small"
                      disabled={idx === items.length - 1}
                      onClick={(e) => {
                        e.stopPropagation()
                        onMove(it.key, 1)
                      }}
                      sx={{ bgcolor: 'rgba(255,255,255,0.9)', '&:hover': { bgcolor: '#fff' } }}
                      aria-label="後ろへ"
                    >
                      <ChevronRightIcon fontSize="small" sx={{ color: INK }} />
                    </IconButton>
                  </Box>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(it.key)
                  }}
                  sx={{ bgcolor: 'rgba(255,255,255,0.9)', pointerEvents: 'auto', '&:hover': { bgcolor: '#fff' } }}
                  aria-label="外す"
                >
                  <CloseIcon fontSize="small" sx={{ color: INK }} />
                </IconButton>
                </Box>
              </Box>
            )
  }

  return (
    <Box sx={{ maxWidth: 440, mx: 'auto' }}>
      <Typography variant="caption" color="text.secondary">件名: {subject || '(配信名未入力)'}</Typography>
      <Box sx={{ bgcolor: '#fff', color: INK, border: '1px solid #ddd', borderRadius: 2, overflow: 'hidden', mt: 0.5 }}>
        <Box sx={{ bgcolor: '#222', color: '#fff', textAlign: 'center', py: 1.5, letterSpacing: 4, fontWeight: 700 }}>SHOP</Box>
        <Box sx={{ aspectRatio: '16 / 9', bgcolor: '#e9e9ee', color: '#999', display: 'grid', placeItems: 'center', fontSize: '0.8rem' }}>
          メインビジュアル
        </Box>
        <Box sx={{ px: 3, py: 2.5, textAlign: 'center' }}>
          <Typography
            sx={{ display: 'inline-block', border: '2px solid', borderColor: INK, px: 2, py: 0.5, fontWeight: 700, fontSize: '1.05rem', color: INK }}
          >
            {theme || '(テーマ未入力)'}
          </Typography>
          <Typography sx={{ mt: 1.5, color: SUB, whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>{copy || '(コピー未入力)'}</Typography>
        </Box>
        {runs.map((run) => (
          <Box key={run.start} sx={{ px: 2, pb: 2 }}>
            {showHeadings && run.category && (
              <Box sx={{ textAlign: 'center', my: 1.5 }}>
                <Typography
                  component="span"
                  sx={{ display: 'inline-block', border: '2px solid', borderColor: INK, px: 2, py: 0.25, fontWeight: 700, fontSize: '0.95rem', color: INK, letterSpacing: 4 }}
                >
                  {run.category}
                </Typography>
              </Box>
            )}
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
              {run.items.map((it, j) => renderTile(it, run.start + j))}
            </Box>
          </Box>
        ))}
        <Box sx={{ px: 2, pb: 3 }}>
          <Box
            {...handlers(items.length)}
            sx={{
              minHeight: items.length === 0 ? 96 : 44,
              border: '2px dashed',
              borderColor: over === items.length ? '#6750a4' : '#bbb',
              bgcolor: over === items.length ? 'rgba(103,80,164,0.08)' : 'transparent',
              borderRadius: 1.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: SUB,
              fontSize: '0.85rem',
              textAlign: 'center',
            }}
          >
            {items.length === 0 ? 'ここに商品をドロップ' : '＋ ここにドロップで末尾に追加'}
          </Box>
        </Box>
        <Box sx={{ bgcolor: '#f5f5f5', color: SUB, fontSize: '0.75rem', textAlign: 'center', py: 1.5 }}>配信停止はこちら</Box>
      </Box>
    </Box>
  )
}

function PushPreview({ subject, theme, copy, items, products, selectedKey, onSelect, onRemove, onMove, onDropAt }: Props) {
  const { over, handlers, clear } = useDropTarget(onDropAt)
  const byId = new Map(products.map((p) => [p.cr854_productid, p]))
  const hero = items[0] && byId.get(items[0].productId)

  return (
    <Box sx={{ maxWidth: 380, mx: 'auto', display: 'grid', gap: 2 }}>
      <Box sx={{ background: 'linear-gradient(160deg, #3b4a6b, #1d2438)', borderRadius: 4, p: 2, pt: 3 }}>
      <Box sx={{ bgcolor: 'rgba(245,245,248,0.96)', color: INK, borderRadius: 4, p: 1.5, display: 'flex', gap: 1.25, boxShadow: 3 }}>
        <Box sx={{ width: 36, height: 36, borderRadius: 1.5, bgcolor: '#222', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
          SHOP
        </Box>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: '0.75rem', color: SUB }}>SHOP ・ たった今</Typography>
          <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', color: INK }}>{subject || theme || '(配信名未入力)'}</Typography>
          <Typography sx={{ fontSize: '0.85rem', color: INK, whiteSpace: 'pre-wrap' }}>{copy || '(コピー未入力)'}</Typography>
          {items.length > 1 && <Typography sx={{ fontSize: '0.75rem', color: SUB, mt: 0.5 }}>ほか{items.length - 1}点</Typography>}
        </Box>
        {hero && (
          <Box component="img" draggable={false} src={hero.cr854_imageurl} alt={hero.cr854_name} sx={{ width: 56, height: 56, borderRadius: 1.5, objectFit: 'cover', flexShrink: 0, bgcolor: '#eee' }} />
        )}
      </Box>
      </Box>
      <Typography variant="caption" color="text.secondary">
        プッシュは先頭の商品が画像に使われます。ドラッグで順序を入れ替えられます。
      </Typography>
      <Box sx={{ display: 'grid', gap: 0.75 }}>
        {items.map((it, idx) => {
          const p = byId.get(it.productId)
          return (
            <Box
              key={it.key}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_ITEM, it.key)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={clear}
              onClick={() => onSelect(it.key)}
              {...handlers(idx)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                p: 0.75,
                border: 2,
                borderRadius: 1.5,
                cursor: 'grab',
                borderColor: over === idx ? 'primary.main' : it.key === selectedKey ? 'primary.main' : 'divider',
              }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ width: 16 }}>{idx + 1}</Typography>
              <Box component="img" draggable={false} src={p?.cr854_imageurl} alt="" sx={{ width: 32, height: 32, borderRadius: 1, objectFit: 'cover' }} />
              <Typography noWrap sx={{ flexGrow: 1, fontSize: '0.85rem' }}>{p?.cr854_name}</Typography>
              <IconButton
                size="small"
                disabled={idx === 0}
                onClick={(e) => {
                  e.stopPropagation()
                  onMove(it.key, -1)
                }}
                aria-label="上へ"
              >
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                disabled={idx === items.length - 1}
                onClick={(e) => {
                  e.stopPropagation()
                  onMove(it.key, 1)
                }}
                aria-label="下へ"
              >
                <ArrowDownwardIcon fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(it.key)
                }}
                aria-label="外す"
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          )
        })}
        <Box
          {...handlers(items.length)}
          sx={{
            border: '2px dashed',
            borderColor: over === items.length ? 'primary.main' : 'divider',
            borderRadius: 1.5,
            py: 1.5,
            textAlign: 'center',
            color: 'text.secondary',
            fontSize: '0.85rem',
          }}
        >
          {items.length === 0 ? 'ここに商品をドロップ' : '＋ ここにドロップで末尾に追加'}
        </Box>
      </Box>
    </Box>
  )
}
