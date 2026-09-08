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
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' });

  const stamped = await dbh.prepare(
    `SELECT r.seq, r.currency FROM expenses e
     JOIN settlement_rounds r ON r.id = e.settlement_round_id
     WHERE e.id = ? AND e.trip_id = ? AND r.reverted_at IS NULL`,
  ).bind(id, trip.id).first<{ seq: number; currency: string }>();
  if (stamped) {
    throw createError({
      statusCode: 409,
      statusMessage: `這筆已經列入「${stamped.currency} 第 ${stamped.seq} 次結算」,不能刪除。`
        + '要刪的話請先到結算頁撤銷那次結算。',
    });
  }

  const res = await dbh.prepare(`DELETE FROM expenses WHERE id = ? AND trip_id = ?`)
    .bind(id, trip.id).run();

  if (!res.meta?.changes) {
    throw createError({ statusCode: 404, statusMessage: '找不到這筆支出' });
  }
  return { ok: true };
});
