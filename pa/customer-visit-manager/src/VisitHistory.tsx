import { useCallback, useEffect, useState } from 'react'
import { Cr854_table_3d6fd778sService } from './generated/services/Cr854_table_3d6fd778sService'
import {
  Cr854_table_3d6fd778scr854_column_9e77de87 as VisitResult,
  type Cr854_table_3d6fd778s,
} from './generated/models/Cr854_table_3d6fd778sModel'

export interface Salesperson {
  id: string
  name: string
}

interface Props {
  customerId: string
  salespeople: Salesperson[]
}

const fmtDateTime = (v?: string) => (v ? new Date(v).toLocaleString('ja-JP') : '-')

const emptyForm = { content: '', visitedAt: '', result: '', dueDate: '', salespersonId: '' }

export function VisitHistory({ customerId, salespeople }: Props) {
  const [visits, setVisits] = useState<Cr854_table_3d6fd778s[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(emptyForm)

  const nameOf = (id?: string) => salespeople.find((s) => s.id === id)?.name ?? '-'

  const load = useCallback(async () => {
    try {
      const res = await Cr854_table_3d6fd778sService.getAll({
        filter: `_cr854_column_cc26b3f5_value eq ${customerId}`,
        orderBy: ['cr854_column_11f9e5bf desc'],
      })
      if (res.success) {
        setVisits(res.data ?? [])
        setError(null)
      } else setError(res.error?.message ?? '訪問履歴の取得に失敗しました')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [customerId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await Cr854_table_3d6fd778sService.create({
        cr854_column_82b80e4c: form.content,
        cr854_column_11f9e5bf: new Date(form.visitedAt).toISOString(),
        cr854_column_956c2b11: form.dueDate || undefined,
        cr854_column_9e77de87: form.result === '' ? undefined : (Number(form.result) as 0 | 1 | 2),
        'cr854_column_cc26b3f5@odata.bind': `/cr854_table_8c8e6d02s(${customerId})`,
        'cr854_column_4d4c494e@odata.bind': `/cr854_table_a2287751s(${form.salespersonId})`,
        statecode: 0,
      })
      if (!res.success) throw new Error(res.error?.message ?? '登録に失敗しました')
      setForm(emptyForm)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value })

  return (
    <section>
      <h2>訪問履歴</h2>
      {error && <p className="error">エラー: {error}</p>}
      {visits.length === 0 && !error && <p className="count">履歴はまだありません</p>}
      <ul className="cards">
        {visits.map((v) => (
          <li key={v.cr854_table_3d6fd778id} className="card static">
            <strong>{fmtDateTime(v.cr854_column_11f9e5bf)}{v.cr854_column_9e77de87 !== undefined && ` / ${VisitResult[v.cr854_column_9e77de87]}`}</strong>
            <span>担当: {nameOf(v._cr854_column_4d4c494e_value)}</span>
            <span className="pre">{v.cr854_column_82b80e4c}</span>
            {v.cr854_column_956c2b11 && <span>フォローアップ期限: {v.cr854_column_956c2b11.slice(0, 10)}</span>}
          </li>
        ))}
      </ul>

      <h2>訪問を登録</h2>
      <form className="form" onSubmit={submit}>
        <label>訪問日時
          <input type="datetime-local" required value={form.visitedAt} onChange={set('visitedAt')} />
        </label>
        <label>営業担当者
          <select required value={form.salespersonId} onChange={set('salespersonId')}>
            <option value="">選択してください</option>
            {salespeople.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>訪問内容
          <input type="text" required value={form.content} onChange={set('content')} />
        </label>
        <label>訪問結果
          <select value={form.result} onChange={set('result')}>
            <option value="">未選択</option>
            {Object.entries(VisitResult).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <label>フォローアップ期限
          <input type="date" value={form.dueDate} onChange={set('dueDate')} />
        </label>
        <button type="submit" disabled={saving}>{saving ? '登録中...' : '登録'}</button>
      </form>
    </section>
  )
}
