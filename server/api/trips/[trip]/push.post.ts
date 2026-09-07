import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const s = await readBody<{ endpoint: string; keys: { p256dh: string; auth: string } }>(event);
  if (!s?.endpoint || !s?.keys?.p256dh) {
    throw createError({ statusCode: 400, statusMessage: 'endpoint / keys required' });
  }
  await dbh.prepare(
    `INSERT INTO push_subscriptions (id, trip_id, endpoint, p256dh, auth) VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO NOTHING`,
  ).bind(uid(), trip.id, s.endpoint, s.keys.p256dh, s.keys.auth).run();
  setResponseStatus(event, 201);
  return { ok: true };
});
