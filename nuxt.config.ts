import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-09-07',

  // SPA 而非 SSR。三個理由:
  //  1. Workers 免費版每次呼叫只有 10ms CPU,SSR 每次都要在那個預算內渲染 Vue
  //  2. 這是 PWA,要離線可用 —— SPA 的離線行為單純得多
  //  3. 私人工具,不需要 SEO
  // server routes(server/api/**)不受影響,照樣全部可用。
  ssr: false,

  // nitro-cloudflare-dev 讓 dev 模式也拿得到 D1 binding（miniflare 模擬）
  modules: ['@vite-pwa/nuxt', 'nitro-cloudflare-dev', '@nuxt/icon', '@vueuse/nuxt'],

  css: ['~/assets/css/main.css'],

  // Tailwind v4 走 Vite plugin，不需要 tailwind.config.js（設定寫在 CSS 的 @theme 裡）
  vite: {
    plugins: [tailwindcss()],
  },

  nitro: {
    preset: 'cloudflare_module',
    experimental: {
      tasks: true,
      // asyncContext 是社群回報「讓 task 拿到 Cloudflare binding」的做法。
      // 官方文件未記載,所以 server/utils/cf.ts 另有 self-fetch 後路,
      // 不管這個 flag 有沒有效,cron 都能動。
      asyncContext: true,
    },
    // Nitro 會在 build 時把這些自動寫成 wrangler 的 Cron Triggers。
    // 一律 UTC:0 1 * * * = 台灣 09:00;日本 12:00 JST = 03:00 UTC。
    scheduledTasks: {
      '0 1 * * *': ['fx:sync'],
      '*/5 * * * *': ['reminders:run'],
    },
  },

  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant-TW' },
      link: [
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/favicon-32.png' },
        { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/favicon-16.png' },
        // iOS 加到主畫面時抓這一張(它不看 manifest 的 icons)
        { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      ],
      meta: [
        { name: 'theme-color', content: '#3f6fd0' },
        // iOS 主畫面啟動時的狀態列樣式
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'apple-mobile-web-app-title', content: '旅帳' },
      ],
    },
  },

  runtimeConfig: {
    fxBase: 'TWD',
    fxSourceUrl: 'https://open.er-api.com/v6/latest',
    // 估算用的價差假設,不是官方數字。可用每筆的 fx_rate_override 覆寫。
    // 現金預設 0:這個團的做法是**出發前就在台灣換好現金**,
    // 那筆錢的成本在換鈔當下就固定了,記帳時再加一次價差等於重複計價。
    // (如果是在當地 ATM 提領或臨櫃換,那才有價差 —— 那種情況每筆自己填。)
    cashSpreadPct: '0',
    // 刷卡才有國外交易手續費:國際組織費 + 發卡行加收,
    // 台灣的 Visa / Mastercard / JCB 實務上合計約 1.5%(AmEx 約 2%)。
    cardFeePct: '1.5',
    // wrangler secret put NUXT_VAPID_PRIVATE_JWK / NUXT_VAPID_PUBLIC_KEY / NUXT_VAPID_SUBJECT
    vapidPrivateJwk: '',
    vapidPublicKey: '',
    vapidSubject: '',
    // task 走 self-fetch 後路時用的共享密鑰
    taskSecret: '',
    publicOrigin: '',
  },

  pwa: {
    registerType: 'autoUpdate',
    // injectManifest 才能用自己的 service worker(推播需要)
    strategies: 'injectManifest',
    // ⚠️ 這個 srcDir 是相對於 Nuxt 的 srcDir 解析，而 Nuxt 4 的 srcDir 是 app/，
    // 所以實際位置是 app/service-worker/sw.ts。放在專案根目錄會噴 ENOENT。
    srcDir: 'service-worker',
    filename: 'sw.ts',
    manifest: {
      name: '旅遊記帳',
      short_name: '旅帳',
      lang: 'zh-TW',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#3f6fd0',   // 要和 app.head 的 theme-color meta 一致
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        // maskable:Android 會把圖示裁成圓形/圓角,圖形必須落在中央 80% 安全區內。
        // 沒有這一張的話,系統會自己在四周補白邊,看起來像縮小一號的貼紙。
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    devOptions: { enabled: true, type: 'module' },
    // public/ 裡要被 SW 預先快取的檔案
    includeAssets: ['favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png'],
  },
})
