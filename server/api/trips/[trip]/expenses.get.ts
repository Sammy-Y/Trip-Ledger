import { db } from '../../../utils/cf';
import { requireTrip } from '../../../utils/trip';
import type { Expense, Kind } from '../../../../shared/types';

type Row = Omit<Expense, 'payers' | 'shares'>;
type Line = { expense_id: string; member_id: string; amount_minor: number };

/**
 * 支出列表。?kind=shared|personal 不給就兩軌都回。
 *
 * payers / shares 用「整批撈出來再在記憶體組裝」而不是逐筆查 ——
 * D1 每個 statement 都是一次往返,N+1 在幾十筆支出上就會很有感。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const raw = getQuery(event).kind;
  const kind = typeof raw === 'string' && raw ? (raw as Kind) : undefined;
  if (kind && kind !== 'shared' && kind !== 'personal') {
    throw createError({ statusCode: 400, statusMessage: 'kind 只能是 shared 或 personal' });
  }

  // SQL 一律寫成完全靜態的字串,不做任何插值。
  // 用「?2 IS NULL OR e.kind = ?2」的 sentinel 寫法讓同一份 SQL 同時支援
  // 「有篩選」和「不篩選」—— 這樣就不需要動態拼接 WHERE 子句。
  // (原本的寫法插的雖然是常數字面量、實際上安全,但只要有人後來改成
  //  把 kind 直接插進去就會變成 injection,而 review 很容易看漏。)
  const kindArg = kind ?? null;

  const [expenses, payers, shares] = await Promise.all([
    dbh.prepare(
      `SELECT e.id, e.kind, e.description, e.category, e.currency, e.amount_minor,
              e.payment_method, e.fx_rate, e.fx_rate_date, e.fx_rate_source,
              e.fx_rate_override, e.fx_markup_pct, e.spent_at, e.settlement_round_id,
              e.note, e.created_at
       FROM expenses e
       WHERE e.trip_id = ?1 AND (?2 IS NULL OR e.kind = ?2)
       ORDER BY e.spent_at DESC, e.created_at DESC`,
    ).bind(trip.id, kindArg).all<Row>(),
    dbh.prepare(
      `SELECT p.expense_id, p.member_id, p.amount_minor
       FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.trip_id = ?1 AND (?2 IS NULL OR e.kind = ?2)`,
    ).bind(trip.id, kindArg).all<Line>(),
    dbh.prepare(
      `SELECT s.expense_id, s.member_id, s.amount_minor
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.trip_id = ?1 AND (?2 IS NULL OR e.kind = ?2)`,
    ).bind(trip.id, kindArg).all<Line>(),
  ]);

  const group = (rows: Line[]) => {
    const m = new Map<string, Array<{ member_id: string; amount_minor: number }>>();
    for (const r of rows) {
      const list = m.get(r.expense_id);
      const item = { member_id: r.member_id, amount_minor: r.amount_minor };
      if (list) list.push(item);
      else m.set(r.expense_id, [item]);
    }
    return m;
  };

  const byPayer = group(payers.results ?? []);
  const byShare = group(shares.results ?? []);

  return (expenses.results ?? []).map<Expense>((e) => ({
    ...e,
    payers: byPayer.get(e.id) ?? [],
    shares: byShare.get(e.id) ?? [],
  }));
});
