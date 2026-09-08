/**
 * 公費金流(任一端是公費的 settlement)的共用查詢與算術。
 *
 * ── 為什麼要抽出來 ──────────────────────────────────────────
 *
 * 修改與刪除兩支端點都必須回答同樣的兩個問題:
 *
 *   ① 這一列到底是不是「這趟的、可以動的公費金流」(答錯就是 404 或改到別人的帳)
 *   ② 動了它之後,公費剩餘會變成多少(答錯就是那個不可為負的不變量破掉)
 *
 * 兩邊各寫一份的下場是「有一天只改了一邊」,而那個分岔的症狀特別難認:
 * JS 算出來放行、SQL 前提算出來擋掉,使用者拿到一句莫名其妙的
 * 「被別人改動了」而其實沒有人動過(這個 repo 的 settlements.post 剛修完
 * 同一類的 bug)。所以「剩餘怎麼算」在 server 端只有這裡一份。
 *
 * ⚠️ 這份 JS 算術有一個資料庫層的雙胞胎:兩支端點 `UPDATE` / `DELETE`
 * 的 WHERE 裡那段三個 COALESCE 相減的算式。JS 這道只是為了給出**帶數字的
 * 錯誤訊息**,真正擋併發的是 SQL 那道(理由見 settlements.post.ts 的實測數字)。
 * 改動這裡的定義時,那兩句 SQL 一定要一起改。
 */
import { formatMoney } from './money';

export interface PotMove {
  id: string;
  /** in = 人投入公費(公費是 to_member);out = 公費退還給人 */
  direction: 'in' | 'out';
  /** 對方是誰(投入的人 / 收到退還的人)。公費本身在 pot_id。 */
  member_id: string;
  currency: string;
  amount_minor: number;
  settled_at: string;
  note: string | null;
  pot_id: string;
  pot_name: string;
  /** 這個幣別目前的三個量(含這一列自己)。剩餘 = contributed − spent − refunded。 */
  contributed: number;
  spent: number;
  refunded: number;
}

/**
 * 讀出「可以被修改 / 刪除的那一列」,順便把同幣別的公費收支一起帶回來。
 *
 * 一次往返問完兩件事是刻意的:分成兩次查的話,「這列屬於哪個幣別」和
 * 「那個幣別現在剩多少」之間又多一個空窗,而下面所有的判斷都建立在
 * 「這兩個數字看到的是同一瞬間」之上(寫法同 expenses/[id].patch.ts 的 readTarget)。
 *
 * 找不到的三種情況一律回 null → 呼叫端一律 404:
 *   ① 這個 id 不存在  ② 它屬於別趟  ③ 它不是公費金流(人對人的還款)
 * 分開回報等於告訴對方「這個 id 存在,只是不給你動」,那本身就是資訊洩漏
 * (同 utils/trip.ts 的 notFound())。
 *
 * `source = 'manual'` 也寫進 WHERE:結算回合產生的轉帳(source = 'round')
 * 是回合的一部分,它的生命週期屬於那個回合(撤銷回合時整批刪掉),
 * 從這兩支端點被逐筆改掉會讓回合的明細對不上它自己的淨額快照。
 * 公費的腿本來就不會被寫成 round(見 utils/ledger.ts:deferred 一律不寫入),
 * 所以這個條件今天永遠成立 —— 但**不要依賴那個巧合**,巧合會隨著下一次
 * 結算語意的改動消失,而它消失的時候沒有任何測試會紅。
 */
export async function readPotMove(
  dbh: D1Database,
  tripId: string,
  id: string,
): Promise<PotMove | null> {
  const row = await dbh.prepare(
    `SELECT s.id, s.currency, s.amount_minor, s.settled_at, s.note,
            m.id AS pot_id, m.name AS pot_name,
            CASE WHEN s.to_member = m.id THEN 'in' ELSE 'out' END AS direction,
            CASE WHEN s.to_member = m.id THEN s.from_member ELSE s.to_member END AS member_id,
            COALESCE((SELECT SUM(i.amount_minor) FROM settlements i
                       WHERE i.trip_id = s.trip_id AND i.currency = s.currency
                         AND i.to_member = m.id), 0) AS contributed,
            COALESCE((SELECT SUM(p.amount_minor) FROM expense_payers p
                       JOIN expenses e ON e.id = p.expense_id
                       WHERE e.trip_id = s.trip_id AND e.kind = 'shared'
                         AND e.currency = s.currency AND p.member_id = m.id), 0) AS spent,
            COALESCE((SELECT SUM(o.amount_minor) FROM settlements o
                       WHERE o.trip_id = s.trip_id AND o.currency = s.currency
                         AND o.from_member = m.id), 0) AS refunded
     FROM settlements s
     JOIN members m ON m.trip_id = s.trip_id AND m.is_pot = 1
     WHERE s.id = ?1 AND s.trip_id = ?2 AND s.source = 'manual'
       AND (s.from_member = m.id OR s.to_member = m.id)`,
  ).bind(id, tripId).first<PotMove>();
  return row ?? null;
}

/**
 * 剩餘 = 投入 − 公費付掉的 − 已退還。
 *
 * 定義與 balance.get.ts 的 potSummary 完全一致(那裡是總覽頁顯示的來源),
 * 包括「不分 source」這件事:回合寫的轉帳如果真的碰到了公費,那筆錢也確實
 * 進出過信封,算剩餘時不能當作沒發生。可以被**編輯**的集合才需要濾 source。
 */
export const remainingOf = (m: PotMove) => m.contributed - m.spent - m.refunded;

/**
 * 把這一筆改成 newAmountMinor 之後,剩餘會變成多少。
 *
 * 投入改小、或退還改大,都會讓剩餘往下掉 —— 兩者是同一件事的兩個方向,
 * 所以這裡只有一個算式,不是兩段 if:
 *
 *   in  : 剩餘 + (新 − 舊)      投入變多 → 信封變多
 *   out : 剩餘 − (新 − 舊)      退還變多 → 信封變少
 *
 * **刪除就是「改成 0」**,算術上完全一樣(刪掉一筆投入 = 那筆投入沒發生過),
 * 所以刪除不需要自己的公式,呼叫端傳 0 進來即可。少一條路徑就少一個
 * 「只改了一邊」的機會。
 */
export function remainingAfter(m: PotMove, newAmountMinor: number): number {
  return remainingOf(m) + potEditDelta(m, newAmountMinor);
}

/**
 * 這次編輯讓剩餘**變動多少**。> 0 = 信封變多,< 0 = 信封變少。
 *
 *   in  : 新 − 舊      投入變多 → 信封變多
 *   out : −(新 − 舊)   退還變多 → 信封變少
 *
 * 抽出來是因為下面的 blocksPotEdit 要單獨問「方向」這件事,
 * 而它的 SQL 雙胞胎(兩支端點 WHERE 裡那段 CASE)也是獨立的一項。
 */
export function potEditDelta(m: PotMove, newAmountMinor: number): number {
  const delta = newAmountMinor - m.amount_minor;
  return m.direction === 'in' ? delta : -delta;
}

/**
 * 這次編輯該不該被擋下來。
 *
 * 判準是「**不可以讓剩餘變得更差**」,而不是「剩餘不可為負」。這個差別很重要:
 *
 * 公費**超支**(剩餘 < 0)是一個合法而且到得了的狀態 —— server 沒有任何一支
 * 端點擋「公費付掉的共同支出 > 投入」(expenses.post 只擋公費當個人花費付款人、
 * 以及公費出現在分攤名單),README 也明講那個差額是由當時付錢的人先墊著。
 *
 * 而「剩餘不可為負」這個判準一旦進到超支狀態就會把帳鎖死,擋掉的正好是
 * **唯一能把帳修回事實的那些編輯**:
 *
 *   投入記太少(漏記了一筆)→ 想改大 → 改完剩餘仍是負的 → 被擋
 *   誤記了一筆從沒發生的退還 → 想刪掉 → 刪完剩餘仍是負的 → 被擋
 *
 * 後者更硬:刪除 = 改成 0,而退還方向「改成 0」比任何正數都讓剩餘更大,
 * 所以刪除被擋的時候,沒有任何合法輸入動得了那一列 —— 它被永久凍結。
 * 而淨額現在含投入 / 退還(見 utils/ledger.ts),凍結的那一列等於在那個人
 * 身上掛一筆永遠拔不掉的假債務。
 *
 * 改成看**變化量**之後:
 *   剩餘 ≥ 0 時行為完全不變(after < 0 必然 < before,兩個判準等價)
 *   剩餘 < 0 時只擋「讓它更負」的方向,修正帳的方向一律放行
 *
 * ⚠️ 這條規則有一個 SQL 雙胞胎:兩支端點 WHERE 裡那段
 * `(CASE ...) >= 0 OR (三個 COALESCE 相減 + CASE) >= 0`。
 * 前半就是「變化量 ≥ 0」,後半就是「改完不是負的」。兩邊必須一起改。
 */
export function blocksPotEdit(m: PotMove, newAmountMinor: number): boolean {
  // 變化量 ≥ 0 = 這次編輯讓信封變多或不變 —— 永遠安全,即使現在是超支的。
  if (potEditDelta(m, newAmountMinor) >= 0) return false;
  // 讓信封變少:改完不可以是負的。
  return remainingAfter(m, newAmountMinor) < 0;
}

/** 找不到 / 不屬於這趟 / 不是公費金流 —— 一律同一句,不透露那個 id 存不存在。 */
export function potMoveNotFound() {
  return createError({ statusCode: 404, statusMessage: '找不到這筆公費金流' });
}

/**
 * 剩餘會變成負的 —— 這是「信封裡的錢比實際有的多」,一個沒有現實對應的狀態。
 *
 * 訊息一定要帶出數字**和可以怎麼辦**:使用者按下去的時候只知道自己要改成多少,
 * 不知道公費已經花掉多少。光說「不能這樣改」他會再試一次一樣的數字。
 * 所以把「現在剩多少」「改完會變多少」「最多/最少能改到多少」一起講完。
 *
 * @param next  想改成的金額。刪除傳 0(刪除 = 改成 0,見 remainingAfter)。
 */
export function potRemainingError(m: PotMove, next: number) {
  const remaining = remainingOf(m);
  const after = remainingAfter(m, next);
  /*
    可以改到哪裡。合法集合是「變化量 ≥ 0」和「改完剩餘 ≥ 0」的**聯集**
    (見 blocksPotEdit),所以邊界是兩者中比較寬鬆的那個:

      in  : next ≥ 舊金額 − 剩餘   或   next ≥ 舊金額
      out : next ≤ 舊金額 + 剩餘   或   next ≤ 舊金額

    剩餘 ≥ 0 時前者比較寬,邊界就是舊的那條算式(行為完全沒變);
    剩餘 < 0 時後者比較寬,邊界是舊金額本身。兩種情況合起來就是
    把算式裡的「剩餘」換成 max(剩餘, 0) —— 不是兩段 if。

    ⚠️ 超支時**一定要 clamp**。不 clamp 的話 in 方向會印出一個比舊金額還大的
    「最少只能改到」(照著填就是把一筆假的投入寫進帳裡,而投入現在直接進淨額,
    那筆錢會變成他真的可以跟別人收的錢),out 方向更會印出一個**負數**,
    而 patch 端點要求 amount_minor > 0 —— 訊息指的路根本走不通。
  */
  const headroom = Math.max(remaining, 0);
  const bound = m.direction === 'in' ? m.amount_minor - headroom : m.amount_minor + headroom;
  const what = m.direction === 'in' ? '投入' : '退還';

  /*
    ⚠️ 這幾個數字一定要 formatMoney,不能直接內插 amount_minor。
    整支 API 的金額都是最小單位整數,而 TWD 的 exponent 是 2 ——
    NT$1,000.01 存的是 100001,直接印出來是差 100 倍的另一個數字。
    而且前端(overview.vue)刻意把這句 statusMessage **原樣**顯示:
    這是使用者唯一能理解為什麼被擋的線索,而「最少只能改到 X」更是
    他要照著打的數字 —— 印錯的話他會照那個數字再送一次,然後再被擋一次。
  */
  const money = (minor: number) => formatMoney(minor, m.currency);
  const how = next === 0 ? '刪掉' : `改成 ${money(next)} `;

  // 超支狀態下被擋,講「剩餘不能是負的」會很奇怪 —— 它現在就是負的。
  // 那種情況被擋的理由是「這次改動會讓它**更**負」,訊息要照實說。
  const worse = remaining < 0;

  return createError({
    statusCode: 409,
    statusMessage: `把這筆 ${money(m.amount_minor)} 的${what}${how}之後,`
      + `${m.pot_name}的${m.currency}剩餘會變成 ${money(after)}(現在是 ${money(remaining)})。`
      + (worse
        ? `${m.pot_name}已經超支了(花掉 ${money(m.spent)}、投入只有 ${money(m.contributed)}),`
          + '這一步會讓缺口更大。'
          + (m.direction === 'in'
            ? `這筆只能往上改(最少 ${money(bound)})—— 要往下的話,請先確認公費的花費是不是記多了。`
            : `這筆只能往下改或直接刪掉(最多 ${money(bound)})。`)
        : '剩餘不能是負的 —— 那代表信封裡的錢比公費實際有的還多,'
          + `而${m.pot_name}已經花掉 ${money(m.spent)}、退還 ${money(m.refunded)}。`
          + (m.direction === 'in'
            ? `這筆最少只能改到 ${money(bound)}。要再往下的話,請先確認公費的花費或退還是不是也記錯了。`
            : `這筆最多只能改到 ${money(bound)}。`)),
  });
}
