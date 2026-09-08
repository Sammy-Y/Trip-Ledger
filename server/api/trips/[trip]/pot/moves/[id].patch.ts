import { db } from '../../../../../utils/cf';
import { requireTrip } from '../../../../../utils/trip';
import { readPotMove, remainingAfter, potMoveNotFound, potRemainingError } from '../../../../../utils/pot';

/**
 * 改一筆公費金流的金額。
 *
 * ── 為什麼需要這支 ────────────────────────────────────────────
 *
 * 「我公費給了 10,000,但其實是 8,000」在這支之前只有一條路:再記一筆
 * 退還 2,000 去沖銷。剩餘是對了,但**帳面上留下兩筆從來沒發生過的金流** ——
 * 一筆 10,000 的投入和一筆 2,000 的退還,而事實是一筆 8,000 的投入。
 * 旅程結束核對現金的時候,那兩筆會讓人以為信封真的收過 10,000 又吐回 2,000。
 * 記帳的價值是「事後說得出錢怎麼走的」,用假金流換對的餘額是把那個價值丟掉。
 *
 * ── 只改金額 ──────────────────────────────────────────────────
 *
 * body 只有 amount_minor。方向、幣別、對象都不給改是刻意的:
 * 「投入記成退還」「記到別人頭上」不是改一個數字,那是刪掉重記
 * (而且刪除已經有了)。留在這裡只會讓這支端點要重做 moves.post 的
 * 每一條成員 / 幣別驗證,而漏掉哪一條那條就等於不存在。
 *
 * settled_at 也不動:它是「什麼時候記下來的」,改一個打錯的數字不該讓那筆
 * 跳到清單最上面(同 expenses/[id].patch.ts 不碰 created_at 的理由)。
 *
 * ── 409 為什麼排在 400 後面 ───────────────────────────────────
 *
 * 這個 repo 的慣例是 404 / 409 先於 400(改不到的東西,body 對不對沒有意義,
 * 見 expenses/[id].patch.ts)。這裡 404 仍然第一個,但 409 只能排在 400 之後 ——
 * 因為「會不會讓剩餘變負」這個問題要有 amount_minor 才問得出來。
 * 順序是:能不能動這一列(404)→ 這個數字合不合法(400)→ 改了會不會爆(409)。
 */
type Body = { amount_minor: number };

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' });

  // 事前檢查與寫不進去時的診斷共用同一個讀取 —— 兩邊的判準必須一模一樣,
  // 各寫一份的話,診斷會開始說出和檢查不一致的話(同 expenses/[id].delete.ts)。
  const before = await readPotMove(dbh, trip.id, id);
  if (!before) throw potMoveNotFound();

  const b = await readBody<Body>(event);
  if (!Number.isInteger(b?.amount_minor) || b.amount_minor <= 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'amount_minor 必須是大於 0 的整數(最小單位)。要把這筆歸零請直接刪除它。',
    });
  }

  // ── 剩餘不可為負,第一道:給出帶數字的錯誤訊息 ────────────────
  //
  // 投入 10,000、公費已經花掉 9,000,把投入改成 8,000 → 剩餘 −1,000。
  // 那是「信封裡的錢比實際有的多」,沒有現實對應:總覽會據此叫人再退還,
  // 而退出去的那 1,000 是憑空生出來的。
  //
  // 這一道**擋不住併發**(讀完到寫入之間隔著一次往返),真正的防線是下面
  // 那個 UPDATE 的 WHERE。留著它是為了訊息:SQL 那道只能告訴我們「不成立」,
  // 說不出「現在剩多少、最少能改到多少」。
  if (remainingAfter(before, b.amount_minor) < 0) {
    throw potRemainingError(before, b.amount_minor);
  }

  /**
   * ── 剩餘不可為負,第二道:把前提寫進 SQL 本身 ────────────────
   *
   * 兩支請求可以雙雙通過上面那個 JS 檢查再雙雙寫入 —— 這不是理論:
   * settlements.post.ts 和 rounds.post.ts 的註解裡都是實測數字,
   * 而這支的版本是「兩個人各自把自己那筆投入改小一點」:
   * 各自看起來都還在剩餘之內,加起來就把信封挖穿了。
   *
   * 所以條件在**寫入的同一個語句裡**求值,看得到所有已提交的資料,沒有空窗。
   * 算式與 utils/pot.ts 的 remainingOf / remainingAfter 是同一個數字
   * (三個 COALESCE 相減 = 投入 − 公費花掉的 − 已退還,再加上這一列的變化量),
   * **兩邊算的必須是同一個數** —— 不一樣的話,使用者會拿到一句
   * 「被別人改動了」而其實沒有人動過。
   *
   * 變化量用 `CASE WHEN to_member = ?3` 從**那一列自己**判斷方向,
   * 而不是把上面 JS 讀到的 direction 綁進來:那個值來自前一次往返,
   * 而這句 SQL 的意義是「不管剛剛讀到什麼,寫入的這一刻仍然成立」。
   * 條件的每一項都自己重新拿一次,那個承諾才是真的。
   *
   * `source = 'manual'` 和「任一端是公費」也一起帶上,理由同 readPotMove:
   * 前提要寫在 WHERE 裡,而不是靠上面已經查過了。
   */
  const res = await dbh.prepare(
    `UPDATE settlements SET amount_minor = ?4
     WHERE id = ?1 AND trip_id = ?2 AND source = 'manual'
       AND (from_member = ?3 OR to_member = ?3)
       AND (
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
         + (CASE WHEN to_member = ?3 THEN ?4 - amount_minor ELSE amount_minor - ?4 END)
       ) >= 0`,
  ).bind(id, trip.id, before.pot_id, b.amount_minor).run();

  if (!res.meta?.changes) {
    // 改不到只有一種可能:在這個空窗裡別人動了公費的錢(這一列被刪掉、
    // 或者其他人的投入 / 退還 / 公費花費讓剩餘掉到不夠了)。
    // 重讀一次再回報,而且**用同一個 remainingAfter 重算**,
    // 這樣訊息裡的數字是現在的事實,不是剛剛那次讀取的殘影。
    const now = await readPotMove(dbh, trip.id, id);
    if (!now) throw potMoveNotFound();

    // 「這一瞬間」這句話是刻意的:它代表這支請求通過了 JS 那道、被 SQL 那道擋下來。
    // 兩道防線的訊息分得開,測試才驗得出資料庫層那道真的存在
    // (循序打 API 永遠先撞 JS,見 test/api.pot.test.ts 的併發那組)。
    const raced = (why: string) => createError({
      statusCode: 409,
      statusMessage: `${now.pot_name}的錢在你按下的這一瞬間被別人動了,這筆一個字都沒有改到。${why}`,
    });
    if (remainingAfter(now, b.amount_minor) < 0) {
      throw raced(`現在改成 ${b.amount_minor} 會讓${now.currency}剩餘變成 `
        + `${remainingAfter(now, b.amount_minor)}。請重新整理看最新的剩餘再改。`);
    }
    throw raced('請重新整理再試一次。');
  }

  return { id, amount_minor: b.amount_minor };
});
