import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/**
 * 逐筆列出這趟的公費金流(投入 / 退還),新的排前面。
 *
 * ── 為什麼要逐筆,而不是沿用總覽已經有的每人合計 ─────────────
 *
 * balance 的 `pot.by_currency[].contributions` 是 GROUP BY 成員之後的**合計**:
 * 「MIN 投了 10,000」在那裡是一個數字,但它可能是第一天 5,000、第二天再 5,000
 * 兩筆。使用者要改的是**打錯的那一筆**,而對合計說「改成 8,000」沒有唯一解 ——
 * 要改哪一筆?兩筆各分掉多少?(平均分回去會把兩筆都改成 4,000,
 * 於是為了修一個打錯的數字,把另一筆本來是對的紀錄一起改掉。)
 *
 * 所以編輯的單位是**列**。而列要能被指定,就得先被列出來 ——
 * 帶上 settled_at 是因為「哪一筆」對使用者來說就是「哪一天記的那筆」,
 * 兩筆同額同人的紀錄只有時間分得出來。
 *
 * ── direction 是算出來的,不是存的 ──────────────────────────
 *
 * 資料上公費金流就是一列 settlement,方向寫在「哪一端是公費」。
 * 但前端不該為了看懂這份清單而先去查公費的 member id,更不該自己
 * 拿 from/to 去比對 —— 那個比對每多一個畫面就要重寫一次,寫錯的那次
 * 會把「投入」顯示成「退還」。所以在這裡就翻譯成 direction + member_id(對方是誰)。
 *
 * ── 不濾 source ─────────────────────────────────────────────
 *
 * 修改 / 刪除只碰 `source = 'manual'`(理由見 utils/pot.ts),但**列表要列全部**。
 * 這兩件事該不一致:剩餘的算法也不分 source(balance.get.ts 的 potSummary),
 * 所以任何一列碰到公費的 settlement 都在影響剩餘。把它藏起來的話,
 * 使用者會看到一個「清單加起來對不上剩餘」而且完全查不出原因的畫面;
 * 列出來至少那筆錢是看得見的,只是動不了它(→ 404)。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  // 沒有公費的旅程:JOIN 撈不到任何列 → 空陣列。這是對的,不是錯誤 ——
  // 前端拿到空清單就顯示「還沒有任何公費金流」。
  //
  // ORDER BY 的第二個鍵是 rowid,不是 id:settled_at 只到**秒**
  // (schema 的 datetime('now')),而「大家一起投入公費」是一次寫進好幾列的動作,
  // 同一秒內的順序如果不定,清單每次重整都會跳。id 是隨機 UUID,排出來的順序
  // 和時間無關;rowid 是寫入順序,正好就是「後記的排前面」要的那個次序。
  const rows = await dbh.prepare(
    `SELECT s.id,
            CASE WHEN s.to_member = m.id THEN 'in' ELSE 'out' END AS direction,
            CASE WHEN s.to_member = m.id THEN s.from_member ELSE s.to_member END AS member_id,
            s.currency, s.amount_minor, s.settled_at, s.note
     FROM settlements s
     JOIN members m ON m.trip_id = s.trip_id AND m.is_pot = 1
     WHERE s.trip_id = ? AND (s.from_member = m.id OR s.to_member = m.id)
     ORDER BY s.settled_at DESC, s.rowid DESC`,
  ).bind(trip.id).all<{
    id: string; direction: 'in' | 'out'; member_id: string;
    currency: string; amount_minor: number; settled_at: string; note: string | null;
  }>();

  return { moves: rows.results ?? [] };
});
