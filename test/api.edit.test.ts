/**
 * 編輯支出(PATCH /api/trips/:trip/expenses/:id)的 API 整合測試。
 * 打真實 dev server + 真實本機 D1,不 mock。
 *
 *   pnpm dev            # 另一個終端
 *   node --experimental-strip-types test/api.edit.test.ts
 *
 * ══ 這支測試在防守什麼 ═══════════════════════════════════════════
 *
 * 編輯是**第二條寫入路徑**。新增那條已經被 api.test / api.features 守得很緊,
 * 但那些守衛對 PATCH 一條都不生效 —— 所以這裡的重點不是「PATCH 會不會動」,
 * 而是「PATCH 有沒有把新增那條路徑上的每一個保證都重新做一次」:
 *
 *   ① **整筆取代真的乾淨**:equal → exact 之後,原本那個人的 share 列
 *      不能還留在資料庫裡。留著的話合計仍然對得上(新的那批是守恆的),
 *      但那個人會憑空多欠一筆,而畫面上完全看不出來。
 *   ② **驗證失敗時資料庫一個字都沒動**(這條最重要)。編輯的失敗情境
 *      比新增危險得多:新增失敗只是「沒記到」,編輯失敗如果寫了一半,
 *      留下的是一筆**已經存在、正在被結算採用**的壞帳。
 *   ③ **匯率 snapshot 動得剛剛好**。改了日期或幣別就要重抓 ——
 *      沿用舊匯率會在新幣別上掛一個對不上任何一天的數字;
 *      但只改說明就**不准動**,否則改一個錯字會讓那筆帳的台幣金額跟著跳
 *      (第 13 組;「同一筆帳今天看和明天看要是同一個數字」)。
 *   ④ **蓋章的支出不給改**,而撤銷結算之後可以。
 *   ⑤ **created_at 不動**。它是「什麼時候被記下來」,改錯字不該讓那筆
 *      跳到列表最上面。
 *
 * 每一組都自己建一趟新旅程 —— 餘額是「整趟」的概念,
 * 組跟組之間共用旅程的話,前一組留下的帳會污染下一組的數字。
 */
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
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
async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: J }> {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: J = {};
  const txt = await r.text();
  try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, json };
}
const get = (p: string) => req('GET', p);
const post = (p: string, b?: unknown) => req('POST', p, b);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);
const del = (p: string) => req('DELETE', p);

// 沒有匯率的話 fx 欄位全是 null,第 3、4 組就什麼都證明不了。
await post('/api/admin/sync-rates');

// ═══════════════════════════════════════════════════════════════
// 共用小工具
// ═══════════════════════════════════════════════════════════════
type Ctx = { T: string; tripId: string; id: Record<string, string>; name: (mid: string) => string };

// baseCurrency 幾乎都用預設的 TWD;第 13 組刻意開 JPY 本位的旅程,理由見那一組。
async function mkTrip(label: string, members: string[], pot?: string, baseCurrency = 'TWD'): Promise<Ctx> {
  const r = await post('/api/trips', {
    name: `${label} ${Date.now()}`, base_currency: baseCurrency, members,
    ...(pot ? { pot } : {}),
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
 * 新增與編輯共用同一組預設值 —— 這是刻意的。
 * 兩邊的 body 契約完全一樣(PATCH 是整筆取代,不是部分更新),
 * 測試裡也用同一個形狀,任何一邊偷偷收了不一樣的欄位都會露出來。
 */
const DEFAULTS = { kind: 'shared', payment_method: 'cash', spent_at: '2026-03-08' };
const add = (T: string, body: J) => post(`/api/trips/${T}/expenses`, { ...DEFAULTS, ...body });
const edit = (T: string, id: string, body: J) =>
  patch(`/api/trips/${T}/expenses/${id}`, { ...DEFAULTS, ...body });

/** 這趟的某一筆支出(從列表撈 —— 列表就是前端預填編輯表單的資料來源)。 */
async function one(T: string, id: string): Promise<J | undefined> {
  const r = await get(`/api/trips/${T}/expenses`);
  return ((r.json as J[]) ?? []).find((e) => e.id === id);
}

/** payers / shares 攤成 ['民 2000'] —— 誰、多少、有幾列,一次斷言完。 */
const lines = (rows: J[] | undefined, c: Ctx) =>
  (rows ?? []).map((r) => `${c.name(r.member_id)} ${r.amount_minor}`).sort();

/**
 * 一筆支出的完整快照。「驗證失敗時資料庫沒被改到」只能這樣斷言 ——
 * 逐欄位比對會漏掉沒想到的那一欄,而漏掉的那一欄正是 bug 會住的地方。
 */
const snap = (e: J | undefined, c: Ctx) => (e ? {
  kind: e.kind, description: e.description, category: e.category,
  currency: e.currency, amount_minor: e.amount_minor, payment_method: e.payment_method,
  fx_rate: e.fx_rate, fx_rate_date: e.fx_rate_date, fx_rate_source: e.fx_rate_source,
  fx_rate_override: e.fx_rate_override, fx_markup_pct: e.fx_markup_pct,
  spent_at: e.spent_at, note: e.note, created_at: e.created_at,
  settlement_round_id: e.settlement_round_id ?? null,
  payers: lines(e.payers, c), shares: lines(e.shares, c),
} : null);

/** 某幣別的淨額 map。編輯金額之後,錢有沒有真的跟著動只有這裡答得出來。 */
async function netsOf(T: string, currency: string) {
  const bal = await get(`/api/trips/${T}/balance`);
  const nets = (bal.json.by_currency?.[currency]?.nets ?? []) as J[];
  return new Map<string, number>(nets.map((n) => [n.memberId, n.netMinor]));
}
const netLines = (m: Map<string, number>, c: Ctx) =>
  [...m].map(([mid, v]) => `${c.name(mid)} ${v}`).sort();

// ═══════════════════════════════════════════════════════════════
group('[1] 改文字:description / category / note —— 其他欄位一格都不能動');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E1 改文字', ['民', '喧', '華']);
  const created = await add(c.T, {
    description: '宇治', category: '餐飲', note: '抹茶',
    currency: 'JPY', amount: 3000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('新增 ¥3,000 → 201', created.status, 201);
  const eid = created.json.id as string;
  const before = snap(await one(c.T, eid), c)!;

  const r = await edit(c.T, eid, {
    description: '伊藤久右衛門', category: '伴手禮', note: '宇治本店',
    currency: 'JPY', amount: 3000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('PATCH → 200', r.status, 200);
  eq('回傳 id 就是這一筆', r.json.id, eid);
  check('回傳帶 fx_rate', typeof r.json.fx_rate === 'number', String(r.json.fx_rate));
  check('回傳帶 fx_rate_date', typeof r.json.fx_rate_date === 'string', String(r.json.fx_rate_date));
  check('回傳帶 fx_markup_pct', typeof r.json.fx_markup_pct === 'number', String(r.json.fx_markup_pct));

  const after = await one(c.T, eid);
  eq('描述改掉了', after?.description, '伊藤久右衛門');
  eq('分類改掉了', after?.category, '伴手禮');
  eq('備註改掉了', after?.note, '宇治本店');

  // 這一組真正在守的東西:改一個字,不該有第二個欄位跟著變。
  eq('金額沒變', after?.amount_minor, 3000);
  eq('幣別沒變', after?.currency, 'JPY');
  eq('日期沒變', after?.spent_at, '2026-03-08');
  eq('付款方式沒變', after?.payment_method, 'cash');
  eq('匯率沒變', after?.fx_rate, before.fx_rate);
  eq('匯率日期沒變', after?.fx_rate_date, before.fx_rate_date);
  eq('加成沒變', after?.fx_markup_pct, before.fx_markup_pct);
  eq('付款人沒變', lines(after?.payers, c), ['民 3000']);
  eq('分攤沒變', lines(after?.shares, c), ['喧 1000', '民 1000', '華 1000']);
  // created_at 是「什麼時候被記下來」,不是消費時間 —— 改錯字不該讓那筆跳到列表最上面
  eq('created_at 沒變(改錯字不該重排列表)', after?.created_at, before.created_at);
  eq('列表仍然只有這一筆(是改不是新增)', ((await get(`/api/trips/${c.T}/expenses`)).json as J[]).length, 1);
}

// ═══════════════════════════════════════════════════════════════
group('[2] 改金額:payers / shares / balance 三邊一起對');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E2 改金額', ['民', '喧', '華']);
  const created = await add(c.T, {
    description: '晚餐', currency: 'JPY', amount: 3000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('新增 ¥3,000 → 201', created.status, 201);
  const eid = created.json.id as string;
  eq('改之前:民 +2000,兩人各 −1000',
    netLines(await netsOf(c.T, 'JPY'), c), ['喧 -1000', '民 2000', '華 -1000']);

  const r = await edit(c.T, eid, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('金額改成 ¥6,000 → 200', r.status, 200);

  const after = await one(c.T, eid);
  eq('amount_minor = 6000', after?.amount_minor, 6000);
  eq('付款人金額跟著變成 6000', lines(after?.payers, c), ['民 6000']);
  eq('分攤重新算成各 2000', lines(after?.shares, c), ['喧 2000', '民 2000', '華 2000']);
  // 「有沒有真的影響到錢」只有餘額答得出來 —— 支出列表對了但餘額沒動的話,
  // 代表分攤列沒被重寫,而那正是最危險的那種壞法。
  eq('餘額反映新金額:民 +4000,兩人各 −2000',
    netLines(await netsOf(c.T, 'JPY'), c), ['喧 -2000', '民 4000', '華 -2000']);

  // 金額改小也要對稱地跟著縮
  eq('再改成 ¥900 → 200', (await edit(c.T, eid, {
    description: '晚餐', currency: 'JPY', amount: 900,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  })).status, 200);
  eq('餘額跟著縮:民 +600', netLines(await netsOf(c.T, 'JPY'), c),
    ['喧 -300', '民 600', '華 -300']);
}

// ═══════════════════════════════════════════════════════════════
group('[3] 改幣別:匯率重新 snapshot,而且最小單位換了一套');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E3 改幣別', ['民', '喧', '華']);
  // 先記成台幣(= 本位幣)。identity 匯率 1、加成 0 —— 這是最容易被沿用的錯誤起點。
  const created = await add(c.T, {
    description: '住宿', currency: 'TWD', amount: 900,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('新增 NT$900 → 201', created.status, 201);
  const eid = created.json.id as string;
  const before = await one(c.T, eid);
  eq('本位幣 → 匯率 1', before?.fx_rate, 1);
  eq('本位幣 → 來源 identity', before?.fx_rate_source, 'identity');
  eq('本位幣 → 加成 0', before?.fx_markup_pct, 0);
  eq('TWD exponent 2 → 90000 分', before?.amount_minor, 90000);
  eq('每人分攤 30000 分', lines(before?.shares, c), ['喧 30000', '民 30000', '華 30000']);

  // 對照組:同一天、同幣別、直接用 POST 記一筆。PATCH 算出來的 fx 必須和它一模一樣。
  const ref = await add(c.T, {
    description: '對照組', currency: 'JPY', amount: 100, payment_method: 'card',
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 100 } },
  });
  eq('對照組(JPY / 刷卡)→ 201', ref.status, 201);

  const r = await edit(c.T, eid, {
    description: '住宿', currency: 'JPY', amount: 900, payment_method: 'card',
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('改成 ¥900 / 刷卡 → 200', r.status, 200);

  const after = await one(c.T, eid);
  eq('幣別改掉了', after?.currency, 'JPY');
  eq('JPY exponent 0 → 900', after?.amount_minor, 900);
  eq('每人分攤 300', lines(after?.shares, c), ['喧 300', '民 300', '華 300']);
  eq('付款人也換成 JPY 的最小單位', lines(after?.payers, c), ['民 900']);
  // 這一組的重點:沿用舊匯率(1)會讓這筆日幣支出的台幣估算差 5 倍以上。
  check('匯率不再是本位幣的 1', after?.fx_rate !== 1, String(after?.fx_rate));
  eq('匯率等於同幣別同日期新增的那筆', after?.fx_rate, ref.json.fx_rate);
  eq('匯率日期等於同幣別同日期新增的那筆', after?.fx_rate_date, ref.json.fx_rate_date);
  check('來源不再是 identity', after?.fx_rate_source !== 'identity', String(after?.fx_rate_source));
  // 外幣 + 刷卡 → 加成回到 runtimeConfig 的 cardFeePct,不是繼續留著本位幣的 0
  eq('加成照 POST 的規則重算', after?.fx_markup_pct, ref.json.fx_markup_pct);
  check('刷卡加成大於 0', (after?.fx_markup_pct ?? 0) > 0, String(after?.fx_markup_pct));

  // 反向:改回本位幣,加成要歸零(本位幣不換匯,任何加成都沒有意義)
  eq('改回 NT$900 → 200', (await edit(c.T, eid, {
    description: '住宿', currency: 'TWD', amount: 900, payment_method: 'card',
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  })).status, 200);
  const back = await one(c.T, eid);
  eq('回到本位幣 → 匯率 1', back?.fx_rate, 1);
  eq('回到本位幣 → 加成歸零', back?.fx_markup_pct, 0);
  eq('回到本位幣 → 90000 分', back?.amount_minor, 90000);
}

// ═══════════════════════════════════════════════════════════════
group('[4] 改 spent_at:fx_rate_date 跟著換到新日期那一天');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E4 改日期', ['民', '喧']);
  const TODAY = new Date().toISOString().slice(0, 10);
  const OLD = '2024-01-01';   // 一定早於任何一筆 fx_rates → 會走 fallback:earliest

  // 兩個對照組,把「這個日期應該拿到哪一天的匯率」先問出來 ——
  // 直接寫死日期會綁死在某一次 sync 的結果上,換一台機器就紅。
  const refOld = await add(c.T, {
    description: '對照組 舊', currency: 'JPY', amount: 100, spent_at: OLD,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 100 } },
  });
  const refNew = await add(c.T, {
    description: '對照組 今', currency: 'JPY', amount: 100, spent_at: TODAY,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 100 } },
  });
  eq('對照組(舊日期)→ 201', refOld.status, 201);
  eq('對照組(今天)→ 201', refNew.status, 201);

  const created = await add(c.T, {
    description: '補登的車票', currency: 'JPY', amount: 1000, spent_at: OLD,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('補登一筆(舊日期)→ 201', created.status, 201);
  const eid = created.json.id as string;
  const before = await one(c.T, eid);
  eq('補登 → 匯率日期是最早的那一天', before?.fx_rate_date, refOld.json.fx_rate_date);
  check('補登 → 來源標記 fallback:earliest',
    String(before?.fx_rate_source).includes('fallback:earliest'), String(before?.fx_rate_source));

  const r = await edit(c.T, eid, {
    description: '補登的車票', currency: 'JPY', amount: 1000, spent_at: TODAY,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq(`日期改成 ${TODAY} → 200`, r.status, 200);

  const after = await one(c.T, eid);
  eq('spent_at 改掉了', after?.spent_at, TODAY);
  eq('fx_rate_date 換到新日期該拿的那一天', after?.fx_rate_date, refNew.json.fx_rate_date);
  eq('fx_rate 也等於新日期該拿的那個值', after?.fx_rate, refNew.json.fx_rate);
  // 這是最硬的一條:fallback 標記消失,代表匯率確實是用**新的** spent_at 重查的,
  // 不是把舊的那份原封不動搬過來。
  check('來源不再標 fallback:earliest',
    !String(after?.fx_rate_source).includes('fallback'), String(after?.fx_rate_source));

  // 改回去也要對稱 —— 只往一個方向對的話,通常是某個地方寫死了
  eq('日期改回舊的 → 200', (await edit(c.T, eid, {
    description: '補登的車票', currency: 'JPY', amount: 1000, spent_at: OLD,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 200);
  const back = await one(c.T, eid);
  eq('fx_rate_date 也跟著回去', back?.fx_rate_date, refOld.json.fx_rate_date);
  check('fallback 標記回來了',
    String(back?.fx_rate_source).includes('fallback:earliest'), String(back?.fx_rate_source));
}

// ═══════════════════════════════════════════════════════════════
group('[5] 換分攤模式 equal → exact → shares:舊的列不能有殘留');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E5 換分攤', ['民', '喧', '華']);
  const created = await add(c.T, {
    description: '計程車', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('均分三人 → 201', created.status, 201);
  const eid = created.json.id as string;
  eq('起點:三人各 2000', lines((await one(c.T, eid))?.shares, c),
    ['喧 2000', '民 2000', '華 2000']);

  // equal → exact,而且**少一個人**。這一步是整組的重點:
  // 如果實作是 diff 而不是刪光重寫,華那一列會留下來,
  // 合計仍然守恆(新的兩列加起來是 6000),但華會憑空多欠 2000。
  eq('改成指定金額、只有兩個人 → 200', (await edit(c.T, eid, {
    description: '計程車', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 2500, [c.id['喧']]: 3500 } },
  })).status, 200);
  const ex = await one(c.T, eid);
  eq('分攤只剩兩列,金額照指定的', lines(ex?.shares, c), ['喧 3500', '民 2500']);
  eq('華完全不在分攤名單裡了', (ex?.shares ?? []).some((s: J) => s.member_id === c.id['華']), false);
  // 淨額只列有帳的人,所以「華整個不見了」正是殘留列被刪乾淨的證據 ——
  // 舊的那一列還在的話,這裡會冒出一個「華 -2000」。
  eq('餘額:華從淨額裡整個消失', netLines(await netsOf(c.T, 'JPY'), c),
    ['喧 -3500', '民 3500']);

  // exact → shares,而且人又回來了
  eq('改成份數 1:2:3 → 200', (await edit(c.T, eid, {
    description: '計程車', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'shares', shares: { [c.id['民']]: 1, [c.id['喧']]: 2, [c.id['華']]: 3 } },
  })).status, 200);
  const sh = await one(c.T, eid);
  eq('份數 1:2:3 → 1000 / 2000 / 3000', lines(sh?.shares, c),
    ['喧 2000', '民 1000', '華 3000']);
  eq('剛好三列,沒有殘留', (sh?.shares ?? []).length, 3);
  eq('餘額:民 +5000', netLines(await netsOf(c.T, 'JPY'), c),
    ['喧 -2000', '民 5000', '華 -3000']);

  // shares → equal,繞回起點。三種模式兩兩之間都走過一遍。
  eq('改回均分 → 200', (await edit(c.T, eid, {
    description: '計程車', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  })).status, 200);
  eq('回到三人各 2000', lines((await one(c.T, eid))?.shares, c),
    ['喧 2000', '民 2000', '華 2000']);
}

// ═══════════════════════════════════════════════════════════════
group('[6] 換付款人:一人 → 兩人 → 換成第三個人');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E6 換付款人', ['民', '喧', '華']);
  const created = await add(c.T, {
    description: '門票', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('民全額墊付 → 201', created.status, 201);
  const eid = created.json.id as string;
  eq('起點:民 6000', lines((await one(c.T, eid))?.payers, c), ['民 6000']);

  eq('改成兩人合墊 2000 / 4000 → 200', (await edit(c.T, eid, {
    description: '門票', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'], amount: 2000 }, { member_id: c.id['喧'], amount: 4000 }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  })).status, 200);
  const two = await one(c.T, eid);
  eq('付款人兩列', lines(two?.payers, c), ['喧 4000', '民 2000']);
  eq('分攤沒被波及,還是各 2000', lines(two?.shares, c), ['喧 2000', '民 2000', '華 2000']);
  // 民付 2000、也分攤 2000 → 淨額 0,所以他從清單裡消失,這是預期的
  eq('餘額:喧 +2000、華 −2000(民打平了)',
    netLines(await netsOf(c.T, 'JPY'), c), ['喧 2000', '華 -2000']);

  // 兩人 → 一人(而且是原本沒出現過的第三個人)。舊的兩列都要消失。
  eq('改成華一個人全額 → 200', (await edit(c.T, eid, {
    description: '門票', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['華'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  })).status, 200);
  const solo = await one(c.T, eid);
  eq('付款人只剩華一列', lines(solo?.payers, c), ['華 6000']);
  eq('剛好一列,沒有殘留', (solo?.payers ?? []).length, 1);
  eq('餘額:華 +4000',
    netLines(await netsOf(c.T, 'JPY'), c), ['喧 -2000', '民 -2000', '華 4000']);
}

// ═══════════════════════════════════════════════════════════════
group('[7] 驗證失敗 → 400,而且資料庫一個字都沒動(原子性)');
// ═══════════════════════════════════════════════════════════════
//
// 這一組是整支測試最重要的地方。編輯的失敗情境比新增危險得多:
// 新增失敗只是「沒記到」,編輯失敗如果寫了一半,留下的是一筆
// **已經存在、正在被結算採用**的壞帳 —— 而且畫面上長得完全正常。
{
  const c = await mkTrip('E7 原子性', ['民', '喧', '華']);
  const other = await mkTrip('E7 別趟', ['路人']);
  const created = await add(c.T, {
    description: '正確的那筆', category: '餐飲', note: '不要動我',
    currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('新增 → 201', created.status, 201);
  const eid = created.json.id as string;
  const before = snap(await one(c.T, eid), c)!;
  const netsBefore = netLines(await netsOf(c.T, 'JPY'), c);

  /** 送一個壞 body,斷言「回這個 status」而且「整筆快照一格都沒變」。 */
  async function refuse(label: string, status: number, body: J, msgRe?: RegExp) {
    const r = await edit(c.T, eid, body);
    eq(`${label} → ${status}`, r.status, status);
    if (msgRe) {
      check(`${label}:訊息看得懂`, msgRe.test(JSON.stringify(r.json)),
        JSON.stringify(r.json).slice(0, 140));
    }
    eq(`${label}:整筆支出完全沒被改到`, snap(await one(c.T, eid), c), before);
    eq(`${label}:餘額也沒動`, netLines(await netsOf(c.T, 'JPY'), c), netsBefore);
  }

  // 每一個壞 body 都同時夾帶一個「合法且顯眼」的改動(描述、金額),
  // 這樣如果實作是「先寫 expenses 再驗分攤」,快照比對一定會抓到。
  await refuse('分攤合計不符', 400, {
    description: '被改壞了', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 2000, [c.id['喧']]: 2000 } },  // 4000 ≠ 6000
  }, /不符/);

  await refuse('付款合計不符', 400, {
    description: '被改壞了', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'], amount: 1000 }, { member_id: c.id['喧'], amount: 1000 }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  }, /不符/);

  await refuse('沒有付款人', 400, {
    description: '被改壞了', currency: 'JPY', amount: 6000,
    payers: [],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  }, /付款人/);

  await refuse('缺少 split', 400, {
    description: '被改壞了', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
  }, /分攤方式/);

  await refuse('沒有金額', 400, {
    description: '被改壞了', currency: 'JPY',
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民']] },
  });

  // 跨旅程的成員 id —— POST 擋得掉,PATCH 也必須擋得掉。
  // 漏掉這條的話,列表會出現「未知成員」而且結算永遠不平。
  await refuse('分攤名單有別趟的成員', 400, {
    description: '被改壞了', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 3000, [other.id['路人']]: 3000 } },
  }, /不屬於這趟旅程/);

  await refuse('付款人是別趟的成員', 400, {
    description: '被改壞了', currency: 'JPY', amount: 6000,
    payers: [{ member_id: other.id['路人'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  }, /不屬於這趟旅程/);

  await refuse('有付款人金額是 0', 400, {
    description: '被改壞了', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'], amount: 6000 }, { member_id: c.id['喧'], amount: 0 }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  }, /大於 0/);

  await refuse('加成超出 0~100', 400, {
    description: '被改壞了', currency: 'JPY', amount: 6000, fx_markup_pct: 999,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  }, /fx_markup_pct/);

  // 被這麼多次失敗轟炸完,那筆帳仍然是原本那筆 —— 而且還能正常編輯。
  eq('經過 9 次失敗之後,合法的編輯仍然成功 → 200', (await edit(c.T, eid, {
    description: '正確的那筆(改過了)', category: '餐飲', note: '不要動我',
    currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  })).status, 200);
  eq('這次真的改到了', (await one(c.T, eid))?.description, '正確的那筆(改過了)');
}

// ═══════════════════════════════════════════════════════════════
group('[8] 公費的三條規則,PATCH 同樣要守');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E8 公費', ['民', '喧'], '公費');
  const potId = c.id['公費'];
  check('這趟有公費', !!potId, JSON.stringify(Object.keys(c.id)));

  const created = await add(c.T, {
    description: '公費付的午餐', currency: 'JPY', amount: 2000,
    payers: [{ member_id: potId }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('公費墊付的共同花費 → 201', created.status, 201);
  const eid = created.json.id as string;
  const before = snap(await one(c.T, eid), c)!;

  const inSplit = await edit(c.T, eid, {
    description: '把公費塞進分攤', currency: 'JPY', amount: 2000,
    payers: [{ member_id: potId }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 1000, [potId]: 1000 } },
  });
  eq('公費出現在分攤名單 → 400', inSplit.status, 400);
  check('訊息說明公費是出錢的一方',
    /公費/.test(JSON.stringify(inSplit.json)), JSON.stringify(inSplit.json).slice(0, 140));
  eq('沒被改到', snap(await one(c.T, eid), c), before);

  const personalByPot = await edit(c.T, eid, {
    kind: 'personal', description: '改成個人花費但還是公費付', currency: 'JPY', amount: 2000,
    payment_method: 'cash', spent_at: '2026-03-08',
    payers: [{ member_id: potId }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 2000 } },
  });
  eq('個人花費由公費支付 → 400', personalByPot.status, 400);
  eq('沒被改到', snap(await one(c.T, eid), c), before);

  // 合法的公費編輯要放行,而且公費剩餘要跟著變
  eq('公費那筆改成 ¥3,000 → 200', (await edit(c.T, eid, {
    description: '公費付的午餐', currency: 'JPY', amount: 3000,
    payers: [{ member_id: potId }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 200);
  const bal = await get(`/api/trips/${c.T}/balance`);
  const pot = ((bal.json.pot?.by_currency ?? []) as J[]).find((r) => r.currency === 'JPY');
  eq('公費付掉的金額跟著變成 3000', pot?.spentMinor, 3000);
  eq('公費剩餘 = −3000(還沒有人投入)', pot?.remainingMinor, -3000);
  // 「公費淨額 = 公費花費」是這個 App 的核心不變量(取代了舊的「剩餘 = −淨額」——
  // 淨額已經不含投入/退還,見 server/utils/ledger.ts 開頭),編輯之後也必須成立。
  // ⚠️ 這一組剛好沒有人投入也沒有退還,所以舊的等式在數值上仍然成立;
  // 改成盯 spentMinor 是為了讓它真的在守新語意,而不是碰巧綠著。
  const potNet = (await netsOf(c.T, 'JPY')).get(potId) ?? 0;
  eq('公費淨額 = 公費花費,不變量還在', potNet, pot?.spentMinor);
  eq('編輯之後也是 3000', potNet, 3000);
  eq('兩人各分攤 1500', lines((await one(c.T, eid))?.shares, c), ['喧 1500', '民 1500']);
}

// ═══════════════════════════════════════════════════════════════
group('[9] 找不到 → 404(別趟的 id 也一樣)');
// ═══════════════════════════════════════════════════════════════
{
  const a = await mkTrip('E9 甲', ['民']);
  const b = await mkTrip('E9 乙', ['喧']);
  const inB = await add(b.T, {
    description: '乙的支出', currency: 'JPY', amount: 1000,
    payers: [{ member_id: b.id['喧'] }],
    split: { mode: 'exact', amounts: { [b.id['喧']]: 1000 } },
  });
  eq('乙記一筆 → 201', inB.status, 201);
  const beforeB = snap(await one(b.T, inB.json.id), b)!;

  const body = {
    description: '偷改別人的帳', currency: 'JPY', amount: 9999,
    payers: [{ member_id: a.id['民'] }],
    split: { mode: 'exact', amounts: { [a.id['民']]: 9999 } },
  };

  // 這是權限的邊界,不是「查無資料」的便利回應 ——
  // WHERE 沒有同時綁 trip_id 的話,這一發會直接改掉別人的帳。
  const cross = await edit(a.T, inB.json.id as string, body);
  eq('拿乙的 expense id 從甲的旅程改 → 404', cross.status, 404);
  eq('乙那筆完全沒被動到', snap(await one(b.T, inB.json.id), b), beforeB);

  eq('不存在的 expense id → 404',
    (await edit(a.T, '00000000-0000-0000-0000-000000000000', body)).status, 404);
  // 旅程本身沒權限的話,連 404 之前的那一關都過不了(requireTrip)
  eq('不存在的旅程 token → 404',
    (await edit('nope-nope-nope', inB.json.id as string, body)).status, 404);
}

// ═══════════════════════════════════════════════════════════════
group('[10] 已經蓋章的支出 → 409;撤銷那次結算之後 → 200');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E10 蓋章', ['民', '喧']);
  const created = await add(c.T, {
    description: '第一晚的晚餐', currency: 'JPY', amount: 4000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('新增 ¥4,000 → 201', created.status, 201);
  const eid = created.json.id as string;

  const round = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY', label: '第一晚' });
  eq('關閉結算回合 → 201', round.status, 201);
  const after = await one(c.T, eid);
  check('那筆被蓋章了', !!after?.settlement_round_id, String(after?.settlement_round_id));
  const stamped = snap(after, c)!;

  const body = {
    description: '結算完才想改', currency: 'JPY', amount: 9000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  };
  const blocked = await edit(c.T, eid, body);
  // 錢已經照那個數字付出去了。改掉的話,那次結算的明細會對不上它自己的淨額快照。
  eq('已蓋章 → 409', blocked.status, 409);
  const msg = JSON.stringify(blocked.json);
  check('訊息說得出是第幾次結算', /第 1 次結算/.test(msg), msg.slice(0, 160));
  check('訊息用「修改」不是「刪除」', /修改/.test(msg) && !/刪除/.test(msg), msg.slice(0, 160));
  check('訊息提示要先撤銷', /撤銷/.test(msg), msg.slice(0, 160));
  eq('被擋下來時什麼都沒寫', snap(await one(c.T, eid), c), stamped);

  eq('撤銷那次結算 → 200', (await del(`/api/trips/${c.T}/rounds/${round.json.id}`)).status, 200);
  eq('章拆掉了', (await one(c.T, eid))?.settlement_round_id ?? null, null);

  const ok = await edit(c.T, eid, body);
  eq('撤銷之後可以改 → 200', ok.status, 200);
  const edited = await one(c.T, eid);
  eq('金額真的改了', edited?.amount_minor, 9000);
  eq('分攤跟著重算', lines(edited?.shares, c), ['喧 4500', '民 4500']);
  eq('settlement_round_id 仍然是 NULL(PATCH 不碰它)', edited?.settlement_round_id ?? null, null);
  eq('餘額用新金額算', netLines(await netsOf(c.T, 'JPY'), c), ['喧 -4500', '民 4500']);
}

// ═══════════════════════════════════════════════════════════════
group('[11] kind=personal 也能改,而且改得動 kind 本身');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('E11 個人花費', ['民', '喧']);
  const created = await post(`/api/trips/${c.T}/expenses`, {
    kind: 'personal', description: '北臉紫標後背包', currency: 'JPY', amount: 25000,
    payment_method: 'card', spent_at: '2026-03-10',
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 25000 } },
  });
  eq('新增個人花費 → 201', created.status, 201);
  const eid = created.json.id as string;

  const r = await patch(`/api/trips/${c.T}/expenses/${eid}`, {
    kind: 'personal', description: '北臉紫標後背包(打折)', currency: 'JPY', amount: 19800,
    payment_method: 'card', spent_at: '2026-03-10',
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 19800 } },
  });
  eq('改個人花費的金額 → 200', r.status, 200);
  const after = await one(c.T, eid);
  eq('kind 還是 personal', after?.kind, 'personal');
  eq('金額改掉了', after?.amount_minor, 19800);
  eq('分攤跟著改', lines(after?.shares, c), ['民 19800']);
  eq('?kind=personal 仍然撈得到',
    ((await get(`/api/trips/${c.T}/expenses?kind=personal`)).json as J[]).length, 1);
  // 個人花費不進結算 —— 改金額不該讓誰欠誰,JPY 連一塊淨額都不該出現
  eq('個人花費不影響餘額', netLines(await netsOf(c.T, 'JPY'), c), []);

  // 「記成個人結果是大家一起吃的」是真實會發生的事,整筆取代的語意讓它一次改完
  eq('改成共同花費、兩人均分 → 200', (await patch(`/api/trips/${c.T}/expenses/${eid}`, {
    kind: 'shared', description: '其實是一起買的', currency: 'JPY', amount: 19800,
    payment_method: 'card', spent_at: '2026-03-10',
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 200);
  eq('kind 變成 shared', (await one(c.T, eid))?.kind, 'shared');
  eq('這下進結算了:民 +9900', netLines(await netsOf(c.T, 'JPY'), c), ['喧 -9900', '民 9900']);
  eq('?kind=personal 已經撈不到',
    ((await get(`/api/trips/${c.T}/expenses?kind=personal`)).json as J[]).length, 0);
}

// ═══════════════════════════════════════════════════════════════
group('[12] fx_rate_override:沒送就是清掉,不是「維持原狀」');
// ═══════════════════════════════════════════════════════════════
//
// PATCH 是整筆取代,所以「body 裡沒有這個欄位」= 使用者把它清空了。
// 這條容易被實作成 COALESCE(?, fx_rate_override)(維持原狀),
// 那樣使用者就永遠拿不掉自己填錯的覆寫匯率 —— 而覆寫是會直接改變
// 台幣估算金額的東西。
{
  const c = await mkTrip('E12 覆寫匯率', ['民', '喧']);
  const created = await add(c.T, {
    description: '照帳單回填', currency: 'JPY', amount: 2000, fx_rate_override: 0.25,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('新增時帶覆寫匯率 → 201', created.status, 201);
  const eid = created.json.id as string;
  eq('覆寫存進去了', (await one(c.T, eid))?.fx_rate_override, 0.25);

  eq('改成別的覆寫值 → 200', (await edit(c.T, eid, {
    description: '照帳單回填', currency: 'JPY', amount: 2000, fx_rate_override: 0.23,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 200);
  eq('覆寫換成新的值', (await one(c.T, eid))?.fx_rate_override, 0.23);

  eq('不帶這個欄位 → 200', (await edit(c.T, eid, {
    description: '照帳單回填', currency: 'JPY', amount: 2000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 200);
  eq('覆寫被清掉(回到用 snapshot 的中價)', (await one(c.T, eid))?.fx_rate_override ?? null, null);
}

// ═══════════════════════════════════════════════════════════════
// 直接寫本機 D1 —— 「fx_rates 多出新的一天」沒有 API 做得到
// ═══════════════════════════════════════════════════════════════
//
// 下一組要製造的狀態是「記完帳之後,fx:sync 又跑過一次」。
// sync-rates 抓的永遠是**今天**那一列,沒有任何 endpoint 能讓 fx_rates
// 長出「某筆支出的消費當日」那一列 —— 而那一列正是無條件重抓會踩到的東西。
// 所以照 api.rounds.test.ts 的做法,直接對 miniflare 那個 sqlite 檔動手
// (WAL 模式,dev server 開著也寫得進去,而且它馬上看得到)。
//
// 找不到檔案時不假裝通過:注入會回 false,相關斷言直接紅。
function findD1(): string | null {
  try {
    const dir = fileURLToPath(new URL('../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url));
    const files = readdirSync(dir).filter((n) => n.endsWith('.sqlite') && n !== 'metadata.sqlite');
    if (!files.length) return null;
    // 目錄裡可能有**多個** .sqlite:miniflare 的本機 D1 檔名是由 wrangler.jsonc 的
    // database_id 雜湊出來的,所以那個值一改(例如把 local-dev-placeholder 換成真實 UUID
    // 準備部署),就會多出一個全新的空資料庫,舊的仍然留在磁碟上。
    //
    // 原本這裡是 `files.length === 1 ? … : null`,於是那一刻起所有需要數列的斷言
    // 都變成 `got null`(實測 39 條)—— 而真正的原因和測試完全無關,很難聯想。
    // dev server 讀的一定是**現在**這份設定對應的那個檔,也就是最近被寫入的那個,
    // 所以挑 mtime 最新的。
    return dir + files
      .map((n) => ({ n, at: statSync(dir + n).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]!.n;
  } catch { return null; }
}
const D1_PATH = findD1();
console.log(D1_PATH ? `本機 D1: ${D1_PATH}` : '⚠ 找不到本機 D1 檔案 —— 第 13 組會失敗');

function d1Write(sql: string, ...args: Array<string | number | null>): boolean {
  if (!D1_PATH) return false;
  const dbh = new DatabaseSync(D1_PATH);
  try { dbh.prepare(sql).run(...args); return true; }
  catch (e) { console.log(`  (D1 寫入失敗:${String(e)})`); return false; }
  finally { dbh.close(); }
}

// ═══════════════════════════════════════════════════════════════
group('[13] 純文字編輯不准改寫匯率 snapshot(改一個錯字不該讓金額動)');
// ═══════════════════════════════════════════════════════════════
//
// fx_rates 是一天長一列的表,而 rateOn() 取的是「消費當日或之前**最近**的一列」。
// 所以同一組 (幣別, 日期) 問兩次,中間只要 fx:sync 跑過就會得到不同答案:
//
//   3/8 08:00(台北)= 00:00 UTC 記下這筆。cron 是 0 1 * * * UTC,
//   此刻最近的一列還是 3/7 → 匯率 snapshot 存 3/7 那個值。
//   當天 01:00 UTC 之後 3/8 那列才進來。
//   3/9 使用者只把說明從「宇治」改成「宇治抹茶」——
//   如果 PATCH 無條件重抓,fx_rate 會被改寫成 3/8 的值,本位幣估算跟著跳。
//
// 「同一筆帳今天看和明天看要是同一個數字」是這個 App 的基本承諾
// (原文在 fx.ts 的 backfillMissingRates,而它的實作也照著做:只補
//  fx_rate IS NULL 的列,**從不改寫既有匯率**)。編輯是第二條寫入路徑,
// 同一句承諾在這裡也必須成立。
//
// 只有這三種情況才該重抓:① 幣別換了 ② spent_at 的日期換了 ③ 原本沒有 snapshot。
{
  // ── 為什麼這一組的旅程是 JPY 本位、支出記 TWD(和其他組相反)───────
  //
  // 這一組必須往 fx_rates 注入假匯率,而 expenses.currency 有
  // `REFERENCES currencies(code)`,所以不能拿一個沒人用的幣別代碼來隔離。
  // 改成隔離 (base, currency) 這一對:sync-rates 只寫 base='TWD' 的列
  // (見 nuxt.config 的 fxBase),其他測試也一律是 TWD 本位,
  // 所以 base='JPY' & currency='TWD' 這一對**只有這一組會碰** ——
  // 注入的假匯率不會污染任何人,包含本機那趟真實的 3 月行程。
  const D7 = '2026-03-07';   // 記帳當下 fx_rates 最新的那一列
  const D8 = '2026-03-08';   // 消費當日 —— 這一列在記帳之後才進來
  const D9 = '2026-03-09';
  const OLD_RATE = 4.9;      // 1 TWD = 4.9 JPY
  const NEW_RATE = 5;        // 隔天那列:1 TWD = 5 JPY
  // 兩列的 source 刻意不一樣 —— 這樣 fx_rate_source 也能當判準。
  // 兩列同一個 source 的話,「來源沒動」這條在被改寫的時候照樣是綠的,
  // 也就是它什麼都沒守(反向驗證時實測過)。
  const SRC7 = 'test:injected@3-07';
  const SRC8 = 'test:injected@3-08';

  const clearRates = () => d1Write(`DELETE FROM fx_rates WHERE base = 'JPY' AND currency = 'TWD'`);
  const injectRate = (date: string, rate: number, src: string) => d1Write(
    `INSERT INTO fx_rates (rate_date, base, currency, rate, source) VALUES (?, 'JPY', 'TWD', ?, ?)
     ON CONFLICT(rate_date, base, currency) DO UPDATE SET
       rate = excluded.rate, source = excluded.source`,
    date, rate, src);

  /** 這個人這趟的本位幣估算 —— 使用者真正看到的那個數字。 */
  const totalBase = async (T: string, mid: string) =>
    ((await get(`/api/trips/${T}/balance`)).json.per_member?.[mid]?.totalBase ?? null);

  /** NT$30,000 的個人花費。要斷言本位幣估算,一個人一筆最乾淨。 */
  const body = (c: Ctx, desc: string, spent: string, currency = 'TWD') => ({
    kind: 'personal', description: desc, currency, amount: 30000, spent_at: spent,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 30000 } },
  });

  clearRates();   // 上一次跑到一半失敗留下的列,先清乾淨
  check('注入「記帳當下」最新的那一列(3/7)', injectRate(D7, OLD_RATE, SRC7));

  const c = await mkTrip('E13 匯率凍結', ['民', '喧'], undefined, 'JPY');
  const created = await add(c.T, body(c, '宇治', D8));
  eq('3/8 記下 NT$30,000 → 201', created.status, 201);
  const eid = created.json.id as string;
  eq('記帳當下只找得到 3/7 那列 → 4.9', created.json.fx_rate, OLD_RATE);
  eq('匯率日期是 3/7', created.json.fx_rate_date, D7);
  eq('本位幣估算 ¥147,000', await totalBase(c.T, c.id['民']), 147000);

  // 記帳之後 fx:sync 又跑了一次,3/8 那列才進來 —— 這就是那個空窗。
  check('注入「記帳之後才進來」的 3/8 那列', injectRate(D8, NEW_RATE, SRC8));

  // 先證明注入真的生效:同幣別同日期**新記**一筆,現在必須拿到 3/8 的值。
  // 少了這一條,下面「匯率沒動」有可能只是因為注入根本沒寫進去 ——
  // 那樣的測試永遠是綠的,而且什麼都沒守。
  // 對照組另開一趟,免得它的金額混進上面那個 per_member。
  const cRef = await mkTrip('E13 對照組', ['民'], undefined, 'JPY');
  const ref = await add(cRef.T, body(cRef, '對照組', D8));
  eq('對照組:現在新記的一筆拿到 3/8 的 5', ref.json.fx_rate, NEW_RATE);
  eq('對照組:匯率日期是 3/8', ref.json.fx_rate_date, D8);
  eq('對照組:本位幣估算 ¥150,000(和上面差 3,000)',
    await totalBase(cRef.T, cRef.id['民']), 150000);

  // ── 整組的重點:只改說明,幣別和日期一個字都沒動 ──────────────
  const r = await edit(c.T, eid, body(c, '宇治抹茶', D8));
  eq('只把「宇治」改成「宇治抹茶」→ 200', r.status, 200);
  const after = await one(c.T, eid);
  eq('說明改掉了', after?.description, '宇治抹茶');
  eq('fx_rate 沒被改寫', after?.fx_rate, OLD_RATE);
  eq('fx_rate_date 還停在 3/7', after?.fx_rate_date, D7);
  eq('fx_rate_source 也沒動(還是 3/7 那列的來源)', after?.fx_rate_source, SRC7);
  eq('回傳的 fx_rate 是沿用的那個,不是剛查到的', r.json.fx_rate, OLD_RATE);
  eq('回傳的 fx_rate_date 也是沿用的', r.json.fx_rate_date, D7);
  // 這一條是使用者真正會看到的東西:改一個錯字,估算金額不能動
  eq('本位幣估算還是 ¥147,000(沒有跳成 150,000)',
    await totalBase(c.T, c.id['民']), 147000);

  // 再改一次 —— 「每次編輯漂一點」也是不行的
  eq('第二次只改說明 → 200', (await edit(c.T, eid, body(c, '伊藤久右衛門', D8))).status, 200);
  eq('連改兩次也沒漂', (await one(c.T, eid))?.fx_rate, OLD_RATE);

  // 改金額、改付款方式(連帶 markup)也都不是重抓的理由 ——
  // 「哪些欄位算數」寫錯的話,這裡會抓到。
  eq('改金額 + 改成刷卡 → 200', (await edit(c.T, eid, {
    ...body(c, '伊藤久右衛門', D8), amount: 12000, payment_method: 'card',
    split: { mode: 'exact', amounts: { [c.id['民']]: 12000 } },
  })).status, 200);
  const cheaper = await one(c.T, eid);
  eq('金額真的改了', cheaper?.amount_minor, 1200000);
  eq('加成照 POST 的規則重算(刷卡 1.5%)', cheaper?.fx_markup_pct, 1.5);
  eq('但匯率還是原本那個', cheaper?.fx_rate, OLD_RATE);
  eq('匯率日期也還是 3/7', cheaper?.fx_rate_date, D7);

  // ── 反過來:該重抓的時候一定要重抓,否則就變成永遠不更新 ──────────
  //
  // ① 日期改了 → 重抓。3/9 之前最近的一列現在是 3/8。
  eq('把日期改成 3/9 → 200', (await edit(c.T, eid, {
    ...body(c, '伊藤久右衛門', D9), amount: 30000,
  })).status, 200);
  const dated = await one(c.T, eid);
  eq('日期改了 → 匯率重抓成 5', dated?.fx_rate, NEW_RATE);
  eq('匯率日期換成 3/8', dated?.fx_rate_date, D8);
  eq('來源也換成 3/8 那列的', dated?.fx_rate_source, SRC8);
  eq('本位幣估算這次才該跟著動:¥150,000', await totalBase(c.T, c.id['民']), 150000);

  // ② 幣別改了 → 重抓(改成本位幣 = identity)
  eq('把幣別改成本位幣 JPY → 200',
    (await edit(c.T, eid, body(c, '伊藤久右衛門', D9, 'JPY'))).status, 200);
  const swapped = await one(c.T, eid);
  eq('幣別改了 → 匯率重抓成 identity 的 1', swapped?.fx_rate, 1);
  eq('來源變成 identity', swapped?.fx_rate_source, 'identity');

  // ③ 原本就沒有 snapshot → 補上是對的。
  //    「不要改寫既有匯率」在這裡沒有東西要保護,而留著 null 反而會漂:
  //    balance 對 fx_rate 為 null 的列退回用「今天」的匯率換算(見 fx.ts)。
  //    這裡直接把欄位挖成 NULL,模擬 fx_rates 還空著時記下的帳 / Excel 匯入的舊帳。
  const cNil = await mkTrip('E13 本來沒 snapshot', ['民'], undefined, 'JPY');
  const noRate = await add(cNil.T, body(cNil, '匯入的舊帳', D8));
  eq('先正常記一筆 → 201', noRate.status, 201);
  const nid = noRate.json.id as string;
  check('把它的匯率欄位挖成 NULL',
    d1Write(`UPDATE expenses SET fx_rate = NULL, fx_rate_date = NULL, fx_rate_source = NULL
             WHERE id = ?`, nid));
  eq('確認現在是 null', (await one(cNil.T, nid))?.fx_rate ?? null, null);

  eq('只改說明 → 200', (await edit(cNil.T, nid, body(cNil, '匯入的舊帳(改了說明)', D8))).status, 200);
  const filled = await one(cNil.T, nid);
  eq('本來是 null → 這次補上了', filled?.fx_rate, NEW_RATE);
  eq('補的是消費當日該拿的那一列(3/8)', filled?.fx_rate_date, D8);
  eq('來源也一起補上', filled?.fx_rate_source, SRC8);

  // 注入的假匯率不留在本機 D1 裡 —— 下一支測試、下一次開發都不該看到它
  check('清掉注入的匯率', clearRates());
}

process.exit(summary() > 0 ? 1 : 0);
