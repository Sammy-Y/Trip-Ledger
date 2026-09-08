import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/**
 * 刪除支出。
 *
 * WHERE 同時綁 trip_id:拿別的旅程的 expense id 過來會刪不到 → 回 404,
 * 不用先 SELECT 確認歸屬再刪(少一次往返,也不會有中間的競態)。
 * expense_payers / expense_shares 由 ON DELETE CASCADE 清掉。
 *
 * **已經列入結算回合的支出不給刪。** 那筆帳已經被算進當時的轉帳、
 * 而且錢已經照那個數字付出去了;直接刪掉會讓那次結算的明細指向一筆不存在的支出,
 * 事後沒辦法回答「這 1,850 是怎麼來的」。要刪就先撤銷那次結算。
 *
 * 而「不給刪」是寫在 DELETE 的 WHERE 裡,不是只靠先問一次 ——
 * 先讀再寫的話,兩者之間的空窗(Workers 打遠端 D1 是幾十到幾百毫秒)裡
 * 另一支手機按下結算,這筆就會在蓋章之後才被刪掉。理由與寫法同
 * expenses/[id].patch.ts 的樂觀鎖。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' });

  // 事前檢查與刪不到時的診斷共用同一句 —— 兩邊的判準必須一模一樣。
  const readStamped = () => dbh.prepare(
    `SELECT r.seq, r.currency FROM expenses e
     JOIN settlement_rounds r ON r.id = e.settlement_round_id
     WHERE e.id = ? AND e.trip_id = ? AND r.reverted_at IS NULL`,
  ).bind(id, trip.id).first<{ seq: number; currency: string }>();

  const stampedError = (s: { seq: number; currency: string }) => createError({
    statusCode: 409,
    statusMessage: `這筆已經列入「${s.currency} 第 ${s.seq} 次結算」,不能刪除。`
      + '要刪的話請先到結算頁撤銷那次結算。',
  });

  const stamped = await readStamped();
  if (stamped) throw stampedError(stamped);

  const res = await dbh.prepare(
    `DELETE FROM expenses WHERE id = ? AND trip_id = ? AND settlement_round_id IS NULL`,
  ).bind(id, trip.id).run();

  if (!res.meta?.changes) {
    // 刪不到有兩種可能:本來就不存在(404),或是在這個空窗裡被蓋章了(409)。
    // 一律回 404 會讓使用者以為那筆消失了,而它其實還在畫面上。
    const now = await readStamped();
    if (now) throw stampedError(now);
    throw createError({ statusCode: 404, statusMessage: '找不到這筆支出' });
  }
  return { ok: true };
});
