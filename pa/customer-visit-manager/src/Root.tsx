import { FluentProvider } from '@fluentui/react-components'
import { useFluentTheme } from './theme.ts'
import App from './App.tsx'

export default function Root() {
  const theme = useFluentTheme()
  return (
    <FluentProvider theme={theme} style={{ width: '100%', boxSizing: 'border-box', minHeight: '100vh', background: 'var(--colorNeutralBackground2)' }}>
      <App />
    </FluentProvider>
  )
}
