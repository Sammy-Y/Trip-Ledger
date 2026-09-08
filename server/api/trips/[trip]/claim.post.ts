import { db } from '../../../utils/cf';
import { resolveTripAccess } from '../../../utils/trip';

/**
 * 認領無主旅程。
 *
 * 權限層上線前建立的旅程沒有任何 trip_access 紀錄。它們仍然能用 share_token
 * 進去記帳,但沒有人能刪除、沒有人能跨裝置找回。這支讓登入的使用者
 * 把其中一趟收為己有。
 *
 * ⚠️ 已知取捨:認領的條件是「登入 + 進得去這趟」,而進得去的條件是持有
 * share_token。所以在你認領之前,任何拿到那條連結的人都可以搶先認領。
 * 對這三趟既有的私人旅程可以接受;之後如果要更嚴,就得改成
 * 「migration 時直接綁定 user_id」那條路。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const access = await resolveTripAccess(event, dbh);

  if (!access.session.userId) {
    throw createError({ statusCode: 401, statusMessage: '請先登入,才能認領這趟旅程。' });
  }
  if (!access.orphan) {
    throw createError({
      statusCode: 409,
      statusMessage: access.role === 'owner'
        ? '這趟旅程已經是你的了。'
        : '這趟旅程已經有擁有者了。',
    });
  }

  // 一句話完成「還沒有人擁有 → 我來擁有」。
  //
  // 不能寫成「先查 orphan、再 INSERT」:PRIMARY KEY 是 (trip_id, user_id),
  // 兩個**不同的**使用者同時按認領會雙雙寫入成功,一趟就有兩個 owner。
  // WHERE NOT EXISTS 和 INSERT 在同一個語句裡,SQLite 保證原子性,
  // 慢的那個 changes 會是 0。
  const res = await dbh.prepare(
    `INSERT INTO trip_access (trip_id, user_id, role)
     SELECT ?1, ?2, 'owner'
     WHERE NOT EXISTS (SELECT 1 FROM trip_access WHERE trip_id = ?3)`,
  ).bind(access.trip.id, access.session.userId, access.trip.id).run();

  if (!res.meta.changes) {
    throw createError({ statusCode: 409, statusMessage: '這趟旅程已經有擁有者了。' });
  }

  setResponseStatus(event, 201);
  return { ok: true, trip_id: access.trip.id, role: 'owner' };
});
