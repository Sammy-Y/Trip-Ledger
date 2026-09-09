import { db } from '../../../../../utils/cf';
import { requireTrip } from '../../../../../utils/trip';
import { exchangeNotFound } from '../../../../../utils/exchange';

/**
 * 刪掉一筆換匯紀錄。
 *
 * ── 為什麼刪除在這裡是安全的 ────────────────────────────────────
 *
 * 這張表不影響任何結算 —— 不進淨額、不進轉帳、不進結算回合、不碰公費。
 * 所以刪一筆換匯只會讓錢包的「換到多少」少那麼多,不會有任何人因此
 * 被要求付錢或收錢。
 *
 * 對照 utils/pot.ts:刪一筆**投入公費**要兩道防線,因為公費剩餘變負會讓
 * 結算據此寫出一筆憑空生出來的真實轉帳(那裡有實測數字)。
 * 這裡連前置讀取都不需要 —— 沒有任何前提要檢查,前提就只有「這一列是這趟的」,
 * 而那一句直接寫在 WHERE 裡。
 *
 * ── 為什麼是硬刪,不是軟刪 ──────────────────────────────────────
 *
 * settlement_rounds 的撤銷是軟性的(留列、標時間),因為「這個回合被撤銷過」
 * 本身是帳上要看得到的事實 —— 那晚真的有人照那份淨額付了錢。
 * 換匯紀錄相反:它記的是「我去銀行換了錢」,記錯了就是**沒發生過**,
 * 留一列已刪除的紀錄只會讓清單多一筆看得到卻碰不到的東西
 * (同 pot/moves/[id].delete.ts 對「刪除 vs 改成 0」的判斷)。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' });

  // trip_id 是唯一的前提,而它寫在 WHERE 裡 —— 所以「別趟的 id」刪不到,
  // 而且不必先讀一次來比對(先讀再比的版本多一個「忘記比」的機會)。
  const res = await dbh.prepare(
    `DELETE FROM fx_exchanges WHERE id = ?1 AND trip_id = ?2`,
  ).bind(id, trip.id).run();

  // 刪不到的三種情況(id 不存在 / 屬於別趟 / 已經被別人刪掉)對使用者來說
  // 是同一件事:那筆不在了。一律同一句 404,不透露那個 id 存不存在。
  if (!res.meta?.changes) throw exchangeNotFound();

  return { ok: true, deleted: id };
});
