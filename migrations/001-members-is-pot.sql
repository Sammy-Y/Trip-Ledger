-- 為既有資料庫加上「公費」旗標。
--
-- schema.sql 用的是 CREATE TABLE IF NOT EXISTS,對「已經存在的表」不會補欄位,
-- 所以既有的本機 / 線上資料庫要另外跑這一支。
--
--   pnpm db:migrate          （本機）
--   pnpm db:migrate:remote   （線上）
--
-- 重複執行會報 "duplicate column name: is_pot",那代表已經套用過了,可以忽略。

ALTER TABLE members ADD COLUMN is_pot INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_one_pot ON members(trip_id) WHERE is_pot = 1;
