import type { H3Event } from 'h3';

/**
 * 密碼與 session。
 *
 * ## 為什麼是 PBKDF2 而不是 bcrypt / argon2
 * Cloudflare Workers 沒有 Node 的原生模組,bcrypt 跑不起來;argon2 要背一包 WASM。
 * WebCrypto 的 PBKDF2 是這個 runtime 裡唯一不用額外依賴就能用的密碼雜湊。
 * 它比 argon2 弱在「不吃記憶體,對 GPU 破解友善」,但配上足夠的迭代次數
 * 加上帳號鎖定,對這個規模的服務是合理的。
 *
 * ## ⚠️ CPU 預算
 * Workers 免費版每次呼叫只有 10ms CPU(見 nuxt.config.ts 的註解),
 * 而 PBKDF2 的重點就是「故意很慢」。所以迭代次數做成 runtimeConfig 可調,
 * 而且每個使用者的迭代次數存在自己那一列 —— 之後調高時舊密碼還驗得過,
 * 登入成功時再用新參數重算(見 login.post.ts)。
 *
 * ## session 為什麼存雜湊
 * cookie 裡放原始 token,資料庫只存它的 SHA-256。這樣資料庫外洩時
 * 攻擊者拿到的東西無法直接當 cookie 用 —— 和密碼不存明碼是同一個道理。
 * session token 是高熵隨機值,不需要 PBKDF2,單次 SHA-256 就夠(也才不吃 CPU)。
 */

/** cookie 名稱。登入與訪客共用同一個 —— 差別只在 sessions.user_id 是否為 NULL。 */
export const SESSION_COOKIE = 'tl_sess';

/** session 有效期(天)。旅程動輒橫跨數週,設短了會一直被登出。 */
const SESSION_DAYS = 90;

/** 連續失敗幾次就鎖帳號。 */
const MAX_FAILED = 8;
/** 鎖多久(分鐘)。 */
const LOCK_MINUTES = 15;

const enc = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 密碼學等級的隨機字串,給 salt 和 session token 用。 */
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toBase64Url(a);
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

/**
 * 定時比較。
 *
 * `a === b` 會在第一個不同的字元就回傳,執行時間洩漏「猜對了幾個字元」,
 * 理論上可以一個字元一個字元地把雜湊試出來。這裡一律走完全長度。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function derivePassword(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations },
    key,
    256,
  );
  return toHex(bits);
}

export interface PasswordRecord { hash: string; salt: string; iter: number }

export async function hashPassword(password: string, iterations: number): Promise<PasswordRecord> {
  const salt = randomToken(16);
  return { hash: await derivePassword(password, salt, iterations), salt, iter: iterations };
}

export async function verifyPassword(password: string, rec: PasswordRecord): Promise<boolean> {
  return timingSafeEqual(await derivePassword(password, rec.salt, rec.iter), rec.hash);
}

/** runtimeConfig 的迭代次數。設定壞掉時退回一個安全的預設,不要靜靜地用 0。 */
export function iterationsOf(cfg: { pbkdf2Iterations?: unknown }): number {
  const n = Number(cfg?.pbkdf2Iterations);
  return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : 50_000;
}

// ── 帳號鎖定 ────────────────────────────────────────────────

export function isLocked(lockedUntil: string | null, nowIso: string): boolean {
  return !!lockedUntil && lockedUntil > nowIso;
}

/** 失敗次數達門檻時回傳「鎖到什麼時候」,否則 null。 */
export function lockUntilFor(failedCount: number, now: Date): string | null {
  if (failedCount < MAX_FAILED) return null;
  return new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString();
}

// ── session ────────────────────────────────────────────────

export interface SessionInfo {
  /** sessions.id,也就是 cookie token 的 SHA-256。 */
  id: string;
  /** 已登入才有值;訪客是 null。 */
  userId: string | null;
}

function sessionExpiry(now = new Date()): string {
  return new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString();
}

/**
 * 本機 http 開發時不能加 Secure,否則瀏覽器根本不會存這個 cookie。
 * 線上一律 https,所以直接看這次請求的協定就好。
 */
function cookieOptions(event: H3Event) {
  return {
    httpOnly: true,
    secure: getRequestProtocol(event) === 'https',
    // Lax 而不是 Strict:從 LINE 點分享連結進來屬於跨站導覽,
    // Strict 會讓那一次請求帶不到 cookie,使用者看起來就像沒登入。
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  };
}

/** 建立 session 並把 cookie 種下去。userId 為 null 就是訪客 session。 */
export async function startSession(event: H3Event, dbh: D1Database, userId: string | null): Promise<SessionInfo> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  await dbh.prepare(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)`,
  ).bind(id, userId, sessionExpiry()).run();
  setCookie(event, SESSION_COOKIE, token, cookieOptions(event));
  return { id, userId };
}

/**
 * 讀出目前的 session。過期或不存在都回 null。
 *
 * 刻意不在這裡自動建立 session —— 建立是寫入操作,不該發生在每一個 GET 上。
 * 需要 session 的地方(解鎖旅程、登入)才呼叫 startSession。
 */
export async function readSession(event: H3Event, dbh: D1Database): Promise<SessionInfo | null> {
  const token = getCookie(event, SESSION_COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await dbh.prepare(
    `SELECT id, user_id, expires_at FROM sessions WHERE id = ?`,
  ).bind(id).first<{ id: string; user_id: string | null; expires_at: string }>();
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) return null;
  return { id: row.id, userId: row.user_id };
}

/** 已經有 session 就沿用,沒有就開一個訪客 session。 */
export async function ensureSession(event: H3Event, dbh: D1Database): Promise<SessionInfo> {
  return (await readSession(event, dbh)) ?? await startSession(event, dbh, null);
}

export async function destroySession(event: H3Event, dbh: D1Database): Promise<void> {
  const token = getCookie(event, SESSION_COOKIE);
  if (token) {
    await dbh.prepare(`DELETE FROM sessions WHERE id = ?`).bind(await sha256Hex(token)).run();
  }
  deleteCookie(event, SESSION_COOKIE, { path: '/' });
}

// ── 輸入驗證 ────────────────────────────────────────────────

/** 夠用就好的 email 檢查。真正的驗證是「寄得到信」,那是之後的事。 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

/**
 * 密碼長度下限 10 而不是常見的 8。
 * 沒有 email 驗證、沒有二階段驗證的情況下,密碼是唯一一道門。
 */
export function passwordProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return '請輸入密碼';
  if (raw.length < 10) return '密碼至少要 10 個字';
  if (raw.length > 200) return '密碼太長了(上限 200 字)';
  return null;
}

/**
 * 登入 / 註冊成功後把 session 換成新的一組。
 *
 * 為什麼不直接把舊 session 的 user_id 補上去(那樣更省事):
 * **session fixation。** 攻擊者先想辦法讓受害者的瀏覽器帶著一個他知道的
 * cookie 值,等受害者登入,那個他知道的 cookie 就變成已登入狀態。
 * 只要在「權限升級」的瞬間換一組新的隨機值,這條路就斷了。
 *
 * 換的同時要把訪客期間解鎖過的旅程搬過去,否則使用者一登入
 * 反而看不到剛剛還在記帳的那一趟。
 */
export async function promoteSession(event: H3Event, dbh: D1Database, userId: string): Promise<SessionInfo> {
  const old = await readSession(event, dbh);
  const next = await startSession(event, dbh, userId);
  if (old) {
    await dbh.batch([
      dbh.prepare(
        `INSERT INTO session_trips (session_id, trip_id)
         SELECT ?, trip_id FROM session_trips WHERE session_id = ?
         ON CONFLICT (session_id, trip_id) DO NOTHING`,
      ).bind(next.id, old.id),
      dbh.prepare(`DELETE FROM sessions WHERE id = ?`).bind(old.id),
    ]);
  }
  return next;
}

/**
 * 刪掉過期的 session。
 *
 * readSession 已經會拒絕過期的 session,所以這支不影響安全性,
 * 只是不讓 sessions / session_trips 無限長大 ——
 * 每個沒帶 cookie 又點了分享連結的人都會留下一列。
 *
 * session_trips 有 ON DELETE CASCADE,跟著一起清掉。
 */
export async function purgeExpiredSessions(dbh: D1Database): Promise<number> {
  const res = await dbh.prepare(
    `DELETE FROM sessions WHERE expires_at <= ?`,
  ).bind(new Date().toISOString()).run();
  return res.meta.changes ?? 0;
}
