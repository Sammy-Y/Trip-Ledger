/**
 * 錢包 —— 「我手上還剩多少現金」。issue #6
 *
 * ── 為什麼這件事需要一個自己的檔案 ──────────────────────────────
 *
 * 這是這個 repo 裡第三個「剩餘」:
 *
 *   淨額(utils/ledger.ts)   誰欠誰      → 結算用
 *   公費剩餘(utils/pot.ts)  信封裡多少  → 總覽的公費區塊用
 *   錢包剩餘(這裡)          我口袋多少  → 總覽的錢包區塊用
 *
 * 三個都是「還剩多少」,但問的是三件不同的事,任何一個混進另一個的算式裡
 * 都會算錯錢。所以每一個都只住在一個地方,而這裡是第三個的唯一來源
 * (定義寫在 remainingOf() 上,SQL 只負責把六個總和撈出來)。
 *
 * ── 這裡**不參與計價** ──────────────────────────────────────────
 *
 * 換匯匯率不會被拿去重算支出的台幣金額(記帳全部用日幣,不需要換算),
 * 不進 nets / transfers / 結算回合,也不碰公費的任何數字。
 * 唯一的出口是 balance.get.ts 的 `wallets` 欄位 ——
 * 「沒有任何換匯紀錄時所有現有數字完全不變」這條不變量就是靠這件事成立的。
 *
 * ── 為什麼查詢和公費那邊長得不一樣(沒有寫進 SQL 的併發前提)──────
 *
 * utils/pot.ts 的每一句 UPDATE / DELETE 都把「剩餘不可為負」寫進 WHERE,
 * 因為那個不變量一破,結算就會據此寫出一筆**憑空生出來的真實轉帳**。
 * 錢包剩餘沒有那個下游:負數只是「在當地 ATM 提過款還沒記」的提示,
 * 沒有任何人會因此被要求付錢。所以這裡**刻意不擋負數**,也不需要併發前提 ——
 * 加上去只會讓「補登昨天的支出」被莫名擋掉。
 */
import type { WalletCurrency, WalletSummary } from '../../shared/types';

/** 一個 (member, currency) 格子裡的六個總和。剩餘由它們算出來,不另外存。 */
interface Bucket {
  exchangedInMinor: number;
  costs: Map<string, number>;
  cashSpentMinor: number;
  potContributedMinor: number;
  repaidOutMinor: number;
  receivedInMinor: number;
  exchangedOutMinor: number;
}

const emptyBucket = (): Bucket => ({
  exchangedInMinor: 0,
  costs: new Map(),
  cashSpentMinor: 0,
  potContributedMinor: 0,
  repaidOutMinor: 0,
  receivedInMinor: 0,
  exchangedOutMinor: 0,
});

/**
 * **錢包剩餘的定義,整個 codebase 只有這一份。**
 *
 *   剩餘 = 換到的 − 離手的 + 收到的
 *
 * 「離手的」是四種從他手上出去的現金,四種都要算:
 *   · 自己付現的支出        —— 錢直接給了店家
 *   · 投入公費的            —— 這也是支出,錢確實離開了他手上
 *   · 付出去的還款          —— 還給別人的
 *   · 拿這個幣別再去換別的  —— 換回台幣、當地 ATM 提款都是這一種
 *
 * 最後那一項容易漏,而漏掉的症狀正好是這個功能最不能出的錯:
 * 把剩下的日幣換回台幣之後,錢包還說你手上有 ¥6,800。
 */
const remainingOf = (b: Bucket) =>
  b.exchangedInMinor
  - b.cashSpentMinor
  - b.potContributedMinor
  - b.repaidOutMinor
  - b.exchangedOutMinor
  + b.receivedInMinor;

type Row = { member_id: string; currency: string; amt: number };

/**
 * 每人一塊錢包,逐幣別分開。
 *
 * ── 哪些 (人, 幣別) 會長出一個錢包 ─────────────────────────────
 *
 * 兩個條件同時成立:**他換到過那個幣別**,而且**那個幣別不是本位幣**。
 *
 * 第一個條件很直觀:沒換過就沒有東西可以追蹤。
 *
 * 第二個條件是實測出來的。「錢包」問的是**口袋裡的外幣現金**還剩多少;
 * 本位幣(台幣)不是那種東西 —— 它在銀行帳戶裡,而帳戶餘額這個 app 看不到。
 * 硬給它一塊錢包的話,離手那一邊會變成胡說:
 *
 *   把剩下的 ¥1,000 換回 NT$200 → 台幣錢包「換到 NT$200」
 *   而出發前買日幣付掉的 NT$3,100 也是「台幣離手」
 *   → 剩餘 = 200 − 3,100 = **−2,900**,畫面跳出「花掉的比換到的多」
 *
 * 而事實上什麼問題都沒有:那 3,100 是從銀行帳戶出去的,不是從他口袋裡
 * 那 200 塊現金出去的。資料上分不出這兩種台幣,所以正確的做法是
 * **不要假裝分得出來** —— 本位幣不開錢包。
 *
 * 這樣「換回台幣」仍然被正確記錄:它會從**日幣**錢包扣掉那 ¥1,000
 * (見 exchangedOutMinor),而那才是這件事真正要影響的數字。
 *
 * 公費(is_pot = 1)一律排除:公費不需要匯率,它的剩餘是另一個概念
 * (utils/pot.ts)。先記了換匯、之後才被標成公費的成員,錢包會消失 ——
 * 那是對的,兩個「剩餘」不該同時掛在同一個實體上。
 *
 * @param baseCurrency 旅程的本位幣。這個幣別**不會**有錢包(理由見上)。
 */
export async function walletSummaries(
  dbh: D1Database,
  tripId: string,
  baseCurrency: string,
): Promise<WalletSummary[]> {
  const [exIn, exOut, cash, potIn, repaid, received] = await Promise.all([
    // ① 換到的。**只有這一句可以開出新的錢包格子**,所以「不是本位幣」
    //    這個條件寫在這裡就夠了 —— 下面五句往不存在的格子裡加會被丟掉。
    //
    //    cost_currency 一起 GROUP BY —— 加權平均匯率要用付出那一邊的總和,
    //    而「付出的幣別」理論上可以有多種(實務上只有台幣),不在這裡假設。
    dbh.prepare(
      `SELECT f.member_id, m.name AS member_name, f.currency, f.cost_currency,
              SUM(f.amount_minor) AS amt, SUM(f.cost_minor) AS cost
       FROM fx_exchanges f
       JOIN members m ON m.id = f.member_id AND m.trip_id = f.trip_id AND m.is_pot = 0
       WHERE f.trip_id = ?1 AND f.currency <> ?2
       GROUP BY f.member_id, m.name, f.currency, f.cost_currency`,
    ).bind(tripId, baseCurrency).all<{
      member_id: string; member_name: string;
      currency: string; cost_currency: string; amt: number; cost: number;
    }>(),

    // ② 換出:拿某個幣別的現金去換別的。對那個幣別來說這是離手。
    dbh.prepare(
      `SELECT f.member_id, f.cost_currency AS currency, SUM(f.cost_minor) AS amt
       FROM fx_exchanges f
       JOIN members m ON m.id = f.member_id AND m.trip_id = f.trip_id AND m.is_pot = 0
       WHERE f.trip_id = ?
       GROUP BY f.member_id, f.cost_currency`,
    ).bind(tripId).all<Row>(),

    // ③ 自己付現的支出。
    //
    //    ⚠️ **不濾 kind。** 個人花費付的現金一樣離開了他的口袋 ——
    //    這裡問的是「口袋裡還剩多少」,不是「這趟該分攤多少」。
    //    (那個問題由 balance.get.ts 的 per_member 回答,兩者刻意不同。)
    //
    //    ⚠️ 只算 cash。刷卡的錢從來沒有變成他手上的現金,
    //    算進來的話錢包會憑空少掉一整筆。
    dbh.prepare(
      `SELECT p.member_id, e.currency, SUM(p.amount_minor) AS amt
       FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.trip_id = ? AND e.payment_method = 'cash'
       GROUP BY p.member_id, e.currency`,
    ).bind(tripId).all<Row>(),

    // ④ 投入公費。JOIN 而不是先查 pot id:沒有公費的旅程自然撈不到列,
    //    不必在 JS 裡多一條 potId == null 的分支(那條分支正是
    //    `to_member <> NULL` 靜靜回傳零列的地方)。
    dbh.prepare(
      `SELECT s.from_member AS member_id, s.currency, SUM(s.amount_minor) AS amt
       FROM settlements s
       JOIN members p ON p.trip_id = s.trip_id AND p.is_pot = 1 AND p.id = s.to_member
       WHERE s.trip_id = ?
       GROUP BY s.from_member, s.currency`,
    ).bind(tripId).all<Row>(),

    // ⑤ 付出去的還款(對方不是公費)。
    //    ④ + ⑤ 剛好是「所有 from_member = 他」的 settlements,不重不漏。
    //
    //    ⚠️ **不濾 source。** 結算回合寫下來的轉帳也是真的付出去的錢
    //    (定義同 balance.get.ts 的 potSummary)。濾掉的話,結算之後
    //    錢包會顯示他手上還有那筆已經付掉的現金。
    dbh.prepare(
      `SELECT s.from_member AS member_id, s.currency, SUM(s.amount_minor) AS amt
       FROM settlements s
       WHERE s.trip_id = ?
         AND NOT EXISTS (SELECT 1 FROM members p
                          WHERE p.trip_id = s.trip_id AND p.is_pot = 1
                            AND p.id = s.to_member)
       GROUP BY s.from_member, s.currency`,
    ).bind(tripId).all<Row>(),

    // ⑥ 收到的:別人還的錢 + 公費退還。不分對方是誰 —— 兩種都真的進了口袋。
    dbh.prepare(
      `SELECT s.to_member AS member_id, s.currency, SUM(s.amount_minor) AS amt
       FROM settlements s
       WHERE s.trip_id = ?
       GROUP BY s.to_member, s.currency`,
    ).bind(tripId).all<Row>(),
  ]);

  const inRows = exIn.results ?? [];
  // 一筆(外幣的)換匯都沒有 → 一塊錢包都沒有。**這就是回歸保護那條不變量**:
  // 這個功能上線前的旅程走到這裡就回空陣列,其餘五個總和一個都不會被用到。
  if (!inRows.length) return [];

  /** member_id -> currency -> Bucket。只有 ① 可以開新格子(理由見函式說明)。 */
  const wallets = new Map<string, { name: string; byCurrency: Map<string, Bucket> }>();

  for (const r of inRows) {
    const w = wallets.get(r.member_id)
      ?? { name: r.member_name, byCurrency: new Map<string, Bucket>() };
    const b = w.byCurrency.get(r.currency) ?? emptyBucket();
    b.exchangedInMinor += r.amt;
    b.costs.set(r.cost_currency, (b.costs.get(r.cost_currency) ?? 0) + r.cost);
    w.byCurrency.set(r.currency, b);
    wallets.set(r.member_id, w);
  }

  /** 只往**已經存在**的格子裡加。找不到就丟掉 —— 不會憑空開出一塊錢包。 */
  const addTo = (rows: Row[], key: Exclude<keyof Bucket, 'costs'>) => {
    for (const r of rows) {
      const b = wallets.get(r.member_id)?.byCurrency.get(r.currency);
      if (b) b[key] += r.amt;
    }
  };
  addTo(exOut.results ?? [], 'exchangedOutMinor');
  addTo(cash.results ?? [], 'cashSpentMinor');
  addTo(potIn.results ?? [], 'potContributedMinor');
  addTo(repaid.results ?? [], 'repaidOutMinor');
  addTo(received.results ?? [], 'receivedInMinor');

  return [...wallets.entries()]
    .map(([memberId, w]) => ({
      memberId,
      name: w.name,
      by_currency: [...w.byCurrency.entries()]
        // 幣別按代碼排 —— 金額排序在跨幣別之間沒有意義(同 overview 的 totals)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, b]): WalletCurrency => ({
          currency,
          exchangedInMinor: b.exchangedInMinor,
          costs: [...b.costs.entries()]
            .sort(([a], [b2]) => a.localeCompare(b2))
            .map(([cur, amountMinor]) => ({ currency: cur, amountMinor })),
          cashSpentMinor: b.cashSpentMinor,
          potContributedMinor: b.potContributedMinor,
          repaidOutMinor: b.repaidOutMinor,
          receivedInMinor: b.receivedInMinor,
          exchangedOutMinor: b.exchangedOutMinor,
          remainingMinor: remainingOf(b),
        })),
    }))
    // 成員按名字排,和 GET /api/trips/:trip 的 members 一致,畫面上下對得起來
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}
