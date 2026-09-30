import Box from '@mui/material/Box'

interface Props {
  /** ドラッグ中、ポインタの移動量(px)ごとに呼ばれる */
  onDrag: (deltaX: number) => void
  onDone?: () => void
}

/** ペイン間の境界。ドラッグで幅を変える(md 以上でのみ表示) */
export function Splitter({ onDrag, onDone }: Props) {
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

  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      onPointerDown={start}
      sx={{
        display: { xs: 'none', md: 'block' },
        cursor: 'col-resize',
        touchAction: 'none',
        position: 'relative',
        bgcolor: 'divider',
        '&::after': { content: '""', position: 'absolute', top: 0, bottom: 0, left: -3, right: -3 },
        '&:hover, &:active': { bgcolor: 'primary.main' },
      }}
    />
  )
}
