// server/schema.json(GCP 版のデータ定義)と、src/generated/models(Dataverse のテーブル定義)の食い違いを検出する。
//   node scripts/check-schema.mjs        ← npm run verify に含まれる
// Dataverse に列を足して `pa app add data-source` で生成し直したのに、schema.json への追記を忘れる事故を防ぐ。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schema = JSON.parse(readFileSync(join(root, 'server', 'schema.json'), 'utf8'))
const problems = []

for (const [table, def] of Object.entries(schema.tables)) {
  const file = join(root, 'src', 'generated', 'models', `${table[0].toUpperCase()}${table.slice(1)}Model.ts`)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    problems.push(`${table}: 生成モデルが見つかりません(${file})`)
    continue
  }
  // 書き込みの項目(Base)だけを見る
  const base = text.match(/export interface \w+Base \{([\s\S]*?)\n\}/)?.[1] ?? ''
  const fields = new Set()
  const lookups = new Set()
  for (const m of base.matchAll(/^\s+(?:"?(cr854_\w+)(@odata\.bind)?"?)\??:/gm)) {
    if (m[2]) lookups.add(m[1])
    else if (m[1] !== def.pk) fields.add(m[1])
  }
  const defined = new Set(def.columns.map((c) => c[0]))
  const definedLookups = new Set(def.lookups.map((l) => l[0]))
  for (const f of fields) if (!defined.has(f)) problems.push(`${table}: 生成モデルにある列 ${f} が、schema.json にありません`)
  for (const f of defined) if (!fields.has(f)) problems.push(`${table}: schema.json にある列 ${f} が、生成モデルにありません`)
  for (const f of lookups) if (!definedLookups.has(f)) problems.push(`${table}: 生成モデルにある参照 ${f} が、schema.json にありません`)
  for (const f of definedLookups) if (!lookups.has(f)) problems.push(`${table}: schema.json にある参照 ${f} が、生成モデルにありません`)
}

if (problems.length) {
  console.error('schema.json と生成モデルが一致しません:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log(`schema.json OK(${Object.keys(schema.tables).length} テーブル)`)
