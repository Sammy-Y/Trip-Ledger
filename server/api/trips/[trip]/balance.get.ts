import { db } from '../../../utils/cf';
import { requireTrip } from '../../../utils/trip';
import { rateOn } from '../../../utils/fx';
import { convertToBase } from '../../../utils/money';
import { tripLedger } from '../../../utils/ledger';
import type { Net, Transfer } from '../../../utils/settle';
import type { PotCurrency, PotSummary } from '../../../../shared/types';

/**
 * 公費的收支明細,逐幣別分開。
 *
 * 剩餘 = 投入 − 公費付掉的 − 已退還。
 * 這個數字恆等於「公費成員淨額的相反數」——
 * 公費淨額 = 付出去的 + 退還的 − 收進來的,所以取負號就是手上還有多少現金。
 * 兩條路徑算出同一個數字,是這裡的正確性檢查。
 */
async function potSummary(dbh: D1Database, tripId: string): Promise<PotSummary | null> {
  const pot = await dbh.prepare(
    `SELECT id, name FROM members WHERE trip_id = ? AND is_pot = 1`,
  ).bind(tripId).first<{ id: string; name: string }>();
  if (!pot) return null;

  const [inflow, outflow, spent] = await Promise.all([
    // 誰投入了公費:settlements 裡「流向公費」的那些
    dbh.prepare(
      `SELECT currency, from_member AS member_id, SUM(amount_minor) AS amt
       FROM settlements WHERE trip_id = ? AND to_member = ?
       GROUP BY currency, from_member`,
    ).bind(tripId, pot.id).all<{ currency: string; member_id: string; amt: number }>(),
    // 公費退還給誰:反方向
    dbh.prepare(
      `SELECT currency, to_member AS member_id, SUM(amount_minor) AS amt
       FROM settlements WHERE trip_id = ? AND from_member = ?
       GROUP BY currency, to_member`,
    ).bind(tripId, pot.id).all<{ currency: string; member_id: string; amt: number }>(),
    // 公費付掉的支出。
    //
    // ⚠️ `kind = 'shared'` 不能省。utils/ledger.ts 的淨額只算 shared,
    // 這裡如果連 personal 一起算,`剩餘 = −公費淨額` 這個不變量就會差掉
    // 那筆個人花費的金額 —— 結算頁要公費退 16,000、總覽卻說它只有 11,000,
    // 中間那 5,000 卡在沒有任何畫面能解決的地方(實測出來的)。
    //
    // expenses.post 會擋「公費當個人花費付款人」,但那只在**寫入當下有公費**才擋得到;
    // 先記帳、之後才把某個成員標成公費的話就繞過去了(見 members/[id].patch.ts)。
    dbh.prepare(
      `SELECT e.currency, SUM(p.amount_minor) AS amt
       FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.trip_id = ? AND e.kind = 'shared' AND p.member_id = ?
       GROUP BY e.currency`,
    ).bind(tripId, pot.id).all<{ currency: string; amt: number }>(),
  ]);

  const inRows = inflow.results ?? [], outRows = outflow.results ?? [], spentRows = spent.results ?? [];
  const currencies = [...new Set([
    ...inRows.map((r) => r.currency),
    ...outRows.map((r) => r.currency),
    ...spentRows.map((r) => r.currency),
  ])].sort();

  const byCurrency: PotCurrency[] = currencies.map((cur) => {
    const contributions = inRows.filter((r) => r.currency === cur)
      .map((r) => ({ memberId: r.member_id, amountMinor: r.amt }))
      .sort((a, b) => b.amountMinor - a.amountMinor);
    const refunds = outRows.filter((r) => r.currency === cur)
      .map((r) => ({ memberId: r.member_id, amountMinor: r.amt }))
      .sort((a, b) => b.amountMinor - a.amountMinor);
    const contributedMinor = contributions.reduce((s, c) => s + c.amountMinor, 0);
    const refundedMinor = refunds.reduce((s, c) => s + c.amountMinor, 0);
    const spentMinor = spentRows.filter((r) => r.currency === cur).reduce((s, r) => s + r.amt, 0);
    return {
      currency: cur,
      contributedMinor,
      spentMinor,
      refundedMinor,
      remainingMinor: contributedMinor - spentMinor - refundedMinor,
      contributions,
      refunds,
    };
  });

  return { memberId: pot.id, name: pot.name, by_currency: byCurrency };
}

/**
 * 結算 —— 這支就是「誰要給誰多少錢」。
 *
 * 關鍵設計:**逐幣別分別結算**,絕不把日幣台幣加在一起。
 * 原 Excel 的 SUM(C2:C74)=194,765 就是混幣相加的無意義數字。
 * 換算成本位幣的數字只用於「我這趟總共花了多少」的參考顯示。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  // 淨額與轉帳建議一律走 utils/ledger.ts —— 結算回合用的是同一份程式碼,
  // 兩邊絕不會漂移。也是那裡修掉「只有結算、沒有共同支出的幣別會整個消失」的問題。
  const [ledger, shareRows] = await Promise.all([
    tripLedger(dbh, trip.id),
    // per_member 的本位幣統計要用「每筆支出自己 snapshot 的匯率」,
    // 所以這個查詢不做 GROUP BY —— 逐筆帶出 fx 欄位再各自換算。
    dbh.prepare(
      `SELECT s.member_id, e.kind, e.currency, s.amount_minor AS amt,
              e.fx_rate, e.fx_rate_override, e.fx_markup_pct
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.trip_id = ?`,
    ).bind(trip.id).all<{
      member_id: string; kind: 'shared' | 'personal'; currency: string; amt: number;
      fx_rate: number | null; fx_rate_override: number | null; fx_markup_pct: number;
    }>(),
  ]);

  const rows = shareRows.results ?? [];

  // 對外的形狀保持不變(nets / transfers),recorded / deferred 額外附上 ——
  // 結算頁要能把「公費的腿」標成唯讀,不要讓人以為那筆現在就該轉。
  const byCurrency: Record<string, {
    nets: Net[]; transfers: Transfer[]; recorded: Transfer[]; deferred: Transfer[];
  }> = {};
  for (const cur of ledger.currencies) {
    const b = ledger.byCurrency[cur]!;
    byCurrency[cur] = {
      nets: b.nets, transfers: b.transfers, recorded: b.recorded, deferred: b.deferred,
    };
  }

  // 每人的個人視角:共同分攤 + 個人花費 = 我這趟總共花了多少(換算本位幣)。
  // 用每筆支出自己的 fx_rate / override / markup,而不是統一套今天的匯率 ——
  // 否則會跟支出明細顯示的金額不一致。
  const today = new Date().toISOString().slice(0, 10);
  const rateCache = new Map<string, number | null>();
  const todayRate = async (cur: string) => {
    if (!rateCache.has(cur)) {
      const fx = await rateOn(dbh, trip.base_currency, cur, today);
      rateCache.set(cur, fx?.rate ?? null);
    }
    return rateCache.get(cur)!;
  };

  const perMember: Record<string, {
    sharedOwedBase: number; personalBase: number; totalBase: number; unconverted: number;
  }> = {};
  const slot = (id: string) => (perMember[id] ??= {
    sharedOwedBase: 0, personalBase: 0, totalBase: 0, unconverted: 0,
  });

  for (const r of rows) {
    const v = convertToBase({
      amountMinor: r.amt,
      currency: r.currency,
      baseCurrency: trip.base_currency,
      // 支出寫入時沒拿到匯率的(例如匯入舊資料),退回今天的匯率
      fxRate: r.fx_rate ?? await todayRate(r.currency),
      fxRateOverride: r.fx_rate_override,
      markupPct: r.fx_markup_pct ?? 0,
    });
    const s = slot(r.member_id);
    if (v == null) { s.unconverted += 1; continue; }   // 完全沒有匯率可用,計數而非靜靜歸零
    if (r.kind === 'shared') s.sharedOwedBase += v;
    else s.personalBase += v;
    s.totalBase = s.sharedOwedBase + s.personalBase;
  }

  return {
    base_currency: trip.base_currency,
    by_currency: byCurrency,
    per_member: perMember,
    pot: await potSummary(dbh, trip.id),
    disclaimer: '本位幣金額為估算值(中價加計價差/手續費假設)。刷卡以店家請款日匯率計價,實際金額以銀行帳單為準。',
    rate_attribution: 'Rates By Exchange Rate API (open.er-api.com)',
  };
});
