import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { powerApps } from "@microsoft/power-apps-vite/plugin"

/**
 * 開発時だけ、フォントなどの資産の URL に、開発サーバー自身のアドレスを付ける。
 * 付けないと、Power Apps の画面(別のアドレス)から開いたときに、場所の指定(/node_modules/…)が
 * Power Apps のサーバーを指してしまい、フォントが読み込まれない。
 */
const absoluteDevAssetUrls = (): Plugin => ({
  name: 'absolute-dev-asset-urls',
  apply: 'serve',
  configureServer(server) {
    server.httpServer?.once('listening', () => {
      const addr = server.httpServer?.address()
      if (!addr || typeof addr !== 'object') return
      const local = ['::1', '::', '0.0.0.0', '127.0.0.1']
      const host = local.includes(addr.address) ? 'localhost' : addr.address
      const scheme = server.config.server.https ? 'https' : 'http'
      server.config.server.origin = `${scheme}://${host}:${addr.port}`
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), powerApps(), absoluteDevAssetUrls()],
  build: {
    // SVG は、大きさにかかわらず、アプリの中に埋め込む(既定は 4KB 以下だけ)。
    // 別ファイルの URL のままだと、Power Apps の画面(別のアドレス)から開いたときに、画像が壊れて表示されるため。
    assetsInlineLimit: (file) => (file.endsWith('.svg') ? true : undefined),
  },
});
