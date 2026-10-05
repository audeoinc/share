import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// 撮影・デモ用の設定: Dataverse と AI を、サンプルデータ(src/mock)に差し替えて、アプリを動かす。
//   npx vite --config vite.mock.config.ts
// 本番のビルド(vite.config.ts)には、影響しない。Power Apps のホストも、サインインも要らない。
const mockServices = (): Plugin => ({
  name: 'mock-services',
  enforce: 'pre',
  resolveId(source) {
    const m = source.match(/generated\/services\/(Cr854_\w+Service)$/)
    if (m) return `\0mock:${m[1]}`
  },
  load(id) {
    if (!id.startsWith('\0mock:')) return
    const name = id.slice('\0mock:'.length)
    return `import { makeService } from '/src/mock/db.ts'\nexport const ${name} = makeService('${name}')\n`
  },
})

export default defineConfig({
  plugins: [mockServices(), react()],
  server: { port: 5190, strictPort: true },
})
