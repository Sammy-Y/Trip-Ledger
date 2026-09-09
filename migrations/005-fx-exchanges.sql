-- 換匯紀錄(fx_exchanges)。issue #6
--
-- ── 為什麼需要這張表 ────────────────────────────────────────────
--
-- 我們的做法是「出發前在台灣分次換好」:第一次 0.21 換 ¥5,000、
-- 第二次 0.205 換 ¥10,000。之後在當地付現就是從這 ¥15,000 裡面出。
--
-- 在這張表之前,資料庫裡**沒有「換匯」這個事件**,所以三個問題全部答不出來:
--   ① 我這趟換了多少日幣?折合台幣多少?
--   ② 我花了多少日幣?
--   ③ **我手上還剩多少?**  ← 這才是旅途中真正想知道的那一個
--
-- ── 存兩邊的金額,不存匯率 ──────────────────────────────────────
--
-- 「第 1 次 0.21」直覺上會想存成 rate = 0.21,但那是錯的三次方:
--   1. 匯率是浮點數,存了它金額就得由它算出來 → 回到浮點數存錢的老問題
--      (整個 schema 的第 2 個設計決定就是不做這件事)。
--   2. 加權平均會失真。兩筆各自的匯率再平均是 (0.21 + 0.205) / 2 = 0.2075,
--      而正確答案是 3,100 / 15,000 = 0.2067 —— 差在第二筆的金額是第一筆的兩倍。
--   3. 使用者實際付出去的是**台幣整數**。存匯率的話那個整數要反推,
--      而反推的結果和他銀行帳戶扣掉的數字不一定一樣。
--
-- 所以存 amount_minor(換到的)+ cost_minor(付出的),匯率一律當導出值:
--   有效匯率     = cost / amount
--   加權平均匯率 = Σcost / Σamount   ← 兩個總和的比值,所以**與紀錄順序無關**
-- 這個定義在 shared/money.ts 的 exchangeRate() 只有一份,前後端共用。
--
-- 上面那兩筆就是:
--   (MIN, JPY,  5000, TWD, 105000)   -- 有效匯率 0.21
--   (MIN, JPY, 10000, TWD, 205000)   -- 有效匯率 0.205
--
-- ── 這張表**不參與任何計價** ────────────────────────────────────
--
-- 記帳全部用日幣,不需要換算,所以換匯匯率**不會**被拿去重算支出的台幣金額
-- (convertToBase() 一行都沒改)。它也不進淨額、不進結算回合、不碰公費 ——
-- 那正是「刪掉一筆換匯是安全的」的原因,也是編輯 / 刪除不需要像
-- 公費金流那樣寫併發前提的原因(對照 server/utils/pot.ts 的兩道防線)。
--
--   pnpm db:migrate          （本機）
--   pnpm db:migrate:remote   （線上）
--
-- 重複執行會報 "already exists",代表已經套用過了,可以忽略。

CREATE TABLE IF NOT EXISTS fx_exchanges (
  id             TEXT PRIMARY KEY,
  trip_id        TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  -- 誰換的。錢包是**每人一個**:「我手上還剩多少」問的是我自己的口袋,
  -- 不是全隊的總和。公費不能換匯(公費不需要匯率),由 server 端擋。
  member_id      TEXT NOT NULL REFERENCES members(id),
  -- 換到的
  currency       TEXT NOT NULL REFERENCES currencies(code),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  -- 付出的
  cost_currency  TEXT NOT NULL REFERENCES currencies(code),
  cost_minor     INTEGER NOT NULL CHECK (cost_minor > 0),
  exchanged_at   TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- 同幣別「換匯」沒有意義(匯率恆為 1),而它會讓錢包的兩邊互相抵銷成 0。
  -- server 端也擋,這裡是最後一道。
  CHECK (currency <> cost_currency)
);

-- 錢包的查詢一律是「這趟、這個人、這個幣別」,三個鍵的順序就照那個問法。
CREATE INDEX IF NOT EXISTS idx_fx_exchanges_trip ON fx_exchanges(trip_id, member_id, currency);
