import { db } from '../../../utils/cf';
import { requireOwner } from '../../../utils/trip';

/**
 * 刪除整趟旅程。members / expenses / reservations 都有 ON DELETE CASCADE。
 *
 * ⚠️ 這支以前只要拿得到連結就能刪。支出全部 CASCADE 掉、無法復原,
 * 是這個 API 裡破壞力最大的操作,所以限 owner。
 * 無主旅程(權限層上線前建的)沒有 owner —— 要先認領才能刪。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const { trip } = await requireOwner(event, dbh);
  await dbh.prepare(`DELETE FROM trips WHERE id = ?`).bind(trip.id).run();
  return { ok: true, deleted: trip.id };
});
