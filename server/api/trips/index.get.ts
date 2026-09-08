import { db } from '../../utils/cf';
import { readSession } from '../../utils/auth';

/**
 * 「我的旅程」列表。
 *
 * ⚠️ 這支以前是 `SELECT ... FROM trips`(沒有 WHERE),
 * 也就是把資料庫裡**所有人**的旅程連同 share_token 一起回傳。
 * 自己和朋友用的時候那是功能,對外開放就是把所有人的鑰匙掛在門口。
 *
 * 現在的規則:
 *   - 已登入 → trip_access 有紀錄的旅程(帶 role)
 *   - 訪客   → 這個 session 用 share_token 解鎖過的旅程(role = editor)
 *   - 沒有 session → 空陣列(不是錯誤,新使用者本來就沒有旅程)
 *
 * share_token 只有 owner 拿得到 —— 它等於這趟的鑰匙,editor 不該能再散播出去。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const session = await readSession(event, dbh);
  if (!session) return [];

  // 兩種來源 UNION 起來。同一趟可能兩邊都有(登入者又剛好用 token 進來過),
  // role 取 owner 優先 —— MAX() 在這裡剛好可用,因為 'owner' > 'editor' 字典序。
  const rows = await dbh.prepare(
    `SELECT t.id, t.name, t.base_currency, t.start_date, t.end_date, t.created_at,
            MAX(a.role) AS role,
            CASE WHEN MAX(a.role) = 'owner' THEN t.share_token ELSE NULL END AS share_token,
            (SELECT COUNT(*) FROM members m  WHERE m.trip_id = t.id AND m.is_pot = 0) AS member_count,
            (SELECT COUNT(*) FROM expenses e WHERE e.trip_id = t.id) AS expense_count,
            (SELECT MAX(e.spent_at) FROM expenses e WHERE e.trip_id = t.id) AS last_spent_at,
            (SELECT COUNT(*) FROM trip_access x WHERE x.trip_id = t.id) AS owner_count
     FROM trips t
     JOIN (
       SELECT trip_id, role FROM trip_access WHERE user_id = ?1
       UNION ALL
       SELECT trip_id, 'editor' AS role FROM session_trips WHERE session_id = ?2
     ) a ON a.trip_id = t.id
     GROUP BY t.id
     ORDER BY COALESCE(t.start_date, t.created_at) DESC`,
  ).bind(session.userId, session.id).all<{
    id: string; role: string; owner_count: number;
  }>();

  // owner_count 只是拿來算 orphan 的中間值,不要洩到 API 回應裡。
  return (rows.results ?? []).map(({ owner_count, ...r }) => ({
    ...r,
    orphan: (owner_count ?? 0) === 0,
  }));
});
