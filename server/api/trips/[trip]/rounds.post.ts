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
 * 公費完全不進結算的算術(見 utils/ledger.ts 開頭:兩本分開的帳),
 * 所以 deferred 今天**恆為空** —— 這兩個欄位留著當防線:萬一哪天公費
 * 重新進了淨額,它的腿會落進 deferred 而不是被寫成真的轉帳
 * (那等於第一晚就把信封清空,而那筆錢明天還要用)。
 * 投入與退還一律走總覽頁,那一按才代表現金真的換了手。
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
  const [ledger, unbalanced, itemRows, seqRow, fpRow, fpExp] = await Promise.all([
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
    // 這個幣別目前的還款狀態。寫入時會再核對一次 —— 見下面的樂觀鎖說明。
    dbh.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total
       FROM settlements WHERE trip_id = ? AND currency = ?`,
    ).bind(trip.id, currency).first<{ n: number; total: number }>(),
    // 支出內容的指紋:未結總額,加上付款/分攤兩張子表的加權校驗和。
    // 同樣是寫入時再核對一次 —— 見下面的樂觀鎖說明。
    //
    // ⚠️ 子表**不能直接加總**。付款合計與分攤合計恆等於支出金額
    // (寫入時驗過,findUnbalancedExpenses 也再驗一次),所以兩個加總永遠是
    // 同一個數字,看不到「同一筆錢在人之間搬家」——「三人均分改成一個人吃下」
    // 一分錢都沒動,卻會把每個人的淨額整個換掉。所以要乘上一個跟人有關的權重。
    //
    // 權重是 n(1000n + 1),n = 成員在這趟裡的名次(照 id 排,穩定且不必外傳)。
    // 為什麼不是單純的 n:純線性權重的盲區剛好就是最常見的那種改法 ——
    // 三人均分改成中間那個人全吃,差量是 (1, −2, 1) 的倍數,加權後剛好抵銷,
    // 指紋一模一樣。補上二次項之後,三個人要撞上就得讓差量剛好是
    // (5001, −8002, 3001) 的倍數(NT$50.01 / −NT$80.02 / NT$30.01)—— 手改改不出來。
    // 權重上限很小(十個人也才十萬),乘上金額仍遠在 2^53 以內 ——
    // 這很重要,因為這個值要原封不動經過 JS 再送回 SQL 比對,精度掉了就會誤擋。
    //
    // 範圍是這個幣別的**全部**共同支出、不限未結的那些,因為回合的算術
    // 本來就是整趟(見 utils/ledger.ts:算術範圍 vs 明細範圍)。
    // 只改描述、改分類不會動到這兩張子表 → 指紋不變 → 不會誤擋。
    dbh.prepare(
      `SELECT
         (SELECT COALESCE(SUM(amount_minor), 0) FROM expenses
           WHERE trip_id = ?1 AND kind = 'shared' AND currency = ?2
             AND settlement_round_id IS NULL) AS unsettled_total,
         (SELECT COALESCE(SUM(p.amount_minor * r.n * (1000 * r.n + 1)), 0)
          FROM expense_payers p
          JOIN expenses e ON e.id = p.expense_id
          JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n
                FROM members WHERE trip_id = ?1) r ON r.id = p.member_id
          WHERE e.trip_id = ?1 AND e.kind = 'shared' AND e.currency = ?2) AS paid_fp,
         (SELECT COALESCE(SUM(s.amount_minor * r.n * (1000 * r.n + 1)), 0)
          FROM expense_shares s
          JOIN expenses e ON e.id = s.expense_id
          JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n
                FROM members WHERE trip_id = ?1) r ON r.id = s.member_id
          WHERE e.trip_id = ?1 AND e.kind = 'shared' AND e.currency = ?2) AS owed_fp`,
    ).bind(trip.id, currency)
      .first<{ unsettled_total: number; paid_fp: number; owed_fp: number }>(),
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
    /**
     * ── 樂觀鎖:把「讀到的狀態」變成資料庫層的寫入前提 ──────────
     *
     * 上面那些檢查都是「讀完再判斷」,而寫入是另一次往返 ——
     * 中間那個空窗期什麼都可能發生。實測過的災難:
     *
     *   點「結算」→ 3ms 後點「標記已還款」→ 兩支都回 201
     *   → 1,500 的債被記了 3,000,然後 App 開始叫收錢的人反過來付 1,500 回去。
     *   (localhost 空窗約 15ms;Workers 打遠端 D1 讀取要 4 次往返,
     *    空窗是幾十到幾百毫秒 —— 網路慢的時候手殘點兩下就中。)
     *
     * body 的 `expect` 指紋擋不住,因為它是拿**同一份過期的讀取**去比對。
     *
     * 所以這裡把前提寫進 SQL 本身:INSERT ... SELECT ... WHERE <前提>。
     * 前提不成立就插不進這一列,而後面的 nets / settlements / UPDATE 都
     * 外鍵指向這個 round_id → FOREIGN KEY constraint failed → **整個 batch 回滾**。
     * (D1 的 batch 是單一交易,而且 D1 預設開啟外鍵 —— 兩件事都實測確認過。)
     *
     * 前提包含六件事:未結明細筆數、這個幣別的還款筆數、還款總額,
     * 以及支出內容的三個指紋(未結總額 + 付款/分攤兩張子表的加權校驗和)。
     * 加還款總額是因為筆數相同但金額不同也會讓算術結果不一樣。
     *
     * ── 「還款筆數 / 還款總額」要不要排掉投入 / 退還? ──
     *
     * **不要,照舊全部數。** 投入 / 退還不進淨額(見 utils/ledger.ts 開頭),
     * 所以有人在空窗期投入公費並不會改變這個回合要寫的轉帳金額。
     * 但指紋的職責不是重現淨額,是回答「我讀完到我寫入之間,這個幣別的帳有沒有變」——
     * 而投入 / 退還**確實把帳改了**:總覽的剩餘動了,結算頁那一行公費現況也跟著動。
     * 使用者看到的畫面變了。
     *
     * 把它們濾掉的唯一好處是「別人正在投入公費時我還能關回合」,代價是
     * 這句 SQL 要多帶 pot id 去比對兩端 —— 買到的是把鎖弄鬆,而且多一個縫。
     * 所以維持現狀:偏保守的一側。
     *
     * 而**內容指紋是給編輯支出用的**(PATCH expenses/[id])。前三個量它一個都不動:
     * 改金額不改 kind 也不改 currency → 未結筆數還是一樣;settlements 一列都沒碰
     * → 筆數與總額也一樣。於是「A 打開預覽 → B 把 ¥10,000 改成 ¥20,000 → A 按下結算」
     * 三個前提全部成立,回合照樣成立:快照寫的是 ¥10,000 那一版的淨額、
     * 轉帳照著它付出去,而 E 已經蓋章 —— 不撤銷就修不了。
     * (下一回合的算術會自己補回差額,錢不會永久消失,但這一輪照錯數字付出去的現金補不回來。)
     * POST 會讓未結筆數 +1、DELETE 會讓它 −1,兩者都撞得到前三個量;
     * PATCH 是第一個「改錢卻不改任何筆數」的操作,所以指紋必須看得到支出內容本身。
     *
     * 成員名單本身也在指紋裡(名次來自 members)—— 併發新增/刪除成員也會擋下來。
     * 那是保守的一側:成員動了,淨額該算給誰本來就要重看一次。
     */
    dbh.prepare(
      `INSERT INTO settlement_rounds (id, trip_id, currency, seq, label, note)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE (SELECT COUNT(*) FROM expenses
               WHERE trip_id = ?2 AND kind = 'shared' AND currency = ?3
                 AND settlement_round_id IS NULL) = ?7
         AND (SELECT COUNT(*) FROM settlements
               WHERE trip_id = ?2 AND currency = ?3) = ?8
         AND (SELECT COALESCE(SUM(amount_minor), 0) FROM settlements
               WHERE trip_id = ?2 AND currency = ?3) = ?9
         AND (SELECT COALESCE(SUM(amount_minor), 0) FROM expenses
               WHERE trip_id = ?2 AND kind = 'shared' AND currency = ?3
                 AND settlement_round_id IS NULL) = ?10
         AND (SELECT COALESCE(SUM(p.amount_minor * r.n * (1000 * r.n + 1)), 0)
              FROM expense_payers p
              JOIN expenses e ON e.id = p.expense_id
              JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n
                    FROM members WHERE trip_id = ?2) r ON r.id = p.member_id
              WHERE e.trip_id = ?2 AND e.kind = 'shared' AND e.currency = ?3) = ?11
         AND (SELECT COALESCE(SUM(s.amount_minor * r.n * (1000 * r.n + 1)), 0)
              FROM expense_shares s
              JOIN expenses e ON e.id = s.expense_id
              JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n
                    FROM members WHERE trip_id = ?2) r ON r.id = s.member_id
              WHERE e.trip_id = ?2 AND e.kind = 'shared' AND e.currency = ?3) = ?12`,
    ).bind(
      roundId, trip.id, currency, seq, b.label?.trim() || null, b.note?.trim() || null,
      itemCount, fpRow?.n ?? 0, fpRow?.total ?? 0,
      fpExp?.unsettled_total ?? 0, fpExp?.paid_fp ?? 0, fpExp?.owed_fp ?? 0,
    ),

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

  let stamped = itemCount;
  try {
    const results = await dbh.batch(stmts);
    // 蓋章的筆數用 UPDATE 真正改到的列數,而不是上面那個事前 COUNT ——
    // 預覽之後才新增的那筆也會被蓋到,回報事前的數字就是明知故錯。
    const changes = results[results.length - 1]?.meta?.changes;
    if (typeof changes === 'number') stamped = changes;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // FOREIGN KEY = 上面的樂觀鎖前提不成立 → round 那一列沒插進去 → 整批回滾。
    if (/FOREIGN\s*KEY/i.test(msg)) {
      throw createError({
        statusCode: 409,
        statusMessage: '這個幣別的帳在你按下結算的這一瞬間被改動了'
          + '(有人記了一筆帳、改了某一筆、或標記了還款)。什麼都沒有寫入,請重新整理再結算。',
      });
    }
    // UNIQUE(trip_id, currency, seq) 撞到 = 另一支手機剛剛結完同一輪
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
    item_count: stamped,
    recorded,
    deferred: block.deferred,
    nets: block.nets,
  };
});
