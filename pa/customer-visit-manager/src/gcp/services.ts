// GCP 版の、データの入出力(generated/services の互換サービス)。
//
// Power Apps 版では、生成された `Cr854_…Service` が Dataverse を呼ぶ。GCP 版のビルド(vite.gcp.config.ts)では、
// その import をここに差し替えて、同じ関数名・同じ戻り値の形で、サーバーの /api/data を呼ぶ。
// 画面のコードは、どちらのビルドでも同じ(同期を保つため、画面側には GCP 用の分岐を入れない)。

interface ErrorBody {
  message: string
  code?: string
}
interface Result<T> {
  success: boolean
  data?: T
  error?: ErrorBody
}

interface GetAllOptions {
  filter?: string
  orderBy?: string[]
  select?: string[]
  top?: number
  skip?: number
}

type Rec = Record<string, unknown>

/** DB が止まっているときなどの通知(準備中の表示に使う) */
export const dbUnavailable = new EventTarget()

async function call<T>(method: string, path: string, query?: URLSearchParams, body?: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(`/api/data/${path}${query && [...query].length ? `?${query}` : ''}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as Result<T> | null
    if (!json) return { success: false, error: { message: `サーバーの応答が正しくありません(${res.status})` } }
    if (!json.success && json.error?.code === 'db_unavailable') dbUnavailable.dispatchEvent(new Event('unavailable'))
    return json
  } catch (e) {
    return { success: false, error: { message: e instanceof Error ? e.message : String(e) } }
  }
}

export function makeService(table: string) {
  return {
    async getAll(options?: GetAllOptions): Promise<Result<Rec[]>> {
      const q = new URLSearchParams()
      if (options?.filter) q.set('filter', options.filter)
      if (options?.orderBy?.length) q.set('orderBy', options.orderBy.join(','))
      if (options?.select?.length) q.set('select', options.select.join(','))
      if (options?.top) q.set('top', String(options.top))
      if (options?.skip) q.set('skip', String(options.skip))
      return call<Rec[]>('GET', table, q)
    },
    async get(id: string): Promise<Result<Rec>> {
      return call<Rec>('GET', `${table}/${encodeURIComponent(id)}`)
    },
    async create(record: Rec): Promise<Result<Rec>> {
      return call<Rec>('POST', table, undefined, record)
    },
    async update(id: string, changedFields: Rec): Promise<Result<Rec>> {
      return call<Rec>('PATCH', `${table}/${encodeURIComponent(id)}`, undefined, changedFields)
    },
    async delete(id: string): Promise<void> {
      await call<null>('DELETE', `${table}/${encodeURIComponent(id)}`)
    },
  }
}
