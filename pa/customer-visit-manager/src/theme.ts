import { useEffect, useState } from 'react'
import { createDarkTheme, createLightTheme, type BrandVariants, type Theme } from '@fluentui/react-components'

// 英数字は Inter、日本語は Noto Sans JP(どちらもアプリに同梱)。読み込めないときだけ、OS のフォントになる
const fontFamilyBase = "'Inter', 'Noto Sans JP', 'Segoe UI', 'Yu Gothic UI', 'Meiryo UI', system-ui, -apple-system, sans-serif"

/** 色相・彩度を固定し、明度だけを変えてブランド色の 16 段階を作る(80 が基準色) */
function ramp(hue: number, sat: number): BrandVariants {
  const lightness: Record<string, number> = {
    10: 9, 20: 14, 30: 19, 40: 24, 50: 29, 60: 34, 70: 40, 80: 46, 90: 52, 100: 58, 110: 64, 120: 70, 130: 77, 140: 84, 150: 91, 160: 96,
  }
  const hex = (l: number) => {
    const a = (sat / 100) * Math.min(l / 100, 1 - l / 100)
    const f = (n: number) => {
      const k = (n + hue / 30) % 12
      const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
      return Math.round(255 * c).toString(16).padStart(2, '0')
    }
    return `#${f(0)}${f(8)}${f(4)}`
  }
  return Object.fromEntries(Object.entries(lightness).map(([k, l]) => [k, hex(l)])) as unknown as BrandVariants
}

// 落ち着いた青(インディゴ寄り)。Microsoft 製品の中でも違和感がなく、既定の青より締まって見える
const brand = ramp(226, 66)

const light: Theme = {
  ...createLightTheme(brand),
  fontFamilyBase,
  // 面は、背景(薄いグレー)の上に、白いカードを重ねる
  colorNeutralBackground2: '#f4f5f7',
  colorNeutralBackground3: '#eceef2',
  colorNeutralStroke2: '#e4e7ec',
  colorNeutralStroke1: '#cdd2da',
  colorNeutralForeground1: '#1b1f2a',
  colorNeutralForeground2: '#3d4452',
  colorNeutralForeground3: '#667085',
  borderRadiusSmall: '4px',
  borderRadiusMedium: '6px',
  borderRadiusLarge: '8px',
  borderRadiusXLarge: '12px',
  shadow2: '0 0 1px rgba(16, 24, 40, 0.10), 0 1px 2px rgba(16, 24, 40, 0.06)',
  shadow4: '0 0 1px rgba(16, 24, 40, 0.10), 0 2px 4px rgba(16, 24, 40, 0.06)',
  shadow8: '0 0 1px rgba(16, 24, 40, 0.10), 0 4px 10px rgba(16, 24, 40, 0.08)',
  shadow16: '0 0 1px rgba(16, 24, 40, 0.12), 0 8px 24px rgba(16, 24, 40, 0.12)',
  shadow28: '0 0 1px rgba(16, 24, 40, 0.14), 0 16px 40px rgba(16, 24, 40, 0.16)',
}

const dark: Theme = {
  ...createDarkTheme(brand),
  fontFamilyBase,
  borderRadiusSmall: '4px',
  borderRadiusMedium: '6px',
  borderRadiusLarge: '8px',
  borderRadiusXLarge: '12px',
}

const query = '(prefers-color-scheme: dark)'

/** OSの配色設定(ライト/ダーク)に自動で追従する Fluent 2 のテーマ */
export function useFluentTheme(): Theme {
  const [isDark, setIsDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = (e: MediaQueryListEvent) => setIsDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return isDark ? dark : light
}
