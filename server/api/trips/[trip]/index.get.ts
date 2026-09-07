import { db } from '../../../utils/cf';
import { requireTrip } from '../../../utils/trip';

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const members = await dbh.prepare(`SELECT id, name FROM members WHERE trip_id = ? ORDER BY name`)
    .bind(trip.id).all<{ id: string; name: string }>();
  return { trip, members: members.results ?? [] };
});
