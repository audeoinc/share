// GCP 版の、AI の送受信(Cr854_airequestsService の互換サービス)。
//
// Power Apps 版の askText(src/aiSelect.ts)は、依頼を AI要求テーブルに書き、フローの返答をポーリングで待つ。
// GCP 版では、同じ create / get / delete の呼び出しを、サーバーの /api/ask(Gemini)への 1 回の問い合わせに置き換える。
// 画面側(プロンプトの作成・JSON の解釈・やり直し)は共通のまま。

// aiSelect.ts の STATUS_* と同じ値(AI要求の状態の選択肢)
const WAITING = 588230000
const DONE = 588230001
const ERROR = 588230002

interface Pending {
  status: number
  response: string
  settled: Promise<void>
}

const requests = new Map<string, Pending>()
// get は、返答が出るまで少し待つ(2 秒おきのポーリングでも、返答の直後に受け取れる)
const WAIT_IN_GET_MS = 20_000

function ask(prompt: string): Pending {
  const p: Pending = { status: WAITING, response: '', settled: Promise.resolve() }
  p.settled = (async () => {
    try {
      const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) })
      const json = (await res.json().catch(() => null)) as { success?: boolean; text?: string; error?: { message?: string } } | null
      if (json?.success && json.text) {
        p.status = DONE
        p.response = json.text
      } else {
        p.status = ERROR
        p.response = json?.error?.message ?? `AI のサーバーの応答が正しくありません(${res.status})`
      }
    } catch (e) {
      p.status = ERROR
      p.response = e instanceof Error ? e.message : String(e)
    }
  })()
  return p
}

export function makeAiRequestService() {
  return {
    async create(record: { cr854_prompt?: string }) {
      const id = crypto.randomUUID()
      requests.set(id, ask(record.cr854_prompt ?? ''))
      return { success: true, data: { cr854_airequestid: id } }
    },
    async get(id: string) {
      const p = requests.get(id)
      if (!p) return { success: false, error: { message: 'AI の依頼が見つかりません' } }
      if (p.status === WAITING) await Promise.race([p.settled, new Promise((r) => setTimeout(r, WAIT_IN_GET_MS))])
      return { success: true, data: { cr854_airequestid: id, cr854_status: p.status, cr854_response: p.response } }
    },
    async delete(id: string) {
      requests.delete(id)
    },
  }
}
