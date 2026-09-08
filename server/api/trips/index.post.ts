import { db } from '../../utils/cf';
import { uid, shareToken } from '../../utils/trip';
import { ensureSession } from '../../utils/auth';

/**
 * 建立旅程,並把「誰能進來」一起記下來。
 *
 * 登入的人建立 → trip_access 給 owner(可刪除、可看 share_token、換裝置找得回來)。
 * 沒登入的人建立 → 只寫進這個瀏覽器的 session,不會有 owner。
 *   這是刻意允許的:註冊門檻擋在「想開一趟來試試」前面會直接勸退新使用者。
 *   代價是換瀏覽器就找不回來,所以前端要提醒他註冊。
 */

export default defineEventHandler(async (event) => {
  const b = await readBody<{
    name: string; base_currency?: string; members?: string[];
    /** 順便建立公費(common pot)。給名字就建,例如 '公費'。 */
    pot?: string;
  }>(event);
  if (!b?.name) throw createError({ statusCode: 400, statusMessage: 'name required' });

  const dbh = db(event);
  const session = await ensureSession(event, dbh);
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
    // 建立者的權限。登入了就是正式的 owner,沒登入就只綁這個瀏覽器。
    session.userId
      ? dbh.prepare(`INSERT INTO trip_access (trip_id, user_id, role) VALUES (?,?,'owner')`)
          .bind(id, session.userId)
      : dbh.prepare(`INSERT INTO session_trips (session_id, trip_id) VALUES (?,?)`)
          .bind(session.id, id),
  ];
  await dbh.batch(stmts);

  setResponseStatus(event, 201);
  return {
    id,
    share_token: token,
    url: `/t/${token}`,
    role: session.userId ? 'owner' : 'editor',
    /** 沒登入建立的旅程換個瀏覽器就找不回來,前端要據此提醒。 */
    anonymous: !session.userId,
  };
});
