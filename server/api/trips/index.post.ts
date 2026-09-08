import { db } from '../../utils/cf';
import { uid, shareToken } from '../../utils/trip';
import { readSession } from '../../utils/auth';

/**
 * 建立旅程。**要登入。**
 *
 * ── 為什麼建立要登入,但記帳不用 ──────────────────────────────
 *
 * 這兩件事的風險完全不一樣:
 *
 *   建立旅程  這個人是 owner —— 只有他能刪掉整趟(支出全部 CASCADE)、
 *             只有他拿得到 share_token。沒有帳號的話這些權力綁在一個
 *             瀏覽器 cookie 上,清一次資料就永久失去自己的行程,
 *             而那筆資料也永遠不會有人能刪 —— 變成一趟沒人管的無主旅程。
 *   記帳      旅伴憑 share_token 進來,不必註冊。持有連結本身就是憑證,
 *             而且「丟連結到 LINE 群組就能一起記」是這個產品降低協作
 *             門檻的核心設計(見 utils/trip.ts 的 resolveTripAccess)。
 *
 * 之前這裡允許匿名建立,理由是「註冊門檻擋在想試試的人前面會勸退他」。
 * 實際跑起來的結果是線上一開站就累積出無主旅程:沒有 owner、誰都刪不掉、
 * 建立者換個分頁就再也找不到。門檻的位置放錯了 —— 該擋的是「開一趟新的」,
 * 不是「加入別人的」。
 *
 * 既有的無主旅程仍然進得去(share_token 照舊有效),而且登入之後可以認領
 * (POST /trips/:trip/claim)。這一支只負責不再產生新的。
 */

export default defineEventHandler(async (event) => {
  const b = await readBody<{
    name: string; base_currency?: string; members?: string[];
    /** 順便建立公費(common pot)。給名字就建,例如 '公費'。 */
    pot?: string;
  }>(event);
  if (!b?.name) throw createError({ statusCode: 400, statusMessage: 'name required' });

  const dbh = db(event);

  // 刻意用 readSession 而不是 ensureSession:沒登入就不該為他開一個 session。
  // 開了也沒用(這一支是他唯一會用到 session_trips 的入口),只是留一列垃圾。
  const session = await readSession(event, dbh);
  if (!session?.userId) {
    throw createError({
      statusCode: 401,
      statusMessage: '要先登入才能建立旅程 —— 旅程需要一個擁有者,'
        + '否則換個瀏覽器就再也找不回來,也沒有人能刪除它。'
        + '(被邀請的旅伴不用註冊:拿到分享連結就能一起記帳。)',
    });
  }

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
    // 建立者就是 owner。上面已經擋掉沒登入的情況,所以這裡不再有分支。
    dbh.prepare(`INSERT INTO trip_access (trip_id, user_id, role) VALUES (?,?,'owner')`)
      .bind(id, session.userId),
  ];
  await dbh.batch(stmts);

  setResponseStatus(event, 201);
  return { id, share_token: token, url: `/t/${token}`, role: 'owner' };
});
