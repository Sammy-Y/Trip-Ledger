/**
 * API 整合測試。打真實的 dev server + 真實的本機 D1,不 mock。
 *
 * 用法:先 `pnpm dev`,再
 *   node --experimental-strip-types test/api.test.ts [baseUrl]
 * 預設會自動從 dev server 的 log 或常見 port 找。
 *
 * 這支測的是「單元測試抓不到」的東西:server 端驗證、SQL 聚合、
 * 多幣別是否真的分開結算、以及刪除/還款會不會正確反映到餘額。
 */
import { group, check, eq, summary } from './_harness.ts';
import { loginFixture } from './_session.ts';

const BASE = process.argv[2] || process.env.BASE_URL || '';

async function findBase(): Promise<string | null> {
  const cands = BASE ? [BASE] : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
  for (const b of cands) {
    try {
      const r = await fetch(`${b}/api/trips/__probe__`, { signal: AbortSignal.timeout(3000) });
      // 404 = 路由活著但 token 不存在,正是我們要的訊號
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
const session = await loginFixture(base, 'api');
const req = session.req;
const get = (p: string) => req('GET', p);
const post = (p: string, b?: unknown) => req('POST', p, b);
const del = (p: string) => req('DELETE', p);

// ── 前置:確保有匯率,否則換算欄位會是 null ──
await post('/api/admin/sync-rates');

group('[建立] 旅程與成員');
const created = await post('/api/trips', {
  name: `測試 ${Date.now()}`, base_currency: 'TWD', members: ['民', '喧', '公'],
});
eq('POST /api/trips → 201', created.status, 201);
check('回傳 share_token', typeof created.json.share_token === 'string' && created.json.share_token.length > 10);
const T = created.json.share_token;

const tripRes = await get(`/api/trips/${T}`);
eq('GET trip → 200', tripRes.status, 200);
eq('三位成員', tripRes.json.members?.length, 3);
const id: Record<string, string> = {};
for (const m of tripRes.json.members ?? []) id[m.name] = m.id;
check('成員 id 都取到了', !!(id['民'] && id['喧'] && id['公']));

group('[驗證] server 必須擋掉不合法的支出');
const badNoPayer = await post(`/api/trips/${T}/expenses`, {
  kind: 'shared', description: '沒有付款人', currency: 'JPY', amount: 1000,
  spent_at: '2026-03-08', payers: [],
  split: { mode: 'equal', members: [id['民']] },
});
eq('沒有付款人 → 400', badNoPayer.status, 400);

const badShareSum = await post(`/api/trips/${T}/expenses`, {
  kind: 'shared', description: '分攤合計不符', currency: 'JPY', amount: 1000,
  spent_at: '2026-03-08', payers: [{ member_id: id['民'] }],
  split: { mode: 'exact', amounts: { [id['民']]: 400, [id['喧']]: 400 } },  // 800 ≠ 1000
});
eq('分攤合計不符 → 400', badShareSum.status, 400);
check('錯誤訊息說明差額', /不符|8\d\d/.test(JSON.stringify(badShareSum.json)),
  JSON.stringify(badShareSum.json).slice(0, 120));

const badPayerSum = await post(`/api/trips/${T}/expenses`, {
  kind: 'shared', description: '付款合計不符', currency: 'JPY', amount: 1000,
  spent_at: '2026-03-08',
  payers: [{ member_id: id['民'], amount: 300 }, { member_id: id['喧'], amount: 300 }],  // 600 ≠ 1000
  split: { mode: 'equal', members: [id['民'], id['喧']] },
});
eq('付款合計不符 → 400', badPayerSum.status, 400);

eq('不存在的 token → 404', (await get('/api/trips/nope-nope-nope')).status, 404);

group('[記帳] 三種分攤模式（用 Excel 真實數字）');
const e1 = await post(`/api/trips/${T}/expenses`, {
  kind: 'shared', description: '3/8 吃飯', currency: 'JPY', amount: 13244,
  payment_method: 'cash', spent_at: '2026-03-08',
  payers: [{ member_id: id['民'] }],
  split: { mode: 'equal', members: [id['民'], id['喧'], id['公']] },
});
eq('均分 13244 → 201', e1.status, 201);
check('回傳 fx_rate（不是 null）', typeof e1.json.fx_rate === 'number', String(e1.json.fx_rate));

const e2 = await post(`/api/trips/${T}/expenses`, {
  kind: 'shared', description: '伊藤久右衛門', currency: 'JPY', amount: 6274,
  payment_method: 'card', spent_at: '2026-03-09',
  payers: [{ member_id: id['喧'] }],
  split: { mode: 'exact', amounts: { [id['民']]: 3857, [id['喧']]: 2417 } },
});
eq('指定金額 3857/2417 → 201', e2.status, 201);

const e3 = await post(`/api/trips/${T}/expenses`, {
  kind: 'shared', description: '住宿', currency: 'TWD', amount: 6633,
  payment_method: 'card', spent_at: '2026-03-08',
  payers: [{ member_id: id['公'] }],
  split: { mode: 'shares', shares: { [id['民']]: 1, [id['喧']]: 1, [id['公']]: 1 } },
});
eq('按份數（台幣）→ 201', e3.status, 201);

const e4 = await post(`/api/trips/${T}/expenses`, {
  kind: 'personal', description: '北臉紫標後背包', currency: 'JPY', amount: 25000,
  payment_method: 'card', spent_at: '2026-03-10',
  payers: [{ member_id: id['民'] }],
  split: { mode: 'exact', amounts: { [id['民']]: 25000 } },
});
eq('個人花費 → 201', e4.status, 201);

group('[列表] GET expenses');
const all = await get(`/api/trips/${T}/expenses`);
eq('列出全部 → 200', all.status, 200);
eq('共 4 筆', Array.isArray(all.json) ? all.json.length : (all.json as any).length, 4);
const first = (all.json as any)[0];
check('每筆帶 payers', Array.isArray(first?.payers) && first.payers.length > 0);
check('每筆帶 shares', Array.isArray(first?.shares) && first.shares.length > 0);

const onlyShared = await get(`/api/trips/${T}/expenses?kind=shared`);
eq('kind=shared 過濾出 3 筆', (onlyShared.json as any).length, 3);
const onlyPersonal = await get(`/api/trips/${T}/expenses?kind=personal`);
eq('kind=personal 過濾出 1 筆', (onlyPersonal.json as any).length, 1);

group('[結算] 核心不變量');
const bal = await get(`/api/trips/${T}/balance`);
eq('GET balance → 200', bal.status, 200);
const byCur = bal.json.by_currency ?? {};

check('日幣與台幣是分開的兩個 key（絕不相加）',
  'JPY' in byCur && 'TWD' in byCur, JSON.stringify(Object.keys(byCur)));

for (const [cur, blk] of Object.entries<any>(byCur)) {
  const netSum = blk.nets.reduce((s: number, n: any) => s + n.netMinor, 0);
  eq(`${cur} 淨額總和為 0`, netSum, 0);

  check(`${cur} 轉帳筆數 <= n-1`,
    blk.transfers.length <= Math.max(0, blk.nets.length - 1),
    `${blk.transfers.length} vs ${blk.nets.length - 1}`);

  // 套用所有轉帳後，每個人都應該歸零
  const after = new Map<string, number>(blk.nets.map((n: any) => [n.memberId, n.netMinor]));
  for (const t of blk.transfers) {
    after.set(t.from, (after.get(t.from) ?? 0) + t.amountMinor);
    after.set(t.to, (after.get(t.to) ?? 0) - t.amountMinor);
  }
  check(`${cur} 套用轉帳後全部歸零`, [...after.values()].every((v) => v === 0),
    JSON.stringify([...after.entries()]));

  check(`${cur} 轉帳金額都是正數`, blk.transfers.every((t: any) => t.amountMinor > 0));
}

// 個人花費不可以進入結算。
// 注意:13244 除以 3 除不盡(4414.67),所以是「兩人 4415、一人 4414」,
// 而餘數給誰取決於 splitEqually 依 memberId(隨機 UUID)排序的結果 ——
// 每次跑都不一樣。所以這裡只能斷言「不隨排序改變」的性質,不能寫死某人的數字。
const jpyNet = new Map<string, number>((byCur.JPY?.nets ?? []).map((n: any) => [n.memberId, n.netMinor]));

// 民墊 13244、分攤(自己的均分份額 + 伊藤 3857);喧墊 6274、分攤(均分份額 + 2417);公只有均分份額。
// 三人的均分份額必為 {4415, 4415, 4414} 的某個排列。
const meal = [id['民'], id['喧'], id['公']].map((m) => {
  // 由淨額反推該人的均分份額
  if (m === id['民']) return 13244 - 3857 - (jpyNet.get(m) ?? 0);
  if (m === id['喧']) return 6274 - 2417 - (jpyNet.get(m) ?? 0);
  return -(jpyNet.get(m) ?? 0);
}).sort((a, b) => a - b);
eq('均分份額為 {4414, 4415, 4415}', meal, [4414, 4415, 4415]);
check('三人份額合計 = 13244', meal.reduce((a, b) => a + b, 0) === 13244, String(meal));

// 個人花費(背包 25000)若污染結算,民的淨額會多出 25000 這個量級
check('個人花費未進入結算(民的淨額在 4972±1)',
  Math.abs((jpyNet.get(id['民']) ?? 0) - 4972) <= 1, String(jpyNet.get(id['民'])));
check('三人淨額都在合理量級(無 25000 汙染)',
  [...jpyNet.values()].every((v) => Math.abs(v) < 6000), JSON.stringify([...jpyNet.values()]));

group('[每人總花費] 共同分攤 + 個人');
const pm = bal.json.per_member ?? {};
const minPm = pm[id['民']];
check('民有 per_member 資料', !!minPm, JSON.stringify(Object.keys(pm)));
if (minPm) {
  check('民的個人花費 > 0（背包那筆）', minPm.personalBase > 0, String(minPm.personalBase));
  eq('total = shared + personal', minPm.totalBase, minPm.sharedOwedBase + minPm.personalBase);
  eq('沒有無法換算的筆數', minPm.unconverted, 0);
}
check('喧的個人花費為 0', (pm[id['喧']]?.personalBase ?? -1) === 0, String(pm[id['喧']]?.personalBase));

group('[揭露] 必要的說明文字');
check('有 disclaimer（估算值說明）', typeof bal.json.disclaimer === 'string' && bal.json.disclaimer.length > 10);
check('有 rate_attribution（匯率來源標註，授權要求）',
  typeof bal.json.rate_attribution === 'string' && /Exchange Rate API/i.test(bal.json.rate_attribution));

group('[還款] settlements 要能減少餘額');
// 用 balance 實際算出來的轉帳金額,不要自己猜 —— 猜錯會變成多還/少還,
// 後面的斷言就會連環失敗(這正是這支測試上一版的 bug)。
const jpyBlock = bal.json.by_currency?.JPY;
const firstTransfer = jpyBlock?.transfers?.[0];
check('日幣有轉帳建議可以測', !!firstTransfer, JSON.stringify(jpyBlock?.transfers));

const beforeCount = jpyBlock?.transfers?.length ?? 0;
const settle = await post(`/api/trips/${T}/settlements`, {
  from_member: firstTransfer.from, to_member: firstTransfer.to,
  currency: 'JPY', amount_minor: firstTransfer.amountMinor,
});
check('POST settlements 成功', settle.status === 200 || settle.status === 201, String(settle.status));

const bal2 = await get(`/api/trips/${T}/balance`);
const jpy2 = new Map<string, number>((bal2.json.by_currency?.JPY?.nets ?? []).map((n: any) => [n.memberId, n.netMinor]));
eq('還款者淨額歸零', jpy2.get(firstTransfer.from) ?? 0, 0);
eq('還款後轉帳少一筆', bal2.json.by_currency?.JPY?.transfers?.length, beforeCount - 1);
eq('還款後淨額總和仍為 0', [...jpy2.values()].reduce((a, b) => a + b, 0), 0);

group('[刪除] DELETE 要反映到餘額');
const delRes = await del(`/api/trips/${T}/expenses/${e2.json.id}`);
check('DELETE 成功', delRes.status === 200 || delRes.status === 204, String(delRes.status));

const bal3 = await get(`/api/trips/${T}/balance`);
const jpy3 = new Map<string, number>((bal3.json.by_currency?.JPY?.nets ?? []).map((n: any) => [n.memberId, n.netMinor]));
eq('刪除後淨額總和仍為 0', [...jpy3.values()].reduce((a, b) => a + b, 0), 0);
// 伊藤那筆(喧墊款 6274,分攤 民 3857 / 喧 2417)。
// 民在這筆是「分攤方」——他欠 3857。刪掉這筆等於免除這筆債,
// 所以民的淨額要「上升」3857(不是下降,方向很容易寫反)。
const beforeMin = jpy2.get(id['民']) ?? 0, afterMin = jpy3.get(id['民']) ?? 0;
eq('刪除伊藤後民的淨額上升 3857（他不再欠這筆）', afterMin - beforeMin, 3857);
// 喧在這筆是「墊款方」——他墊 6274 但自己只用 2417,淨賺 3857 的債權。
// 刪掉後這個債權消失,喧的淨額要「下降」3857。
const beforeH = jpy2.get(id['喧']) ?? 0, afterH = jpy3.get(id['喧']) ?? 0;
eq('刪除伊藤後喧的淨額下降 3857（他不再有這筆債權）', beforeH - afterH, 3857);
eq('刪除後仍剩 3 筆支出', ((await get(`/api/trips/${T}/expenses`)).json as any).length, 3);
eq('刪除不存在的支出 → 404', (await del(`/api/trips/${T}/expenses/00000000-0000-0000-0000-000000000000`)).status, 404);

group('[預約] reservations');
const r1 = await post(`/api/trips/${T}/reservations`, {
  name: '空蟬亭', url: 'https://www.tablecheck.com/shops/karasemitei/reserve',
  opens_at_utc: '2026-10-01 03:00:00', remind_before_min: 10, note: '每月1號12:00(JST)開放',
});
check('新增預約成功', r1.status === 200 || r1.status === 201, String(r1.status));
const rlist = await get(`/api/trips/${T}/reservations`);
eq('列出預約 → 200', rlist.status, 200);
check('至少一筆預約', (rlist.json as any)?.length >= 1, JSON.stringify(rlist.json).slice(0, 150));

process.exit(summary() > 0 ? 1 : 0);
