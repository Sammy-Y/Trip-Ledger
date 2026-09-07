import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/** Service Worker 收到空推播後回打這支取要顯示的內容(見 server/utils/push.ts)。 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const rows = await dbh.prepare(
    `SELECT name, url, opens_at_utc, note FROM reservations
     WHERE trip_id = ? AND status = 'pending' AND opens_at_utc IS NOT NULL
       AND datetime(opens_at_utc) >= datetime('now', '-15 minutes')
     ORDER BY opens_at_utc LIMIT 5`,
  ).bind(trip.id).all();
  return rows.results ?? [];
});
