import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';
import { tripLedger, assertZeroSum, findUnbalancedExpenses } from '../../../../utils/ledger';

/**
 * 結算預覽 —— 「這一輪要結什麼、結果是誰給誰多少」。
 *
 * 回傳兩種東西,對應兩個**不同的範圍**(這個區別是整個功能的核心,見 utils/ledger.ts):
 *
 *   items      還沒列入任何回合的共同支出 → 這是「明細」,使用者要看的那份清單
 *   nets/轉帳  整趟到現在的算術結果        → 這是「結果」,誰要給誰多少錢
 *
 * 所以明細列的是今天新增的那幾筆,而金額是把整趟算進來之後的淨額 ——
 * 因為只算子集會重複要錢(理由在 ledger.ts 有完整說明)。
 *
 * ?currency=JPY 只看一個幣別;不給就每個幣別各一塊。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);

  const raw = getQuery(event).currency;
  const currency = typeof raw === 'string' && raw ? raw : null;

  const [ledger, items, seqRows, unbalanced] = await Promise.all([
    tripLedger(dbh, trip.id, currency),
    unsettledItems(dbh, trip.id, currency),
    dbh.prepare(
      `SELECT currency, MAX(seq) AS max_seq FROM settlement_rounds
       WHERE trip_id = ?1 AND (?2 IS NULL OR currency = ?2)
       GROUP BY currency`,
    ).bind(trip.id, currency).all<{ currency: string; max_seq: number }>(),
    findUnbalancedExpenses(dbh, trip.id, currency),
  ]);

  const nextSeq = new Map((seqRows.results ?? []).map((r) => [r.currency, (r.max_seq ?? 0) + 1]));

  // 幣別集合要把「有未結明細」的幣別也算進來 —— 理論上 ledger 已經涵蓋,
  // 但明細與算術是兩個查詢,寧可取聯集也不要少一塊。
  const codes = [...new Set([...ledger.currencies, ...items.map((i) => i.currency)])].sort();

  const blocks = codes.map((cur) => {
    const block = ledger.byCurrency[cur];
    const mine = items.filter((i) => i.currency === cur);
    const zeroSumProblem = block ? assertZeroSum(block) : null;
    // **只看這個幣別自己的問題。** 日幣有一筆對不上,不該把台幣的結算按鈕
    // 一起鎖死 —— 而且 POST /rounds 是逐幣別檢查的,兩邊不一致的話
    // 畫面說不能結算、API 卻回 201。
    const unbalancedHere = unbalanced.filter((u) => u.currency === cur);

    return {
      currency: cur,
      seq: nextSeq.get(cur) ?? 1,
      /** 明細:還沒列入任何回合的共同支出 */
      items: mine,
      item_count: mine.length,
      /**
       * 整趟淨額(含公費),加起來必為 0。
       * 含投入公費 / 公費退還 —— 公費那一列的值 = −公費剩餘(見 utils/ledger.ts)。
       */
      nets: block?.nets ?? [],
      /** 真的要記下來的轉帳:兩端都不是公費 */
      recorded: block?.recorded ?? [],
      /** 公費的腿:「結束時退還 / 還要補多少」的唯讀顯示。投入 / 退還都在總覽頁做 */
      deferred: block?.deferred ?? [],
      /** 帳目不平衡時不准結算 —— 寧可擋住也不要寫錯的金額 */
      blocked_reason: zeroSumProblem
        ?? (unbalancedHere.length
          ? `有 ${unbalancedHere.length} 筆支出的付款與分攤金額對不上`
            + `(${unbalancedHere.slice(0, 3).map((u) => u.description).join('、')})`
            + ',結算已中止。'
          : null),
      /** 是哪幾筆對不上 —— 光說「有 1 筆」使用者找不到,等於死路 */
      unbalanced: unbalancedHere.map((u) => ({
        id: u.id, description: u.description, paid_minor: u.paid, owed_minor: u.owed,
      })),
    };
  });

  return {
    pot_id: ledger.potId,
    currencies: codes,
    blocks,
    /** 完全沒有未結明細、也沒有待轉帳,就是全部結清了 */
    all_settled: blocks.every((b) => b.item_count === 0 && b.recorded.length === 0),
  };
});

/**
 * 還沒列入任何回合的共同支出,含付款人與分攤明細。
 *
 * payers / shares 整批撈出來再在記憶體組裝 —— D1 每個 statement 都是一次往返,
 * 逐筆查在幾十筆支出上就會很有感(和 expenses.get.ts 同一套做法)。
 */
async function unsettledItems(dbh: D1Database, tripId: string, currency: string | null) {
  type Row = {
    id: string; description: string; category: string | null; currency: string;
    amount_minor: number; payment_method: string; spent_at: string; note: string | null;
    created_at: string;
  };
  type Line = { expense_id: string; member_id: string; amount_minor: number };

  const [expenses, payers, shares] = await Promise.all([
    dbh.prepare(
      `SELECT e.id, e.description, e.category, e.currency, e.amount_minor,
              e.payment_method, e.spent_at, e.note, e.created_at
       FROM expenses e
       WHERE e.trip_id = ?1 AND e.kind = 'shared' AND e.settlement_round_id IS NULL
         AND (?2 IS NULL OR e.currency = ?2)
       ORDER BY e.spent_at ASC, e.created_at ASC`,
    ).bind(tripId, currency).all<Row>(),
    dbh.prepare(
      `SELECT p.expense_id, p.member_id, p.amount_minor
       FROM expense_payers p JOIN expenses e ON e.id = p.expense_id
       WHERE e.trip_id = ?1 AND e.kind = 'shared' AND e.settlement_round_id IS NULL
         AND (?2 IS NULL OR e.currency = ?2)`,
    ).bind(tripId, currency).all<Line>(),
    dbh.prepare(
      `SELECT s.expense_id, s.member_id, s.amount_minor
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
       WHERE e.trip_id = ?1 AND e.kind = 'shared' AND e.settlement_round_id IS NULL
         AND (?2 IS NULL OR e.currency = ?2)`,
    ).bind(tripId, currency).all<Line>(),
  ]);

  const group = (rows: Line[]) => {
    const m = new Map<string, Array<{ member_id: string; amount_minor: number }>>();
    for (const r of rows) {
      const item = { member_id: r.member_id, amount_minor: r.amount_minor };
      const list = m.get(r.expense_id);
      if (list) list.push(item);
      else m.set(r.expense_id, [item]);
    }
    return m;
  };

  const byPayer = group(payers.results ?? []);
  const byShare = group(shares.results ?? []);

  return (expenses.results ?? []).map((e) => ({
    ...e,
    payers: byPayer.get(e.id) ?? [],
    shares: byShare.get(e.id) ?? [],
  }));
}
