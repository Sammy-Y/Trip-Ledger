import type { H3Event } from 'h3';

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

/**
 * 用路由參數取出旅程。**id 或 share_token 都接受。**
 *
 * 設計取捨:這是「自己和幾個朋友用」的工具,不做權限。
 * 主要導覽走 trip id(旅程列表點進來就是 /t/<id>),
 * 但 share_token 仍然有效 —— 丟到 LINE 群組的舊連結不會壞,
 * 而且 token 比 id 更適合當分享用的網址(不會暴露內部 id 的可枚舉性)。
 */
export async function requireTrip(event: H3Event, dbh: D1Database): Promise<Trip> {
  const key = getRouterParam(event, 'trip');
  if (!key) throw createError({ statusCode: 400, statusMessage: '缺少旅程識別碼' });
  const trip = await dbh.prepare(
    `SELECT id, name, base_currency, start_date, end_date FROM trips
     WHERE share_token = ?1 OR id = ?1`,
  ).bind(key).first<Trip>();
  if (!trip) throw createError({ statusCode: 404, statusMessage: '找不到這個旅程' });
  return trip;
}
