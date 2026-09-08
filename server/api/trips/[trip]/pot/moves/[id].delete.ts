import { db } from '../../../../../utils/cf';
import { requireTrip } from '../../../../../utils/trip';
import { readPotMove, remainingAfter, blocksPotEdit, potMoveNotFound, potRemainingError } from '../../../../../utils/pot';
import { formatMoney } from '../../../../../utils/money';

/**
 * 刪掉一筆公費金流。
 *
 * ── 為什麼刪除和修改要分開存在 ────────────────────────────────
 *
 * 「金額打錯」用修改,「這筆根本沒發生」用刪除 —— 把後者做成「改成 0」是不行的,
 * amount_minor 是 CHECK(<> 0) 之外語意上也不成立:一筆 0 元的投入會一直留在
 * 清單上,而它代表的事情是「這個人投了 0 元」,不是「他沒投」。
 *
 * ── 算術上刪除**就是**改成 0 ──────────────────────────────────
 *
 * 語意分得開,算術不必分:刪掉一筆投入 = 那筆投入沒發生過 = 金額變成 0。
 * 所以剩餘的檢查直接呼叫 remainingAfter(m, 0),不另外推導一條公式 ——
 * 少一條路徑就少一個「改了修改那邊、忘了改刪除這邊」的機會。
 *
 * 刪投入會讓剩餘往下掉(可能變負 → 409),刪退還只會讓剩餘變大(永遠安全),
 * 這兩件事也是同一個算式自己得出來的結論,不是兩段 if。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' });

  // 事前檢查與刪不到時的診斷共用同一個讀取(同 expenses/[id].delete.ts)。
  const before = await readPotMove(dbh, trip.id, id);
  if (!before) throw potMoveNotFound();

  // 第一道:帶數字的錯誤訊息。投入 10,000、公費已經花掉 9,000 → 刪掉它
  // 剩餘會變成 −9,000,那是「信封裡的錢比實際有的多」,沒有現實對應。
  // 這種時候使用者要的通常是「改小」而不是「刪掉」,所以訊息會說最少能改到多少。
  //
  // 判準是**變化量**(見 utils/pot.ts 的 blocksPotEdit):刪**退還**的變化量
  // 恆為正,所以這一行對退還永遠放行 —— 那正是檔頭那句
  // 「刪退還只會讓剩餘變大(永遠安全)」宣告的行為。用絕對值判的話,
  // 公費一旦超支就沒有任何合法輸入動得了那一列(刪除比任何正數 PATCH 都寬鬆,
  // 而刪除都被擋),那一列會被永久凍結。
  if (blocksPotEdit(before, 0)) throw potRemainingError(before, 0);

  /**
   * 第二道,也是真正擋併發的那道:把前提寫進 DELETE 的 WHERE。
   *
   * 「一支把投入改小、另一支把另一筆投入刪掉」兩支各自都在剩餘之內,
   * 同時送出就會把信封挖穿 —— JS 那道只縮小空窗,消不掉它
   * (完整推導見 settlements.post.ts,那裡有實測命中率)。
   *
   * 算式與 utils/pot.ts 的 remainingAfter(m, 0) 是同一個數字,
   * 也和 [id].patch.ts 那句 UPDATE 是同一段(那裡的變化量是 ?4 − amount_minor,
   * 這裡的 ?4 恆為 0,所以化簡成 −amount_minor)。三處必須一起改。
   *
   * 方向一樣從那一列自己判斷(`CASE WHEN to_member = ?3`),不採信上面讀到的值。
   */
  const res = await dbh.prepare(
    `DELETE FROM settlements
     WHERE id = ?1 AND trip_id = ?2 AND source = 'manual'
       AND (from_member = ?3 OR to_member = ?3)
       AND (
         -- ① 變化量 ≥ 0 → 放行。刪**退還**的變化量恆為 +amount_minor,
         --    所以這一條讓「刪退還永遠安全」在 SQL 這一層也成立
         --    (見 utils/pot.ts 的 blocksPotEdit;JS 那道是同一個判準)。
         (CASE WHEN to_member = ?3 THEN -amount_minor ELSE amount_minor END) >= 0
         -- ② 刪投入(讓信封變少):刪完之後剩餘不可以是負的。
         OR (
         COALESCE((SELECT SUM(i.amount_minor) FROM settlements i
                    WHERE i.trip_id = ?2 AND i.currency = settlements.currency
                      AND i.to_member = ?3), 0)
         - COALESCE((SELECT SUM(p.amount_minor) FROM expense_payers p
                      JOIN expenses e ON e.id = p.expense_id
                      WHERE e.trip_id = ?2 AND e.kind = 'shared'
                        AND e.currency = settlements.currency AND p.member_id = ?3), 0)
         - COALESCE((SELECT SUM(o.amount_minor) FROM settlements o
                      WHERE o.trip_id = ?2 AND o.currency = settlements.currency
                        AND o.from_member = ?3), 0)
           + (CASE WHEN to_member = ?3 THEN -amount_minor ELSE amount_minor END)
         ) >= 0
       )`,
  ).bind(id, trip.id, before.pot_id).run();

  if (!res.meta?.changes) {
    // 刪不到有兩種可能:已經被別人刪掉了(404 —— 對使用者來說結果一樣,
    // 那筆確實不在了),或是在這個空窗裡剩餘掉到不夠了(409)。
    // 一律回 404 會讓使用者以為刪成功了,而它還在畫面上。
    const now = await readPotMove(dbh, trip.id, id);
    if (!now) throw potMoveNotFound();

    // 「這一瞬間」是刻意的措辭:它代表這支通過了 JS 那道、被 SQL 那道擋下來。
    // 兩道防線的訊息分得開,測試才驗得出資料庫層那道真的存在
    // (循序打 API 永遠先撞 JS,見 test/api.pot.test.ts 的併發那組)。
    const raced = (why: string) => createError({
      statusCode: 409,
      statusMessage: `${now.pot_name}的錢在你按下的這一瞬間被別人動了,這筆沒有被刪掉。${why}`,
    });
    // ⚠️ formatMoney,理由同 patch 那支:overview.vue 原樣顯示這句,
    // 裸內插的話 TWD 會差 100 倍。
    if (blocksPotEdit(now, 0)) {
      throw raced(`現在刪掉它,${now.currency}剩餘會變成 `
        + `${formatMoney(remainingAfter(now, 0), now.currency)}。`
        + '請重新整理看最新的剩餘再試一次。');
    }
    throw raced('請重新整理再試一次。');
  }

  return { ok: true, deleted: id };
});
