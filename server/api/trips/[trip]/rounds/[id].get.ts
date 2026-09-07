import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/**
 * 一次結算回合的完整明細 —— 「這 1,850 是怎麼算出來的」。
 *
 * 三塊:
 *   items      當時列入的支出(誰付的、誰分攤多少)
 *   nets       當時每個人的淨額快照(含公費)
 *   transfers  當時記下來的轉帳
 *
 * nets 是**快照**而不是即時重算 —— 之後有人補登支出、改名字、刪帳,
 * 重算會得到不同的數字,但當時是照這份付的錢。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少回合 id' });

  const round = await dbh.prepare(
    `SELECT id, currency, seq, label, note, created_at, reverted_at
     FROM settlement_rounds WHERE trip_id = ? AND id = ?`,
  ).bind(trip.id, id).first<{
    id: string; currency: string; seq: number; label: string | null;
    note: string | null; created_at: string; reverted_at: string | null;
  }>();
  if (!round) throw createError({ statusCode: 404, statusMessage: '找不到這次結算' });

  type Line = { expense_id: string; member_id: string; amount_minor: number };

  const [items, payers, shares, nets, transfers] = await Promise.all([
    dbh.prepare(
      `SELECT id, description, category, currency, amount_minor, payment_method,
              spent_at, note, created_at
       FROM expenses
       WHERE trip_id = ? AND settlement_round_id = ?
       ORDER BY spent_at ASC, created_at ASC`,
    ).bind(trip.id, id).all(),
    dbh.prepare(
      `SELECT p.expense_id, p.member_id, p.amount_minor
       FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.trip_id = ? AND e.settlement_round_id = ?`,
    ).bind(trip.id, id).all<Line>(),
    dbh.prepare(
      `SELECT s.expense_id, s.member_id, s.amount_minor
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.trip_id = ? AND e.settlement_round_id = ?`,
    ).bind(trip.id, id).all<Line>(),
    dbh.prepare(
      `SELECT member_id, net_minor FROM settlement_round_nets
       WHERE round_id = ? ORDER BY net_minor DESC`,
    ).bind(id).all<{ member_id: string; net_minor: number }>(),
    dbh.prepare(
      `SELECT id, from_member, to_member, currency, amount_minor, settled_at
       FROM settlements
       WHERE trip_id = ? AND round_id = ? AND source = 'round'
       ORDER BY amount_minor DESC`,
    ).bind(trip.id, id).all(),
  ]);

  const group = (rows: Line[]) => {
    const m = new Map<string, Array<{ member_id: string; amount_minor: number }>>();
    for (const r of rows) {
      const item = { member_id: r.member_id, amount_minor: r.amount_minor };
      const list = m.get(r.expense_id);
      if (list) list.push(item);
      else m.set(r.expense_id, [item]);
    }
    return m;
  };
  const byPayer = group(payers.results ?? []);
  const byShare = group(shares.results ?? []);

  return {
    ...round,
    items: (items.results ?? []).map((e: Record<string, unknown>) => ({
      ...e,
      payers: byPayer.get(String(e.id)) ?? [],
      shares: byShare.get(String(e.id)) ?? [],
    })),
    nets: (nets.results ?? []).map((n) => ({ memberId: n.member_id, netMinor: n.net_minor })),
    transfers: transfers.results ?? [],
  };
});
