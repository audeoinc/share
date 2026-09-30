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
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { DND_HERO, DND_ITEM, scaled, yen, type Item } from './items'
import { heroImage, productImage } from './images'
import { EMAIL_TEMPLATES, type EmailTemplateId } from './templates'

interface Props {
  channel: 'email' | 'push'
  subject: string
  theme: string
  copy: string
  items: Item[]
  products: Cr854_products[]
  selectedKey: string | null
  showHeadings: boolean
  template: EmailTemplateId
  /** 設定中のメイン画像 */
  hero?: Cr854_heroimages
  onDropHero: (heroId: string) => void
  onClearHero: () => void
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

function EmailPreview({ subject, theme, copy, items, products, selectedKey, showHeadings, template, hero, onDropHero, onClearHero, onSelect, onRemove, onMove, onDropAt }: Props) {
  const { over, handlers, clear } = useDropTarget(onDropAt)
  const [heroOver, setHeroOver] = useState(false)
  const byId = new Map(products.map((p) => [p.cr854_productid, p]))
  const tpl = EMAIL_TEMPLATES[template]
  const offer = tpl.hero === 'offer'

  // 商品にマウスを乗せたときに出る、並べ替えと削除のボタン
  const controls = (it: Item, idx: number) => (
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
  )

  const dragProps = (it: Item, idx: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DND_ITEM, it.key)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragEnd: clear,
    onClick: () => onSelect(it.key),
    ...handlers(idx),
  })

  const frame = (it: Item, idx: number) => ({
    position: 'relative',
    cursor: 'grab',
    p: 0.75,
    borderRadius: 1.5,
    border: '2px solid',
    borderColor: over === idx ? 'primary.main' : it.key === selectedKey ? '#6750a4' : 'transparent',
    bgcolor: over === idx ? 'rgba(103,80,164,0.08)' : 'transparent',
    '&:hover .remove': { opacity: 1 },
  })

  const priceEl = (price?: number) =>
    offer ? (
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap' }}>
        <Typography component="span" sx={{ fontSize: '1.05rem', fontWeight: 800, color: '#d32f2f' }}>{yen(price)}</Typography>
        <Typography component="span" sx={{ fontSize: '0.65rem', fontWeight: 700, color: '#fff', bgcolor: '#d32f2f', px: 0.75, borderRadius: 0.5 }}>
          期間限定
        </Typography>
      </Box>
    ) : (
      <Typography sx={{ fontSize: '0.8rem', fontWeight: 700, color: INK }}>{yen(price)}</Typography>
    )

  const cta = (
    <Box sx={{ mt: 0.75, py: 0.5, textAlign: 'center', bgcolor: offer ? '#d32f2f' : '#222', color: '#fff', fontSize: '0.75rem', borderRadius: 0.5 }}>
      詳細はこちら
    </Box>
  )

  const gridTile = (it: Item, idx: number) => {
    const p = byId.get(it.productId)
    return (
      <Box key={it.key} {...dragProps(it, idx)} sx={frame(it, idx)}>
        <Box component="img" draggable={false} src={productImage(p)} alt={p?.cr854_name} sx={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 1, bgcolor: '#eee', display: 'block' }} />
        <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, mt: 0.5, color: INK }} noWrap>{p?.cr854_name}</Typography>
        {priceEl(p?.cr854_price)}
        {cta}
        {controls(it, idx)}
      </Box>
    )
  }

  // 特集枠: 画像を左、商品名・説明・価格を右に大きく見せる
  const featureTile = (it: Item, idx: number) => {
    const p = byId.get(it.productId)
    return (
      <Box key={it.key} {...dragProps(it, idx)} sx={{ ...frame(it, idx), display: 'flex', gap: 1.5 }}>
        <Box component="img" draggable={false} src={productImage(p)} alt={p?.cr854_name} sx={{ width: '44%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 1, bgcolor: '#eee', display: 'block', flexShrink: 0 }} />
        <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 0.5 }}>
          <Typography sx={{ fontSize: '0.7rem', letterSpacing: 2, color: SUB }}>FEATURE</Typography>
          <Typography sx={{ fontSize: '1rem', fontWeight: 700, color: INK }}>{p?.cr854_name}</Typography>
          <Typography sx={{ fontSize: '0.8rem', color: SUB }}>{p?.cr854_description}</Typography>
          {priceEl(p?.cr854_price)}
          {cta}
        </Box>
        {controls(it, idx)}
      </Box>
    )
  }

  // 空きの枠: ここへドロップすると、末尾の空き枠から埋まる
  const emptySlot = (key: string, feature: boolean) => (
    <Box
      key={key}
      {...handlers(items.length)}
      sx={{
        aspectRatio: feature ? undefined : '3 / 4',
        minHeight: feature ? 120 : undefined,
        border: '2px dashed',
        borderColor: over === items.length ? '#6750a4' : '#bbb',
        bgcolor: over === items.length ? 'rgba(103,80,164,0.08)' : 'transparent',
        borderRadius: 1.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: SUB,
        fontSize: '0.8rem',
        textAlign: 'center',
        p: 1,
      }}
    >
      ここに商品をドロップ
    </Box>
  )

  const headingEl = (text: string) => (
    <Box sx={{ textAlign: 'center', my: 1.5 }}>
      <Typography
        component="span"
        sx={{ display: 'inline-block', border: '2px solid', borderColor: INK, px: 2, py: 0.25, fontWeight: 700, fontSize: '0.95rem', color: INK, letterSpacing: 4 }}
      >
        {text}
      </Typography>
    </Box>
  )

  // ---- ヒーロー(メイン画像 + 見出し)。種類によって装飾が変わる
  const heroBox = (
    <Box
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DND_HERO)) return
        e.preventDefault()
        setHeroOver(true)
      }}
      onDragLeave={() => setHeroOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setHeroOver(false)
        const id = e.dataTransfer.getData(DND_HERO)
        if (id) onDropHero(id)
      }}
      sx={{
        position: 'relative',
        aspectRatio: '16 / 9',
        bgcolor: heroOver ? 'rgba(103,80,164,0.15)' : '#e9e9ee',
        outline: heroOver ? '3px solid #6750a4' : 'none',
        outlineOffset: -3,
        color: '#999',
        display: 'grid',
        placeItems: 'center',
        fontSize: '0.8rem',
        '&:hover .hero-clear': { opacity: 1 },
      }}
    >
      {hero ? (
        <>
          <Box component="img" draggable={false} src={heroImage(hero)} alt={hero.cr854_name} sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          <IconButton
            className="hero-clear"
            size="small"
            onClick={onClearHero}
            aria-label="メイン画像を外す"
            sx={{ position: 'absolute', top: 8, right: 8, opacity: 0, bgcolor: 'rgba(255,255,255,0.9)', '&:hover': { bgcolor: '#fff' } }}
          >
            <CloseIcon fontSize="small" sx={{ color: INK }} />
          </IconButton>
        </>
      ) : (
        'メインビジュアル(候補から画像をドロップ)'
      )}
      {tpl.hero === 'offer' && (
        <Box sx={{ position: 'absolute', top: 12, left: 12, bgcolor: '#d32f2f', color: '#fff', fontWeight: 800, letterSpacing: 2, fontSize: '0.75rem', px: 1.25, py: 0.5, borderRadius: 0.5 }}>
          LIMITED OFFER
        </Box>
      )}
      {tpl.hero === 'collab' && (
        <Box sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, bgcolor: 'rgba(0,0,0,0.55)', color: '#fff', textAlign: 'center', letterSpacing: 4, fontSize: '0.7rem', py: 0.5 }}>
          SPECIAL COLLABORATION
        </Box>
      )}
    </Box>
  )

  const headline =
    tpl.hero === 'offer' ? (
      <Box sx={{ bgcolor: '#d32f2f', color: '#fff', px: 3, py: 2.5, textAlign: 'center' }}>
        <Typography sx={{ fontSize: '0.75rem', letterSpacing: 4, opacity: 0.9 }}>VALUE PRICE</Typography>
        <Typography sx={{ fontWeight: 800, fontSize: '1.25rem', mt: 0.5 }}>{theme || '(テーマ未入力)'}</Typography>
        <Typography sx={{ mt: 1, fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{copy || '(コピー未入力)'}</Typography>
      </Box>
    ) : tpl.hero === 'collab' ? (
      <Box sx={{ px: 3, py: 2.5, textAlign: 'center' }}>
        <Typography sx={{ fontStyle: 'italic', fontFamily: 'Georgia, serif', fontSize: '1.4rem', fontWeight: 700, color: INK }}>
          {theme || '(テーマ未入力)'}
        </Typography>
        <Box sx={{ width: 48, height: 2, bgcolor: INK, mx: 'auto', my: 1 }} />
        <Typography sx={{ color: SUB, whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>{copy || '(コピー未入力)'}</Typography>
      </Box>
    ) : (
      <Box sx={{ px: 3, py: 2.5, textAlign: 'center' }}>
        <Typography sx={{ display: 'inline-block', border: '2px solid', borderColor: INK, px: 2, py: 0.5, fontWeight: 700, fontSize: '1.05rem', color: INK }}>
          {theme || '(テーマ未入力)'}
        </Typography>
        <Typography sx={{ mt: 1.5, color: SUB, whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>{copy || '(コピー未入力)'}</Typography>
      </Box>
    )

  // ---- 本文(商品)。free は連続する同カテゴリごとに見出しを付け、それ以外はテンプレートの枠に流し込む
  let body: React.ReactNode
  if (template === 'free') {
    const runs: { category?: string; start: number; items: Item[] }[] = []
    items.forEach((it, idx) => {
      const category = byId.get(it.productId)?.cr854_categoryname
      const last = runs[runs.length - 1]
      if (last && last.category === category) last.items.push(it)
      else runs.push({ category, start: idx, items: [it] })
    })
    body = (
      <>
        {runs.map((run) => (
          <Box key={run.start} sx={{ px: 2, pb: 2 }}>
            {showHeadings && run.category && headingEl(run.category)}
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>{run.items.map((it, j) => gridTile(it, run.start + j))}</Box>
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
      </>
    )
  } else {
    // 各セクションの先頭位置(それまでの枠数の合計)
    const sections = tpl.sections.map((sec, i) => {
      const start = tpl.sections.slice(0, i).reduce((n, s) => n + s.slots, 0)
      return { sec, start, list: items.slice(start, start + sec.slots) }
    })
    const offset = tpl.sections.reduce((n, s) => n + s.slots, 0)
    const overflow = items.slice(offset)
    body = (
      <>
        {sections.map(({ sec, start, list }) => {
          const category = sec.categoryHeading ? byId.get(list[0]?.productId ?? '')?.cr854_categoryname : undefined
          const feature = sec.kind === 'feature'
          return (
            <Box key={start} sx={{ px: 2, pb: 2 }}>
              {sec.categoryHeading && headingEl(category ?? `CATEGORY ${start / sec.slots + 1}`)}
              <Box sx={{ display: 'grid', gridTemplateColumns: feature ? '1fr' : '1fr 1fr', gap: 1.5 }}>
                {Array.from({ length: sec.slots }, (_, j) =>
                  list[j] ? (feature ? featureTile(list[j], start + j) : gridTile(list[j], start + j)) : emptySlot(`e${start + j}`, feature),
                )}
              </Box>
            </Box>
          )
        })}
        {overflow.length > 0 && (
          <Box sx={{ px: 2, pb: 3 }}>
            <Typography sx={{ fontSize: '0.75rem', color: '#b26a00', bgcolor: '#fff4e0', borderRadius: 1, px: 1, py: 0.5, mb: 1 }}>
              枠外({overflow.length}件): このテンプレートの枠を超えているため、メールには載りません
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5, opacity: 0.55 }}>
              {overflow.map((it, j) => gridTile(it, offset + j))}
            </Box>
          </Box>
        )}
      </>
    )
  }

  return (
    <Box sx={{ maxWidth: 440, mx: 'auto' }}>
      <Typography variant="caption" color="text.secondary">件名: {subject || '(配信名未入力)'}</Typography>
      <Box sx={{ bgcolor: '#fff', color: INK, border: '1px solid #ddd', borderRadius: 2, overflow: 'hidden', mt: 0.5, ...scaled }}>
        <Box sx={{ bgcolor: '#222', color: '#fff', textAlign: 'center', py: 1.5, letterSpacing: 4, fontWeight: 700 }}>SHOP</Box>
        {heroBox}
        {headline}
        {body}
        <Box sx={{ bgcolor: '#f5f5f5', color: SUB, fontSize: '0.75rem', textAlign: 'center', py: 1.5 }}>配信停止はこちら</Box>
      </Box>
    </Box>
  )
}

function PushPreview({ subject, theme, copy, items, products, selectedKey, hero: pickedHero, onSelect, onRemove, onMove, onDropAt }: Props) {
  const { over, handlers, clear } = useDropTarget(onDropAt)
  const byId = new Map(products.map((p) => [p.cr854_productid, p]))
  const firstProduct = items[0] && byId.get(items[0].productId)
  // メイン画像が設定されていればそれを、なければ先頭の商品の画像を通知の画像にする
  const heroSrc = pickedHero ? heroImage(pickedHero) : productImage(firstProduct)
  const heroAlt = pickedHero?.cr854_name ?? firstProduct?.cr854_name

  return (
    <Box sx={{ maxWidth: 380, mx: 'auto', display: 'grid', gap: 2 }}>
      <Box sx={{ background: 'linear-gradient(160deg, #3b4a6b, #1d2438)', borderRadius: 4, p: 2, pt: 3, ...scaled }}>
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
        {heroSrc && (
          <Box component="img" draggable={false} src={heroSrc} alt={heroAlt} sx={{ width: 56, height: 56, borderRadius: 1.5, objectFit: 'cover', flexShrink: 0, bgcolor: '#eee' }} />
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
              <Box component="img" draggable={false} src={productImage(p)} alt="" sx={{ width: 32, height: 32, borderRadius: 1, objectFit: 'cover' }} />
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
