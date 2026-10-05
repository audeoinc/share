// 撮影・デモ用の、Dataverse の身代わり(メモリ上のデータ)。生成されたサービス(src/generated/services)と、同じ形で呼べる。
// vite.mock.config.ts が、サービスの読み込みを、ここに差し替える。ページを読み込み直すと、データは、最初に戻る。

import { mockAgent } from './agent'
import { cards, deliveryProducts, guid, heroes, layoutTemplates, policies, products, weekly, type Row } from './seed'

const tables: Record<string, Row[]> = {
  Cr854_deliverycardsService: structuredClone(cards),
  Cr854_deliveryproductsService: structuredClone(deliveryProducts),
  Cr854_productsService: structuredClone(products),
  Cr854_heroimagesService: structuredClone(heroes),
  Cr854_weeklyperformancesService: structuredClone(weekly),
  Cr854_productpoliciesService: structuredClone(policies),
  Cr854_layouttemplatesService: structuredClone(layoutTemplates),
  Cr854_airequestsService: [],
}

const idKey = (name: string) => `${name.replace('Service', '').toLowerCase().replace(/s$/, '').replace('cr854_productpolicie', 'cr854_productpolicy')}id`

interface Options {
  filter?: string
  orderBy?: string[]
  top?: number
}

/** `項目 eq 値`(値は、'文字' か、そのままの文字)だけを読む簡単な絞り込み */
function matches(row: Row, filter?: string): boolean {
  if (!filter) return true
  const m = filter.match(/^\s*(\S+)\s+eq\s+(.+?)\s*$/)
  if (!m) return true
  const value = m[2].replace(/^'(.*)'$/, '$1').replace(/''/g, "'")
  return String(row[m[1]]) === value
}

const clone = <T,>(v: T): T => structuredClone(v)

/** `cr854_deliverycard@odata.bind: /cr854_deliverycards(<id>)` を、`_cr854_deliverycard_value` に直す */
function applyBinds(row: Row, fields: Row) {
  for (const [k, v] of Object.entries(fields)) {
    const m = k.match(/^(.+)@odata\.bind$/)
    if (m) {
      const id = typeof v === 'string' ? (v.match(/\(([^)]+)\)/)?.[1] ?? null) : null
      row[`_${m[1]}_value`] = id ?? undefined
    } else row[k] = v
  }
}

const DELAY_MS = 1200
const waiting = new Map<string, number>()

export function makeService(name: string) {
  const rows = tables[name]
  const key = idKey(name)
  const find = (id: string) => rows.find((r) => r[key] === id)
  return {
    async getAll(options?: Options) {
      let list = rows.filter((r) => matches(r, options?.filter)).map(clone)
      const ob = options?.orderBy?.[0]?.split(' ')
      if (ob?.[0]) {
        const dir = ob[1] === 'desc' ? -1 : 1
        list = list.sort((a, b) => (String(a[ob[0]] ?? '') < String(b[ob[0]] ?? '') ? -dir : String(a[ob[0]] ?? '') > String(b[ob[0]] ?? '') ? dir : 0))
      }
      if (options?.top) list = list.slice(0, options.top)
      return { success: true, data: list }
    },
    async get(id: string) {
      const r = find(id)
      if (!r) return { success: false, error: { message: 'not found' } }
      // AI 要求: 少し待ってから、エージェントの返答を返す(実際の待ち時間の代わり)
      if (name === 'Cr854_airequestsService') {
        const readyAt = waiting.get(id) ?? 0
        if (Date.now() >= readyAt && r.cr854_status !== 588230001) {
          r.cr854_response = mockAgent(String(r.cr854_prompt ?? ''))
          r.cr854_status = 588230001
        }
      }
      return { success: true, data: clone(r) }
    },
    async create(record: Row) {
      const row: Row = { [key]: guid(`${name}:${Math.random()}:${Date.now()}`), createdon: new Date().toISOString() }
      applyBinds(row, record)
      rows.push(row)
      if (name === 'Cr854_airequestsService') waiting.set(row[key] as string, Date.now() + DELAY_MS)
      return { success: true, data: clone(row) }
    },
    async update(id: string, fields: Row) {
      const r = find(id)
      if (!r) return { success: false, error: { message: 'not found' } }
      applyBinds(r, fields)
      return { success: true, data: clone(r) }
    },
    async delete(id: string) {
      const i = rows.findIndex((r) => r[key] === id)
      if (i >= 0) rows.splice(i, 1)
    },
  }
}
