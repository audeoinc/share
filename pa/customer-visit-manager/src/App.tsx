import { useEffect, useState } from 'react'
import { Cr854_table_8c8e6d02sService } from './generated/services/Cr854_table_8c8e6d02sService'
import type { Cr854_table_8c8e6d02s } from './generated/models/Cr854_table_8c8e6d02sModel'
import './App.css'

// 顧客テーブル (cr854_table_8c8e6d02) の列論理名
const COL = {
  id: 'cr854_table_8c8e6d02id',
  name: 'cr854_column_e2c297ce',
  address: 'cr854_column_a6bd4ae4',
  phone: 'cr854_column_29b71671',
  email: 'cr854_column_0b29b608',
  nextVisit: 'cr854_column_2f248d05',
  followUp: 'cr854_column_293add8b',
} as const

type Customer = Cr854_table_8c8e6d02s

function formatDate(value?: string): string {
  if (!value) return '未設定'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ja-JP')
}

function App() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const result = await Cr854_table_8c8e6d02sService.getAll({
          select: Object.values(COL),
          filter: 'statecode eq 0',
          orderBy: [`${COL.name} asc`],
        })
        if (cancelled) return
        if (!result.success) {
          throw result.error ?? new Error('顧客データの取得に失敗しました')
        }
        setCustomers(result.data ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app">
      <h1>顧客訪問マネージャー</h1>

      {loading && <p>読み込み中...</p>}
      {error && <p className="error">エラー: {error}</p>}
      {!loading && !error && customers.length === 0 && <p>顧客が登録されていません</p>}

      {!loading && !error && customers.length > 0 && (
        <>
          <p className="count">{customers.length} 件</p>
          <ul className="customer-list">
            {customers.map((c) => (
              <li key={c[COL.id]} className="customer-card">
                <h2>{c[COL.name]}</h2>
                <dl>
                  <dt>所在地</dt>
                  <dd>{c[COL.address] || '-'}</dd>
                  <dt>電話番号</dt>
                  <dd>{c[COL.phone] || '-'}</dd>
                  <dt>次回訪問予定日</dt>
                  <dd>{formatDate(c[COL.nextVisit])}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default App
