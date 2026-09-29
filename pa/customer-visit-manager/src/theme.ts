import { createTheme } from '@mui/material/styles'

// OSの配色設定(ライト/ダーク)に自動で追従する
export const theme = createTheme({
  colorSchemes: { light: true, dark: true },
  cssVariables: { colorSchemeSelector: 'media' },
  palette: { primary: { main: '#6750a4' } },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: '"Noto Sans JP", "Yu Gothic UI", "Meiryo", system-ui, sans-serif',
    button: { textTransform: 'none' },
  },
})
