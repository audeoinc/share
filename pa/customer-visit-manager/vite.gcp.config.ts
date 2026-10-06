import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// GCP 版(Cloud Run)のビルド設定: Dataverse の生成サービス(generated/services)を、サーバーの API を呼ぶ互換サービス
// (src/gcp/services.ts)に差し替える。画面のコードは、Power Apps 版と同じ。
//   開発:   npm run dev:gcp      (別のターミナルで、サーバーを 8080 で起動しておく。/api はそこへ中継する)
//   ビルド: npm run build:gcp    (dist-gcp/ にできる。サーバーがこれを配信する)
const gcpServices = (): Plugin => ({
  name: 'gcp-services',
  enforce: 'pre',
  resolveId(source) {
    const m = source.match(/generated\/services\/(Cr854_\w+Service)$/)
    if (m) return `\0gcp:${m[1]}`
  },
  load(id) {
    if (!id.startsWith('\0gcp:')) return
    const name = id.slice('\0gcp:'.length)
    const table = name.replace(/Service$/, '').replace(/^C/, 'c') // Cr854_deliverycardsService → cr854_deliverycards
    return `import { makeService } from '/src/gcp/services.ts'\nexport const ${name} = makeService('${table}')\n`
  },
})

export default defineConfig({
  plugins: [gcpServices(), react()],
  build: {
    outDir: 'dist-gcp',
    // Power Apps 版と同じ(SVG は、アプリの中に埋め込む)
    assetsInlineLimit: (file) => (file.endsWith('.svg') ? true : undefined),
  },
  server: { port: 5191, strictPort: true, proxy: { '/api': 'http://localhost:8080' } },
})
