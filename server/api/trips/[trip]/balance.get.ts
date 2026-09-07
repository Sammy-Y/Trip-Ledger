import { db } from '../../../utils/cf';
import { requireTrip } from '../../../utils/trip';
import { rateOn } from '../../../utils/fx';
import { convertToBase } from '../../../utils/money';
import { netBalances, minCashFlow, type Net, type Transfer } from '../../../utils/settle';

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

  const [paid, owed, settled, shareRows] = await Promise.all([
    dbh.prepare(
      `SELECT e.currency, p.member_id, SUM(p.amount_minor) AS amt
       FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.trip_id = ? AND e.kind = 'shared' GROUP BY e.currency, p.member_id`,
    ).bind(trip.id).all<{ currency: string; member_id: string; amt: number }>(),
    dbh.prepare(
      `SELECT e.currency, s.member_id, SUM(s.amount_minor) AS amt
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.trip_id = ? AND e.kind = 'shared' GROUP BY e.currency, s.member_id`,
    ).bind(trip.id).all<{ currency: string; member_id: string; amt: number }>(),
    dbh.prepare(
      `SELECT currency, from_member, to_member, SUM(amount_minor) AS amt
       FROM settlements WHERE trip_id = ? GROUP BY currency, from_member, to_member`,
    ).bind(trip.id).all<{ currency: string; from_member: string; to_member: string; amt: number }>(),
    // per_member 的本位幣統計要用「每筆支出自己 snapshot 的匯率」,
    // 所以這兩個查詢不做 GROUP BY —— 逐筆帶出 fx 欄位再各自換算。
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

  const paidR = paid.results ?? [], owedR = owed.results ?? [];
  const settledR = settled.results ?? [], rows = shareRows.results ?? [];

  const currencies = [...new Set([...paidR, ...owedR].map((r) => r.currency))];

  const byCurrency: Record<string, { nets: Net[]; transfers: Transfer[] }> = {};
  for (const cur of currencies) {
    const nets = netBalances({
      paid: paidR.filter((r) => r.currency === cur).map((r) => ({ memberId: r.member_id, amountMinor: r.amt })),
      owed: owedR.filter((r) => r.currency === cur).map((r) => ({ memberId: r.member_id, amountMinor: r.amt })),
      settled: settledR.filter((r) => r.currency === cur)
        .map((r) => ({ from: r.from_member, to: r.to_member, amountMinor: r.amt })),
    });
    byCurrency[cur] = { nets, transfers: minCashFlow(nets) };
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
    disclaimer: '本位幣金額為估算值(中價加計價差/手續費假設)。刷卡以店家請款日匯率計價,實際金額以銀行帳單為準。',
    rate_attribution: 'Rates By Exchange Rate API (open.er-api.com)',
  };
});
