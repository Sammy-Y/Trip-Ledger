/**
 * 換匯紀錄的寫入驗證與逐列讀取。issue #6
 *
 * ── 為什麼抽出來 ────────────────────────────────────────────────
 *
 * 三支端點(POST / PATCH / DELETE)要問同樣的問題:
 *   ① 這個金額合法嗎(正整數最小單位)
 *   ② 這個日期合法嗎
 *   ③ 這一列到底是不是「這趟的」(答錯就是改到別人的帳)
 *
 * 各寫一份的下場是「有一天只改了一邊」。這裡的三個函式就是那三個問題的
 * 唯一答案(同 utils/pot.ts 的動機)。
 *
 * ── 和公費金流的關鍵差別:這裡**沒有**寫進 SQL 的併發前提 ─────────
 *
 * utils/pot.ts 的每一句 UPDATE / DELETE 都把「剩餘不可為負」寫進 WHERE,
 * 因為公費剩餘一旦變負,結算就會據此叫某個人付一筆憑空生出來的錢。
 *
 * 換匯紀錄沒有那個下游 —— 它不進淨額、不進轉帳、不進結算回合,
 * 錢包剩餘變負只是「在當地 ATM 提過款還沒記」的提示。
 * 所以這裡刻意不擋負數:擋了只會讓「先記支出、晚點才補記換匯」被莫名拒絕,
 * 而那是旅途中最常見的順序。**這不是漏了一道防線,是那道防線不該存在。**
 */
import type { FxExchange } from '../../shared/types';

/** 找不到 / 不屬於這趟 —— 一律同一句,不透露那個 id 存不存在(同 utils/trip.ts)。 */
export function exchangeNotFound() {
  return createError({ statusCode: 404, statusMessage: '找不到這筆換匯紀錄' });
}

/**
 * 金額一律是「大於 0 的整數最小單位」。
 *
 * 為什麼連 0 都不給:一筆「換到 0 日幣」或「付出 0 台幣」在現實裡不存在,
 * 而它會讓有效匯率變成 0 或除以 0。資料庫的 CHECK 也擋(見 schema.sql),
 * 這裡擋是為了給出說得出是哪個欄位的錯誤訊息 —— 撞到 CHECK 只會得到
 * 一句 SQLITE_CONSTRAINT,使用者完全不知道自己填錯了什麼。
 *
 * @param label 講給人聽的欄位名(「換到的金額」而不是 amount_minor)
 */
export function requirePositiveMinor(v: unknown, field: string, label: string): number {
  if (!Number.isInteger(v) || (v as number) <= 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `${label}(${field})必須是大於 0 的整數(最小單位)。`
        + '日幣直接填圓,台幣要填「分」—— NT$1,050 是 105000。',
    });
  }
  return v as number;
}

/**
 * 換匯日期。存 'YYYY-MM-DD',和支出的 spent_at 對齊
 * (那邊來自 <input type="date">,同一個形狀)。
 *
 * 為什麼要驗而不是照收:這個欄位是清單的排序鍵。
 * 收到 '昨天' 或 '2026/9/1' 的話 ORDER BY 會把它排到一個沒人料得到的位置,
 * 而且畫面上的日期會顯示 Invalid Date —— 兩個症狀都很難連回「當初存錯了」。
 *
 * 完整 ISO 字串(帶時間)一律截到日期:換匯是「那一天去銀行換的」,
 * 幾點幾分沒有意義,留著只會讓同一天的兩筆看起來像不同天。
 */
export function normalizeExchangedAt(raw: unknown): string {
  if (raw == null || raw === '') return new Date().toISOString().slice(0, 10);
  if (typeof raw !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'exchanged_at 必須是 YYYY-MM-DD 的日期字串' });
  }
  const date = raw.trim().slice(0, 10);
  const shapeOk = /^\d{4}-\d{2}-\d{2}$/.test(date);
  /*
    形狀對了還不夠,而且**不能只看 Date.parse 有沒有回 NaN**。

    '2026-02-30' 的 DD 是 30,合乎 ES 的 Date Time String Format(DD 只要求 01–31),
    所以 Date.parse 不會回 NaN —— 它會照 MakeDay 溢位成 2026-03-02。
    只檢查 NaN 的話,使用者填 2/30 會靜靜被存成 3/2,而清單上顯示的是 3/2,
    他只會覺得「我明明填 2 月」。(2026-13-01 的 MM 超出 01–12,那個才真的回 NaN。)

    所以用**來回比對**:轉成 Date 再印回 YYYY-MM-DD,對不上就是那一天不存在。
  */
  const roundTrip = shapeOk
    ? new Date(`${date}T00:00:00Z`)
    : null;
  const normalized = roundTrip && !Number.isNaN(roundTrip.getTime())
    ? roundTrip.toISOString().slice(0, 10)
    : null;
  if (normalized !== date) {
    throw createError({
      statusCode: 400,
      statusMessage: `換匯日期「${raw}」看不懂,或那一天不存在。請用 YYYY-MM-DD(例:2026-09-01)。`,
    });
  }
  return date;
}

/**
 * 讀出「可以被修改 / 刪除的那一列」。
 *
 * trip_id 寫進 WHERE 而不是查回來再比對:比對版本的漏洞是
 * 「忘記比」或「比錯欄位」,而那個 bug 的症狀是改到別的旅程的帳。
 * 前提寫在 WHERE 裡就不可能忘(同 utils/pot.ts 的 readPotMove)。
 *
 * 找不到的兩種情況(id 不存在 / 屬於別趟)一律回 null → 呼叫端一律 404。
 */
export async function readExchange(
  dbh: D1Database,
  tripId: string,
  id: string,
): Promise<FxExchange | null> {
  const row = await dbh.prepare(
    `SELECT id, member_id, currency, amount_minor, cost_currency, cost_minor,
            exchanged_at, note, created_at
     FROM fx_exchanges WHERE id = ?1 AND trip_id = ?2`,
  ).bind(id, tripId).first<FxExchange>();
  return row ?? null;
}
