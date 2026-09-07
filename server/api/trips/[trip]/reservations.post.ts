import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const b = await readBody<{
    name: string; url?: string;
    opens_at_utc?: string; booked_for_utc?: string;
    booking_name?: string; party_size?: number;
    remind_before_min?: number; note?: string; status?: string;
  }>(event);
  if (!b?.name) throw createError({ statusCode: 400, statusMessage: '請填店名 / 項目' });

  const status = b.status ?? (b.booked_for_utc ? 'booked' : 'pending');
  if (!['pending', 'booked', 'cancelled'].includes(status)) {
    throw createError({ statusCode: 400, statusMessage: 'status 只能是 pending / booked / cancelled' });
  }

  const partySize = b.party_size == null ? null : Number(b.party_size);
  if (partySize != null && (!Number.isInteger(partySize) || partySize < 1)) {
    throw createError({ statusCode: 400, statusMessage: '人數必須是大於 0 的整數' });
  }

  const id = uid();
  await dbh.prepare(
    `INSERT INTO reservations
       (id, trip_id, name, url, opens_at_utc, booked_for_utc, booking_name, party_size,
        remind_before_min, status, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, trip.id, b.name, b.url ?? null,
    b.opens_at_utc ?? null, b.booked_for_utc ?? null,
    b.booking_name ?? null, partySize,
    b.remind_before_min ?? 10, status, b.note ?? null,
  ).run();

  setResponseStatus(event, 201);
  return { id, status };
});
