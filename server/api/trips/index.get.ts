import { db } from '../../utils/cf';

/**
 * 列出所有旅程 —— 這是 App 的首頁,概念上等於「打開旅遊資料夾看到多個 Excel」。
 *
 * 刻意不做權限:這是自己和朋友用的工具,沒有多使用者的概念。
 * 一併帶出每趟的成員數與支出筆數,列表才有東西可看、不用前端再打 N 次 API。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const rows = await dbh.prepare(
    `SELECT t.id, t.name, t.base_currency, t.start_date, t.end_date,
            t.share_token, t.created_at,
            (SELECT COUNT(*) FROM members m  WHERE m.trip_id = t.id) AS member_count,
            (SELECT COUNT(*) FROM expenses e WHERE e.trip_id = t.id) AS expense_count,
            (SELECT MAX(e.spent_at) FROM expenses e WHERE e.trip_id = t.id) AS last_spent_at
     FROM trips t
     ORDER BY COALESCE(t.start_date, t.created_at) DESC`,
  ).all();
  return rows.results ?? [];
});
