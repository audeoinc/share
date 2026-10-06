// 初期データ(docs/*.csv → src/mock/seed.ts)を、GCP 版の DB に入れる形(server/seed.json)に書き出す。
//   npm run seed:export
// モック(撮影用)と GCP 版が、同じ元データから始まるようにするため。seed.ts を直したら、これを実行して seed.json もコミットする。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
})
try {
  const m = await server.ssrLoadModule('/src/mock/seed.ts')
  const data = {
    cr854_heroimages: m.heroes,
    cr854_products: m.products,
    cr854_deliverycards: m.cards,
    cr854_deliveryproducts: m.deliveryProducts,
    cr854_weeklyperformances: m.weekly,
    cr854_productpolicies: m.policies,
    cr854_layouttemplates: m.layoutTemplates,
  }
  writeFileSync(join(root, 'server', 'seed.json'), JSON.stringify(data, null, 1) + '\n')
  for (const [k, v] of Object.entries(data)) console.log(k, v.length)
} finally {
  await server.close()
}
