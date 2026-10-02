import { useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import SearchIcon from '@mui/icons-material/Search'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { DND_HERO } from './items'
import { heroImage } from './images'

interface Props {
  heroes: Cr854_heroimages[]
  selectedId?: string
  onSelect: (id: string) => void
}

/** すべてのメイン画像から探す。サムネイルの一覧で、クリックするだけで設定できる(ドラッグ&ドロップでも設定できる) */
export function HeroCandidates({ heroes, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const [purpose, setPurpose] = useState('')

  const purposes = useMemo(() => [...new Set(heroes.map((h) => h.cr854_purposename).filter(Boolean))] as string[], [heroes])
  const shown = heroes.filter((h) => {
    if (purpose && h.cr854_purposename !== purpose) return false
    const q = query.trim().toLowerCase()
    return !q || `${h.cr854_name} ${h.cr854_imagecode} ${h.cr854_tags ?? ''} ${h.cr854_description ?? ''}`.toLowerCase().includes(q)
  })

  return (
    <Box sx={{ display: 'grid', gap: 1.25, minWidth: 0 }}>
      <TextField
        fullWidth
        size="small"
        placeholder="画像名・タグ・説明で検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
      />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        <Chip size="small" label="すべて" color={purpose === '' ? 'primary' : 'default'} onClick={() => setPurpose('')} />
        {purposes.map((c) => (
          <Chip key={c} size="small" label={c} color={purpose === c ? 'primary' : 'default'} onClick={() => setPurpose(c === purpose ? '' : c)} />
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary">
        {shown.length}件 ・ クリックで設定(ドラッグ&ドロップでも設定できます)
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 1 }}>
        {shown.map((h) => {
          const used = h.cr854_heroimageid === selectedId
          const select = () => {
            if (!used) onSelect(h.cr854_heroimageid)
          }
          return (
            <Box
              key={h.cr854_heroimageid}
              role="button"
              tabIndex={0}
              title={[h.cr854_name, h.cr854_tags, h.cr854_description].filter(Boolean).join('\n')}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DND_HERO, h.cr854_heroimageid)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={select}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  select()
                }
              }}
              sx={{
                position: 'relative',
                minWidth: 0,
                border: 2,
                borderColor: used ? 'primary.main' : 'divider',
                borderRadius: 2,
                overflow: 'hidden',
                cursor: used ? 'default' : 'pointer',
                bgcolor: 'background.paper',
                '&:hover': used ? undefined : { borderColor: 'primary.light' },
                '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
              }}
            >
              <Box component="img" draggable={false} src={heroImage(h)} alt={h.cr854_name} sx={{ width: '100%', aspectRatio: '8 / 3', objectFit: 'cover', display: 'block', bgcolor: '#e9e9ee' }} />
              {used && <Chip size="small" label="設定中" color="primary" sx={{ position: 'absolute', top: 6, right: 6 }} />}
              <Box sx={{ p: 0.75, minWidth: 0 }}>
                <Typography noWrap sx={{ fontWeight: 600, fontSize: '0.8rem' }}>{h.cr854_name}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                  {h.cr854_imagecode} ・ {h.cr854_purposename} ・ {h.cr854_seasonname}
                </Typography>
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
