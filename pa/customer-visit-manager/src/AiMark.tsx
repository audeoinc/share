/** AI の印(2 つの星)。単色。accent は文字の色に従い、white は塗りの濃いボタン用 */
export function AiIcon({ tone = 'accent', size = 16 }: { tone?: 'accent' | 'white'; size?: number }) {
  const fill = tone === 'white' ? '#fff' : 'currentColor'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      style={tone === 'accent' ? { color: 'var(--colorBrandForeground1)' } : undefined}
    >
      <path fill={fill} d="M8.5 1.8c.35 3.9 1.9 5.6 6 6.2-4.1.6-5.65 2.3-6 6.2-.35-3.9-1.9-5.6-6-6.2 4.1-.6 5.65-2.3 6-6.2z" />
      <path fill={fill} d="M15.6 11.8c.2 2 .95 2.85 3 3.1-2.05.25-2.8 1.1-3 3.1-.2-2-.95-2.85-3-3.1 2.05-.25 2.8-1.1 3-3.1z" />
    </svg>
  )
}
