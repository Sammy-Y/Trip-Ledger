import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/** 結算歷史。最新的排前面。 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const rows = await dbh.prepare(
    `SELECT r.id, r.currency, r.seq, r.label, r.note, r.created_at, r.reverted_at,
            (SELECT COUNT(*) FROM expenses e WHERE e.settlement_round_id = r.id) AS item_count,
            (SELECT COUNT(*) FROM settlements s WHERE s.round_id = r.id AND s.source = 'round')
              AS transfer_count,
            (SELECT COALESCE(SUM(s.amount_minor), 0) FROM settlements s
              WHERE s.round_id = r.id AND s.source = 'round') AS transfer_total_minor
     FROM settlement_rounds r
     WHERE r.trip_id = ?
     ORDER BY r.created_at DESC, r.seq DESC`,
  ).bind(trip.id).all();

  return rows.results ?? [];
});
