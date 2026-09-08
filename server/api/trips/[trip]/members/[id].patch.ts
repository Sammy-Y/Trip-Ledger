import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';

/** 改成員名字,或把某個成員標成/取消公費。 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const memberId = getRouterParam(event, 'id');
  if (!memberId) throw createError({ statusCode: 400, statusMessage: '缺少成員 id' });

  const body = await readBody<{ name?: string; is_pot?: boolean | number }>(event);

  const member = await dbh.prepare(
    `SELECT id, name, is_pot FROM members WHERE trip_id = ? AND id = ?`,
  ).bind(trip.id, memberId).first<{ id: string; name: string; is_pot: number }>();
  if (!member) throw createError({ statusCode: 404, statusMessage: '這趟旅程裡沒有這個成員' });

  const name = body?.name === undefined ? member.name : String(body.name).trim();
  if (!name) throw createError({ statusCode: 400, statusMessage: '名字不能是空的' });

  const isPot = body?.is_pot === undefined ? member.is_pot : (body.is_pot ? 1 : 0);

  // 改名撞到別人 —— UNIQUE(trip_id, name) 會擋,但先給看得懂的訊息。
  if (name !== member.name) {
    const duplicate = await dbh.prepare(
      `SELECT id FROM members WHERE trip_id = ? AND name = ? AND id <> ?`,
    ).bind(trip.id, name, memberId).first<{ id: string }>();
    if (duplicate) throw createError({ statusCode: 400, statusMessage: `已經有一個叫「${name}」的成員了` });
  }

  if (isPot === 1 && member.is_pot !== 1) {
    const existing = await dbh.prepare(
      `SELECT name FROM members WHERE trip_id = ? AND is_pot = 1 AND id <> ?`,
    ).bind(trip.id, memberId).first<{ name: string }>();
    if (existing) {
      throw createError({ statusCode: 400, statusMessage: `這趟已經有公費了(${existing.name})` });
    }

    // ⚠️ 已經有帳的人不能被改成公費。
    //
    // expenses.post 會擋「公費當個人花費付款人」和「公費出現在分攤名單」,
    // 但那只在**寫入當下已經有公費**才擋得到。先用普通成員記帳、之後再把他
    // 標成公費的話就整個繞過去了,而且會直接破壞
    // 「公費剩餘 = −公費淨額」這個不變量:
    //   - 他名下的個人花費 → 剩餘和淨額差掉那筆金額,那筆錢卡在沒有畫面能解決的地方
    //   - 他名下的分攤     → 真實的債務被無聲重新分類成「永遠 deferred 的公費腿」,
    //                        結算再也不會把它寫出來(實測 K 欠的 3,000 就這樣消失)
    const used = await dbh.prepare(
      `SELECT
         (SELECT COUNT(*) FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
           WHERE e.trip_id = ?1 AND p.member_id = ?2) AS paid,
         (SELECT COUNT(*) FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
           WHERE e.trip_id = ?1 AND s.member_id = ?2) AS owed,
         (SELECT COUNT(*) FROM settlements
           WHERE trip_id = ?1 AND (from_member = ?2 OR to_member = ?2)) AS moves`,
    ).bind(trip.id, memberId).first<{ paid: number; owed: number; moves: number }>();

    const total = (used?.paid ?? 0) + (used?.owed ?? 0) + (used?.moves ?? 0);
    if (total > 0) {
      const parts = [
        used?.paid ? `付款 ${used.paid} 筆` : null,
        used?.owed ? `分攤 ${used.owed} 筆` : null,
        used?.moves ? `金流 ${used.moves} 筆` : null,
      ].filter(Boolean).join('、');
      throw createError({
        statusCode: 409,
        statusMessage: `「${member.name}」已經有帳(${parts}),不能改成公費 ——`
          + '那會讓既有的分攤變成永遠不會被結算的公費款項。'
          + '請改成新增一個成員當公費。',
      });
    }
  }

  // 取消公費身分前要先確認它沒有被當成公費用過,否則總覽的「公費剩餘」會突然消失,
  // 而那些錢的去向仍然記在帳上 —— 帳面和畫面會對不起來。
  if (member.is_pot === 1 && isPot === 0) {
    const used = await dbh.prepare(
      `SELECT (SELECT COUNT(*) FROM settlements
                WHERE trip_id = ?1 AND (from_member = ?2 OR to_member = ?2)) AS moves,
              (SELECT COUNT(*) FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
                WHERE e.trip_id = ?1 AND p.member_id = ?2) AS paid`,
    ).bind(trip.id, memberId).first<{ moves: number; paid: number }>();
    if ((used?.moves ?? 0) + (used?.paid ?? 0) > 0) {
      throw createError({
        statusCode: 400,
        statusMessage: '這個公費已經有投入或支出紀錄,不能取消公費身分。要停用請先清掉相關紀錄。',
      });
    }
  }

  await dbh.prepare(`UPDATE members SET name = ?, is_pot = ? WHERE trip_id = ? AND id = ?`)
    .bind(name, isPot, trip.id, memberId).run();

  return { id: memberId, name, is_pot: isPot };
});
