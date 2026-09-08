/**
 * 測試用的登入 session。
 *
 * ── 為什麼需要這一支 ────────────────────────────────────────
 *
 * `POST /api/trips` 現在要登入(理由見 server/api/trips/index.post.ts:
 * 匿名建立會生出沒有 owner、誰都刪不掉的旅程)。而每一支 API 測試的
 * 第一個動作都是建旅程,所以每一支都需要一個帶著 cookie 的 fetch。
 *
 * 抽出來而不是各檔複製一份:六個測試檔的 `req()` 原本一字不差,
 * 那種複製貼上的東西一旦要改(例如再加一個 header)就會只改到其中幾份。
 *
 * ── 每個測試檔開一個獨立帳號 ────────────────────────────────
 *
 * email 帶 timestamp + 隨機碼,所以:
 *   - 同一支測試重跑不會撞到「這個 email 已經註冊過」
 *   - 平行跑不同測試檔時彼此的旅程列表互不干擾
 *     (GET /api/trips 只回自己有權存取的 —— 那正是 api.access 在守的性質)
 *
 * 帳號會留在本機 D1 裡。那和既有測試留下旅程的行為一致(測試不做清理,
 * 因為「刪得掉」本身就是一條要測的性質,順手清掉會讓失敗訊息變難讀)。
 */

export type J = Record<string, any>;
export interface Res { status: number; json: J }
export interface ApiSession {
  req: (method: string, path: string, body?: unknown) => Promise<Res>;
  get: (path: string) => Promise<Res>;
  post: (path: string, body?: unknown) => Promise<Res>;
  patch: (path: string, body?: unknown) => Promise<Res>;
  del: (path: string) => Promise<Res>;
  /** 這個 session 的帳號,需要斷言 owner 是誰時用得到。 */
  email: string;
  userId: string;
}

/**
 * 註冊一個拋棄式帳號並回傳帶著它的 cookie 的請求函式。
 *
 * @param base   dev server 的 origin
 * @param label  測試檔名之類的辨識字串,會進 email,失敗時看得出是誰的帳號
 */
export async function loginFixture(base: string, label: string): Promise<ApiSession> {
  const cookies = new Map<string, string>();

  async function req(method: string, path: string, body?: unknown): Promise<Res> {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (cookies.size) {
      headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const r = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    // 登入 / 註冊會換一組新 session(防 session fixation),所以每次都要收 cookie,
    // 不是只在第一次。Max-Age=0 是登出,要當成刪除。
    for (const line of r.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';')[0]!;
      const at = pair.indexOf('=');
      if (at < 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!value || /max-age=0/i.test(line)) cookies.delete(name);
      else cookies.set(name, value);
    }
    let json: J = {};
    const txt = await r.text();
    try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt.slice(0, 200) }; }
    return { status: r.status, json };
  }

  // 隨機碼不能省:同一毫秒內起跑的兩支測試會拿到同一個 timestamp。
  const email = `t-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const reg = await req('POST', '/api/auth/register', {
    email, password: 'test-fixture-password', display_name: `test:${label}`,
  });
  if (reg.status !== 201) {
    throw new Error(
      `測試帳號註冊失敗(${reg.status}): ${reg.json.statusMessage ?? JSON.stringify(reg.json)}\n`
      + '  → 沒有登入的話 POST /api/trips 會回 401,整支測試的第一個動作就會掛掉。',
    );
  }

  return {
    req,
    get: (p) => req('GET', p),
    post: (p, b?) => req('POST', p, b),
    patch: (p, b?) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
    email,
    userId: reg.json.id,
  };
}
