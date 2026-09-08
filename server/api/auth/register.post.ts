import { db } from '../../utils/cf';
import { uid } from '../../utils/trip';
import { hashPassword, iterationsOf, normalizeEmail, passwordProblem, promoteSession } from '../../utils/auth';

/**
 * 註冊。
 *
 * ⚠️ 已知限制:這支會明確回「這個 email 已經註冊過」,等於可以拿來確認
 * 某個 email 有沒有在這個服務註冊(帳號枚舉)。要真正堵住,得改成
 * 「我們寄了一封信給你」這種不透露結果的流程 —— 那需要先接 email 服務。
 * 在那之前,這是一個知情的取捨:如果不講,使用者會遇到「註冊沒反應」而卡住。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const b = await readBody<{ email?: string; password?: string; display_name?: string }>(event);

  const email = normalizeEmail(b?.email);
  if (!email) throw createError({ statusCode: 400, statusMessage: '請輸入有效的 email' });

  const pwProblem = passwordProblem(b?.password);
  if (pwProblem) throw createError({ statusCode: 400, statusMessage: pwProblem });

  const displayName = (b?.display_name ?? '').trim() || email.split('@')[0]!;
  if (displayName.length > 60) {
    throw createError({ statusCode: 400, statusMessage: '顯示名稱太長了(上限 60 字)' });
  }

  const taken = await dbh.prepare(`SELECT 1 AS ok FROM users WHERE email = ?`).bind(email).first();
  if (taken) throw createError({ statusCode: 409, statusMessage: '這個 email 已經註冊過了,請直接登入。' });

  const pw = await hashPassword(b!.password!, iterationsOf(useRuntimeConfig(event)));
  const id = uid();

  try {
    await dbh.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, password_iter)
       VALUES (?,?,?,?,?,?)`,
    ).bind(id, email, displayName, pw.hash, pw.salt, pw.iter).run();
  } catch (e) {
    // UNIQUE 撞車:兩個請求同時註冊同一個 email。上面的預先檢查擋不住併發,
    // 真正的守門員是資料庫的 UNIQUE 約束。
    if (String(e).includes('UNIQUE')) {
      throw createError({ statusCode: 409, statusMessage: '這個 email 已經註冊過了,請直接登入。' });
    }
    throw e;
  }

  await promoteSession(event, dbh, id);
  setResponseStatus(event, 201);
  return { id, email, display_name: displayName };
});
