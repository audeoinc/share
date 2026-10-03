import { useEffect, useRef, useState } from 'react'
import { Button, Spinner, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components'
import { ChevronDownRegular, ChevronUpRegular, DeleteRegular, SendRegular } from '@fluentui/react-icons'
import { AiIcon } from './AiMark'
import { AutoTextarea } from './AutoTextarea'
import { useT } from './i18n'

export interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
}

interface Props {
  /** チャットの対象(開いているタブ)の名前。null のときは、対象がなく、送れない */
  title: string | null
  messages: ChatMsg[]
  busy: boolean
  /** 入力欄の上に出す、よく使う頼み方(押すと、入力欄に入る) */
  suggestions: string[]
  /** 対象がないときの説明 */
  idleHint?: string
  onSend: (text: string) => void
  onClear: () => void
}

const useStyles = makeStyles({
  // 内容の上に重なる「カード」: ペインの下に、余白を空けて浮かせる
  dock: { flexShrink: 0, padding: '0 12px 12px', minWidth: 0 },
  card: {
    display: 'grid',
    minWidth: 0,
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: '0 6px 20px -6px rgba(16, 24, 40, 0.28), 0 0 1px rgba(16, 24, 40, 0.2)',
  },
  // 上端のつまみ: 上にドラッグすると、やり取りの表示欄が広がる
  grip: {
    display: 'grid',
    placeItems: 'center',
    height: '10px',
    cursor: 'ns-resize',
    touchAction: 'none',
    backgroundColor: tokens.colorBrandBackground2,
    ':hover > span': { backgroundColor: tokens.colorBrandForeground1 },
  },
  gripBar: { width: '32px', height: '3px', borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorBrandStroke2 },
  // 見出しの塗りの帯
  band: {
    display: 'flex',
    alignItems: 'center',
    columnGap: '6px',
    minWidth: 0,
    padding: '4px 6px 4px 12px',
    backgroundColor: tokens.colorBrandBackground2,
    borderBottom: `1px solid ${tokens.colorBrandStroke2}`,
  },
  body: { display: 'grid', rowGap: '6px', padding: '8px 10px 10px', minWidth: 0 },
  title: { flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  log: {
    display: 'grid',
    rowGap: '6px',
    alignContent: 'start',
    maxHeight: '220px',
    overflowY: 'auto',
    padding: '2px',
  },
  bubble: {
    maxWidth: '88%',
    padding: '6px 10px',
    borderRadius: tokens.borderRadiusLarge,
    fontSize: tokens.fontSizeBase200,
    lineHeight: '18px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  user: { justifySelf: 'end', backgroundColor: tokens.colorBrandBackground2, color: tokens.colorNeutralForeground1 },
  assistant: { justifySelf: 'start', backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}` },
  thinking: { justifySelf: 'start', display: 'flex', alignItems: 'center', columnGap: '8px', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  chip: {
    cursor: 'pointer',
    padding: '2px 10px',
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground2,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  inputRow: { display: 'flex', alignItems: 'flex-end', columnGap: '6px' },
  input: { flexGrow: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
})

const LOG_KEY = 'chat.logHeight'
const LOG_MIN = 80

function loadLogHeight(): number | null {
  try {
    const v = Number(localStorage.getItem(LOG_KEY))
    return Number.isFinite(v) && v >= LOG_MIN ? v : null
  } catch {
    return null
  }
}

function saveLogHeight(h: number | null) {
  try {
    if (h !== null) localStorage.setItem(LOG_KEY, String(h))
  } catch {
    // 保存できなくても動作には影響しない
  }
}

/** 中ペインの下に置く、AI へのチャット。開いているタブの案づくりに、指示を加える */
export function ChatPanel({ title, messages, busy, suggestions, idleHint, onSend, onClear }: Props) {
  const t = useT()
  const s = useStyles()
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  // やり取りの表示欄の高さ。つまみをドラッグしたあとは、その高さで固定する(null のあいだは、内容に合わせて最大 220px)
  const [logHeight, setLogHeight] = useState<number | null>(loadLogHeight)

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = logRef.current?.offsetHeight ?? logHeight ?? 120
    const max = Math.round(window.innerHeight * 0.6)
    const move = (ev: PointerEvent) => setLogHeight(Math.min(max, Math.max(LOG_MIN, startH + (startY - ev.clientY))))
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      setLogHeight((h) => {
        saveLogHeight(h)
        return h
      })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    if (!open) setOpen(true)
  }

  // 新しい発言が増えたら、いちばん下までスクロールする
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, busy, open])

  const disabled = title === null
  const send = () => {
    const v = text.trim()
    if (!v || busy || disabled) return
    onSend(v)
    setText('')
  }

  return (
    <div className={s.dock}>
      <div className={s.card}>
        <div className={s.grip} onPointerDown={startDrag} role="separator" aria-orientation="horizontal" aria-label={t('上下にドラッグして、チャットの高さを変える', 'Drag up or down to resize the chat')}>
          <span className={s.gripBar} />
        </div>
        <div className={s.band}>
          <AiIcon />
          <Text size={200} weight="semibold" className={s.title}>
            {disabled ? t('AIチャット', 'AI chat') : t(`AIチャット — ${title}`, `AI chat — ${title}`)}
          </Text>
          {messages.length > 0 && !busy && (
            <Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={onClear} aria-label={t('この会話を消す', 'Clear this conversation')} />
          )}
          <Button
            size="small"
            appearance="subtle"
            icon={open ? <ChevronDownRegular /> : <ChevronUpRegular />}
            onClick={() => setOpen(!open)}
            aria-label={open ? t('閉じる', 'Collapse') : t('開く', 'Expand')}
          />
        </div>

        <div className={s.body}>
          {open && (messages.length > 0 || busy || logHeight !== null) && (
            <div className={s.log} ref={logRef} style={logHeight !== null ? { height: logHeight, maxHeight: 'none' } : undefined}>
              {messages.map((m, i) => (
                <div key={i} className={mergeClasses(s.bubble, m.role === 'user' ? s.user : s.assistant)}>
                  {m.text}
                </div>
              ))}
              {busy && (
                <div className={s.thinking}>
                  <Spinner size="extra-tiny" />
                  {t('考え中...', 'Thinking...')}
                </div>
              )}
            </div>
          )}

          {open && disabled && idleHint && <span className={s.hint}>{idleHint}</span>}

          {open && !disabled && !busy && suggestions.length > 0 && (
            <div className={s.chips}>
              {suggestions.map((q) => (
                <button key={q} type="button" className={s.chip} onClick={() => setText(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}

          <div className={s.inputRow}>
            <AutoTextarea
              className={s.input}
              size="small"
              rows={1}
              value={text}
              disabled={disabled || busy}
              placeholder={
                disabled ? t('このタブでは、AIチャットは使えません', 'AI chat is not available on this tab') : t('AIへの指示を入力(Enterで送信、Shift+Enterで改行)', 'Tell the AI what you want (Enter to send, Shift+Enter for a new line)')
              }
              onChange={(_, d) => setText(d.value)}
              textarea={{
                onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  }
                },
              }}
            />
            <Button
              type="button"
              appearance="primary"
              icon={<SendRegular />}
              disabled={disabled || busy || !text.trim()}
              onClick={send}
              aria-label={t('送信', 'Send')}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
