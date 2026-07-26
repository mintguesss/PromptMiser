import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      // 有新版就自動更新，使用者不會卡在舊版
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'PromptMiser — Prompt 成本分析與壓縮',
        short_name: 'PromptMiser',
        description: '貼上 prompt 就能看到各模型的成本、一鍵壓縮省 token，還能拿到針對你的任務的省錢建議。',
        lang: 'zh-Hant',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#faf9f6',
        theme_color: '#faf9f6',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          // maskable：Android 會把圖示裁成圓形/圓角，這張已預留安全區
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // tokenizer 的字典檔約 2.3MB，預設 2MB 上限會被排除在離線快取外
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // /api 是動態請求，不要被 SPA fallback 攔截、也不要快取
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    // 本機開發時把 /api 轉給另一個 port 的後端，
    // 這樣前端程式碼一律用同網域相對路徑，部署到 Vercel 後不必改設定。
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
