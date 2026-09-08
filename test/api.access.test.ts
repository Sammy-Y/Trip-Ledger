/**
 * 存取控制整合測試。issue #3
 *
 * 這支的每一條都對應一個「開放給不特定使用者之前必須成立」的性質。
 * 打真實 dev server + 真實本機 D1,不 mock —— 權限是最不該用 mock 驗的東西,
 * 因為漏洞往往就出在「真實的 SQL 少了一個 WHERE」。
 *
 * 用法:先 `pnpm dev`,再
 *   node --experimental-strip-types test/api.access.test.ts [baseUrl]
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { group, check, eq, summary } from './_harness.ts';

const BASE = process.argv[2] || process.env.BASE_URL || '';

async function findBase(): Promise<string | null> {
  const cands = BASE ? [BASE] : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
  for (const b of cands) {
    try {
      const r = await fetch(`${b}/api/trips/__probe__`, { signal: AbortSignal.timeout(3000) });
      if (r.status === 404 || r.ok) return b;
    } catch { /* 試下一個 */ }
  }
  return null;
}

const base = await findBase();
if (!base) {
  console.log('\n⚠ 找不到執行中的 dev server。請先 `pnpm dev`,再重跑這支測試。');
  process.exit(2);
}
console.log(`dev server: ${base}`);

type J = Record<string, any>;

/**
 * 一個「瀏覽器」。權限測試的重點就是不同身分之間看得到什麼,
 * 所以每個角色各拿一個獨立的 cookie jar,不能共用 fetch。
 */
class Client {
  // strip-only 模式不支援建構子參數屬性,所以這裡不放 label 之類的欄位。
  private cookies = new Map<string, string>();

  async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: J }> {
    const headers: Record<string, string> = {};
    if (body) headers['content-type'] = 'application/json';
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const r = await fetch(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    for (const line of r.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const eqAt = pair!.indexOf('=');
      if (eqAt < 0) continue;
      const name = pair!.slice(0, eqAt).trim();
      const value = pair!.slice(eqAt + 1).trim();
      // Max-Age=0 / 空值 = 伺服器要求刪除這個 cookie(登出)
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    let json: J = {};
    const txt = await r.text();
    try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt.slice(0, 200) }; }
    return { status: r.status, json };
  }

  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
  del = (p: string) => this.req('DELETE', p);
  /** 忘掉所有 cookie —— 模擬換一台裝置 / 開無痕視窗。 */
  forget() { this.cookies.clear(); }
}

/**
 * 把一趟旅程變成「無主」—— 刪掉它的 trip_access。
 *
 * **API 刻意沒有這個動作**:讓一趟旅程失去擁有者是沒有現實對應的操作。
 * 這裡直接動資料庫,因為要測的是「規則上線前留下的歷史資料還收得回來」,
 * 那個狀態現在已經沒有任何使用者流程能製造出來。
 *
 * 走 miniflare 的 sqlite 檔(和 api.rounds / api.pot 數列時同一招)。
 * 拿不到檔案就直接讓測試失敗,不要靜靜跳過那一整組。
 */
function orphanize(tripId: string): void {
  const dir = fileURLToPath(new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url));
  const files = readdirSync(dir).filter((n) => n.endsWith('.sqlite') && n !== 'metadata.sqlite');
  if (!files.length) throw new Error('找不到本機 D1 檔案,無法製造無主旅程');
  // 目錄裡可能有多個(wrangler.jsonc 的 database_id 改過就會多一個),
  // dev server 讀的是最近被寫入的那個。
  const path = dir + files
    .map((n) => ({ n, at: statSync(dir + n).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]!.n;
  const dbh = new DatabaseSync(path);
  try {
    dbh.prepare('DELETE FROM trip_access WHERE trip_id = ?').run(tripId);
  } finally {
    dbh.close();
  }
}

const stamp = Date.now();
const alice = new Client();
const bob = new Client();
const anon = new Client();

// ── 註冊與登入 ────────────────────────────────────────────

group('[帳號] 註冊的輸入驗證');
eq('email 格式不對 → 400',
  (await alice.post('/api/auth/register', { email: 'nope', password: 'abcdefghij' })).status, 400);
eq('密碼太短 → 400',
  (await alice.post('/api/auth/register', { email: `a${stamp}@example.com`, password: 'short' })).status, 400);

group('[帳號] 註冊 → 自動登入');
const aliceEmail = `alice${stamp}@example.com`;
const alicePw = 'correct-horse-battery';
const reg = await alice.post('/api/auth/register', {
  email: aliceEmail, password: alicePw, display_name: 'Alice',
});
eq('註冊 → 201', reg.status, 201);
eq('email 正規化成小寫', reg.json.email, aliceEmail);
const me1 = await alice.get('/api/auth/me');
eq('註冊完就是登入狀態', me1.json.user?.email, aliceEmail);

eq('同一個 email 再註冊 → 409',
  (await bob.post('/api/auth/register', { email: aliceEmail, password: 'another-long-one' })).status, 409);
eq('email 大小寫不同也算同一個 → 409',
  (await bob.post('/api/auth/register', { email: aliceEmail.toUpperCase(), password: 'another-long-one' })).status, 409);

group('[帳號] 登入');
eq('密碼錯 → 401',
  (await bob.post('/api/auth/login', { email: aliceEmail, password: 'wrong-password-here' })).status, 401);
eq('查無此 email → 401(與密碼錯同一個回應,不洩漏帳號存在與否)',
  (await bob.post('/api/auth/login', { email: `ghost${stamp}@example.com`, password: 'wrong-password-here' })).status, 401);

// ── 旅程的可見性 ──────────────────────────────────────────

group('[隔離] 沒有 session 的人看不到任何旅程');
const anonList = await anon.get('/api/trips');
eq('GET /api/trips → 200', anonList.status, 200);
eq('回傳空陣列,不是全部旅程', Array.isArray(anonList.json) && anonList.json.length, 0);

group('[建立] 登入的人建立旅程 → owner');
const aliceTrip = await alice.post('/api/trips', {
  name: `Alice 的旅程 ${stamp}`, base_currency: 'TWD', members: ['Alice', 'Amy'],
});
eq('建立 → 201', aliceTrip.status, 201);
eq('role = owner', aliceTrip.json.role, 'owner');
const aliceTripId: string = aliceTrip.json.id;
const aliceToken: string = aliceTrip.json.share_token;

const aliceList = await alice.get('/api/trips');
eq('自己的列表看得到這一趟', aliceList.json.some((t: J) => t.id === aliceTripId), true);
eq('owner 拿得到 share_token',
  aliceList.json.find((t: J) => t.id === aliceTripId)?.share_token, aliceToken);

group('[隔離] 別人看不到 Alice 的旅程 —— 這是整個 issue 的核心');
const bobEmail = `bob${stamp}@example.com`;
await bob.post('/api/auth/register', { email: bobEmail, password: 'bobs-long-password', display_name: 'Bob' });
const bobList = await bob.get('/api/trips');
eq('Bob 的列表是空的', bobList.json.length, 0);
eq('Bob 用 trip id 直接打 → 404(不是 403,不洩漏存在性)',
  (await bob.get(`/api/trips/${aliceTripId}`)).status, 404);
eq('Bob 讀不到支出', (await bob.get(`/api/trips/${aliceTripId}/expenses`)).status, 404);
eq('Bob 寫不進支出',
  (await bob.post(`/api/trips/${aliceTripId}/expenses`, {
    kind: 'shared', description: '偷寫', currency: 'TWD', amount: 100,
    spent_at: new Date().toISOString(), payers: [{ member_id: 'x' }],
    split: { mode: 'equal', members: ['x'] },
  })).status, 404);
eq('Bob 刪不掉 Alice 的旅程', (await bob.del(`/api/trips/${aliceTripId}`)).status, 404);

group('[分享] 拿到 share_token 就進得去,而且會被記住');
const carol = new Client();
const viaToken = await carol.get(`/api/trips/${aliceToken}`);
eq('用 share_token → 200', viaToken.status, 200);
eq('訪客的 role 是 editor', viaToken.json.role, 'editor');
eq('editor 拿不到 share_token(鑰匙不該再被轉發)', viaToken.json.share_token, null);
eq('解鎖後改用 trip id 也進得去', (await carol.get(`/api/trips/${aliceTripId}`)).status, 200);
eq('解鎖過的旅程會出現在訪客的列表裡',
  (await carol.get('/api/trips')).json.some((t: J) => t.id === aliceTripId), true);
eq('訪客(editor)刪不掉旅程', (await carol.del(`/api/trips/${aliceTripId}`)).status, 403);

group('[分享] 換一台裝置就沒有權限了 —— cookie 是憑證,不是 trip id');
carol.forget();
eq('清掉 cookie 後用 trip id → 404', (await carol.get(`/api/trips/${aliceTripId}`)).status, 404);
eq('清掉 cookie 後用 share_token 仍可 → 200', (await carol.get(`/api/trips/${aliceToken}`)).status, 200);

group('[權限] 只有 owner 能刪除');
eq('Alice 刪自己的旅程 → 200', (await alice.del(`/api/trips/${aliceTripId}`)).status, 200);
eq('刪掉之後連 owner 也讀不到 → 404', (await alice.get(`/api/trips/${aliceTripId}`)).status, 404);

// ── 建立要登入,但加入不用 ──────────────────────────────────

group('[門檻] 沒登入不能開新旅程 —— 但拿到連結就能記帳');
/*
  這一組守的是那條門檻放在正確的位置上。

  匿名建立以前是允許的,理由是「註冊門檻擋在想試試的人前面會勸退他」。
  實際跑起來會累積出無主旅程:沒有 owner、誰都刪不掉、建立者換個分頁
  就再也找不到。門檻該擋的是「開一趟新的」,不是「加入別人的」——
  後者持有分享連結本身就是憑證,而且是這個產品降低協作門檻的核心設計。
*/
const anonCreate = await anon.post('/api/trips', { name: `不該建成 ${stamp}`, members: ['甲'] });
eq('沒登入建立旅程 → 401', anonCreate.status, 401);
check('錯誤訊息要說得出「旅伴不用註冊」,不然他會以為整個 App 都要註冊',
  String(anonCreate.json.statusMessage ?? '').includes('不用註冊'),
  String(anonCreate.json.statusMessage));
eq('一趟都沒被建出來', (await anon.get('/api/trips')).json.length, 0);

// 但同一個訪客拿到 Alice 的分享連結就能進去記帳(aliceTrip 在上面已經刪掉了,
// 所以這裡另外開一趟)。
const shared = await alice.post('/api/trips', {
  name: `分享給訪客 ${stamp}`, base_currency: 'JPY', members: ['Alice', 'Guest'],
});
const sharedId: string = shared.json.id;
const sharedToken: string = shared.json.share_token;
eq('登入的人建立 → 201', shared.status, 201);
eq('建立者是 owner', shared.json.role, 'owner');

eq('訪客用 share_token 進得去 → 200', (await anon.get(`/api/trips/${sharedToken}`)).status, 200);
eq('而且他是 editor', (await anon.get(`/api/trips/${sharedToken}`)).json.role, 'editor');
const guestMembers = (await anon.get(`/api/trips/${sharedToken}`)).json.members ?? [];
const guestExpense = await anon.post(`/api/trips/${sharedToken}/expenses`, {
  kind: 'shared', description: '訪客記的一筆', currency: 'JPY', amount: 1000,
  spent_at: '2026-03-08',
  payers: [{ member_id: guestMembers[0]?.id }],
  split: { mode: 'equal', members: guestMembers.map((m: J) => m.id) },
});
eq('訪客記帳 → 201(這是「旅伴不用註冊」的實質內容)', guestExpense.status, 201);
eq('但他仍然刪不掉整趟 → 403', (await anon.del(`/api/trips/${sharedId}`)).status, 403);
eq('那一筆也真的進去了', (await alice.get(`/api/trips/${sharedId}/expenses`)).json.length, 1);

group('[認領] 既有的無主旅程仍然收得回來');
/*
  新規則之後不會再產生無主旅程,但規則上線前建立的那幾趟還在
  (線上實際遇到:進得去、記得帳,但沒有 owner 所以誰都刪不掉)。
  這一組直接往 trip_access 的空狀態造一趟來守那條出口 ——
  不能再靠「匿名建立一趟」來製造,因為那條路已經封了。
*/
const orphan = await alice.post('/api/trips', { name: `待認領 ${stamp}`, members: ['甲', '乙'] });
const orphanId: string = orphan.json.id;
const orphanToken: string = orphan.json.share_token;
// 讓它變成無主:把 Alice 的 owner 紀錄拿掉。API 沒有這個動作(刻意的),
// 所以這裡直接動資料庫 —— 這一組模擬的是「歷史資料」而不是使用者能觸發的流程。
eq('先確認它現在有 owner', (await alice.get(`/api/trips/${orphanId}`)).json.orphan, false);
await orphanize(orphanId);

// ⚠️ 這裡刻意不用 alice 查。她的 trip_access 剛被刪掉,而她的 session
// 從來沒有用 share_token 解鎖過這一趟 —— 所以她現在拿 trip id 去問會得到 404,
// 那是對的(光知道 id 不是憑證)。要看無主狀態只能走 share_token。
eq('原本的擁有者失去權限後,連看都看不到 → 404',
  (await alice.get(`/api/trips/${orphanId}`)).status, 404);
eq('變成無主', (await alice.get(`/api/trips/${orphanToken}`)).json.orphan, true);
eq('無主旅程沒人能刪 → 403', (await alice.del(`/api/trips/${orphanToken}`)).status, 403);
eq('沒登入不能認領 → 401', (await anon.post(`/api/trips/${orphanToken}/claim`)).status, 401);
const dave = new Client();
eq('登入了但進不去也不能認領 → 404',
  (await dave.post(`/api/trips/${orphanId}/claim`)).status, 404);

await bob.get(`/api/trips/${orphanToken}`);          // Bob 先用連結進去
const claimed = await bob.post(`/api/trips/${orphanToken}/claim`);
eq('Bob 認領 → 201', claimed.status, 201);
eq('認領後 role = owner', (await bob.get(`/api/trips/${orphanId}`)).json.role, 'owner');
eq('認領後看得到 share_token',
  (await bob.get(`/api/trips/${orphanId}`)).json.share_token, orphanToken);
eq('不再是無主', (await bob.get(`/api/trips/${orphanId}`)).json.orphan, false);
eq('重複認領 → 409', (await bob.post(`/api/trips/${orphanToken}/claim`)).status, 409);

// 原本用連結進來的訪客仍然進得去(他還是這趟的記帳者),但不是 owner
await anon.get(`/api/trips/${orphanToken}`);
eq('訪客還是進得去', (await anon.get(`/api/trips/${orphanId}`)).status, 200);
eq('但他是 editor 不是 owner', (await anon.get(`/api/trips/${orphanId}`)).json.role, 'editor');
eq('別人認領後他就刪不掉了 → 403', (await anon.del(`/api/trips/${orphanId}`)).status, 403);

group('[session] 登出之後就什麼都看不到了');
await bob.post('/api/auth/logout');
eq('me → null', (await bob.get('/api/auth/me')).json.user, null);
eq('列表變空', (await bob.get('/api/trips')).json.length, 0);
eq('用 trip id 進不去 → 404', (await bob.get(`/api/trips/${orphanId}`)).status, 404);

group('[session] 重新登入拿得回自己的旅程 —— 這是帳號存在的理由');
await bob.post('/api/auth/login', { email: bobEmail, password: 'bobs-long-password' });
eq('登入後列表又有了',
  (await bob.get('/api/trips')).json.some((t: J) => t.id === orphanId), true);

// 收尾:把測試建立的旅程刪掉
await bob.del(`/api/trips/${orphanId}`);
await alice.del(`/api/trips/${sharedId}`);

process.exit(summary() > 0 ? 1 : 0);
