/**
 * 併發與競態的整合測試。打真實 dev server + 真實本機 D1。
 *
 *   pnpm dev              # 另一個終端
 *   pnpm test:concurrency
 *
 * ══ 為什麼需要這一支 ══════════════════════════════════════════
 *
 * 這支是為一次對抗性稽核寫的。當時單元 + API 測試共 576 項全綠,
 * 而稽核用 `Promise.all` 打同一組端點,立刻挖出兩個**會算錯錢**的漏洞:
 *
 *   1. 點「結算」之後 3ms 點「標記已還款」,兩支都回 201
 *      → 1,500 的債被記了 3,000,然後 App 開始叫收錢的人反過來付 1,500 回去
 *      (命中率 19/20)
 *   2. 兩支手機同時退還「剛好等於全部餘額」的金額,兩筆都寫進去
 *      → 公費剩餘變負數 → 結算據此寫出一筆多 6,000 的真實轉帳,憑空生出來的
 *
 * 全部測試裡**一個 `Promise.all` 都沒有** —— 這就是它們活下來的原因。
 * 所有「先讀狀態、再判斷、最後在另一次往返寫入」的端點都有這個空窗;
 * localhost 約 15ms,Workers 打遠端 D1 是幾十到幾百毫秒
 * (讀取階段有 4 次往返)—— 網路慢的時候手殘點兩下就中。
 *
 * 這支的每一個 group 都對應一個當時真的發生過的災難。
 * 修法是把「讀到的狀態」變成資料庫層的寫入前提(樂觀鎖),
 * 而不是在 JS 裡多加一個 if —— 多加 if 只會讓空窗變小,不會消失。
 */
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
const session = await loginFixture(base, 'conc');
const req = session.req;
const get = (p: string) => req('GET', p);
const post = (p: string, b?: unknown) => req('POST', p, b);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);
const del = (p: string) => req('DELETE', p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await post('/api/admin/sync-rates');

/** 開一趟乾淨的旅程。每個案例都要自己一趟,否則互相污染。 */
async function newTrip(withPot: boolean) {
  const t = await post('/api/trips', {
    name: `併發測試 ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    base_currency: 'TWD',
    members: ['A', 'B'],
    ...(withPot ? { pot: '公費' } : {}),
  });
  const T = t.json.share_token as string;
  const members: Array<{ id: string; name: string; is_pot: number }> = (await get(`/api/trips/${T}`)).json.members;
  const id: Record<string, string> = {};
  for (const m of members) id[m.name] = m.id;
  const potId = members.find((m) => m.is_pot === 1)?.id ?? '';
  return { T, id, potId };
}

/** 一筆 A 墊款、A/B 對半分的共同支出 */
async function dinner(T: string, id: Record<string, string>, amount: number, currency = 'TWD') {
  const half = currency === 'TWD' ? amount / 2 : Math.floor(amount / 2);
  return post(`/api/trips/${T}/expenses`, {
    kind: 'shared', description: '晚餐', currency, amount, spent_at: '2026-03-08',
    payers: [{ member_id: id.A }],
    split: { mode: 'exact', amounts: { [id.A!]: half, [id.B!]: amount - half } },
  });
}

/** 這個幣別所有人的淨額絕對值加總。0 = 完全結清,沒有多記也沒有少記。 */
async function netAbsSum(T: string, currency = 'TWD'): Promise<number> {
  const bal = (await get(`/api/trips/${T}/balance`)).json;
  return ((bal.by_currency?.[currency]?.nets ?? []) as J[])
    .reduce((s, n) => s + Math.abs(n.netMinor), 0);
}

async function settlementRows(T: string) {
  const bal = (await get(`/api/trips/${T}/balance`)).json;
  return bal;
}

// ═══════════════════════════════════════════════════════════════
group('[競態] 關閉回合 vs 標記已還款 —— 同一筆債不能被記兩次');

// 這兩顆按鈕在同一個畫面上(結算頁),所以「先按結算、手指順勢又點到還款」
// 是完全正常的操作。稽核當時 19/20 會讓 1,500 的債被記成 3,000,
// 而且之後 App 會叫收錢的人反過來付回去 —— 錯得非常有說服力。
// 判準要選對。「一定要完全結清」是**錯的**判準:兩支請求互相衝突時,
// 兩支都被擋下來(債務原封不動)是完全安全的結果 —— 錢沒有錯,只是還沒付。
//
// 真正不能發生的是**重複記帳**:同一筆 1,500 的債被記了 3,000,
// 於是墊錢的那個人反過來變成欠錢,而 App 會叫他把錢付回去。
// 所以判準是:墊錢的人的淨額永遠不可以是負的。
{
  const ROUNDS = 12;
  let payerOwes = 0;      // 墊錢的人反而欠錢 = 重複記帳(絕對不能發生)
  let overRecorded = 0;   // 記進去的還款總額超過原本的債務
  const outcomes: Record<string, number> = {};

  for (let k = 0; k < ROUNDS; k++) {
    const { T, id } = await newTrip(false);
    await dinner(T, id, 3000);
    const pv = (await get(`/api/trips/${T}/rounds/preview?currency=TWD`)).json.blocks[0];

    const [close, manual] = await Promise.all([
      post(`/api/trips/${T}/rounds`, {
        currency: 'TWD',
        expect: { item_count: pv.item_count, recorded_count: pv.recorded.length },
      }),
      post(`/api/trips/${T}/settlements`, {
        from_member: id.B, to_member: id.A, currency: 'TWD', amount_minor: 150000,
      }),
    ]);
    outcomes[`${close.status}/${manual.status}`] = (outcomes[`${close.status}/${manual.status}`] ?? 0) + 1;

    const bal = await settlementRows(T);
    const nets = (bal.by_currency?.TWD?.nets ?? []) as J[];
    const netA = nets.find((n) => n.memberId === id.A)?.netMinor ?? 0;

    // A 墊了 3,000、只用 1,500,所以 A 永遠是債權人(淨額 ≥ 0)。
    // 變成負的就代表那 1,500 被記了兩次。
    if (netA < 0) payerOwes++;
    // 淨額絕對值總和只有兩種合法值:0(結清)或 300000(完全沒動)
    const abs = await netAbsSum(T);
    if (abs !== 0 && abs !== 300000) overRecorded++;
  }

  eq(`${ROUNDS} 次同時操作,墊錢的人從未反而欠錢(= 沒有重複記帳)`, payerOwes, 0);
  eq('餘額只會是「結清」或「原封不動」,不會出現第三種數字', overRecorded, 0);
  check('兩支請求不會同時成功(有一支必須被擋下)',
    !outcomes['201/201'], `狀態組合: ${JSON.stringify(outcomes)}`);
}

group('[競態] 兩支還款同時打向同一個收款人 —— 不能超過他的債權');

// settlements.post 的上限是 min(付款人欠款, 收款人債權)。JS 那道只是為了給出
// 帶數字的錯誤訊息,真正擋併發的是 `INSERT ... SELECT ... WHERE` 裡的兩個前提。
//
// **這一組是收款人那一側唯一抓得到的地方**:JS 檢查和 SQL 前提算的是同一個上限,
// 所以只要 JS 還在,循序打 API 看不出 SQL 那一半有沒有寫(api.rounds 的 [17]
// 全綠也不代表 SQL 那道存在)。要分開它們就必須讓兩支請求同時通過 JS。
//
// 情境:公費付 4,000 元兩人均分、A 墊 10,000 元兩人均分
//   → 淨額 A +3,000 / B −7,000 / 公費 +4,000,建議只有 B→A 3,000 元
//   → B 欠 7,000,所以「2,500 + 2,500」兩支在付款人那一側都過得了
//   → 但 A 只被欠 3,000,第二支必須被收款人那一側擋掉
// 少了那個前提:兩支都寫進去 → A 的淨額變成 −2,000 元,憑空多出一筆欠款,
// 而那 5,000 元裡有 2,000 元本來該回到公費信封。
{
  const ROUNDS = 8;
  const AMOUNT = 250000;        // 每支 2,500 元
  const CREDIT = 300000;        // A 實際被欠 3,000 元
  let negative = 0;             // 收款人淨額變負 = 憑空生出假債務(絕對不能發生)
  let overshoot = 0;            // 記進去的還款總額超過收款人的債權
  let sqlBlocked = 0;           // 由資料庫層那道擋下來的次數(= 兩支都通過了 JS)
  const outcomes: Record<string, number> = {};

  for (let k = 0; k < ROUNDS; k++) {
    const { T, id, potId } = await newTrip(true);
    await post(`/api/trips/${T}/expenses`, {
      kind: 'shared', description: '公費早餐', currency: 'TWD', amount: 4000, spent_at: '2026-03-08',
      payers: [{ member_id: potId }],
      split: { mode: 'equal', members: [id.A, id.B] },
    });
    await post(`/api/trips/${T}/expenses`, {
      kind: 'shared', description: '晚餐', currency: 'TWD', amount: 10000, spent_at: '2026-03-08',
      payers: [{ member_id: id.A }],
      split: { mode: 'equal', members: [id.A, id.B] },
    });

    const pair = await Promise.all([
      post(`/api/trips/${T}/settlements`, {
        from_member: id.B, to_member: id.A, currency: 'TWD', amount_minor: AMOUNT,
      }),
      post(`/api/trips/${T}/settlements`, {
        from_member: id.B, to_member: id.A, currency: 'TWD', amount_minor: AMOUNT,
      }),
    ]);
    const key = pair.map((r) => r.status).sort().join('/');
    outcomes[key] = (outcomes[key] ?? 0) + 1;

    // 兩道防線的錯誤訊息不一樣,所以「是誰擋的」看得出來。
    // 訊息裡有「這一瞬間」= 走到了 INSERT 才被前提擋掉 = JS 兩支都放行過。
    if (pair.some((r) => r.status === 409
      && String(r.json.statusMessage ?? '').includes('這一瞬間'))) sqlBlocked++;

    const bal = (await get(`/api/trips/${T}/balance`)).json;
    const netA = ((bal.by_currency?.TWD?.nets ?? []) as J[])
      .find((n) => n.memberId === id.A)?.netMinor ?? 0;
    // A 墊了 10,000 元、自己只該分攤 7,000 元,所以 A 永遠是債權人(淨額 ≥ 0)。
    // 變成負的就代表有一筆還款被記到了他沒有的債權上。
    if (netA < 0) negative++;
    if (pair.filter((r) => r.status === 201).length * AMOUNT > CREDIT) overshoot++;
  }

  eq(`${ROUNDS} 次同時還款,收款人的淨額從未變成負的(= 沒有生出假債務)`, negative, 0);
  eq('記進去的還款總額從未超過收款人當時的債權', overshoot, 0);
  check('兩支不會同時成功(第二支必須被收款人那一側擋掉)',
    !outcomes['201/201'], `狀態組合: ${JSON.stringify(outcomes)}`);
  // 這一條是在守「測試本身有效」:如果 JS 每次都先擋掉一支,這一組就沒有真的
  // 測到資料庫層那道前提,上面三條會在 SQL 少一半的情況下照樣全綠。
  check('至少一次是由資料庫層那道前提擋下來的(兩支都通過了 JS 檢查)',
    sqlBlocked > 0, `sqlBlocked=${sqlBlocked}/${ROUNDS}, 狀態組合: ${JSON.stringify(outcomes)}`);
}

group('[競態] 同時關閉同一個幣別 —— 只能成立一個回合');

{
  const { T, id } = await newTrip(false);
  await dinner(T, id, 3000);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => post(`/api/trips/${T}/rounds`, { currency: 'TWD' })),
  );
  const created = results.filter((r) => r.status === 201).length;
  eq('剛好一個成功', created, 1);
  eq('其餘全部 409', results.filter((r) => r.status === 409).length, 4);

  const rounds = (await get(`/api/trips/${T}/rounds`)).json as J[];
  eq('資料庫裡剛好一個回合', rounds.length, 1);
  eq('剛好一筆轉帳', rounds[0]?.transfer_count, 1);
  eq('全部結清(淨額歸零)', await netAbsSum(T), 0);
}

group('[競態] 過期的畫面不能結算 —— 期間新增了一筆帳');

{
  const { T, id } = await newTrip(false);
  await dinner(T, id, 3000);
  const pv = (await get(`/api/trips/${T}/rounds/preview?currency=TWD`)).json.blocks[0];

  // 使用者看完畫面之後,另一支手機記了一筆
  await post(`/api/trips/${T}/expenses`, {
    kind: 'shared', description: '計程車', currency: 'TWD', amount: 1000, spent_at: '2026-03-08',
    payers: [{ member_id: id.B }],
    split: { mode: 'exact', amounts: { [id.A!]: 500, [id.B!]: 500 } },
  });

  const stale = await post(`/api/trips/${T}/rounds`, {
    currency: 'TWD',
    expect: { item_count: pv.item_count, recorded_count: pv.recorded.length },
  });
  eq('用過期指紋結算 → 409', stale.status, 409);
  eq('什麼都沒寫進去(沒有回合)', ((await get(`/api/trips/${T}/rounds`)).json as J[]).length, 0);
}

group('[競態] 還款在讀取與寫入之間插進來 —— 樂觀鎖必須擋住');

// 這個是 CRIT-1 的最小化版本:不靠時間差,直接製造出「讀到的狀態已經過期」。
// 先拿到 preview(讀),再手動記一筆還款(改變狀態),然後不帶 expect 結算。
// 沒有資料庫層前提的話這裡會 201 並把已經還過的錢再記一次。
{
  const { T, id } = await newTrip(false);
  await dinner(T, id, 3000);
  await get(`/api/trips/${T}/rounds/preview?currency=TWD`);

  await post(`/api/trips/${T}/settlements`, {
    from_member: id.B, to_member: id.A, currency: 'TWD', amount_minor: 150000,
  });

  // 這時候整趟已經結清了,所以「沒有待轉帳」但還有 1 筆未蓋章的明細 →
  // 允許成立一個只蓋章、不寫轉帳的回合。關鍵是它**不能**再寫一筆轉帳。
  const close = await post(`/api/trips/${T}/rounds`, { currency: 'TWD' });
  check('結算被受理或被擋都可以,但不能記出錯的錢',
    close.status === 201 || close.status === 409, String(close.status));
  eq('淨額仍然是 0(沒有把還過的錢再記一次)', await netAbsSum(T), 0);

  const rounds = (await get(`/api/trips/${T}/rounds`)).json as J[];
  if (rounds.length) {
    eq('若回合成立,它不該產生任何轉帳', rounds[0]?.transfer_count, 0);
  }
}

// ═══════════════════════════════════════════════════════════════
group('[競態] 公費退還:併發不能把餘額弄成負的');

// 稽核當時兩筆各自都在上限內、同時送出 → 兩筆都寫進去 → 公費剩餘 −6,000,
// 而結算據此寫出一筆多 6,000 的真實轉帳。那 6,000 是憑空生出來的。
{
  const CASES = 6;
  let negative = 0;
  let overshoot = 0;

  for (let k = 0; k < CASES; k++) {
    const { T, id, potId } = await newTrip(true);
    await post(`/api/trips/${T}/pot/moves`, {
      direction: 'in', currency: 'TWD', entries: [{ member_id: id.A, amount_minor: 1000000 }],
    });
    await post(`/api/trips/${T}/expenses`, {
      kind: 'shared', description: '公費晚餐', currency: 'TWD', amount: 4000, spent_at: '2026-03-08',
      payers: [{ member_id: potId }],
      split: { mode: 'equal', members: [id.A, id.B] },
    });
    // 剩餘 = 1,000,000 − 400,000 = 600,000

    await Promise.all([
      post(`/api/trips/${T}/pot/moves`, {
        direction: 'out', currency: 'TWD', entries: [{ member_id: id.B, amount_minor: 600000 }],
      }),
      post(`/api/trips/${T}/pot/moves`, {
        direction: 'out', currency: 'TWD', entries: [{ member_id: id.B, amount_minor: 600000 }],
      }),
    ]);

    const bal = await settlementRows(T);
    const row = (bal.pot?.by_currency ?? []).find((c: J) => c.currency === 'TWD');
    const remaining = row?.remainingMinor ?? 0;
    if (remaining < 0) negative++;
    if ((row?.refundedMinor ?? 0) > 600000) overshoot++;
  }

  eq(`${CASES} 次併發退還,沒有一次讓公費剩餘變負`, negative, 0);
  eq('退還總額從未超過當時的可退餘額', overshoot, 0);
}

group('[競態] 公費投入:併發不能少記或多記');

{
  const { T, id } = await newTrip(true);
  // 兩支手機同時各記一次「兩個人各投 5,000」
  const both = await Promise.all([
    post(`/api/trips/${T}/pot/moves`, {
      direction: 'in', currency: 'TWD',
      entries: [{ member_id: id.A, amount_minor: 500000 }, { member_id: id.B, amount_minor: 500000 }],
    }),
    post(`/api/trips/${T}/pot/moves`, {
      direction: 'in', currency: 'TWD',
      entries: [{ member_id: id.A, amount_minor: 500000 }, { member_id: id.B, amount_minor: 500000 }],
    }),
  ]);
  const ok = both.filter((r) => r.status === 201).length;
  const bal = await settlementRows(T);
  const row = (bal.pot?.by_currency ?? []).find((c: J) => c.currency === 'TWD');
  // 投入沒有上限,兩次都成立是正確的(那是兩個真的決定)——
  // 重點是金額必須剛好等於受理的次數 × 10,000,不能少記也不能多記。
  eq('投入總額 = 受理次數 × 10,000', row?.contributedMinor, ok * 1000000);
  eq('剩餘 = 投入(還沒有支出)', row?.remainingMinor, ok * 1000000);
}

// ═══════════════════════════════════════════════════════════════
group('[不變量] 公費淨額 = 公費花費,在併發之後仍然成立');

// 這條是整個公費功能的正確性支點。稽核找到唯一能讓它失效的路徑是
// 「把已經有帳的成員改標成公費」,那個現在被 409 擋住了。
//
// ⚠️ 舊版這裡驗的是「剩餘 = −公費淨額」。淨額改成不含投入/退還之後那條不再成立
// (見 server/utils/ledger.ts 開頭)—— 剩餘只住在 pot.by_currency,
// 而淨額換成和 spentMinor 對帳。兩者仍然是兩條獨立路徑算同一個數字:
// spentMinor 直接加總 expense_payers,淨額走 netBalances 的加減。
{
  const { T, id, potId } = await newTrip(true);
  await post(`/api/trips/${T}/pot/moves`, {
    direction: 'in', currency: 'TWD',
    entries: [{ member_id: id.A, amount_minor: 800000 }, { member_id: id.B, amount_minor: 800000 }],
  });
  await post(`/api/trips/${T}/expenses`, {
    kind: 'shared', description: '公費門票', currency: 'TWD', amount: 6000, spent_at: '2026-03-08',
    payers: [{ member_id: potId }],
    split: { mode: 'equal', members: [id.A, id.B] },
  });
  await Promise.all([
    post(`/api/trips/${T}/pot/moves`, {
      direction: 'out', currency: 'TWD', entries: [{ member_id: id.A, amount_minor: 200000 }],
    }),
    post(`/api/trips/${T}/rounds`, { currency: 'TWD' }),
  ]);

  const bal = await settlementRows(T);
  const row = (bal.pot?.by_currency ?? []).find((c: J) => c.currency === 'TWD');
  const nets = (bal.by_currency?.TWD?.nets ?? []) as J[];
  const potNet = nets.find((n) => n.memberId === potId)?.netMinor ?? 0;
  eq('公費淨額 = 公費花費', potNet, row?.spentMinor);
  eq('Σ(真人淨額) = −公費花費',
    nets.filter((n) => n.memberId !== potId).reduce((s, n) => s + n.netMinor, 0),
    -(row?.spentMinor ?? 0));
  eq('淨額總和仍為 0', nets.reduce((s, n) => s + n.netMinor, 0), 0);
  // 投入 1,600,000 − 花掉 600,000 − 退還(成功的話 200,000)。退還可能被回合擠掉,
  // 所以只斷言「剩餘完全由 pot 的三個量決定」,不去猜那一次併發誰贏。
  eq('剩餘 = 投入 − 花費 − 退還(和淨額無關)',
    row?.remainingMinor,
    (row?.contributedMinor ?? 0) - (row?.spentMinor ?? 0) - (row?.refundedMinor ?? 0));
}

group('[防護] 個人花費的付款人不能事後被改成公費');

// 這條路徑會讓「公費淨額 = 公費花費」差掉那筆個人花費的金額,
// 而那筆錢會卡在沒有任何畫面能解決的地方(實測 5,000 卡住):
// 剩餘說公費花掉了,卻沒有任何人的淨額欠著它。
{
  const { T, id } = await newTrip(false);
  await post(`/api/trips/${T}/expenses`, {
    kind: 'personal', description: '計程車', currency: 'TWD', amount: 5000, spent_at: '2026-03-08',
    payers: [{ member_id: id.A }],
    split: { mode: 'exact', amounts: { [id.A!]: 5000 } },
  });
  const p = await patch(`/api/trips/${T}/members/${id.A}`, { is_pot: true });
  eq('把有帳的成員改成公費 → 409', p.status, 409);
}

{
  // 反面:完全沒有帳的成員可以被標成公費(否則這個防護就過度了)
  const { T, id } = await newTrip(false);
  const p = await patch(`/api/trips/${T}/members/${id.B}`, { is_pot: true });
  eq('沒有帳的成員可以改成公費 → 200', p.status, 200);
}

group('[防護] 公費退還的上限:兩支端點都要守');

// settlements.post 和 pot/moves 寫的是**完全一樣的那一列**。
// 只守一邊的話,擋在那邊的請求換成打另一邊就過了。
{
  const { T, id, potId } = await newTrip(true);
  await post(`/api/trips/${T}/pot/moves`, {
    direction: 'in', currency: 'TWD', entries: [{ member_id: id.A, amount_minor: 1000000 }],
  });

  const viaMoves = await post(`/api/trips/${T}/pot/moves`, {
    direction: 'out', currency: 'TWD', entries: [{ member_id: id.B, amount_minor: 99990000 }],
  });
  eq('/pot/moves 超額退還 → 400', viaMoves.status, 400);

  const viaSettlements = await post(`/api/trips/${T}/settlements`, {
    from_member: potId, to_member: id.B, currency: 'TWD', amount_minor: 99990000,
  });
  eq('/settlements 同一筆超額退還 → 400(不能繞過)', viaSettlements.status, 400);

  // 合法金額兩邊都要放行
  eq('/settlements 合法退還 → 201',
    (await post(`/api/trips/${T}/settlements`, {
      from_member: potId, to_member: id.B, currency: 'TWD', amount_minor: 300000,
    })).status, 201);

  const bal = await settlementRows(T);
  const row = (bal.pot?.by_currency ?? []).find((c: J) => c.currency === 'TWD');
  eq('剩餘正確 = 1,000,000 − 300,000', row?.remainingMinor, 700000);
}

// ═══════════════════════════════════════════════════════════════
group('[競態] 編輯 / 刪除支出 vs 關閉回合 —— 蓋章的錢不能再變');

// 這一組守的是回合的可稽核性:一個回合的淨額快照,必須就是**它蓋章的那些支出**
// 算出來的淨額。對不上就代表回合宣告「這些錢已經付了」的金額和帳目不符,
// 而且那些支出已經蓋章 —— 不撤銷就修不了,「這 1,850 是怎麼來的」永遠答不出來。
//
// 稽核找到兩條路徑,而且是**相反方向**的同一個空窗(修法在兩支端點各一半):
//
//   ① PATCH 的「已蓋章 → 409」是先讀再寫。讀完之後才蓋的章擋不住,
//      於是已蓋章的支出被改掉。
//      → expenses/[id].patch.ts 每一句都帶 settlement_round_id IS NULL
//   ② 反過來:PATCH 落在 rounds.post 的讀取與寫入之間。它不改 kind、
//      不改 currency、不碰 settlements —— 原本的樂觀鎖三個量一個都沒動,
//      回合照樣成立,而快照停在舊金額。
//      → rounds.post.ts 的前提加上支出內容的指紋
//
// 兩條都是實測出來的:修之前同時送出 14/14 全部留下一個對不上的回合,
// 只修 ① 之後仍然 6/30 —— ② 不是理論上的可能性,是剩下來的那 6 次。
//
// 判準不是「誰該贏」。兩支都被擋、任一支贏都是安全的結果;
// 不能發生的是**兩支都成功而且回合的數字對不上**。
{
  /** 三個人才看得出「錢在人之間搬家」—— 兩個人的話任何改動都同時改到兩邊。 */
  async function newTrip3() {
    const t = await post('/api/trips', {
      name: `併發測試 編輯 ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      base_currency: 'TWD', members: ['A', 'B', 'C'],
    });
    const T = t.json.share_token as string;
    const members: J[] = (await get(`/api/trips/${T}`)).json.members;
    const id: Record<string, string> = {};
    for (const m of members) id[m.name] = m.id;
    return { T, id };
  }

  /** 一個回合的淨額快照 vs 它蓋章的支出現在算出來的淨額。 */
  function netsOf(rows: J[], sign: 1 | -1, key: 'payers' | 'shares', into: Map<string, number>) {
    for (const it of rows) {
      for (const r of (it[key] ?? []) as J[]) {
        into.set(r.member_id, (into.get(r.member_id) ?? 0) + sign * r.amount_minor);
      }
    }
  }
  const fmt = (m: Map<string, number>) => [...m].filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k.slice(0, 6)} ${v}`).sort().join(' | ');

  async function inconsistentRounds(T: string): Promise<string[]> {
    const bad: string[] = [];
    for (const r of ((await get(`/api/trips/${T}/rounds`)).json as J[]) ?? []) {
      const full = (await get(`/api/trips/${T}/rounds/${r.id}`)).json;
      const live = new Map<string, number>();
      netsOf(full.items ?? [], 1, 'payers', live);
      netsOf(full.items ?? [], -1, 'shares', live);
      const snap = new Map<string, number>(
        ((full.nets ?? []) as J[]).map((n) => [n.memberId, n.netMinor]),
      );
      if (fmt(live) !== fmt(snap)) bad.push(`快照 ${fmt(snap)} / 實際 ${fmt(live)}`);
    }
    return bad;
  }

  /**
   * 同時「關閉回合」和「動一筆支出」。
   *
   * delay 正的是**回合**慢出手、負的是**編輯**慢出手(毫秒)。
   * 兩個方向都要掃:編輯先寫完會落進回合的讀寫空窗(→ ②),
   * 回合先寫完則是編輯的 409 檢查過期(→ ①)。
   * 只掃一邊的話,另一支端點沒修也會全綠。
   */
  async function race(label: string, mutate: (T: string, id: Record<string, string>, eid: string) => Promise<J>) {
    const outcomes: Record<string, number> = {};
    const bad: string[] = [];

    // 沒有斷言「誰該贏」,所以掃不掃得到某個組合都不影響綠燈 ——
    // 這些數字只是為了讓兩支端點的前提都真的被打到(印出來的狀態組合看得見)。
    for (const delay of [-30, -18, -10, -4, 0, 0, 6, 12, 20, 30]) {
      const { T, id } = await newTrip3();
      const created = await post(`/api/trips/${T}/expenses`, {
        kind: 'shared', description: '晚餐', currency: 'TWD', amount: 3000, spent_at: '2026-03-08',
        payers: [{ member_id: id.A }],
        split: { mode: 'equal', members: [id.A, id.B, id.C] },
      });
      const eid = created.json.id as string;

      const [round, edit] = await Promise.all([
        (async () => {
          if (delay > 0) await sleep(delay);
          return post(`/api/trips/${T}/rounds`, { currency: 'TWD' });
        })(),
        (async () => {
          if (delay < 0) await sleep(-delay);
          return mutate(T, id, eid);
        })(),
      ]);
      const key = `${round.status}/${edit.status}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      for (const why of await inconsistentRounds(T)) bad.push(`delay=${delay} ${key} ${why}`);
    }

    check(`${label}:沒有一個回合的快照對不上它蓋章的支出`,
      bad.length === 0, bad.slice(0, 2).join(' ;; '));
    console.log(`       狀態組合(回合/編輯): ${JSON.stringify(outcomes)}`);
  }

  // ① 改金額。稽核的原始情境:¥10,000 補上漏打的零變 ¥20,000。
  await race('改金額', (T, id, eid) => patch(`/api/trips/${T}/expenses/${eid}`, {
    kind: 'shared', description: '晚餐', currency: 'TWD', amount: 9000, spent_at: '2026-03-08',
    payers: [{ member_id: id.A }],
    split: { mode: 'equal', members: [id.A, id.B, id.C] },
  }));

  // ② 只改分攤,金額一分錢都沒動 —— 未結總額也不變,只有加權校驗和看得到。
  //    「其實那道菜只有乙吃」是真的會發生的編輯。
  await race('只改分攤(金額不變)', (T, id, eid) => patch(`/api/trips/${T}/expenses/${eid}`, {
    kind: 'shared', description: '晚餐', currency: 'TWD', amount: 3000, spent_at: '2026-03-08',
    payers: [{ member_id: id.A }],
    split: { mode: 'exact', amounts: { [id.B!]: 3000 } },
  }));

  // ③ 刪除。同一個 TOCTOU:回合蓋完章之後才刪掉,那個回合的明細就空了,
  //    而快照和轉帳還在,金額再也回推不出來。
  await race('刪掉整筆', (T, _id, eid) => del(`/api/trips/${T}/expenses/${eid}`));
}

group('[防護] 指紋不能過度敏感 —— 不動錢的編輯不該擋掉結算');

// 樂觀鎖加得太寬的話,「改個錯字」也會讓結算回 409,而使用者完全不知道
// 自己該重新整理什麼(畫面上的數字一個都沒變)。所以指紋只看付款與分攤,
// 描述、分類、備註都不在裡面。
{
  const { T, id } = await newTrip(false);
  const created = await post(`/api/trips/${T}/expenses`, {
    kind: 'shared', description: '晚餐', currency: 'TWD', amount: 3000, spent_at: '2026-03-08',
    payers: [{ member_id: id.A }],
    split: { mode: 'equal', members: [id.A, id.B] },
  });
  const eid = created.json.id as string;
  const pv = (await get(`/api/trips/${T}/rounds/preview?currency=TWD`)).json.blocks[0];

  eq('改描述 → 200', (await patch(`/api/trips/${T}/expenses/${eid}`, {
    kind: 'shared', description: '第一晚的晚餐', category: '餐飲', note: '有點貴',
    currency: 'TWD', amount: 3000, spent_at: '2026-03-08',
    payers: [{ member_id: id.A }],
    split: { mode: 'equal', members: [id.A, id.B] },
  })).status, 200);

  const close = await post(`/api/trips/${T}/rounds`, {
    currency: 'TWD',
    expect: { item_count: pv.item_count, recorded_count: pv.recorded.length },
  });
  eq('改完描述,照原本的預覽結算 → 201', close.status, 201);
  eq('轉帳金額還是原本那個', close.json.recorded?.[0]?.amountMinor, 150000);
  eq('全部結清(淨額歸零)', await netAbsSum(T), 0);
}

process.exit(summary() > 0 ? 1 : 0);
