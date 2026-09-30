import { useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import SearchIcon from '@mui/icons-material/Search'
import type { Cr854_heroimages } from './generated/models/Cr854_heroimagesModel'
import { DND_HERO, scaled } from './items'
import { heroImage } from './images'

interface Props {
  heroes: Cr854_heroimages[]
  selectedId?: string
  onSelect: (id: string) => void
}

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
    <Box sx={{ display: 'grid', gap: 1.5, ...scaled }}>
      <TextField
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
        {shown.length}件 ・ 右のメインビジュアルへドラッグして設定
      </Typography>
      {shown.map((h) => {
        const used = h.cr854_heroimageid === selectedId
        return (
          <Box
            key={h.cr854_heroimageid}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_HERO, h.cr854_heroimageid)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            sx={{
              border: 2,
              borderColor: used ? 'primary.main' : 'divider',
              borderRadius: 2,
              overflow: 'hidden',
              cursor: 'grab',
              bgcolor: 'background.paper',
            }}
          >
            <Box component="img" draggable={false} src={heroImage(h)} alt={h.cr854_name} sx={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', display: 'block', bgcolor: '#e9e9ee' }} />
            <Box sx={{ p: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography noWrap sx={{ fontWeight: 600, fontSize: '0.9rem' }}>{h.cr854_name}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                  {h.cr854_imagecode} ・ {h.cr854_purposename} ・ {h.cr854_seasonname}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{h.cr854_tags}</Typography>
              </Box>
              {used ? <Chip size="small" label="設定中" color="primary" /> : <Button onClick={() => onSelect(h.cr854_heroimageid)}>設定</Button>}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
