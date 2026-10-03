import { makeStyles, tokens } from '@fluentui/react-components'

interface Props {
  /** ドラッグ中、ポインタの移動量(px)ごとに呼ばれる */
  onDrag: (deltaX: number) => void
  onDone?: () => void
}

const useStyles = makeStyles({
  root: {
    cursor: 'col-resize',
    touchAction: 'none',
    position: 'relative',
    backgroundColor: tokens.colorNeutralStroke2,
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFast,
    '::after': { content: '""', position: 'absolute', top: 0, bottom: 0, left: '-3px', right: '-3px' },
    ':hover': { backgroundColor: tokens.colorBrandStroke1 },
    ':active': { backgroundColor: tokens.colorBrandStroke1 },
    '@media (max-width: 899px)': { display: 'none' },
  },
})

/** ペイン間の境界。ドラッグで幅を変える(900px 以上でのみ表示) */
export function Splitter({ onDrag, onDone }: Props) {
  const styles = useStyles()

  function start(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let last = e.clientX
    const move = (ev: PointerEvent) => {
      onDrag(ev.clientX - last)
      last = ev.clientX
    }
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      onDone?.()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }

  return <div role="separator" aria-orientation="vertical" onPointerDown={start} className={styles.root} />
}
