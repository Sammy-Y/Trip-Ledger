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
group('[不變量] 公費剩餘 = −公費淨額,在併發之後仍然成立');

// 這條是整個公費功能的正確性支點。稽核找到唯一能讓它失效的路徑是
// 「把已經有帳的成員改標成公費」,那個現在被 409 擋住了。
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
  const potNet = ((bal.by_currency?.TWD?.nets ?? []) as J[]).find((n) => n.memberId === potId)?.netMinor ?? 0;
  eq('剩餘 = −淨額', row?.remainingMinor, -potNet);
  eq('淨額總和仍為 0', ((bal.by_currency?.TWD?.nets ?? []) as J[]).reduce((s, n) => s + n.netMinor, 0), 0);
}

group('[防護] 個人花費的付款人不能事後被改成公費');

// 這條路徑會讓「剩餘 = −淨額」差掉那筆個人花費的金額,
// 而那筆錢會卡在沒有任何畫面能解決的地方(實測 5,000 卡住)。
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

process.exit(summary() > 0 ? 1 : 0);
