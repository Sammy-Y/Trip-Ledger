import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/**
 * 撤銷一次結算回合。
 *
 * 誤按「結算」是會發生的事,而結算會寫入真實金錢的紀錄 ——
 * 沒有撤銷的話,使用者只能自己去把那幾筆 settlement 一列一列刪掉,
 * 而且刪的過程中畫面上的餘額是錯的。
 *
 * 撤銷要做三件事,一個 batch 內完成:
 *   1. 刪掉這個回合產生的轉帳(source='round')
 *   2. 把這個回合蓋的章拆掉(expenses.settlement_round_id → NULL)
 *   3. 標記 reverted_at(列留著,帳上看得出「這裡曾經結算過又撤銷」)
 *
 * ⚠️ **只刪 source='round' 的列。** 使用者自己按「標記已還款」記的還款、
 * 以及投入公費的那些,都是真的發生過的付款 —— 撤銷回合不該把它們一起消滅。
 * 而因為手動的列從頭到尾不會被蓋上 round_id(見 rounds.post.ts),
 * 這裡本來就碰不到它們;那個 source 條件是第二道保險。
 *
 * 撤銷之後那些支出會回到「未結算」,下次預覽又會出現 —— 這正是預期行為。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少回合 id' });

  const round = await dbh.prepare(
    `SELECT id, seq, currency, reverted_at FROM settlement_rounds
     WHERE trip_id = ? AND id = ?`,
  ).bind(trip.id, id).first<{ id: string; seq: number; currency: string; reverted_at: string | null }>();
  if (!round) throw createError({ statusCode: 404, statusMessage: '找不到這次結算' });

  if (round.reverted_at) {
    throw createError({ statusCode: 409, statusMessage: '這次結算已經撤銷過了' });
  }

  const counts = await dbh.prepare(
    `SELECT
       (SELECT COUNT(*) FROM settlements s
         WHERE s.trip_id = ?1 AND s.round_id = ?2 AND s.source = 'round') AS transfers,
       (SELECT COUNT(*) FROM expenses e
         WHERE e.trip_id = ?1 AND e.settlement_round_id = ?2) AS items`,
  ).bind(trip.id, id).first<{ transfers: number; items: number }>();

  await dbh.batch([
    dbh.prepare(
      `DELETE FROM settlements WHERE trip_id = ? AND round_id = ? AND source = 'round'`,
    ).bind(trip.id, id),
    dbh.prepare(
      `UPDATE expenses SET settlement_round_id = NULL
       WHERE trip_id = ? AND settlement_round_id = ?`,
    ).bind(trip.id, id),
    dbh.prepare(
      `UPDATE settlement_rounds SET reverted_at = datetime('now')
       WHERE trip_id = ? AND id = ?`,
    ).bind(trip.id, id),
  ]);

  return {
    id,
    reverted: true,
    removed_transfers: counts?.transfers ?? 0,
    unstamped_items: counts?.items ?? 0,
  };
});
