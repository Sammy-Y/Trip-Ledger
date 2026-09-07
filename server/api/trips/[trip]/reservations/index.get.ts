import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';
import type { Reservation } from '../../../../../shared/types';

/**
 * 預約清單(全部,不只到期的 —— 到期推播用的是同目錄的 due.get.ts)。
 *
 * `opens_at_utc IS NULL` 當第一個排序鍵:SQLite 把布林算成 0/1,
 * 所以還沒定時間的預約會排在有時間的後面,而不是被 NULL 擠到最前面。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const rows = await dbh.prepare(
    `SELECT id, name, url, opens_at_utc, remind_before_min, reminded_at, status, note
     FROM reservations
     WHERE trip_id = ?
     ORDER BY opens_at_utc IS NULL, opens_at_utc ASC, name`,
  ).bind(trip.id).all<Reservation>();

  return rows.results ?? [];
});
