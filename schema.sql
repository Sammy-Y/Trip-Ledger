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
CREATE TABLE IF NOT EXISTS members (
  id       TEXT PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  UNIQUE (trip_id, name)
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
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id, kind, spent_at);

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
CREATE TABLE IF NOT EXISTS settlements (
  id            TEXT PRIMARY KEY,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_member   TEXT NOT NULL REFERENCES members(id),
  to_member     TEXT NOT NULL REFERENCES members(id),
  currency      TEXT NOT NULL REFERENCES currencies(code),
  amount_minor  INTEGER NOT NULL,
  settled_at    TEXT NOT NULL DEFAULT (datetime('now')),
  note          TEXT
);

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
CREATE TABLE IF NOT EXISTS reservations (
  id                TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  url               TEXT,
  -- 開放預約的時刻,存 UTC ISO8601。日本 12:00 JST = 03:00 UTC。
  opens_at_utc      TEXT,
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
