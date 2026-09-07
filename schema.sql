-- trip-ledger schema (Cloudflare D1 / SQLite)
--
-- 三個設計決定,對應你 Excel 的三個結構性問題:
--  1. expense_payers 與 expense_shares 分成兩張表 → 「誰墊錢」和「誰該分攤」解耦。
--     解決 Excel 痛點:付款人欄常空白、拆分細節只能寫在備註自由文字。
--  2. 金額一律用整數最小單位(amount_minor)存 → 不用浮點數,不會有累積誤差。
--  3. 每筆支出寫入時就把當下匯率 snapshot 到 expenses.fx_rate → 補登用的是當時匯率,
--     不是查詢當下的匯率。且結算永遠「分幣別」進行,絕不跨幣別相加。

PRAGMA foreign_keys = ON;

-- 幣別的小數位數。JPY 沒有輔幣單位(exponent 0),TWD 用分(exponent 2)。
CREATE TABLE IF NOT EXISTS currencies (
  code      TEXT PRIMARY KEY,
  exponent  INTEGER NOT NULL,
  label     TEXT NOT NULL
);
INSERT OR IGNORE INTO currencies (code, exponent, label) VALUES
  ('TWD', 2, '台幣'),
  ('JPY', 0, '日幣');

CREATE TABLE IF NOT EXISTS trips (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  base_currency  TEXT NOT NULL DEFAULT 'TWD' REFERENCES currencies(code),
  start_date     TEXT,
  end_date       TEXT,
  -- 免註冊協作的關鍵:朋友憑這個不可猜的 token 進來記帳,不需要下載 App、不需要帳號。
  share_token    TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 成員不需要帳號,只是一個名字。人數不固定(不再有 Excel 裡硬編碼的 /2)。
--
-- is_pot = 1 是「公費」:大家先各拿一筆錢出來,吃飯門票直接從公費付。
-- 它不是人,但它是一個「持有現金的實體」—— 會付錢、會被人投入、最後要退還,
-- 這些行為和成員完全一樣,所以用同一張表表達,不需要額外的資料表。
-- 差別只在語意:公費永遠不該是「受益人」(不進 expense_shares),
-- 所以 UI 要把它從分攤名單裡排除。這個旗標就是讓 UI 認得出它。
CREATE TABLE IF NOT EXISTS members (
  id       TEXT PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  is_pot   INTEGER NOT NULL DEFAULT 0 CHECK (is_pot IN (0,1)),
  UNIQUE (trip_id, name)
);
-- 一趟旅程最多一個公費 —— 兩個公費的話「剩餘多少」就沒有唯一答案。
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_one_pot ON members(trip_id) WHERE is_pot = 1;

-- 一次「結算回合」。
--
-- 為什麼需要:旅途中不是只在最後結算一次。「今晚先把今天的帳結掉」是常態,
-- 而結完之後下一次必須**從還沒結的地方開始**,不能把已經付清的帳再算一遍。
-- 所以要有一個東西代表「這一批帳已經結清了」,並且把當時的明細留下來 ——
-- 事後有人問「這 1,850 是怎麼來的」,要拿得出當時算的那幾筆。
--
-- 定義在 expenses / settlements 之前,因為那兩張表都會參照它。
--
-- **一個回合只處理一個幣別。** 結算永遠分幣別進行,一個按鈕同時結掉日幣和台幣
-- 會寫下「其實沒有發生過」的台幣轉帳(當晚只有日幣現金在桌上動)。
--
-- seq = 同一趟、同一幣別的第幾次結算。UNIQUE(trip_id, currency, seq) 是
-- 併發防護:兩支手機同時按下結算會算出同一個 seq,資料庫只會讓一個成功,
-- 另一個拿到 UNIQUE 衝突 → 不會出現兩個回合各寫一份轉帳、金額變兩倍。
CREATE TABLE IF NOT EXISTS settlement_rounds (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  currency    TEXT NOT NULL REFERENCES currencies(code),
  seq         INTEGER NOT NULL,
  label       TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- 撤銷是軟性的:列留著、標記時間,這樣「這個回合被撤銷過」在帳上看得到。
  reverted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_seq ON settlement_rounds(trip_id, currency, seq);
CREATE INDEX IF NOT EXISTS idx_rounds_trip ON settlement_rounds(trip_id, created_at);

-- 結算當下每個人的淨額快照(含公費)。
--
-- 為什麼要存:回合的明細要能回答「這 1,850 是怎麼算出來的」。
-- 之後有人補登支出、改成員名字、或刪掉一筆帳,重算會得到不同的數字,
-- 但**當時**照這份淨額付了錢。存下來才有可稽核的軌跡。
CREATE TABLE IF NOT EXISTS settlement_round_nets (
  round_id   TEXT NOT NULL REFERENCES settlement_rounds(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  net_minor  INTEGER NOT NULL,
  PRIMARY KEY (round_id, member_id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id              TEXT PRIMARY KEY,
  trip_id         TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  -- 雙軌帳本:shared 進結算,personal 只進該成員自己的統計。
  kind            TEXT NOT NULL CHECK (kind IN ('shared','personal')),
  description     TEXT NOT NULL,
  category        TEXT,
  currency        TEXT NOT NULL REFERENCES currencies(code),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor <> 0),
  -- 現金與刷卡的成本匯率不同,分開標記才能估得準一點。
  payment_method  TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','card')),
  -- 寫入當下 snapshot 的中價(1 單位 currency = ? base_currency)。TWD 本身為 1。
  fx_rate         REAL,
  fx_rate_date    TEXT,
  fx_rate_source  TEXT,
  -- 使用者手動覆寫的匯率(例如照信用卡帳單實際入帳回填)。有值時優先於 fx_rate。
  fx_rate_override REAL,
  -- 套用在中價之上的估算加成(%)。現金價差或海外刷卡手續費。
  fx_markup_pct   REAL NOT NULL DEFAULT 0,
  spent_at        TEXT NOT NULL,
  -- 這筆已經在哪一個結算回合被結清了。NULL = 還沒結算,下次結算會納入。
  -- 「下次從尚未標記的地方開始」就是靠這個欄位。
  settlement_round_id TEXT REFERENCES settlement_rounds(id),
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id, kind, spent_at);
-- 「還沒結算的共同花費有哪些」是結算頁每次都要問的問題
CREATE INDEX IF NOT EXISTS idx_expenses_unsettled ON expenses(trip_id, kind, settlement_round_id);

-- 誰實際付了錢。允許一筆支出由多人共同墊款。
CREATE TABLE IF NOT EXISTS expense_payers (
  expense_id    TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount_minor  INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

-- 誰受益 / 誰該分攤。只列出實際參與的人 → 天然支援「只有部分成員參與的支出」。
-- 三種分攤模式(均分 / 比例 / 指定金額)都在寫入時算成 amount_minor 存下來,
-- 這樣結算讀取時不必重算,也留下可稽核的軌跡。
CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id    TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  amount_minor  INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

-- 已經還過的錢。結算時要扣掉,否則還完款餘額不會歸零。
--
-- source 分兩種,revert 一個回合時行為不同:
--   'round'  結算回合產生的轉帳 → 回合被撤銷時要一起刪掉
--   'manual' 使用者自己按「標記已還款」或投入公費 → 那是真的發生過的付款,
--            回合被撤銷時只把 round_id 解除,絕不能刪
CREATE TABLE IF NOT EXISTS settlements (
  id            TEXT PRIMARY KEY,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_member   TEXT NOT NULL REFERENCES members(id),
  to_member     TEXT NOT NULL REFERENCES members(id),
  currency      TEXT NOT NULL REFERENCES currencies(code),
  amount_minor  INTEGER NOT NULL,
  settled_at    TEXT NOT NULL DEFAULT (datetime('now')),
  round_id      TEXT REFERENCES settlement_rounds(id),
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','round')),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_settlements_round ON settlements(round_id);

-- 每日匯率快照(cron 寫入)。有了這張表,補登昨天的支出就能取到昨天的匯率。
CREATE TABLE IF NOT EXISTS fx_rates (
  rate_date  TEXT NOT NULL,
  base       TEXT NOT NULL,
  currency   TEXT NOT NULL,
  rate       REAL NOT NULL,      -- 1 unit of `currency` = `rate` units of `base`
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rate_date, base, currency)
);

-- 對應你 Excel 的「預訂」工作表:記錄開放預約的時間點並在之前提醒。
--
-- ⚠️ 這裡有**兩個不同的時間**,是這張表最容易搞混的地方:
--
--   opens_at_utc    「什麼時候可以開始搶」  2026-10-01 12:00 JST
--   booked_for_utc  「訂到的是哪一餐」      2027-01-01 18:30 JST
--
-- 日本熱門餐廳的規則是「每月 1 號 12:00 開放下兩個月的座位」,
-- 所以這兩個時間差好幾個月,而提醒要看的是前者、行程要看的是後者。
-- 原本只有 opens_at_utc,結果「我訂到哪一天」根本記不下來
-- (原 Excel 的「預約時段」欄就是 booked_for_utc,匯入時無處可放)。
CREATE TABLE IF NOT EXISTS reservations (
  id                TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  url               TEXT,
  -- 開放預約的時刻,存 UTC ISO8601。日本 12:00 JST = 03:00 UTC。
  opens_at_utc      TEXT,
  -- 實際訂到的用餐時刻(UTC)。訂到之後才會有值,而且可以改
  -- (「1/1 沒位子,改訂 1/3」是常態,不該只能刪掉重建)。
  booked_for_utc    TEXT,
  -- 訂位用的名字。日本餐廳現場是喊名字的,記錯就進不去。
  booking_name      TEXT,
  -- 訂位人數。改人數常常要重訂,所以要記。
  party_size        INTEGER,
  remind_before_min INTEGER NOT NULL DEFAULT 10,
  reminded_at       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','booked','cancelled')),
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_res_due ON reservations(status, opens_at_utc, reminded_at);

-- Web Push 訂閱(每個裝置一筆)。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
