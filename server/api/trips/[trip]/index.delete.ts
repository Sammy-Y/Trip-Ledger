import { db } from '../../../utils/cf';
import { requireTrip } from '../../../utils/trip';

/** 刪除整趟旅程。members / expenses / reservations 都有 ON DELETE CASCADE。 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  await dbh.prepare(`DELETE FROM trips WHERE id = ?`).bind(trip.id).run();
  return { ok: true, deleted: trip.id };
});
