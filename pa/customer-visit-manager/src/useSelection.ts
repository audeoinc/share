import { useState, type Dispatch, type SetStateAction } from 'react'
import { DND_CAND, DND_ITEM, DND_PRODUCT, SOURCE_AI, SOURCE_MANUAL, type Candidate, type Item } from './items'
import { sectionRange, sectionsOf, type EmailTemplateId, type SectionInfo } from './templates'

interface Args {
  template: EmailTemplateId
  items: Item[]
  setItems: Dispatch<SetStateAction<Item[]>>
  candidates: Candidate[]
  setCandidates: Dispatch<SetStateAction<Candidate[]>>
}

/** 選定済み商品・候補の操作(昇格・降格・並べ替え・ドラッグ&ドロップ) */
export function useSelection({ template, items, setItems, candidates, setCandidates }: Args) {
  const sections = sectionsOf(template)

  /** そのセクションの選定済み商品(最後のセクションは、枠を超えた分も含める) */
  const listOf = (sec: SectionInfo) => {
    const [from, to] = sectionRange(sections, sec, items.length)
    return items.slice(from, to)
  }
  const isFull = (sec: SectionInfo) => Number.isFinite(sec.slots) && listOf(sec).length >= sec.slots

  const moveInSection = (sec: SectionInfo, key: string, delta: number) =>
    setItems((prev) => {
      const [from, to] = sectionRange(sections, sec, prev.length)
      const i = prev.findIndex((x) => x.key === key)
      const j = i + delta
      if (i < 0 || j < from || j >= to) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const demote = (sec: SectionInfo, item: Item) => {
    setItems((prev) => prev.filter((x) => x.key !== item.key))
    setCandidates((prev) => [{ ...item, section: sec.index }, ...prev])
  }

  /** 候補を選定済みへ。枠がいっぱいなら、そのセクションの最後の商品を候補へ下げる */
  const promote = (sec: SectionInfo, cand: Candidate) => {
    const list = listOf(sec)
    const full = isFull(sec)
    let nextItems = [...items]
    let nextCands = candidates.filter((c) => c.key !== cand.key)
    if (full) {
      const last = list[list.length - 1]
      nextItems = nextItems.filter((x) => x.key !== last.key)
      nextCands = [{ ...last, section: sec.index }, ...nextCands]
    }
    const insertAt = sec.start + (full ? sec.slots - 1 : list.length)
    nextItems.splice(insertAt, 0, { key: cand.key, rowId: cand.rowId, productId: cand.productId, reason: cand.reason, source: cand.source })
    setItems(nextItems)
    setCandidates(nextCands)
  }

  const addManual = (sec: SectionInfo, productId: string) => {
    if (items.some((x) => x.productId === productId)) return
    const existing = candidates.find((c) => c.productId === productId)
    promote(sec, existing ?? { key: crypto.randomUUID(), productId, reason: '', source: SOURCE_MANUAL, section: sec.index })
  }

  // ---- ドラッグ&ドロップ
  const [dropKey, setDropKey] = useState<string | null>(null)
  const startDrag = (kind: 'item' | 'cand', key: string, productId: string) => (e: React.DragEvent) => {
    if (kind === 'item') e.dataTransfer.setData(DND_ITEM, key)
    else {
      e.dataTransfer.setData(DND_CAND, key)
      e.dataTransfer.setData(DND_PRODUCT, productId) // 右のプレビューへも落とせる
    }
    e.dataTransfer.effectAllowed = 'move'
  }
  const overTarget = (id: string) => (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropKey(id)
  }
  const leaveTarget = (id: string) => () => setDropKey((k) => (k === id ? null : k))

  /** 候補(または商品一覧の商品)を、選定済みの target と入れ替える */
  const swapIn = (sec: SectionInfo, target: Item, incoming: Candidate) => {
    setItems((prev) => prev.map((x) => (x.key === target.key ? { key: incoming.key, rowId: incoming.rowId, productId: incoming.productId, reason: incoming.reason, source: incoming.source } : x)))
    setCandidates((prev) => [{ ...target, section: sec.index }, ...prev.filter((c) => c.key !== incoming.key)])
  }

  /** 選定済みの行へのドロップ: 選定済みどうしは並べ替え、候補・商品一覧からは入れ替え */
  const dropOnSelected = (sec: SectionInfo, target: Item, dt: DataTransfer) => {
    const itemKey = dt.getData(DND_ITEM)
    const candKey = dt.getData(DND_CAND)
    const productId = dt.getData(DND_PRODUCT)
    if (itemKey) {
      if (itemKey === target.key) return
      setItems((prev) => {
        const [from, to] = sectionRange(sections, sec, prev.length)
        const a = prev.findIndex((x) => x.key === itemKey)
        const b = prev.findIndex((x) => x.key === target.key)
        if (a < from || a >= to || b < from || b >= to) return prev
        const next = [...prev]
        const [moved] = next.splice(a, 1)
        next.splice(b, 0, moved)
        return next
      })
    } else if (candKey) {
      const c = candidates.find((x) => x.key === candKey)
      if (c) swapIn(sec, target, c)
    } else if (productId && !items.some((x) => x.productId === productId)) {
      const c = candidates.find((x) => x.productId === productId) ?? { key: crypto.randomUUID(), productId, reason: '', source: SOURCE_MANUAL, section: sec.index }
      swapIn(sec, target, c)
    }
  }

  /** 選定済みリストの空きへのドロップ(枠に余裕があるときだけ、候補・商品一覧から追加) */
  const dropOnSelectedArea = (sec: SectionInfo, dt: DataTransfer) => {
    if (isFull(sec)) return
    const candKey = dt.getData(DND_CAND)
    const productId = dt.getData(DND_PRODUCT)
    const c = candKey ? candidates.find((x) => x.key === candKey) : undefined
    if (c) promote(sec, c)
    else if (productId) addManual(sec, productId)
  }

  /** 候補の領域へのドロップ: 選定済みの商品を、候補へ戻す */
  const dropOnCandidates = (sec: SectionInfo, dt: DataTransfer) => {
    const itemKey = dt.getData(DND_ITEM)
    const it = itemKey ? items.find((x) => x.key === itemKey) : undefined
    if (it && listOf(sec).some((x) => x.key === it.key)) demote(sec, it)
  }

  const setItemReason = (key: string, reason: string) => setItems((prev) => prev.map((x) => (x.key === key ? { ...x, reason } : x)))
  const setCandReason = (key: string, reason: string) => setCandidates((prev) => prev.map((x) => (x.key === key ? { ...x, reason } : x)))

  const toItems = (rows: { productId: string; reason: string }[]): Item[] =>
    rows.map((r) => ({ key: crypto.randomUUID(), productId: r.productId, reason: r.reason, source: SOURCE_AI }))

  return {
    sections,
    listOf,
    isFull,
    moveInSection,
    demote,
    promote,
    addManual,
    dropKey,
    setDropKey,
    startDrag,
    overTarget,
    leaveTarget,
    swapIn,
    dropOnSelected,
    dropOnSelectedArea,
    dropOnCandidates,
    setItemReason,
    setCandReason,
    toItems,
  }
}
