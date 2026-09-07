<div align="center">

# trip-ledger

**多人旅遊的記帳與分帳工具 —— 行程結束時直接告訴你誰要給誰多少錢。**

Nuxt 4 · TypeScript · Cloudflare Workers · D1

</div>

---

## About trip-ledger

這個專案的起點是一份用了好幾趟的 Google Sheet(`202603 神戶京都宇治.xlsx`),
裡面有行程、預訂、景點清單、共同花費、個人花費。它大致堪用,
但有幾個**結構性的**問題 —— 不是「再加一欄就好」,是表格這個形式本身處理不了的。

| 原表的問題 | 為什麼是結構性的 |
|---|---|
| 27 筆共同花費裡,**25 筆的「人員」欄是空的** | 不是忘了填。旅途中沒人想停下來開試算表打字,協作門檻太高 |
| 分帳細節退化成備註自由文字<br>`伊藤久右衛門 6,274 (民: 3857 / 喧: 2417)` | 表格只有一個「人員」欄,表達不了「A 付錢、但 B 和 C 各用了多少」 |
| 人數 `/2` 硬編碼在公式裡 | 只要有人中途加入、或某筆只有部分人參與,公式就得整欄重寫 |
| **公費完全無法表達** | 備註裡的 `米果玩具 1,735 (公)`、`飯店稅金 800 (公)` 是從公費付的。<br>表格沒有「這筆是公費出的」這個概念,只能寫進自由文字;<br>而且原檔從未定義「公」是什麼,得靠人記得 |
| 只算得出「平均一人花費」 | **完全沒有結算邏輯**。誰欠誰多少,表格從頭到尾沒有回答 |
| `SUM(C2:C74)` = 194,765 | 把日幣和台幣直接相加,這個數字沒有意義 |
| 匯率手填一個固定值 `0.201` | 補登昨天的支出時,用的還是今天填的那個數字 |

> [!NOTE]
> **核心洞察是第一條。** 付款人欄位空白不是資料品質問題,是產品問題 ——
> 所以這個 App 的解法是把記帳門檻壓到「點一個連結就能記」,而不是加更多欄位。

### Features

- **誰墊錢 vs 誰受益分開** — 一筆支出可以是「喧刷卡付了 6,274,但實際是民用 3,857、喧用 2,417」
- **算出誰要給誰多少錢** — 淨額 + 貪婪法減少轉帳筆數
- **逐幣別分開結算** — 台幣一組、日幣一組,絕不相加
- **雙軌帳本** — 共同花費(要分攤)與個人花費(只算自己),最後給你「我自己合計多少」
- **公費(common pot)** — 大家先各拿一筆錢出來,吃飯直接從公費付。結算時算出公費該退誰多少
- **三種分攤方式** — 均分 / 按份數 / 指定金額,只列實際參與的人
- **匯率在記帳當下 snapshot** — 取「消費當日」而非「查詢當下」,每筆可手動覆寫
- **現金 / 刷卡分流** — 兩者成本匯率不同,各自套用估算加成
- **預約開放時間提醒** — 日本餐廳「每月 1 號 12:00 開放訂位」的排程推播
- **免註冊協作** — 連結丟 LINE 群組,旅伴點開就能記帳
- **PWA** — 加到主畫面、離線可用

---

## Tech Stack

- **[Nuxt 4](https://nuxt.com)** + **[Vue 3](https://vuejs.org)** + TypeScript — 前後端同一個框架
- **[Nitro](https://nitro.build)** (`cloudflare_module` preset) — server routes 與排程
- **[Cloudflare Workers](https://developers.cloudflare.com/workers/)** — 部署目標,scale to zero
- **[Cloudflare D1](https://developers.cloudflare.com/d1/)** — SQLite,無連線池問題
- **[Tailwind CSS v4](https://tailwindcss.com)** — 設定寫在 CSS 的 `@theme`
- **[@vite-pwa/nuxt](https://vite-pwa-org.netlify.app/frameworks/nuxt)** — PWA + 自訂 service worker

<details>
<summary><b>為什麼是這些選擇</b></summary>

| 決定 | 理由 |
|---|---|
| Cloudflare Workers | 這個 App 一年只用幾週。serverless 沒人用就不計費,常駐容器 24 小時都在燒 |
| Workers 而非 Pages | **Cron Triggers 是 Workers 專有的**,預約提醒與匯率同步都靠它 |
| `ssr: false`(SPA) | 免費版每次呼叫只有 **10ms CPU**,SSR 每次都要在那預算內渲染 Vue;PWA 離線行為也單純得多。私人工具不需要 SEO |
| D1 (SQLite) 而非 Postgres | serverless 打 Postgres 會爆連線池,D1 天生沒這問題。資料量也遠遠用不到 Postgres |
| 金額存整數最小單位 | 浮點數存錢會累積誤差。JPY exponent 0、TWD exponent 2 |
| 分攤演算法放 `shared/` | 前端即時試算與後端寫入跑**同一份程式碼**,結果逐分錢一致,不會「畫面說剛好、送出被退回」 |

</details>

---

## Architecture

```
                朋友的手機（Safari → 分享 → 加到主畫面）
                              │ HTTPS
                              ▼
        ┌──────────────────────────────────────────────┐
        │        一個 Cloudflare Worker                 │
        │                                              │
        │  前端    Vue 3 SPA（ssr: false）+ PWA        │
        │  API     server/api/**   16 支端點            │
        │  排程    server/tasks/**                      │
        │            fx:sync        0 1 * * *  (UTC)   │
        │            reminders:run  */5 * * * * (UTC)  │
        └───────────────────────┬──────────────────────┘
                                ▼
                         D1 (SQLite)
```

**一次 `wrangler deploy`,前端 / API / 排程 / DB binding 全部上線。**

<details>
<summary><b>目錄結構</b></summary>

```
nuxt.config.ts          preset / scheduledTasks / PWA / Tailwind
wrangler.jsonc          D1 binding + Cron Triggers（必須手動維護，見 Troubleshooting）
schema.sql              資料表

app/
  pages/
    index.vue                 旅程列表（首頁）
    t/[trip]/index.vue        支出列表（可收合、可篩選）
    t/[trip]/new.vue          記一筆
    t/[trip]/settle.vue       ★ 誰欠誰多少
    t/[trip]/plan.vue         預約清單
    t/[trip]/members.vue      成員 + 分享連結
  components/
    expense/  ExpenseForm · PayerEditor · SplitEditor · ExpenseRow · ExpenseDetail
    settle/   TransferCard · MemberBalanceRow
    plan/     ReservationCard
    ui/       AppButton · AppField · AppSheet · Money · EmptyState · LoadingBlock
  composables/  useApi · useTrip · useTripId · usePushSubscription
  service-worker/sw.ts        自訂 SW：接收推播
  assets/css/main.css         設計系統（CSS 變數 + 深色模式）

server/
  api/trips/    16 支端點，全部經過 requireTrip
  tasks/        fx/sync · reminders/run
  utils/        settle · money · fx · push · reminders · trip · cf

shared/         前後端共用：money · split · types
test/           見 Testing
scripts/        import-excel.mjs
```

</details>

<details>
<summary><b>資料模型的關鍵</b></summary>

```sql
expenses          一筆支出（金額、幣別、當時匯率 snapshot、現金/刷卡）
expense_payers    誰付了錢    ─┐ 分成兩張表，
expense_shares    誰該分攤    ─┘ 「墊錢」和「受益」才能解耦
settlements       已經還過的款（結算時要扣掉）
fx_rates          每日匯率快照（補登時取得到當天的匯率）
reservations      預約開放時間（opens_at_utc）
```

`expense_shares` 只列出實際參與的人 —— 這是「部分成員參與的支出」能成立的原因,
也是原 Excel 的 `/2` 硬編碼做不到的事。

</details>

<details>
<summary><b>公費（common pot）怎麼表達</b></summary>

出國常見的做法:大家先各拿一筆錢出來放公費,吃飯、門票直接從公費付,
不用每筆都分帳。最後公費剩下的錢再退還。

> [!NOTE]
> 原始 Excel 的備註裡只寫「(公)」,全檔沒有任何地方定義它是什麼
> (搜「公費」是 0 筆命中)。這個語意由專案作者提供。
> 匯入腳本已把它展開成「(公費)」—— 備註的用途是讓人日後看得懂,
> 選清楚而不選逐字轉錄。

**現有資料模型就能表達,不需要額外的表:**

| 現實 | 資料 |
|---|---|
| 公費本身 | 一個 `member`（它不是人,但它是持有現金的實體） |
| 「民拿 10,000 出來放公費」 | `settlement`:民 → 公費 |
| 「這頓飯是公費付的」 | `expense`,payer = 公費,分攤給真正的受益人 |
| 「公費剩下的退還」 | 結算時自動算出來 |

已實測驗證(含出資不均的情況):

```
民、喧各出 10,000（共 20,000），公費付了晚餐 6,000 + 門票 4,000
  → 公費 → 民 ¥5,000
  → 公費 → 喧 ¥5,000        淨額總和 = 0 ✔

出資不均：民 12,000 / 喧 8,000，公費付晚餐 6,000（兩人均分）
  → 公費 → 民 ¥9,000
  → 公費 → 喧 ¥5,000        公費淨額 −14,000 = 正好是剩餘現金 ✔
```

> [!WARNING]
> **UI 目前沒有針對公費最佳化**,有兩個要注意的地方:
> 1. 記帳表單的「均分」預設會**勾選全部成員,包含公費** —— 公費不該是受益人,要手動取消勾選
> 2. 「投入公費」目前得用結算頁的「標記已還款」來記錄,語意上對不上
>
> 數學是對的,但這個用法目前得靠自己知道。見 Roadmap。

</details>

---

## Getting Started

### Prerequisites

| | 版本 | 備註 |
|---|---|---|
| Node.js | 22+ | 測試用 `--experimental-strip-types` 直接跑 `.ts` |
| pnpm | 10+ | **不要用 npm**,見下方警告 |
| Cloudflare 帳號 | — | **本機開發不需要**,只有部署才要 |

> [!WARNING]
> **用 pnpm,不要用 npm。** npm 10.9.4 在這個依賴圖上會崩在 arborist 的
> `#loadPeerSet`,錯誤訊息是 `Cannot read properties of null (reading 'edgesOut')`。
> 那是 npm 自己的 bug,不是專案的問題。

### Local Development

本機開發**不需要 Cloudflare 帳號** —— `nitro-cloudflare-dev` 會用 miniflare 模擬 D1,
而且 persist dir 就是 wrangler 的 `.wrangler/state/v3`,兩邊共用同一份本機資料庫。

```bash
pnpm install          # esbuild / workerd 的 build script 已在
                      # package.json 的 pnpm.onlyBuiltDependencies 批准

pnpm db:init          # 建本機資料表
pnpm dev              # → http://localhost:3000
```

> [!IMPORTANT]
> 啟動後**必做這一步**,否則每筆支出的 `fx_rate` 都會是 `null`:
> ```bash
> curl -X POST localhost:3000/api/admin/sync-rates
> ```

### 匯入原始 Excel（可選）

```bash
node scripts/import-excel.mjs http://localhost:3000
```

走 API 而不是直接寫 D1 —— 這樣才會經過 server 驗證,是對整條路徑的真實測試。

實測 **40 筆支出 + 5 筆預訂全數成功**,含負數(藥妝代購扣繳 −2,062)
與 JST→UTC 轉換(空蟬亭 12:00 JST → 03:00 UTC),總額與 Excel 摘要區完全吻合。

---

## Testing

全部**零依賴** —— 用 `node --experimental-strip-types` 直接跑,不需要 vitest 或任何 test runner。

```bash
pnpm test         # 單元測試（不需要 dev server）
pnpm test:api     # API 整合測試（需要 dev server 在跑）
```

| 測試 | 數量 | 守什麼 |
|---|---|---|
| `settle.test.ts` | 17 | 結算引擎:拆分守恆、淨額歸零、環狀債務壓縮 |
| `money.test.ts` | 28 | 金額轉換、四捨五入、幣別符號唯一性 |
| `sql-safety.test.ts` | 2 | **掃描原始碼**,把 SQL 插值 / 串接 / 動態子句本身當失敗 |
| `schema-types.test.ts` | 15 | `schema.sql` ↔ `shared/types.ts` 欄位一致 |
| `cron-config.test.ts` | 8 | `nuxt.config.ts` ↔ `wrangler.jsonc` 的 cron 同步 |
| `vue-compile.test.mjs` | 22 | 所有 SFC 實際編譯 |
| `settle.fuzz.ts` | 20000 | 隨機案例:全部歸零、不漏帳、轉帳 ≤ n−1 筆 |
| `api.test.ts` | 56 | 真實 HTTP + 真實 D1:驗證、結算、還款、刪除 |

### 這些測試是為了什麼寫的

後四支是**針對實際踩過的坑**寫的回歸測試,不是為了湊覆蓋率:

- **`vue-compile`** — `SplitEditor.vue` 曾有兩份 `readNumber`。
  56 個 API 測試全綠,但點進表單頁是一片紅色編譯錯誤。
  `node --check` 只看 `.ts`,看不到 `.vue`。
- **`cron-config`** — Nitro 沒有自動生成 Cron Triggers(見 Troubleshooting),
  兩邊不同步時**排程不會跑而且完全沒有錯誤訊息**。
- **`sql-safety`** — 注入是「review 看漏一次就成立」的漏洞,靠人眼守不住。
- **`schema-types`** — D1 的 `.first<T>()` 只是型別斷言、不做實際驗證,
  加了欄位忘記改型別編譯器不會抱怨。

`sql-safety` 和 `schema-types` 都做過**反向驗證**:故意植入
`WHERE base = ${base}` 和一個沒有對應型別的欄位,確認測試真的會失敗、還原後會通過。

### 撰寫慣例

- **SQL 一律是完全靜態字串,零插值。** 可選條件用
  `(?2 IS NULL OR e.kind = ?2)` 的 sentinel 寫法,不要拼接 WHERE。
- **金額在 API 邊界的單位不一致,要小心**:
  `expenses.post` 收「人類單位」(`amount: 13244`),
  `settlements.post` 收「最小單位」(`amount_minor`)。
- **顏色一律走 CSS 變數**(`--credit` / `--debit` / `--text-muted` …),
  不要寫 `dark:` 前綴或硬 hex。深色模式由 `prefers-color-scheme` 自動處理。
- 所有金額顯示加 `.tnum`(等寬數字),欄位才不會跳動。

---

## Deployment

```bash
npx wrangler login
npx wrangler d1 create trip-ledger     # 把回傳的 database_id 填進 wrangler.jsonc
pnpm db:init:remote
```

設定 secrets(`runtimeConfig` 對應的環境變數名 = `NUXT_` 前綴 + 駝峰轉大寫底線):

```bash
npx wrangler secret put NUXT_TASK_SECRET
npx wrangler secret put NUXT_PUBLIC_ORIGIN      # https://trip-ledger.<你的>.workers.dev
npx wrangler secret put NUXT_VAPID_PRIVATE_JWK  # 推播用，不做推播可跳過
npx wrangler secret put NUXT_VAPID_PUBLIC_KEY
npx wrangler secret put NUXT_VAPID_SUBJECT      # mailto:you@example.com

pnpm deploy
```

<details>
<summary><b>產生 VAPID 金鑰</b></summary>

```bash
node -e "
const {webcrypto:c}=require('crypto');
c.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']).then(async k=>{
  console.log('PRIVATE_JWK='+JSON.stringify(await c.subtle.exportKey('jwk',k.privateKey)));
  console.log('PUBLIC_KEY='+Buffer.from(await c.subtle.exportKey('raw',k.publicKey)).toString('base64url'));
});"
```

</details>

> [!CAUTION]
> **部署後務必到 Cloudflare dashboard 確認 Cron Triggers 真的建起來了。**
> 原因見下一節第一項。

---

## Troubleshooting

<details open>
<summary><b>排程沒有跑,而且沒有任何錯誤訊息</b></summary>

**Nitro 不會自動生成 Cron Triggers —— 已實測確認。**

文件說 `cloudflare_module` preset 會依 `scheduledTasks` 在 build 時生成,
但 `pnpm build` 後 `.output` 底下找不到任何含 crons 的 wrangler 設定
([nuxt-hub/core#648](https://github.com/nuxt-hub/core/issues/648)、
[nitro#3214](https://github.com/nitrojs/nitro/issues/3214))。

已在 `wrangler.jsonc` 手動宣告 `triggers.crons`,並用 `cron-config.test.ts`
擋住兩邊不同步。**改 `scheduledTasks` 時記得兩邊都要改。**

</details>

<details>
<summary><b>API 回 500「拿不到 Cloudflare binding」</b></summary>

binding 的取法在 Nitro 版本之間變過:

- Nitro v3 / Nuxt 5:`event.req.runtime.cloudflare.env`
- Nitro v2 / Nuxt 3:`event.context.cloudflare.env`

`server/utils/cf.ts` 兩個都試,拿不到會**明確報錯**而不是靜靜回 `undefined`
然後在 SQL 那行才炸。本機請確認 `wrangler.jsonc` 的 `d1_databases` 已宣告。

</details>

<details>
<summary><b>scheduled task 拿不到 D1</b></summary>

task 跑在請求生命週期外,官方沒有記載怎麼取 binding。
社群解法是 `experimental.asyncContext`(已開啟),dev 實測有效
(log 顯示 `[reminders:run] via binding`)。

但每個 task 仍保留 **self-fetch 後路**:拿不到 binding 就對自己的公開網址
(`NUXT_PUBLIC_ORIGIN`)發一次認證過的請求,讓工作在有 binding 的請求情境裡跑。
不管哪條路 cron 都會動,代價是多一次 invocation。

</details>

<details>
<summary><b>補登舊支出時匯率標成 (fallback:earliest)</b></summary>

`open.er-api.com` 免費版**只給最新匯率,沒有歷史資料**。
補登或匯入舊行程時 `rateOn()` 會退回「現有最早的一筆」並標記來源。

這種筆數的金額是近似值,UI 會提示使用者用 `fx_rate_override` 照信用卡帳單回填。

**為什麼不用台灣銀行牌告:** `rate.bot.com.tw/xrt/flcsv/0/day` 有 JS bot challenge,
從機房 IP 只會拿到 "Challenge Validation" 頁,換 User-Agent 無效 → Worker 一定被擋。
台銀是唯一有現金/即期買賣四價的權威來源,真要那個精度得靠家用網路的機器抓再回填。

</details>

<details>
<summary><b>換算金額和信用卡帳單對不起來</b></summary>

**這是預期的。** 誤差有三層疊加:

1. 中價 vs 你實際換現金/刷卡的成本價,有價差
2. 海外刷卡手續費(VISA / MC / JCB 約 1% + 銀行最高 0.5%;AmEx 2%)
3. **刷卡是以「店家請款日」的匯率計價**,請款日在消費後數日至數週

`cashSpreadPct` / `cardFeePct` 預設 1.5 **是假設值,不是官方數字**。
UI 上一律標示「估算值,實際以銀行請款為準」。

</details>

---

## Design Decisions

這幾項是**刻意的取捨**,不是待辦事項:

<details>
<summary><b>結算是貪婪近似解,不是數學最少筆數</b></summary>

最小化轉帳次數可歸約到 Subset Sum,屬 NP-Complete,沒有多項式時間最佳解;
Splitwise 自己也是用啟發式。UI 文案寫「已簡化」而非「最少」。

</details>

<details>
<summary><b>餘數永遠給 memberId 排序在前的人</b></summary>

實測 18 筆日幣共同支出裡有 7 筆金額是奇數,累積下來一方多分攤 7 圓(總額仍守恆)。

**刻意不修。** 這個排序決定論正是前端即時試算能和 server 逐分錢一致的原因
(兩邊跑 `shared/split.ts` 同一份程式碼)。改成隨機或按支出 id 輪替的話,
建立支出前拿不到 id,預覽就會和實際存檔不一致 —— 使用者會看到
「畫面說剛好,送出卻被退回」。用 7 圓的系統性偏差換可預測性,划算。

</details>

<details>
<summary><b>支出列表的篩選在前端做,不走 API</b></summary>

因為 Tab 徽章、摘要卡總計、篩選下拉的選項**都需要未篩選的完整清單**,
所以完整清單本來就在記憶體裡。搬到 API 會變成兩次往返拿同一批資料的子集,
還多一個載入狀態。

> [!WARNING]
> **加分頁時必須改成 server 篩** —— 否則只會篩到當前頁,是靜默的錯誤資料。
> `expenses.get.ts` 已有 sentinel 寫法,加參數是同樣模式。

</details>

<details>
<summary><b>Workers 免費版每次呼叫 10ms CPU</b></summary>

CRUD 與 2–10 人結算是微秒級,沒問題。**不要在 Worker 裡跑 OCR** ——
真要做收據辨識得掛獨立服務。

</details>

<details>
<summary><b>Cron 一律 UTC</b></summary>

日本 12:00 JST = 03:00 UTC。日台皆無日光節約時間,偏移是常數。

</details>

---

## Roadmap

- [ ] **公費的第一級支援** — `members` 加一個 `is_pot` 旗標,讓 UI 能:
      把公費排除在「均分」的預設勾選之外、把「標記已還款」在公費情境下改成「投入公費 / 退還公費」、
      在結算頁把公費的退款和成員之間的轉帳分開顯示。
      目前的做法(見上)數學正確但不好發現。
- [ ] 實際部署到 Cloudflare
- [ ] `pnpm typecheck` 清乾淨
- [ ] 手機斷點驗證

## Project Status

**已驗證**

- UI 在真實瀏覽器走過完整流程:旅程列表 → 記一筆(即時試算 10,000 分三人
  = 3,334 / 3,333 / 3,333)→ 送出 → 列表更新 → 結算
- 原始 Excel 40 筆全數匯入,總額與 Excel 摘要區完全吻合
  (共同 台幣 45,902 / 日幣 148,863;個人 台幣 −2,062 / 日幣 99,952)
- 結算結果:`【日幣】Hsuan → MIN JP¥74,435`、`【台幣】Hsuan → MIN NT$21,334`
- `pnpm build` 成功(316 kB / 105 kB gzip)
- scheduled task 在 dev 實際執行過

**未驗證**

- **沒有實際部署過**。`wrangler.jsonc` 的 `database_id` 仍是 placeholder
- 沒跑過 `pnpm typecheck`
- Web Push 沒對真實 iOS 裝置測過
- **手機斷點沒驗證** —— 請自己把視窗拉窄到 400px 以下,確認底部 tab bar 出現

---

## Attribution

匯率資料來自 [Exchange Rate API](https://www.exchangerate-api.com) 的 open access 端點,
其授權要求標註來源,UI 上請保留:

> Rates By [Exchange Rate API](https://www.exchangerate-api.com)
