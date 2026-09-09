import { db } from '../../../../../utils/cf';
import { requireTrip } from '../../../../../utils/trip';
import {
  exchangeNotFound,
  normalizeExchangedAt,
  readExchange,
  requirePositiveMinor,
} from '../../../../../utils/exchange';

/**
 * 改一筆換匯紀錄。
 *
 * ── 為什麼可以直接改 ────────────────────────────────────────────
 *
 * 打錯字很正常(0.21 打成 0.021、5,000 打成 50,000),而這張表**不影響任何
 * 結算**:不進淨額、不進轉帳、不進結算回合、不碰公費。所以改它只會讓
 * 錢包的剩餘變準,不可能讓任何人被要求付一筆不存在的錢。
 *
 * 對照 pot/moves/[id].patch.ts:那支要兩道防線(JS 一道給訊息、SQL 一道
 * 擋併發),因為公費剩餘變負會讓結算寫出憑空生出來的真實轉帳。
 * 這裡**刻意一道都不放**:錢包剩餘變負只是提示(在當地 ATM 提過款沒記),
 * 擋了反而會讓「先記支出、晚點才補記換匯」這個最常見的順序被拒絕。
 *
 * ── 只改金額 / 日期 / 備註 ──────────────────────────────────────
 *
 * member_id、currency、cost_currency 都不給改,理由同 pot/moves 那支:
 * 「記到別人頭上」「幣別選錯」不是改一個數字,那是刪掉重記(而刪除已經有了)。
 * 留在這裡只會讓這支端點重做 exchanges.post 的每一條成員 / 幣別 / 公費驗證,
 * 而漏掉哪一條那條就等於不存在。
 *
 * created_at 也不動:它是「什麼時候記下來的」,改一個打錯的數字不該讓那筆
 * 跳到清單最上面(同 expenses/[id].patch.ts 不碰 created_at 的理由)。
 * exchanged_at 反過來**要能改** —— 那是「哪一天去換的」,本身就可能記錯,
 * 而它是清單的排序鍵,錯了就永遠找不到那一筆。
 */
type Body = {
  amount_minor?: number;
  cost_minor?: number;
  exchanged_at?: string;
  /** null = 清掉備註;不給這個欄位 = 保持原樣 */
  note?: string | null;
};

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' });

  // 404 先於 400:改不到的東西,body 對不對沒有意義
  // (這個 repo 的慣例,見 expenses/[id].patch.ts)。
  const before = await readExchange(dbh, trip.id, id);
  if (!before) throw exchangeNotFound();

  const b = (await readBody<Body>(event)) ?? {};

  /*
    ── 部分更新:沒給的欄位沿用舊值 ──────────────────────────────

    合併之後一律用**同一句** UPDATE 寫四個欄位,不按 body 的內容拼 SQL。
    動態拼接會讓這支變成「有幾種欄位組合就有幾條路徑」,而測試只會蓋到其中幾條
    (而且 test/sql-safety.test.ts 直接把字串拼 SQL 當成失敗條件)。
    多寫幾個沒變的欄位不花什麼,少一條路徑就少一個 bug 的家。
  */
  const amountMinor = b.amount_minor === undefined
    ? before.amount_minor
    : requirePositiveMinor(b.amount_minor, 'amount_minor', '換到的金額');
  const costMinor = b.cost_minor === undefined
    ? before.cost_minor
    : requirePositiveMinor(b.cost_minor, 'cost_minor', '付出的金額');
  const exchangedAt = b.exchanged_at === undefined
    ? before.exchanged_at
    : normalizeExchangedAt(b.exchanged_at);
  // `'note' in b` 而不是 `b.note !== undefined`:要分得出「沒送這個欄位」
  // (保持原樣)和「送了 null」(清掉備註)。後者是使用者刪掉輸入框的內容。
  const note = 'note' in b ? (b.note?.trim() || null) : before.note;

  const res = await dbh.prepare(
    `UPDATE fx_exchanges
     SET amount_minor = ?3, cost_minor = ?4, exchanged_at = ?5, note = ?6
     WHERE id = ?1 AND trip_id = ?2`,
  ).bind(id, trip.id, amountMinor, costMinor, exchangedAt, note).run();

  // 上面剛讀到、這裡卻改不到 —— 只有一種可能:在這個空窗裡別人把它刪掉了。
  // 對使用者來說結果和「本來就不存在」一樣(那筆確實不在了),所以同一句 404。
  if (!res.meta?.changes) throw exchangeNotFound();

  return {
    id,
    member_id: before.member_id,
    currency: before.currency,
    amount_minor: amountMinor,
    cost_currency: before.cost_currency,
    cost_minor: costMinor,
    exchanged_at: exchangedAt,
    note,
  };
});
