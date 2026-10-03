// ヘッドラインの書体。フォントはアプリに同梱する(外部の CDN は、環境の通信制限で止まる可能性があるため)。
// 欧文は Jost、和文は Zen Kaku Gothic New(いずれも SIL Open Font License)。ファッション誌らしく、細字・広い字間・英字は大文字。
// 画面全体の書体: 英数字は Inter、日本語は Noto Sans JP(標準 400 と、ラベル・見出し用の 600)
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/noto-sans-jp/japanese-400.css'
import '@fontsource/noto-sans-jp/japanese-600.css'
import '@fontsource/jost/latin-300.css'
import '@fontsource/zen-kaku-gothic-new/latin-300.css'
import '@fontsource/zen-kaku-gothic-new/japanese-300.css'

export const HEADLINE_FONT = {
  family: '"Jost", "Zen Kaku Gothic New", "Noto Sans JP", sans-serif',
  weight: 300,
  /** 字間(英字のみのとき) */
  tracking: '0.22em',
  /** 字間(日本語を含むとき。広すぎると、長いヘッドラインが折り返すため) */
  trackingJa: '0.1em',
  /** 英字を大文字にする */
  upper: true,
  /** 見た目の大きさの補正 */
  scale: 0.95,
} as const
