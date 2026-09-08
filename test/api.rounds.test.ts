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
 *   ② 公費先幫人墊過款之後,不會再叫另一個人付一次
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
group('[2] 公費永遠不會被結算清空(招牌案例)');
// ═══════════════════════════════════════════════════════════════
//
// 淨額不含投入/退還(見 server/utils/ledger.ts 開頭),所以公費淨額 = +公費花費,
// 它的腿長成「人 → 公費」= 「這個人還要投入多少」。照 minCashFlow 寫下去
// 等於幫他記了一筆他沒付的投入 —— 信封裡憑空多出錢,總覽的剩餘就開始說謊。
// 所以任一端是公費的轉帳一律是 deferred:只顯示,永遠不寫入。
//
// (舊語意下這條腿是反方向的「公費 → 人」,寫下去等於第一晚就把信封清空退還。
//  方向反了,結論一樣。這一組守的就是「不管方向,公費的腿都不寫」。)
{
  const c = await mkTrip('R2 公費不可清空', ['民', '喧'], '公費');
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
  eq('明細兩筆', pv.b.item_count, 2);
  // 招牌斷言:公費的腿只出現在 deferred,recorded 必須是空的
  check('recorded 是一個陣列', Array.isArray(pv.b.recorded), JSON.stringify(pv.b.recorded));
  eq('recorded 是空的(沒有人需要互轉)', fmt(pv.b.recorded, c), []);
  eq('deferred 是各人 → 公費 ¥5,000 兩筆(=「還要投入多少」)',
    fmt(pv.b.deferred, c), ['喧→公費 5000', '民→公費 5000']);

  const before = await netsOf(c.T, 'JPY');
  const potBefore = JSON.stringify(potBlock(before.bal, 'JPY'));
  eq('結算前 公費淨額 +10,000(= 公費花掉的錢,投入不算)', before.map.get(c.id['公費']), 10000);
  eq('結算前 民 −5,000(他分攤了 5,000)', before.map.get(c.id['民']), -5000);
  eq('結算前 settlements 只有兩筆投入', countSettlements(c.tripId), 2);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  eq('seq = 1', closed.json.seq, 1);
  check('回合有回傳 recorded 陣列', Array.isArray(closed.json.recorded), JSON.stringify(closed.json.recorded));
  eq('回合寫下的轉帳:0 筆', closed.json.recorded?.length, 0);
  eq('回合仍然回報公費的腿(唯讀顯示用)', closed.json.deferred?.length, 2);

  // 這是「公費沒有被清空」的直接證據:source='round' 一列都沒寫
  eq('settlements 沒有任何 source=round 的列', countSettlements(c.tripId, 'round'), 0);
  eq('settlements 總數還是 2(只有那兩筆投入)', countSettlements(c.tripId), 2);

  const after = await netsOf(c.T, 'JPY');
  eq('公費收支完全沒被動到(逐位元相同)', JSON.stringify(potBlock(after.bal, 'JPY')), potBefore);
  const pb = potBlock(after.bal, 'JPY');
  eq('投入 ¥20,000', pb?.contributedMinor, 20000);
  eq('已支出 ¥10,000', pb?.spentMinor, 10000);
  eq('已退還 ¥0', pb?.refundedMinor, 0);
  eq('剩餘 ¥10,000(錢還在信封裡 —— 這個數字只在總覽頁)', pb?.remainingMinor, 10000);
  eq('公費淨額還是 +10,000', after.map.get(c.id['公費']), 10000);
  eq('公費淨額 = 公費花費', after.map.get(c.id['公費']), pb?.spentMinor);
  eq('Σ(真人淨額) = −公費花費',
    after.rows.filter((n) => n.memberId !== c.id['公費']).reduce((s, n) => s + n.netMinor, 0),
    -(pb?.spentMinor ?? 0));

  // 蓋章照樣要蓋 —— 明細已經看過了,下次預覽不該再列出來
  const stamps = await stampMap(c.T);
  eq('晚餐蓋章', stamps.get('晚餐'), closed.json.id);
  eq('門票蓋章', stamps.get('門票'), closed.json.id);
  const pv2 = await preview(c.T, 'JPY');
  eq('下次預覽沒有未結明細', pv2.b.item_count, 0);
  eq('公費的腿還在(還沒退還)', pv2.b.deferred?.length, 2);
}

// ═══════════════════════════════════════════════════════════════
group('[3] 出資不平均:債改走公費,不再是人對人');
// ═══════════════════════════════════════════════════════════════
//
// 民出了全部的公費、喧一毛沒出,兩人卻平均花掉。
//
// ⚠️ 這一組的期望值因為新語意**整組換掉了**,而且換的方向最容易被誤判成 bug:
// 舊語意 recorded = 喧→民 ¥5,000(人對人);新語意 recorded 是**空的**,
// 喧那 ¥5,000 變成他對公費的欠款(deferred)—— 他去總覽投入,公費再退給民。
// 債沒有消失,只是路由改成經過信封。下面把整條路徑的錢算完,證明分毫對得上。
{
  const c = await mkTrip('R3 出資不平均', ['民', '喧'], '公費');
  eq('民投入 ¥20,000 → 201',
    (await potMoves(c.T, {
      direction: 'in', currency: 'JPY',
      entries: [{ member_id: c.id['民'], amount_minor: 20000 }],
    })).status, 201);

  eq('公費付行程 ¥10,000 → 201', (await shared(c.T, {
    description: '包車', currency: 'JPY', amount: 10000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  // 民 投入的 ¥20,000 不進淨額,所以他和喧看起來一樣:各分攤了 ¥5,000 還沒付。
  eq('淨額:民 −5,000', pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, -5000);
  eq('淨額:喧 −5,000', pv.b.nets?.find((n: J) => n.memberId === c.id['喧'])?.netMinor, -5000);
  eq('淨額:公費 +10,000(= 它花掉的錢)',
    pv.b.nets?.find((n: J) => n.memberId === c.id['公費'])?.netMinor, 10000);
  eq('淨額總和 0', (pv.b.nets ?? []).reduce((s: number, n: J) => s + n.netMinor, 0), 0);

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  // 核心斷言:回合不再寫人對人的轉帳,而且**一列 settlement 都不寫**。
  eq('recorded 是空的(喧的債改走公費)', fmt(closed.json.recorded, c), []);
  eq('公費的腿留在 deferred:兩人各還要投入 ¥5,000',
    fmt(closed.json.deferred, c), ['喧→公費 5000', '民→公費 5000']);
  eq('一列 source=round 都沒寫', countSettlements(c.tripId, 'round'), 0);

  const after = await netsOf(c.T, 'JPY');
  const pb = potBlock(after.bal, 'JPY');
  eq('公費投入還是 ¥20,000', pb?.contributedMinor, 20000);
  eq('公費已退還 ¥0', pb?.refundedMinor, 0);
  eq('公費剩餘還是 ¥10,000', pb?.remainingMinor, 10000);
  eq('結算後 民 還是 −5,000(他投入的 20,000 在總覽頁,不在這裡)',
    after.map.get(c.id['民']), -5000);
  eq('結算後 喧 還是 −5,000', after.map.get(c.id['喧']), -5000);
  eq('結算後 公費 還是 +10,000', after.map.get(c.id['公費']), 10000);

  // ── 債沒有消失:把喧的欠款照新語意走完,錢要對得上 ──────────
  // 喧 照他的淨額投入 ¥5,000 → 信封 10,000 + 5,000 = 15,000 → 全額退還給民。
  eq('喧 投入 ¥5,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['喧'], amount_minor: 5000 }],
  })).status, 201);
  const mid = potBlock((await get(`/api/trips/${c.T}/balance`)).json, 'JPY');
  eq('信封現在有 ¥15,000', mid?.remainingMinor, 15000);
  eq('喧 投入之後淨額**沒變**(投入不是還款)',
    (await netsOf(c.T, 'JPY')).map.get(c.id['喧']), -5000);

  eq('公費退還民 ¥15,000 → 201', (await potMoves(c.T, {
    direction: 'out', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 15000 }],
  })).status, 201);
  const end = potBlock((await get(`/api/trips/${c.T}/balance`)).json, 'JPY');
  eq('信封清空', end?.remainingMinor, 0);
  eq('投入合計 ¥25,000(民 20,000 + 喧 5,000)', end?.contributedMinor, 25000);
  eq('退還合計 ¥15,000(全部給民)', end?.refundedMinor, 15000);
  // 民 實際掏出 20,000 − 15,000 = 5,000;喧 實際掏出 5,000 —— 各自剛好是他該分攤的。
  eq('民 實際掏出 ¥5,000', 20000 - 15000, 5000);
  eq('兩人實付合計 = 公費花費', (20000 - 15000) + 5000, end?.spentMinor);
  // 淨額完全沒被這兩筆金流動到 —— 這是新語意的定義,也是這一組最後的守門。
  const final = await netsOf(c.T, 'JPY');
  eq('走完整條路徑後淨額依然是 −5000 / −5000 / +10000',
    [c.id['民'], c.id['喧'], c.id['公費']].map((m) => final.map.get(m) ?? 0),
    [-5000, -5000, 10000]);
}

// ═══════════════════════════════════════════════════════════════
group('[4] 公費補過墊款之後,兩本帳各自結、加起來不多不少');
// ═══════════════════════════════════════════════════════════════
//
// 民先自己墊晚餐 ¥6,000,公費隨後把 ¥6,000 還給民。
//
// ⚠️ 這一組的期望值也因為新語意換掉了,而且它的**原本用途消失了**:
// 舊版這組叫「殺掉子集算術」—— 舊語意下公費的退還會抵掉人對人的債,
// 所以 recorded 是空的,而子集算術會錯誤地開出 喧→民 ¥3,000。
// 新語意下退還不進淨額,所以正確答案**就是** 喧→民 ¥3,000 ——
// 這個場景再也分不出「整趟」和「子集」的差別了。
// (子集算術的守門改由 [5] 吸收手動還款、[6] 連續兩回合負責:
//  那兩組用的是人對人的還款,而人對人的還款仍然在算術範圍裡。)
//
// 所以這組現在守的是另一件更難的事:**新語意把一本帳拆成兩本**
//   ① 人的帳(nets)   誰為共同花費多墊了錢
//   ② 信封的帳(pot)  誰投入多少、拿回多少
// 兩本各自結完,每個人實際掏出的錢必須剛好等於他該分攤的。
// 「喧 是不是被多收了一次」的答案在這裡:不是 —— 他多付的那筆從信封拿回來。
{
  const c = await mkTrip('R4 公費墊款', ['民', '喧'], '公費');
  eq('兩人各投入 ¥5,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 5000 }, { member_id: c.id['喧'], amount_minor: 5000 }],
  })).status, 201);

  eq('民自己墊晚餐 ¥6,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  eq('公費把 ¥6,000 還給民 → 201', (await potMoves(c.T, {
    direction: 'out', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 6000 }],
    note: '公費補墊款',
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  eq('明細還是列著那筆晚餐', pv.b.item_count, 1);
  // 民:墊 6,000 − 分攤 3,000 = +3,000(投入 5,000 與收到的 6,000 退還都不算)
  // 喧:分攤 3,000,沒墊過 → −3,000。公費:一毛都沒付過 shared 支出 → 0 → 不在 nets 裡。
  eq('淨額:民 +3,000', pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, 3000);
  eq('淨額:喧 −3,000', pv.b.nets?.find((n: J) => n.memberId === c.id['喧'])?.netMinor, -3000);
  check('公費不在淨額裡(它沒有付過任何共同支出)',
    !(pv.b.nets ?? []).some((n: J) => n.memberId === c.id['公費']), JSON.stringify(pv.b.nets));

  const closed = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY' });
  eq('關閉回合 → 201', closed.status, 201);
  const rec = (closed.json.recorded ?? []) as J[];
  check('回合有回傳 recorded 陣列', Array.isArray(closed.json.recorded), JSON.stringify(closed.json.recorded));
  eq('人的帳:喧→民 ¥3,000(他分攤的那一半)', fmt(rec, c), ['喧→民 3000']);
  eq('寫了 1 列 source=round', countSettlements(c.tripId, 'round'), 1);
  eq('沒有公費的腿(公費一毛共同支出都沒付)', fmt(closed.json.deferred, c), []);

  const after = await netsOf(c.T, 'JPY');
  const pb = potBlock(after.bal, 'JPY');
  eq('公費花費 ¥0', pb?.spentMinor, 0);
  eq('公費剩餘 ¥4,000(10,000 投入 − 6,000 退還)', pb?.remainingMinor, 4000);
  eq('人的帳結清了(淨額全歸零)', after.rows.filter((n) => n.netMinor !== 0).length, 0);
  eq('晚餐蓋章了', (await stampMap(c.T)).get('晚餐'), closed.json.id);

  // ── 信封的帳:誰投入多少、拿回多少 ──────────────────────────
  // 民 投 5,000 卻拿回 6,000 → 他從信封多領了 1,000;喧 投 5,000 一毛沒拿。
  // 信封手上剩 4,000,而喧 應得 5,000 —— 差的 1,000 就是民 多領的那筆。
  eq('投入:各 ¥5,000',
    (pb?.contributions ?? []).map((x: J) => `${c.name(x.memberId)} ${x.amountMinor}`).sort(),
    ['喧 5000', '民 5000']);
  eq('退還:民 ¥6,000', (pb?.refunds ?? []).map((x: J) => `${c.name(x.memberId)} ${x.amountMinor}`),
    ['民 6000']);

  eq('民 把多領的 ¥1,000 放回信封 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 1000 }],
  })).status, 201);
  eq('公費退還喧 ¥5,000 → 201', (await potMoves(c.T, {
    direction: 'out', currency: 'JPY',
    entries: [{ member_id: c.id['喧'], amount_minor: 5000 }],
  })).status, 201);
  const end = potBlock((await get(`/api/trips/${c.T}/balance`)).json, 'JPY');
  eq('信封清空', end?.remainingMinor, 0);

  // ── 兩本帳加起來:每個人實際掏出的錢 = 他該分攤的 ¥3,000 ──────
  // 民:投 5,000 + 補 1,000 + 墊晚餐 6,000 − 領回 6,000 − 收喧 3,000 = 3,000
  // 喧:投 5,000 + 付民 3,000 − 領回 5,000 = 3,000
  eq('民 實際掏出 ¥3,000', 5000 + 1000 + 6000 - 6000 - 3000, 3000);
  eq('喧 實際掏出 ¥3,000', 5000 + 3000 - 5000, 3000);
  eq('兩人合計 = 晚餐 ¥6,000', 3000 + 3000, 6000);
  // 「喧 被多收一次」會長成他實際掏出 6,000 —— 上面那條就是這件事的守門。
  eq('淨額仍然全歸零(退還沒有把已結的帳弄回來)',
    (await netsOf(c.T, 'JPY')).rows.filter((n) => n.netMinor !== 0).length, 0);
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
  // ⚠️ 計程車刻意是 ¥8,000(舊版是 ¥2,000)。新語意下投入不進淨額,所以
  // 「民 投了 10,000」不再讓他變債權人 —— 金額太小的話兩個人都是債務人、
  // recorded 會是空的,這一組就測不到「撤銷會刪掉轉帳」那半邊了。
  // 要有人對人的轉帳可撤,就得真的有人自掏腰包超過他該分攤的。
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
  // 民 墊 8,000 − 分攤 7,000 = +1,000;喧 −7,000;公費 +6,000(它花掉的錢)。
  eq('寫下 喧→民 ¥1,000', fmt(closed.json.recorded, c), ['喧→民 1000']);
  eq('公費的腿:喧 還要投入 ¥6,000', fmt(closed.json.deferred, c), ['喧→公費 6000']);
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
  eq('撤銷後又建議 喧→民 ¥1,000', fmt(pvAfter.b.recorded, c), ['喧→民 1000']);

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
  eq('重結的金額一樣是 喧→民 ¥1,000', fmt(again.json.recorded, c), ['喧→民 1000']);
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
//     「公費淨額 = 公費花費」直接破掉(差額等於該筆全額)——
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
group('[14] GET /rounds/:id 明細:「這 ¥5,500 是怎麼算出來的」');
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
  // ⚠️ 這筆住宿是為了新語意加的。舊語意下「民 投入 20,000」就讓他成為債權人,
  // 光靠咖啡就能算出 喧→民 ¥5,500;新語意投入不進淨額,他得真的自掏腰包才會是債權人。
  // 金額選 ¥20,000 兩人均分,是為了讓招牌數字仍然剛好是 ¥5,500 ——
  // 這一組要問的是「這 ¥5,500 是怎麼算出來的」,換個數字就要重寫整段敘述。
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

  // 淨額快照要含公費,否則加起來不等於 0
  const nets = (detail.json.nets ?? []) as J[];
  const netMap = new Map<string, number>(nets.map((n) => [n.memberId, n.netMinor]));
  eq('快照淨額總和 0', nets.reduce((s, n) => s + n.netMinor, 0), 0);
  check('快照裡有公費', netMap.has(c.id['公費']), JSON.stringify(nets.map((n) => c.name(n.memberId))));
  // 民:墊 800 + 20,000 − 分攤 15,300 = +5,500。**投入的 20,000 不算**
  // (舊語意會把它算進來,得到 +15,500 —— 那個 10,000 的差就是信封裡的現金)。
  eq('民 +5,500', netMap.get(c.id['民']), 5500);
  eq('喧 −15,500(包車 5,000 + 咖啡 500 + 住宿 10,000)', netMap.get(c.id['喧']), -15500);
  // 公費:付掉 10,000,沒有分攤 → 淨額就是它花掉的錢
  eq('公費 +10,000 = 它花掉的錢', netMap.get(c.id['公費']), 10000);

  const transfers = (detail.json.transfers ?? []) as J[];
  eq('記下來的轉帳:喧→民 ¥5,500(公費的腿不寫)',
    transfers.map((t) => `${c.name(t.from_member)}→${c.name(t.to_member)} ${t.amount_minor}`), ['喧→民 5500']);
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
  // 這一組完全沒有支出,只有投入與退還 —— 新語意下這兩種都不進淨額,
  // 所以公費(和所有人)根本不會出現在 nets 裡,而剩餘照樣是 ¥9,000。
  // 「剩餘只住在總覽頁」在這裡是最極端的樣子:結算頁的算術是空的。
  const netsNow = await netsOf(c.T, 'JPY');
  eq('公費花費 ¥0', pb2?.spentMinor, 0);
  eq('公費不在淨額裡(它沒付過任何共同支出)', netsNow.map.get(c.id['公費']) ?? 0, 0);
  eq('淨額整個是空的(投入/退還都不進算術)', netsNow.rows.length, 0);
  eq('剩餘仍然是 ¥9,000 —— 和淨額無關', pb2?.remainingMinor, 9000);

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
group('[16] 「標記已還款」的上限必須用新語意算(JS 檢查與 SQL 前提是同一個 owes)');
// ═══════════════════════════════════════════════════════════════
//
// settlements.post.ts 有兩道一樣的上限:一道在 JS(為了給帶數字的錯誤訊息)、
// 一道寫進 `INSERT ... SELECT ... WHERE`(那才是擋得住併發的那道)。
// 淨額改成不含投入/退還之後,**兩道都必須跟著改**,否則就是這個 repo
// 最怕的那一類 bug:JS 用新語意放行、SQL 用舊語意擋掉。
//
// 這一組就是那個縫的最小重現:民 投了公費 ¥10,000,同時欠 喧 ¥5,000。
//   新語意 owes(民) = 5,000 → 結算頁就是這樣建議的
//   舊算法 owes(民) = 5,000 − 10,000 = −5,000 → 一列都插不進去
//     → 照著畫面按下「標記已還款」永遠回 409「這筆已經結清了」
{
  const c = await mkTrip('R16 還款上限', ['民', '喧'], '公費');
  eq('民投入公費 ¥10,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 10000 }],
  })).status, 201);
  eq('喧墊晚餐 ¥10,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 10000,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  eq('淨額:民 −5,000(投入不抵這筆人對人的債)',
    pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, -5000);
  eq('預覽建議 民→喧 ¥5,000', fmt(pv.b.recorded, c), ['民→喧 5000']);

  // 先確認超額還是擋得住 —— 不然「放行」可能只是把上限整個拿掉。
  const over = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['民'], to_member: c.id['喧'], currency: 'JPY', amount_minor: 5001,
  });
  eq('多還 1 元 → 409', over.status, 409);
  // 斷言的是**使用者看到的字串**,所以要含幣別符號與千分位 ——
  // 這一條同時在守「訊息裡的金額有經過 formatMoney」:直接內插 amount_minor
  // 的話 TWD 會差 100 倍(NT$1,000.01 存的是 100001),而這幾句訊息帶的數字
  // 正是使用者要照著改的。
  check('訊息帶得出目前的欠款 JP¥5,000',
    String(over.json.statusMessage ?? '').includes('JP¥5,000'), String(over.json.statusMessage));
  eq('被擋掉就是一列都沒寫', countSettlements(c.tripId), 1);

  // 核心斷言:照著畫面的金額按下去必須成功。
  const ok = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['民'], to_member: c.id['喧'], currency: 'JPY', amount_minor: 5000,
    note: '現場給現金',
  });
  eq('照建議標記已還款 → 201', ok.status, 201);
  eq('手動那筆真的寫進去了', countSettlements(c.tripId, 'manual'), 2);   // 投入 + 這筆

  const after = await netsOf(c.T, 'JPY');
  eq('還完之後淨額全歸零', after.rows.filter((n) => n.netMinor !== 0).length, 0);
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
// 多個人身上。公費一旦付過共同支出就必然如此(新語意下公費淨額 = +公費花費,
// 它恆為債權人之一)。稽核者的實測:
//
//   公費付 ¥6,000 兩人均分、民 墊 ¥20,000 兩人均分
//   → 淨額 民 +7,000 / 喧 −13,000 / 公費 +6,000,建議只有 喧→民 ¥7,000
//   → 舊寫法送 喧→民 13,000(= owes(喧))兩道防護都放行 → 201
//   → 之後淨額變成 民 −6,000 / 公費 +6,000:民 憑空多出一筆欠款,建議整個變空
//
// 超出的那 6,000 本來該流向公費,而公費的腿一律不寫進 settlements
// (見 server/utils/ledger.ts),所以那不是「順序不同、結果等價」——
// 是真的把錢記到了錯的人身上,而該收錢的信封一分也沒拿到。
//
// 這一組每一發都同時斷言**列數**:被擋掉時「一列都沒寫」和「寫了兩列剛好抵銷」
// 在餘額上長得一樣,而後者正是這個 bug 的樣子。
{
  const c = await mkTrip('R17 收款人債權上限', ['民', '喧'], '公費');
  eq('公費付早餐 ¥6,000 → 201', (await shared(c.T, {
    description: '早餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('民墊晚餐 ¥20,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 20000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  eq('淨額:民 +7,000', pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, 7000);
  eq('淨額:喧 −13,000', pv.b.nets?.find((n: J) => n.memberId === c.id['喧'])?.netMinor, -13000);
  eq('淨額:公費 +6,000(= 它付掉的共同支出)',
    pv.b.nets?.find((n: J) => n.memberId === c.id['公費'])?.netMinor, 6000);
  // 這兩條就是整組的前提:喧 欠 13,000,但只有 7,000 是欠民的。
  eq('建議只有 喧→民 ¥7,000', fmt(pv.b.recorded, c), ['喧→民 7000']);
  eq('剩下的 6,000 是公費的腿(deferred,永遠不寫)', fmt(pv.b.deferred, c), ['喧→公費 6000']);

  // ── 稽核者那一發:送出付款人的全部欠款 ─────────────────────
  const exploit = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 13000,
  });
  eq('送 owes(喧) = 13,000(超過民的債權 7,000)→ 409', exploit.status, 409);
  check('訊息說得出上限 JP¥7,000 與付款人的欠款 JP¥13,000',
    ['JP¥7,000', 'JP¥13,000'].every((s) => String(exploit.json.statusMessage ?? '').includes(s)),
    String(exploit.json.statusMessage));
  eq('被擋掉就是一列都沒寫', countSettlements(c.tripId), 0);

  // 「資料庫沒有被改到」要直接看淨額 —— 這個 bug 的症狀就是收款人淨額翻負。
  const still = await netsOf(c.T, 'JPY');
  eq('民的淨額原封不動(沒有憑空生出 −6,000 的欠款)', still.map.get(c.id['民']), 7000);
  eq('喧的淨額原封不動', still.map.get(c.id['喧']), -13000);
  eq('建議也原封不動', fmt((await preview(c.T, 'JPY')).b.recorded, c), ['喧→民 7000']);

  const over = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 7001,
  });
  eq('上限 +1(7,001)→ 409', over.status, 409);
  eq('還是一列都沒寫', countSettlements(c.tripId), 0);

  // 少還一點是合法的(使用者手上的現金只有一半)—— 上限是上限,不是等號。
  const half = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 3000,
    note: '先給一半',
  });
  eq('低於上限的部分還款 3,000 → 201', half.status, 201);
  eq('剩下的建議變成 喧→民 ¥4,000', fmt((await preview(c.T, 'JPY')).b.recorded, c), ['喧→民 4000']);

  // 邊界值 min(owes, credit) = min(10,000, 4,000) = 4,000,同時也是畫面上的建議金額。
  // 這兩個在人對人的還款上**永遠是同一個數字**:minCashFlow 的每一筆
  // = min(當時的 credit, −debt),恰好等於兩側上限中較小的那個。
  // 這就是加上收款人這一側不會誤擋任何正常流程的理由。
  const boundary = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 4000,
  });
  eq('剛好等於上限 / 建議金額 4,000 → 201', boundary.status, 201);
  eq('兩筆手動還款都寫進去了', countSettlements(c.tripId, 'manual'), 2);

  const after = await netsOf(c.T, 'JPY');
  eq('民歸零(他的 7,000 債權剛好被清完)', after.map.get(c.id['民']) ?? 0, 0);
  eq('喧還欠 6,000 —— 那是欠公費的,不是欠民的', after.map.get(c.id['喧']), -6000);
  eq('公費淨額不變 +6,000', after.map.get(c.id['公費']), 6000);
  eq('淨額總和仍為 0', after.sum, 0);
  const pvEnd = await preview(c.T, 'JPY');
  eq('人對人的建議清空', fmt(pvEnd.b.recorded, c), []);
  eq('剩下的只有公費那條腿', fmt(pvEnd.b.deferred, c), ['喧→公費 6000']);

  // 這一發擋住的是收款人那一側:喧 還欠 6,000(付款人側過得了),但民 已經歸零。
  const more = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 1,
  });
  eq('付款人還欠 6,000,但民歸零 → 再還 1 元也是 409', more.status, 409);
  // 訊息要指名是「民」沒有債權,不能講成「你這筆已經結清了」——
  // 喧 確實還欠 6,000,只是欠的不是民。
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
// (淨額不含投入/退還,見 server/utils/ledger.ts 開頭)。這一組把兩個方向都放進來:
//
//   投入(民→公費 50,000)少排 → credit(民) 被撐大到 57,000 → 超額的 13,000 過關
//   退還(公費→民 10,000)少排 → credit(民) 被壓成 −3,000 → 照建議的 7,000 永遠 409
//
// 後者是 JS/SQL 分岔那一類 bug 的樣子:JS 算 7,000 放行、SQL 算 −3,000 擋掉,
// 使用者拿到一句「已經結清了」而其實沒有。
{
  const c = await mkTrip('R17 投入退還不污染上限', ['民', '喧'], '公費');
  eq('民投入公費 ¥50,000 → 201', (await potMoves(c.T, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 50000 }],
  })).status, 201);
  eq('公費付早餐 ¥6,000 → 201', (await shared(c.T, {
    description: '早餐', currency: 'JPY', amount: 6000,
    payers: [{ member_id: c.id['公費'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('民墊晚餐 ¥20,000 → 201', (await shared(c.T, {
    description: '晚餐', currency: 'JPY', amount: 20000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('公費退還民 ¥10,000 → 201', (await potMoves(c.T, {
    direction: 'out', currency: 'JPY',
    entries: [{ member_id: c.id['民'], amount_minor: 10000 }],
  })).status, 201);

  const pv = await preview(c.T, 'JPY');
  eq('民的淨額還是 +7,000(投入 50,000 與退還 10,000 都不進算術)',
    pv.b.nets?.find((n: J) => n.memberId === c.id['民'])?.netMinor, 7000);
  eq('建議還是只有 喧→民 ¥7,000', fmt(pv.b.recorded, c), ['喧→民 7000']);
  eq('目前 2 列(投入 + 退還)', countSettlements(c.tripId), 2);

  const over = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 13000,
  });
  eq('投入 50,000 撐不出更高的上限:13,000 → 409', over.status, 409);
  eq('一列都沒多寫', countSettlements(c.tripId), 2);

  const ok = await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: c.id['民'], currency: 'JPY', amount_minor: 7000,
  });
  eq('退還 10,000 也壓不小上限:照建議的 7,000 → 201', ok.status, 201);
  eq('手動那筆真的寫進去了(投入 + 退還 + 這筆)', countSettlements(c.tripId, 'manual'), 3);

  const after = await netsOf(c.T, 'JPY');
  eq('民歸零', after.map.get(c.id['民']) ?? 0, 0);
  eq('喧剩下欠公費的 6,000', after.map.get(c.id['喧']), -6000);
  eq('公費剩餘 50,000 − 6,000 − 10,000 = 34,000(還款沒碰到信封)',
    potBlock(after.bal, 'JPY')?.remainingMinor, 34000);
}

process.exit(summary() > 0 ? 1 : 0);
