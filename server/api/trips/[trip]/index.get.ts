import { db } from '../../../utils/cf';
import { requireTrip } from '../../../utils/trip';

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const cfg = useRuntimeConfig(event);

  // 公費排在最後 —— 它不是人,在成員名單裡混在中間會讓人以為多了一個旅伴。
  const members = await dbh.prepare(
    `SELECT id, name, is_pot FROM members WHERE trip_id = ? ORDER BY is_pot, name`,
  ).bind(trip.id).all<{ id: string; name: string; is_pot: number }>();

  return {
    trip,
    members: members.results ?? [],
    // 記帳表單要顯示「刷卡預設加計多少手續費」並讓使用者改。
    // 值的來源仍然只有 runtimeConfig 一處,不在前端複製一份預設值。
    fx_defaults: {
      cash_spread_pct: Number(cfg.cashSpreadPct),
      card_fee_pct: Number(cfg.cardFeePct),
    },
  };
});
