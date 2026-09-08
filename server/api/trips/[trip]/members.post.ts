import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const body = await readBody<{ name?: string; is_pot?: boolean | number }>(event);
  const name = body?.name?.trim();
  if (!name) throw createError({ statusCode: 400, statusMessage: '請填成員名字' });

  const isPot = body?.is_pot ? 1 : 0;

  // 一趟只能有一個公費。資料庫的 partial unique index 也會擋,
  // 但那會拋出看不懂的 UNIQUE constraint 訊息 —— 這裡先給人話。
  if (isPot) {
    const existing = await dbh.prepare(
      `SELECT name FROM members WHERE trip_id = ? AND is_pot = 1`,
    ).bind(trip.id).first<{ name: string }>();
    if (existing) {
      throw createError({ statusCode: 400, statusMessage: `這趟已經有公費了(${existing.name})` });
    }
  }

  const duplicate = await dbh.prepare(
    `SELECT id FROM members WHERE trip_id = ? AND name = ?`,
  ).bind(trip.id, name).first<{ id: string }>();
  if (duplicate) throw createError({ statusCode: 400, statusMessage: `已經有一個叫「${name}」的成員了` });

  const id = uid();
  await dbh.prepare(`INSERT INTO members (id, trip_id, name, is_pot) VALUES (?,?,?,?)`)
    .bind(id, trip.id, name, isPot).run();
  setResponseStatus(event, 201);
  return { id, name, is_pot: isPot };
});
