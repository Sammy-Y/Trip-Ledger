-- 結算回合(incremental settlement rounds)。
--
-- 「今晚先把今天的帳結掉,下次從還沒結的地方開始」需要:
--   1. 代表「這一批帳結清了」的實體(一個回合 = 一趟 + 一個幣別) → settlement_rounds
--   2. 結算當下的淨額快照(明細要能回答「這數字怎麼算的」)      → settlement_round_nets
--   3. 支出上「已列入哪個回合」的標記                          → expenses.settlement_round_id
--   4. 轉帳紀錄能分辨「回合產生的」和「使用者手動記的」          → settlements.round_id / source
--
-- 第 4 點讓「撤銷回合」安全:回合產生的轉帳要刪掉,
-- 但手動記的還款(和投入公費)是真的發生過的付款,絕不能刪。
--
--   pnpm db:migrate          （本機）
--   pnpm db:migrate:remote   （線上）
--
-- 重複執行會報 "duplicate column name" / "already exists",代表已經套用過了,可以忽略。

CREATE TABLE IF NOT EXISTS settlement_rounds (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  currency    TEXT NOT NULL REFERENCES currencies(code),
  seq         INTEGER NOT NULL,
  label       TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reverted_at TEXT
);

-- 併發防護:兩支手機同時結算會算出同一個 seq,只有一個寫得進去。
CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_seq ON settlement_rounds(trip_id, currency, seq);

CREATE INDEX IF NOT EXISTS idx_rounds_trip ON settlement_rounds(trip_id, created_at);

CREATE TABLE IF NOT EXISTS settlement_round_nets (
  round_id   TEXT NOT NULL REFERENCES settlement_rounds(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  net_minor  INTEGER NOT NULL,
  PRIMARY KEY (round_id, member_id)
);

ALTER TABLE expenses ADD COLUMN settlement_round_id TEXT REFERENCES settlement_rounds(id);

ALTER TABLE settlements ADD COLUMN round_id TEXT REFERENCES settlement_rounds(id);

-- ⚠️ schema.sql 的 source 有 CHECK (source IN ('manual','round')),這裡沒有 ——
-- SQLite 的 ALTER TABLE 不支援加 CHECK 約束(要加只能整表重建)。
-- 所以「全新建的資料庫」比「migrate 過來的」多一層防護。
-- 兩邊都靠 server 端驗證守住(只有結算回合會寫 'round'),差異僅在最後一道防線。
ALTER TABLE settlements ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_expenses_unsettled ON expenses(trip_id, kind, settlement_round_id);

CREATE INDEX IF NOT EXISTS idx_settlements_round ON settlements(round_id);
