import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const { name } = await readBody<{ name: string }>(event);
  if (!name) throw createError({ statusCode: 400, statusMessage: 'name required' });

  const id = uid();
  await dbh.prepare(`INSERT INTO members (id, trip_id, name) VALUES (?,?,?)`)
    .bind(id, trip.id, name).run();
  setResponseStatus(event, 201);
  return { id, name };
});
