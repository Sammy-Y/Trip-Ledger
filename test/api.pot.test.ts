/**
 * 公費金流逐筆修改 / 刪除的 API 整合測試。打真實 dev server + 真實本機 D1,不 mock。
 *
 *   pnpm dev            # 另一個終端
 *   pnpm test:pot
 *
 * ══ 這支測試在防守什麼 ═══════════════════════════════════════════
 *
 * 「公費給了 10,000 其實是 8,000」以前只能記一筆退還 2,000 去沖銷 ——
 * 剩餘是對的,帳面卻多出兩筆從來沒發生過的金流。GET / PATCH / DELETE
 * 三支端點是為了讓那筆記錄可以**被改成事實**,而它們動的是
 * 「公費信封裡有多少現金」這個唯一沒有第二條路徑可以對照的數字
 * (剩餘只住在 balance.get.ts 的 potSummary,見 shared/types.ts 的警告)。
 *
 * 所以這裡盯的是四件事:
 *
 *   ① **剩餘不可為負。** 減少一筆投入、或增加一筆退還,都可能讓
 *      「信封裡的錢比實際有的多」。那是沒有現實對應的狀態:總覽會據此
 *      叫人再退還,而退出去的錢是憑空生出來的。
 *   ② **被擋下來的時候資料庫一個字都沒動。** 擋住但已經改了一半,
 *      比不擋還糟 —— 使用者看到錯誤訊息會以為沒事,而帳已經壞了。
 *   ③ **擋人的是資料庫層那道前提,不是 JS 那個 if。** 兩支請求可以雙雙
 *      通過 JS 檢查再雙雙寫入,所以最後那組是併發。**循序測試證明不了
 *      SQL 那道存在**(JS 還在的話循序請求永遠先撞 JS),這個 repo 上一次
 *      就踩到這個,所以那一組是必要的,不是加分項。
 *   ④ **改公費金流會等量移動結算的淨額,而且支點不變量要一直成立。**
 *      投入 / 退還進淨額(見 server/utils/ledger.ts 開頭),所以改了一筆投入之後
 *      那個人的淨額必須跟著移動同樣多,而 `公費淨額 === −剩餘` 一步都不能鬆。
 *
 * 每一組都自己建一趟新旅程 —— 剩餘是「整趟」的概念,
 * 組跟組之間共用旅程的話,前一組留下的錢會污染下一組的數字。
 */
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { group, check, eq, summary } from './_harness.ts';
import { loginFixture } from './_session.ts';

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
// 建立旅程要登入(見 server/api/trips/index.post.ts),所以整支測試跑在一個
// 拋棄式帳號的 session 上。cookie 的處理與逐檔獨立的理由見 test/_session.ts。
const session = await loginFixture(base, 'pot');
const req = session.req;
const get = (p: string) => req('GET', p);
const post = (p: string, b?: unknown) => req('POST', p, b);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);
const del = (p: string) => req('DELETE', p);

await post('/api/admin/sync-rates');

// ═══════════════════════════════════════════════════════════════
// 直接讀本機 D1 —— 「被擋下來時資料庫沒被改到」用 API 表達不出來
// ═══════════════════════════════════════════════════════════════
//
// 用 balance 反推是不夠的:剩餘算的是三個總和,「那一列沒被改到」和
// 「那一列被改小、另一列同時被改大」在總和上長得一模一樣。
// 要斷言的是**那一列本身**,所以只能去讀列。
//
// 檔案的挑選邏輯與 api.rounds.test.ts 相同(同一個目錄可能有多個 .sqlite,
// database_id 一改就會多一個空的,要挑 mtime 最新的那個)。
function findD1(): string | null {
  try {
    const dir = fileURLToPath(new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url));
    const files = readdirSync(dir).filter((n) => n.endsWith('.sqlite') && n !== 'metadata.sqlite');
    if (!files.length) return null;
    return dir + files
      .map((n) => ({ n, at: statSync(dir + n).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]!.n;
  } catch { return null; }
}
const D1_PATH = findD1();
console.log(D1_PATH ? `本機 D1: ${D1_PATH}` : '⚠ 找不到本機 D1 檔案 —— 需要讀列的斷言會失敗');

function d1All<T = J>(sql: string, ...args: Array<string | number | null>): T[] | null {
  if (!D1_PATH) return null;
  const dbh = new DatabaseSync(D1_PATH, { readOnly: true });
  try { return dbh.prepare(sql).all(...args) as T[]; }
  catch (e) { console.log(`  (D1 讀取失敗:${String(e)})`); return null; }
  finally { dbh.close(); }
}
/** 寫入本機 D1 —— 只用在「注入結算回合寫的公費腿」那一組(正常路徑產生不出來)。 */
function d1Write(sql: string, ...args: Array<string | number | null>): boolean {
  if (!D1_PATH) return false;
  const dbh = new DatabaseSync(D1_PATH);
  try { dbh.prepare(sql).run(...args); return true; }
  catch (e) { console.log(`  (D1 寫入失敗:${String(e)})`); return false; }
  finally { dbh.close(); }
}

/** 直接讀那一列的金額。null = 這列不在了。 */
function rowAmount(id: string): number | null {
  const rows = d1All<{ amount_minor: number }>(
    `SELECT amount_minor FROM settlements WHERE id = ?`, id);
  return rows && rows.length ? rows[0]!.amount_minor : null;
}
function countSettlements(tripId: string): number | null {
  const rows = d1All<{ n: number }>(
    `SELECT COUNT(*) AS n FROM settlements WHERE trip_id = ?`, tripId);
  return rows ? rows[0]!.n : null;
}

// ═══════════════════════════════════════════════════════════════
// 共用小工具
// ═══════════════════════════════════════════════════════════════
type Ctx = { T: string; tripId: string; id: Record<string, string>; name: (mid: string) => string };

async function mkTrip(label: string, members: string[], pot?: string): Promise<Ctx> {
  const r = await post('/api/trips', {
    name: `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    base_currency: 'TWD', members, ...(pot ? { pot } : {}),
  });
  eq(`建立旅程(${label})→ 201`, r.status, 201);
  const info = await get(`/api/trips/${r.json.share_token}`);
  const id: Record<string, string> = {};
  const rev = new Map<string, string>();
  for (const m of (info.json.members ?? []) as J[]) { id[m.name] = m.id; rev.set(m.id, m.name); }
  return {
    T: r.json.share_token, tripId: r.json.id, id,
    name: (mid: string) => rev.get(mid) ?? `?${String(mid).slice(0, 6)}`,
  };
}

/**
 * 金額一律用日幣 —— exponent 0,所以「最小單位」就是畫面上的數字。
 * 台幣的話每個斷言都要多兩個零,讀的人得自己心算才知道測的是什麼情境。
 */
const yen = (T: string, body: J) => post(`/api/trips/${T}/expenses`, {
  kind: 'shared', payment_method: 'cash', spent_at: '2026-03-08', currency: 'JPY', ...body,
});
const moveIn = (T: string, entries: J[]) =>
  post(`/api/trips/${T}/pot/moves`, { direction: 'in', currency: 'JPY', entries });
const moveOut = (T: string, entries: J[]) =>
  post(`/api/trips/${T}/pot/moves`, { direction: 'out', currency: 'JPY', entries });

async function listMoves(T: string) {
  const r = await get(`/api/trips/${T}/pot/moves`);
  return { status: r.status, moves: (r.json.moves ?? []) as J[] };
}
/** 清單攤成 ['in 民 5000'] —— 方向、對象、金額、順序一次斷言完。 */
const fmt = (moves: J[], c: Ctx) =>
  moves.map((m) => `${m.direction} ${c.name(m.member_id)} ${m.amount_minor}`);

/** 這趟某個幣別的公費三個量 + 剩餘。 */
async function potOf(T: string, currency = 'JPY') {
  const bal = await get(`/api/trips/${T}/balance`);
  const row = ((bal.json.pot?.by_currency ?? []) as J[]).find((r) => r.currency === currency);
  return { bal: bal.json, row: row ?? ({} as J) };
}
/** 淨額(含公費),map 起來方便逐人斷言。 */
function netsOf(bal: J, currency = 'JPY') {
  const nets = (bal.by_currency?.[currency]?.nets ?? []) as J[];
  return new Map<string, number>(nets.map((n) => [n.memberId, n.netMinor]));
}
const transfersOf = (bal: J, c: Ctx, currency = 'JPY') =>
  ((bal.by_currency?.[currency]?.recorded ?? []) as J[])
    .map((t) => `${c.name(t.from)}→${c.name(t.to)} ${t.amountMinor}`).sort();

/** 常見情境:兩個人投入公費、公費花掉一筆,剩下 remaining。 */
async function potTrip(label: string, contributions: Array<[string, number]>, spend: number) {
  const c = await mkTrip(label, ['民', '喧'], '公費');
  const r = await moveIn(c.T, contributions.map(([n, a]) => ({ member_id: c.id[n], amount_minor: a })));
  eq(`投入 ${contributions.map(([n, a]) => `${n} ${a}`).join(' / ')} → 201`, r.status, 201);
  if (spend > 0) {
    const e = await yen(c.T, {
      description: '公費晚餐', amount: spend,
      payers: [{ member_id: c.id['公費'] }],
      split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
    });
    eq(`公費花掉 ¥${spend} → 201`, e.status, 201);
  }
  return c;
}

// ═══════════════════════════════════════════════════════════════
group('[1] 逐筆列出公費金流 —— 方向、對象、順序');
// ═══════════════════════════════════════════════════════════════
//
// 這一組是整個功能的前提:編輯的單位是「列」,而列要能被指定就得先被列出來。
// 總覽的 contributions 是每人合計,分不出「第一天 5,000、第二天再 5,000」
// 是哪一筆 —— 對合計說「改成 8,000」沒有唯一解。
{
  const c = await mkTrip('P1 清單', ['民', '喧'], '公費');
  const empty = await listMoves(c.T);
  eq('還沒有任何金流 → 200 空清單', `${empty.status} ${empty.moves.length}`, '200 0');

  eq('兩個人各投入 ¥5,000 → 201', (await moveIn(c.T, [
    { member_id: c.id['民'], amount_minor: 5000 },
    { member_id: c.id['喧'], amount_minor: 5000 },
  ])).status, 201);
  eq('公費退還喧 ¥1,200 → 201',
    (await moveOut(c.T, [{ member_id: c.id['喧'], amount_minor: 1200 }])).status, 201);

  const l = await listMoves(c.T);
  eq('三筆都在,而且新的排前面(退還最後記,排第一)',
    fmt(l.moves, c), ['out 喧 1200', 'in 喧 5000', 'in 民 5000']);
  eq('每一筆都帶得出時間', l.moves.filter((m) => !!m.settled_at).length, 3);
  eq('備註是 moves.post 寫的那句',
    [...new Set(l.moves.map((m) => m.note))].sort(), ['公費退還', '投入公費']);
  eq('每一筆都有 id', l.moves.filter((m) => typeof m.id === 'string' && m.id.length > 0).length, 3);
  eq('幣別跟著每一列走', [...new Set(l.moves.map((m) => m.currency))], ['JPY']);

  // 人對人的還款不是公費金流。列進來的話,使用者會在「公費」的清單裡
  // 看到一筆和信封無關的錢,而且改它會改到真的債務。
  //
  // 晚餐刻意是 ¥20,000:淨額含投入(見 server/utils/ledger.ts),
  // 喧 手上已經有「投入 5,000 − 領回 1,200」的正值,分攤金額不夠大的話
  // 他根本不欠民錢,下面那筆還款會被上限擋成 409,這一組就測不到它想測的事。
  eq('民墊晚餐 ¥20,000 兩人均分 → 201', (await yen(c.T, {
    description: '晚餐', amount: 20000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  const p2p = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 2000,
  });
  eq('喧還民 ¥2,000 → 201', p2p.status, 201);
  const l2 = await listMoves(c.T);
  eq('人對人的還款不在公費清單裡(還是三筆)', l2.moves.length, 3);
  eq('那一列確實寫進資料庫了(只是不屬於這份清單)', countSettlements(c.tripId), 4);

  // 沒有公費的旅程:空清單,不是 404 —— 前端拿到空陣列就顯示「還沒有任何公費金流」。
  const noPot = await mkTrip('P1 沒有公費', ['民', '喧']);
  const l3 = await listMoves(noPot.T);
  eq('沒設公費的旅程 → 200 空清單', `${l3.status} ${l3.moves.length}`, '200 0');
}

// ═══════════════════════════════════════════════════════════════
group('[2] 改金額 —— 剩餘與 contributedMinor 跟著變,其他都不動');
// ═══════════════════════════════════════════════════════════════
{
  const c = await potTrip('P2 改金額', [['民', 10000], ['喧', 5000]], 3000);
  const before = await potOf(c.T);
  eq('改之前:投入 15,000 − 花 3,000 = 剩 12,000',
    [before.row.contributedMinor, before.row.spentMinor, before.row.remainingMinor],
    [15000, 3000, 12000]);

  const l0 = await listMoves(c.T);
  const mins = l0.moves.find((m) => c.name(m.member_id) === '民')!;
  const stamp = mins.settled_at;

  const r = await patch(`/api/trips/${c.T}/pot/moves/${mins.id}`, { amount_minor: 8000 });
  eq('民那筆 10,000 → 8,000 回 200', r.status, 200);
  eq('回應就是契約說的兩個欄位', [r.json.id, r.json.amount_minor], [mins.id, 8000]);

  const after = await potOf(c.T);
  eq('投入合計跟著變成 13,000', after.row.contributedMinor, 13000);
  eq('剩餘跟著變成 10,000', after.row.remainingMinor, 10000);
  eq('花掉的沒有被碰到', after.row.spentMinor, 3000);
  eq('每人合計:民 8,000 / 喧 5,000',
    (after.row.contributions as J[]).map((x) => `${c.name(x.memberId)} ${x.amountMinor}`).sort(),
    ['喧 5000', '民 8000']);

  const l1 = await listMoves(c.T);
  eq('清單裡那筆變成 8,000,另一筆沒動', fmt(l1.moves, c), ['in 喧 5000', 'in 民 8000']);
  eq('settled_at 沒有跟著改 —— 改一個打錯的數字不該讓它跳到最上面',
    l1.moves.find((m) => m.id === mins.id)?.settled_at, stamp);
  eq('沒有多寫也沒有少寫任何一列', countSettlements(c.tripId), 2);

  // 退還也要能改。這一側改「大」才是危險的方向(信封的錢變少)。
  eq('公費退還民 ¥1,000 → 201',
    (await moveOut(c.T, [{ member_id: c.id['民'], amount_minor: 1000 }])).status, 201);
  const refund = (await listMoves(c.T)).moves.find((m) => m.direction === 'out')!;
  const up = await patch(`/api/trips/${c.T}/pot/moves/${refund.id}`, { amount_minor: 4000 });
  eq('退還 1,000 → 4,000 回 200', up.status, 200);
  const after2 = await potOf(c.T);
  eq('已退還變成 4,000', after2.row.refundedMinor, 4000);
  eq('剩餘 = 13,000 − 3,000 − 4,000 = 6,000', after2.row.remainingMinor, 6000);
  const down = await patch(`/api/trips/${c.T}/pot/moves/${refund.id}`, { amount_minor: 500 });
  eq('退還改小 → 200', down.status, 200);
  eq('剩餘回到 9,500', (await potOf(c.T)).row.remainingMinor, 9500);
}

// ═══════════════════════════════════════════════════════════════
group('[3] 改到剩餘會變負 → 409,而且資料庫一個字都沒動');
// ═══════════════════════════════════════════════════════════════
//
// 招牌案例:投入 10,000、公費已經花掉 9,000,把投入改成 8,000 → 剩餘 −1,000。
// 「信封裡的錢比實際有的多」沒有現實對應:總覽會據此叫人再退還,
// 而退出去的那 1,000 是憑空生出來的。
{
  const c = await potTrip('P3 剩餘不可為負', [['民', 10000]], 9000);
  const mv = (await listMoves(c.T)).moves[0]!;
  eq('剩餘 1,000', (await potOf(c.T)).row.remainingMinor, 1000);

  const bad = await patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 8000 });
  eq('改成 8,000 → 409', bad.status, 409);
  const msg = String(bad.json.statusMessage ?? '');
  // 斷言的是**使用者實際看到的字串**(含幣別符號與千分位),不是最小單位整數。
  // 這幾條同時在守「訊息的金額有經過 formatMoney」—— 直接內插 amount_minor
  // 的話 TWD 會差 100 倍(NT$1,000.01 存的是 100001),而 overview.vue 是把
  // 這句 statusMessage **原樣**顯示的:「最少只能改到 X」正是使用者要照著打的數字,
  // 印錯的話他會照那個數字再送一次然後再被擋一次。
  check('訊息帶得出「會變成 JP¥-1,000」', msg.includes('會變成 JP¥-1,000'), msg);
  check('訊息說得出現在剩多少', msg.includes('現在是 JP¥1,000'), msg);
  check('訊息說得出最少能改到多少', msg.includes('最少只能改到 JP¥9,000'), msg);

  eq('那一列的金額一個字都沒改到', rowAmount(mv.id), 10000);
  const still = await potOf(c.T);
  eq('投入合計沒變', still.row.contributedMinor, 10000);
  eq('剩餘沒變', still.row.remainingMinor, 1000);

  // 邊界:剛好把剩餘壓到 0 是允許的 —— 信封空了不是壞事,負的才是。
  const edge = await patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 9000 });
  eq('剛好改到剩餘 = 0 → 200', edge.status, 200);
  eq('剩餘 0', (await potOf(c.T)).row.remainingMinor, 0);
  const over = await patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 8999 });
  eq('再少 1 元 → 409', over.status, 409);
  eq('還是 9,000', rowAmount(mv.id), 9000);

  // 退還改大也是同一個不變量的另一個方向。
  const c2 = await potTrip('P3 退還改大', [['民', 10000]], 6000);
  eq('公費退還喧 ¥1,000 → 201',
    (await moveOut(c2.T, [{ member_id: c2.id['喧'], amount_minor: 1000 }])).status, 201);
  const out = (await listMoves(c2.T)).moves.find((m) => m.direction === 'out')!;
  eq('剩餘 3,000', (await potOf(c2.T)).row.remainingMinor, 3000);
  const tooMuch = await patch(`/api/trips/${c2.T}/pot/moves/${out.id}`, { amount_minor: 4001 });
  eq('退還改成 4,001(信封只有 4,000 可退)→ 409', tooMuch.status, 409);
  check('訊息說得出最多能改到 JP¥4,000',
    String(tooMuch.json.statusMessage ?? '').includes('最多只能改到 JP¥4,000'),
    String(tooMuch.json.statusMessage));
  eq('那一列沒被改到', rowAmount(out.id), 1000);
  eq('退還剛好 4,000 → 200',
    (await patch(`/api/trips/${c2.T}/pot/moves/${out.id}`, { amount_minor: 4000 })).status, 200);
  eq('剩餘歸零', (await potOf(c2.T)).row.remainingMinor, 0);
}

// ═══════════════════════════════════════════════════════════════
group('[4] 刪除一筆 —— 剩餘跟著變,刪到變負就擋掉');
// ═══════════════════════════════════════════════════════════════
{
  const c = await potTrip('P4 刪除', [['民', 10000], ['喧', 5000]], 3000);
  const list0 = await listMoves(c.T);
  const hsuan = list0.moves.find((m) => c.name(m.member_id) === '喧')!;

  const d = await del(`/api/trips/${c.T}/pot/moves/${hsuan.id}`);
  eq('刪掉喧那筆 5,000 → 200', d.status, 200);
  eq('回應就是契約說的形狀', [d.json.ok, d.json.deleted], [true, hsuan.id]);
  eq('那一列真的不在了', rowAmount(hsuan.id), null);
  const after = await potOf(c.T);
  eq('投入合計 10,000', after.row.contributedMinor, 10000);
  eq('剩餘 10,000 − 3,000 = 7,000', after.row.remainingMinor, 7000);
  eq('清單只剩民那筆', fmt((await listMoves(c.T)).moves, c), ['in 民 10000']);

  // 刪掉最後一筆投入 → 剩餘會變成 −3,000(公費已經花掉的錢沒有來源了)
  const min = (await listMoves(c.T)).moves[0]!;
  const bad = await del(`/api/trips/${c.T}/pot/moves/${min.id}`);
  eq('刪掉唯一的投入 → 409', bad.status, 409);
  const msg = String(bad.json.statusMessage ?? '');
  check('訊息帶得出「會變成 JP¥-3,000」', msg.includes('會變成 JP¥-3,000'), msg);
  check('訊息也告訴他可以改小到 JP¥3,000(這種時候他要的通常是改不是刪)',
    msg.includes('最少只能改到 JP¥3,000'), msg);
  eq('那一列還在,金額也沒變', rowAmount(min.id), 10000);
  eq('剩餘沒變', (await potOf(c.T)).row.remainingMinor, 7000);

  // 刪退還永遠安全 —— 錢回到信封裡,剩餘只會變大。
  eq('公費退還民 ¥2,000 → 201',
    (await moveOut(c.T, [{ member_id: c.id['民'], amount_minor: 2000 }])).status, 201);
  eq('剩餘先掉到 5,000', (await potOf(c.T)).row.remainingMinor, 5000);
  const out = (await listMoves(c.T)).moves.find((m) => m.direction === 'out')!;
  eq('刪掉那筆退還 → 200', (await del(`/api/trips/${c.T}/pot/moves/${out.id}`)).status, 200);
  eq('剩餘回到 7,000', (await potOf(c.T)).row.remainingMinor, 7000);
  eq('這趟只剩一列', countSettlements(c.tripId), 1);
}

// ═══════════════════════════════════════════════════════════════
group('[5] 動不到的東西一律 404 —— 不透露那個 id 存不存在');
// ═══════════════════════════════════════════════════════════════
{
  const a = await potTrip('P5 甲趟', [['民', 10000]], 0);
  const b = await potTrip('P5 乙趟', [['民', 8000]], 0);
  const inA = (await listMoves(a.T)).moves[0]!;

  eq('不存在的 id → PATCH 404',
    (await patch(`/api/trips/${a.T}/pot/moves/nope-nope`, { amount_minor: 100 })).status, 404);
  eq('不存在的 id → DELETE 404',
    (await del(`/api/trips/${a.T}/pot/moves/nope-nope`)).status, 404);

  // 別趟的 id:WHERE 同時綁 trip_id,所以查不到(理由見 expenses/[id].delete.ts)。
  const cross = await patch(`/api/trips/${b.T}/pot/moves/${inA.id}`, { amount_minor: 100 });
  eq('拿甲趟的 id 去乙趟改 → 404', cross.status, 404);
  eq('甲趟那筆完全沒被動到', rowAmount(inA.id), 10000);
  eq('拿甲趟的 id 去乙趟刪 → 404',
    (await del(`/api/trips/${b.T}/pot/moves/${inA.id}`)).status, 404);
  eq('甲趟那筆還在', rowAmount(inA.id), 10000);

  // 404 要排在 400 前面:改不到的東西,body 對不對沒有意義
  // (順序和 expenses/[id].patch.ts 一致)。
  const both = await patch(`/api/trips/${b.T}/pot/moves/${inA.id}`, { amount_minor: -5 });
  eq('別趟的 id + 不合法的金額 → 404(不是 400)', both.status, 404);

  // 人對人的還款不是公費金流。改得動的話,使用者會從公費的畫面改掉一筆真的債務。
  const c = await mkTrip('P5 人對人', ['民', '喧'], '公費');
  eq('民墊晚餐 ¥4,000 → 201', (await yen(c.T, {
    description: '晚餐', amount: 4000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  const p2p = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 2000,
  });
  eq('喧還民 ¥2,000 → 201', p2p.status, 201);
  eq('拿那筆還款的 id 來改 → 404',
    (await patch(`/api/trips/${c.T}/pot/moves/${p2p.json.id}`, { amount_minor: 1000 })).status, 404);
  eq('拿那筆還款的 id 來刪 → 404',
    (await del(`/api/trips/${c.T}/pot/moves/${p2p.json.id}`)).status, 404);
  eq('那筆還款完好', rowAmount(p2p.json.id), 2000);

  // 結算回合寫的轉帳(source='round')絕對不能被這兩支碰到。
  // 公費的腿本來就不會被寫成 round(ledger.ts 的 deferred 一律不寫入),
  // 所以這一列只能用手動 SQL 注入 —— 而「擋它」正是不依賴那個巧合的意思。
  const injected = 'pot-round-leg-' + Math.random().toString(36).slice(2, 10);
  const ok = d1Write(
    `INSERT INTO settlements (id, trip_id, from_member, to_member, currency, amount_minor, source)
     VALUES (?, ?, ?, ?, 'JPY', 700, 'round')`,
    injected, c.tripId, c.id['公費'], c.id['民']);
  check('注入一列 source=round 的公費腿(模擬未來的結算語意改動)', ok);
  if (ok) {
    eq('它出現在清單裡 —— 那筆錢真的動過信封,藏起來只會讓剩餘對不上',
      (await listMoves(c.T)).moves.filter((m) => m.id === injected).length, 1);
    eq('但改不動 → 404',
      (await patch(`/api/trips/${c.T}/pot/moves/${injected}`, { amount_minor: 100 })).status, 404);
    eq('也刪不掉 → 404', (await del(`/api/trips/${c.T}/pot/moves/${injected}`)).status, 404);
    eq('那一列完好', rowAmount(injected), 700);
  }
}

// ═══════════════════════════════════════════════════════════════
group('[6] 金額不合法 → 400');
// ═══════════════════════════════════════════════════════════════
{
  const c = await potTrip('P6 驗證', [['民', 10000]], 0);
  const mv = (await listMoves(c.T)).moves[0]!;
  const url = `/api/trips/${c.T}/pot/moves/${mv.id}`;

  eq('0 → 400', (await patch(url, { amount_minor: 0 })).status, 400);
  eq('負數 → 400', (await patch(url, { amount_minor: -100 })).status, 400);
  eq('小數 → 400(金額一律整數最小單位)', (await patch(url, { amount_minor: 12.5 })).status, 400);
  eq('字串 → 400', (await patch(url, { amount_minor: '5000' })).status, 400);
  eq('缺欄位 → 400', (await patch(url, {})).status, 400);
  eq('五次都被擋下來之後,那一列還是 10,000', rowAmount(mv.id), 10000);
}

// ═══════════════════════════════════════════════════════════════
group('[7] 改公費金流**完全不影響**人對人的淨額');
// ═══════════════════════════════════════════════════════════════
//
// 使用者的模型:「A 先墊錢,但就是 A 墊錢,跟公費沒關係,不會變多,不會變少,
// 也跟 A 拿出多少公費沒關係。」(見 server/utils/ledger.ts 開頭的兩本帳)
//
// 所以把一筆投入從 30,000 改成 9,000,**結算頁要一動也不動** ——
// 動了就代表信封那一本污染了人對人那一本,而症狀是某個人的欠款
// 莫名多出或少掉一截,畫面上完全找不到出處。
//
// 這一組同時守另一半:公費**付掉**的支出也不進算術。
// 下面那筆「公費付早餐 6,000」對三個人的淨額一毛影響都沒有。
{
  const c = await mkTrip('P7 淨額不受公費影響', ['民', '喧'], '公費');
  eq('民墊晚餐 ¥20,000 兩人均分 → 201', (await yen(c.T, {
    description: '晚餐', amount: 20000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('公費付早餐 ¥6,000 兩人均分 → 201', (await yen(c.T, {
    description: '早餐', amount: 6000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('民投入公費 ¥30,000 → 201',
    (await moveIn(c.T, [{ member_id: c.id['民'], amount_minor: 30000 }])).status, 201);

  const b0 = await potOf(c.T);
  const n0 = netsOf(b0.bal);
  const t0 = transfersOf(b0.bal, c);
  // 民:墊 20,000 − 分攤 10,000 = +10,000。**公費付的 6,000 和投入的 30,000 都不在裡面。**
  eq('淨額只反映「民墊的那一筆」:民 +10,000 / 喧 −10,000',
    [n0.get(c.id['民']), n0.get(c.id['喧'])], [10000, -10000]);
  check('公費不在淨額裡', !n0.has(c.id['公費']), JSON.stringify([...n0]));
  eq('recorded:喧→民 ¥10,000', t0, ['喧→民 10000']);
  eq('信封餘額 30,000 − 6,000 = 24,000', b0.row.remainingMinor, 24000);

  // ── 核心:動信封,人對人那一本逐位元不變 ───────────────────────
  const mv = (await listMoves(c.T)).moves[0]!;
  eq('把投入從 30,000 改成 9,000 → 200',
    (await patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 9000 })).status, 200);

  const b1 = await potOf(c.T);
  eq('淨額**逐位元**不變',
    JSON.stringify(b1.bal.by_currency?.JPY?.nets ?? []),
    JSON.stringify(b0.bal.by_currency?.JPY?.nets ?? []));
  eq('轉帳建議一模一樣', transfersOf(b1.bal, c), t0);
  eq('變的只有信封:9,000 − 6,000 = 3,000', b1.row.remainingMinor, 3000);

  // 退還同理 —— 「只處理投入、忘了處理退還」是這一類最容易犯的錯。
  eq('公費退還民 ¥1,000 → 201',
    (await moveOut(c.T, [{ member_id: c.id['民'], amount_minor: 1000 }])).status, 201);
  const b2 = await potOf(c.T);
  eq('退還之後淨額還是逐位元不變',
    JSON.stringify(b2.bal.by_currency?.JPY?.nets ?? []),
    JSON.stringify(b0.bal.by_currency?.JPY?.nets ?? []));
  eq('信封降到 2,000', b2.row.remainingMinor, 2000);

  eq('刪掉那筆投入 → 409(剩餘會變 −7,000)',
    (await del(`/api/trips/${c.T}/pot/moves/${mv.id}`)).status, 409);
  const b3 = await potOf(c.T);
  eq('被擋下來之後淨額也沒動',
    JSON.stringify(b3.bal.by_currency?.JPY?.nets ?? []),
    JSON.stringify(b0.bal.by_currency?.JPY?.nets ?? []));
  eq('剩餘也沒動', b3.row.remainingMinor, 2000);
}

// ═══════════════════════════════════════════════════════════════
group('[8] 併發:兩支同時動公費,不能雙雙成功而讓剩餘變負');
// ═══════════════════════════════════════════════════════════════
//
// ⚠️ 這一組是**唯一**驗得出資料庫層那道前提存在的地方。
//
// JS 那個 if 和 SQL 那句 WHERE 算的是同一個數字,所以循序打 API 永遠先撞 JS ——
// 把 SQL 那道整段刪掉,上面 [3] [4] 兩組還是會全綠。要分開它們就必須讓
// 兩支請求**同時**通過 JS 檢查:各自看起來都還在剩餘之內,加起來把信封挖穿。
//
// (這個 repo 上一次就是這樣漏掉的,見 test/api.concurrency.test.ts 開頭。)
{
  // ── (a) 兩支同時改**同一筆** ────────────────────────────────
  // 這種其實是安全的(兩支寫的是同一列,結果只會是其中一個值),
  // 但它是使用者最容易做出來的動作 —— 兩支手機看著同一個畫面按下儲存。
  // 要斷言的是「不管誰贏,資料庫裡是其中一個值,而且剩餘沒有變負」。
  {
    const c = await potTrip('P8a 同一筆', [['民', 10000]], 6000);
    const mv = (await listMoves(c.T)).moves[0]!;
    const url = `/api/trips/${c.T}/pot/moves/${mv.id}`;
    const pair = await Promise.all([
      patch(url, { amount_minor: 7000 }),
      patch(url, { amount_minor: 8000 }),
    ]);
    check('至少一支成功', pair.some((r) => r.status === 200),
      JSON.stringify(pair.map((r) => r.status)));
    const amt = rowAmount(mv.id);
    check('資料庫裡是其中一個值(不是兩個相加、也不是被改成別的)',
      amt === 7000 || amt === 8000, `got ${amt}`);
    const row = (await potOf(c.T)).row;
    eq('剩餘 = 那個值 − 6,000', row.remainingMinor, (amt ?? 0) - 6000);
    check('剩餘沒有變負', (row.remainingMinor ?? 0) >= 0, JSON.stringify(row));
  }

  // ── (b) 兩支同時把**不同的兩筆**投入改小 ─────────────────────
  //
  // 投入 民 5,000 + 喧 5,000、公費花掉 9,000 → 剩餘 1,000。
  // 兩支各把自己那筆改小 800:各自算起來剩餘還有 200,都過得了 JS;
  // 兩支都寫進去的話剩餘變成 −600 —— 信封裡的錢比實際有的多 600。
  {
    const ROUNDS = 8;
    let negative = 0, bothOk = 0, sqlBlocked = 0;
    const outcomes: Record<string, number> = {};

    for (let k = 0; k < ROUNDS; k++) {
      const c = await potTrip('P8b 兩筆同時改小', [['民', 5000], ['喧', 5000]], 9000);
      const l = await listMoves(c.T);
      const a = l.moves.find((m) => c.name(m.member_id) === '民')!;
      const b = l.moves.find((m) => c.name(m.member_id) === '喧')!;

      const pair = await Promise.all([
        patch(`/api/trips/${c.T}/pot/moves/${a.id}`, { amount_minor: 4200 }),
        patch(`/api/trips/${c.T}/pot/moves/${b.id}`, { amount_minor: 4200 }),
      ]);
      const key = pair.map((r) => r.status).sort().join('/');
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (pair.every((r) => r.status === 200)) bothOk++;
      // 兩道防線的訊息不一樣,所以「是誰擋的」看得出來。
      // 「這一瞬間」= 走到了 UPDATE 才被前提擋掉 = 兩支都通過了 JS。
      if (pair.some((r) => r.status === 409
        && String(r.json.statusMessage ?? '').includes('這一瞬間'))) sqlBlocked++;

      const row = (await potOf(c.T)).row;
      if ((row.remainingMinor ?? 0) < 0) negative++;
    }

    eq(`${ROUNDS} 次同時改小,剩餘從未變成負的`, negative, 0);
    eq('兩支從未雙雙成功', bothOk, 0);
    // 這一條是在守「測試本身有效」:如果每次都是 JS 先擋掉一支,
    // 上面兩條在 SQL 那道被刪掉的情況下照樣全綠。
    check('至少一次是由資料庫層那道前提擋下來的(兩支都通過了 JS 檢查)',
      sqlBlocked > 0, `sqlBlocked=${sqlBlocked}/${ROUNDS}, 狀態組合: ${JSON.stringify(outcomes)}`);
  }

  // ── (c) 一支改小、一支刪除 ──────────────────────────────────
  //
  // 投入 民 5,000 + 喧 800、公費花掉 4,800 → 剩餘 1,000。
  // 改小 800 和刪掉那筆 800 各自都留下 200,一起發生就是 −600。
  // 兩支是**不同的端點**,所以這一組同時證明兩句 SQL 的前提算的是同一個數。
  {
    const ROUNDS = 8;
    let negative = 0, bothOk = 0, sqlBlocked = 0;
    const outcomes: Record<string, number> = {};

    for (let k = 0; k < ROUNDS; k++) {
      const c = await potTrip('P8c 改小加刪除', [['民', 5000], ['喧', 800]], 4800);
      const l = await listMoves(c.T);
      const a = l.moves.find((m) => c.name(m.member_id) === '民')!;
      const b = l.moves.find((m) => c.name(m.member_id) === '喧')!;

      const pair = await Promise.all([
        patch(`/api/trips/${c.T}/pot/moves/${a.id}`, { amount_minor: 4200 }),
        del(`/api/trips/${c.T}/pot/moves/${b.id}`),
      ]);
      const key = pair.map((r) => r.status).sort().join('/');
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (pair.every((r) => r.status === 200)) bothOk++;
      if (pair.some((r) => r.status === 409
        && String(r.json.statusMessage ?? '').includes('這一瞬間'))) sqlBlocked++;

      const row = (await potOf(c.T)).row;
      if ((row.remainingMinor ?? 0) < 0) negative++;
      // 被擋下來的那一支必須是真的什麼都沒做:剩餘要能由現存的列完全解釋。
      const cur = (row.contributedMinor ?? 0) - (row.spentMinor ?? 0) - (row.refundedMinor ?? 0);
      if (cur !== row.remainingMinor) negative++;
    }

    eq(`${ROUNDS} 次「一支改小 + 一支刪除」,剩餘從未變成負的`, negative, 0);
    eq('兩支從未雙雙成功', bothOk, 0);
    check('至少一次是由資料庫層那道前提擋下來的(兩支都通過了 JS 檢查)',
      sqlBlocked > 0, `sqlBlocked=${sqlBlocked}/${ROUNDS}, 狀態組合: ${JSON.stringify(outcomes)}`);
  }

  // ── (d) 一支改小投入、一支同時退還 ──────────────────────────
  //
  // 這一組跨到 pot/moves.post:那支也有自己的 SQL 前提。
  // 兩支加起來一樣可以把信封挖穿,而擋住它的是「兩邊算的是同一個剩餘」。
  {
    const ROUNDS = 6;
    let negative = 0, bothOk = 0;

    for (let k = 0; k < ROUNDS; k++) {
      const c = await potTrip('P8d 改小加退還', [['民', 5000]], 4000);
      const mv = (await listMoves(c.T)).moves[0]!;
      // 剩餘 1,000:改小 800 之後剩 200,同時退還 800 也只剩 200,兩個都過得了 JS。
      const pair = await Promise.all([
        patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 4200 }),
        moveOut(c.T, [{ member_id: c.id['喧'], amount_minor: 800 }]),
      ]);
      if (pair[0].status === 200 && pair[1].status === 201) bothOk++;
      const row = (await potOf(c.T)).row;
      if ((row.remainingMinor ?? 0) < 0) negative++;
    }

    eq(`${ROUNDS} 次「改小投入 + 同時退還」,剩餘從未變成負的`, negative, 0);
    eq('兩支從未雙雙成功', bothOk, 0);
  }
}

// ═══════════════════════════════════════════════════════════════
group('[9] 公費超支之後,修正帳的那些編輯不可以被鎖死');
// ═══════════════════════════════════════════════════════════════
//
// 判準是「不可以讓剩餘變得更差」,不是「剩餘不可為負」(見 utils/pot.ts 的
// blocksPotEdit)。這個差別只在**超支狀態**才看得出來,而超支是到得了的:
// server 沒有任何一支端點擋「公費付掉的共同支出 > 投入」。
//
// 用絕對值判的話,擋掉的正好是唯一能把帳修回事實的那些編輯 ——
// 而淨額現在含投入 / 退還,被凍結的那一列等於在某個人身上掛一筆拔不掉的假債務。
{
  // ── (a) 投入記太少,想改大 ──────────────────────────────────
  const c = await mkTrip('P9 超支後改大投入', ['民', '喧'], '公費');
  // 兩個人其實各拿了 ¥10,000 出來,但只記了民的、而且打成 ¥5,000
  eq('民投入 ¥5,000(其實是 10,000,打錯了)→ 201',
    (await moveIn(c.T, [{ member_id: c.id['民'], amount_minor: 5000 }])).status, 201);
  eq('公費付包車 ¥15,000 兩人均分 → 201', (await yen(c.T, {
    description: '包車', amount: 15000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const before = await potOf(c.T);
  eq('公費現在超支 ¥10,000', before.row.remainingMinor, -10000);
  // 超支是信封那一本的狀態,人對人那一本完全不知道它的存在 ——
  // 這一趟沒有人自己墊過錢,所以結算頁是空的。
  check('公費不在淨額裡', !netsOf(before.bal).has(c.id['公費']),
    JSON.stringify([...netsOf(before.bal)]));
  eq('人對人那一本是空的(沒有人自己墊過)', netsOf(before.bal).size, 0);

  const mv = (await listMoves(c.T)).moves[0]!;
  // 核心斷言:改成事實(10,000)之後剩餘還是負的(−5,000),但它**變好了** → 必須放行。
  const fix = await patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 10000 });
  eq('把投入改成正確的 ¥10,000 → 200(剩餘仍是負的,但缺口變小了)', fix.status, 200);
  eq('那一列真的改到了', rowAmount(mv.id), 10000);

  const after = await potOf(c.T);
  eq('剩餘從 −10,000 回到 −5,000(缺口變小了)', after.row.remainingMinor, -5000);
  eq('人對人那一本一個字都沒動', netsOf(after.bal).size, 0);

  // 反方向仍然要擋:把投入改小會讓缺口更大。
  const worse = await patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 3000 });
  eq('把投入改小 → 409(這一步讓缺口更大)', worse.status, 409);
  eq('被擋掉就是一個字都沒改', rowAmount(mv.id), 10000);
  // 訊息不可以叫他去填一個比事實大的假數字(bound 要 clamp 到舊金額)。
  const msg = String(worse.json.statusMessage ?? '');
  // 訊息裡出現 JP¥15,000 是合理的(那是「公費已經花掉多少」的脈絡),
  // 要盯的是**他要照著打的那個數字**:下限必須 clamp 到舊金額,不能是
  // 未 clamp 的「舊金額 − 剩餘」= 25,000 —— 照那個填就是記一筆假投入,
  // 而投入直接進淨額,那筆錢會變成他真的可以跟別人收的錢。
  check('下限 clamp 成舊金額 JP¥10,000',
    /只能往上改\(最少 JP¥10,000\)/.test(msg), msg);
  check('下限不是未 clamp 的 JP¥25,000', !msg.includes('JP¥25,000'), msg);
}

{
  // ── (b) 誤記的退還,超支之後還是要刪得掉 ─────────────────────
  //
  // 這是更硬的一種:刪除 = 改成 0,而退還方向「改成 0」比任何正數都讓剩餘更大。
  // 所以刪除一旦被擋,**沒有任何合法輸入動得了那一列** —— 它被永久凍結。
  const c = await mkTrip('P9 超支後刪退還', ['民', '喧'], '公費');
  eq('民投入 ¥10,000 → 201',
    (await moveIn(c.T, [{ member_id: c.id['民'], amount_minor: 10000 }])).status, 201);
  eq('誤記一筆「公費退還民 ¥4,000」(其實沒發生)→ 201',
    (await moveOut(c.T, [{ member_id: c.id['民'], amount_minor: 4000 }])).status, 201);
  eq('公費付包車 ¥15,000 兩人均分 → 201', (await yen(c.T, {
    description: '包車', amount: 15000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const before = await potOf(c.T);
  eq('公費超支 ¥9,000', before.row.remainingMinor, -9000);
  // 那筆從沒發生的退還只弄壞信封的餘額(少了 4,000),人對人那一本不受影響。
  // 但餘額錯了一樣要命:總覽會據此叫人再投入,而那是他不欠的錢。
  eq('人對人那一本是空的', netsOf(before.bal).size, 0);

  const out = (await listMoves(c.T)).moves.find((m) => m.direction === 'out')!;
  const gone = await del(`/api/trips/${c.T}/pot/moves/${out.id}`);
  eq('刪掉那筆從沒發生的退還 → 200(刪退還永遠安全)', gone.status, 200);
  eq('那一列真的不在了', rowAmount(out.id), null);

  const after = await potOf(c.T);
  eq('剩餘從 −9,000 回到 −5,000(那 4,000 回到信封裡)', after.row.remainingMinor, -5000);
  eq('人對人那一本還是空的', netsOf(after.bal).size, 0);
}

{
  // ── (c) 剩餘 ≥ 0 時行為完全沒變 ─────────────────────────────
  // 換判準最怕的是把既有的防護一起放寬掉。這一組釘住「沒有超支的時候,
  // 舊的那條規則一字不改」。
  const c = await potTrip('P9 沒超支時照舊擋', [['民', 10000]], 9000);
  eq('剩餘 ¥1,000', (await potOf(c.T)).row.remainingMinor, 1000);
  const mv = (await listMoves(c.T)).moves[0]!;
  eq('把投入改成 8,000(剩餘會變 −1,000)→ 409',
    (await patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 8000 })).status, 409);
  eq('那一列沒被改到', rowAmount(mv.id), 10000);
  eq('改成 9,000(剩餘剛好 0)→ 200',
    (await patch(`/api/trips/${c.T}/pot/moves/${mv.id}`, { amount_minor: 9000 })).status, 200);
  eq('剩餘歸零', (await potOf(c.T)).row.remainingMinor, 0);
}

// ═══════════════════════════════════════════════════════════════
group('[10] 退還走 /settlements 也要有資料庫層的上限');
// ═══════════════════════════════════════════════════════════════
//
// pot/moves.post.ts 的退還早就有 SQL 前提,settlements.post.ts 卻是無條件 INSERT ——
// 同一筆錢換一支端點打就繞過去了。
//
// 淨額含投入 / 退還之後這個縫從「顯示問題」升級成算錯錢:
// 多寫的那一列直接把收款人的淨額往下打,而配對出來的腿有一條**兩端都是真人**
// → 落在 recorded → 結算回合會把它寫成真實的 settlements。
{
  const c = await mkTrip('P10 退還上限', ['民', '喧'], '公費');
  eq('民投入 ¥10,000 → 201',
    (await moveIn(c.T, [{ member_id: c.id['民'], amount_minor: 10000 }])).status, 201);

  const refund = (amount: number) => post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['公費'], to_member: c.id['喧'], currency: 'JPY', amount_minor: amount,
  });

  // 循序:JS 那道會先擋。這一發只證明上限存在,證明不了它在資料庫層。
  eq('循序超額退還 ¥10,001 → 400', (await refund(10001)).status, 400);
  eq('一列都沒寫', countSettlements(c.tripId), 1);

  // ⚠️ 併發才驗得出 SQL 那道。兩支都會讀到「剛好還夠」,JS 兩邊都放行 ——
  // 沒有 SQL 前提的話兩筆都會寫進去。
  const pair = await Promise.all([refund(10000), refund(10000)]);
  const ok = pair.filter((r) => r.status === 201).length;
  eq('兩支同時退還「剛好等於全部餘額」→ 只有一支成功', ok, 1);
  eq('settlements 只多一列(投入 + 一筆退還)', countSettlements(c.tripId), 2);

  const after = await potOf(c.T);
  eq('剩餘歸零,沒有變成負的', after.row.remainingMinor, 0);
  /*
    重複退還的症狀在**信封**那一本:剩餘會變成 −10,000 —— 信封付出去的
    比它手上有的多 10,000,而那 10,000 是憑空生出來的現金。
    (退還不進淨額,所以人對人那一本看不出差別 —— 這也是為什麼上面那兩條
     `remainingMinor` 的斷言才是這一組真正的守門,而不是看轉帳建議。)
  */
  eq('投入合計還是 ¥10,000', after.row.contributedMinor, 10000);
  eq('退還合計就是那一筆 ¥10,000(不是 20,000)', after.row.refundedMinor, 10000);
  eq('人對人那一本沒有被波及(這一趟沒有共同支出)', netsOf(after.bal).size, 0);
}

process.exit(summary() > 0 ? 1 : 0);
