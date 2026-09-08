import type { H3Event } from 'h3';
import { readSession, startSession, timingSafeEqual, type SessionInfo } from './auth';

export const uid = () => crypto.randomUUID();

export function shareToken(n = 18) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type Trip = {
  id: string; name: string; base_currency: string;
  start_date: string | null; end_date: string | null;
};

export type TripRole = 'owner' | 'editor';

export interface TripAccess {
  trip: Trip;
  role: TripRole;
  /** 這趟還沒有任何帳號擁有它(權限層上線前就存在的舊資料)。可被登入使用者認領。 */
  orphan: boolean;
  /** 這次請求所屬的 session。訪客也有,只是 userId 為 null。 */
  session: SessionInfo;
  /** 只有 owner 看得到。其他人一律 null —— 拿到它就等於拿到這趟的鑰匙。 */
  shareToken: string | null;
}

/**
 * 「找不到」和「沒權限」一律回同一個 404。
 *
 * 回 403 等於告訴對方「這個 id 是存在的」,那本身就是資訊洩漏 ——
 * 可以拿來確認某個 id 有沒有被用、枚舉出哪些旅程存在。
 */
function notFound() {
  return createError({ statusCode: 404, statusMessage: '找不到這個旅程' });
}

type TripRow = Trip & { share_token: string };

/**
 * 解析這次請求對某趟旅程有什麼權限。
 *
 * 判斷順序(第一個成立的就是答案):
 *   1. 已登入,且 trip_access 有這個 user  → 用該筆的 role
 *   2. session 之前用 share_token 解鎖過   → editor
 *   3. 網址上那一段就是有效的 share_token  → 解鎖並記進 session,editor
 *   4. 以上皆非                            → 404
 *
 * 關鍵在第 4 條與 id 的關係:**光知道 trip id 不再等於有權限。**
 * 舊版是 `WHERE share_token = ?1 OR id = ?1` 就放行,而當時
 * GET /api/trips 會把所有人的 id 和 token 一起吐出來,等於後門大開。
 * 現在 id 只是「我已經有權限了,用它導覽」的捷徑,單獨拿到沒有任何用處。
 */
export async function resolveTripAccess(event: H3Event, dbh: D1Database): Promise<TripAccess> {
  const key = getRouterParam(event, 'trip');
  if (!key) throw createError({ statusCode: 400, statusMessage: '缺少旅程識別碼' });

  const row = await dbh.prepare(
    `SELECT id, name, base_currency, start_date, end_date, share_token FROM trips
     WHERE id = ?1 OR share_token = ?2`,
  ).bind(key, key).first<TripRow>();
  if (!row) throw notFound();

  const trip: Trip = {
    id: row.id, name: row.name, base_currency: row.base_currency,
    start_date: row.start_date, end_date: row.end_date,
  };

  // 無主旅程要讓 UI 知道,才能顯示「認領」。一趟一次查詢,不算貴。
  const owners = await dbh.prepare(
    `SELECT COUNT(*) AS n FROM trip_access WHERE trip_id = ?`,
  ).bind(row.id).first<{ n: number }>();
  const orphan = (owners?.n ?? 0) === 0;

  const existing = await readSession(event, dbh);

  const grant = (role: TripRole, session: SessionInfo): TripAccess => ({
    trip,
    role,
    orphan,
    session,
    shareToken: role === 'owner' ? row.share_token : null,
  });

  // 1. 帳號的正式權限
  if (existing?.userId) {
    const access = await dbh.prepare(
      `SELECT role FROM trip_access WHERE trip_id = ? AND user_id = ?`,
    ).bind(row.id, existing.userId).first<{ role: TripRole }>();
    if (access) return grant(access.role, existing);
  }

  // 2. 這個 session 先前已經用 token 解鎖過
  if (existing) {
    const unlocked = await dbh.prepare(
      `SELECT 1 AS ok FROM session_trips WHERE session_id = ? AND trip_id = ?`,
    ).bind(existing.id, row.id).first<{ ok: number }>();
    if (unlocked) return grant('editor', existing);
  }

  // 3. 網址帶的是 share_token —— 持有 token 本身就是憑證。
  //    解鎖一次就記進 session,之後即使網址換成 id 也還進得來。
  if (timingSafeEqual(key, row.share_token)) {
    const session = existing ?? await startSession(event, dbh, null);
    await dbh.prepare(
      `INSERT INTO session_trips (session_id, trip_id) VALUES (?,?)
       ON CONFLICT (session_id, trip_id) DO NOTHING`,
    ).bind(session.id, row.id).run();
    return grant('editor', session);
  }

  // 4. 只知道 id,沒有任何憑證
  throw notFound();
}

/**
 * 取出旅程,順便驗權限。**簽名與回傳值刻意和沒有權限層時完全一樣**,
 * 所以 21 個既有的 endpoint 一行都不用改就自動受到保護。
 *
 * 需要分辨 owner / editor 的少數 endpoint(刪除旅程、看 share_token)
 * 改用 resolveTripAccess 或 requireOwner。
 */
export async function requireTrip(event: H3Event, dbh: D1Database): Promise<Trip> {
  return (await resolveTripAccess(event, dbh)).trip;
}

/** 只有 owner 能做的事。無主旅程沒有 owner,要先認領。 */
export async function requireOwner(event: H3Event, dbh: D1Database): Promise<TripAccess> {
  const access = await resolveTripAccess(event, dbh);
  if (access.role !== 'owner') {
    throw createError({
      statusCode: 403,
      statusMessage: access.orphan
        ? '這趟旅程還沒有擁有者。請先登入並認領它,才能做這個操作。'
        : '只有旅程的擁有者可以做這個操作。',
    });
  }
  return access;
}
