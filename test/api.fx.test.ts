/**
 * 換匯紀錄與錢包的 API 整合測試。打真實 dev server + 真實本機 D1,不 mock。
 *
 *   pnpm dev            # 另一個終端
 *   pnpm test:fx
 *
 * ══ 這支測試在防守什麼 ═══════════════════════════════════════════
 *
 * issue #6 的範圍是**刻意畫小**的:只做記錄與呈現,不改任何計價邏輯。
 * 所以這裡最重要的不是「新功能算得對」,而是「舊功能一個字都沒變」——
 * 五件事,由重要到次要:
 *
 *   ① **沒有任何換匯紀錄時,所有現有數字完全不變。**
 *      這是回歸保護,最重要的一條。wallets 回空陣列,其餘欄位一字不動。
 *   ② **有了換匯紀錄之後,nets / transfers / 結算回合仍然一字不動。**
 *      ①只證明「沒用到就沒事」,②才證明「用了也沒事」。少了②,
 *      哪天有人把換匯匯率接進 convertToBase(),①還是綠的。
 *   ③ 剩餘 = 換入 − 現金支出 − 投入公費 − 付出還款 − 換出 + 收到的(逐幣別)。
 *      六個流向,漏掉任何一個都是「錢包說你手上有,實際上沒有」。
 *   ④ 加權平均匯率與紀錄的順序無關(存金額而不是匯率的直接後果)。
 *   ⑤ 剩餘變成負的只**警告**不阻擋 —— 那代表在當地 ATM 提過款沒記,
 *      擋下來會讓「先記支出、晚點補記換匯」這個最常見的順序做不到。
 *
 * 每一組都自己建一趟新旅程 —— 錢包是「整趟、逐人」的概念,
 * 組跟組之間共用旅程的話,前一組留下的錢會污染下一組的數字。
 */
import { group, check, eq, summary } from './_harness.ts';
import { loginFixture } from './_session.ts';
import { exchangeRate, formatRate } from '../shared/money.ts';

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
const session = await loginFixture(base, 'fx');
const req = session.req;
const get = (p: string) => req('GET', p);
const post = (p: string, b?: unknown) => req('POST', p, b);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);
const del = (p: string) => req('DELETE', p);

await post('/api/admin/sync-rates');

// ═══════════════════════════════════════════════════════════════
// 共用小工具
// ═══════════════════════════════════════════════════════════════
type Ctx = { T: string; tripId: string; id: Record<string, string> };

async function mkTrip(label: string, members: string[], pot?: string): Promise<Ctx> {
  const r = await post('/api/trips', {
    name: `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    base_currency: 'TWD', members, ...(pot ? { pot } : {}),
  });
  eq(`建立旅程(${label})→ 201`, r.status, 201);
  const info = await get(`/api/trips/${r.json.share_token}`);
  const id: Record<string, string> = {};
  for (const m of (info.json.members ?? []) as J[]) id[m.name] = m.id;
  return { T: r.json.share_token, tripId: r.json.id, id };
}

/**
 * 金額一律用日幣當「換到的」—— exponent 0,所以最小單位就是畫面上的數字。
 * 付出的是台幣(exponent 2),所以 NT$1,050 是 105000 —— 那兩個零是刻意留著的:
 * 這個功能最容易出的錯就是把台幣的分當成元,測試裡就該長成那樣。
 */
const yen = (T: string, body: J) => post(`/api/trips/${T}/expenses`, {
  kind: 'shared', payment_method: 'cash', spent_at: '2026-03-08', currency: 'JPY', ...body,
});

/** 記一筆換匯。預設是「在台灣用台幣換日幣」。 */
const exchange = (T: string, body: J) => post(`/api/trips/${T}/fx/exchanges`, {
  currency: 'JPY', cost_currency: 'TWD', exchanged_at: '2026-03-01', ...body,
});

async function listExchanges(T: string) {
  const r = await get(`/api/trips/${T}/fx/exchanges`);
  return { status: r.status, rows: (r.json.exchanges ?? []) as J[] };
}

/** 某個人某個幣別的錢包。找不到就回 null(那塊錢包不存在,不是剩餘為 0)。 */
async function walletOf(T: string, memberId: string, currency = 'JPY') {
  const bal = await get(`/api/trips/${T}/balance`);
  const w = ((bal.json.wallets ?? []) as J[]).find((x) => x.memberId === memberId);
  const row = ((w?.by_currency ?? []) as J[]).find((r) => r.currency === currency);
  return { bal: bal.json, wallet: w ?? null, row: row ?? null };
}

/**
 * 「現有的數字」的指紋。①②兩條不變量比的就是這個字串。
 *
 * 刻意**不含** wallets(那是新加的欄位,本來就會變),
 * 也不含 disclaimer / rate_attribution(常數字串,比了只是噪音)。
 */
const ledgerFingerprint = (bal: J) => JSON.stringify({
  base_currency: bal.base_currency,
  by_currency: bal.by_currency,
  per_member: bal.per_member,
  pot: bal.pot,
});

/** 結算的指紋 —— 預覽的淨額、轉帳、明細筆數,以及回合列表。 */
async function settleFingerprint(T: string) {
  const [preview, rounds] = await Promise.all([
    get(`/api/trips/${T}/rounds/preview`),
    get(`/api/trips/${T}/rounds`),
  ]);
  return JSON.stringify({ preview: preview.json, rounds: rounds.json });
}

// ═══════════════════════════════════════════════════════════════
group('[1] 記錄 → 列出 → 改 → 刪');
// ═══════════════════════════════════════════════════════════════
//
// 編輯的單位是**列**:錢包的 exchangedInMinor 是加總,對加總說
// 「改成 ¥12,000」沒有唯一解(要改哪一筆?各分掉多少?)。
// 所以列要能被列出來、被指定、被改、被刪。
{
  const c = await mkTrip('F1 CRUD', ['民', '喧']);

  const empty = await listExchanges(c.T);
  eq('還沒有任何換匯 → 200 空清單', `${empty.status} ${empty.rows.length}`, '200 0');

  const first = await exchange(c.T, {
    member_id: c.id['民'], amount_minor: 5000, cost_minor: 105000, note: '機場台銀',
  });
  eq('第 1 次 0.21 換 ¥5,000(付 NT$1,050)→ 201', first.status, 201);
  eq('回傳整列,不是只回 id',
    [first.json.amount_minor, first.json.cost_minor, first.json.cost_currency, first.json.exchanged_at],
    [5000, 105000, 'TWD', '2026-03-01']);

  const second = await exchange(c.T, {
    member_id: c.id['民'], amount_minor: 10000, cost_minor: 205000, exchanged_at: '2026-03-02',
  });
  eq('第 2 次 0.205 換 ¥10,000(付 NT$2,050)→ 201', second.status, 201);

  const l = await listExchanges(c.T);
  eq('兩筆都在,新的排前面', l.rows.map((r) => r.amount_minor), [10000, 5000]);
  eq('每一筆的有效匯率算得出來',
    l.rows.map((r) => formatRate(exchangeRate(r.amount_minor, r.currency, r.cost_minor, r.cost_currency))),
    ['0.205', '0.21']);
  check('清單沒有 rate 欄位(匯率是導出值,不存)',
    l.rows.every((r) => !('rate' in r)), JSON.stringify(Object.keys(l.rows[0] ?? {})));
  eq('備註跟著那一列走', l.rows.map((r) => r.note), [null, '機場台銀']);

  // ── 改 ──
  const up = await patch(`/api/trips/${c.T}/fx/exchanges/${first.json.id}`, {
    amount_minor: 6000, cost_minor: 126000,
  });
  eq('把第 1 筆改成 0.21 換 ¥6,000 → 200', up.status, 200);
  const afterEdit = (await listExchanges(c.T)).rows.find((r) => r.id === first.json.id)!;
  eq('那一列真的變了', [afterEdit.amount_minor, afterEdit.cost_minor], [6000, 126000]);
  eq('沒送的欄位保持原樣(備註、日期、成員)',
    [afterEdit.note, afterEdit.exchanged_at, afterEdit.member_id],
    ['機場台銀', '2026-03-01', c.id['民']]);

  const onlyDate = await patch(`/api/trips/${c.T}/fx/exchanges/${first.json.id}`, {
    exchanged_at: '2026-02-28',
  });
  eq('只改日期 → 200', onlyDate.status, 200);
  const afterDate = (await listExchanges(c.T)).rows.find((r) => r.id === first.json.id)!;
  eq('金額沒被歸零', [afterDate.amount_minor, afterDate.cost_minor], [6000, 126000]);
  eq('日期換了', afterDate.exchanged_at, '2026-02-28');

  const clearNote = await patch(`/api/trips/${c.T}/fx/exchanges/${first.json.id}`, { note: null });
  eq('送 note: null 會清掉備註 → 200', clearNote.status, 200);
  eq('備註真的被清掉',
    (await listExchanges(c.T)).rows.find((r) => r.id === first.json.id)!.note, null);

  // ── 刪 ──
  const rm = await del(`/api/trips/${c.T}/fx/exchanges/${first.json.id}`);
  eq('刪掉第 1 筆 → 200', rm.status, 200);
  const left = await listExchanges(c.T);
  eq('只剩第 2 筆', left.rows.map((r) => r.amount_minor), [10000]);
  eq('再刪同一筆 → 404(那筆確實不在了)',
    (await del(`/api/trips/${c.T}/fx/exchanges/${first.json.id}`)).status, 404);
}

// ═══════════════════════════════════════════════════════════════
group('[2] 錢包:剩餘 = 換入 − 現金支出 − 投入公費 − 付出還款 − 換出 + 收到的');
// ═══════════════════════════════════════════════════════════════
//
// 這一組跑的就是 issue 裡那張圖:
//   換匯   ¥15,000  (NT$3,100 · 平均 0.2067)
//   自己花  ¥6,200
//   投入公費 ¥2,000
//   ─────────────
//   還剩   ¥6,800
// 然後再一項一項把其餘三個流向加上去,每加一項都重新斷言剩餘。
// 逐項加而不是一次擺好,是為了在失敗時**指得出是哪一個流向算錯**。
{
  const c = await mkTrip('F2 錢包', ['民', '喧'], '公費');
  const mine = c.id['民'];

  // ① 換入:分兩次換,總共 ¥15,000 / NT$3,100
  eq('第 1 次 0.21 換 ¥5,000 → 201', (await exchange(c.T, {
    member_id: mine, amount_minor: 5000, cost_minor: 105000,
  })).status, 201);
  eq('第 2 次 0.205 換 ¥10,000 → 201', (await exchange(c.T, {
    member_id: mine, amount_minor: 10000, cost_minor: 205000,
  })).status, 201);

  {
    const { row } = await walletOf(c.T, mine);
    eq('換到 ¥15,000', row!.exchangedInMinor, 15000);
    eq('付出 NT$3,100(逐付出幣別,只有台幣一種)',
      row!.costs, [{ currency: 'TWD', amountMinor: 310000 }]);
    eq('加權平均匯率 0.2067(不是 0.2075)',
      formatRate(exchangeRate(row!.exchangedInMinor, 'JPY', row!.costs[0].amountMinor, 'TWD')),
      '0.2067');
    eq('什麼都還沒花 → 剩餘就是換到的', row!.remainingMinor, 15000);
  }

  // ② 自己付現的支出。**共同與個人都算** —— 問的是「口袋剩多少」,
  //    不是「這趟該分攤多少」。個人花費付的現金一樣離手了。
  eq('民付現墊共同晚餐 ¥4,200 → 201', (await yen(c.T, {
    description: '晚餐', amount: 4200,
    payers: [{ member_id: mine }],
    split: { mode: 'equal', members: [mine, c.id['喧']] },
  })).status, 201);
  eq('民付現買個人紀念品 ¥2,000 → 201', (await yen(c.T, {
    kind: 'personal', description: '紀念品', amount: 2000,
    payers: [{ member_id: mine }],
    split: { mode: 'exact', amounts: { [mine]: 2000 } },
  })).status, 201);

  {
    const { row } = await walletOf(c.T, mine);
    eq('自己花 ¥6,200(共同 4,200 + 個人 2,000)', row!.cashSpentMinor, 6200);
    eq('剩餘 15,000 − 6,200 = 8,800', row!.remainingMinor, 8800);
  }

  // ③ **刷卡不算。** 刷卡的錢從來沒有變成他手上的現金,
  //    算進來的話錢包會憑空少掉一整筆。
  eq('民刷卡買藥妝 ¥9,999 → 201', (await yen(c.T, {
    payment_method: 'card', description: '藥妝', amount: 9999,
    payers: [{ member_id: mine }],
    split: { mode: 'exact', amounts: { [mine]: 9999 } },
  })).status, 201);
  {
    const { row } = await walletOf(c.T, mine);
    eq('刷卡 ¥9,999 完全不影響現金支出', row!.cashSpentMinor, 6200);
    eq('剩餘不動', row!.remainingMinor, 8800);
  }

  // ④ 投入公費 —— 這也是離手,錢確實離開了他的口袋
  eq('民投入公費 ¥2,000 → 201', (await post(`/api/trips/${c.T}/pot/moves`, {
    direction: 'in', currency: 'JPY',
    entries: [{ member_id: mine, amount_minor: 2000 }],
  })).status, 201);
  {
    const { row } = await walletOf(c.T, mine);
    eq('投入公費 ¥2,000', row!.potContributedMinor, 2000);
    eq('剩餘 8,800 − 2,000 = 6,800 ← issue 裡那個數字', row!.remainingMinor, 6800);
  }

  // ⑤ 收到的錢(喧還他 ¥2,100 —— 晚餐那筆的一半)
  eq('喧還民 ¥2,100 → 201', (await post(`/api/trips/${c.T}/settlements`, {
    from_member: c.id['喧'], to_member: mine, currency: 'JPY', amount_minor: 2100,
  })).status, 201);
  {
    const { row } = await walletOf(c.T, mine);
    eq('收到 ¥2,100', row!.receivedInMinor, 2100);
    eq('剩餘 6,800 + 2,100 = 8,900', row!.remainingMinor, 8900);
  }

  // ⑥ 付出去的還款(和投入公費分開列 —— 兩者都是離手,但語意不同)。
  //
  //    要先讓民**真的欠錢**才還得出去:settlements.post 會擋「已經結清了
  //    還在記還款」(那會憑空生出債務)。所以先讓喧墊一筆共同支出。
  //    順帶驗一件事:喧付的現金**不該**動到民的錢包 —— 錢包是逐人的。
  eq('喧付現墊共同計程車 ¥1,000 → 201', (await yen(c.T, {
    description: '計程車', amount: 1000,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [mine, c.id['喧']] },
  })).status, 201);
  {
    const { row } = await walletOf(c.T, mine);
    eq('喧付的現金不影響民的錢包', [row!.cashSpentMinor, row!.remainingMinor], [6200, 8900]);
  }

  eq('民還喧 ¥300 → 201', (await post(`/api/trips/${c.T}/settlements`, {
    from_member: mine, to_member: c.id['喧'], currency: 'JPY', amount_minor: 300,
  })).status, 201);
  {
    const { row } = await walletOf(c.T, mine);
    eq('付出還款 ¥300(不含投入公費那 2,000)', row!.repaidOutMinor, 300);
    eq('投入公費仍然單獨列著', row!.potContributedMinor, 2000);
    eq('剩餘 8,900 − 300 = 8,600', row!.remainingMinor, 8600);
  }

  // ⑦ **換出:把日幣換回台幣。** 這一項最容易漏,而漏掉的症狀正好是
  //    這個功能最不能出的錯 —— 錢已經不在手上了,錢包還說有。
  eq('民用 ¥1,000 換回 NT$200 → 201', (await exchange(c.T, {
    member_id: mine, currency: 'TWD', amount_minor: 20000,
    cost_currency: 'JPY', cost_minor: 1000, exchanged_at: '2026-03-10',
  })).status, 201);
  {
    const { wallet, row } = await walletOf(c.T, mine);
    eq('日幣錢包記到「換成其他幣別 ¥1,000」', row!.exchangedOutMinor, 1000);
    eq('剩餘 8,600 − 1,000 = 7,600', row!.remainingMinor, 7600);

    /*
      ── 本位幣不開錢包 ──

      換回台幣**不會**長出一塊台幣錢包,即使「換到的」那一邊就是台幣。
      開了的話離手那一邊會變成胡說:出發前買日幣付掉的 NT$3,100 也是
      「台幣離手」,於是台幣剩餘 = 200 − 3,100 = −2,900,畫面跳出
      「花掉的比換到的多」—— 而事實上那 3,100 是從銀行帳戶出去的,
      不是從他口袋裡那 200 塊現金出去的。資料上分不出這兩種台幣,
      所以正確的做法是不要假裝分得出來(見 utils/wallet.ts)。

      這件事真正要影響的數字是**日幣少了 ¥1,000**,而那個上面已經驗過了。
    */
    const twd = ((wallet!.by_currency ?? []) as J[]).find((r) => r.currency === 'TWD');
    eq('沒有台幣錢包(本位幣在銀行帳戶裡,不是口袋裡的現金)', twd, undefined);
    eq('這個人只有一塊錢包', (wallet!.by_currency as J[]).map((r) => r.currency), ['JPY']);
  }

  // ⑧ 六個流向一起驗一次算式本身 —— 上面是逐項,這裡是總帳。
  {
    const { wallet } = await walletOf(c.T, mine);
    for (const row of (wallet!.by_currency ?? []) as J[]) {
      const paid = (row.costs as J[]).reduce((s, x) => s + x.amountMinor, 0);
      const expect = row.exchangedInMinor
        - row.cashSpentMinor - row.potContributedMinor
        - row.repaidOutMinor - row.exchangedOutMinor
        + row.receivedInMinor;
      eq(`${row.currency} 剩餘 = 換入 − 現金 − 公費 − 還款 − 換出 + 收到`,
        row.remainingMinor, expect);
      check(`${row.currency} 的 costs 加得起來(${paid})`, paid >= 0);
    }
  }

  // ⑨ 公費不會有錢包 —— 公費的剩餘是另一個概念(utils/pot.ts)。
  //    兩個都叫「剩餘」而且永遠不一樣,並排顯示沒有人分得出該信哪一個。
  {
    const { bal } = await walletOf(c.T, mine);
    const potWallet = ((bal.wallets ?? []) as J[]).find((w) => w.memberId === c.id['公費']);
    eq('公費沒有錢包', potWallet, undefined);
    check('公費的剩餘照舊由 pot 那一塊回答',
      Array.isArray(bal.pot?.by_currency) && bal.pot.by_currency.length > 0);
  }
}

// ═══════════════════════════════════════════════════════════════
group('[3] 回歸保護:換匯紀錄不影響任何現有數字');
// ═══════════════════════════════════════════════════════════════
//
// **這是整張 issue 最重要的一條。** 兩個方向都要測:
//   ① 沒有換匯紀錄 → wallets 是空陣列,其餘一字不動
//   ② 有了換匯紀錄 → 其餘**仍然**一字不動(含結算預覽與回合)
// 少了②,哪天有人把換匯匯率接進 convertToBase(),①還是會綠。
{
  const c = await mkTrip('F3 回歸', ['民', '喧'], '公費');
  eq('民墊晚餐 ¥8,000 兩人均分 → 201', (await yen(c.T, {
    description: '晚餐', amount: 8000,
    payers: [{ member_id: c.id['民'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('喧刷卡買門票 ¥3,000 兩人均分 → 201', (await yen(c.T, {
    payment_method: 'card', description: '門票', amount: 3000,
    payers: [{ member_id: c.id['喧'] }],
    split: { mode: 'equal', members: [c.id['民'], c.id['喧']] },
  })).status, 201);
  eq('兩人各投入公費 ¥5,000 → 201', (await post(`/api/trips/${c.T}/pot/moves`, {
    direction: 'in', currency: 'JPY',
    entries: [
      { member_id: c.id['民'], amount_minor: 5000 },
      { member_id: c.id['喧'], amount_minor: 5000 },
    ],
  })).status, 201);
  // 結算一次 —— 回合、回合的淨額快照、回合寫的轉帳都要進到指紋裡
  const round = await post(`/api/trips/${c.T}/rounds`, { currency: 'JPY', label: '第一晚' });
  eq('結算日幣 → 201', round.status, 201);

  const before = await get(`/api/trips/${c.T}/balance`);
  const beforeLedger = ledgerFingerprint(before.json);
  const beforeSettle = await settleFingerprint(c.T);

  // ── ① 沒有任何換匯紀錄 ──
  eq('wallets 是空陣列(不是 null、不是 undefined)', before.json.wallets, []);
  check('balance 仍然帶著原有的每一塊',
    !!before.json.by_currency && !!before.json.per_member && !!before.json.pot
    && typeof before.json.disclaimer === 'string');

  // ── ② 記了三筆換匯之後 ──
  eq('民 0.21 換 ¥5,000 → 201',
    (await exchange(c.T, { member_id: c.id['民'], amount_minor: 5000, cost_minor: 105000 })).status, 201);
  eq('民 0.205 換 ¥10,000 → 201',
    (await exchange(c.T, { member_id: c.id['民'], amount_minor: 10000, cost_minor: 205000 })).status, 201);
  eq('喧 0.208 換 ¥20,000 → 201',
    (await exchange(c.T, { member_id: c.id['喧'], amount_minor: 20000, cost_minor: 416000 })).status, 201);

  const after = await get(`/api/trips/${c.T}/balance`);
  eq('by_currency / per_member / pot 一個字都沒變',
    ledgerFingerprint(after.json), beforeLedger);
  eq('結算預覽與回合列表一個字都沒變', await settleFingerprint(c.T), beforeSettle);
  eq('只有 wallets 多了東西(兩個人)', (after.json.wallets as J[]).length, 2);

  // 改一筆、刪一筆之後再驗一次 —— 「不影響結算」不能只在新增時成立。
  const rows = (await listExchanges(c.T)).rows;
  eq('改一筆金額 → 200',
    (await patch(`/api/trips/${c.T}/fx/exchanges/${rows[0]!.id}`,
      { amount_minor: 999, cost_minor: 20800 })).status, 200);
  eq('刪一筆 → 200', (await del(`/api/trips/${c.T}/fx/exchanges/${rows[1]!.id}`)).status, 200);

  const edited = await get(`/api/trips/${c.T}/balance`);
  eq('改 / 刪之後,現有數字仍然一字不動',
    ledgerFingerprint(edited.json), beforeLedger);
  eq('改 / 刪之後,結算仍然一字不動', await settleFingerprint(c.T), beforeSettle);

  // 全部刪掉 → 回到完全沒有換匯紀錄的狀態,wallets 應該又是空的
  for (const r of (await listExchanges(c.T)).rows) {
    eq(`刪掉 ${r.amount_minor} → 200`, (await del(`/api/trips/${c.T}/fx/exchanges/${r.id}`)).status, 200);
  }
  const cleaned = await get(`/api/trips/${c.T}/balance`);
  eq('刪光之後 wallets 回到空陣列', cleaned.json.wallets, []);
  eq('刪光之後現有數字還是一字不動', ledgerFingerprint(cleaned.json), beforeLedger);
}

// ═══════════════════════════════════════════════════════════════
group('[4] 加權平均匯率與紀錄的順序無關');
// ═══════════════════════════════════════════════════════════════
//
// 這條之所以是**結構性**成立的,就是因為資料庫存的是兩邊的金額而不是匯率:
// 平均是「Σ付出 ÷ Σ換到」,兩個總和都與加總順序無關。
// 存 rate 的話就得把每筆的匯率再平均一次,那個會被順序與筆數影響
// (0.21 與 0.205 平均是 0.2075,而正確答案是 0.2067)。
{
  const forward = await mkTrip('F4 順序 A', ['民']);
  const backward = await mkTrip('F4 順序 B', ['民']);
  const pair: Array<[number, number]> = [[5000, 105000], [10000, 205000]];

  for (const [amount, cost] of pair) {
    eq(`A 依序寫入 ¥${amount}`, (await exchange(forward.T, {
      member_id: forward.id['民'], amount_minor: amount, cost_minor: cost,
    })).status, 201);
  }
  for (const [amount, cost] of [...pair].reverse()) {
    eq(`B 逆序寫入 ¥${amount}`, (await exchange(backward.T, {
      member_id: backward.id['民'], amount_minor: amount, cost_minor: cost,
    })).status, 201);
  }

  const a = (await walletOf(forward.T, forward.id['民'])).row!;
  const b = (await walletOf(backward.T, backward.id['民'])).row!;
  eq('兩邊的換入總額一樣', [a.exchangedInMinor, b.exchangedInMinor], [15000, 15000]);
  eq('兩邊的付出總額一樣', [a.costs[0].amountMinor, b.costs[0].amountMinor], [310000, 310000]);

  const rateA = exchangeRate(a.exchangedInMinor, 'JPY', a.costs[0].amountMinor, 'TWD');
  const rateB = exchangeRate(b.exchangedInMinor, 'JPY', b.costs[0].amountMinor, 'TWD');
  eq('加權平均匯率完全相同', rateA, rateB);
  eq('而且是 0.2067,不是把匯率再平均的 0.2075', formatRate(rateA), '0.2067');
}

// ═══════════════════════════════════════════════════════════════
group('[5] 剩餘變成負的只警告不阻擋');
// ═══════════════════════════════════════════════════════════════
//
// 最常見的原因是「在當地 ATM 提過款還沒記」—— 那是**少記了一筆**,
// 不是記錯了。擋下來的話,「先記支出、晚點才補記換匯」這個旅途中
// 最自然的順序會做不到,而使用者只會覺得系統在刁難他。
//
// 對照 utils/pot.ts:公費剩餘變負是**要擋**的,因為結算會據此寫出一筆
// 憑空生出來的真實轉帳。錢包沒有那個下游,所以刻意不擋。
{
  const c = await mkTrip('F5 負剩餘', ['民']);
  const mine = c.id['民'];

  // 先記一筆很大的現金支出,再記一筆很小的換匯
  eq('民付現花掉 ¥30,000 → 201', (await yen(c.T, {
    kind: 'personal', description: '相機', amount: 30000,
    payers: [{ member_id: mine }],
    split: { mode: 'exact', amounts: { [mine]: 30000 } },
  })).status, 201);
  const small = await exchange(c.T, { member_id: mine, amount_minor: 5000, cost_minor: 105000 });
  eq('只換了 ¥5,000 —— 仍然寫得進去(201,不是 4xx)', small.status, 201);

  const { row } = await walletOf(c.T, mine);
  eq('剩餘是 −25,000,誠實顯示', row!.remainingMinor, -25000);

  // 補記在當地 ATM 提的款 → 剩餘歸位。這就是「警告而不是阻擋」的價值:
  // 使用者看到負數才知道自己漏記了什麼。
  eq('補記 ATM 提款 ¥30,000 → 201', (await exchange(c.T, {
    member_id: mine, amount_minor: 30000, cost_minor: 630000, exchanged_at: '2026-03-09',
  })).status, 201);
  eq('剩餘回到 +5,000', (await walletOf(c.T, mine)).row!.remainingMinor, 5000);

  // 改小到讓剩餘再變負,一樣不擋
  const rows = (await listExchanges(c.T)).rows;
  const big = rows.find((r) => r.amount_minor === 30000)!;
  eq('把那筆改成 ¥1,000 → 200(不因為剩餘會變負而被擋)',
    (await patch(`/api/trips/${c.T}/fx/exchanges/${big.id}`,
      { amount_minor: 1000, cost_minor: 21000 })).status, 200);
  eq('剩餘變成 −24,000', (await walletOf(c.T, mine)).row!.remainingMinor, -24000);
}

// ═══════════════════════════════════════════════════════════════
group('[6] 寫入驗證 —— 擋掉的每一種都要說得出原因');
// ═══════════════════════════════════════════════════════════════
{
  const c = await mkTrip('F6 驗證', ['民'], '公費');
  const other = await mkTrip('F6 別趟', ['阿']);
  const mine = c.id['民'];

  const bad = async (label: string, body: J, wantStatus = 400) => {
    const r = await exchange(c.T, body);
    eq(label, r.status, wantStatus);
    check(`  ↳ 而且說得出原因`, typeof r.json.statusMessage === 'string' && r.json.statusMessage.length > 5,
      JSON.stringify(r.json).slice(0, 160));
  };

  // ── 公費不能換匯 ──
  // 允許的話,同一個實體上會同時掛著兩個定義不同的「剩餘」
  // (公費剩餘 = 投入 − 付掉 − 退還;錢包剩餘 = 換入 − 離手 + 收到),
  // 兩個並排顯示、名字都叫剩餘、而且永遠不一樣。
  await bad('公費換匯 → 400', { member_id: c.id['公費'], amount_minor: 5000, cost_minor: 105000 });

  // ── 同幣別 ──
  // 匯率恆為 1,而且錢包的兩邊會互相抵銷:換入 +10,000、換出 −10,000,
  // 剩餘一動也不動,清單上卻多一筆莫名的紀錄。
  await bad('換到的和付出的都是 JPY → 400',
    { member_id: mine, currency: 'JPY', cost_currency: 'JPY', amount_minor: 5000, cost_minor: 5000 });

  // ── 別趟的成員 ──
  await bad('用別趟的成員 id → 400',
    { member_id: other.id['阿'], amount_minor: 5000, cost_minor: 105000 });
  await bad('用不存在的成員 id → 400',
    { member_id: 'nope-nope-nope', amount_minor: 5000, cost_minor: 105000 });

  // ── 金額 ──
  await bad('換到 0 → 400', { member_id: mine, amount_minor: 0, cost_minor: 105000 });
  await bad('付出 0 → 400', { member_id: mine, amount_minor: 5000, cost_minor: 0 });
  await bad('換到負數 → 400', { member_id: mine, amount_minor: -5000, cost_minor: 105000 });
  await bad('小數(不是最小單位整數)→ 400',
    { member_id: mine, amount_minor: 5000.5, cost_minor: 105000 });
  await bad('缺少 member_id → 400', { amount_minor: 5000, cost_minor: 105000 });

  // ── 幣別 / 日期 ──
  await bad('不支援的幣別 → 400',
    { member_id: mine, currency: 'XXX', amount_minor: 5000, cost_minor: 105000 });
  await bad('日期看不懂 → 400',
    { member_id: mine, amount_minor: 5000, cost_minor: 105000, exchanged_at: '昨天' });
  await bad('那一天不存在(2026-02-30)→ 400',
    { member_id: mine, amount_minor: 5000, cost_minor: 105000, exchanged_at: '2026-02-30' });

  // 被擋掉之後資料庫要一個字都沒動
  eq('以上全部被擋,清單仍然是空的', (await listExchanges(c.T)).rows.length, 0);

  // ── 不給日期 = 今天 ──
  const noDate = await post(`/api/trips/${c.T}/fx/exchanges`, {
    member_id: mine, currency: 'JPY', amount_minor: 5000, cost_minor: 105000,
  });
  eq('不給 exchanged_at → 201,而且是今天', noDate.status, 201);
  eq('日期是今天', noDate.json.exchanged_at, new Date().toISOString().slice(0, 10));
  eq('不給 cost_currency → 用旅程的本位幣', noDate.json.cost_currency, 'TWD');

  // ── 改 / 刪 別趟的列 ──
  eq('改別趟的換匯 → 404',
    (await patch(`/api/trips/${other.T}/fx/exchanges/${noDate.json.id}`,
      { amount_minor: 1 })).status, 404);
  eq('刪別趟的換匯 → 404',
    (await del(`/api/trips/${other.T}/fx/exchanges/${noDate.json.id}`)).status, 404);
  eq('那一列完全沒被動到',
    (await listExchanges(c.T)).rows.map((r) => r.amount_minor), [5000]);

  eq('改不存在的 id → 404',
    (await patch(`/api/trips/${c.T}/fx/exchanges/nope`, { amount_minor: 1 })).status, 404);

  // 改的驗證和新增走同一份(utils/exchange.ts),所以只驗它真的接上了
  eq('改成 0 → 400',
    (await patch(`/api/trips/${c.T}/fx/exchanges/${noDate.json.id}`,
      { amount_minor: 0 })).status, 400);
  eq('改成看不懂的日期 → 400',
    (await patch(`/api/trips/${c.T}/fx/exchanges/${noDate.json.id}`,
      { exchanged_at: 'tomorrow' })).status, 400);
  eq('被擋之後那一列還是原樣',
    (await listExchanges(c.T)).rows.map((r) => [r.amount_minor, r.exchanged_at]),
    [[5000, new Date().toISOString().slice(0, 10)]]);
}

// ═══════════════════════════════════════════════════════════════
group('[7] 權限:換匯紀錄跟著旅程的存取控制走');
// ═══════════════════════════════════════════════════════════════
//
// 四支端點都走 requireTrip(),所以「光知道 trip id 不等於有權限」這條
// 對它們自動成立(見 utils/trip.ts)。這一組是確認它們真的接上了 ——
// 漏接的那一支會變成整個權限層的後門。
{
  const c = await mkTrip('F7 權限', ['民']);
  const made = await exchange(c.T, {
    member_id: c.id['民'], amount_minor: 5000, cost_minor: 105000,
  });
  eq('先記一筆 → 201', made.status, 201);

  // 另一個帳號,完全沒有這趟的權限
  const stranger = await loginFixture(base, 'fx-stranger');
  eq('陌生人用 trip id 列出換匯 → 404',
    (await stranger.get(`/api/trips/${c.tripId}/fx/exchanges`)).status, 404);
  eq('陌生人記一筆 → 404',
    (await stranger.post(`/api/trips/${c.tripId}/fx/exchanges`, {
      member_id: c.id['民'], currency: 'JPY', amount_minor: 1, cost_minor: 1,
    })).status, 404);
  eq('陌生人改一筆 → 404',
    (await stranger.patch(`/api/trips/${c.tripId}/fx/exchanges/${made.json.id}`,
      { amount_minor: 1 })).status, 404);
  eq('陌生人刪一筆 → 404',
    (await stranger.del(`/api/trips/${c.tripId}/fx/exchanges/${made.json.id}`)).status, 404);

  eq('那一列完全沒被動到', (await listExchanges(c.T)).rows.map((r) => r.amount_minor), [5000]);

  // 持有 share_token 的旅伴可以記(免註冊協作是這個 app 的核心)
  eq('旅伴憑 share_token 列得出來',
    (await stranger.get(`/api/trips/${c.T}/fx/exchanges`)).status, 200);
  eq('旅伴憑 share_token 記得進去',
    (await stranger.post(`/api/trips/${c.T}/fx/exchanges`, {
      member_id: c.id['民'], currency: 'JPY', amount_minor: 3000, cost_minor: 63000,
    })).status, 201);
  eq('兩筆都在', (await listExchanges(c.T)).rows.length, 2);
}

process.exit(summary() > 0 ? 1 : 0);
