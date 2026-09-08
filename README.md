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
| 27 筆共同花費裡,**25 筆的「人員」欄是空的** | 不是忘了填 —— 那 25 筆是**從公費出的**,而表格沒有一欄可以記這件事。<br>「留空」被當成了「公費」的代號,而這個約定只存在人的腦子裡 |
| 分帳細節退化成備註自由文字<br>`伊藤久右衛門 6,274 (民: 3857 / 喧: 2417)` | 表格只有一個「人員」欄,表達不了「A 付錢、但 B 和 C 各用了多少」 |
| 人數 `/2` 硬編碼在公式裡 | 只要有人中途加入、或某筆只有部分人參與,公式就得整欄重寫 |
| **公費完全無法表達** | 除了上面那 25 筆的「留空」,備註裡的 `米果玩具 1,735 (公)`、`飯店稅金 800 (公)` 也是公費付的。<br>表格沒有「這筆是公費出的」這個概念,所以它同時用**兩種**方式被暗示;<br>而且原檔從未定義「公」是什麼,得靠人記得 |
| 只算得出「平均一人花費」 | **完全沒有結算邏輯**。誰欠誰多少,表格從頭到尾沒有回答 |
| `SUM(C2:C74)` = 194,765 | 把日幣和台幣直接相加,這個數字沒有意義 |
| 匯率手填一個固定值 `0.201` | 補登昨天的支出時,用的還是今天填的那個數字 |
| 「預約時段」和「開放預約時間」擠在一起 | 這是**兩個相差好幾個月**的時間(10/1 開放搶隔年 1/1 的位子)。<br>而且三筆的年份還停在 2025 —— 上一版行程的殘留,沒人發現 |

> [!NOTE]
> **核心洞察是第一條。** 付款人欄位空白不是資料品質問題,是**表達能力**問題 ——
> 那 25 筆其實有一個很明確的答案(公費付的),只是表格沒有地方放它,
> 於是答案退化成一個沒人寫下來的約定。
> 所以這個 App 的解法是給「公費」一個真正的位置(`members.is_pot`),
> 並且把記帳門檻壓到「點一個連結就能記」,而不是加更多自由文字欄位。

### Features

- **誰墊錢 vs 誰受益分開** — 一筆支出可以是「喧刷卡付了 6,274,但實際是民用 3,857、喧用 2,417」
- **算出誰要給誰多少錢** — 淨額 + 貪婪法減少轉帳筆數
- **逐幣別分開結算** — 台幣一組、日幣一組,絕不相加
- **雙軌帳本** — 共同花費(要分攤)與個人花費(只算自己),最後給你「我自己合計多少」
- **結算回合** — 「今晚先把今天的帳結掉」,下次只列還沒結的明細。
  但**金額一律用整趟重算**,不是只算未結的那幾筆 —— 理由見下方,那是這個功能的核心
- **公費(common pot)** — 大家先各拿一筆錢出來,吃飯直接從公費付。結算時算出公費該退誰多少
- **公費投入是勾選式的** — 「今天大家各拿 5,000 出來」勾人、金額填一次,一次原子寫入
- **三種分攤方式** — 均分 / 按份數 / 指定金額,只列實際參與的人
- **總覽頁** — 一頁看完:公費剩多少、逐幣別總花費、每人合計與淨額
- **匯率在記帳當下 snapshot** — 取「消費當日」而非「查詢當下」,每筆可手動覆寫。
  當時抓不到匯率的支出,之後每次同步都會回頭補寫(否則那筆的換算金額會**每天漂移**)
- **只有刷卡加手續費** — 國外交易手續費預設 **1.5%**(Visa / MC / JCB 實務值),每筆可自訂。
  **現金預設 0%** —— 出發前在台灣換好的現金,成本在換鈔當下就固定了,再加價差是重複計價
- **預約開放時間提醒** — 日本餐廳「每月 1 號 12:00 開放訂位」的排程推播
- **訂位時間獨立記錄** — 「什麼時候開放搶」和「訂到哪一餐」是兩個欄位,可能差好幾個月;訂到之後打勾、時間有變可直接改
- **免註冊協作** — 連結丟 LINE 群組,旅伴點開就能記帳
- **旅程之間互相隔離** — 每個人只看得到自己建立的、或用分享連結進去過的旅程。
  建立者可以註冊帳號(換手機也找得回來、只有他能刪除旅程),旅伴不用
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
        │  API     server/api/**   30 支端點            │
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
schema.sql              資料表（全新資料庫用）
migrations/             既有資料庫的增量變更（見 Local Development）
  001-members-is-pot.sql
  002-reservations-booked.sql
  003-settlement-rounds.sql   ★ 結算回合的 2 張表 + 3 個欄位 + 2 個索引
  004-auth.sql                ★ 存取控制的 4 張表（users / sessions / session_trips / trip_access）

app/
  pages/
    index.vue                 旅程列表（首頁）
    login.vue                 ★ 登入 / 註冊（一頁兩用）
    t/[trip]/overview.vue     ★ 總覽：公費剩餘 / 總花費 / 每人合計 / 投入・退還
    t/[trip]/index.vue        支出列表（可收合、可篩選、可依金額排序）
    t/[trip]/new.vue          記一筆
    t/[trip]/settle.vue       ★ 誰欠誰多少 + 結算回合（預覽 / 關閉 / 歷史 / 撤銷）
    t/[trip]/plan.vue         預約 + 訂位
    t/[trip]/members.vue      成員（可改名 / 刪除）+ 公費 + 分享連結
  components/
    expense/  ExpenseForm · PayerEditor · SplitEditor · ExpenseRow · ExpenseDetail
    settle/   TransferCard · MemberBalanceRow
              RoundPanel ★ · RoundItemList · RoundTransferList · RoundHistoryCard
    plan/     ReservationCard
    ui/       AppButton · AppField · AppSheet · Money · EmptyState · LoadingBlock
  composables/  useApi · useTrip · useTripId · usePushSubscription
  service-worker/sw.ts        自訂 SW：接收推播
  assets/css/main.css         設計系統（CSS 變數 + 深色模式）

server/
  api/            25 支端點：21 支在 trips/[trip]/ 底下（全部經過 requireTrip）、
                  2 支 trips/ 列表與建立、2 支 admin/
    trips/[trip]/rounds.post.ts        ★ 關閉一次結算回合
    trips/[trip]/rounds/preview.get.ts ★ 這一輪要結什麼
    trips/[trip]/rounds/index.get.ts      結算歷史
    trips/[trip]/rounds/[id].get.ts       某一次的完整明細
    trips/[trip]/rounds/[id].delete.ts    撤銷（軟性）
    trips/[trip]/pot/moves.post.ts     ★ 批次投入 / 退還公費
  tasks/          fx/sync · reminders/run
  utils/          ledger ★ · settle · money · fx · push · reminders · trip · cf

shared/         前後端共用：money · split（含 previewShares）· types
test/           見 Testing
scripts/        import-excel.mjs · migrate.mjs · gen-icons.mjs · test-all.mjs
```

`server/utils/ledger.ts` 是**「誰欠誰多少」的唯一計算來源** ——
`balance.get.ts`(結算頁 / 總覽頁)和 `rounds/*`(結算回合)呼叫同一支。
兩邊各寫一份查詢的話,遲早會出現「結算頁說要付 1,850、按下去卻寫進 1,900」。

</details>

<details>
<summary><b>資料模型的關鍵</b></summary>

```sql
members                 成員。is_pot = 1 是公費（不是人，是持有現金的實體）
expenses                一筆支出（金額、幣別、當時匯率 snapshot、現金/刷卡、手續費 %）
  .settlement_round_id  已列入哪一次結算回合。NULL = 下次結算的明細會列到它
expense_payers          誰付了錢    ─┐ 分成兩張表，
expense_shares          誰該分攤    ─┘ 「墊錢」和「受益」才能解耦
settlements             錢從 A 移到 B（還款、投入公費、公費退還都是這個）
  .source               'manual'（人自己記的）/ 'round'（結算回合產生的）
  .round_id             屬於哪一次回合。撤銷回合只刪 source='round' 的
settlement_rounds       一次結算 = 一趟 + 一個幣別 + seq。reverted_at = 軟性撤銷
settlement_round_nets   結算當下每個人的淨額快照（含公費）—— 事後回答「這數字怎麼算的」
fx_rates                每日匯率快照（補登時取得到當天的匯率）
reservations            預約：opens_at_utc（何時開放搶）+ booked_for_utc（訂到哪一餐）
```

`expense_shares` 只列出實際參與的人 —— 這是「部分成員參與的支出」能成立的原因,
也是原 Excel 的 `/2` 硬編碼做不到的事。

**`reservations` 有兩個時間,不要搞混。** 日本熱門餐廳是「每月 1 號 12:00 開放下兩個月的座位」,
所以「什麼時候開放搶」(`opens_at_utc`)和「訂到哪一餐」(`booked_for_utc`)可能差好幾個月:
提醒看前者、行程看後者。原本只有前者,結果「我訂到哪一天」根本記不下來 ——
原 Excel 的「預約時段」欄就是後者,匯入時無處可放。

`members.is_pot` 上有 partial unique index(`WHERE is_pot = 1`),
一趟旅程最多一個公費 —— 兩個公費的話「還剩多少」就沒有唯一答案。

`settlement_rounds` 上有 `UNIQUE(trip_id, currency, seq)`,那是**併發防護**:
兩支手機同時按下結算會各自算出同一個 `seq`,資料庫只讓一個寫進去,
另一個拿到 UNIQUE 衝突 → 不會出現兩個回合各寫一份轉帳、金額變成兩倍。

> [!NOTE]
> `migrations/003` 加 `settlements.source` 時**沒有** `CHECK (source IN ('manual','round'))` ——
> SQLite 的 `ALTER TABLE` 不支援加 CHECK 約束(要加只能整表重建)。
> 所以「全新建的資料庫」比「migrate 過來的」多一層防護,
> 差異僅在最後一道防線:兩邊都靠 server 端守住(只有結算回合會寫 `'round'`)。

</details>

<details>
<summary><b>★ 結算回合：算術範圍 ≠ 明細範圍（整個功能的核心，別「優化」掉）</b></summary>

旅途中不是只在最後結算一次。「今晚先把今天的帳結掉」是常態,
所以要有一個東西代表「這一批帳結清了」—— `settlement_rounds`。
**一個回合 = 一趟 + 一個幣別**;一個按鈕同時結掉日幣和台幣,
會寫下當晚根本沒發生的台幣轉帳(桌上動的只有日幣現金)。

> [!IMPORTANT]
> **算術範圍是整趟,只有明細範圍是「還沒標記的那些」。**
>
> ```
> 算術範圍（nets / recorded / deferred）= 整趟到目前為止的所有帳，永遠不看標記
> 明細範圍（清單要列哪幾筆）          = 只有 expenses.settlement_round_id IS NULL 的
> ```
>
> 直覺的做法是「只把沒標記的帳拿來算」。**那是錯的,而且會算錯錢。**

為什麼子集算術是**金額上的**錯,不只是不精確:

**`settlements` 這一列沒有任何欄位指向它清掉的是哪一筆債。**
所以只要算術範圍是個真子集,就一定會遇到「這筆還款被算進來了,
但它對應的那筆債在範圍外」—— 於是同一筆錢被要求付兩次。
兩個具體會壞掉的流程:

| 流程 | 子集算術會發生什麼 |
|---|---|
| 公費先幫某人墊了款(`pot/moves` 的 `direction='out'`) | 那筆退還落在子集裡、被墊的那筆支出落在子集外 → 再叫另一個人付一次公費已經付掉的錢 |
| 使用者照建議自己付了錢,在結算頁按「標記已還款」,之後才關回合 | 回合把那筆手動還款吸收進來,吐出一筆**反方向**的轉帳 → 付款 / 反轉可以無限來回 |

而「整趟都算」為什麼不會重複要錢 —— 這是**可證明的無操作**:
已經結算過的支出貢獻 `net_r`,而當時那個回合寫下的 settlement 貢獻 `−net_r`,
兩者相加恰好是 0。所以把舊帳一起算進來**不改變任何數字**,
而且順手讓三件事全部免費變安全:吸收手動還款、補登過去日期的支出、
非後進先出地撤銷某個回合。

> [!CAUTION]
> 這條規則看起來非常像可以優化(「都結清了還算它幹嘛」),
> 而優化掉它的代價是**真的多要一次錢**、以及一個沒有出口的付款/反轉迴圈。
> `test/ledger.test.ts` 就是為了釘住這一條而存在的。

**公費在算術裡是完整成員,只在輸出時被拆開。**

公費必須參與 `netBalances`,否則淨額加起來不等於 0 ——
而 `minCashFlow` 對非零和輸入**不會拋錯,只會靜靜回傳不完整的清單**
(`settle.ts` 的 `if (credit <= 0 || debt >= 0) break`)。錢就這樣無聲消失。

但公費的腿不能寫成真的轉帳:第一天晚上 `net(公費) = −(信封裡還剩的現金)`,
照 `minCashFlow` 寫下去等於「把公費清空退還給大家」,**而那筆錢明天還要用**。

所以輸出分兩堆:

| | 內容 | 行為 |
|---|---|---|
| `recorded` | 兩端都是真人 | 回合會真的寫成 `settlements`(`source='round'`) |
| `deferred` | 任一端是公費 | **唯讀,永遠不寫入**。公費在總覽頁用「投入 / 退還」單獨對帳 |

丟掉公費的腿之後為什麼不會有人被多要或多付 —— 靠 `minCashFlow` 的**單邊性**:
每個成員只會出現在轉帳的一側(債權人永遠是收款方、債務人永遠是付款方)。
所以公費的腿一定**全部同向**,丟掉之後剩下的人身上的殘額**同號**。兩個推論:

```
殘額同號  ⇒ 沒有人被多要錢，也沒有人被多付錢
          ⇒ 回合永遠不可能把公費抽乾（它的腿一列都不會被寫下來）

Σ 殘額 = −net(公費) = 信封裡還剩的現金      ← 和總覽頁「剩餘 = −公費淨額」同一個數字
          ⇒「deferred 不寫入」沒有讓任何錢消失，
             只是把它延後到旅程結束用「退還」處理
```

**關閉回合 = 宣告「這些錢已經付了」。** 單階段,**沒有 `paid_at`**。

兩階段(先產生待付清單、之後逐筆勾)會讓同一筆債同時出現在回合裡、
和結算頁那顆「標記已還款」按鈕旁,而兩邊都沒有 idempotency ——
點兩次就會在 1,500 的債上記下 3,000,然後帳本開始要求反向轉帳。
**想要部分付款的正確做法是不要關回合**:先在結算頁逐筆「標記已還款」,
下次預覽自然只剩沒付的那些。

> [!WARNING]
> `expenses.settlement_round_id` 是**呈現用的標記**,不是「這筆錢已經清了」。
> 它唯一的作用是「下次明細從哪裡開始列」。
> 那筆支出在算術上永遠都還在帳本裡(這正是上面那個無操作證明的內容)。
>
> 所以 UI 的用字是**「已列入第 N 次結算」,不是「已結清」**。
> 債務是由那一輪的轉帳**整體**清掉的,不是一筆一筆對消 ——
> 叫它「已結清」會讓人以為可以逐筆勾銷,而那個心智模型會算錯錢。

**寫錢之前的檢查**(全部擋在 `rounds.post.ts`,寧可回 409 也不要寫錯金額):

- 逐筆驗「付款合計 == 分攤合計」(`findUnbalancedExpenses`)——
  資料庫可能被匯入腳本或手動 SQL 改過,結算是把錯誤變成真實金錢的那一步
- 驗淨額總和為 0(`assertZeroSum`)—— 因為 `minCashFlow` 自己不會抱怨
- `expect: { item_count, recorded_count }` 指紋核對 ——
  兩支手機同時操作時,擋掉「照著已經過期的畫面按下結算」
- 四件事在同一個 `dbh.batch()` 裡:回合列、淨額快照、`recorded` 轉帳、蓋章。
  要嘛全部成功,要嘛什麼都沒發生

**撤銷是軟性的**(`reverted_at`,列留著,帳上看得出「這裡曾經結算過又撤銷」),
而且**只刪 `source='round'` 的轉帳** —— 使用者自己記的還款和投入公費
是真的發生過的付款,撤銷回合不該把它們一起消滅。
撤銷之後那些支出回到「未結算」,下次預覽又會出現,這正是預期行為。

**端點**(`:trip` 吃 trip id 或 share_token —— 但**光知道 id 不等於有權限**,見 Access Control):

| | |
|---|---|
| `GET /api/trips/:trip/rounds/preview[?currency=JPY]` | 每個幣別一塊:`items` / `item_count` / `nets` / `recorded` / `deferred` / `blocked_reason`,外加 `pot_id` 與 `all_settled` |
| `POST /api/trips/:trip/rounds` | `{ currency, label?, note?, expect? }` → `201` |
| `GET /api/trips/:trip/rounds` | 結算歷史(含 `item_count` / `transfer_count` / `transfer_total_minor`) |
| `GET /api/trips/:trip/rounds/:id` | 當時的明細 + 淨額快照 + 轉帳 |
| `DELETE /api/trips/:trip/rounds/:id` | 撤銷 |

`GET /rounds/:id` 回的 `nets` 是**快照**而不是即時重算 ——
之後有人補登支出、改名字、刪帳,重算會得到不同的數字,
但**當時**是照這份淨額付的錢。存下來才有可稽核的軌跡。

已經蓋章的支出**不給刪**(`409`)。那筆帳已經被算進當時的轉帳、
錢也已經照那個數字付出去了;直接刪掉會讓那次結算的明細指向一筆不存在的支出。
要刪就先撤銷那次結算。

</details>

<details>
<summary><b>公費（common pot）怎麼表達</b></summary>

出國常見的做法:大家先各拿一筆錢出來放公費,吃飯、門票直接從公費付,
不用每筆都分帳。最後公費剩下的錢再退還。

> [!NOTE]
> 原始 Excel 用**兩種**方式暗示公費,而且兩種都沒有定義過
> (全檔搜「公費」是 0 筆命中),語意由專案作者提供:
>
> - 備註裡的「(公)」—— 匯入腳本展開成「(公費)」。
>   備註的用途是讓人日後看得懂,選清楚而不選逐字轉錄
> - **「人員」欄留空** —— 27 筆共同花費裡有 25 筆。匯入時記成公費付款(見上方匯入那節)

**用 `members.is_pot` 標記,不需要額外的表:**

| 現實 | 資料 |
|---|---|
| 公費本身 | 一個 `member`,`is_pot = 1`（它不是人,但它是持有現金的實體） |
| 「民拿 10,000 出來放公費」 | `settlement`:民 → 公費（總覽頁的「投入公費」） |
| 「這頓飯是公費付的」 | `expense`,payer = 公費,分攤給真正的受益人 |
| 「公費還剩多少」 | 投入 − 公費付掉的 − 已退還,逐幣別分開算 |
| 「公費剩下的退還」 | `settlement`:公費 → 民（總覽頁的「退還」） |

**怎麼用:**

1. 「成員」頁 → 建立公費(預設就叫「公費」,可以改名)
2. 「總覽」頁 →「投入公費」:**勾選這次有拿錢出來的人,幣別和金額只填一次**
   (預設全選,少數不參與的取消勾選就好)
3. 記帳時勾「這筆從公費付」 → 付款人自動設成公費、自動由**全體真人成員**均分
   (公費不進分攤名單,送進去 server 會 `400`)
4. 「總覽」頁隨時看剩多少、誰出了多少;最後用「退還」把剩的分回去(同樣是勾選式的)

`is_pot` 這個旗標讓 UI 認得出它,所以:記帳表單的均分名單**自動排除公費**
(公費是出錢的一方,不該替自己分攤一份),而且它在成員名單裡排最後、標成「公費 · 不參與分攤」。

**為什麼投入是一支批次端點而不是叫前端呼叫 N 次:**

`POST /api/trips/:trip/pot/moves`,body 是
`{ direction: 'in' | 'out', currency, entries: [{ member_id, amount_minor }], note? }`,
整批寫在同一個 `dbh.batch()` 裡。

| 理由 | |
|---|---|
| **公費投入天生是集體行為** | 「今天大家說好各拿 5,000 出來」是**一個**決定,不是 N 個決定。UI 就該長成勾選 + 填一次金額 |
| N 次請求會**半途失敗** | 第 3 個人失敗時前 2 個已經寫進去了,使用者得自己去把它們找出來刪掉 —— 而畫面上公費的剩餘已經是錯的 |
| 少 N−1 次往返 | 手機在國外用行動網路,每次往返都有感 |

> [!NOTE]
> 金額仍然是**逐人**存的(`entries[].amount_minor`),不是存一個共用金額。
> 「每人一樣」是最常見的情況,**但不是規則** ——
> 有人先墊多一點、有人身上剛好沒零錢。所以資料模型不把「一樣」寫死,
> UI 另外給一個「每人金額不同」的開關當逃生門。
>
> 端點會擋掉:同一個成員出現兩次(幾乎一定是 UI 的 bug,靜靜寫兩筆會讓剩餘莫名少一截)、
> 金額不是大於 0 的整數、以及「勾到的不是這趟的人」或「勾到公費自己」
> (公費對自己轉帳沒有意義,而且會讓淨額算錯)。

**正確性的不變量:**

```
剩餘現金 = −(公費的淨額)
```

投入 − 支出 − 退還(公費專用的聚合)和結算引擎算出的淨額,是兩條完全獨立的計算路徑,
必須得到同一個數字。`test/api.features.test.ts` 每次都會驗這一條:

```
民、喧各出 10,000（共 20,000），公費付了晚餐 6,000 + 門票 4,000
  投入 20,000 − 支出 10,000 − 退還 0 = 剩餘 10,000
  公費淨額 −10,000                    → 相反數 = 10,000  ✔
  日幣淨額總和 = 0                                        ✔

再退還民 5,000
  剩餘 5,000 ／ 公費淨額 −5,000       → 一致            ✔
  民的淨額歸零                                            ✔
```

這個不變量也是結算回合安全性的另一面:
`Σ(丟掉公費腿之後剩下的殘額) = −net(公費) =` 剩餘現金,
所以「`deferred` 不寫入」並不會讓任何錢消失,只是把它留到旅程結束用「退還」處理。

> [!TIP]
> 公費**超支**(付出去的比投入的多)時剩餘會是負數,總覽頁會標出來 ——
> 那個差額實際上是由當時付錢的人先墊著,不是帳算錯了。

</details>

<details>
<summary><b>匯率:同一筆帳明天看還是同一個數字嗎？（會，而且這件事需要維護）</b></summary>

會。**匯率是逐筆 snapshot 的**,不是每次顯示才去查:

```sql
expenses.fx_rate          寫入當下取到的中價（1 單位 currency = ? base_currency）
expenses.fx_rate_date     那個匯率是哪一天的
expenses.fx_rate_source   來源（open.er-api.com / identity / …(fallback:earliest)）
expenses.fx_rate_override 使用者照信用卡帳單回填的實際匯率。有值時優先
expenses.fx_markup_pct    套在中價之上的估算加成（現金價差 / 海外刷卡手續費）
```

而且取的是**消費當日**(`spent_at`)的匯率,不是「按下儲存的那一刻」——
補登昨天的支出用的就是昨天的匯率。這正是原 Excel 手填一個固定 `0.201` 做不到的事。

```
有效匯率 = (fx_rate_override ?? fx_rate) × (1 + fx_markup_pct / 100)
```

**新增:`backfillMissingRates()`(`server/utils/fx.ts`)每次同步匯率時回頭補寫。**

記帳時如果 `fx_rates` 是空的(還沒跑過 `sync-rates`),`rateOn()` 會回 `null`,
那筆支出的 `fx_rate` 就留空 —— 而 `balance.get.ts` 對 `fx_rate IS NULL` 的列
**退回用「今天」的匯率**換算。後果是:

- 那筆支出的台幣金額**每天都會變**(靜默的,沒有任何提示)
- 支出明細顯示的是存下來的匯率、總覽 / 結算顯示的是今天的匯率,**兩邊對不起來**

「同一筆帳今天看和明天看要是同一個數字」是這個 App 的基本承諾,
所以只要匯率一旦可得,就把它釘進那筆支出裡讓它停止漂移。
補的是**消費當日**的匯率(和記帳時同一套 `rateOn` 政策,含 fallback 標記),
不是今天的 —— 否則補完之後數字雖然固定了,卻固定在錯的值上。

放在 `syncRates()` 裡面而不是各個呼叫端:scheduled task 走 binding、
`/api/admin/sync-rates` 走 HTTP,兩條路都會經過 `syncRates`,只有那裡不會漏掉。
一次上限 500 筆 —— 免費版 Workers 每次呼叫只有 10ms CPU,不要一次掃全表。

> [!WARNING]
> **剩下的誠實警告:免費 API 沒有歷史匯率。**
> `open.er-api.com` 的 open access 端點只給最新匯率,所以補登或匯入舊行程時
> `rateOn()` 會退回「現有最早的一筆」,並把 `fx_rate_source` 標成
> `…(fallback:earliest)`。那種筆數的換算金額是**近似值**,UI 標成近似並提示
> 使用者用 `fx_rate_override` 照信用卡帳單回填。
> 回傳 `null` 反而更糟 —— `fx_rate` 留空的話,之後每個統計都得再猜一次匯率。

</details>

<details>
<summary><b>Access Control（存取控制）</b></summary>

在 issue #3 之前這個 App **完全沒有權限層**,而且那是刻意的 ——
註解裡寫明「這是自己和幾個朋友用的工具」。要開放給不特定使用者,有三個洞必須先補:

| 洞 | 症狀 |
|---|---|
| `GET /api/trips` 沒有 `WHERE` | 首頁列出資料庫裡**所有人**的旅程,連 `share_token` 一起回傳 |
| `requireTrip` 是 `share_token = ?1 OR id = ?1` | 拿到 id 就等於有權限,配合上一條等於後門大開 |
| `DELETE /api/trips/:trip` 不分身分 | 任何拿到連結的人都能刪掉整趟(支出 CASCADE,無法復原) |

### 採用的模型:混合式

**建立者有帳號,旅伴不用。** 理由是旅遊分帳的天然形狀就是「一個人開團、其他人被拉進來」,
強迫五個旅伴都註冊會直接殺死使用率。帳號解決的是另一件事:**換手機之後還找得回自己的旅程**。

| 身分 | 怎麼進來 | 能做什麼 |
|---|---|---|
| owner | 登入 + `trip_access` 有紀錄 | 全部,含刪除旅程、看 share_token |
| editor(訪客) | 持有 share_token,或這個 session 解鎖過 | 記帳、結算、改成員 —— 但不能刪除旅程 |
| 其他人 | — | `404`(不是 `403`,見下) |

### 四張表

```
users          帳號本身（email + PBKDF2 密碼雜湊 + 失敗鎖定）
sessions       一個瀏覽器一筆。user_id 為 NULL 就是訪客
               → 登入與未登入共用同一套 cookie 機制,requireTrip 只有一條路徑
session_trips  訪客憑 share_token 解鎖過的旅程
trip_access    帳號對旅程的正式權限（owner / editor）
               → 獨立一張表而非 trips.owner_id,之後「轉移旅程」不用改 schema
```

### 判斷順序(`server/utils/trip.ts`)

```
1. 已登入,且 trip_access 有這個 user  → 用該筆的 role
2. session 之前用 share_token 解鎖過   → editor
3. 網址上那一段就是有效的 share_token  → 解鎖並記進 session,editor
4. 以上皆非                            → 404
```

**第 4 條回 404 而不是 403** —— 回 403 等於告訴對方「這個 id 是存在的」,
那本身就是資訊洩漏,可以拿來枚舉出哪些旅程存在。

**`requireTrip` 的簽名刻意沒有改。** 21 個既有端點原封不動就自動受到保護 ——
權限是那種「漏掉一個檔案就前功盡棄」的東西,把它收斂成一個 choke point
比在 21 個地方各寫一次可靠得多。需要分辨 owner / editor 的少數端點
改用 `resolveTripAccess` 或 `requireOwner`。

### 分享連結一定要用 share_token

```js
// ✘ 壞掉:從旅程列表點進來時網址是 /t/<trip-id>,
//    而 trip id 對沒有權限的人是無效的 —— 朋友點開只會看到 404
const shareUrl = `${location.origin}/t/${route.params.trip}`

// ✔ useTrip().shareUrl —— 用 API 回傳的 share_token 組
```

這是這次改動最容易踩到的回歸。`useTrip()` 統一提供 `shareUrl`,
呼叫端不要自己拼(`app/layouts/default.vue` 和 `members.vue` 都吃過這個虧)。

### 無主旅程

權限層上線前建立的旅程沒有任何 `trip_access` 紀錄。它們仍能用 share_token 進去記帳,
但沒有人能刪除。登入的使用者可以在旅程列表按「認領」收為己有
(`POST /api/trips/:trip/claim`)。

> [!WARNING]
> 認領的條件是「登入 + 進得去這趟」,而進得去的條件是持有 share_token。
> 所以在你認領之前,**任何拿到那條連結的人都可以搶先認領**。
> 對既有的幾趟私人旅程可以接受;要更嚴就得改成 migration 時直接綁定 `user_id`。

### 密碼雜湊被 CPU 上限綁架

Workers 沒有原生 bcrypt/argon2,只剩 WebCrypto 的 PBKDF2。而 PBKDF2 的重點是「故意很慢」,
偏偏**免費版 Workers 每次呼叫只有 10ms CPU**。實測(`node scripts/bench-pbkdf2.mjs`):

| 迭代次數 | 本機耗時 | 10ms 預算 |
|---|---|---|
| 50,000 | 3.6 ms | ✔ |
| 100,000 | 7.2 ms | 線上很可能超標 |
| 200,000 | 14.5 ms | ✘ |
| 600,000(OWASP 建議值) | 45.3 ms | ✘ |

所以預設值是 **50,000**,那是被 CPU 上限逼出來的妥協,不是安全上的建議值。
升級 Workers Paid(30 秒 CPU)之後把 `pbkdf2Iterations` 改成 `600000` 即可 ——
每個使用者的迭代次數存在自己那一列,**舊帳號照樣登得進來**,
會在下次登入成功時自動用新參數重算。升級不需要任何資料遷移。

### 其他

- **session token 存雜湊** — cookie 放原始 token,DB 只存 SHA-256。DB 外洩時拿到的東西不能直接當 cookie 用
- **登入 / 註冊會換一組新 session** — 防 session fixation。訪客期間解鎖過的旅程會一起搬過去
- **email 不存在時也跑一次 PBKDF2** — 否則「查無此人」比「密碼錯」快一整個雜湊的時間,光看回應時間就能問出某個 email 有沒有註冊
- **連續 8 次失敗鎖 15 分鐘**
- **`Referrer-Policy: no-referrer`** — 否則頁面上任何一個外連(例如訂位連結指向的餐廳網站)都會在 log 裡看到完整網址,也就是 share_token
- **`X-Robots-Tag: noindex`** — 防止搜尋引擎收錄被分享到公開場合的旅程連結

### 已知限制

- **註冊會明確回「這個 email 已經註冊過」** — 可以拿來確認某個 email 有沒有在這裡註冊。
  要堵住得改成「我們寄了一封信給你」的流程,那需要先接 email 服務
- **沒有 email 驗證、沒有忘記密碼** — 密碼弄丟就進不去了
- **editor 拿不到 share_token** — 想再分享給新旅伴要請 owner 出面
- **沒有 token 輪替** — 連結外流目前只能刪掉整趟重建

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

> [!TIP]
> **沒裝 pnpm 也不用另外安裝。** Node 22 內建 corepack,而 `package.json` 已經
> 用 `packageManager` 釘死版本(`pnpm@10.23.0`),所以:
> ```bash
> corepack enable
> corepack pnpm install     # 之後 corepack pnpm <任何指令> 都可以
> ```
> 這樣拿到的一定是專案指定的那個 pnpm 版本,不會因為全域裝的版本不同而出事。

### Local Development

本機開發**不需要 Cloudflare 帳號** —— `nitro-cloudflare-dev` 會用 miniflare 模擬 D1,
而且 persist dir 就是 wrangler 的 `.wrangler/state/v3`,兩邊共用同一份本機資料庫。

```bash
pnpm install          # esbuild / workerd 的 build script 已在
                      # package.json 的 pnpm.onlyBuiltDependencies 批准

pnpm db:init          # 建本機資料表（全新資料庫）
pnpm db:migrate       # 既有資料庫補上新欄位（見下方）
pnpm dev              # → http://localhost:3000
```

> [!IMPORTANT]
> **`db:init` 不會幫既有資料庫補欄位。** `schema.sql` 用的是
> `CREATE TABLE IF NOT EXISTS` —— 表已經存在時它整段跳過,新加的欄位不會出現。
> 所以加了欄位之後要跑 `pnpm db:migrate`(線上是 `pnpm db:migrate:remote`)。
>
> `scripts/migrate.mjs` 會依檔名順序套用 `migrations/*.sql`,而且**重跑是安全的** ——
> SQLite 沒有 `ADD COLUMN IF NOT EXISTS`,已套用過的會噴 `duplicate column name`,
> 腳本把那個當成「這步早就做完了」而不是失敗。

> [!IMPORTANT]
> 啟動後**必做這一步**,否則每筆支出的 `fx_rate` 都會是 `null`:
> ```bash
> curl -X POST localhost:3000/api/admin/sync-rates
> ```
> 忘了先做也還救得回來 —— 這支同時會跑 `backfillMissingRates()`,
> 把已經記進去、`fx_rate` 還空著的支出補上**消費當日**的匯率。
> 但在補上之前那些支出的換算金額每天都會變,所以還是先做。

### 匯入原始 Excel（可選）

```bash
node scripts/import-excel.mjs http://localhost:3000
```

走 API 而不是直接寫 D1 —— 這樣才會經過 server 驗證,是對整條路徑的真實測試。

實測 **40 筆支出 + 5 筆預訂全數成功**,含負數(藥妝代購扣繳 −2,062)
與 JST→UTC 轉換(空蟬亭 12:00 JST → 03:00 UTC),總額與 Excel 摘要區完全吻合。

> [!IMPORTANT]
> **「人員」欄留空 = 這筆從公費付。** 共同花費 27 筆裡有 **25 筆**是這樣。
>
> 以前的做法是「暫記為 MIN,備註標一個 ⚠」—— 那是把一個未知硬塞給一個人,
> 算出來的「誰欠誰」是假的,而且**假得很有說服力**(有金額、有付款人、能結算)。
> 現在腳本會先建一個 `is_pot = 1` 的成員(`POST /api/trips` 的 `pot` 參數),
> 那 25 筆的付款人就記到它身上,備註寫的是理由而不是警告。
>
> 分攤名單一律**只有真人** —— 公費是出錢的一方,不是受益人
> (真的送進去 server 會 `400`)。
> 名字→id 的對照表也刻意只收真人:哪天資料裡的人員欄真的出現「公費」兩個字,
> 會直接炸掉而不是被默默解析成公費付款。

> [!WARNING]
> **匯入完成後公費的淨額會是一個很大的負數,那是對的。**
> 腳本只知道公費「付掉了多少」,不知道每個人「投入了多少」—— 原 Excel 沒記。
> 要讓公費平掉,得到總覽頁用「投入公費」把每個人拿出來的錢補上。
> 腳本結束時會把這句話印出來提醒。

> [!NOTE]
> **只涵蓋 4 張工作表**(共同花費 / 個人花費 / 預訂 / 下拉清單)。
> 原檔另外 5 張(行程 / 景點美食 / 必買必逛清單 / 行李清單 / 和服)沒有匯入,
> 資料庫也沒有能放的表 —— 見 Project Status。
>
> 另外,預訂的時間是**刻意的改寫**:原檔「預約時段」欄存的是用餐時段
> (而且空蟬亭 / 朝食喜心 / Moritaya 三筆的年份還停在 2025,是上一版行程的殘留),
> 匯入腳本填進 `opens_at_utc` 的是備註文字裡的「開放預約時間」。
> `booked_for_utc` **刻意留空**:年份差一年的日期匯進行程頁會「錯得很像真的」,
> 要怎麼修正還沒決定,所以先不寫。
>
> 訂位名字(`booking_name`)有三筆是從**「行程」工作表**抄來的 ——
> 「預訂」表根本沒有這一欄。空蟬亭 / 朝食喜心 是「Sammy Yang」、忍轟 是「Sammy」,
> 不統一是原檔就這樣,照抄不合併:日本餐廳現場是喊名字的,猜錯比留空更糟。

---

## Bugs Fixed

這幾個是加結算回合的時候順手挖到的**既有** bug —— 早就存在,只是沒人踩到。
會把它們寫進 README 是因為共同點很清楚:**它們都不會報錯,只會算出錯的數字。**

<details open>
<summary><b>只有結算、沒有共同支出的幣別會整個消失</b></summary>

`balance.get.ts` 的幣別清單是從 `paid` / `owed` 兩個查詢推出來的。
所以「有人投入了公費、但這個幣別還沒有任何共同支出」的情況下 ——
第一天晚上很常見 —— 那個幣別**完全不存在於結果裡**:
總覽頁的公費區塊顯示有 20,000,結算頁卻連那個幣別的區塊都沒有,
而「剩餘 = −net(公費)」這個不變量直接破掉(它連個可比的數字都拿不到)。

修法在 `server/utils/ledger.ts`:幣別集合改成 `paid ∪ owed ∪ settlements` 的**聯集**。
`rounds/preview.get.ts` 又多取一次聯集(把「有未結明細」的幣別也算進去)——
明細與算術是兩個查詢,寧可多取也不要少一塊。

</details>

<details>
<summary><b>expenses.post 完全沒有驗成員，四種輸入都回 201</b></summary>

這一段以前**整段不存在**。實測四種輸入都會拿到 `201`,然後靜靜把帳弄壞:

| 輸入 | 後果 | 現在 |
|---|---|---|
| 付款人 / 分攤人是**別的旅程**的成員 id | 列會寫進 `expense_payers`,但成員名單查不到 → 畫面顯示未知成員,而且結算永遠不平 | `400` |
| **公費當個人花費的付款人** | 公費付了錢卻沒有人分攤 → 「剩餘 = −net(公費)」破掉,實測差額等於該筆全額 | `400` |
| **公費出現在分攤名單裡** | 公費替自己分攤一份(自己欠自己)→ 結算產生一筆莫名的公費轉帳 | `400` |
| 多付款人裡有金額 `0` 或負數 | 付款合計仍可能湊對,但個別的墊款金額是假的 | `400` |

「不出錢的人請直接不要列」—— 這是那個 `0` 的錯誤訊息,也是規則本身。
結算是把這些錯誤變成**真實金錢**的那一步,所以擋在寫入的時候而不是結算的時候。

</details>

<details>
<summary><b>刪掉已經結算過的支出</b></summary>

那筆帳已經被算進當時的轉帳,而且錢已經照那個數字付出去了。
直接刪掉的話,那次結算的明細會指向一筆不存在的支出 ——
事後永遠沒辦法回答「這 1,850 是怎麼來的」。

現在回 `409`,訊息直接告訴你是哪個幣別的第幾次結算,以及「要刪先去撤銷那次結算」。
(判斷條件帶 `r.reverted_at IS NULL` —— 已經撤銷過的回合不該擋人。)

</details>

<details>
<summary><b>pnpm test 用 && 串起來，第一支失敗就吞掉後面全部</b></summary>

這個最陰險,因為它**讓紅燈看起來像小問題**。

實際踩到過:`schema-types` 掛掉時,後面的 `cron-config` / `vue-compile` /
20,000 筆 fuzz **三支根本沒有執行**,而畫面上顯示的是
「14 passed, 1 failed」—— 看起來只是某支測試有一個小斷言壞了。
實際上那次是全紅,而且沒人知道另外三支是什麼狀態。

現在 `pnpm test` 跑 `node scripts/test-all.mjs`:每支都跑完,最後一次列出結果,
只要有任何一支失敗 exit code 就是 1。

```
════════════════════════════════════════════════════════════
  ✔ settle
  ✔ money
  ...
全部 9 個測試檔通過。
```

</details>

<details>
<summary><b>fx_rate 為 NULL 的支出，換算金額每天都在漂移</b></summary>

見上方「匯率」那節。簡短版:`balance.get.ts` 對 `fx_rate IS NULL` 的列
退回用**今天**的匯率,所以那筆的台幣金額每天都不一樣,
而且和支出明細(顯示存下來的匯率)對不起來。
`backfillMissingRates()` 現在每次同步都會把它們釘住 —— 釘的是**消費當日**的匯率。

</details>

---

## Testing

全部**零依賴** —— 用 `node --experimental-strip-types` 直接跑,不需要 vitest 或任何 test runner。

```bash
pnpm test           # 9 個單元測試檔（不需要 dev server）        197 項
pnpm test:api       # API 整合測試（需要 dev server）
pnpm test:features  # 只跑公費 / 成員 / 手續費 / 訂位那一支         87 項
pnpm test:rounds    # 只跑結算回合那一支（需要 dev server）        306 項
```

`api.test` + `api.features` + `api.rounds` 合計 **449 項**,
全部打真實 HTTP + 真實 D1(dev 用 miniflare 的本機庫,和 wrangler 共用)。

> [!TIP]
> 每一支都可以直接跑,不一定要透過 `package.json` 的 script:
> ```bash
> node --experimental-strip-types test/api.rounds.test.ts
> ```
> `pnpm test:rounds` 就只是這一行的別名。

> [!IMPORTANT]
> **`pnpm test` 現在跑 `node scripts/test-all.mjs`,不是用 `&&` 串起來的。**
> 原本第一支失敗就會吞掉後面全部,而畫面上看起來只是「14 passed, 1 failed」——
> 那次其實是全紅的。理由見 Bugs Fixed。

| 測試 | 數量 | 守什麼 |
|---|---|---|
| `settle.test.ts` | 17 | 結算引擎:拆分守恆、淨額歸零、環狀債務壓縮 |
| `money.test.ts` | 28 | 金額轉換、四捨五入、幣別符號唯一性 |
| `split-preview.test.ts` | 34 | 表單的分攤試算 —— **個人花費送出鈕被鎖死那個 bug 的回歸測試** |
| `ledger.test.ts` | 66 | **結算的數學**:子集算術會重複要錢的反例、`minCashFlow` 的單邊性、公費殘額同號、`Σ 殘額 = −net(公費)`、`assertZeroSum` |
| `sql-safety.test.ts` | 2 | **掃描原始碼**,把 SQL 插值 / 串接 / 動態子句本身當失敗 |
| `schema-types.test.ts` | 15 | `schema.sql` ↔ `shared/types.ts` 欄位一致 |
| `cron-config.test.ts` | 8 | `nuxt.config.ts` ↔ `wrangler.jsonc` 的 cron 同步 |
| `vue-compile.test.mjs` | 27 | 所有 SFC 實際編譯 |
| `settle.fuzz.ts` | 20000 | 隨機案例:全部歸零、不漏帳、轉帳 ≤ n−1 筆 |
| `api.test.ts` | 56 | 真實 HTTP + 真實 D1:驗證、結算、還款、刪除 |
| `api.features.test.ts` | 87 | 公費收支與不變量、成員改名/刪除防護、刷卡手續費、訂位兩個時間 |
| `api.access.test.ts` | 51 | **存取控制**:旅程之間互不可見、id 不是憑證、editor 拿不到 share_token、只有 owner 能刪、認領無主旅程、登出後看不到東西 |
| `api.rounds.test.ts` | 306 | **結算回合的 15 組情境**:公費不會被清空、公費墊款後不再重複收、吸收手動還款不吐反向轉帳、連續兩回合不互相反轉、撤銷是精確反運算且不刪手動還款、舊畫面指紋防護、蓋章的支出不准刪、幣別互相隔離、`pot/moves` 的原子性 |

`ledger.test.ts` 是純函式測試(不需要 dev server),`api.rounds.test.ts` 打真實 HTTP。
兩層是刻意的:數學性質在單元層用隨機案例壓,而「錢真的有沒有寫進資料庫」
只有整合層答得出來。`ledger.test.ts` 裡還有一組
**[防漂移]** 斷言,確保測試自己那份 `recorded` / `deferred` 的切法
和 `server/utils/ledger.ts` 完全一致 —— 否則測試會開始守一個不存在的實作。

### 這些測試是為了什麼寫的

大部分是**針對實際踩過的坑**寫的回歸測試,不是為了湊覆蓋率:

- **`split-preview`** — 個人花費的送出鈕**被永久鎖住,完全記不了帳**。
  原因:表單把分攤 draft 設成 `{ mode:'exact', amounts:{ [owner]: null } }`,
  而 exact 模式會濾掉 `null` → 試算結果是空的 → 驗證判定「請選擇分攤的人」。
  **56 個 API 測試全綠**,因為問題在 `.vue` 的 computed 裡,沒有任何測試碰得到。
  所以修法不只是改那個判斷,而是把規則搬到 `shared/split.ts` 的
  `previewShares()` 變成可測的純函式 —— 測試碰不到的地方,bug 就會住在那裡。
- **`vue-compile`** — `SplitEditor.vue` 曾有兩份 `readNumber`。
  56 個 API 測試全綠,但點進表單頁是一片紅色編譯錯誤。
  `node --check` 只看 `.ts`,看不到 `.vue`。
- **`cron-config`** — Nitro 沒有自動生成 Cron Triggers(見 Troubleshooting),
  兩邊不同步時**排程不會跑而且完全沒有錯誤訊息**。
- **`sql-safety`** — 注入是「review 看漏一次就成立」的漏洞,靠人眼守不住。
- **`schema-types`** — D1 的 `.first<T>()` 只是型別斷言、不做實際驗證,
  加了欄位忘記改型別編譯器不會抱怨。
- **`ledger` / `api.rounds`** — 「算術範圍是整趟」這條規則**看起來像可以優化**,
  而優化掉它會多要一次錢。所以測試不是驗「結果對不對」,是直接驗
  **那兩個實際壞掉過的流程**:公費墊款之後不會再向另一個人收一次、
  照建議付款並手動標記之後下一回合不會吐出反方向的轉帳。
  另外壓 `minCashFlow` 的單邊性(隨機 4,000 組淨額向量),
  因為「丟掉公費的腿之後沒有人被多要錢」整個建立在那條性質上。

`sql-safety`、`schema-types`、`split-preview` 都做過**反向驗證**:分別故意植入
`WHERE base = ${base}`、一個沒有對應型別的欄位、以及還原成有 bug 的個人花費判斷,
確認測試真的會失敗(`split-preview` 掉 9 項)、還原後會通過。
沒做過反向驗證的測試,你不知道它到底有沒有在守。

### 撰寫慣例

- **SQL 一律是完全靜態字串,零插值。** 可選條件用
  `(?2 IS NULL OR e.kind = ?2)` 的 sentinel 寫法,不要拼接 WHERE。
  部分更新(PATCH)不准動態拼 SET —— 用
  `CASE WHEN ?flag = 1 THEN ?value ELSE col END` 表達「這個欄位有沒有被送來」,
  這樣「不要動」和「清成 NULL」才分得開(`COALESCE` 分不出來)。
  範例見 `reservations/[id].patch.ts`。
- **金額在 API 邊界的單位不一致,要小心**:
  `expenses.post` 收「人類單位」(`amount: 13244`),
  `settlements.post` 與 `pot/moves` 收「最小單位」(`amount_minor`)。
- **淨額只有一個計算來源。** 要「誰欠誰多少」一律呼叫
  `server/utils/ledger.ts` 的 `tripLedger()`,不要自己再寫一份 SQL。
  兩份查詢遲早會漂移,而漂移的症狀是「畫面說 1,850、按下去寫進 1,900」。
- **任何要把轉帳寫進資料庫的路徑,都必須先自己證明輸入是零和的**
  (`assertZeroSum`)。`minCashFlow` 對非零和輸入不會拋錯,只會靜靜回傳
  不完整的清單 —— 不要指望下游會抱怨。
- **顏色一律走 CSS 變數**(`--credit` / `--debit` / `--text-muted` …),
  不要寫 `dark:` 前綴或硬 hex。深色模式由 `prefers-color-scheme` 自動處理。
- 所有金額顯示加 `.tnum`(等寬數字),欄位才不會跳動。

---

## Deployment

### Cloudflare vs Vercel

**結論:走 Cloudflare。這個專案在 Vercel 免費方案上跑不起來,不是「比較差」而是「不能用」。**

| | Cloudflare Workers | Vercel |
|---|---|---|
| 每 5 分鐘的預約提醒 | ✅ 免費方案就能跑(每個 Worker 3 個 cron trigger) | ❌ **Hobby 只允許「一天一次」**,`*/5 * * * *` 會在部署時直接被拒 |
| Cron 觸發時間精度 | 準時 | Hobby 就算改成每天一次,也只保證「那個小時內某一刻」 |
| 資料庫 | D1 綁定即用,免費 5 GB / 5M 列讀取・10 萬列寫入 每天 | ❌ **D1 是 Cloudflare 專屬**,得整個換掉(Neon / Turso / Vercel Postgres) |
| 要改的程式 | 0 | Nitro preset 換成 `vercel`、DB 層整層重寫、cron 改 `vercel.json` |
| 成本 | 免費方案就夠(一年只用幾週) | 要 cron 精度就得上 **Pro($20/月)** |

要在 Vercel 跑,等於放棄兩個核心功能之一(提醒)或重寫資料層。
**Cron Triggers 是 Workers 專有的**,這也是當初選 Workers 而不是 Pages 的原因。

> [!NOTE]
> **2026-09-01 起 D1 免費方案超量會直接回錯誤**,不再是軟性限制。
> 對這個專案來說遠遠用不到(每 5 分鐘的排程一天 288 次查詢,
> 免費額度是每天 5M 列讀取),但值得知道。

### 步驟(Cloudflare)

```bash
npx wrangler login
npx wrangler d1 create trip-ledger     # 把回傳的 database_id 填進 wrangler.jsonc
pnpm db:init:remote                    # 建表
pnpm db:migrate:remote                 # 補上增量變更（is_pot / booked_for_utc /
                                       #   settlement_rounds …）
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

注意這**不是** `fx_rate` 為 `NULL` 的那個問題(那個是「還沒同步過匯率」,
`backfillMissingRates()` 會補;見「匯率」那節)。`fallback:earliest` 是
「有匯率,但不是那一天的」,補了也還是近似值,只有 `fx_rate_override` 治得了。

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

不過 `minCashFlow` 有一個**用得上的**性質:**單邊性** ——
每個成員只會出現在轉帳的一側(債權人永遠收款、債務人永遠付款)。
結算回合把公費的腿丟掉之後不會有人被多要錢,靠的就是這一條。

</details>

<details>
<summary><b>結算回合是單階段的，沒有「待付款」狀態</b></summary>

按下結算就等於宣告「這些錢已經付了」,沒有 `paid_at`、沒有兩階段。
理由是 idempotency:兩階段會讓同一筆債同時出現在回合裡和結算頁的
「標記已還款」旁邊,而兩邊都沒有防重複 —— 點兩次就會在 1,500 的債上記下 3,000。

**部分付款有明確的路徑,只是不是「關一個部分的回合」:**
先在結算頁逐筆「標記已還款」,下次預覽自然只剩沒付的那些。
按錯了就 `DELETE /rounds/:id` 撤銷。

</details>

<details>
<summary><b>公費的轉帳建議永遠是唯讀的</b></summary>

第一天晚上 `net(公費) = −(信封裡還剩的現金)`,照建議寫下去等於把公費清空。
所以任一端是公費的轉帳歸到 `deferred`,只顯示、不寫入,
旅程結束在總覽頁用「退還」處理。完整推導見 Architecture 的結算回合那節。

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

- [x] **分階段結算(settlement rounds)** — `settlement_rounds` / `settlement_round_nets`、
      `expenses.settlement_round_id`、`settlements.round_id` + `source`,
      五支端點(preview / close / list / detail / revert)。
      **算術範圍是整趟、明細範圍才是未結的那些**,公費的腿 `deferred` 不寫入
- [x] **公費批次投入 / 退還** — `POST /pot/moves`,勾人 + 金額填一次,一個 atomic batch
- [x] **公費的第一級支援** — `members.is_pot` 已加,均分自動排除公費,
      「投入公費 / 退還」有了對得上語意的入口(總覽頁),剩餘與出資明細也算得出來
- [x] **淨額計算收斂成一份** — `server/utils/ledger.ts`,`balance` 與 `rounds/*` 共用,
      不可能漂移
- [x] **匯率不再每天漂移** — `backfillMissingRates()` 把 `fx_rate IS NULL` 的支出
      補上**消費當日**的匯率,每次同步都跑
- [x] **`expenses.post` 補上成員驗證** — 跨旅程的成員 id、公費當付款人 / 當受益人、
      0 或負數的墊款金額,全部 400(見 Bugs Fixed)
- [x] **`pnpm test` 不再吞掉後面的測試** — `scripts/test-all.mjs`
- [x] **訂位時間與開放時間分開** — `reservations.booked_for_utc` / `booking_name` / `party_size`,
      可打勾「我訂到了」、事後改時間
- [x] **成員改名 / 刪除**(有帳的擋住,見 `members/[id].delete.ts`)
- [x] 支出列表可依金額排序(同幣別內)
- [x] 國外交易手續費可自訂(預設 1.5%)
- [x] **結算頁接上回合 UI** — `settle.vue` + `settle/RoundPanel` ·
      `RoundItemList` · `RoundTransferList` · `RoundHistoryCard`:
      本次要結算的明細、關閉本輪、結算歷史、展開某一輪的明細、撤銷。
      公費的腿在畫面上一律沒有按鈕,而蓋章的支出叫「已列入第 N 次結算」**不是「已結清」**
- [ ] **行程表** — 原 Excel 的「行程」「景點美食」「必買必逛」「行李清單」四張表**還沒有對應功能**,
      資料庫也沒有能放的表(見下方 Project Status)
- [ ] 實際部署到 Cloudflare
- [ ] `pnpm typecheck` 修復 —— **目前是壞的,而且不是專案的錯**:
      TypeScript 7.0.2 移掉了 `./lib/tsc` 這個 export,而 vue-tsc 3.3.11 還在 require 它,
      所以它在讀到任何專案檔案之前就先炸了。要嘛把 typescript 釘回 5.x,要嘛等 vue-tsc 更新。
      (`pnpm test` 的 `vue-compile` 有實際編譯所有 SFC,所以不是完全沒有把關。)
- [ ] 手機斷點驗證 —— 底部 tab bar 現在有 **6 個**,320px 機身要親眼確認
- [ ] 預約的刪除(目前只能標成已取消)

## Project Status

**已驗證**

- 原始 Excel 40 筆支出 + 5 筆預訂全數匯入(`40 成功 / 0 失敗`、`預訂 5/5`),
  四個合計欄與 Excel 摘要區完全吻合
  (共同 台幣 45,902 / 日幣 148,863;個人 台幣 −2,062 / 日幣 99,952)
- **197 項單元測試 + 449 項 API 整合測試 + 20,000 筆 fuzz** 全綠
  (`pnpm test` 的 9 個測試檔全部執行完才回報,見 Bugs Fixed)
- 公費的不變量(剩餘 = −淨額)由兩條獨立計算路徑交叉驗證
- **結算回合的兩個範圍**(算術 = 整趟 / 明細 = 未標記)由 `test/ledger.test.ts` 與
  `test/api.rounds.test.ts` 兩層守住,含「公費墊款後不會重複要錢」與
  「吸收手動還款不會產生反方向轉帳」兩個實際壞過的流程
- `pnpm db:migrate` 重複執行安全(已實測跑兩次)
- scheduled task 在 dev 實際執行過

> [!NOTE]
> **匯入後的結算結果變了,而且變得很有教育意義。**
> 舊版腳本把 25 筆沒付款人的帳記到 MIN 身上,所以結算出來是
> 「Hsuan → MIN 日幣 74,428 / 台幣 21,334」——
> 那個數字**建立在一個猜測上**。
>
> 現在那 25 筆記給公費,實測的結果是:
>
> ```
> 【日幣】Hsuan −74,435 ／ MIN −64,428 ／ 公費 +138,863
> 【台幣】Hsuan −21,334 ／ MIN −22,951 ／ 公費 +44,285
>   recorded（人與人之間要轉的）= 0 筆
>   deferred（欠公費的，唯讀）  = 各幣別 2 筆
> ```
>
> **人與人之間一筆都不用轉**,因為所有的錢都是公費出的 ——
> 這是原檔真正的樣子。公費剩餘是負的(日幣 −138,863 / 台幣 −44,285),
> 因為原 Excel **沒有記任何人投入了多少**;那不是算錯,是原始資料缺這一塊。
> 到總覽頁用「投入公費」補上之後,人與人之間的淨額才會出現。
>
> 日幣兩人差 10,007 = MIN 墊的 Icoca 10,000 + 奇數金額的餘數 7 圓
> (見 Design Decisions);台幣差 1,617 = Hsuan 墊的 Icoca。
>
> `GET /rounds/preview` 對這趟回的是 `JPY: 18 筆明細 / 0 筆 recorded`、
> `TWD: 9 筆明細 / 0 筆 recorded`,`blocked_reason` 皆為 `null`。

**未驗證**

- **沒有實際部署過**。`wrangler.jsonc` 的 `database_id` 仍是 placeholder
- **`pnpm build` 沒有在這一輪重跑** —— 上次成功的數字(286 kB / 98.2 kB gzip)
  是加結算回合 UI 之前的。`vue-compile` 有實際編譯全部 27 個 SFC,
  所以編譯錯誤擋住了,但 bundle 大小是舊數字
- **UI 這一輪從頭到尾沒有在瀏覽器裡開過** —— 這次沒有可用的瀏覽器工具,
  所以結算回合面板、總覽頁、公費勾選面板、金額排序、成員編輯、訂位面板
  全部只有 **SFC 編譯 + API 層**驗證過。
  `split-preview.test.ts` 釘住了送出鈕那條規則、`api.rounds.test.ts` 釘住了
  回合的每一條金錢語意,但**版面與互動沒有任何目視確認**
- **結算回合的 UI 尤其需要親眼看** —— 那頁現在要同時顯示兩種範圍的數字
  (明細是未結的那幾筆、金額是整趟重算),文案有沒有把這件事講清楚
  只有真的看過才知道。看不懂的話使用者會自己去加總、發現對不起來,然後不敢信任這個 App
- `pnpm typecheck` 是壞的(見 Roadmap,原因在工具鏈不在專案)
- Web Push 沒對真實 iOS 裝置測過
- **手機斷點沒驗證** —— 底部 tab bar 現在有 6 個,請把視窗拉到 320–400px 確認沒有擠爆

**不在範圍內**

原 Excel 共 9 張工作表,目前只涵蓋 4 張(共同花費 / 個人花費 / 預訂 / 下拉清單)。
「行程」「景點美食」「必買必逛清單」「行李清單」**沒有匯入,資料庫也沒有對應的表** ——
這個 App 定位是記帳與分帳,行程規劃要另外設計資料模型。
其中「行程」表存有來回機票時間(出發 2026-03-08 09:00、回程 2026-03-14 11:30)
與七天的逐日行程,想要的話見 Roadmap。

---

## Attribution

匯率資料來自 [Exchange Rate API](https://www.exchangerate-api.com) 的 open access 端點,
其授權要求標註來源,UI 上請保留:

> Rates By [Exchange Rate API](https://www.exchangerate-api.com)
