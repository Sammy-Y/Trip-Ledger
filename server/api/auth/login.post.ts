import { db } from '../../utils/cf';
import {
  derivePassword, hashPassword, isLocked, iterationsOf, lockUntilFor,
  normalizeEmail, promoteSession, timingSafeEqual,
} from '../../utils/auth';

type UserRow = {
  id: string; email: string; display_name: string;
  password_hash: string; password_salt: string; password_iter: number;
  failed_count: number; locked_until: string | null;
};

/** email 不存在時拿來墊檔的雜湊參數。長度和真的一樣,只是永遠對不上。 */
const DUMMY_SALT = 'x'.repeat(22);

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const cfg = useRuntimeConfig(event);
  const b = await readBody<{ email?: string; password?: string }>(event);

  const email = normalizeEmail(b?.email);
  const password = typeof b?.password === 'string' ? b.password : '';
  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: '請輸入 email 和密碼' });
  }

  const user = await dbh.prepare(
    `SELECT id, email, display_name, password_hash, password_salt, password_iter,
            failed_count, locked_until
     FROM users WHERE email = ?`,
  ).bind(email).first<UserRow>();

  const now = new Date();
  const nowIso = now.toISOString();

  if (user && isLocked(user.locked_until, nowIso)) {
    throw createError({
      statusCode: 429,
      statusMessage: '密碼錯太多次,帳號暫時鎖住了。請過幾分鐘再試。',
    });
  }

  // email 不存在時也算一次雜湊。
  // 不這樣做的話,「查無此人」會比「密碼錯」快上一整個 PBKDF2 的時間,
  // 光看回應時間就能判斷某個 email 有沒有註冊過。
  const iter = user?.password_iter ?? iterationsOf(cfg);
  const salt = user?.password_salt ?? DUMMY_SALT;
  const derived = await derivePassword(password, salt, iter);
  const ok = !!user && timingSafeEqual(derived, user.password_hash);

  if (!ok) {
    if (user) {
      const failed = user.failed_count + 1;
      await dbh.prepare(
        `UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?`,
      ).bind(failed, lockUntilFor(failed, now), user.id).run();
    }
    throw createError({ statusCode: 401, statusMessage: 'email 或密碼不對' });
  }

  // 迭代次數被調高過 → 用新參數重算一次存回去。舊帳號會在下次登入時自動跟上,
  // 不需要叫所有人改密碼。
  const wanted = iterationsOf(cfg);
  if (user.password_iter !== wanted) {
    const next = await hashPassword(password, wanted);
    await dbh.prepare(
      `UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ?,
              failed_count = 0, locked_until = NULL WHERE id = ?`,
    ).bind(next.hash, next.salt, next.iter, user.id).run();
  } else if (user.failed_count !== 0 || user.locked_until !== null) {
    await dbh.prepare(
      `UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ?`,
    ).bind(user.id).run();
  }

  await promoteSession(event, dbh, user.id);
  return { id: user.id, email: user.email, display_name: user.display_name };
});
