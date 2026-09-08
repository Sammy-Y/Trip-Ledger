import { db } from '../../utils/cf';
import { readSession } from '../../utils/auth';

/**
 * 目前登入的人。沒登入回 null 而不是 401 ——
 * 前端每次載入都會問一次,「沒登入」是正常狀態,不是錯誤。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const session = await readSession(event, dbh);
  if (!session?.userId) return { user: null };
  const user = await dbh.prepare(
    `SELECT id, email, display_name, created_at FROM users WHERE id = ?`,
  ).bind(session.userId).first<{ id: string; email: string; display_name: string; created_at: string }>();
  return { user: user ?? null };
});
