import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';
import { tripLedger, assertZeroSum, findUnbalancedExpenses } from '../../../utils/ledger';

/**
 * 關閉一次結算回合 —— 「今晚的帳結掉」。
 *
 * 做四件事,全部在同一個 dbh.batch() 裡(要嘛全部成功,要嘛什麼都沒發生):
 *   1. 建立 settlement_rounds 一列(帶 seq = 這個幣別的第幾次)
 *   2. 把當下每個人的淨額快照進 settlement_round_nets(明細要能回答「怎麼算的」)
 *   3. 把 recorded 轉帳寫成 settlements(source='round', round_id=這一回合)
 *   4. 把還沒標記的共同支出蓋上 settlement_round_id
 *
 * ── 三個刻意的決定 ──────────────────────────────────────────
 *
 * **只寫 recorded,不寫 deferred。** deferred 是任一端為公費的轉帳。
 * 第一天晚上公費淨額 = −(手上剩的現金),照著寫下去等於把公費清空退還,
 * 而那筆錢明天還要用。公費的結算在旅程結束用「退還」處理。
 *
 * **關閉回合等於宣告「這些錢已經付了」**(單階段,沒有 paid_at)。
 * 兩階段(先產生待付清單、之後逐筆勾)會讓同一筆債同時出現在回合裡
 * 和結算頁的「標記已還款」按鈕旁,而兩邊都沒有 idempotency ——
 * 點兩次就會在 1,500 的債上記下 3,000,然後帳本開始要求反向轉帳。
 * 想要「部分付款」的話,正確做法是不要關回合,先用結算頁逐筆標記已還款,
 * 下次預覽會自動只剩沒付的那些。
 *
 * **寫錢之前先自己證明輸入是零和的。** minCashFlow 對非零和輸入
 * 不會拋錯,只會靜靜回傳不完整的清單(settle.ts 的 break)——
 * 那會變成「畫面顯示已結清,但有一筆錢無聲消失」。所以這裡擋在前面。
 */
type Body = {
  currency: string;
  label?: string;
  note?: string;
  /**
   * 預覽時看到的指紋:{ item_count, recorded_count }。
   * 給了就會在寫入前重新核對 —— 兩個人同時操作時,
   * 避免照著舊畫面關掉一個內容已經變了的回合。
   */
  expect?: { item_count?: number; recorded_count?: number };
};

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const b = await readBody<Body>(event);

  const currency = b?.currency?.trim();
  if (!currency) throw createError({ statusCode: 400, statusMessage: '缺少幣別(一個回合只結一個幣別)' });

  const known = await dbh.prepare(`SELECT code FROM currencies WHERE code = ?`)
    .bind(currency).first<{ code: string }>();
  if (!known) throw createError({ statusCode: 400, statusMessage: `不支援的幣別 ${currency}` });

  // ── 寫錢之前的所有檢查 ──────────────────────────────────────
  const [ledger, unbalanced, itemRows, seqRow] = await Promise.all([
    tripLedger(dbh, trip.id, currency),
    findUnbalancedExpenses(dbh, trip.id, currency),
    dbh.prepare(
      `SELECT COUNT(*) AS n FROM expenses
       WHERE trip_id = ? AND kind = 'shared' AND currency = ? AND settlement_round_id IS NULL`,
    ).bind(trip.id, currency).first<{ n: number }>(),
    dbh.prepare(
      `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM settlement_rounds
       WHERE trip_id = ? AND currency = ?`,
    ).bind(trip.id, currency).first<{ max_seq: number }>(),
  ]);

  if (unbalanced.length) {
    throw createError({
      statusCode: 409,
      statusMessage: `有 ${unbalanced.length} 筆支出的付款與分攤金額對不上`
        + `(${unbalanced.slice(0, 3).map((u) => u.description).join('、')})。`
        + '修好之後才能結算 —— 現在結算會寫入錯誤的金額。',
    });
  }

  const block = ledger.byCurrency[currency];
  const itemCount = itemRows?.n ?? 0;
  const recorded = block?.recorded ?? [];

  if (!block || (itemCount === 0 && recorded.length === 0)) {
    throw createError({
      statusCode: 409,
      statusMessage: '沒有需要結算的東西 —— 沒有新的未結明細,也沒有待轉帳。',
    });
  }

  const zeroSumProblem = assertZeroSum(block);
  if (zeroSumProblem) throw createError({ statusCode: 409, statusMessage: zeroSumProblem });

  // 併發:照著舊畫面按下結算的話擋掉,叫他重新看一次
  if (b.expect) {
    if (typeof b.expect.item_count === 'number' && b.expect.item_count !== itemCount) {
      throw createError({
        statusCode: 409,
        statusMessage: `明細筆數已經變了(你看到 ${b.expect.item_count} 筆,現在是 ${itemCount} 筆)。請重新整理再結算。`,
      });
    }
    if (typeof b.expect.recorded_count === 'number' && b.expect.recorded_count !== recorded.length) {
      throw createError({
        statusCode: 409,
        statusMessage: '轉帳建議已經變了(可能有人剛記了一筆帳)。請重新整理再結算。',
      });
    }
  }

  for (const t of recorded) {
    if (!Number.isInteger(t.amountMinor) || t.amountMinor <= 0) {
      throw createError({ statusCode: 500, statusMessage: '算出非法的轉帳金額,已中止' });
    }
  }

  // ── 寫入 ────────────────────────────────────────────────────
  const roundId = uid();
  const seq = (seqRow?.max_seq ?? 0) + 1;

  const stmts = [
    dbh.prepare(
      `INSERT INTO settlement_rounds (id, trip_id, currency, seq, label, note)
       VALUES (?,?,?,?,?,?)`,
    ).bind(roundId, trip.id, currency, seq, b.label?.trim() || null, b.note?.trim() || null),

    // 淨額快照(含公費)。之後資料變了也還原得出當時是照什麼數字付的。
    ...block.nets.map((n) =>
      dbh.prepare(
        `INSERT INTO settlement_round_nets (round_id, member_id, net_minor) VALUES (?,?,?)`,
      ).bind(roundId, n.memberId, n.netMinor)),

    // 只寫 recorded。source='round' 讓撤銷時分得出哪些可以刪。
    ...recorded.map((t) =>
      dbh.prepare(
        `INSERT INTO settlements
           (id, trip_id, from_member, to_member, currency, amount_minor, round_id, source, note)
         VALUES (?,?,?,?,?,?,?,'round',?)`,
      ).bind(uid(), trip.id, t.from, t.to, currency, t.amountMinor, roundId,
        `第 ${seq} 次結算`)),

    // 蓋章。一句靜態的集合條件,不需要 IN (?,?,?) ——
    // 預覽之後才新增的那筆也會被蓋到,它仍然會進下一回合的算術,不會掉錢。
    dbh.prepare(
      `UPDATE expenses SET settlement_round_id = ?1
       WHERE trip_id = ?2 AND kind = 'shared' AND currency = ?3 AND settlement_round_id IS NULL`,
    ).bind(roundId, trip.id, currency),
  ];

  try {
    await dbh.batch(stmts);
  } catch (e) {
    // UNIQUE(trip_id, currency, seq) 撞到 = 另一支手機剛剛結完同一輪
    const msg = String((e as Error)?.message ?? e);
    if (/UNIQUE|constraint/i.test(msg)) {
      throw createError({
        statusCode: 409,
        statusMessage: '剛剛已經有人結算過這個幣別了。請重新整理看最新狀態。',
      });
    }
    throw e;
  }

  setResponseStatus(event, 201);
  return {
    id: roundId,
    currency,
    seq,
    item_count: itemCount,
    recorded,
    deferred: block.deferred,
    nets: block.nets,
  };
});
