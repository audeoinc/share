import { useLayoutEffect, useRef, useState } from 'react'
import { Button, Input, ToggleButton, makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import {
  ArrowDownRegular,
  ArrowUpRegular,
  ChevronLeftRegular,
  ChevronRightRegular,
  DismissRegular,
} from '@fluentui/react-icons'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { AutoTextarea } from './AutoTextarea'
import { DND_HERO, DND_ITEM, scaled, yen, type Item } from './items'
import { heroImage, productImage } from './images'
import { EMAIL_TEMPLATES, type EmailTemplateId } from './templates'
import { HEADLINE_FONT } from './fonts'

interface Props {
  channel: 'email' | 'push'
  subject: string
  /** メイン画像に載せる大見出し */
  headline: string
  copy: string
  items: Item[]
  products: Cr854_products[]
  selectedKey: string | null
  showHeadings: boolean
  template: EmailTemplateId
  /** 配信日時(ロック画面の時計に使う) */
  scheduledAt: string
  /** true のとき、画像を小さくした表示(プッシュのメッセージ用) */
  compact?: boolean
  /** カテゴリ系テンプレートの見出し(セクションの順) */
  sectionTitles: string[]
  onSectionTitle: (index: number, text: string) => void
  /** 各セクションのコピー(セクションの順) */
  sectionCopies: string[]
  onSectionCopy: (index: number, text: string) => void
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
const ACCENT = '#6750a4'
const ACCENT_BG = 'rgba(103,80,164,0.08)'

const useStyles = makeStyles({
  fit: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  controls: {
    position: 'absolute',
    top: '8px',
    left: '8px',
    right: '8px',
    display: 'flex',
    justifyContent: 'space-between',
    opacity: 0,
    pointerEvents: 'none',
  },
  controlsGroup: { display: 'flex', gap: '4px', pointerEvents: 'auto' },
  ctlRight: { pointerEvents: 'auto' },
  ctl: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    color: INK,
    '&:hover': { backgroundColor: '#fff', color: INK },
    '&:hover:active': { backgroundColor: '#fff', color: INK },
  },
  heroClear: { position: 'absolute', top: '8px', right: '8px', opacity: 0 },
  frame: {
    position: 'relative',
    cursor: 'grab',
    padding: '6px',
    borderRadius: '12px',
    border: '2px solid transparent',
    '&:hover .remove': { opacity: 1 },
  },
  featureFrame: { display: 'flex', gap: '12px' },
  featureBody: { flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '4px' },
  img: { objectFit: 'cover', borderRadius: '8px', backgroundColor: '#eee', display: 'block' },
  noWrap: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  slot: {
    border: '2px dashed #bbb',
    borderRadius: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: SUB,
    textAlign: 'center',
  },
  hero: {
    position: 'relative',
    containerType: 'inline-size',
    color: '#999',
    display: 'grid',
    placeItems: 'center',
    fontSize: '12.8px',
    '&:hover .hero-clear': { opacity: 1 },
  },
  headingInput: {
    border: `2px solid ${INK}`,
    borderRadius: 0,
    backgroundColor: 'transparent',
    color: INK,
    maxWidth: '100%',
    '::after': { display: 'none' },
  },
  copyTextarea: {
    width: '100%',
    border: 'none',
    backgroundColor: 'transparent',
    '::after': { display: 'none' },
    '& textarea::placeholder': { opacity: 0.6 },
  },
  pushRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px',
    border: '2px solid',
    borderRadius: '12px',
    cursor: 'grab',
  },
  pushDrop: {
    border: '2px dashed',
    borderRadius: '12px',
    padding: '12px 0',
    textAlign: 'center',
    color: tokens.colorNeutralForeground2,
    fontSize: '13.6px',
  },
})

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

/** 1 行に必ず収まる文字。はみ出すときだけ、フォントサイズを縮める(下限 minScale。それでも収まらなければ「…」で省略) */
function FitLine({ baseSize, minScale = 0.55, style, children }: { baseSize: string; minScale?: number; style?: React.CSSProperties; children: string }) {
  const classes = useStyles()
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      // 実寸で測る: 縮尺 1 に戻して、はみ出し具合(表示幅 / 文字の幅)の分だけ縮める。文字の幅は、フォントサイズに比例する
      el.style.setProperty('--fit', '1')
      const ratio = el.scrollWidth > 0 ? el.clientWidth / el.scrollWidth : 1
      el.style.setProperty('--fit', String(Math.max(minScale, Math.min(1, ratio))))
    }
    fit()
    const ro = new ResizeObserver(fit) // 表示幅が変わったとき(ペインの幅の変更など)
    ro.observe(el)
    document.fonts?.ready.then(fit) // フォントの読み込みで、文字の幅が変わったとき
    document.fonts?.addEventListener?.('loadingdone', fit)
    return () => {
      ro.disconnect()
      document.fonts?.removeEventListener?.('loadingdone', fit)
    }
  }, [children, minScale])

  return (
    <div ref={ref} className={classes.fit} style={{ fontSize: `calc(${baseSize} * var(--fit, 1))`, ...style }}>
      {children}
    </div>
  )
}

function EmailPreview({ subject, headline, copy, items, products, selectedKey, showHeadings, template, sectionTitles, onSectionTitle, sectionCopies, onSectionCopy, compact = false, hero, onDropHero, onClearHero, onSelect, onRemove, onMove, onDropAt }: Props) {
  const classes = useStyles()
  const { over, handlers, clear } = useDropTarget(onDropAt)
  const [heroOver, setHeroOver] = useState(false)
  const byId = new Map(products.map((p) => [p.cr854_productid, p]))
  const tpl = EMAIL_TEMPLATES[template]
  const offer = tpl.hero === 'offer'
  const hf = HEADLINE_FONT

  // 商品にマウスを乗せたときに出る、並べ替えと削除のボタン
  const controls = (it: Item, idx: number) => (
    <div className={mergeClasses('remove', classes.controls)}>
      <div className={classes.controlsGroup}>
        <Button
          className={classes.ctl}
          appearance="subtle"
          size="small"
          icon={<ChevronLeftRegular />}
          disabled={idx === 0}
          onClick={(e) => {
            e.stopPropagation()
            onMove(it.key, -1)
          }}
          aria-label="前へ"
        />
        <Button
          className={classes.ctl}
          appearance="subtle"
          size="small"
          icon={<ChevronRightRegular />}
          disabled={idx === items.length - 1}
          onClick={(e) => {
            e.stopPropagation()
            onMove(it.key, 1)
          }}
          aria-label="後ろへ"
        />
      </div>
      <Button
        className={mergeClasses(classes.ctl, classes.ctlRight)}
        appearance="subtle"
        size="small"
        icon={<DismissRegular />}
        onClick={(e) => {
          e.stopPropagation()
          onRemove(it.key)
        }}
        aria-label="外す"
      />
    </div>
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

  const frameStyle = (it: Item, idx: number): React.CSSProperties => ({
    borderColor: over === idx ? tokens.colorBrandForeground1 : it.key === selectedKey ? ACCENT : 'transparent',
    backgroundColor: over === idx ? 'rgba(103,80,164,0.08)' : 'transparent',
  })

  const priceEl = (price?: number) =>
    offer ? (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#d32f2f' }}>{yen(price)}</span>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#fff', backgroundColor: '#d32f2f', padding: '0 6px', borderRadius: 4 }}>
          期間限定
        </span>
      </div>
    ) : (
      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: INK }}>{yen(price)}</div>
    )

  const cta = (
    <div style={{ marginTop: 6, padding: '4px 0', textAlign: 'center', backgroundColor: offer ? '#d32f2f' : '#222', color: '#fff', fontSize: '0.75rem', borderRadius: 4 }}>
      詳細はこちら
    </div>
  )

  const gridTile = (it: Item, idx: number) => {
    const p = byId.get(it.productId)
    return (
      <div key={it.key} {...dragProps(it, idx)} className={classes.frame} style={frameStyle(it, idx)}>
        <img className={classes.img} draggable={false} src={productImage(p)} alt={p?.cr854_name} style={{ width: '100%', aspectRatio: compact ? '1 / 1' : '3 / 4' }} />
        <div className={classes.noWrap} style={{ fontSize: '0.85rem', fontWeight: 600, marginTop: 4, color: INK }}>{p?.cr854_name}</div>
        {priceEl(p?.cr854_price)}
        {cta}
        {controls(it, idx)}
      </div>
    )
  }

  // 特集枠: 画像を左、商品名・説明・価格を右に大きく見せる
  const featureTile = (it: Item, idx: number) => {
    const p = byId.get(it.productId)
    return (
      <div key={it.key} {...dragProps(it, idx)} className={mergeClasses(classes.frame, classes.featureFrame)} style={frameStyle(it, idx)}>
        <img className={classes.img} draggable={false} src={productImage(p)} alt={p?.cr854_name} style={{ width: compact ? '30%' : '44%', aspectRatio: compact ? '1 / 1' : '3 / 4', flexShrink: 0 }} />
        <div className={classes.featureBody}>
          <div style={{ fontSize: '0.7rem', letterSpacing: 2, color: SUB }}>FEATURE</div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: INK }}>{p?.cr854_name}</div>
          <div style={{ fontSize: '0.8rem', color: SUB }}>{p?.cr854_description}</div>
          {priceEl(p?.cr854_price)}
          {cta}
        </div>
        {controls(it, idx)}
      </div>
    )
  }

  // 空きの枠: ここへドロップすると、末尾の空き枠から埋まる
  const emptySlot = (key: string, feature: boolean) => (
    <div
      key={key}
      {...handlers(items.length)}
      className={classes.slot}
      style={{
        aspectRatio: feature ? undefined : compact ? '1 / 1' : '3 / 4',
        minHeight: feature ? 120 : undefined,
        borderColor: over === items.length ? ACCENT : '#bbb',
        backgroundColor: over === items.length ? ACCENT_BG : 'transparent',
        fontSize: '0.8rem',
        padding: 8,
      }}
    >
      ここに商品をドロップ
    </div>
  )

  const headingEl = (text: string) => (
    <div style={{ textAlign: 'center', margin: '12px 0' }}>
      <span style={{ display: 'inline-block', border: `2px solid ${INK}`, padding: '2px 16px', fontWeight: 700, fontSize: '0.95rem', color: INK, letterSpacing: 4 }}>
        {text}
      </span>
    </div>
  )

  // カテゴリ系テンプレートの見出し。クリックして書き換えられる(未設定なら商品カテゴリ名を出す)
  const editableHeading = (index: number, fallback: string) => {
    const value = sectionTitles[index] !== undefined ? sectionTitles[index] : fallback
    return (
      <div style={{ textAlign: 'center', margin: '12px 0' }}>
        <Input
          className={classes.headingInput}
          appearance="outline"
          value={value}
          onChange={(_, d) => onSectionTitle(index, d.value)}
          input={{ 'aria-label': `セクション${index + 1}の見出し`, style: { textAlign: 'center', fontWeight: 700, fontSize: '0.95rem', letterSpacing: 2, color: INK } }}
          style={{ width: `${Math.max(10, value.length * 2 + 4)}ch` }}
        />
      </div>
    )
  }

  // セクションのコピー。クリックして書き換えられる(見出しの下、商品の上に入る)
  // hasHeading: カテゴリ見出しの直下かどうか。見出しがないときは、メイン画像から離す(コピーは、直下の商品に寄せる)
  const sectionCopyEl = (index: number, hasHeading: boolean) => {
    const text = sectionCopies[index] ?? ''
    return (
      <div style={{ textAlign: 'center', marginTop: hasHeading ? 6 : 22, marginBottom: 4, padding: '0 8px' }}>
        <AutoTextarea
          className={classes.copyTextarea}
          appearance="outline"
          rows={Math.max(1, text.split('\n').length)}
          value={text}
          onChange={(_, d) => onSectionCopy(index, d.value)}
          placeholder="(セクションのコピー)"
          textarea={{ 'aria-label': `セクション${index + 1}のコピー`, style: { textAlign: 'center', fontSize: '0.85rem', color: SUB, letterSpacing: 0.5, paddingTop: 2, paddingBottom: 2, minHeight: 0 } }}
        />
      </div>
    )
  }

  // ---- ヒーロー(メイン画像 + 見出し)。種類によって装飾が変わる
  const heroBox = (
    <div
      className={classes.hero}
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
      style={{
        aspectRatio: compact ? '3 / 1' : '8 / 3',
        backgroundColor: heroOver ? 'rgba(103,80,164,0.15)' : '#e9e9ee',
        outline: heroOver ? `3px solid ${ACCENT}` : 'none',
        outlineOffset: -3,
      }}
    >
      {hero ? (
        <>
          <img draggable={false} src={heroImage(hero)} alt={hero.cr854_name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          <Button
            className={mergeClasses('hero-clear', classes.heroClear, classes.ctl)}
            appearance="subtle"
            size="small"
            icon={<DismissRegular />}
            onClick={onClearHero}
            aria-label="メイン画像を外す"
          />
        </>
      ) : (
        'メインビジュアル(候補から画像をドロップ)'
      )}
      {tpl.hero === 'offer' && (
        <div style={{ position: 'absolute', top: 12, left: 12, backgroundColor: '#d32f2f', color: '#fff', fontWeight: 800, letterSpacing: 2, fontSize: '0.75rem', padding: '4px 10px', borderRadius: 4 }}>
          LIMITED OFFER
        </div>
      )}
      {tpl.hero === 'collab' && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)', color: '#fff', textAlign: 'center', letterSpacing: 4, fontSize: '0.7rem', padding: '4px 0' }}>
          SPECIAL COLLABORATION
        </div>
      )}
      {/* ヘッドライン: 画像の下部に半透明の帯を敷いて、左寄せの太字で載せる */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: `${compact ? '1.2cqw' : '2.2cqw'} 5cqw`,
          backgroundColor: 'rgba(0,0,0,0.42)',
          color: '#fff',
          textAlign: 'left',
          pointerEvents: 'none',
        }}
      >
        {/* 日英どちらも 1 行に収める: 長いときは、文字を縮める(下限は 0.4 倍) */}
        <FitLine
          baseSize={`calc(${compact ? '4.2cqw' : '5cqw'} * ${hf.scale})`}
          minScale={0.4}
          style={{
            fontFamily: hf.family,
            fontWeight: hf.weight,
            // 日本語を含むヘッドラインは、字間を狭める
            letterSpacing: /[\u3000-\u9fff\uff00-\uffef]/.test(headline) ? hf.trackingJa : hf.tracking,
            textTransform: hf.upper ? 'uppercase' : 'none',
            lineHeight: 1.2,
          }}
        >
          {headline || '(ヘッドライン未入力)'}
        </FitLine>
        <FitLine
          baseSize={compact ? '2.6cqw' : '2.9cqw'}
          style={{ marginTop: '0.8cqw', fontFamily: hf.family, fontWeight: 400, letterSpacing: '0.06em', lineHeight: 1.5, opacity: 0.95 }}
        >
          {copy || '(コピー未入力)'}
        </FitLine>
      </div>
    </div>
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
          <div key={run.start} style={{ padding: '0 16px 16px' }}>
            {showHeadings && run.category && headingEl(run.category)}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{run.items.map((it, j) => gridTile(it, run.start + j))}</div>
          </div>
        ))}
        <div style={{ padding: '0 16px 24px' }}>
          <div
            {...handlers(items.length)}
            className={classes.slot}
            style={{
              minHeight: items.length === 0 ? 96 : 44,
              borderColor: over === items.length ? ACCENT : '#bbb',
              backgroundColor: over === items.length ? ACCENT_BG : 'transparent',
              fontSize: '0.85rem',
            }}
          >
            {items.length === 0 ? 'ここに商品をドロップ' : '＋ ここにドロップで末尾に追加'}
          </div>
        </div>
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
        {sections.map(({ sec, start, list }, si) => {
          const category = sec.categoryHeading ? byId.get(list[0]?.productId ?? '')?.cr854_categoryname : undefined
          const feature = sec.kind === 'feature'
          return (
            <div key={start} style={{ padding: '0 16px 16px' }}>
              {sec.categoryHeading && editableHeading(si, category ?? `CATEGORY ${si + 1}`)}
              {sectionCopyEl(si, !!sec.categoryHeading)}
              <div style={{ display: 'grid', gridTemplateColumns: feature ? '1fr' : '1fr 1fr', gap: 12 }}>
                {Array.from({ length: sec.slots }, (_, j) =>
                  list[j] ? (feature ? featureTile(list[j], start + j) : gridTile(list[j], start + j)) : emptySlot(`e${start + j}`, feature),
                )}
              </div>
            </div>
          )
        })}
        {overflow.length > 0 && (
          <div style={{ padding: '0 16px 24px' }}>
            <div style={{ fontSize: '0.75rem', color: '#b26a00', backgroundColor: '#fff4e0', borderRadius: 8, padding: '4px 8px', marginBottom: 8 }}>
              枠外({overflow.length}件): このテンプレートの枠を超えているため、メールには載りません
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, opacity: 0.55 }}>
              {overflow.map((it, j) => gridTile(it, offset + j))}
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <div style={{ maxWidth: 440, margin: '0 auto' }}>
      {!compact && <span style={{ fontSize: 12, color: tokens.colorNeutralForeground2 }}>件名: {subject || '(配信名未入力)'}</span>}
      <div style={{ backgroundColor: '#fff', color: INK, border: '1px solid #ddd', borderRadius: 16, overflow: 'hidden', marginTop: 4, ...scaled }}>
        <div style={{ backgroundColor: '#222', color: '#fff', textAlign: 'center', padding: '12px 0', letterSpacing: 4, fontWeight: 700 }}>SHOP</div>
        {heroBox}
        {body}
        {!compact && <div style={{ backgroundColor: '#f5f5f5', color: SUB, fontSize: '0.75rem', textAlign: 'center', padding: '12px 0' }}>配信停止はこちら</div>}
      </div>
    </div>
  )
}

function PushPreview(props: Props) {
  const { subject, headline, copy, scheduledAt, items, products, selectedKey, hero: pickedHero, onSelect, onRemove, onMove, onDropAt } = props
  const classes = useStyles()
  const { over, handlers, clear } = useDropTarget(onDropAt)
  const [style, setStyle] = useState<'ios' | 'android'>('ios')
  const byId = new Map(products.map((p) => [p.cr854_productid, p]))
  const firstProduct = items[0] && byId.get(items[0].productId)
  // メイン画像が設定されていればそれを、なければ先頭の商品の画像を通知の画像にする
  const heroSrc = pickedHero ? heroImage(pickedHero) : productImage(firstProduct)
  const heroAlt = pickedHero?.cr854_name ?? firstProduct?.cr854_name

  const when = scheduledAt ? new Date(scheduledAt) : null
  const clock = when ? `${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}` : '9:41'
  const dateText = when ? when.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'long' }) : ''
  const title = headline || subject || '(ヘッドライン未入力)'
  const bodyText = copy || '(コピー未入力)'
  const hasJa = /[\u3000-\u9fff\uff00-\uffef]/.test(title)
  const titleFont = {
    fontFamily: HEADLINE_FONT.family,
    fontWeight: HEADLINE_FONT.weight,
    letterSpacing: hasJa ? '0.06em' : '0.14em',
    textTransform: HEADLINE_FONT.upper ? ('uppercase' as const) : ('none' as const),
  }
  const bodyFont = { fontFamily: HEADLINE_FONT.family, letterSpacing: '0.04em' }
  const more = items.length > 1 ? `ほか${items.length - 1}点の商品` : ''

  const appIcon = (size: number) => (
    <div style={{ width: size, height: size, borderRadius: style === 'ios' ? '22%' : '50%', backgroundColor: '#222', color: '#fff', display: 'grid', placeItems: 'center', fontSize: size * 0.5, fontWeight: 800, flexShrink: 0 }}>
      S
    </div>
  )

  const image = heroSrc && (
    <img
      draggable={false}
      src={heroSrc}
      alt={heroAlt}
      style={{ width: '100%', aspectRatio: style === 'ios' ? '16 / 9' : '2 / 1', objectFit: 'cover', borderRadius: style === 'ios' ? 16 : 24, display: 'block', backgroundColor: '#e9e9ee', marginTop: 8 }}
    />
  )

  const notification =
    style === 'ios' ? (
      <div style={{ backgroundColor: 'rgba(250,250,252,0.86)', color: INK, borderRadius: 22, padding: 12, boxShadow: '0 4px 18px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          {appIcon(20)}
          <div style={{ flexGrow: 1, fontSize: '0.7rem', letterSpacing: 1, color: SUB }}>SHOP</div>
          <div style={{ fontSize: '0.7rem', color: SUB }}>たった今</div>
        </div>
        <div style={{ ...titleFont, fontSize: '0.9rem', color: INK }}>{title}</div>
        <div style={{ ...bodyFont, fontSize: '0.85rem', color: INK, whiteSpace: 'pre-wrap' }}>{bodyText}</div>
        {image}
        {more && <div style={{ fontSize: '0.7rem', color: SUB, marginTop: 6 }}>{more}</div>}
      </div>
    ) : (
      <div style={{ backgroundColor: '#f3edf7', color: INK, borderRadius: 24, padding: 12, boxShadow: '0 2px 10px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          {appIcon(18)}
          <div style={{ flexGrow: 1, fontSize: '0.7rem', color: SUB }}>SHOP ・ たった今</div>
          <div style={{ fontSize: '0.8rem', color: SUB, lineHeight: 1 }}>⌃</div>
        </div>
        <div style={{ ...titleFont, fontSize: '0.9rem', color: INK }}>{title}</div>
        <div style={{ ...bodyFont, fontSize: '0.85rem', color: '#444', whiteSpace: 'pre-wrap' }}>{bodyText}</div>
        {image}
        {more && <div style={{ fontSize: '0.7rem', color: SUB, marginTop: 6 }}>{more}</div>}
      </div>
    )

  return (
    <div style={{ maxWidth: 380, margin: '0 auto', display: 'grid', gap: 16 }}>
      <div style={{ justifySelf: 'center', display: 'flex' }}>
        <ToggleButton size="small" checked={style === 'ios'} onClick={() => setStyle('ios')} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
          iOS風
        </ToggleButton>
        <ToggleButton size="small" checked={style === 'android'} onClick={() => setStyle('android')} style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: -1 }}>
          Android風
        </ToggleButton>
      </div>
      {/* スマホのロック画面 */}
      <div
        style={{
          background: style === 'ios' ? 'linear-gradient(165deg, #3b4a6b, #1d2438 70%, #2a2440)' : 'linear-gradient(165deg, #2b3a4a, #141c26)',
          border: '6px solid #101010',
          borderRadius: 36,
          padding: '24px 14px',
          color: '#fff',
          boxShadow: tokens.shadow16,
          ...scaled,
        }}
      >
        <div style={{ textAlign: style === 'ios' ? 'center' : 'left', marginBottom: 20, padding: style === 'ios' ? 0 : '0 8px' }}>
          {dateText && <div style={{ fontSize: '0.85rem', opacity: 0.85 }}>{dateText}</div>}
          <div style={{ fontSize: style === 'ios' ? '3.6rem' : '3rem', fontWeight: style === 'ios' ? 300 : 400, lineHeight: 1.1 }}>{clock}</div>
        </div>
        {notification}
        <div style={{ width: 96, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.55)', margin: '24px auto 0' }} />
      </div>
      <span style={{ fontSize: 12, color: tokens.colorNeutralForeground2 }}>
        通知の画像には、メイン画像(なければ先頭の商品)を使います。下のリストで、商品の順序を入れ替えられます。
      </span>
      {/* 通知をタップしたあとのメッセージ本文。メールと同じレイアウトで、画像を小さくしたもの */}
      <div style={{ fontSize: 14, fontWeight: 700 }}>タップ後のメッセージ(メールと同じレイアウト)</div>
      <EmailPreview {...props} compact />
      <div style={{ display: 'grid', gap: 6 }}>
        {items.map((it, idx) => {
          const p = byId.get(it.productId)
          return (
            <div
              key={it.key}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_ITEM, it.key)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={clear}
              onClick={() => onSelect(it.key)}
              {...handlers(idx)}
              className={classes.pushRow}
              style={{ borderColor: over === idx || it.key === selectedKey ? tokens.colorBrandForeground1 : tokens.colorNeutralStroke2 }}
            >
              <span style={{ width: 16, fontSize: 12, color: tokens.colorNeutralForeground2 }}>{idx + 1}</span>
              <img draggable={false} src={productImage(p)} alt="" style={{ width: 32, height: 32, borderRadius: 8, objectFit: 'cover' }} />
              <div className={classes.noWrap} style={{ flexGrow: 1, fontSize: '0.85rem' }}>{p?.cr854_name}</div>
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowUpRegular />}
                disabled={idx === 0}
                onClick={(e) => {
                  e.stopPropagation()
                  onMove(it.key, -1)
                }}
                aria-label="上へ"
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowDownRegular />}
                disabled={idx === items.length - 1}
                onClick={(e) => {
                  e.stopPropagation()
                  onMove(it.key, 1)
                }}
                aria-label="下へ"
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<DismissRegular />}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(it.key)
                }}
                aria-label="外す"
              />
            </div>
          )
        })}
        <div
          {...handlers(items.length)}
          className={classes.pushDrop}
          style={{ borderColor: over === items.length ? tokens.colorBrandForeground1 : tokens.colorNeutralStroke2 }}
        >
          {items.length === 0 ? 'ここに商品をドロップ' : '＋ ここにドロップで末尾に追加'}
        </div>
      </div>
    </div>
  )
}
