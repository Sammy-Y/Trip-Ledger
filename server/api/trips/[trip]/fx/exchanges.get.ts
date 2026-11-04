import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/**
 * 逐筆列出這趟的換匯紀錄,新的排前面。
 *
 * ── 為什麼要逐筆,而不是沿用 balance 已經有的錢包合計 ──────────
 *
 * `wallets[].exchangedInMinor` 是加總:「MIN 換了 ¥15,000」在那裡是一個數字,
 * 但它是 0.21 換 5,000 加上 0.205 換 10,000 兩筆。使用者要改的是**打錯的那一筆**,
 * 而對合計說「改成 ¥12,000」沒有唯一解(要改哪一筆?各分掉多少?)。
 *
 * 所以編輯的單位是**列**,而列要能被指定就得先被列出來 ——
 * 帶 exchanged_at 是因為「哪一筆」對使用者來說就是「哪一天換的那筆」。
 *
 * ── 沒有 rate 欄位 ──────────────────────────────────────────────
 *
 * 每一列的有效匯率由前端用 shared/money.ts 的 exchangeRate() 算
 * (定義只有一份,理由見 schema.sql 的 fx_exchanges)。在這裡多算一個 rate
 * 回去,等於給前端第二個來源可以選,而兩個來源遲早會不一致。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  // ORDER BY 的第二個鍵是 rowid,不是 id:exchanged_at 只到**日**,
  // 而「同一天分兩次換」正是這個功能存在的理由 —— 同一天的順序如果不定,
  // 清單每次重整都會跳。id 是隨機 UUID,排出來和時間無關;
  // rowid 是寫入順序,正好就是「後記的排前面」要的那個次序(同 pot/moves.get.ts)。
  const rows = await dbh.prepare(
    `SELECT id, member_id, currency, amount_minor, cost_currency, cost_minor,
            exchanged_at, note, created_at
     FROM fx_exchanges
     WHERE trip_id = ?
     ORDER BY exchanged_at DESC, rowid DESC`,
  ).bind(trip.id).all<{
    id: string; member_id: string;
    currency: string; amount_minor: number;
    cost_currency: string; cost_minor: number;
    exchanged_at: string; note: string | null; created_at: string;
  }>();

  return { exchanges: rows.results ?? [] };
});
