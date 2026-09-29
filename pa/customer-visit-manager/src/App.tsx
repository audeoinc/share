import { useEffect, useMemo, useState } from 'react'
import { Cr854_table_8c8e6d02sService } from './generated/services/Cr854_table_8c8e6d02sService'
import type { Cr854_table_8c8e6d02s } from './generated/models/Cr854_table_8c8e6d02sModel'
import './App.css'

type Customer = Cr854_table_8c8e6d02s

const fmtDate = (v?: string) => (v ? v.slice(0, 10) : '未設定')

function App() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Cr854_table_8c8e6d02sService.getAll({ orderBy: ['cr854_column_e2c297ce asc'] })
      .then((res) => {
        if (cancelled) return
        if (res.success) setCustomers(res.data ?? [])
        else setError(res.error?.message ?? '顧客の取得に失敗しました')
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return customers
    return customers.filter((c) =>
      [c.cr854_column_e2c297ce, c.cr854_column_a6bd4ae4, c.cr854_column_29b71671, c.cr854_column_0b29b608]
        .some((v) => v?.toLowerCase().includes(q)),
    )
  }, [customers, query])

  const selected = customers.find((c) => c.cr854_table_8c8e6d02id === selectedId)

  if (selected) {
    return (
      <div className="app">
        <button onClick={() => setSelectedId(null)}>← 一覧に戻る</button>
        <h1>{selected.cr854_column_e2c297ce}</h1>
        <dl className="detail">
          <dt>所在地</dt><dd>{selected.cr854_column_a6bd4ae4 || '-'}</dd>
          <dt>電話番号</dt><dd>{selected.cr854_column_29b71671 || '-'}</dd>
          <dt>メールアドレス</dt><dd>{selected.cr854_column_0b29b608 || '-'}</dd>
          <dt>次回訪問予定日</dt><dd>{fmtDate(selected.cr854_column_2f248d05)}</dd>
          <dt>フォローアップ内容</dt><dd className="pre">{selected.cr854_column_293add8b || '-'}</dd>
        </dl>
      </div>
    )
  }

  return (
    <div className="app">
      <h1>顧客訪問マネージャー</h1>
      <input
        className="search"
        type="search"
        placeholder="顧客名・所在地・電話・メールで検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <p>読み込み中...</p>}
      {error && <p className="error">エラー: {error}</p>}
      {!loading && !error && (
        <>
          <p className="count">{filtered.length} / {customers.length} 件</p>
          <ul className="cards">
            {filtered.map((c) => (
              <li key={c.cr854_table_8c8e6d02id}>
                <button className="card" onClick={() => setSelectedId(c.cr854_table_8c8e6d02id)}>
                  <strong>{c.cr854_column_e2c297ce}</strong>
                  <span>{c.cr854_column_a6bd4ae4 || '所在地未設定'}</span>
                  <span>次回訪問: {fmtDate(c.cr854_column_2f248d05)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default App
