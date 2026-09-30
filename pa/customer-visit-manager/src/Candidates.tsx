import { useMemo, useState } from 'react'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import SearchIcon from '@mui/icons-material/Search'
import type { Cr854_products } from './generated/models/Cr854_productsModel'
import { DND_PRODUCT, yen } from './items'

interface Props {
  products: Cr854_products[]
  usedIds: Set<string>
  onAdd: (productId: string) => void
}

const trendMark = (label?: string) => (label === '上昇' ? '▲ 上昇' : label === '下降' ? '▼ 下降' : '— 横ばい')

export function Candidates({ products, usedIds, onAdd }: Props) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')

  const categories = useMemo(() => [...new Set(products.map((p) => p.cr854_categoryname).filter(Boolean))] as string[], [products])
  const shown = products.filter((p) => {
    if (category && p.cr854_categoryname !== category) return false
    const q = query.trim().toLowerCase()
    return !q || `${p.cr854_name} ${p.cr854_productcode} ${p.cr854_description ?? ''}`.toLowerCase().includes(q)
  })

  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <TextField
        size="small"
        placeholder="商品名・コード・説明で検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
      />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        <Chip size="small" label="すべて" color={category === '' ? 'primary' : 'default'} onClick={() => setCategory('')} />
        {categories.map((c) => (
          <Chip key={c} size="small" label={c} color={category === c ? 'primary' : 'default'} onClick={() => setCategory(c === category ? '' : c)} />
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary">
        {shown.length}件 ・ 右のプレビューへドラッグして掲載
      </Typography>
      {shown.map((p) => {
        const used = usedIds.has(p.cr854_productid)
        return (
          <Box
            key={p.cr854_productid}
            draggable={!used}
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_PRODUCT, p.cr854_productid)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            sx={{
              display: 'flex',
              gap: 1.25,
              alignItems: 'center',
              p: 1,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              opacity: used ? 0.45 : 1,
              cursor: used ? 'default' : 'grab',
              bgcolor: 'background.paper',
              '&:hover': used ? undefined : { borderColor: 'primary.main' },
            }}
          >
            <Avatar variant="rounded" src={p.cr854_imageurl} alt={p.cr854_name} sx={{ width: 48, height: 48 }} />
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography noWrap sx={{ fontWeight: 600, fontSize: '0.9rem' }}>{p.cr854_name}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                {p.cr854_productcode} ・ {yen(p.cr854_price)} ・ 在庫{p.cr854_stock ?? '-'}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                {trendMark(p.cr854_salestrendname)} ・ ★{p.cr854_rating ?? '-'} ・ {p.cr854_weathername}
              </Typography>
            </Box>
            {used ? (
              <Chip size="small" label="掲載中" />
            ) : (
              <IconButton size="small" onClick={() => onAdd(p.cr854_productid)} aria-label="追加">
                <AddIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
