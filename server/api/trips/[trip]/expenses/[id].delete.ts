import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/**
 * 刪除支出。
 *
 * WHERE 同時綁 trip_id:拿別的旅程的 expense id 過來會刪不到 → 回 404,
 * 不用先 SELECT 確認歸屬再刪(少一次往返,也不會有中間的競態)。
 * expense_payers / expense_shares 由 ON DELETE CASCADE 清掉。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' });

  const res = await dbh.prepare(`DELETE FROM expenses WHERE id = ? AND trip_id = ?`)
    .bind(id, trip.id).run();

  if (!res.meta?.changes) {
    throw createError({ statusCode: 404, statusMessage: '找不到這筆支出' });
  }
  return { ok: true };
});
