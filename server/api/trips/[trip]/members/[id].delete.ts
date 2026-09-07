import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/**
 * 刪除成員。
 *
 * ⚠️ 這支一定要先檢查參照,不能直接 DELETE。
 *
 * expense_payers 和 expense_shares 對 members 都是 ON DELETE CASCADE ——
 * 直接刪人的話,那些付款/分攤的列會跟著無聲消失,結果是:
 * 支出金額還在,但分攤合計對不上了(守恆被破壞),而且沒有任何錯誤訊息。
 * 結算會從此算出錯的數字,而使用者不會知道發生過什麼。
 *
 * 所以有帳的人不給刪,只給改名。這是刻意的取捨:
 * 「打錯字」用改名解決,「這個人根本不該在名單裡」才需要刪,
 * 而後者按定義就是還沒有任何帳的人。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const memberId = getRouterParam(event, 'id');
  if (!memberId) throw createError({ statusCode: 400, statusMessage: '缺少成員 id' });

  const member = await dbh.prepare(
    `SELECT id, name FROM members WHERE trip_id = ? AND id = ?`,
  ).bind(trip.id, memberId).first<{ id: string; name: string }>();
  if (!member) throw createError({ statusCode: 404, statusMessage: '這趟旅程裡沒有這個成員' });

  const refs = await dbh.prepare(
    `SELECT
       (SELECT COUNT(*) FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
         WHERE e.trip_id = ?1 AND p.member_id = ?2) AS paid,
       (SELECT COUNT(*) FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
         WHERE e.trip_id = ?1 AND s.member_id = ?2) AS owed,
       (SELECT COUNT(*) FROM settlements
         WHERE trip_id = ?1 AND (from_member = ?2 OR to_member = ?2)) AS moves`,
  ).bind(trip.id, memberId).first<{ paid: number; owed: number; moves: number }>();

  const paid = refs?.paid ?? 0, owed = refs?.owed ?? 0, moves = refs?.moves ?? 0;
  if (paid + owed + moves > 0) {
    const parts = [
      paid ? `付款 ${paid} 筆` : null,
      owed ? `分攤 ${owed} 筆` : null,
      moves ? `還款 ${moves} 筆` : null,
    ].filter(Boolean).join('、');
    throw createError({
      statusCode: 409,
      statusMessage: `「${member.name}」還有帳(${parts}),不能刪除。要改名的話用編輯就好;真的要移除請先刪掉相關支出。`,
    });
  }

  await dbh.prepare(`DELETE FROM members WHERE trip_id = ? AND id = ?`)
    .bind(trip.id, memberId).run();

  return { id: memberId, deleted: true };
});
