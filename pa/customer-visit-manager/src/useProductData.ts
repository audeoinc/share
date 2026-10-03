import { useEffect, useState } from 'react'
import { Cr854_weeklyperformancesService } from './generated/services/Cr854_weeklyperformancesService'
import { Cr854_productpoliciesService } from './generated/services/Cr854_productpoliciesService'
import { tr } from './i18n'

export interface WeeklyPoint {
  /** 週の開始日(YYYY-MM-DD) */
  week: string
  units: number
  revenue: number
  stock: number
}

export interface ProductPolicy {
  policy: string
  promoPlan: string
  promoPeriod: string
  stage: string
}

export interface ProductData {
  weekly: WeeklyPoint[]
  policy?: ProductPolicy
}

// 同じ商品を開き直したときに、取り直さない(画面を開いている間だけ有効)
const cache = new Map<string, ProductData>()

async function load(code: string): Promise<ProductData> {
  const safe = code.replace(/'/g, "''")
  const [weekly, policy] = await Promise.all([
    Cr854_weeklyperformancesService.getAll({
      filter: `cr854_productcode eq '${safe}'`,
      orderBy: ['cr854_weekstart asc'],
      select: ['cr854_weekstart', 'cr854_units', 'cr854_revenue', 'cr854_stock'],
      top: 60,
    }),
    Cr854_productpoliciesService.getAll({
      filter: `cr854_productcode eq '${safe}'`,
      select: ['cr854_policy', 'cr854_promoplan', 'cr854_promoperiod', 'cr854_stage'],
      top: 1,
    }),
  ])
  if (!weekly.success) throw new Error(weekly.error?.message ?? tr('売上・在庫の実績を取得できませんでした', 'Failed to load sales and stock data'))
  const pol = policy.success ? policy.data?.[0] : undefined
  return {
    weekly: (weekly.data ?? []).map((w) => ({
      week: (w.cr854_weekstart ?? '').slice(0, 10),
      units: w.cr854_units ?? 0,
      revenue: w.cr854_revenue ?? 0,
      stock: w.cr854_stock ?? 0,
    })),
    policy: pol
      ? { policy: pol.cr854_policy ?? '', promoPlan: pol.cr854_promoplan ?? '', promoPeriod: pol.cr854_promoperiod ?? '', stage: pol.cr854_stage ?? '' }
      : undefined,
  }
}

/** 商品コードの、週次実績と販売方針を読み込む(開いたときに 1 回。結果は覚えておく) */
export function useProductData(code?: string) {
  const [state, setState] = useState<{ data?: ProductData; loading: boolean; error?: string }>(() => ({
    data: code ? cache.get(code) : undefined,
    loading: !!code && !cache.has(code),
  }))

  useEffect(() => {
    if (!code || cache.has(code)) return
    let cancelled = false
    load(code)
      .then((data) => {
        cache.set(code, data)
        if (!cancelled) setState({ data, loading: false })
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ loading: false, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [code])

  return state
}
