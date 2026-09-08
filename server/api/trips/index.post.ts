import { db } from '../../utils/cf';
import { uid, shareToken } from '../../utils/trip';

export default defineEventHandler(async (event) => {
  const b = await readBody<{
    name: string; base_currency?: string; members?: string[];
    /** 順便建立公費(common pot)。給名字就建,例如 '公費'。 */
    pot?: string;
  }>(event);
  if (!b?.name) throw createError({ statusCode: 400, statusMessage: 'name required' });

  const dbh = db(event);
  const id = uid();
  const token = shareToken();
  const potName = b.pot?.trim();

  const stmts = [
    dbh.prepare(`INSERT INTO trips (id, name, base_currency, share_token) VALUES (?,?,?,?)`)
      .bind(id, b.name, b.base_currency ?? 'TWD', token),
    ...(b.members ?? []).map((name) =>
      dbh.prepare(`INSERT INTO members (id, trip_id, name, is_pot) VALUES (?,?,?,0)`).bind(uid(), id, name)),
    ...(potName
      ? [dbh.prepare(`INSERT INTO members (id, trip_id, name, is_pot) VALUES (?,?,?,1)`)
          .bind(uid(), id, potName)]
      : []),
  ];
  await dbh.batch(stmts);

  setResponseStatus(event, 201);
  return { id, share_token: token, url: `/t/${token}` };
});
