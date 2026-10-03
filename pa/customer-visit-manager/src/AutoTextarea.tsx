import { useLayoutEffect, useRef } from 'react'
import { Textarea, type TextareaProps } from '@fluentui/react-components'

/** 内容の行数に合わせて高さが伸びる複数行入力(rows は最小の行数)。入力が見切れない */
export function AutoTextarea({ value, rows = 1, textarea, ...rest }: TextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
    fit()
    // 幅が変わると折り返しが変わるので、ペインの幅の変更にも追従する
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [value])

  return <Textarea {...rest} value={value} rows={rows} resize="none" textarea={{ ...(typeof textarea === 'object' ? textarea : {}), ref }} />
}
