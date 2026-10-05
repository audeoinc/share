import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { productMarket } from './market'
import { getTemplate, gridColumns, type EmailTemplateId, type Section } from './templates'
import { HEADLINE_FONT } from './fonts'
import { locale, optionLabel, useT } from './i18n'

interface Props {
  channel: 'email' | 'push'
  subject: string
  /** メイン画像に載せる大見出し */
  headline: string
  copy: string
  items: Item[]
  products: Cr854_products[]
  selectedKey: string | null
  /** 商品リストの行にマウスが乗っている商品(該当商品を光らせる) */
  hoverKey?: string | null
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
  const textRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const text = textRef.current
    if (!el || !text) return
    const fit = () => {
      // 文字そのものの幅(text)と、表示できる幅(el)を比べて、倍率を決める。
      // 文字の幅は、現在の倍率に比例するので、「現在の倍率 × 表示幅 / 文字の幅」が、ちょうど収まる倍率になる
      const current = parseFloat(el.style.getPropertyValue('--fit')) || 1
      const width = text.offsetWidth
      if (width <= 0 || el.clientWidth <= 0) return
      const next = Math.max(minScale, Math.min(1, (current * el.clientWidth) / width))
      if (Math.abs(next - current) > 0.004) el.style.setProperty('--fit', String(next))
    }
    fit()
    // 表示幅が変わったとき(ペインの幅の変更など)と、文字の幅が変わったとき(フォントの読み込み、文の変更)の、どちらも検知する
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    ro.observe(text)
    document.fonts?.ready.then(fit)
    document.fonts?.addEventListener?.('loadingdone', fit)
    return () => {
      ro.disconnect()
      document.fonts?.removeEventListener?.('loadingdone', fit)
    }
  }, [children, minScale])

  return (
    <div ref={ref} className={classes.fit} style={{ fontSize: `calc(${baseSize} * var(--fit, 1))`, ...style }}>
      <span ref={textRef} style={{ display: 'inline-block' }}>{children}</span>
    </div>
  )
}

function EmailPreview({ subject, headline, copy, items, products, selectedKey, hoverKey, showHeadings, template, sectionTitles, onSectionTitle, sectionCopies, onSectionCopy, compact = false, hero, onDropHero, onClearHero, onSelect, onRemove, onMove, onDropAt }: Props) {
  const t = useT()
  const classes = useStyles()
  const { over, handlers, clear } = useDropTarget(onDropAt)
  const [heroOver, setHeroOver] = useState(false)

  // 商品リストで選ばれた商品が、見える位置に来るようにスクロールする
  useEffect(() => {
    if (!selectedKey) return
    document.querySelector(`[data-item-key="${selectedKey}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedKey])
  const byId = new Map(products.map((p) => [p.cr854_productid, p]))
  const tpl = getTemplate(template)
  const offer = tpl.hero === 'offer'
  const heroText = tpl.heroText ?? 'band'
  const jaHeadline = /[\u3000-\u9fff\uff00-\uffef]/.test(headline)
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
          aria-label={t('前へ', 'Previous')}
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
          aria-label={t('後ろへ', 'Next')}
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
        aria-label={t('外す', 'Remove')}
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
    'data-item-key': it.key,
    ...handlers(idx),
  })

  const frameStyle = (it: Item, idx: number): React.CSSProperties => ({
    borderColor: over === idx ? tokens.colorBrandForeground1 : it.key === selectedKey || it.key === hoverKey ? ACCENT : 'transparent',
    backgroundColor: over === idx ? 'rgba(103,80,164,0.08)' : 'transparent',
  })

  const priceEl = (price?: number, market?: 'JP' | 'US') =>
    offer ? (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '1.05rem', fontWeight: 800, color: '#d32f2f' }}>{yen(price, market)}</span>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#fff', backgroundColor: '#d32f2f', padding: '0 6px', borderRadius: 4 }}>
          {t('期間限定', 'LIMITED TIME')}
        </span>
      </div>
    ) : (
      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: INK }}>{yen(price, market)}</div>
    )

  const cta = (
    <div style={{ marginTop: 6, padding: '4px 0', textAlign: 'center', backgroundColor: offer ? '#d32f2f' : '#222', color: '#fff', fontSize: '0.75rem', borderRadius: 4 }}>
      {t('詳細はこちら', 'View details')}
    </div>
  )

  const gridTile = (it: Item, idx: number) => {
    const p = byId.get(it.productId)
    return (
      <div key={it.key} {...dragProps(it, idx)} className={classes.frame} style={frameStyle(it, idx)}>
        <img className={classes.img} draggable={false} src={productImage(p)} alt={p?.cr854_name} style={{ width: '100%', aspectRatio: compact ? '1 / 1' : '3 / 4' }} />
        <div className={classes.noWrap} style={{ fontSize: '0.85rem', fontWeight: 600, marginTop: 4, color: INK }}>{p?.cr854_name}</div>
        {priceEl(p?.cr854_price, productMarket(p))}
        {controls(it, idx)}
      </div>
    )
  }

  // 写真だけのタイル: 名前・価格を出さず、写真を敷き詰める
  const photoTile = (it: Item, idx: number) => {
    const p = byId.get(it.productId)
    return (
      <div key={it.key} {...dragProps(it, idx)} className={classes.frame} style={{ ...frameStyle(it, idx), padding: 2 }}>
        <img className={classes.img} draggable={false} src={productImage(p)} alt={p?.cr854_name} style={{ width: '100%', aspectRatio: '4 / 5', borderRadius: 4 }} />
        {controls(it, idx)}
      </div>
    )
  }

  // 写真を枠いっぱいに敷き、名前・価格を左下に重ねる(大きく 1 点・モザイク)。
  // fill: 枠の高さに合わせる(モザイクのマス)。そうでなければ正方形
  const overlayTile = (it: Item, idx: number, fill: boolean, small = false) => {
    const p = byId.get(it.productId)
    return (
      <div key={it.key} {...dragProps(it, idx)} className={classes.frame} style={{ ...frameStyle(it, idx), padding: 0, ...(fill ? { height: '100%' } : {}) }}>
        <img className={classes.img} draggable={false} src={productImage(p)} alt={p?.cr854_name} style={{ width: '100%', ...(fill ? { height: '100%' } : { aspectRatio: '1 / 1' }) }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: small ? '14px 6px 4px' : '28px 12px 10px', borderRadius: '0 0 8px 8px', background: 'linear-gradient(rgba(255,255,255,0), rgba(255,255,255,0.9))' }}>
          <div className={classes.noWrap} style={{ fontSize: small ? '0.7rem' : '0.9rem', fontWeight: 600, color: INK }}>{p?.cr854_name}</div>
          {!small && priceEl(p?.cr854_price, productMarket(p))}
        </div>
        {controls(it, idx)}
      </div>
    )
  }

  // ストーリー: 写真と、名前・価格・商品の説明を横に並べる。reverse で、写真を左にする
  const storyRow = (it: Item, idx: number, reverse: boolean) => {
    const p = byId.get(it.productId)
    const text = (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, padding: '12px 14px', minWidth: 0 }}>
        {p?.cr854_categoryname && <div style={{ fontSize: '0.65rem', letterSpacing: 2, color: SUB }}>{optionLabel(p.cr854_categoryname).toUpperCase()}</div>}
        <div style={{ fontSize: '1rem', fontWeight: 600, color: INK }}>{p?.cr854_name}</div>
        {priceEl(p?.cr854_price, productMarket(p))}
        {p?.cr854_description && <div style={{ fontSize: '0.78rem', color: SUB, lineHeight: 1.5, marginTop: 6 }}>“{p.cr854_description}”</div>}
      </div>
    )
    const img = <img className={classes.img} draggable={false} src={productImage(p)} alt={p?.cr854_name} style={{ width: '100%', aspectRatio: '3 / 4', borderRadius: 0 }} />
    return (
      <div key={it.key} {...dragProps(it, idx)} className={classes.frame} style={{ ...frameStyle(it, idx), padding: 0, backgroundColor: over === idx ? ACCENT_BG : '#f1f1f3' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', alignItems: 'stretch' }}>
          {reverse ? img : text}
          {reverse ? text : img}
        </div>
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
          {priceEl(p?.cr854_price, productMarket(p))}
          {cta}
        </div>
        {controls(it, idx)}
      </div>
    )
  }

  // 空きの枠: ここへドロップすると、末尾の空き枠から埋まる
  const emptySlot = (key: string, feature: boolean, shape?: React.CSSProperties) => (
    <div
      key={key}
      {...handlers(items.length)}
      className={classes.slot}
      style={{
        aspectRatio: feature ? undefined : compact ? '1 / 1' : '3 / 4',
        minHeight: feature ? 120 : undefined,
        ...shape,
        borderColor: over === items.length ? ACCENT : '#bbb',
        backgroundColor: over === items.length ? ACCENT_BG : 'transparent',
        fontSize: '0.8rem',
        padding: 8,
      }}
    >
      {t('ここに商品をドロップ', 'Drop a product here')}
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
    const value = sectionTitles[index] ? sectionTitles[index] : fallback
    return (
      <div style={{ textAlign: 'center', margin: '12px 0' }}>
        <Input
          className={classes.headingInput}
          appearance="outline"
          value={value}
          onChange={(_, d) => onSectionTitle(index, d.value)}
          input={{ 'aria-label': t(`セクション${index + 1}の見出し`, `Section ${index + 1} heading`), style: { textAlign: 'center', fontWeight: 700, fontSize: '0.95rem', letterSpacing: 2, color: INK } }}
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
          placeholder={t('(セクションのコピー)', '(Section copy)')}
          textarea={{ 'aria-label': t(`セクション${index + 1}のコピー`, `Section ${index + 1} copy`), style: { textAlign: 'center', fontSize: '0.85rem', color: SUB, letterSpacing: 0.5, paddingTop: 2, paddingBottom: 2, minHeight: 0 } }}
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
        aspectRatio: heroText === 'band' ? (compact ? '3 / 1' : '8 / 3') : compact ? '2 / 1' : heroText === 'overlay' ? '4 / 5' : '1 / 1',
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
            aria-label={t('メイン画像を外す', 'Remove main image')}
          />
        </>
      ) : (
        t('メインビジュアル(候補から画像をドロップ)', 'Main visual (drop an image from the candidates)')
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
      {/* ヘッドライン(帯): 画像の下部に半透明の帯を敷いて、左寄せの太字で載せる */}
      {heroText === 'band' && (
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
          {headline || t('(ヘッドライン未入力)', '(No headline)')}
        </FitLine>
        <FitLine
          baseSize={compact ? '2.6cqw' : '2.9cqw'}
          style={{ marginTop: '0.8cqw', fontFamily: hf.family, fontWeight: 400, letterSpacing: '0.06em', lineHeight: 1.5, opacity: 0.95 }}
        >
          {copy || t('(コピー未入力)', '(No copy)')}
        </FitLine>
      </div>
      )}
      {/* ヘッドライン(大きく重ねる): 写真の中央に、折り返して大きく載せる。コピーは写真の下 */}
      {heroText === 'overlay' && (
        <div
          style={{
            position: 'absolute',
            inset: '0 6cqw',
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            textAlign: 'center',
            pointerEvents: 'none',
            fontFamily: hf.family,
            fontWeight: hf.weight,
            fontSize: `calc(${compact ? '6cqw' : '10cqw'} * ${hf.scale})`,
            lineHeight: 1.15,
            letterSpacing: jaHeadline ? hf.trackingJa : hf.tracking,
            textTransform: hf.upper ? 'uppercase' : 'none',
            textShadow: '0 2px 12px rgba(0,0,0,0.35)',
            overflowWrap: 'anywhere',
          }}
        >
          {headline || t('(ヘッドライン未入力)', '(No headline)')}
        </div>
      )}
    </div>
  )

  // ---- ヒーローの下(写真の下に置くヘッドライン・コピーと、ボタン)
  const buttonLabels = [t('商品を見る', 'Shop now'), t('もっと見る', 'See more')]
  const buttonRow = (n: number | undefined, outline: boolean) =>
    n ? (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)`, gap: 10, padding: n === 1 ? '4px 25%' : '4px 16px' }}>
        {buttonLabels.slice(0, n).map((label) => (
          <div
            key={label}
            style={{
              textAlign: 'center',
              padding: '8px 0',
              borderRadius: 999,
              fontSize: '0.8rem',
              ...(outline ? { border: `1px solid ${INK}`, color: INK } : { backgroundColor: offer ? '#d32f2f' : '#222', color: '#fff' }),
            }}
          >
            {label}
          </div>
        ))}
      </div>
    ) : null
  const heroAfter = (
    <>
      {heroText === 'below' && (
        <div style={{ textAlign: 'center', padding: '16px 16px 0', color: INK }}>
          <div style={{ fontFamily: hf.family, fontWeight: hf.weight, fontSize: `calc(1.5rem * ${hf.scale})`, lineHeight: 1.25, letterSpacing: jaHeadline ? hf.trackingJa : hf.tracking, textTransform: hf.upper ? 'uppercase' : 'none' }}>
            {headline || t('(ヘッドライン未入力)', '(No headline)')}
          </div>
        </div>
      )}
      {heroText !== 'band' && (
        <div style={{ textAlign: 'center', padding: '8px 24px 0', fontSize: '0.85rem', color: SUB, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{copy || t('(コピー未入力)', '(No copy)')}</div>
      )}
      {tpl.heroButtons ? <div style={{ paddingTop: 12 }}>{buttonRow(tpl.heroButtons, false)}</div> : null}
      <div style={{ height: 8 }} />
    </>
  )

  // ---- セクションの商品の並び(種類ごと)。start は、並び全体の中での先頭の位置
  const sectionBody = (sec: Section, start: number, list: Item[]) => {
    const slot = (j: number, tile: (it: Item, idx: number) => React.ReactNode, shape?: React.CSSProperties, feature = false) =>
      list[j] ? tile(list[j], start + j) : emptySlot(`e${start + j}`, feature, shape)
    const slots = Array.from({ length: sec.slots }, (_, j) => j)
    const cols = gridColumns(sec)
    switch (sec.kind) {
      case 'photos':
        return (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 4, alignItems: 'start' }}>{slots.map((j) => slot(j, photoTile, { aspectRatio: '4 / 5', padding: 4 }))}</div>
        )
      case 'wide':
        return <div style={{ display: 'grid', gap: 12 }}>{slots.map((j) => slot(j, (it, idx) => overlayTile(it, idx, false), { aspectRatio: '1 / 1' }))}</div>
      case 'mosaic': {
        // 3 点で 1 組。各組の先頭が大きいマス(縦 2 行分)
        const groups = Array.from({ length: Math.ceil(sec.slots / 3) }, (_, g) => g * 3)
        const cell = (j: number, big: boolean) => slot(j, (it, idx) => overlayTile(it, idx, true, !big), { aspectRatio: 'auto', height: '100%' })
        return (
          <div style={{ display: 'grid', gap: 8 }}>
            {groups.map((g) => (
              <div key={g} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 8, aspectRatio: '1 / 1' }}>
                <div style={{ gridRow: '1 / 3', gridColumn: sec.flip ? 2 : 1, minHeight: 0 }}>{cell(g, true)}</div>
                <div style={{ gridRow: 1, gridColumn: sec.flip ? 1 : 2, minHeight: 0 }}>{cell(g + 1, false)}</div>
                <div style={{ gridRow: 2, gridColumn: sec.flip ? 1 : 2, minHeight: 0 }}>{cell(g + 2, false)}</div>
              </div>
            ))}
          </div>
        )
      }
      case 'story':
        return <div style={{ display: 'grid', gap: 8 }}>{slots.map((j) => slot(j, (it, idx) => storyRow(it, idx, j % 2 === 1), { aspectRatio: '2 / 1.3' }))}</div>
      case 'feature':
        return <div style={{ display: 'grid', gap: 12 }}>{slots.map((j) => slot(j, featureTile, undefined, true))}</div>
      default:
        // 3 列は 1 枠が狭いので、名前が枠を押し広げないよう minmax(0, 1fr) にし、間隔も詰める
        return (
          // alignItems: start: 空き枠を、隣の商品(名前・価格の分だけ高い)の高さに引き伸ばすと、縦横比のせいで横にはみ出すため
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: cols === 3 ? 8 : 12, alignItems: 'start' }}>{slots.map((j) => slot(j, gridTile))}</div>
        )
    }
  }

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
            {showHeadings && run.category && headingEl(optionLabel(run.category))}
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
            {items.length === 0 ? t('ここに商品をドロップ', 'Drop a product here') : t('＋ ここにドロップで末尾に追加', '+ Drop here to add to the end')}
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
          return (
            <div key={start} style={{ padding: '0 16px 16px' }}>
              {sec.categoryHeading && editableHeading(si, category ? optionLabel(category) : `CATEGORY ${si + 1}`)}
              {sectionCopyEl(si, !!sec.categoryHeading)}
              {sectionBody(sec, start, list)}
              {sec.buttons ? <div style={{ paddingTop: 14 }}>{buttonRow(sec.buttons, true)}</div> : null}
            </div>
          )
        })}
        {overflow.length > 0 && (
          <div style={{ padding: '0 16px 24px' }}>
            <div style={{ fontSize: '0.75rem', color: '#b26a00', backgroundColor: '#fff4e0', borderRadius: 8, padding: '4px 8px', marginBottom: 8 }}>
              {t(`枠外(${overflow.length}件): このテンプレートの枠を超えているため、メールには載りません`, `Out of slots (${overflow.length}): these exceed the template's slots and won't appear in the email`)}
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
      {!compact && <span style={{ fontSize: 12, color: tokens.colorNeutralForeground2 }}>{t('件名', 'Subject')}: {subject || t('(配信名未入力)', '(No name)')}</span>}
      <div style={{ backgroundColor: '#fff', color: INK, border: '1px solid #ddd', borderRadius: 16, overflow: 'hidden', marginTop: 4, ...scaled }}>
        {/* お知らせ帯: 配信名を、メールの最上部に細い帯で出す */}
        {tpl.topBar && (
          <div className={classes.noWrap} style={{ backgroundColor: '#555', color: '#fff', textAlign: 'center', padding: '6px 12px', fontSize: '0.75rem', letterSpacing: 2 }}>
            {subject || t('(配信名未入力)', '(No name)')} ›
          </div>
        )}
        <div style={{ backgroundColor: '#222', color: '#fff', textAlign: 'center', padding: '12px 0', letterSpacing: 4, fontWeight: 700 }}>SHOP</div>
        {heroBox}
        {heroAfter}
        {body}
        {!compact && <div style={{ backgroundColor: '#f5f5f5', color: SUB, fontSize: '0.75rem', textAlign: 'center', padding: '12px 0' }}>{t('配信停止はこちら', 'Unsubscribe')}</div>}
      </div>
    </div>
  )
}

function PushPreview(props: Props) {
  const { subject, headline, copy, scheduledAt, items, products, selectedKey, hero: pickedHero, onSelect, onRemove, onMove, onDropAt } = props
  const t = useT()
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
  const dateText = when ? when.toLocaleDateString(locale(), { month: 'long', day: 'numeric', weekday: 'long' }) : ''
  const title = headline || subject || t('(ヘッドライン未入力)', '(No headline)')
  const bodyText = copy || t('(コピー未入力)', '(No copy)')
  const hasJa = /[\u3000-\u9fff\uff00-\uffef]/.test(title)
  const titleFont = {
    fontFamily: HEADLINE_FONT.family,
    fontWeight: HEADLINE_FONT.weight,
    letterSpacing: hasJa ? '0.06em' : '0.14em',
    textTransform: HEADLINE_FONT.upper ? ('uppercase' as const) : ('none' as const),
  }
  const bodyFont = { fontFamily: HEADLINE_FONT.family, letterSpacing: '0.04em' }
  const more = items.length > 1 ? t(`ほか${items.length - 1}点の商品`, `+${items.length - 1} more products`) : ''

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
          <div style={{ fontSize: '0.7rem', color: SUB }}>{t('たった今', 'now')}</div>
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
          <div style={{ flexGrow: 1, fontSize: '0.7rem', color: SUB }}>SHOP ・ {t('たった今', 'now')}</div>
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
          {t('iOS風', 'iOS style')}
        </ToggleButton>
        <ToggleButton size="small" checked={style === 'android'} onClick={() => setStyle('android')} style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: -1 }}>
          {t('Android風', 'Android style')}
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
        {t('通知の画像には、メイン画像(なければ先頭の商品)を使います。下のリストで、商品の順序を入れ替えられます。', 'The notification image uses the main image (or the first product if none). You can reorder products in the list below.')}
      </span>
      {/* 通知をタップしたあとのメッセージ本文。メールと同じレイアウトで、画像を小さくしたもの */}
      <div style={{ fontSize: 14, fontWeight: 700 }}>{t('タップ後のメッセージ(メールと同じレイアウト)', 'Message after tapping (same layout as the email)')}</div>
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
                aria-label={t('上へ', 'Move up')}
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
                aria-label={t('下へ', 'Move down')}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<DismissRegular />}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(it.key)
                }}
                aria-label={t('外す', 'Remove')}
              />
            </div>
          )
        })}
        <div
          {...handlers(items.length)}
          className={classes.pushDrop}
          style={{ borderColor: over === items.length ? tokens.colorBrandForeground1 : tokens.colorNeutralStroke2 }}
        >
          {items.length === 0 ? t('ここに商品をドロップ', 'Drop a product here') : t('＋ ここにドロップで末尾に追加', '+ Drop here to add to the end')}
        </div>
      </div>
    </div>
  )
}
