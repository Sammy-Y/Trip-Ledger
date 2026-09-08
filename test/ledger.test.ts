/**
 * 結算回合的算術單元測試 —— 「關掉一個回合會不會多要錢、會不會把公費清空」。
 *
 * 這支測的不是 SQL,是**寫錢之前的那一段純算術**。API 測試(test/api.features.test.ts)
 * 驗端點的行為,fuzz(test/settle.fuzz.ts)驗 minCashFlow 一般性的守恆;
 * 這支專門驗**回合功能新增的那幾個性質**,也就是四方對抗式設計審查推導出來的那組定理。
 *
 * ══ 為什麼這幾個性質是「載重」的 ═════════════════════════════════
 *
 * 回合功能有兩個範圍(server/utils/ledger.ts 有完整說明):
 *
 *   算術範圍 = 整趟到目前為止的所有帳,公費算成完整成員
 *   明細範圍 = 只有 settlement_round_id IS NULL 的那幾筆
 *
 * 而輸出被切成兩堆:兩端都是人的 recorded(回合真的會寫進 settlements)、
 * 任一端是公費的 deferred(唯讀,永不寫入)。
 *
 * 再加一條算術範圍的規則:**投入公費 / 公費退還不進淨額**。
 * 淨額 = 為共同花費付掉的 − 該分攤的 − 人對人的還款,任一端是公費的 settlement
 * 一律排除。理由與完整推導在 server/utils/ledger.ts 開頭;
 * 這支測試守的是它推出來的那條新不變量:
 *
 *   Σ(真人淨額) = −(公費花費)   而且   公費淨額 = +公費花費
 *
 * 壞掉的後果:公費「剩餘」會被拆成兩列掛回真人的淨額上,
 * 於是結算頁怎麼藏都藏不掉它 —— 那正是這次改動要消滅的東西。
 *
 * 「丟掉公費的腿還是安全的」這件事不是顯然的 —— 它需要證明:
 *
 *   LEMMA     任何子集、成員集合從資料列推導 ⇒ Σ淨額 = 0
 *   單邊性     每個成員只會出現在轉帳的一側(債權人恆為收款、債務人恆為付款)
 *   定理一     公費的腿被整條丟掉:殘額同號,且 Σ殘額 = −公費淨額
 *   定理二     完整性:去掉公費的腿之後,人與人之間該清的債一分不少
 *   定理三     不會多付:recorded 的清償方向與淨額同號,且絕對值 ≤ 淨額
 *   定理四     冪等:把 recorded 吸收回帳本後再結一輪,recorded 必須是空的
 *
 * 任何一條壞掉的後果都是**真實的錢**:
 *   單邊性壞 → 有人同時被要求收錢和付錢,丟掉公費腿之後帳目不平。
 *   定理一壞 → 回合幫某人記了一筆他沒付的投入(新語意),
 *              或第一晚就把公費退還給大家、明天沒錢買票(舊語意)。
 *   定理二壞 → 有人的債沒被列進轉帳,而支出已經被蓋上回合章 → 那筆錢無聲消失。
 *   定理三壞 → 有人被要求付超過他欠的金額。
 *   定理四壞 → 付款/反轉無限來回(使用者照著付了,下一輪又叫他反向付回來)。
 */
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { netBalances, minCashFlow, splitEqually, splitByShares, type Net, type Transfer } from '../server/utils/settle.ts';
import type { LedgerBlock } from '../server/utils/ledger.ts';
import { group, check, eq, summary } from './_harness.ts';

// ── 為什麼需要這個 resolve hook ──────────────────────────────────
// server/utils/ledger.ts 第一行是 `from './settle'`(沒有副檔名)。Nuxt/Vite 解析得動,
// 但 `node --experimental-strip-types` 走的是原生 ESM 解析,副檔名不能省 → ERR_MODULE_NOT_FOUND。
// 補上 `.ts` 是為了載入**真正的** assertZeroSum;在測試裡另抄一份的話,
// 就變成「測試在測試自己」,ledger.ts 改壞了這支還是綠的。
registerHooks({
  resolve(spec, ctx, next) {
    if (/^\.{1,2}\//.test(spec) && !/\.[cm]?[jt]s$/.test(spec)) {
      try { return next(`${spec}.ts`, ctx); } catch { /* 不是 .ts 就照原樣解析 */ }
    }
    return next(spec, ctx);
  },
});
const { assertZeroSum } = await import('../server/utils/ledger.ts');

// ═══════════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════════

const sumNets = (nets: Net[]) => nets.reduce((s, n) => s + n.netMinor, 0);
const totalOf = (ts: Transfer[]) => ts.reduce((s, t) => s + t.amountMinor, 0);
const byId = (ts: Transfer[]) => [...ts].sort((a, b) =>
  a.from === b.from ? (a.to < b.to ? -1 : 1) : (a.from < b.from ? -1 : 1));

/**
 * 一組轉帳對每個成員的「清償量」d(m) = Σ(收到) − Σ(付出)。
 *
 * 套用轉帳的定義(見 netBalances 的 settled 迴圈)是
 * net'(from) = net(from) + amount、net'(to) = net(to) − amount,
 * 所以 net'(m) = net(m) − d(m)。於是:
 *   「全部套用後歸零」⇔ d_all(m) === net(m)
 *   定理二的等式 d_recorded(m) === net(m) − residual(m) 就是同一件事的 recorded 版本 ——
 *   刻意寫成 recorded 的形式,因為**只有 recorded 會被寫進資料庫**。
 */
function dischargeMap(transfers: Transfer[]): Map<string, number> {
  const d = new Map<string, number>();
  const bump = (id: string, v: number) => d.set(id, (d.get(id) ?? 0) + v);
  for (const t of transfers) { bump(t.to, t.amountMinor); bump(t.from, -t.amountMinor); }
  return d;
}

/**
 * ledger.ts 裡 recorded/deferred 的切法。**這是一份鏡像**,因為那三行寫在
 * tripLedger 內部(需要 D1 才能呼叫),而它是純邏輯、必須被單獨證明。
 * 下面有一個「防漂移」檢查:直接讀 ledger.ts 的原始碼,確認那三行還是這個樣子。
 */
function splitLegs(transfers: Transfer[], potId: string | null) {
  const touchesPot = (t: Transfer) => !!potId && (t.from === potId || t.to === potId);
  return {
    recorded: transfers.filter((t) => !touchesPot(t)),
    deferred: transfers.filter(touchesPot),
  };
}

type Settled = { from: string; to: string; amountMinor: number };

/**
 * tripLedger 算術管線的鏡像:先排掉任一端是公費的 settlement,再交給 netBalances。
 *
 * 和 splitLegs 一樣是**鏡像**(真本在 tripLedger 裡面,要 D1 才叫得動),
 * 所以下面的防漂移檢查直接讀 ledger.ts 的原始碼比對那幾行。
 * 沒有那個檢查的話,這裡改對了、ledger.ts 改錯了,這支測試會全綠。
 */
function tripNets(input: {
  paid: Array<{ memberId: string; amountMinor: number }>;
  owed: Array<{ memberId: string; amountMinor: number }>;
  settled: Settled[];
}, potId: string | null): Net[] {
  return netBalances({
    paid: input.paid,
    owed: input.owed,
    settled: potId === null
      ? input.settled
      : input.settled.filter((s) => s.from !== potId && s.to !== potId),
  });
}

/** 用淨額組出一個 LedgerBlock —— assertZeroSum 只看 nets,其餘欄位照實填。 */
function blockOf(currency: string, nets: Net[], potId: string | null): LedgerBlock {
  const transfers = minCashFlow(nets);
  const { recorded, deferred } = splitLegs(transfers, potId);
  return { currency, nets, transfers, recorded, deferred };
}

type Violation = { prop: string; detail: string };

/**
 * 一次驗完回合的全部性質。回傳違規清單(空 = 全部成立)。
 *
 * 手工案例直接斷言「沒有違規」,隨機案例把違規依性質彙總 ——
 * 幾千個案例 × 十個性質不可能每個都印一行。
 */
function verifyRound(nets: Net[], potId: string | null): Violation[] {
  const bad: Violation[] = [];
  const fail = (prop: string, detail: string) => bad.push({ prop, detail });

  // ── LEMMA:Σ淨額 = 0 ──────────────────────────────────────────
  // 這是前提,不是結論:minCashFlow 對非零和輸入不會拋錯,只會靜靜回傳
  // 不完整的清單(settle.ts 的 `if (credit <= 0 || debt >= 0) break`)。
  const total = sumNets(nets);
  if (total !== 0) fail('lemma-zero-sum', `Σnets=${total}`);

  const transfers = minCashFlow(nets);
  const netOf = new Map(nets.map((n) => [n.memberId, n.netMinor]));

  // ── 單邊性 ───────────────────────────────────────────────────
  // 這是「丟掉公費的腿仍然安全」的全部理由:每個人只出現在一側,
  // 所以少掉幾條腿之後,剩下的殘額同號,不會有人被多要也不會有人被多付。
  const froms = new Set(transfers.map((t) => t.from));
  const tos = new Set(transfers.map((t) => t.to));
  for (const id of froms) if (tos.has(id)) fail('one-sided', `${id} 同時是付款方與收款方`);
  for (const t of transfers) {
    if (t.from === t.to) fail('one-sided', `自己轉給自己 ${t.from}`);
    // 方向必須跟淨額的正負一致 —— 債權人恆為 to、債務人恆為 from。
    if ((netOf.get(t.from) ?? 0) >= 0) fail('one-sided', `付款方 ${t.from} 淨額不是負的`);
    if ((netOf.get(t.to) ?? 0) <= 0) fail('one-sided', `收款方 ${t.to} 淨額不是正的`);
    if (!Number.isInteger(t.amountMinor) || t.amountMinor <= 0) {
      fail('legal-amount', `金額 ${t.amountMinor} 不是正整數`);
    }
  }

  const { recorded, deferred } = splitLegs(transfers, potId);

  // ── 分堆必須是「分割」:不重不漏 ─────────────────────────────
  // 少一條腿在兩邊都看不到 = 畫面上一筆錢憑空消失。
  if (recorded.length + deferred.length !== transfers.length) {
    fail('partition', `${recorded.length}+${deferred.length} != ${transfers.length}`);
  }
  if (totalOf(recorded) + totalOf(deferred) !== totalOf(transfers)) {
    fail('partition', '金額總和對不上');
  }
  const touches = (t: Transfer) => !!potId && (t.from === potId || t.to === potId);
  if (recorded.some(touches)) fail('partition', 'recorded 裡出現公費的腿(會被寫進 settlements)');
  if (deferred.some((t) => !touches(t))) fail('partition', 'deferred 裡出現人與人的腿(會被漏掉)');

  const dAll = dischargeMap(transfers);
  const dRec = dischargeMap(recorded);
  const dDef = dischargeMap(deferred);
  const netPot = potId ? (netOf.get(potId) ?? 0) : 0;
  const people = nets.filter((n) => n.memberId !== potId);
  const residual = (id: string) => dDef.get(id) ?? 0;

  // minCashFlow 的完整清單本來就該讓所有人歸零 —— 這是定理二的前提,
  // 壞了的話下面的等式都沒有意義,所以先在這裡擋一次。
  for (const n of nets) {
    if ((dAll.get(n.memberId) ?? 0) !== n.netMinor) {
      fail('full-settle', `${n.memberId} d=${dAll.get(n.memberId)} net=${n.netMinor}`);
    }
  }

  // ── 定理一:公費的腿被整條丟掉,而且丟得乾淨 ─────────────────
  // 公費淨額 > 0(新語意的常態:淨額 = 它花掉的錢)⇒ 它只會是收款方
  //   ⇒ 每條腿都是 人→公費 =「還要投入多少」⇒ 每個人的殘額 ≤ 0。
  // 公費淨額 < 0 ⇒ 反過來,每條腿都是 公費→人,殘額全部 ≥ 0
  //   (舊語意的常態;新語意只在公費身上有分攤時才做得到這個形狀)。
  // 公費淨額 = 0 ⇒ 它根本不在 nets 裡(netBalances 濾掉 0)⇒ 沒有任何腿。
  if (netPot === 0 && deferred.length) fail('thm1-single-sign', '公費淨額 0 卻有 deferred');
  if (netPot < 0 && deferred.some((t) => t.from !== potId)) {
    fail('thm1-single-sign', '公費淨額為負,卻有人要付錢給公費');
  }
  if (netPot > 0 && deferred.some((t) => t.to !== potId)) {
    fail('thm1-single-sign', '公費淨額為正,公費卻還在付錢出去');
  }
  for (const p of people) {
    const r = residual(p.memberId);
    if (netPot < 0 && r < 0) fail('thm1-single-sign', `${p.memberId} 殘額 ${r} 應該 ≥ 0`);
    if (netPot > 0 && r > 0) fail('thm1-single-sign', `${p.memberId} 殘額 ${r} 應該 ≤ 0`);
    // 殘額不可能超過本人的淨額,否則「丟掉這條腿」會讓他倒欠。
    if (Math.abs(r) > Math.abs(p.netMinor)) fail('thm1-single-sign', `${p.memberId} 殘額大於淨額`);
  }
  // Σ殘額 = −公費淨額。新語意下這個量 = −(公費花費),也就是
  // 「所有人加起來還要往信封裡放多少」;它已經不是總覽頁的「剩餘」了
  // (剩餘只住在 balance.get.ts 的 potSummary)。
  const sumRes = people.reduce((s, p) => s + residual(p.memberId), 0);
  if (sumRes !== -netPot) fail('thm1-pot-cash', `Σresidual=${sumRes} 應該是 ${-netPot}`);
  // 公費自己一分錢都沒被動到:被丟掉的腿剛好等於它的全部淨額。
  if (potId && residual(potId) !== netPot) {
    fail('thm1-pot-cash', `公費被丟掉的腿 ${residual(potId)} != 淨額 ${netPot}`);
  }

  // ── 定理二:完整性 ───────────────────────────────────────────
  // 去掉公費的腿之後,人與人之間的債一分不少地被 recorded 清掉。
  // 壞掉的後果:支出被蓋上回合章(明細範圍前進了),但那筆債沒進轉帳清單 → 錢消失。
  for (const p of people) {
    const want = p.netMinor - residual(p.memberId);
    const got = dRec.get(p.memberId) ?? 0;
    if (got !== want) fail('thm2-complete', `${p.memberId} recorded 清償 ${got} 應該是 ${want}`);
  }
  if (potId && (dRec.get(potId) ?? 0) !== 0) {
    fail('thm2-complete', '公費出現在 recorded 的清償裡(等於把公費清空)');
  }

  // ── 定理三:不會多付 ─────────────────────────────────────────
  for (const p of people) {
    const d = dRec.get(p.memberId) ?? 0;
    if (d !== 0 && Math.sign(d) !== Math.sign(p.netMinor)) {
      fail('thm3-no-overpay', `${p.memberId} 清償方向 ${d} 與淨額 ${p.netMinor} 相反`);
    }
    if (Math.abs(d) > Math.abs(p.netMinor)) {
      fail('thm3-no-overpay', `${p.memberId} 清償 ${d} 超過淨額 ${p.netMinor}`);
    }
  }

  // ── 定理四:冪等(不會付款/反轉無限來回)───────────────────
  // 把 recorded 當成回合寫進去的 settlements 吸收回帳本(算術範圍是整趟,
  // 所以下一輪一定會再看到它們),再結一輪:
  //   每個人的淨額應該剛好剩下殘額、公費淨額完全沒變,
  //   而且新的 recorded 必須是空的 —— 沒有任何人被再要一次錢。
  const nets2 = netBalances({
    paid: nets.filter((n) => n.netMinor > 0).map((n) => ({ memberId: n.memberId, amountMinor: n.netMinor })),
    owed: nets.filter((n) => n.netMinor < 0).map((n) => ({ memberId: n.memberId, amountMinor: -n.netMinor })),
    settled: recorded.map((t) => ({ from: t.from, to: t.to, amountMinor: t.amountMinor })),
  });
  const net2Of = new Map(nets2.map((n) => [n.memberId, n.netMinor]));
  for (const p of people) {
    if ((net2Of.get(p.memberId) ?? 0) !== residual(p.memberId)) {
      fail('thm4-idempotent', `${p.memberId} 吸收後淨額 ${net2Of.get(p.memberId) ?? 0} 應該等於殘額 ${residual(p.memberId)}`);
    }
  }
  if (potId && (net2Of.get(potId) ?? 0) !== netPot) {
    fail('thm4-idempotent', `公費淨額被回合改變了:${net2Of.get(potId) ?? 0} != ${netPot}`);
  }
  const rec2 = splitLegs(minCashFlow(nets2), potId).recorded;
  if (rec2.length) fail('thm4-idempotent', `第二輪還想寫 ${rec2.length} 筆轉帳:${JSON.stringify(rec2)}`);

  return bad;
}

/** 手工案例的斷言入口。 */
function expectAllProps(name: string, nets: Net[], potId: string | null) {
  const bad = verifyRound(nets, potId);
  check(name, bad.length === 0, bad.map((b) => `${b.prop}: ${b.detail}`).join(' / '));
}

/** 固定種子的 32-bit LCG(Numerical Recipes 參數)。 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) / 0x1000000;   // 取高位,低位的週期太短
  };
}

// ═══════════════════════════════════════════════════════════════
group('[防漂移] 測試裡的鏡像必須和 ledger.ts 一致');

{
  // splitLegs / tripNets 是 tripLedger 內部那幾行的鏡像。萬一那幾行被改了(例如把
  // deferred 也寫進 settlements、或把投入又算回淨額),鏡像會讓這支測試繼續全綠 ——
  // 所以直接讀原始碼比對。**這是整支測試唯一真的碰到 ledger.ts 內部算術的地方。**
  const src = readFileSync(new URL('../server/utils/ledger.ts', import.meta.url), 'utf8');
  check('touchesPot 的判斷式沒變',
    src.includes('const touchesPot = (t: Transfer) => !!potId && (t.from === potId || t.to === potId);'),
    'ledger.ts 的 touchesPot 改了,請同步更新 splitLegs');
  check('recorded = 不碰公費的腿',
    src.includes('recorded: transfers.filter((t) => !touchesPot(t)),'));
  check('deferred = 碰到公費的腿',
    src.includes('deferred: transfers.filter(touchesPot),'));

  // ── 新語意:投入/退還不進淨額 ────────────────────────────────
  // 這三條盯的是同一件事的三個部位。少任何一條,拿掉 ledger.ts 的排除邏輯之後
  // 下面那些「新不變量」的斷言仍然是綠的(它們算的是鏡像)—— 反向驗證確認過。
  check('淨額只吃兩端都是真人的 settlement(排除條件兩端都看)',
    src.includes('settledR.filter((r) => r.from_member !== potId && r.to_member !== potId)'),
    'ledger.ts 排除投入/退還的那一行改了,請同步更新 tripNets');
  check('沒有公費的旅程原封不動地用全部 settlements',
    /const p2pR = potId === null\s*\n\s*\? settledR\s*\n\s*: settledR\.filter/.test(src),
    '找不到 p2pR 的 potId === null 分支');
  check('netBalances 真的收到 p2pR(不是 settledR)',
    src.includes('settled: p2pR.filter((r) => r.currency === cur)'),
    '算術又吃回了未過濾的 settledR —— 投入/退還會重新進淨額');
  // 帳本是**只讀**的:它只計算「誰欠誰多少」,寫入一律由 rounds.post / settlements.post 負責。
  // 一旦有人在這裡加寫入 SQL,balance.get(每次開頁都呼叫)就會變成會改資料的端點。
  check('ledger.ts 不含任何寫入 SQL(只讀模組)',
    !/\b(INSERT|UPDATE|DELETE)\b/i.test(src));
}

// ═══════════════════════════════════════════════════════════════
group('[LEMMA] 任何子集都零和,而且成員集合是從資料列推導的');

{
  // 每一筆支出都滿足「付款合計 == 分攤合計」。刻意混入幾種真實會發生的怪狀況:
  //   ① 公費當付款人(pot 墊錢),分攤裡沒有公費 —— 公費不替自己分攤一份
  //   ② 只出現在分攤、從沒付過錢的人(小孩、後來才加入的人)
  //   ③ 只出現在 settlements、完全沒有支出的人(只投了公費就走)
  //   ④ 一個**不在 members 表裡**的 id(expenses.post 目前不驗跨旅程的成員 id)
  // netBalances 的成員集合來自資料列,所以以上全部照樣零和 ——
  // 若改成 SELECT members 再對照,④ 會被靜靜丟掉,Σ淨額就不是 0 了。
  type Exp = { paid: Array<[string, number]>; owed: Array<[string, number]> };
  const expenses: Exp[] = [
    { paid: [['pot', 6000]], owed: [['min', 3000], ['hsuan', 3000]] },
    { paid: [['min', 13244]], owed: [...splitEqually(13244, ['min', 'hsuan', 'kid'])] as Array<[string, number]> },
    { paid: [['min', 4000], ['hsuan', 2274]], owed: [...splitByShares(6274, { min: 3857, hsuan: 2417 })] as Array<[string, number]> },
    // ④ 外來 id:只要它同時進 paid/owed 的算術,總和仍為 0
    { paid: [['ghost', 500]], owed: [['min', 250], ['ghost', 250]] },
  ];
  const settlements: Array<{ from: string; to: string; amountMinor: number }> = [
    { from: 'min', to: 'pot', amountMinor: 10000 },
    { from: 'hsuan', to: 'pot', amountMinor: 10000 },
    { from: 'walkaway', to: 'pot', amountMinor: 5000 },
  ];

  let combos = 0, bad = 0, firstBad = '';
  for (let em = 0; em < 1 << expenses.length; em++) {
    for (let sm = 0; sm < 1 << settlements.length; sm++) {
      const picked = expenses.filter((_, i) => em & (1 << i));
      const nets = netBalances({
        paid: picked.flatMap((e) => e.paid.map(([memberId, amountMinor]) => ({ memberId, amountMinor }))),
        owed: picked.flatMap((e) => e.owed.map(([memberId, amountMinor]) => ({ memberId, amountMinor }))),
        settled: settlements.filter((_, i) => sm & (1 << i)),
      });
      combos++;
      const t = sumNets(nets);
      if (t !== 0) { bad++; if (!firstBad) firstBad = `em=${em} sm=${sm} Σ=${t}`; }
    }
  }
  check(`${combos} 種(支出子集 × 還款子集)全部零和`, bad === 0, firstBad);
  eq('子集數 = 2^4 × 2^3', combos, 128);
}

{
  // 反面:只要有一筆支出「付款 ≠ 分攤」,零和就會破 —— 這正是 assertZeroSum 要攔的東西。
  // netBalances 不會偷偷補平(它只是加總),所以錯誤會一路浮到結算前的檢查。
  const nets = netBalances({
    paid: [{ memberId: 'min', amountMinor: 1000 }],
    owed: [{ memberId: 'min', amountMinor: 400 }, { memberId: 'hsuan', amountMinor: 400 }],
    settled: [],
  });
  eq('付款 1000、分攤 800 → Σ淨額 = 200(不自動補平)', sumNets(nets), 200);
  check('assertZeroSum 會攔下來', assertZeroSum(blockOf('JPY', nets, 'pot')) !== null);
}

// ═══════════════════════════════════════════════════════════════
group('[為什麼算術範圍不能只看未結子集] 同一筆錢會被要求兩次');

{
  // 這是設計審查裡最關鍵的反例,寫成回歸測試以免有人「順手最佳化」回子集算術。
  //
  // 第一輪:A 墊 30000,三人均分 → 建議 B→A 10000、C→A 10000,回合把它們寫成 settlements。
  const paid = [{ memberId: 'A', amountMinor: 30000 }];
  const owed = [...splitEqually(30000, ['A', 'B', 'C'])].map(([memberId, amountMinor]) => ({ memberId, amountMinor }));
  const round1 = minCashFlow(netBalances({ paid, owed, settled: [] }));
  eq('第一輪:兩筆都流向 A', round1.length === 2 && round1.every((t) => t.to === 'A'), true);
  const written = round1.map((t) => ({ from: t.from, to: t.to, amountMinor: t.amountMinor }));

  // 整趟算術(正確):支出貢獻 net_r、回合寫下的 settlement 貢獻 −net_r,相加為 0。
  const whole = netBalances({ paid, owed, settled: written });
  eq('整趟範圍:第二輪沒有任何人要付錢', minCashFlow(whole).length, 0);

  // 子集算術(錯誤):支出已被蓋章所以看不到,但 settlements 沒有欄位指向它清掉的是哪筆債,
  // 於是只剩「B、C 付過錢」這個事實 → 反過來叫 A 把 20000 吐回去。
  const subset = netBalances({ paid: [], owed: [], settled: written });
  const loop = minCashFlow(subset);
  eq('子集範圍:憑空生出 20000 的反向轉帳(這就是付款/反轉無限來回)', totalOf(loop), 20000);
  check('反向轉帳全部是 A 要付出去', loop.length > 0 && loop.every((t) => t.from === 'A'), JSON.stringify(loop));
}

// ═══════════════════════════════════════════════════════════════
group('[assertZeroSum] 寫錢之前的最後一道檢查');

{
  const ok = assertZeroSum(blockOf('JPY', [
    { memberId: 'min', netMinor: 5000 },
    { memberId: 'pot', netMinor: -5000 },
  ], 'pot'));
  eq('零和 → 回傳 null', ok, null);

  eq('空的帳本也算零和(「沒東西可結」由 rounds.post 另外擋)',
    assertZeroSum(blockOf('JPY', [], 'pot')), null);

  const bad = assertZeroSum(blockOf('JPY', [
    { memberId: 'min', netMinor: 5000 },
    { memberId: 'pot', netMinor: -4900 },
  ], 'pot'));
  check('非零和 → 回傳非 null 的理由', bad !== null);
  check('訊息是中文的(會直接顯示給使用者看)', !!bad && /[一-鿿]/.test(bad), String(bad));
  check('訊息帶幣別 —— 使用者要知道是哪一塊壞掉', !!bad && bad.includes('JPY'), String(bad));
  check('訊息帶差額 100', !!bad && bad.includes('100'), String(bad));
  check('訊息說明「已中止」,不是只抱怨', !!bad && bad.includes('中止'), String(bad));

  // 浮點數淨額:總和可能剛好是 0,但金額一律是整數最小單位,
  // 出現小數代表上游有人用了浮點運算 → 一樣不准寫入。
  const frac = assertZeroSum(blockOf('JPY', [
    { memberId: 'min', netMinor: 0.5 },
    { memberId: 'pot', netMinor: -0.5 },
  ], 'pot'));
  check('非整數淨額也要攔(總和是 0 但金額不是整數)', frac !== null, String(frac));
  check('非整數的訊息也是中文的', !!frac && /[一-鿿]/.test(frac), String(frac));
}

// ═══════════════════════════════════════════════════════════════
group('[新語意] 投入/退還不進淨額,人對人的還款照算');

{
  const A = 'a', B = 'b', POT = 'pot';

  // 底盤:B 自己墊 10,000 的共同支出,兩人均分 → A 欠 B 5,000。公費還沒花錢。
  const base = {
    paid: [{ memberId: B, amountMinor: 10000 }],
    owed: [...splitEqually(10000, [A, B])].map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
    settled: [] as Settled[],
  };
  const plain = tripNets(base, POT);
  eq('底盤:A −5000 / B +5000,公費不在裡面', plain, [
    { memberId: A, netMinor: -5000 },
    { memberId: B, netMinor: 5000 },
  ]);

  // ① 投入(人 → 公費):金額多大都不該動到淨額。
  eq('A 投入公費 999,999 → 淨額逐位元不變',
    tripNets({ ...base, settled: [{ from: A, to: POT, amountMinor: 999999 }] }, POT), plain);

  // ② 退還(公費 → 人):同樣不動。**只排一邊是最容易犯的錯**,所以兩邊各測一次。
  eq('公費退還 B 7,000 → 淨額逐位元不變',
    tripNets({ ...base, settled: [{ from: POT, to: B, amountMinor: 7000 }] }, POT), plain);
  eq('投入與退還混在一起 → 淨額還是不變',
    tripNets({ ...base, settled: [
      { from: A, to: POT, amountMinor: 4000 },
      { from: POT, to: B, amountMinor: 1500 },
    ] }, POT), plain);

  // ③ 人對人的還款:**一定要算進去**,它是真實的債務清償。
  //    手動「標記已還款」和回合寫下的轉帳在這一層長得一模一樣(source 是資料庫欄位,
  //    算術看不到也不該看到)—— 所以「兩者都要算」在這裡就是「人對人一律算」。
  eq('A 還了 B 2,000 → A 的債剩 3,000',
    tripNets({ ...base, settled: [{ from: A, to: B, amountMinor: 2000 }] }, POT), [
      { memberId: A, netMinor: -3000 },
      { memberId: B, netMinor: 3000 },
    ]);
  eq('A 還滿 5,000 → 兩人都從淨額裡消失',
    tripNets({ ...base, settled: [{ from: A, to: B, amountMinor: 5000 }] }, POT), []);
  eq('沒有公費的旅程(potId = null),人對人的還款照樣算',
    tripNets({ ...base, settled: [{ from: A, to: B, amountMinor: 2000 }] }, null), [
      { memberId: A, netMinor: -3000 },
      { memberId: B, netMinor: 3000 },
    ]);

  // ④ 三種還款混在一起:只有中間那筆該生效。
  eq('投入 + 人對人 + 退還 → 只有人對人生效',
    tripNets({ ...base, settled: [
      { from: A, to: POT, amountMinor: 50000 },
      { from: A, to: B, amountMinor: 2000 },
      { from: POT, to: A, amountMinor: 30000 },
    ] }, POT), [
      { memberId: A, netMinor: -3000 },
      { memberId: B, netMinor: 3000 },
    ]);
}

{
  // ⑤ 「只排一邊」到底錯在哪 —— 把錯的做法寫出來,證明不變量真的會破。
  // 這是把反向驗證寫進測試:如果排除邏輯少一半,下面那兩個 !== 會變成 ===。
  const A = 'a', B = 'b', POT = 'pot';
  const potSpent = 8000;
  const settled: Settled[] = [
    { from: A, to: POT, amountMinor: 30000 },   // 投入
    { from: POT, to: B, amountMinor: 6000 },    // 退還
  ];
  const paid = [{ memberId: POT, amountMinor: potSpent }];
  const owed = [...splitEqually(potSpent, [A, B])].map(([memberId, amountMinor]) => ({ memberId, amountMinor }));

  const right = tripNets({ paid, owed, settled }, POT);
  eq('兩邊都排 → 公費淨額 = 公費花費', right.find((n) => n.memberId === POT)?.netMinor, potSpent);

  const onlyIn = netBalances({ paid, owed, settled: settled.filter((s) => s.to !== POT) });
  check('只排投入 → 公費淨額多出退還的 6,000,不變量破掉',
    onlyIn.find((n) => n.memberId === POT)?.netMinor !== potSpent,
    JSON.stringify(onlyIn));
  const onlyOut = netBalances({ paid, owed, settled: settled.filter((s) => s.from !== POT) });
  check('只排退還 → 公費淨額少掉投入的 30,000,不變量破掉',
    onlyOut.find((n) => n.memberId === POT)?.netMinor !== potSpent,
    JSON.stringify(onlyOut));
  const neither = netBalances({ paid, owed, settled });
  check('都不排(舊語意)→ 公費淨額是負的,那就是「剩餘」',
    (neither.find((n) => n.memberId === POT)?.netMinor ?? 0) < 0, JSON.stringify(neither));
}

{
  // ⑥ 公費一毛都沒花:它必須完全不出現在 nets 裡(netBalances 濾掉 0),
  // 即使信封裡有一大筆現金。「結算頁不該再談剩餘」在這裡是最乾淨的樣子。
  const A = 'a', B = 'b', POT = 'pot';
  const nets = tripNets({
    paid: [{ memberId: A, amountMinor: 3000 }],
    owed: [...splitEqually(3000, [A, B])].map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
    settled: [{ from: A, to: POT, amountMinor: 100000 }, { from: B, to: POT, amountMinor: 100000 }],
  }, POT);
  check('公費不在 nets 裡', !nets.some((n) => n.memberId === POT), JSON.stringify(nets));
  eq('只剩人與人的 1,500', nets, [
    { memberId: A, netMinor: 1500 },
    { memberId: B, netMinor: -1500 },
  ]);
  eq('deferred 是空的 —— 沒有人被叫去補投入', splitLegs(minCashFlow(nets), POT).deferred, []);
  expectAllProps('全部性質成立', nets, POT);
}

{
  // ⑦ 只有投入、什麼都還沒花的幣別:淨額整個是空的。
  // tripLedger 仍然會為它留一個(空的)區塊 —— 理由見 ledger.ts 的幣別集合那段。
  const nets = tripNets({
    paid: [], owed: [],
    settled: [{ from: 'a', to: 'pot', amountMinor: 100000 }],
  }, 'pot');
  eq('淨額是空陣列', nets, []);
  eq('空帳本仍然算零和', assertZeroSum(blockOf('KRW', nets, 'pot')), null);
}

// ═══════════════════════════════════════════════════════════════
group('[實例] 公費模式:各投 10,000,公費付掉 6,000 + 4,000');

{
  // README 的那個範例。投入公費 = settlements 裡「流向公費」的一筆(見 balance.get.ts),
  // 而它**不進淨額** —— 所以那兩筆 10,000 在下面的數字裡完全看不到。
  const MIN = 'min', HSUAN = 'hsuan', POT = 'pot';
  const potSpent = 10000;
  const input = {
    paid: [{ memberId: POT, amountMinor: 6000 }, { memberId: POT, amountMinor: 4000 }],
    owed: [
      ...[...splitEqually(6000, [MIN, HSUAN])].map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
      ...[...splitEqually(4000, [MIN, HSUAN])].map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
    ],
    settled: [
      { from: MIN, to: POT, amountMinor: 10000 },
      { from: HSUAN, to: POT, amountMinor: 10000 },
    ],
  };
  const nets = tripNets(input, POT);
  eq('淨額 = 民 −5000 / 喧 −5000 / 公費 +10000', nets, [
    { memberId: HSUAN, netMinor: -5000 },
    { memberId: MIN, netMinor: -5000 },
    { memberId: POT, netMinor: 10000 },
  ]);
  // 舊語意在這裡是 民 +5000 / 喧 +5000 / 公費 −10000 —— 兩人合計 10,000
  // 剛好是信封裡剩下的現金,也就是「剩餘被拆成兩列掛在真人身上」的樣子。
  eq('公費淨額 === 公費花費', nets.find((n) => n.memberId === POT)?.netMinor, potSpent);
  eq('Σ(真人淨額) === −公費花費',
    nets.filter((n) => n.memberId !== POT).reduce((s, n) => s + n.netMinor, 0), -potSpent);

  // 投入完全不影響淨額:把那兩筆拿掉,結果必須逐位元相同。
  eq('把兩筆投入整個刪掉,淨額一模一樣',
    tripNets({ ...input, settled: [] }, POT), nets);

  const { recorded, deferred } = splitLegs(minCashFlow(nets), POT);
  eq('recorded 是空的 —— 沒有人需要付錢給任何人', recorded, []);
  // 腿的方向和舊語意**相反**:現在是「還要投入多少」,不是「公費要退多少」。
  eq('deferred 是兩條「人 → 公費」的腿(唯讀,絕不寫入)', byId(deferred), [
    { from: HSUAN, to: POT, amountMinor: 5000 },
    { from: MIN, to: POT, amountMinor: 5000 },
  ]);
  eq('Σ deferred === 公費花費', totalOf(deferred), potSpent);

  // 剩餘(20,000 投入 − 10,000 花掉)已經完全不在這個模組的算術裡了 ——
  // 它只住在 balance.get.ts 的 potSummary,總覽頁自己去讀。
  expectAllProps('全部性質成立', nets, POT);
}

group('[實例] 出資不均:民 出 20,000、喧 出 0,公費付掉 10,000');

{
  // 這一組是整個新語意最容易被誤判成 bug 的形狀:**recorded 空了**。
  // 舊語意會叫 喧 → 民 5,000;新語意把它改道成「喧 欠公費 5,000」。
  // 債沒有消失,下面把整條路徑的錢算完給你看。
  const MIN = 'min', HSUAN = 'hsuan', POT = 'pot';
  const contributed = 20000, potSpent = 10000;
  const nets = tripNets({
    paid: [{ memberId: POT, amountMinor: potSpent }],
    owed: [...splitEqually(potSpent, [MIN, HSUAN])].map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
    settled: [{ from: MIN, to: POT, amountMinor: contributed }],
  }, POT);
  eq('淨額 = 民 −5000 / 喧 −5000 / 公費 +10000', nets, [
    { memberId: HSUAN, netMinor: -5000 },
    { memberId: MIN, netMinor: -5000 },
    { memberId: POT, netMinor: 10000 },
  ]);
  eq('公費淨額 === 公費花費', nets.find((n) => n.memberId === POT)?.netMinor, potSpent);

  const { recorded, deferred } = splitLegs(minCashFlow(nets), POT);
  eq('recorded 是空的 —— 喧 的債改走公費,不再是人對人', recorded, []);
  eq('deferred:兩人各還要投入 5,000', byId(deferred), [
    { from: HSUAN, to: POT, amountMinor: 5000 },
    { from: MIN, to: POT, amountMinor: 5000 },
  ]);

  // ── 債沒有消失的證明:把剩下的路徑走完 ──────────────────────
  // 喧 照他的淨額去總覽投入 5,000 → 信封有 (20,000 − 10,000) + 5,000 = 15,000
  // → 全額退還給民(他是唯一出資的人)→ 民 實際掏出 20,000 − 15,000 = 5,000。
  const hsuanPays = 5000;                                  // = −net(喧)
  const envelope = contributed - potSpent + hsuanPays;
  eq('喧 補投之後信封有 15,000', envelope, 15000);
  eq('民 實際掏出 = 他該分攤的 5,000', contributed - envelope, 5000);
  eq('喧 實際掏出 = 他該分攤的 5,000', hsuanPays, 5000);
  eq('兩人實付合計 === 公費花費', (contributed - envelope) + hsuanPays, potSpent);

  expectAllProps('全部性質成立', nets, POT);
}

// ═══════════════════════════════════════════════════════════════
group('[手工] 單邊性與公費殘額的各種形狀');

{
  const P = 'pot';
  // ⚠️ 這一組直接餵淨額向量,所以會出現「公費淨額為負」的形狀 ——
  // 那在新語意的真實資料裡**不可能發生**(公費淨額 = 花費 ≥ 0,見下面的性質斷言)。
  // 留著是刻意的:minCashFlow 與分堆邏輯對兩個方向都必須成立,
  // 而「公費身上出現分攤」(有人把有帳的成員改標成公費)仍然做得到那個形狀。
  // 只測 ≥ 0 的一半,那條路徑就再也沒有測試守著了。
  expectAllProps('公費淨額為負(舊語意的第一晚;新語意只在公費身上有分攤時出現)', [
    { memberId: 'a', netMinor: 3000 }, { memberId: 'b', netMinor: 3000 },
    { memberId: 'c', netMinor: 3000 }, { memberId: P, netMinor: -9000 },
  ], P);
  expectAllProps('公費 + 人與人的債混在一起', [
    { memberId: 'a', netMinor: 12000 }, { memberId: 'b', netMinor: -4000 },
    { memberId: 'c', netMinor: -1000 }, { memberId: P, netMinor: -7000 },
  ], P);
  // 公費淨額為正:公費超支(有人代墊給公費、或投入不足)→ 腿的方向全部反過來
  expectAllProps('公費超支,所有腿都是人→公費', [
    { memberId: 'a', netMinor: -3000 }, { memberId: 'b', netMinor: -2000 },
    { memberId: P, netMinor: 5000 },
  ], P);
  expectAllProps('公費超支 + 人與人的債', [
    { memberId: 'a', netMinor: -9000 }, { memberId: 'b', netMinor: 4000 },
    { memberId: 'c', netMinor: 2000 }, { memberId: P, netMinor: 3000 },
  ], P);
  // 公費淨額剛好 0 → netBalances 會把它濾掉,deferred 必須是空的
  expectAllProps('公費淨額 0(收支剛好抵銷)→ 沒有任何 deferred', [
    { memberId: 'a', netMinor: 2500 }, { memberId: 'b', netMinor: -2500 },
  ], P);
  // 沒有公費的旅程:全部都是 recorded,一樣要成立
  expectAllProps('這趟沒有公費(potId = null)', [
    { memberId: 'a', netMinor: 7000 }, { memberId: 'b', netMinor: -3000 },
    { memberId: 'c', netMinor: -4000 },
  ], null);
  // 平手:多位債權人金額相同,踩 minCashFlow 的 tie-break 分支
  expectAllProps('平手的債權人(tie-break)', [
    { memberId: 'a', netMinor: 1000 }, { memberId: 'b', netMinor: 1000 },
    { memberId: 'c', netMinor: 1000 }, { memberId: 'd', netMinor: -1000 },
    { memberId: 'e', netMinor: -1000 }, { memberId: P, netMinor: -1000 },
  ], P);
  // 極端金額差:1 元 vs 幾十萬(餘數分配最容易出事的地方)
  expectAllProps('1 元 vs 500,000 的極端差距', [
    { memberId: 'a', netMinor: 1 }, { memberId: 'b', netMinor: 500000 },
    { memberId: 'c', netMinor: -1 }, { memberId: P, netMinor: -500000 },
  ], P);
  // 兩人一趟(最小可結算規模)
  expectAllProps('兩個人 + 公費', [
    { memberId: 'a', netMinor: 6622 }, { memberId: 'b', netMinor: -6622 },
  ], P);
  // 公費是唯一的債權人,所有人都欠它
  expectAllProps('大家都欠公費(公費幫每個人墊過款)', [
    { memberId: 'a', netMinor: -1000 }, { memberId: 'b', netMinor: -2000 },
    { memberId: 'c', netMinor: -3000 }, { memberId: P, netMinor: 6000 },
  ], P);
  // 公費 id 在排序上落在最前/最後,確認結果與 id 的字典序無關
  expectAllProps('公費 id 排序在最前面', [
    { memberId: 'aaa-pot', netMinor: -8000 }, { memberId: 'm1', netMinor: 5000 },
    { memberId: 'm2', netMinor: 3000 },
  ], 'aaa-pot');
  expectAllProps('公費 id 排序在最後面', [
    { memberId: 'm1', netMinor: 5000 }, { memberId: 'm2', netMinor: 3000 },
    { memberId: 'zzz-pot', netMinor: -8000 },
  ], 'zzz-pot');
}

// ═══════════════════════════════════════════════════════════════
group('[隨機] 由支出/還款產生的完整帳本(固定種子)');

{
  // 種子固定 = 失敗案例可重現(絕不用 Math.random,否則 CI 紅了也查不出是哪一組)。
  const rnd = lcg(20260907);
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T,>(xs: T[]) => xs[ri(xs.length)];

  const CASES = 3000;
  const violations = new Map<string, { n: number; first: string }>();
  const bump = (prop: string, detail: string) => {
    const cur = violations.get(prop);
    if (cur) cur.n++;
    else violations.set(prop, { n: 1, first: detail });
  };
  // 覆蓋率計數器:每個分支都必須真的被走到,否則「全綠」是假的。
  const cov = {
    potNeg: 0, potPos: 0, potZero: 0, noPot: 0, recEmpty: 0, recSome: 0, defSome: 0,
    contributed: 0, refunded: 0, p2p: 0,
  };

  for (let iter = 0; iter < CASES; iter++) {
    const nPeople = 2 + ri(5);                       // 2..6 人
    const people = Array.from({ length: nPeople }, (_, i) => `p${i}`);
    const potId = ri(4) === 0 ? null : (ri(2) === 0 ? 'aa-pot' : 'zz-pot');  // 1/4 的旅程沒有公費
    const payerPool = potId ? [...people, potId] : people;

    const paid: Array<{ memberId: string; amountMinor: number }> = [];
    const owed: Array<{ memberId: string; amountMinor: number }> = [];
    let potSpent = 0;

    const nExp = 1 + ri(4);                          // 1..4 筆共同支出
    for (let e = 0; e < nExp; e++) {
      const amount = 1 + ri(200000);
      // 分攤的人:人的非空子集。**公費不分攤**(它是出錢的一方,見 previewShares 的規則);
      // 讓公費分攤自己付的錢會讓「公費淨額 = 公費花費」這個不變量失效。
      const sharers = people.filter(() => ri(2) === 0);
      if (!sharers.length) sharers.push(pick(people));
      const shares = ri(2) === 0
        ? splitEqually(amount, sharers)
        : splitByShares(amount, Object.fromEntries(sharers.map((id) => [id, 1 + ri(20)])));
      for (const [memberId, amountMinor] of shares) owed.push({ memberId, amountMinor });

      // 付款人 1..2 位(可以是公費),合計必須等於 amount —— 這是 LEMMA 的前提。
      const nPayers = 1 + ri(2);
      let left = amount;
      for (let i = 0; i < nPayers; i++) {
        const take = i === nPayers - 1 ? left : ri(left + 1);
        const who = pick(payerPool);
        paid.push({ memberId: who, amountMinor: take });
        if (who === potId) potSpent += take;
        left -= take;
      }
    }

    // 還款:投入公費 / 公費退還 / 人與人手動還款(三種都會真的出現在 settlements 表)
    const settled: Settled[] = [];
    const p2pOnly: Settled[] = [];        // 只有人對人的那些 —— 下面驗淨額公式要用
    const nSet = ri(5);
    for (let s = 0; s < nSet; s++) {
      const kind = potId ? ri(6) : 5;
      if (kind <= 3) {
        const amt = 1 + ri(300000);
        settled.push({ from: pick(people), to: potId!, amountMinor: amt });
        cov.contributed++;
      } else if (kind === 4) {
        const amt = 1 + ri(50000);
        settled.push({ from: potId!, to: pick(people), amountMinor: amt });
        cov.refunded++;
      } else {
        const from = pick(people);
        const to = pick(people.filter((p) => p !== from)) ?? from;
        if (to !== from) {
          const row = { from, to, amountMinor: 1 + ri(80000) };
          settled.push(row);
          p2pOnly.push(row);
          cov.p2p++;
        }
      }
    }

    // 走 tripLedger 的管線(排掉任一端是公費的 settlement),不是裸的 netBalances。
    const nets = tripNets({ paid, owed, settled }, potId);
    for (const v of verifyRound(nets, potId)) bump(v.prop, `iter=${iter} ${v.detail}`);

    const netPot = potId ? (nets.find((n) => n.memberId === potId)?.netMinor ?? 0) : 0;

    // ── 新語意的三條恆等式 ─────────────────────────────────────
    //
    // ① 逐人的淨額公式。這條是**最緊的**一條:它同時抓「排太少」(投入/退還漏排)
    //    和「排太多」(把人對人的還款一起排掉)。少了它,把 settled 整個丟掉
    //    也能讓下面兩條通過 —— 而那等於把所有已還的款憑空作廢。
    const formula = new Map<string, number>();
    const bumpF = (id: string, v: number) => formula.set(id, (formula.get(id) ?? 0) + v);
    for (const p of paid) bumpF(p.memberId, p.amountMinor);
    for (const o of owed) bumpF(o.memberId, -o.amountMinor);
    for (const s of p2pOnly) { bumpF(s.from, s.amountMinor); bumpF(s.to, -s.amountMinor); }
    const netOfIter = new Map(nets.map((n) => [n.memberId, n.netMinor]));
    for (const [id, want] of formula) {
      // netBalances 會濾掉 0,所以「不在 nets 裡」等於 0。
      if ((netOfIter.get(id) ?? 0) !== want) {
        bump('net-formula', `iter=${iter} ${id} 淨額 ${netOfIter.get(id) ?? 0} 應該是 ${want}`);
      }
    }

    if (potId) {
      // ② 公費淨額 === 公費花費(公費不替自己分攤,所以恆等)。
      if (netPot !== potSpent) {
        bump('pot-net-is-spent', `iter=${iter} 公費淨額 ${netPot} 應該是花費 ${potSpent}`);
      }
      // ③ Σ(真人淨額) === −(公費花費)。零和 + ② 的推論,但它就是規格上那一條,
      //    所以獨立驗一次 —— 讀測試的人要能直接看到規格本身。
      const sumPeople = nets.filter((n) => n.memberId !== potId)
        .reduce((s, n) => s + n.netMinor, 0);
      if (sumPeople !== -potSpent) {
        bump('people-sum-is-pot-spend', `iter=${iter} Σ真人 ${sumPeople} 應該是 ${-potSpent}`);
      }
    }

    // 覆蓋率
    if (!potId) cov.noPot++;
    else if (netPot < 0) cov.potNeg++;
    else if (netPot > 0) cov.potPos++;
    else cov.potZero++;
    const { recorded, deferred } = splitLegs(minCashFlow(nets), potId);
    if (recorded.length) cov.recSome++; else cov.recEmpty++;
    if (deferred.length) cov.defSome++;
  }

  const PROPS = [
    ['lemma-zero-sum', 'LEMMA:Σ淨額 = 0'],
    ['one-sided', '單邊性:每人只在轉帳的一側,方向與淨額同號'],
    ['legal-amount', '轉帳金額都是正整數'],
    ['partition', 'recorded / deferred 是分割(不重不漏)'],
    ['full-settle', '完整清單套用後所有人歸零'],
    ['thm1-single-sign', '定理一:殘額同號、不超過淨額'],
    ['thm1-pot-cash', '定理一:Σ殘額 === −公費淨額'],
    ['thm2-complete', '定理二:recorded 清償 === 淨額 − 殘額'],
    ['thm3-no-overpay', '定理三:方向同號且不超額'],
    ['thm4-idempotent', '定理四:吸收 recorded 後第二輪不再要錢'],
    ['net-formula', '新語意:淨額 = 墊款 − 分攤 − 人對人還款(逐人)'],
    ['pot-net-is-spent', '新語意:公費淨額 === 公費花費'],
    ['people-sum-is-pot-spend', '新語意:Σ(真人淨額) === −(公費花費)'],
  ] as const;
  for (const [key, label] of PROPS) {
    const v = violations.get(key);
    check(`${label}(${CASES} 組隨機帳本)`, !v, v ? `${v.n} 組違規,第一組:${v.first}` : '');
  }

  // 新語意下這變成一條**性質**而不是覆蓋率:公費不替自己分攤,淨額 = 花費 ≥ 0,
  // 所以真實形狀的資料裡公費永遠是債權人。出現負數就代表公費身上有分攤
  // (有人把有帳的成員改標成公費),或投入又被算回淨額了。
  check(`公費淨額從不為負(${CASES} 組)`, cov.potNeg === 0, JSON.stringify(cov));

  // 沒走到的分支等於沒測到 —— 生成器偏掉的話這裡會紅。
  check(`覆蓋:公費淨額為正 ${cov.potPos} 組`, cov.potPos > 50, JSON.stringify(cov));
  check(`覆蓋:公費淨額為 0(公費一毛沒花)${cov.potZero} 組`, cov.potZero > 50, JSON.stringify(cov));
  check(`覆蓋:沒有公費的旅程 ${cov.noPot} 組`, cov.noPot > 50, JSON.stringify(cov));
  check(`覆蓋:recorded 非空 ${cov.recSome} 組`, cov.recSome > 50, JSON.stringify(cov));
  check(`覆蓋:recorded 為空 ${cov.recEmpty} 組`, cov.recEmpty > 50, JSON.stringify(cov));
  check(`覆蓋:deferred 非空 ${cov.defSome} 組`, cov.defSome > 50, JSON.stringify(cov));
  // 三種 settlement 都必須真的被生出來,否則「投入/退還被排掉、人對人照算」
  // 這件事有一半根本沒被測到。
  check(`覆蓋:投入公費 ${cov.contributed} 筆`, cov.contributed > 100, JSON.stringify(cov));
  check(`覆蓋:公費退還 ${cov.refunded} 筆`, cov.refunded > 100, JSON.stringify(cov));
  check(`覆蓋:人對人還款 ${cov.p2p} 筆`, cov.p2p > 100, JSON.stringify(cov));
}

// ═══════════════════════════════════════════════════════════════
group('[隨機] 直接生成淨額向量(不經過支出),壓單邊性與分堆');

{
  // 上面那個生成器受「付款合計 == 分攤合計」約束,形狀有限;
  // 這裡直接生成零和向量(含極端值、大量平手、±1),把 minCashFlow 的
  // tie-break 與 pool 縮減路徑壓得更兇。
  const rnd = lcg(0x5EED1234);
  const ri = (n: number) => Math.floor(rnd() * n);

  const CASES = 4000;
  const violations = new Map<string, { n: number; first: string }>();
  const cov = { withPot: 0, potNeg: 0, potPos: 0, ties: 0 };

  for (let iter = 0; iter < CASES; iter++) {
    const n = 2 + ri(7);                             // 2..8 個成員
    const ids = Array.from({ length: n }, (_, i) => `m${i}`);
    const scale = [1, 2, 100, 33333, 500000][ri(5)];
    const vals: number[] = [];
    for (let i = 0; i < n - 1; i++) vals.push((1 + ri(scale)) * (ri(2) === 0 ? 1 : -1));
    vals.push(-vals.reduce((a, b) => a + b, 0));      // 最後一位補成零和
    if (scale <= 2) cov.ties++;                       // 小尺度 → 大量相同金額

    const nets: Net[] = ids
      .map((memberId, i) => ({ memberId, netMinor: vals[i] }))
      .filter((x) => x.netMinor !== 0)                // netBalances 會濾掉 0,這裡照做
      .sort((a, b) => a.memberId < b.memberId ? -1 : 1);
    if (nets.length < 2) continue;

    // 公費就從現有成員裡指定一個(有時不指定)—— 公費在算術上就是普通成員,
    // 唯一的差別是輸出時它的腿被丟掉,所以這樣指定完全合法。
    const potId = ri(3) === 0 ? null : nets[ri(nets.length)].memberId;
    if (potId) {
      cov.withPot++;
      const np = nets.find((x) => x.memberId === potId)!.netMinor;
      if (np < 0) cov.potNeg++; else cov.potPos++;
    }

    for (const v of verifyRound(nets, potId)) {
      const cur = violations.get(v.prop);
      if (cur) cur.n++;
      else violations.set(v.prop, { n: 1, first: `iter=${iter} ${v.detail}` });
    }
  }

  check(`${CASES} 組隨機淨額向量:全部性質成立`, violations.size === 0,
    [...violations].map(([k, v]) => `${k}×${v.n}(${v.first})`).join(' / '));
  check(`覆蓋:有公費 ${cov.withPot} 組 / 公費為債務人 ${cov.potNeg} / 公費為債權人 ${cov.potPos}`,
    cov.withPot > 100 && cov.potNeg > 50 && cov.potPos > 50, JSON.stringify(cov));
  check(`覆蓋:大量平手金額 ${cov.ties} 組`, cov.ties > 100, JSON.stringify(cov));
}

process.exit(summary() > 0 ? 1 : 0);
