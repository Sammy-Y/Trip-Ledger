import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const b = await readBody<{
    name: string; url?: string; opens_at_utc?: string;
    remind_before_min?: number; note?: string;
  }>(event);
  if (!b?.name) throw createError({ statusCode: 400, statusMessage: 'name required' });

  const id = uid();
  await dbh.prepare(
    `INSERT INTO reservations (id, trip_id, name, url, opens_at_utc, remind_before_min, note)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, trip.id, b.name, b.url ?? null, b.opens_at_utc ?? null, b.remind_before_min ?? 10, b.note ?? null)
   .run();

  setResponseStatus(event, 201);
  return { id };
});
