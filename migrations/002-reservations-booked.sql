-- 預約:把「訂到的是哪一餐」和「什麼時候開放搶」分開。
--
-- 原本只有 opens_at_utc(開放預約的時刻),所以「我訂到 1/1 晚上 6:30」
-- 這件事根本沒有欄位可以放 —— 匯入原始 Excel 的「預約時段」欄時就卡在這裡。
--
--   pnpm db:migrate          （本機）
--   pnpm db:migrate:remote   （線上）
--
-- 重複執行會報 "duplicate column name",那代表已經套用過了,可以忽略。

ALTER TABLE reservations ADD COLUMN booked_for_utc TEXT;
ALTER TABLE reservations ADD COLUMN booking_name TEXT;
ALTER TABLE reservations ADD COLUMN party_size INTEGER;
