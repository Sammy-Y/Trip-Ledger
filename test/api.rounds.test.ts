/**
 * 結算回合(settlement rounds)的 API 整合測試。打真實 dev server + 真實本機 D1,不 mock。
 *
 *   pnpm dev            # 另一個終端
 *   node --experimental-strip-types test/api.rounds.test.ts
 *
 * ══ 這支測試在防守什麼 ═══════════════════════════════════════════
 *
 * 結算回合唯一難的地方是**算術範圍和明細範圍不一樣**(見 server/utils/ledger.ts):
 *
 *   算術範圍(誰給誰多少)= 整趟到目前為止的所有帳,公費算完整成員
 *   明細範圍(列表列哪幾筆)= 只有 settlement_round_id IS NULL 的那些
 *
 * 「只把沒標記的帳拿來算」是直覺但**會算錯錢**的做法:settlement 這一列
 * 沒有任何欄位指向它清掉的是哪一筆債,所以算術範圍只要是真子集,
 * 就會出現「還款被算進來、對應的債在範圍外」→ 同一筆錢被要求付兩次。
 *
 * 所以這裡的每一組都斷言**金額**,不只斷言 status code 或筆數 ——
 * 子集算術的 bug 全部會回 200/201,只是數字是錯的。
 * 各組尤其在盯:
 *
 *   ① 公費永遠不會被結算清空(deferred 絕不寫入)
 *   ② 大家投進信封的錢算在他們自己頭上 —— 先付過錢的人不會被算成欠錢
 *      (淨額含投入 / 退還,見 server/utils/ledger.ts)
 *   ③ 使用者自己記的還款會被吸收,不會吐出反方向的轉帳(付款/反轉無限來回)
 *   ④ 連續兩回合不會互相反轉
 *   ⑤ 撤銷是精確的反運算,而且不會消滅手動記的還款
 *
 * 每一組都自己建一趟新旅程 —— 組跟組之間不能互相干擾,
 * 因為算術範圍是「整趟」,任何殘留的帳都會污染下一組的數字。
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
const session = await loginFixture(base, 'rounds');
const req = session.req;
const get = (p: string) => req('GET', p);
const post = (p: string, b?: unknown) => req('POST', p, b);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);
const del = (p: string) => req('DELETE', p);

await post('/api/admin/sync-rates');

// ═══════════════════════════════════════════════════════════════
// 直接讀本機 D1 —— 有些斷言用 API 表達不出來
// ═══════════════════════════════════════════════════════════════
//
// 「這次結算在 settlements 裡寫了幾列」只能去數列。用 API 反推的話,
// 「一列都沒寫」和「寫了兩列剛好互相抵銷」在餘額上長得完全一樣 ——
// 而後者是公費被清空的那個 bug 的樣子,正是這支測試要抓的東西。
//
// dev server(nitro-cloudflare-dev / miniflare)用的就是 .wrangler 底下那個
// sqlite 檔。WAL 模式,另開一條唯讀連線去數是安全的。
// 找不到檔案時不假裝通過:相關斷言會直接標記失敗並說明原因。
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
console.log(D1_PATH ? `本機 D1: ${D1_PATH}` : '⚠ 找不到本機 D1 檔案 —— 需要數列的斷言會失敗');

function d1All<T = J>(sql: string, ...args: Array<string | number | null>): T[] | null {
  if (!D1_PATH) return null;
  const dbh = new DatabaseSync(D1_PATH, { readOnly: true });
  try { return dbh.prepare(sql).all(...args) as T[]; }
  catch (e) { console.log(`  (D1 讀取失敗:${String(e)})`); return null; }
  finally { dbh.close(); }
}
/** 寫入本機 D1 —— 只用在「注入壞資料」的那一組,模擬被手動 SQL 改壞的資料庫。 */
function d1Write(sql: string, ...args: Array<string | number | null>): boolean {
  if (!D1_PATH) return false;
  const dbh = new DatabaseSync(D1_PATH);
  try { dbh.prepare(sql).run(...args); return true; }
  catch (e) { console.log(`  (D1 寫入失敗:${String(e)})`); return false; }
  finally { dbh.close(); }
}

/** settlements 的列數。source 給了就只數那一種('round' / 'manual')。 */
function countSettlements(tripId: string, source?: 'round' | 'manual'): number | null {
  const rows = d1All<{ n: number }>(
    `SELECT COUNT(*) AS n FROM settlements WHERE trip_id = ?1 AND (?2 IS NULL OR source = ?2)`,
    tripId, source ?? null);
  return rows ? rows[0]!.n : null;
}
/** 這趟所有 settlement 的 id(排序過)—— 撤銷要能證明是精確的反運算。 */
function settlementIds(tripId: string): string[] | null {
  const rows = d1All<{ id: string }>(`SELECT id FROM settlements WHERE trip_id = ?`, tripId);
  return rows ? rows.map((r) => r.id).sort() : null;
}
function roundSettlementCurrencies(tripId: string): string[] | null {
  const rows = d1All<{ currency: string }>(
    `SELECT DISTINCT currency FROM settlements WHERE trip_id = ? AND source = 'round'`, tripId);
  return rows ? rows.map((r) => r.currency).sort() : null;
}

// ═══════════════════════════════════════════════════════════════
// 共用小工具
// ═══════════════════════════════════════════════════════════════
type Ctx = { T: string; tripId: string; id: Record<string, string>; name: (mid: string) => string };

async function mkTrip(label: string, members: string[], pot?: string): Promise<Ctx> {
  const r = await post('/api/trips', {
    name: `${label} ${Date.now()}`, base_currency: 'TWD', members,
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

/** 共同支出。日期與付款方式給預設值,呼叫端只寫真正在意的欄位。 */
const shared = (T: string, body: J) => post(`/api/trips/${T}/expenses`, {
  kind: 'shared', payment_method: 'cash', spent_at: '2026-03-08', ...body,
});
const potMoves = (T: string, body: J) => post(`/api/trips/${T}/pot/moves`, body);

async function preview(T: string, currency: string) {
  const r = await get(`/api/trips/${T}/rounds/preview?currency=${currency}`);
  const b = ((r.json.blocks ?? []) as J[]).find((x) => x.currency === currency);
  return { status: r.status, json: r.json, b: b ?? ({} as J) };
}

/** 轉帳清單攤成 ['喧→民 2000'] —— 方向和金額一次斷言完,而且看得懂 */
const fmt = (ts: J[] | undefined, ctx: Ctx) =>
  (ts ?? []).map((t) => `${ctx.name(t.from)}→${ctx.name(t.to)} ${t.amountMinor}`).sort();

/** 淨額(含公費)。map 起來方便逐人斷言。 */
async function netsOf(T: string, currency: string) {
  const bal = await get(`/api/trips/${T}/balance`);
  const nets = (bal.json.by_currency?.[currency]?.nets ?? []) as J[];
  return {
    bal: bal.json,
    map: new Map<string, number>(nets.map((n) => [n.memberId, n.netMinor])),
    rows: nets,
    sum: nets.reduce((s, n) => s + n.netMinor, 0),
  };
}
const potBlock = (bal: J, currency: string) =>
  ((bal.pot?.by_currency ?? []) as J[]).find((r) => r.currency === currency);

async function stampMap(T: string) {
  const r = await get(`/api/trips/${T}/expenses?kind=shared`);
  const m = new Map<string, string | null>();
  for (const e of (r.json as J[]) ?? []) m.set(e.description, e.settlement_round_id ?? null);
  return m;
}

// ═══════════════════════════════════════════════════════════════
group('[1] 沒有公費的正常流程:算對、蓋章、不能結第二次');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('R1 三人晚餐', ['民', '喧', '華']);
  const dinner = await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  });
  eq('民付晚餐 ¥6,000 → 201', dinner.status, 201);

  const pv = await preview(c.T, 'JPY');
  eq('預覽 → 200', pv.status, 200);
  eq('公費是 null(這趟沒設)', pv.json.pot_id, null);
  eq('明細一筆', pv.b.item_count, 1);
  eq('明細就是那筆晚餐', pv.b.items?.[0]?.description, '晚餐');
  eq('付款人是民、金額全額 6000',
    (pv.b.items?.[0]?.payers ?? []).map((p: J) => `${c.name(p.member_id)} ${p.amount_minor}`), ['民 6000']);
  eq('三人各分攤 2000',
    (pv.b.items?.[0]?.shares ?? []).map((s: J) => `${c.name(s.member_id)} ${s.amount_minor}`).sort(),
    ['喧 2000', '民 2000', '華 2000']);
  // 這一組的重點:兩筆各 2000 流向民,不是一筆 4000,也不是 3000
  eq('轉帳:兩筆 ¥2,000 都流向民', fmt(pv.b.recorded, c), ['喧→民 2000', '華→民 2000']);
  // 「空」的斷言要先確認欄位真的存在,否則欄位整個不見時會空過去
  check('deferred 是一個陣列', Array.isArray(pv.b.deferred), JSON.stringify(pv.b.deferred));
  eq('沒有公費 → deferred 空', pv.b.deferred?.length, 0);
  eq('這次是第 1 回合', pv.b.seq, 1);
  eq('資料健康 → 不擋', pv.b.blocked_reason, null);
  eq('還沒結完', pv.json.all_settled, false);

  const closed = await post(`/api/trips/${c.T}/rounds`, {
    currency: 'JPY', label: '第一晚',
    expect: { item_count: pv.b.item_count, recorded_count: pv.b.recorded.length },
  });
  eq('關閉回合 → 201', closed.status, 201);
  eq('seq = 1', closed.json.seq, 1);
  eq('列入 1 筆明細', closed.json.item_count, 1);
  eq('寫下兩筆 ¥2,000', fmt(closed.json.recorded, c), ['喧→民 2000', '華→民 2000']);
  eq('實際寫進 settlements 的是 2 列', countSettlements(c.tripId, 'round'), 2);

  const after = await netsOf(c.T, 'JPY');
  eq('結算後淨額全部歸零', after.rows.filter((n) => n.netMinor !== 0).length, 0);
  eq('淨額總和 0', after.sum, 0);

  const stamps = await stampMap(c.T);
  eq('晚餐被蓋上這次的 round id', stamps.get('晚餐'), closed.json.id);

  const pv2 = await preview(c.T, 'JPY');
  eq('第二次預覽:沒有未結明細', pv2.b.item_count, 0);
  eq('第二次預覽:沒有待轉帳', pv2.b.recorded?.length, 0);
  eq('all_settled 變 true', pv2.json.all_settled, true);

  const again = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('沒東西可結還要結 → 409', again.status, 409);
  check('訊息說明沒有要結的東西', String(again.json.statusMessage ?? '').includes('沒有需要結算'),
    String(again.json.statusMessage));
  eq('沒有多寫任何轉帳', countSettlements(c.tripId, 'round'), 2);
}

// ═══════════════════════════════════════════════════════════════
group('[2] 公費付掉的支出不產生任何人對人的債(招牌案例)');
// ═══════════════════════════════════════════════════════════════
//
// 兩人各投 ¥10,000(信封 20,000),公費付掉 ¥10,000 兩人均分。
//
// 使用者的模型:公費付的錢在**記帳當下**就從信封扣掉了,不追究是誰用的。
// 所以這一趟沒有人自己墊過錢 ⇒ 人對人那一本是空的 ⇒ 誰都不用轉帳給誰。
// 信封剩 20,000 − 10,000 = 10,000,結束時退還(分法由使用者決定)。
//
// 壞掉的兩種樣子都要擋住:
//   ① 把公費付的支出算進人對人 → 兩個人被算成「應付 −5,000」,
//      而他們早就各投了 1 萬進去。這是使用者親自回報的那個 bug。
//   ② 把公費當成成員一起算 → 它的腿被寫進 settlements = 第一晚就把信封清空,
//      而那筆錢明天還要用。
{
  const c = await mkTrip('R2 公費付的不生債', ['民', '喧'], '公費');
  const moves = await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 10000 }, { member_id: c.id['喧'], amount_minor: 10000 }],
  });
  eq('兩人各投入 ¥10,000 → 201', moves.status, 201);
  eq('總投入 ¥20,000', moves.json.total_minor, 20000);

  for (const [desc, amt] of [['晚餐', 6000], ['門票', 4000]] as const) {
    const r = await shared(c.T, {
      description: desc, currency: 'JPY', amount: amt,
      payers: [{ member_id: c.id['公費'] }],
      split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
    });
    eq(`公費付${desc} ¥${amt} → 201`, r.status, 201);
  }

  const pv = await preview(c.T, 'JPY');
  eq('預覽認得出公費', pv.json.pot_id, c.id['公費']);
  // 明細照列 —— 那是「這一輪看過哪幾筆」,和算術是兩個不同的範圍。
  eq('明細兩筆', pv.b.item_count, 2);
  // 招牌斷言:人對人那一本整個是空的。
  eq('淨額是空的(沒有人自己墊過錢)', pv.b.nets?.length, 0);
  eq('recorded 是空的', fmt(pv.b.recorded, c), []);
  eq('deferred 也是空的(公費根本不在算術裡)', fmt(pv.b.deferred, c), []);

  const before = await netsOf(c.T, 'JPY');
  const potBefore = JSON.stringify(potBlock(before.bal, 'JPY'));
  check('公費不在淨額裡', !before.map.has(c.id['公費']), JSON.stringify(before.rows));
  eq('結算前 沒有任何人有未結的淨額', before.rows.length, 0);
  eq('結算前 settlements 只有兩筆投入', countSettlements(c.tripId), 2);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  eq('seq = 1', closed.json.seq, 1);
  eq('回合寫下的轉帳:0 筆', closed.json.recorded?.length, 0);
  eq('沒有任何公費的腿', closed.json.deferred?.length, 0);

  // 這是「公費沒有被清空」的直接證據:source='round' 一列都沒寫
  eq('settlements 沒有任何 source=round 的列', countSettlements(c.tripId, 'round'), 0);
  eq('settlements 總數還是 2(只有那兩筆投入)', countSettlements(c.tripId), 2);

  const after = await netsOf(c.T, 'JPY');
  eq('公費收支完全沒被動到(逐位元相同)', JSON.stringify(potBlock(after.bal, 'JPY')), potBefore);
  const pb = potBlock(after.bal, 'JPY');
  eq('投入 ¥20,000', pb?.contributedMinor, 20000);
  eq('已支出 ¥10,000', pb?.spentMinor, 10000);
  eq('已退還 ¥0', pb?.refundedMinor, 0);
  eq('信封剩 ¥10,000', pb?.remainingMinor, 10000);
  // 信封那三個量**自己說得出剩餘**,不需要看任何人的淨額 —— 那就是兩本帳的意思。
  eq('剩餘 = 投入 − 花掉 − 退還',
    (pb?.contributedMinor ?? 0) - (pb?.spentMinor ?? 0) - (pb?.refundedMinor ?? 0),
    pb?.remainingMinor);

  // 蓋章照樣要蓋 —— 明細已經看過了,下次預覽不該再列出來
  const stamps = await stampMap(c.T);
  eq('晚餐蓋章', stamps.get('晚餐'), closed.json.id);
  eq('門票蓋章', stamps.get('門票'), closed.json.id);
  const pv2 = await preview(c.T, 'JPY');
  eq('下次預覽沒有未結明細', pv2.b.item_count, 0);
}

// ═══════════════════════════════════════════════════════════════
group('[3] 出資不平均:那件事完全不出現在結算裡');
// ═══════════════════════════════════════════════════════════════
//
// 民 投入公費 ¥20,000、喧 一毛沒投 —— 但那是**信封那一本**的事。
// 人對人那一本只看誰自己墊過錢:這裡是 喧 墊了晚餐 ¥6,000 兩人均分,
// 所以 民 欠 喧 ¥3,000,**跟誰投了多少公費一點關係都沒有**。
//
// 這一組的重點就是那個「一點關係都沒有」:
// 民 投了 2 萬、喧 投了 0,而結算的數字裡完全找不到這件事。
{
  const c = await mkTrip('R3 出資不平均', ['民', '喧'], '公費');
  eq('民投入 ¥20,000、喧 投 0 → 201',
    (await potMoves(c.T, {
      direction: 'in', currency: 'JPY',
      entries: [{ member_id: c.id['民'], amount_minor: 20000 }],
    })).status, 201);

  eq('公費付包車 ¥10,000 → 201', (await shared(c.T, {
    description: '包車', currency: 'JPY', amount: 10000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  eq('喧自己墊晚餐 ¥6,000 兩人均分 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  // 只有晚餐那一筆進算術。包車(公費付的)和那 20,000 投入都不在裡面。
  eq('淨額:喧 +3,000(他墊 6,000 − 自己分攤 3,000)',
    pv.b.nets?.find((n: J) => n.memberId === c.id['喧'])?.netMinor, 3000);
  eq('淨額:民 −3,000', pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, -3000);
  check('公費不在淨額裡', !(pv.b.nets ?? []).some((n: J) => n.memberId === c.id['公費']),
    JSON.stringify(pv.b.nets));
  eq('淨額總和 0', (pv.b.nets ?? []).reduce((s: number, n: J) => s + n.netMinor, 0), 0);
  eq('明細兩筆(公費付的那筆也要列,它一樣要蓋章)', pv.b.item_count, 2);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  eq('recorded:民→喧 ¥3,000', fmt(closed.json.recorded, c), ['民→喧 3000']);
  eq('沒有任何公費的腿', fmt(closed.json.deferred, c), []);
  eq('寫了 1 列 source=round', countSettlements(c.tripId, 'round'), 1);

  const after = await netsOf(c.T, 'JPY');
  const pb = potBlock(after.bal, 'JPY');
  eq('公費投入還是 ¥20,000', pb?.contributedMinor, 20000);
  eq('公費剩餘 = 20,000 − 10,000 = 10,000(結算沒碰信封)', pb?.remainingMinor, 10000);
  eq('結算後人對人全歸零', after.rows.length, 0);

  // ── 那 20,000 的出資不均去哪了 ────────────────────────────────
  // 它留在信封裡。旅程結束時退還多少給誰**由使用者自己決定**
  // (總覽頁的退還可以勾人、平分、或逐人填金額)——
  // 系統不替他假設「投多的人該拿多少回去」。
  eq('民 投入的那 20,000 一分不少還在信封的帳上', pb?.contributedMinor, 20000);
  eq('喧 沒有投入紀錄', (pb?.contributions ?? []).filter((x: J) => x.memberId === c.id['喧']).length, 0);
}

// ═══════════════════════════════════════════════════════════════
group('[4] 公費退還過某人之後,人對人那一本仍然不受影響');
// ═══════════════════════════════════════════════════════════════
//
// 兩人各投 ¥5,000,民 自己墊了晚餐 ¥6,000 兩人均分,
// 然後公費退還民 ¥6,000(等於信封把他墊的錢補給他)。
//
// 退還是把現金從信封搬回某個人手上,**不是還款** —— 所以它不能改變
// 「喧 欠 民 3,000」這件事。那 3,000 是 喧 在晚餐裡的分攤,
// 和信封退了多少給民完全無關。
{
  const c = await mkTrip('R4 公費退還', ['民', '喧'], '公費');
  eq('兩人各投入 ¥5,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 5000 }, { member_id: c.id['喧'], amount_minor: 5000 }],
  })).status, 201);

  eq('民自己墊晚餐 ¥6,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const beforeRefund = await netsOf(c.T, 'JPY');
  eq('退還前:民 +3,000 / 喧 −3,000',
    [beforeRefund.map.get(c.id['民']), beforeRefund.map.get(c.id['喧'])], [3000, -3000]);

  eq('公費把 ¥6,000 還給民 → 201', (await potMoves(c.T, {
    direction: 'out', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 6000 }],
    note: '公費補墊款',
  })).status, 201);

  // 核心斷言:退還之後淨額**逐位元**不變。
  const afterRefund = await netsOf(c.T, 'JPY');
  eq('退還之後淨額逐位元不變',
    JSON.stringify(afterRefund.bal.by_currency?.JPY?.nets ?? []),
    JSON.stringify(beforeRefund.bal.by_currency?.JPY?.nets ?? []));

  const pv = await preview(c.T, 'JPY');
  eq('明細還是列著那筆晚餐', pv.b.item_count, 1);
  eq('recorded:喧→民 ¥3,000', fmt(pv.b.recorded, c), ['喧→民 3000']);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  eq('人的帳:喧→民 ¥3,000', fmt(closed.json.recorded, c), ['喧→民 3000']);
  eq('寫了 1 列 source=round', countSettlements(c.tripId, 'round'), 1);
  eq('沒有任何公費的腿', fmt(closed.json.deferred, c), []);

  const after = await netsOf(c.T, 'JPY');
  const pb = potBlock(after.bal, 'JPY');
  eq('公費花費 ¥0(那筆晚餐是民墊的,不是公費付的)', pb?.spentMinor, 0);
  eq('公費剩餘 ¥4,000(10,000 投入 − 6,000 退還)', pb?.remainingMinor, 4000);
  eq('人對人結清了', after.rows.length, 0);
  eq('晚餐蓋章了', (await stampMap(c.T)).get('晚餐'), closed.json.id);

  // ── 把錢走完:每個人實際掏出多少 ────────────────────────────
  // 民:投 5,000 + 墊 6,000 − 領回 6,000 − 收喧 3,000 = 2,000
  // 喧:投 5,000 + 付民 3,000 = 8,000
  // 兩人差 6,000,而信封裡剛好躺著 4,000 加上民多領的… 這一段由使用者
  // 在總覽頁的退還自己決定怎麼分,系統不替他假設(見 [3] 的說明)。
  eq('信封還剩 ¥4,000 等著被退還', pb?.remainingMinor, 4000);
  eq('投入:各 ¥5,000',
    (pb?.contributions ?? []).map((x: J) => `${c.name(x.memberId)} ${x.amountMinor}`).sort(),
    ['喧 5000', '民 5000']);
  eq('退還:民 ¥6,000', (pb?.refunds ?? []).map((x: J) => `${c.name(x.memberId)} ${x.amountMinor}`),
    ['民 6000']);
}

// ═══════════════════════════════════════════════════════════════
group('[5] 使用者自己記的還款會被吸收,不會吐出反方向的轉帳');
// ═══════════════════════════════════════════════════════════════
//
// 使用者照結算頁的建議付了錢、按了「標記已還款」。這時候關回合,
// 子集算術會看到「計程車 ¥3,000 尚未結」卻看不到那筆還款,
// 於是再開一張 喧→民 ¥1,500 —— 使用者再付一次,下一回合又吐出反方向的
// 民→喧 ¥1,500,付款/反轉無限來回。
{
  const c = await mkTrip('R5 吸收手動還款', ['民', '喧']);
  eq('民墊計程車 ¥3,000 → 201', (await shared(c.T, {
    description: '計程車', currency: 'JPY', amount: 3000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const repay = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'],
    currency: 'JPY', amount_minor: 1500, note: '現場給現金',
  });
  eq('喧當場還了 ¥1,500 → 201', repay.status, 201);

  const pv = await preview(c.T, 'JPY');
  eq('明細還在(還沒關回合)', pv.b.item_count, 1);
  eq('已經兩不相欠 → recorded 空', fmt(pv.b.recorded, c), []);
  eq('淨額全歸零', (pv.b.nets ?? []).length, 0);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  const rec = (closed.json.recorded ?? []) as J[];
  check('回合有回傳 recorded 陣列', Array.isArray(closed.json.recorded), JSON.stringify(closed.json.recorded));
  eq('回合沒有寫下任何轉帳', fmt(rec, c), []);
  check('特別確認:沒有 民→喧 的反向轉帳',
    rec.every((t) => t.from !== c.id['民']), JSON.stringify(fmt(rec, c)));
  eq('settlements 還是只有那筆手動還款', countSettlements(c.tripId), 1);
  eq('手動那筆還在', countSettlements(c.tripId, 'manual'), 1);
  eq('計程車仍然要蓋章', (await stampMap(c.T)).get('計程車'), closed.json.id);
}

// ═══════════════════════════════════════════════════════════════
group('[6] 連續兩回合不會互相反轉');
// ═══════════════════════════════════════════════════════════════
//
// R1 寫下 喧→民 ¥3,000。R2 只該處理新的計程車 ¥2,000 的那一半 = ¥1,000。
// 若第二回合把 R1 的轉帳當成「一筆還沒對應的還款」吸收掉,
// 會算出 民→喧 ¥3,000(把第一回合整個反轉),那是明顯錯誤的數字。
{
  const c = await mkTrip('R6 連續兩回合', ['民', '喧']);
  eq('民付晚餐 ¥6,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const r1 = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY', label: '第一晚' });
  eq('R1 → 201', r1.status, 201);
  eq('R1 seq = 1', r1.json.seq, 1);
  eq('R1 寫下 喧→民 ¥3,000', fmt(r1.json.recorded, c), ['喧→民 3000']);

  eq('喧付計程車 ¥2,000 → 201', (await shared(c.T, {
    description: '計程車', currency: 'JPY', amount: 2000,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const pv2 = await preview(c.T, 'JPY');
  eq('R2 明細只有新的那筆', (pv2.b.items ?? []).map((i: J) => i.description), ['計程車']);
  eq('R2 預覽:民→喧 ¥1,000', fmt(pv2.b.recorded, c), ['民→喧 1000']);

  const r2 = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('R2 → 201', r2.status, 201);
  eq('R2 seq = 2', r2.json.seq, 2);
  // ¥3,000 出現在這裡就是「第二回合把第一回合反轉了」
  eq('R2 只寫 民→喧 ¥1,000(計程車的一半)', fmt(r2.json.recorded, c), ['民→喧 1000']);
  eq('兩回合合計寫了 2 列', countSettlements(c.tripId, 'round'), 2);

  const after = await netsOf(c.T, 'JPY');
  eq('兩回合之後全部歸零', after.rows.filter((n) => n.netMinor !== 0).length, 0);

  const list = await get(`/api/trips/${c.T}/rounds`);
  eq('歷史兩筆', (list.json as J[]).length, 2);
  eq('每筆各列入 1 筆明細', (list.json as J[]).map((r) => r.item_count), [1, 1]);
}

// ═══════════════════════════════════════════════════════════════
group('[7] 撤銷是精確的反運算');
// ═══════════════════════════════════════════════════════════════
//
// 誤按結算是會發生的事。撤銷之後整個帳本必須回到按下去之前的狀態 ——
// 逐位元相同,不是「差不多」。
{
  const c = await mkTrip('R7 撤銷', ['民', '喧'], '公費');
  eq('民獨力投入 ¥10,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 10000 }],
  })).status, 201);
  eq('公費付晚餐 ¥6,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  // ⚠️ 計程車是 ¥8,000:這一組要測「撤銷會刪掉轉帳」,所以 recorded 不能是空的。
  // 公費付的晚餐不進算術(見 utils/ledger.ts),投入也不進 ——
  // 唯一會長出人對人那條腿的就是這筆民自己墊的車錢。
  eq('民墊計程車 ¥8,000 → 201', (await shared(c.T, {
    description: '計程車', currency: 'JPY', amount: 8000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const balBefore = JSON.stringify((await get(`/api/trips/${c.T}/balance`)).json);
  const idsBefore = settlementIds(c.tripId);
  eq('結算前只有那筆投入', idsBefore?.length, 1);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  // 只有計程車進算術:民 墊 8,000 − 自己分攤 4,000 = +4,000,喧 −4,000。
  // 投入的 10,000 和公費付的 6,000 都不在裡面。
  eq('寫下 喧→民 ¥4,000', fmt(closed.json.recorded, c), ['喧→民 4000']);
  eq('沒有任何公費的腿', fmt(closed.json.deferred, c), []);
  eq('結算後多了一列', settlementIds(c.tripId)?.length, 2);
  const stampedNow = await stampMap(c.T);
  eq('晚餐蓋章', stampedNow.get('晚餐'), closed.json.id);
  eq('計程車蓋章', stampedNow.get('計程車'), closed.json.id);

  const reverted = await del(`/api/trips/${c.T}/rounds/${closed.json.id}`);
  eq('撤銷 → 200', reverted.status, 200);
  eq('刪掉 1 筆轉帳', reverted.json.removed_transfers, 1);
  eq('拆掉 2 筆蓋章', reverted.json.unstamped_items, 2);

  // 這一條是整組的重點:撤銷之後帳本要逐位元回到原狀
  eq('balance JSON 與結算前完全相同',
    JSON.stringify((await get(`/api/trips/${c.T}/balance`)).json), balBefore);
  eq('settlement id 清單回到原狀', settlementIds(c.tripId), idsBefore);

  const stampsAfter = await stampMap(c.T);
  eq('晚餐的章拆掉了', stampsAfter.get('晚餐'), null);
  eq('計程車的章拆掉了', stampsAfter.get('計程車'), null);
  const pvAfter = await preview(c.T, 'JPY');
  eq('撤銷後兩筆明細又回到未結清單', pvAfter.b.item_count, 2);
  eq('撤銷後又建議 喧→民 ¥4,000', fmt(pvAfter.b.recorded, c), ['喧→民 4000']);

  const twice = await del(`/api/trips/${c.T}/rounds/${closed.json.id}`);
  eq('撤銷第二次 → 409', twice.status, 409);
  check('訊息說已經撤銷過', String(twice.json.statusMessage ?? '').includes('撤銷'),
    String(twice.json.statusMessage));
  eq('第二次撤銷沒有動到任何 settlement', settlementIds(c.tripId), idsBefore);

  const hist = await get(`/api/trips/${c.T}/rounds`);
  eq('撤銷過的回合仍然留在歷史裡', (hist.json as J[]).length, 1);
  check('reverted_at 有值', !!(hist.json as J[])[0]?.reverted_at, String((hist.json as J[])[0]?.reverted_at));
  eq('撤銷後那個回合的明細數歸零', (hist.json as J[])[0]?.item_count, 0);
  eq('撤銷後那個回合的轉帳數歸零', (hist.json as J[])[0]?.transfer_count, 0);

  // 撤銷之後還可以重新結一次(seq 會往下走,不會重用 1)
  const again = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('撤銷後重新結算 → 201', again.status, 201);
  eq('seq 前進到 2(撤銷不回收序號)', again.json.seq, 2);
  eq('重結的金額一樣是 喧→民 ¥4,000', fmt(again.json.recorded, c), ['喧→民 4000']);
}

// ═══════════════════════════════════════════════════════════════
group('[8] 撤銷絕不刪掉手動記的還款');
// ═══════════════════════════════════════════════════════════════
//
// 使用者自己按「標記已還款」的那筆、以及投入公費的那些,都是**真的發生過的付款**。
// 撤銷回合只該收回回合自己寫的列(source='round')。
// 一起刪掉的話,錢已經付出去了、帳上卻說還沒付。
{
  const c = await mkTrip('R8 撤銷不刪手動', ['民', '喧']);
  eq('民付晚餐 ¥6,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const adhoc = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'],
    currency: 'JPY', amount_minor: 1000, note: '先給一千',
  });
  eq('喧先還 ¥1,000 → 201', adhoc.status, 201);
  eq('手動列 1 筆', countSettlements(c.tripId, 'manual'), 1);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  eq('回合寫下剩下的 喧→民 ¥2,000', fmt(closed.json.recorded, c), ['喧→民 2000']);
  eq('回合列 1 筆', countSettlements(c.tripId, 'round'), 1);
  eq('手動列還是 1 筆', countSettlements(c.tripId, 'manual'), 1);

  eq('撤銷 → 200', (await del(`/api/trips/${c.T}/rounds/${closed.json.id}`)).status, 200);
  eq('回合列被收回', countSettlements(c.tripId, 'round'), 0);
  // 這就是整組的重點
  eq('手動那筆還在(撤銷不碰它)', countSettlements(c.tripId, 'manual'), 1);
  eq('那筆手動還款的 id 沒變', settlementIds(c.tripId), [adhoc.json.id]);

  const after = await netsOf(c.T, 'JPY');
  eq('撤銷後 民 +2,000(6,000 墊 − 3,000 分攤 − 1,000 已收)', after.map.get(c.id['民']), 2000);
  eq('撤銷後 喧 −2,000', after.map.get(c.id['喧']), -2000);
}

// ═══════════════════════════════════════════════════════════════
group('[9] 舊畫面防護:內容變了就不准照舊指紋結算');
// ═══════════════════════════════════════════════════════════════
//
// 兩支手機同時操作。A 看到「1 筆明細、1 筆轉帳」的畫面,
// B 這時候記了一筆帳。A 按下結算的話,他結掉的內容不是他看到的內容 ——
// 擋下來,叫他重新看一次。而且**什麼都不能寫**,不能寫一半。
{
  const c = await mkTrip('R9 舊畫面', ['民', '喧']);
  eq('民付晚餐 ¥6,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  const stale = { item_count: pv.b.item_count, recorded_count: pv.b.recorded.length };
  eq('看到的畫面是 1 筆明細', stale.item_count, 1);
  eq('看到的畫面是 1 筆轉帳', stale.recorded_count, 1);

  eq('另一支手機又記了一筆 → 201', (await shared(c.T, {
    description: '宵夜', currency: 'JPY', amount: 1000,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const blocked = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY', expect: stale });
  eq('照舊指紋結算 → 409', blocked.status, 409);
  check('訊息叫他重新整理', String(blocked.json.statusMessage ?? '').includes('重新整理'),
    String(blocked.json.statusMessage));

  // 被擋掉就是什麼都沒寫 —— 半套狀態比擋不住更難查
  eq('沒有建立任何回合', ((await get(`/api/trips/${c.T}/rounds`)).json as J[]).length, 0);
  eq('沒有寫任何 settlement', countSettlements(c.tripId), 0);
  const stamps = await stampMap(c.T);
  eq('晚餐沒被蓋章', stamps.get('晚餐'), null);
  eq('宵夜沒被蓋章', stamps.get('宵夜'), null);

  // 用新的指紋就能過
  const pv2 = await preview(c.T, 'JPY');
  const ok = await post(`/api/trips/${c.T}/rounds`, {
    currency: 'JPY', expect: { item_count: pv2.b.item_count, recorded_count: pv2.b.recorded.length },
  });
  eq('重新看一次再結 → 201', ok.status, 201);
  eq('這次列入 2 筆', ok.json.item_count, 2);
  eq('金額是 喧→民 ¥2,500', fmt(ok.json.recorded, c), ['喧→民 2500']);
}

// ═══════════════════════════════════════════════════════════════
group('[10] 已列入結算的支出不准刪');
// ═══════════════════════════════════════════════════════════════
//
// 那筆帳已經被算進當時的轉帳、而且錢已經照那個數字付出去了。
// 直接刪掉會讓那次結算的明細指向一筆不存在的支出,
// 事後就回答不出「這 ¥3,000 是怎麼來的」。
{
  const c = await mkTrip('R10 蓋章不准刪', ['民', '喧']);
  const dinner = await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('民付晚餐 → 201', dinner.status, 201);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);

  const blocked = await del(`/api/trips/${c.T}/expenses/${dinner.json.id}`);
  eq('刪已蓋章的支出 → 409', blocked.status, 409);
  check('訊息說要先撤銷結算', String(blocked.json.statusMessage ?? '').includes('撤銷'),
    String(blocked.json.statusMessage));
  check('訊息指出是第幾次結算', String(blocked.json.statusMessage ?? '').includes('第 1 次'),
    String(blocked.json.statusMessage));
  eq('真的沒被刪掉', (await stampMap(c.T)).get('晚餐'), closed.json.id);

  // 回合之後才記的那筆還沒蓋章 → 照樣可以刪
  const late = await shared(c.T, {
    description: '宵夜', currency: 'JPY', amount: 1000,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('回合之後再記一筆 → 201', late.status, 201);
  eq('刪沒蓋章的支出 → 200', (await del(`/api/trips/${c.T}/expenses/${late.json.id}`)).status, 200);
  check('宵夜真的不見了', !(await stampMap(c.T)).has('宵夜'));

  eq('撤銷那次結算 → 200', (await del(`/api/trips/${c.T}/rounds/${closed.json.id}`)).status, 200);
  eq('撤銷後同一筆就刪得掉 → 200',
    (await del(`/api/trips/${c.T}/expenses/${dinner.json.id}`)).status, 200);
  check('晚餐真的不見了', !(await stampMap(c.T)).has('晚餐'));
}

// ═══════════════════════════════════════════════════════════════
group('[11] 幣別彼此隔離:結日幣不會動到台幣');
// ═══════════════════════════════════════════════════════════════
//
// 一個按鈕同時結掉日幣和台幣,會寫下「其實沒有發生過」的台幣轉帳
// (當晚桌上只有日幣現金在動)。seq 也是逐幣別各自從 1 開始。
{
  const c = await mkTrip('R11 幣別隔離', ['民', '喧']);
  eq('民付日幣晚餐 ¥6,000 → 201', (await shared(c.T, {
    description: '晚餐(日幣)', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('喧付台幣機場接送 NT$600 → 201', (await shared(c.T, {
    description: '接送(台幣)', currency: 'TWD', amount: 600,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const all = await get(`/api/trips/${c.T}/rounds/preview`);
  eq('不給幣別 → 兩個區塊', all.json.currencies, ['JPY', 'TWD']);
  const jpy0 = (all.json.blocks as J[]).find((b) => b.currency === 'JPY');
  const twd0 = (all.json.blocks as J[]).find((b) => b.currency === 'TWD');
  eq('日幣建議 喧→民 ¥3,000', fmt(jpy0?.recorded, c), ['喧→民 3000']);
  eq('台幣建議 民→喧 NT$300(30000 分)', fmt(twd0?.recorded, c), ['民→喧 30000']);

  const jpyRound = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('只結日幣 → 201', jpyRound.status, 201);
  eq('日幣 seq = 1', jpyRound.json.seq, 1);
  eq('日幣列入 1 筆', jpyRound.json.item_count, 1);
  eq('只寫日幣那一筆轉帳', fmt(jpyRound.json.recorded, c), ['喧→民 3000']);
  // 只能有日幣的 settlement 被寫出來
  eq('source=round 的列只有 JPY', roundSettlementCurrencies(c.tripId), ['JPY']);
  eq('source=round 共 1 列', countSettlements(c.tripId, 'round'), 1);

  const stamps = await stampMap(c.T);
  eq('日幣那筆蓋章', stamps.get('晚餐(日幣)'), jpyRound.json.id);
  eq('台幣那筆完全沒被蓋章', stamps.get('接送(台幣)'), null);

  const after = await get(`/api/trips/${c.T}/rounds/preview`);
  const jpy1 = (after.json.blocks as J[]).find((b) => b.currency === 'JPY');
  const twd1 = (after.json.blocks as J[]).find((b) => b.currency === 'TWD');
  eq('日幣沒有未結明細了', jpy1?.item_count, 0);
  eq('日幣不再有待轉帳', fmt(jpy1?.recorded, c), []);
  eq('台幣明細還在', twd1?.item_count, 1);
  eq('台幣的轉帳建議原封不動', fmt(twd1?.recorded, c), ['民→喧 30000']);
  eq('台幣下一次也是第 1 回合(seq 逐幣別)', twd1?.seq, 1);
  eq('還沒全部結清', after.json.all_settled, false);

  const twdRound = await post(`/api/trips/${c.T}/rounds`, { currency: 'TWD' });
  eq('再結台幣 → 201', twdRound.status, 201);
  eq('台幣 seq 也是 1(和日幣的 1 並存)', twdRound.json.seq, 1);
  eq('台幣寫下 民→喧 30000', fmt(twdRound.json.recorded, c), ['民→喧 30000']);
  eq('兩個幣別各有一列', roundSettlementCurrencies(c.tripId), ['JPY', 'TWD']);

  const hist = await get(`/api/trips/${c.T}/rounds`);
  eq('歷史兩筆', (hist.json as J[]).length, 2);
  eq('兩筆的 seq 都是 1', (hist.json as J[]).map((r) => r.seq), [1, 1]);
  eq('幣別各一', (hist.json as J[]).map((r) => r.currency).sort(), ['JPY', 'TWD']);
  eq('全部結清', (await get(`/api/trips/${c.T}/rounds/preview`)).json.all_settled, true);
}

// ═══════════════════════════════════════════════════════════════
group('[12] 帳目不平衡就不准結算');
// ═══════════════════════════════════════════════════════════════
//
// minCashFlow 對「淨額加起來不等於 0」的輸入不會拋錯,只會**靜靜回傳
// 不完整的轉帳清單**(settle.ts 的 break)—— 畫面會顯示「已結清」,
// 但有一筆錢無聲消失。所以寫錢之前要自己證明輸入是零和的。
{
  const c = await mkTrip('R12 不平衡', ['民', '喧']);

  // 第一道防線:寫入時就擋掉
  const bad = await shared(c.T, {
    description: '對不上的晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 2000, [c.id['喧']]: 2000 } },
  });
  eq('分攤合計 ≠ 支出金額 → 400', bad.status, 400);
  check('訊息點出分攤合計對不上', String(bad.json.statusMessage ?? '').includes('分攤合計'),
    String(bad.json.statusMessage));

  const good = await shared(c.T, {
    description: '正常的晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('健康的支出 → 201', good.status, 201);
  const healthy = await preview(c.T, 'JPY');
  eq('健康資料 blocked_reason 是 null', healthy.b.blocked_reason, null);

  // 第二道防線:資料庫被直接改壞(匯入腳本、手動 SQL)也要擋住。
  // 這裡真的去改本機 D1 的 expense_shares —— API 進不來的狀態只能這樣造。
  const injected = d1Write(
    `UPDATE expense_shares SET amount_minor = amount_minor - 100 WHERE expense_id = ? AND member_id = ?`,
    good.json.id, c.id['喧']);
  check('成功把一筆分攤改壞(直接寫本機 D1)', injected,
    D1_PATH ? '寫入失敗' : '找不到本機 D1 檔案,無法注入壞資料');

  if (injected) {
    const broken = await preview(c.T, 'JPY');
    check('預覽擋下來並說明原因', !!broken.b.blocked_reason, String(broken.b.blocked_reason));
    check('原因指出淨額總和不是 0', String(broken.b.blocked_reason ?? '').includes('不平衡'),
      String(broken.b.blocked_reason));

    const refuse = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
    eq('壞資料要結算 → 409', refuse.status, 409);
    check('訊息指名是哪一筆支出',
      String(refuse.json.statusMessage ?? '').includes('正常的晚餐'), String(refuse.json.statusMessage));
    eq('什麼都沒寫', countSettlements(c.tripId), 0);
    eq('沒有建立回合', ((await get(`/api/trips/${c.T}/rounds`)).json as J[]).length, 0);

    // 修回去 → 又能結算了(證明擋住的原因就是那個差額,不是別的)
    d1Write(`UPDATE expense_shares SET amount_minor = amount_minor + 100 WHERE expense_id = ? AND member_id = ?`,
      good.json.id, c.id['喧']);
    const fixed = await preview(c.T, 'JPY');
    eq('修好之後不再擋', fixed.b.blocked_reason, null);
    eq('修好之後結算 → 201', (await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' })).status, 201);
  }
}

// ═══════════════════════════════════════════════════════════════
group('[13] 寫入時的成員驗證(以前三種輸入都會回 201 然後靜靜弄壞帳)');
// ═══════════════════════════════════════════════════════════════
//
//  1. 公費當個人花費的付款人 → 公費付了錢卻沒人分攤,
//     「公費淨額 = −剩餘」直接破掉(差額等於該筆全額)——
//     剩餘說公費花掉了,卻沒有任何人的淨額欠著它。
//  2. 公費出現在分攤名單 → 它自己欠自己,結算會冒出莫名的公費轉帳。
//  3. 付款人/分攤人是**別的旅程**的成員 id → 那些列進得去,
//     但成員名單查不到,畫面顯示「未知成員」而且結算永遠不平。
//  4. 多付款人清單裡有 0 或負數 → 不出錢的人被列進 expense_payers。
{
  const c = await mkTrip('R13 驗證', ['民', '喧'], '公費');
  const other = await mkTrip('R13 別的旅程', ['路人']);

  const potPersonal = await shared(c.T, {
    kind: 'personal', description: '公費付個人花費', currency: 'JPY', amount: 1000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 1000 } },
  });
  eq('公費當個人花費的付款人 → 400', potPersonal.status, 400);
  check('訊息說個人花費不能由公費支付',
    String(potPersonal.json.statusMessage ?? '').includes('公費'), String(potPersonal.json.statusMessage));

  const potEqual = await shared(c.T, {
    description: '公費在均分名單裡', currency: 'JPY', amount: 900,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['公費']] },
  });
  eq('公費出現在 split.members → 400', potEqual.status, 400);
  check('訊息說公費不是受益人',
    String(potEqual.json.statusMessage ?? '').includes('分攤名單'), String(potEqual.json.statusMessage));

  eq('公費出現在 split.shares → 400', (await shared(c.T, {
    description: '公費在份數裡', currency: 'JPY', amount: 900,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'shares', shares: { [c.id['民']]: 1, [c.id['喧']]: 1, [c.id['公費']]: 1 } },
  })).status, 400);

  eq('公費出現在 split.amounts → 400', (await shared(c.T, {
    description: '公費在指定金額裡', currency: 'JPY', amount: 900,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 600, [c.id['公費']]: 300 } },
  })).status, 400);

  /*
    ── 公費和人**一起**付同一筆 ──────────────────────────────────
    結算把公費付的支出整筆排除(判準是「公費是付款人之一」,見 utils/ledger.ts),
    所以混合付款那一筆會連同**那個人墊的錢**一起被丟掉 —— 而淨額仍然零和
    (兩邊一起丟),findUnbalancedExpenses 的「付款 != 分攤」也抓不到它。
    那個人的墊款就這樣無聲消失。

    語意上它本來也說不通:那個人墊的算不算他墊的?算的話要把分攤按比例拆開,
    那是一條沒有人需要、卻多出一堆四捨五入邊界的路;不算的話他就白墊了。
  */
  const mixed = await shared(c.T, {
    description: '公費加人一起付', currency: 'JPY', amount: 1000,
    payers: [{ member_id: c.id['公費'], amount: 600 }, { member_id: c.id['民'], amount: 400 }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('公費和人一起付同一筆 → 400', mixed.status, 400);
  check('訊息說要嘛整筆從公費出、要嘛記成人墊的',
    String(mixed.json.statusMessage ?? '').includes('不能由公費和人一起付'),
    String(mixed.json.statusMessage));

  /*
    ── 第二道:已經在資料庫裡的混合付款要擋住整個回合 ──────────────
    上面那兩道擋的是 API。資料庫可能被直接改過(匯入腳本、手動 SQL),
    而這次改動之前建的資料也可能有。結算是把錯誤變成真實金錢的那一步,
    寧可擋住整個回合,也不要靜靜吃掉某個人的錢。
  */
  // ⚠️ 這一段**自己開一趟**。上面那趟(c)後面還有斷言在數它的支出與轉帳,
  // 在那裡多記一筆正常支出會讓那些數字整組偏掉(第一版就是這樣紅的)。
  const mix = await mkTrip('R13 混合付款的第二道', ['民', '喧'], '公費');

  // 編輯那一支也要擋 —— 只擋新增的話,建好之後改成混合付款就繞過去了。
  const okOne = await shared(mix.T, {
    description: '本來是民付的', currency: 'JPY', amount: 1000,
    payers: [{ member_id: mix.id['民'] }],
    split: { mode: 'equal', members: [mix.id['民'], mix.id['喧']] },
  });
  eq('先建一筆正常的 → 201', okOne.status, 201);
  const toMixed = await patch(`/api/trips/${mix.T}/expenses/${okOne.json.id}`, {
    kind: 'shared', description: '本來是民付的', currency: 'JPY', amount: 1000,
    payment_method: 'cash', spent_at: '2026-03-08',
    payers: [{ member_id: mix.id['公費'], amount: 600 }, { member_id: mix.id['民'], amount: 400 }],
    split: { mode: 'equal', members: [mix.id['民'], mix.id['喧']] },
  });
  eq('編輯成混合付款 → 400', toMixed.status, 400);
  eq('被擋掉之後那一筆原封不動,結算照樣可以進行',
    (await preview(mix.T, 'JPY')).b.blocked_reason, null);

  const victim = await shared(mix.T, {
    description: '被注入的混合付款', currency: 'JPY', amount: 1000,
    payers: [{ member_id: mix.id['民'] }],
    split: { mode: 'equal', members: [mix.id['民'], mix.id['喧']] },
  });
  eq('再建一筆要被注入的 → 201', victim.status, 201);
  eq('注入前可以結算', (await preview(mix.T, 'JPY')).b.blocked_reason, null);
  // 把付款人改成「公費 600 + 民 400」—— 合計仍然 1,000,所以「付款 != 分攤」抓不到
  check('手動把它改成混合付款',
    d1Write(`UPDATE expense_payers SET amount_minor = 400 WHERE expense_id = ? AND member_id = ?`,
      victim.json.id, mix.id['民'])
    && d1Write(
      `INSERT INTO expense_payers (expense_id, member_id, amount_minor) VALUES (?,?,?)`,
      victim.json.id, mix.id['公費'], 600));
  const blocked = await preview(mix.T, 'JPY');
  check('結算被擋下來了', !!blocked.b.blocked_reason, String(blocked.b.blocked_reason));
  eq('而且指得出是哪一筆',
    (blocked.b.unbalanced ?? []).map((u: J) => u.description), ['被注入的混合付款']);
  eq('真的關不了回合 → 409',
    (await post(`/api/trips/${mix.T}/rounds`, { currency: 'JPY' })).status, 409);

  const foreignPayer = await shared(c.T, {
    description: '別趟的人付款', currency: 'JPY', amount: 1000,
    payers: [{ member_id: other.id['路人'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('付款人屬於別的旅程 → 400', foreignPayer.status, 400);
  check('訊息說不屬於這趟旅程',
    String(foreignPayer.json.statusMessage ?? '').includes('不屬於這趟旅程'),
    String(foreignPayer.json.statusMessage));

  const foreignShare = await shared(c.T, {
    description: '別趟的人分攤', currency: 'JPY', amount: 1000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], other.id['路人']] },
  });
  eq('分攤成員屬於別的旅程 → 400', foreignShare.status, 400);

  const zeroPayer = await shared(c.T, {
    description: '有人出 0 元', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'], amount: 6000 }, { member_id: c.id['喧'], amount: 0 }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('多付款人清單裡有 0 → 400', zeroPayer.status, 400);
  check('訊息叫他不要列不出錢的人',
    String(zeroPayer.json.statusMessage ?? '').includes('大於 0'), String(zeroPayer.json.statusMessage));

  eq('多付款人清單裡有負數 → 400', (await shared(c.T, {
    description: '有人出負數', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'], amount: 7000 }, { member_id: c.id['喧'], amount: -1000 }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 400);

  // 全部都該被擋在寫入之前 —— 一筆都不能進資料庫
  eq('沒有任何一筆被寫進去', ((await get(`/api/trips/${c.T}/expenses`)).json as J[]).length, 0);

  // 合法的多付款人要能過(確認上面擋的是金額,不是「多付款人」本身)
  const okMulti = await shared(c.T, {
    description: '兩人一起墊', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'], amount: 4000 }, { member_id: c.id['喧'], amount: 2000 }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  });
  eq('合法的多付款人 → 201', okMulti.status, 201);
  eq('結算建議 喧→民 ¥1,000', fmt((await preview(c.T, 'JPY')).b.recorded, c), ['喧→民 1000']);
}

// ═══════════════════════════════════════════════════════════════
group('[14] GET /rounds/:id 明細:「這 ¥10,500 是怎麼算出來的」');
// ═══════════════════════════════════════════════════════════════
//
// nets 是**快照**而不是即時重算 —— 之後有人補登支出、改名字、刪帳,
// 重算會得到不同的數字,但當時是照這份付的錢。
{
  const c = await mkTrip('R14 明細', ['民', '喧'], '公費');
  eq('民投入 ¥20,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 20000 }],
  })).status, 201);
  eq('公費付包車 ¥10,000 → 201', (await shared(c.T, {
    description: '包車', currency: 'JPY', amount: 10000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('民墊咖啡 ¥800 → 201', (await shared(c.T, {
    description: '咖啡', currency: 'JPY', amount: 800,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'exact', amounts: { [c.id['民']]: 300, [c.id['喧']]: 500 } },
  })).status, 201);
  // 這一組刻意把四種來源湊齊:公費付的、自己墊的均分、自己墊的自訂金額、
  // 還有一筆投入 —— 「這個數字是怎麼算出來的」要問得夠難才有意義。
  eq('民墊住宿 ¥20,000 → 201', (await shared(c.T, {
    description: '住宿', currency: 'JPY', amount: 20000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY', label: '第一晚', note: '在旅館結的' });
  eq('關閉回合 → 201', closed.status, 201);

  const detail = await get(`/api/trips/${c.T}/rounds/${closed.json.id}`);
  eq('明細 → 200', detail.status, 200);
  eq('幣別', detail.json.currency, 'JPY');
  eq('seq', detail.json.seq, 1);
  eq('label 留著', detail.json.label, '第一晚');
  eq('note 留著', detail.json.note, '在旅館結的');
  eq('還沒撤銷', detail.json.reverted_at, null);

  const items = (detail.json.items ?? []) as J[];
  eq('列入三筆明細', items.length, 3);
  const coffee = items.find((i) => i.description === '咖啡');
  const charter = items.find((i) => i.description === '包車');
  eq('咖啡的付款人是民、全額 800',
    (coffee?.payers ?? []).map((p: J) => `${c.name(p.member_id)} ${p.amount_minor}`), ['民 800']);
  eq('咖啡的分攤是 民 300 / 喧 500',
    (coffee?.shares ?? []).map((s: J) => `${c.name(s.member_id)} ${s.amount_minor}`).sort(),
    ['喧 500', '民 300']);
  eq('包車的付款人是公費',
    (charter?.payers ?? []).map((p: J) => `${c.name(p.member_id)} ${p.amount_minor}`), ['公費 10000']);
  eq('包車兩人均分 5,000',
    (charter?.shares ?? []).map((s: J) => s.amount_minor).sort(), [5000, 5000]);
  eq('住宿兩人均分 10,000',
    (items.find((i) => i.description === '住宿')?.shares ?? [])
      .map((s: J) => s.amount_minor).sort(), [10000, 10000]);

  // 淨額快照:只有真人。公費不在算術裡(見 utils/ledger.ts),所以也不在快照裡。
  const nets = (detail.json.nets ?? []) as J[];
  const netMap = new Map<string, number>(nets.map((n) => [n.memberId, n.netMinor]));
  eq('快照淨額總和 0', nets.reduce((s, n) => s + n.netMinor, 0), 0);
  check('快照裡沒有公費', !netMap.has(c.id['公費']), JSON.stringify(nets.map((n) => c.name(n.memberId))));
  /*
    只有「人墊的」那兩筆進算術。包車是公費付的 → 整筆排除;投入的 20,000 也不算。
      民:墊 800 + 20,000 = 20,800,分攤 300 + 10,000 = 10,300  → +10,500
      喧:分攤 500 + 10,000 = 10,500                            → −10,500
    這就是招牌數字 ¥10,500 的完整出處 —— 兩筆支出、四個分攤,一個都不多不少。
  */
  eq('民 +10,500', netMap.get(c.id['民']), 10500);
  eq('喧 −10,500(咖啡 500 + 住宿 10,000)', netMap.get(c.id['喧']), -10500);

  const transfers = (detail.json.transfers ?? []) as J[];
  eq('記下來的轉帳:喧→民 ¥10,500',
    transfers.map((t) => `${c.name(t.from_member)}→${c.name(t.to_member)} ${t.amount_minor}`), ['喧→民 10500']);
  check('轉帳都標成這一回合的', transfers.every((t) => !!t.id), JSON.stringify(transfers));

  eq('找不到的回合 id → 404',
    (await get(`/api/trips/${c.T}/rounds/00000000-0000-0000-0000-000000000000`)).status, 404);
}

// ═══════════════════════════════════════════════════════════════
group('[15] 公費批次金流 POST /pot/moves');
// ═══════════════════════════════════════════════════════════════
//
// 「今天大家說好各拿 5,000 出來」是**一個決定**,不是 N 個決定。
// 拆成 N 次請求的話,第 3 個人失敗時前 2 個已經寫進去了,
// 使用者得自己去把它們找出來刪掉 —— 而畫面上公費的剩餘已經是錯的。
{
  const c = await mkTrip('R15 公費批次', ['民', '喧', '華'], '公費');

  const batch = await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [
      { member_id: c.id['民'], amount_minor: 5000 },
      { member_id: c.id['喧'], amount_minor: 3000 },
      { member_id: c.id['華'], amount_minor: 2000 },
    ],
  });
  eq('一次三個人 → 201', batch.status, 201);
  eq('回報 3 筆', batch.json.count, 3);
  eq('回報總額 ¥10,000', batch.json.total_minor, 10000);
  eq('真的寫了 3 列', countSettlements(c.tripId), 3);

  const bal1 = await get(`/api/trips/${c.T}/balance`);
  const pb1 = potBlock(bal1.json, 'JPY');
  eq('公費投入 ¥10,000', pb1?.contributedMinor, 10000);
  eq('公費剩餘 ¥10,000', pb1?.remainingMinor, 10000);
  eq('三筆投入各自的金額',
    (pb1?.contributions ?? []).map((x: J) => `${c.name(x.memberId)} ${x.amountMinor}`),
    ['民 5000', '喧 3000', '華 2000']);

  // 退還:direction=out 產生 公費→人 的列
  const out = await potMoves(c.T, {
    direction: 'out', currency: 'JPY',
    entries: [{ member_id: c.id['華'], amount_minor: 1000 }],
  });
  eq('退還 → 201', out.status, 201);
  const pb2 = potBlock((await get(`/api/trips/${c.T}/balance`)).json, 'JPY');
  eq('已退還 ¥1,000', pb2?.refundedMinor, 1000);
  eq('退還對象是華', (pb2?.refunds ?? []).map((x: J) => `${c.name(x.memberId)} ${x.amountMinor}`),
    ['華 1000']);
  eq('剩餘降到 ¥9,000', pb2?.remainingMinor, 9000);
  // 這一組完全沒有支出,只有投入與退還 —— 那全都是**信封那一本**的事。
  // 人對人那一本從頭到尾是空的:沒有人為誰墊過任何一毛錢。
  const netsNow = await netsOf(c.T, 'JPY');
  eq('公費花費 ¥0', pb2?.spentMinor, 0);
  eq('人對人那一本是空的', netsNow.rows.length, 0);
  check('公費不在淨額裡', !netsNow.map.has(c.id['公費']), JSON.stringify(netsNow.rows));
  // 而信封自己的三個量說得出剩餘,不需要任何淨額。
  eq('剩餘 = 投入 − 花掉 − 退還 = 9,000',
    (pb2?.contributedMinor ?? 0) - (pb2?.spentMinor ?? 0) - (pb2?.refundedMinor ?? 0), 9000);
  const pv15 = await preview(c.T, 'JPY');
  eq('recorded 是空的', fmt(pv15.b.recorded, c), []);
  eq('deferred 也是空的', fmt(pv15.b.deferred, c), []);

  const baseCount = countSettlements(c.tripId);
  eq('目前 4 列', baseCount, 4);

  group('[15] 公費批次:驗證與原子性');
  const dup = await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 1000 }, { member_id: c.id['民'], amount_minor: 2000 }],
  });
  eq('同一個人出現兩次 → 400', dup.status, 400);
  check('訊息說出現兩次', String(dup.json.statusMessage ?? '').includes('兩次'),
    String(dup.json.statusMessage));

  eq('金額 0 → 400', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY', entries: [{ member_id: c.id['民'], amount_minor: 0 }],
  })).status, 400);
  eq('金額負數 → 400', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY', entries: [{ member_id: c.id['民'], amount_minor: -500 }],
  })).status, 400);
  eq('金額不是整數 → 400', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY', entries: [{ member_id: c.id['民'], amount_minor: 100.5 }],
  })).status, 400);
  eq('公費自己出現在名單裡 → 400', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY', entries: [{ member_id: c.id['公費'], amount_minor: 1000 }],
  })).status, 400);
  eq('沒勾任何人 → 400', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY', entries: [],
  })).status, 400);
  eq('direction 亂給 → 400', (await potMoves(c.T, {
    direction: 'sideways', currency: 'JPY', entries: [{ member_id: c.id['民'], amount_minor: 1000 }],
  })).status, 400);
  eq('不支援的幣別 → 400', (await potMoves(c.T, {
    direction: 'in', currency: 'XXX', entries: [{ member_id: c.id['民'], amount_minor: 1000 }],
  })).status, 400);

  const noPot = await mkTrip('R15 沒有公費', ['甲', '乙']);
  const noPotMove = await potMoves(noPot.T, {
    direction: 'in', currency: 'JPY', entries: [{ member_id: noPot.id['甲'], amount_minor: 1000 }],
  });
  eq('這趟沒有公費 → 400', noPotMove.status, 400);
  check('訊息叫他先去建公費', String(noPotMove.json.statusMessage ?? '').includes('公費'),
    String(noPotMove.json.statusMessage));
  eq('沒有公費的旅程也沒被寫入', countSettlements(noPot.tripId), 0);

  // 原子性:三筆裡有一筆不合法 → 一列都不能寫
  const atomic = await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [
      { member_id: c.id['民'], amount_minor: 1000 },
      { member_id: c.id['喧'], amount_minor: 2000 },
      { member_id: noPot.id['甲'], amount_minor: 3000 },   // 別趟的人
    ],
  });
  eq('批次裡有一筆不合法 → 400', atomic.status, 400);
  eq('一列都沒寫(列數不變)', countSettlements(c.tripId), baseCount);
  const pb3 = potBlock((await get(`/api/trips/${c.T}/balance`)).json, 'JPY');
  eq('公費投入沒有變', pb3?.contributedMinor, 10000);
  eq('公費剩餘沒有變', pb3?.remainingMinor, 9000);

  // 壞金額混在中間也一樣(驗證發生在任何寫入之前)
  const atomic2 = await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [
      { member_id: c.id['民'], amount_minor: 1000 },
      { member_id: c.id['喧'], amount_minor: 0 },
      { member_id: c.id['華'], amount_minor: 3000 },
    ],
  });
  eq('中間夾一個 0 元 → 400', atomic2.status, 400);
  eq('還是一列都沒寫', countSettlements(c.tripId), baseCount);
}

// ═══════════════════════════════════════════════════════════════
group('[16] 投入公費完全不影響還款上限(JS 檢查與 SQL 前提必須一致)');
// ═══════════════════════════════════════════════════════════════
//
// settlements.post.ts 有兩道一樣的上限:一道在 JS(走 tripLedger,為了給出
// 帶數字的錯誤訊息)、一道寫進 `INSERT ... SELECT ... WHERE`(那才是擋得住
// 併發的那道)。淨額的語意每動一次,**兩道都必須跟著動** ——
// 否則就是這個 repo 反覆踩到的那一類 bug:一邊用新語意、一邊用舊語意,
// 而症狀只在特定資料形狀才出現。
//
// 這一組是那個縫的最小重現:民 投了公費 ¥10,000,同時因為 喧 墊了晚餐而欠他錢。
//   兩本帳分開 → 投入不抵債 → owes(民) = 15,000,結算頁就是這樣建議的
//   SQL 若還把投入算進去 → owes(民) = 5,000 → 照著畫面按下去會回 409
{
  const c = await mkTrip('R16 投入不影響上限', ['民', '喧'], '公費');
  eq('民投入公費 ¥10,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 10000 }],
  })).status, 201);
  eq('喧墊晚餐 ¥30,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 30000,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  // 民 投了 1 萬進信封,但那**完全不抵**他欠喧的 15,000 ——
  // 那 1 萬是他放進信封的現金,不是還給喧的錢。
  eq('淨額:民 −15,000(投入一毛都沒抵)',
    pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, -15000);
  eq('淨額:喧 +15,000', pv.b.nets?.find((n: J) => n.memberId === c.id['喧'])?.netMinor, 15000);
  check('公費不在淨額裡', !(pv.b.nets ?? []).some((n: J) => n.memberId === c.id['公費']),
    JSON.stringify(pv.b.nets));
  eq('預覽建議 民→喧 ¥15,000', fmt(pv.b.recorded, c), ['民→喧 15000']);
  eq('沒有任何公費的腿', fmt(pv.b.deferred, c), []);

  // 先確認超額還是擋得住 —— 不然「放行」可能只是把上限整個拿掉。
  const over = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['民'], to_member: c.id['喧'], currency: 'JPY', amount_minor: 15001,
  });
  eq('多還 1 元 → 409', over.status, 409);
  // 斷言的是**使用者看到的字串**,所以要含幣別符號與千分位 ——
  // 這一條同時在守「訊息裡的金額有經過 formatMoney」:直接內插 amount_minor
  // 的話 TWD 會差 100 倍,而這幾句訊息帶的數字正是使用者要照著打的。
  check('訊息帶得出目前的欠款 JP¥15,000',
    String(over.json.statusMessage ?? '').includes('JP¥15,000'), String(over.json.statusMessage));
  eq('被擋掉就是一列都沒寫', countSettlements(c.tripId), 1);

  // 核心斷言:照著畫面的金額按下去必須成功(SQL 那道也要算出 15,000)。
  const ok = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['民'], to_member: c.id['喧'], currency: 'JPY', amount_minor: 15000,
    note: '現場給現金',
  });
  eq('照建議標記已還款 → 201', ok.status, 201);
  eq('手動那筆真的寫進去了', countSettlements(c.tripId, 'manual'), 2);   // 投入 + 這筆

  const after = await netsOf(c.T, 'JPY');
  eq('人對人全歸零', after.rows.length, 0);
  eq('沒有人對人的建議了', fmt((await preview(c.T, 'JPY')).b.recorded, c), []);
  // 那筆投入完全沒被這次還款動到 —— 兩本帳互不干涉。
  eq('公費剩餘沒被動到(還款不是退還)',
    potBlock(after.bal, 'JPY')?.remainingMinor, 10000);

  // 已經結清了還要再記 → 409(這條是舊行為,確認沒被放寬)
  const again = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['民'], to_member: c.id['喧'], currency: 'JPY', amount_minor: 1,
  });
  eq('結清後再記 → 409', again.status, 409);
  eq('沒有多寫任何一列', countSettlements(c.tripId), 2);
}

// ═══════════════════════════════════════════════════════════════
group('[17] 還款上限是 min(付款人欠款, 收款人債權) —— 只看付款人會生出假債務');
// ═══════════════════════════════════════════════════════════════
//
// [16] 守的是「JS 與 SQL 算的是同一個 owes」。它抓不到這一種:兩道防護算的
// **確實**是同一個數字,但那個數字只有付款人那一側 —— 收款人被欠多少沒人看。
//
// 為什麼只看付款人會不夠:欠款說的是「這個人總共還欠多少」,而債權會分散在
// 多個人身上 —— 只要**有兩個人各自墊過錢**就會這樣。
//
// ⚠️ 這一組不能用公費來製造第二個債權人:公費付的支出整筆被信封吸收,
// 一毛債都不產生(見 utils/ledger.ts)。所以用三個人、兩個真人各墊一筆:
//
//   公費付早餐 ¥6,000 三人均分   → 完全不進算術(留著是為了證明它真的不影響上限)
//   民 墊晚餐 ¥9,000 三人均分    → 每人分攤 3,000
//   華 墊車錢 ¥6,000 三人均分    → 每人分攤 2,000
//   → 淨額 民 +4,000 / 喧 −5,000 / 華 +1,000
//   → 喧 欠 5,000,但只有 4,000 是欠民的,另外 1,000 是欠華的
//   → 直接 POST { 喧→民 5,000 }(= owes(喧))舊寫法兩道防護都放行 → 201
//   → 之後 民 的淨額變成 −1,000:憑空多出一筆欠款,而該收錢的華一分也沒拿到
//
// 這一組每一發都同時斷言**列數**:被擋掉時「一列都沒寫」和「寫了兩列剛好抵銷」
// 在餘額上長得一樣,而後者正是這個 bug 的樣子。
{
  const c = await mkTrip('R17 收款人債權上限', ['民', '喧', '華'], '公費');
  const three = [c.id['民'], c.id['喧'], c.id['華']];
  eq('公費付早餐 ¥6,000 → 201', (await shared(c.T, {
    description: '早餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: three },
  })).status, 201);
  eq('民墊晚餐 ¥9,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 9000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: three },
  })).status, 201);
  eq('華墊車錢 ¥6,000 → 201', (await shared(c.T, {
    description: '車錢', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['華'] }],
    split: { mode: 'equal', members: three },
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  eq('淨額:民 +4,000', pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, 4000);
  eq('淨額:喧 −5,000', pv.b.nets?.find((n: J) => n.memberId === c.id['喧'])?.netMinor, -5000);
  eq('淨額:華 +1,000', pv.b.nets?.find((n: J) => n.memberId === c.id['華'])?.netMinor, 1000);
  check('公費不在淨額裡(它付的那 6,000 一毛債都沒產生)',
    !(pv.b.nets ?? []).some((n: J) => n.memberId === c.id['公費']), JSON.stringify(pv.b.nets));
  // 這兩條就是整組的前提:喧 欠 5,000,但只有 4,000 是欠民的。
  eq('建議:喧→民 ¥4,000、喧→華 ¥1,000', fmt(pv.b.recorded, c).sort(),
    ['喧→民 4000', '喧→華 1000']);
  eq('沒有任何公費的腿', fmt(pv.b.deferred, c), []);

  // ── 稽核者那一發:送出付款人的全部欠款 ─────────────────────
  const exploit = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 5000,
  });
  eq('送 owes(喧) = 5,000(超過民的債權 4,000)→ 409', exploit.status, 409);
  check('訊息說得出上限 JP¥4,000 與付款人的欠款 JP¥5,000',
    ['JP¥4,000', 'JP¥5,000'].every((x) => String(exploit.json.statusMessage ?? '').includes(x)),
    String(exploit.json.statusMessage));
  eq('被擋掉就是一列都沒寫', countSettlements(c.tripId), 0);

  // 「資料庫沒有被改到」要直接看淨額 —— 這個 bug 的症狀就是收款人淨額翻負。
  const still = await netsOf(c.T, 'JPY');
  eq('民的淨額原封不動(沒有憑空生出 −1,000 的欠款)', still.map.get(c.id['民']), 4000);
  eq('喧的淨額原封不動', still.map.get(c.id['喧']), -5000);
  eq('華的債權原封不動', still.map.get(c.id['華']), 1000);

  const over = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 4001,
  });
  eq('上限 +1(4,001)→ 409', over.status, 409);
  eq('還是一列都沒寫', countSettlements(c.tripId), 0);

  // 少還一點是合法的(使用者手上的現金只有一半)—— 上限是上限,不是等號。
  const half = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 1500,
    note: '先給一半',
  });
  eq('低於上限的部分還款 1,500 → 201', half.status, 201);
  eq('剩下的建議變成 喧→民 ¥2,500、喧→華 ¥1,000',
    fmt((await preview(c.T, 'JPY')).b.recorded, c).sort(), ['喧→民 2500', '喧→華 1000']);

  // 邊界值 min(owes, credit) = min(3,500, 2,500) = 2,500,同時也是畫面上的建議金額。
  // 這兩個在人對人的還款上**永遠是同一個數字**:minCashFlow 的每一筆
  // = min(當時的 credit, −debt),恰好等於兩側上限中較小的那個。
  // 這就是加上收款人這一側不會誤擋任何正常流程的理由。
  const boundary = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 2500,
  });
  eq('剛好等於上限 / 建議金額 2,500 → 201', boundary.status, 201);
  eq('兩筆手動還款都寫進去了', countSettlements(c.tripId, 'manual'), 2);

  const after = await netsOf(c.T, 'JPY');
  eq('民歸零(他的 4,000 債權剛好被清完)', after.map.get(c.id['民']) ?? 0, 0);
  eq('喧還欠 1,000 —— 那是欠華的,不是欠民的', after.map.get(c.id['喧']), -1000);
  eq('華的債權還在 +1,000', after.map.get(c.id['華']), 1000);
  eq('淨額總和仍為 0', after.sum, 0);
  const pvEnd = await preview(c.T, 'JPY');
  eq('剩下的建議只有 喧→華', fmt(pvEnd.b.recorded, c), ['喧→華 1000']);

  // 這一發擋住的是收款人那一側:喧 還欠 1,000(付款人側過得了),但民 已經歸零。
  const more = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 1,
  });
  eq('付款人還欠 1,000,但民歸零 → 再還 1 元也是 409', more.status, 409);
  // 訊息要指名是「民」沒有債權,不能講成「你這筆已經結清了」——
  // 喧 確實還欠 1,000,只是欠的不是民。
  check('訊息說的是「民的帳已經結清」,不是「金額太大」',
    String(more.json.statusMessage ?? '').includes('民的帳已經結清'),
    String(more.json.statusMessage));
  eq('沒有多寫任何一列', countSettlements(c.tripId), 2);
}

// ── 收款人淨額 ≤ 0:上限是 0,而且訊息要說得出「對象錯了」──────
//
// 這裡沒有公費也照樣成立 —— 兩個債務人之間的還款一直都是可以打進來的。
// 錯誤訊息只丟數字不夠:使用者會以為是金額太大,改小再送一樣是錯的。
{
  const c = await mkTrip('R17 不能還錢給同樣欠錢的人', ['民', '喧', '華', '琳']);
  eq('民墊晚餐 ¥9,000 三人均分 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 9000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧'], c.id['華']] },
  })).status, 201);
  eq('建議兩筆都流向民', fmt((await preview(c.T, 'JPY')).b.recorded, c),
    ['喧→民 3000', '華→民 3000']);

  // 喧 和 華 都是 −3,000。舊上限只看 owes(喧) = 3,000 → 放行,
  // 然後 華 變成 +3,000 的債權人、民 的債權一分都沒動 —— 錢走錯了人。
  const wrongWay = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['華'], currency: 'JPY', amount_minor: 3000,
  });
  eq('還給同樣欠錢的華(淨額 −3,000)→ 409', wrongWay.status, 409);
  check('訊息說的是「對象錯了」,不只是數字',
    String(wrongWay.json.statusMessage ?? '').includes('同樣欠錢'),
    String(wrongWay.json.statusMessage));
  eq('一列都沒寫', countSettlements(c.tripId), 0);
  eq('華沒有變成債權人', (await netsOf(c.T, 'JPY')).map.get(c.id['華']), -3000);

  // 琳 完全沒參與 → 淨額 0,而 netBalances 會把 0 濾掉,他根本不在 nets 裡。
  // 「找不到就當 0」必須也走進上限,否則這種人會是個無底洞。
  const toZero = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['琳'], currency: 'JPY', amount_minor: 3000,
  });
  eq('還給淨額 0 而且不在 nets 裡的琳 → 409', toZero.status, 409);
  check('訊息指名是琳沒有債權(淨額 0 走的是「已經結清」那一句)',
    String(toZero.json.statusMessage ?? '').includes('琳的帳已經結清'),
    String(toZero.json.statusMessage));
  eq('還是一列都沒寫', countSettlements(c.tripId), 0);

  // 對照組 —— 上限不是「把所有事情都擋掉」
  eq('照建議還給民 → 201', (await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 3000,
  })).status, 201);
  eq('這一列真的寫了', countSettlements(c.tripId), 1);
}

// ── 上限只看人對人的部分:投入與退還都不能污染它 ────────────────
//
// 收款人那一側的兩個還款加總必須排掉「另一端是公費」的列,理由和付款人那側一樣
// (投入 / 退還都不進人對人那一本,見 server/utils/ledger.ts 開頭)。
// 這一組把**兩個方向**都放進來,而它守的正是「JS 檢查與 SQL 前提用的是同一套算術」:
//
//   民 投入 50,000、公費付早餐 6,000、民 墊晚餐 9,000、華 墊車錢 6,000、公費退還民 10,000
//   → 淨額還是 民 +4,000 / 喧 −5,000 / 華 +1,000 —— 和上一組**一模一樣**
//
// 也就是說:投入 50,000 沒有把上限撐大,退還 10,000 也沒有把它壓小。
// 送 喧→民 4,000 就是探針:
//   SQL 若把投入算進 credit → 上限變成 54,000 → 超額的 4,001 也會被放行
//   SQL 若把退還算進去      → 上限變成 −6,000 → 照建議按下去回 409「已經結清了」
{
  const c = await mkTrip('R17 投入退還與上限', ['民', '喧', '華'], '公費');
  const three = [c.id['民'], c.id['喧'], c.id['華']];
  eq('民投入公費 ¥50,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 50000 }],
  })).status, 201);
  eq('公費付早餐 ¥6,000 → 201', (await shared(c.T, {
    description: '早餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: three },
  })).status, 201);
  eq('民墊晚餐 ¥9,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 9000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: three },
  })).status, 201);
  eq('華墊車錢 ¥6,000 → 201', (await shared(c.T, {
    description: '車錢', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['華'] }],
    split: { mode: 'equal', members: three },
  })).status, 201);
  eq('公費退還民 ¥10,000 → 201', (await potMoves(c.T, {
    direction: 'out', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 10000 }],
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  // 招牌斷言:這四個數字和上一組(沒有任何投入 / 退還)**完全相同**。
  eq('民 +4,000', pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, 4000);
  eq('喧 −5,000', pv.b.nets?.find((n: J) => n.memberId === c.id['喧'])?.netMinor, -5000);
  eq('華 +1,000', pv.b.nets?.find((n: J) => n.memberId === c.id['華'])?.netMinor, 1000);
  check('公費不在淨額裡', !(pv.b.nets ?? []).some((n: J) => n.memberId === c.id['公費']),
    JSON.stringify(pv.b.nets));
  eq('建議也一模一樣', fmt(pv.b.recorded, c).sort(), ['喧→民 4000', '喧→華 1000']);
  eq('目前 2 列(投入 + 退還)', countSettlements(c.tripId), 2);

  // 投入 50,000 沒有撐大上限。
  const over = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 4001,
  });
  eq('投入 50,000 撐不出更高的上限:4,001 → 409', over.status, 409);
  eq('一列都沒多寫', countSettlements(c.tripId), 2);

  // 退還 10,000 沒有壓小上限 —— 照畫面建議的金額按下去必須成功。
  const ok = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 4000,
  });
  eq('退還 10,000 也壓不小上限:照建議的 4,000 → 201', ok.status, 201);
  eq('手動那筆真的寫進去了(投入 + 退還 + 這筆)', countSettlements(c.tripId, 'manual'), 3);

  const after = await netsOf(c.T, 'JPY');
  eq('民歸零', after.map.get(c.id['民']) ?? 0, 0);
  eq('喧剩下欠華的 1,000', after.map.get(c.id['喧']), -1000);
  eq('剩下的建議只有 喧→華', fmt((await preview(c.T, 'JPY')).b.recorded, c), ['喧→華 1000']);
  // 信封完全沒被這次還款動到 —— 兩本帳互不干涉。
  eq('公費剩餘 50,000 − 6,000 − 10,000 = 34,000',
    potBlock(after.bal, 'JPY')?.remainingMinor, 34000);
}

process.exit(summary() > 0 ? 1 : 0);
