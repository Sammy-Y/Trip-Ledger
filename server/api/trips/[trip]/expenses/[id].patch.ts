import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';
import { rateOn } from '../../../../utils/fx';
import { toMinor, formatMoney } from '../../../../utils/money';
import { splitEqually, splitByShares } from '../../../../utils/settle';

/**
 * 編輯支出。
 *
 * ── 為什麼需要這支 ────────────────────────────────────────────
 * 打錯字、金額多按一個零、日期記成隔天 —— 這些是記帳時最常發生的事,
 * 而在這支之前唯一的修法是「刪掉重記」。那個代價不只是麻煩:
 * 重記會拿到新的 created_at,支出列表的排序會整個跳掉,
 * 而使用者只是想把「宇治」改成「宇治抹茶」。
 *
 * ── 語意:整筆取代,不是部分更新 ──────────────────────────────
 * body 和 POST expenses **完全一樣**,收到什麼就是那筆支出的全貌;
 * expense_payers / expense_shares 先刪光再重寫,不做 diff。
 *
 * 理由是分攤模式本身可以整個換掉(equal → exact),
 * diff 要處理「這個人原本在名單裡現在不在了」「模式換了所以每個人的
 * 金額都變了」這些情況,複雜度遠高於重寫,而重寫還天然保證了守恆 ——
 * 寫進去的那批列就是剛剛驗過合計的那一批,中間沒有任何殘留。
 *
 * 所以驗證邏輯和 POST 是同一套,一行都沒有放寬:
 * 編輯是另一條寫入路徑,漏掉哪一條驗證,那條就等於不存在。
 *
 * ── 原子性 ────────────────────────────────────────────────────
 * UPDATE expenses + DELETE payers/shares + INSERT payers/shares
 * 全部塞進同一個 dbh.batch()(D1 的 batch 是單一交易)。
 * 中途失敗留下「支出還在、分攤空了」的話,那筆帳會被
 * findUnbalancedExpenses 判成付款與分攤對不上 —— 更糟的是在被發現以前,
 * 結算算出來的每個人淨額都是錯的,而畫面上完全看不出來。
 */
type Body = {
  kind: 'shared' | 'personal';
  description: string;
  category?: string;
  currency: string;
  amount: number;
  payment_method?: 'cash' | 'card';
  spent_at: string;
  note?: string;
  fx_rate_override?: number;
  /** 換匯加成(%)。不給就用 runtimeConfig 的預設(刷卡手續費 / 現金價差)。 */
  fx_markup_pct?: number;
  payers: Array<{ member_id: string; amount?: number }>;
  split:
    | { mode: 'equal'; members: string[] }
    | { mode: 'shares'; shares: Record<string, number> }
    | { mode: 'exact'; amounts: Record<string, number> };
};

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const b = await readBody<Body>(event);
  const cfg = useRuntimeConfig(event);

  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' });

  // ── 這筆能不能改 ────────────────────────────────────────────
  //
  // 先問資源本身(404 / 409),再驗 body(400)—— 順序和
  // reservations/[id].patch.ts 一致:改不到的東西,body 對不對沒有意義。
  //
  // WHERE 同時綁 trip_id:拿別的旅程的 expense id 過來就查不到 → 404。
  // 和 delete 一樣,權限的邊界寫在 WHERE 裡而不是靠先 SELECT 再比對。
  //
  // 「有沒有被蓋章」和「存不存在」用 LEFT JOIN 一次問完,而不是兩次往返 ——
  // JOIN 條件就是 delete.ts 那句 stamped 查詢(r.reverted_at IS NULL:
  // 撤銷過的回合不算數,那正是「先撤銷再改」的路徑)。
  //
  // 包成函式是因為寫入衝突時要再問一次(見下面的樂觀鎖):
  // 事前檢查和事後診斷必須是**同一個判準**,各寫一份遲早會分岔。
  //
  // 順便把原本的幣別 / 日期 / 匯率 snapshot 一起撈回來 —— 那是下面
  // 「該不該重抓匯率」唯一的依據,而它必須和 404 / 409 判斷看到的是
  // **同一列**(同一次往返、同一個 WHERE),否則兩者之間又多一個空窗。
  type Target = {
    id: string;
    round_seq: number | null; round_currency: string | null;
    currency: string; spent_at: string | null;
    fx_rate: number | null; fx_rate_date: string | null; fx_rate_source: string | null;
  };
  const readTarget = () => dbh.prepare(
    `SELECT e.id, e.currency, e.spent_at, e.fx_rate, e.fx_rate_date, e.fx_rate_source,
            r.seq AS round_seq, r.currency AS round_currency
     FROM expenses e
     LEFT JOIN settlement_rounds r
       ON r.id = e.settlement_round_id AND r.reverted_at IS NULL
     WHERE e.id = ? AND e.trip_id = ?`,
  ).bind(id, trip.id).first<Target>();

  // 已經列入結算回合的支出不給改,理由同「不給刪」(見 [id].delete.ts):
  // 那筆帳已經被算進當時的轉帳,錢也已經照那個數字付出去了。
  // 改金額會讓那次結算的明細對不上它自己的淨額快照,
  // 事後沒辦法回答「這 1,850 是怎麼來的」。
  const stampedError = (t: Target) => createError({
    statusCode: 409,
    statusMessage: `這筆已經列入「${t.round_currency} 第 ${t.round_seq} 次結算」,不能修改。`
      + '要改的話請先到結算頁撤銷那次結算。',
  });

  const target = await readTarget();
  if (!target) throw createError({ statusCode: 404, statusMessage: '找不到這筆支出' });
  if (target.round_seq != null) throw stampedError(target);

  // ── 以下驗證與 POST expenses 完全相同 ───────────────────────
  if (!b?.description || !b?.currency || !b?.amount) {
    throw createError({ statusCode: 400, statusMessage: 'description / currency / amount required' });
  }
  if (!b.payers?.length) {
    throw createError({ statusCode: 400, statusMessage: '至少要有一個付款人' });
  }
  if (!b.split?.mode) {
    throw createError({ statusCode: 400, statusMessage: '缺少分攤方式(split)' });
  }

  const amountMinor = toMinor(b.amount, b.currency);
  const spentDate = (b.spent_at || new Date().toISOString()).slice(0, 10);

  // ── 匯率:只有這三種情況才重新 snapshot ─────────────────────────
  //
  //   ① 幣別換了     ② spent_at 的**日期部分**換了     ③ 原本就沒有 snapshot
  //
  // 其餘一律沿用原本那筆的 fx_rate / fx_rate_date / fx_rate_source。
  //
  // 每次 PATCH 都無條件重抓很吸引人(少一個判斷,而且編輯支出最常見的兩個
  // 理由確實就是「幣別記錯」和「日期記錯」)—— 但那個論證只對了一半:
  // 它漏掉了改錯字。fx_rates 是一天長一列的表,而 rateOn() 取的是
  // 「消費當日或之前**最近**的一列」,所以同一組 (幣別, 日期) 問兩次,
  // 中間只要 fx:sync 跑過就會得到不同答案:
  //
  //   3/8 08:00(台北)= 00:00 UTC 記下 ¥30,000。cron 是 0 1 * * * UTC,
  //   此刻最近的一列還是 3/7(0.2100)→ fx_rate 存 0.2100,換算 6,300。
  //   當天 01:00 UTC 之後 3/8 那列(0.2150)進來。3/9 使用者只把說明
  //   從「宇治」改成「宇治抹茶」,無條件重抓會把 fx_rate 改寫成 0.2150,
  //   台幣估算跳到 6,450 —— **改一個字讓金額動了 150 元。**
  //
  // 「同一筆帳今天看和明天看要是同一個數字」是這個 App 的基本承諾。
  // 那句話的原文寫在 fx.ts 的 backfillMissingRates 上,而它的實作也照著做:
  // 只補 `fx_rate IS NULL` 的列,**從不改寫既有匯率**。編輯是第二條寫入路徑,
  // 同一句承諾在這裡也必須成立 —— 使用者沒有動幣別也沒有動日期,
  // 那筆帳的本位幣金額就沒有任何理由跟著動。
  //
  // 反過來,幣別或日期真的改了就一定要重抓:沿用等於在新的幣別上掛一個
  // 對不上任何一天的匯率,而且它會一直留在那裡不會自己修好 ——
  // backfill 只看 NULL,不會回頭修「有值但是錯的」那種。
  // ③ 同理:本來就沒 snapshot 的話,補上正是 backfill 在做的事,
  //    只是這裡順手做掉,不用等下一次 fx:sync。
  const prevDate = (target.spent_at ?? '').slice(0, 10);
  const resnapshot = b.currency !== target.currency
    || spentDate !== prevDate
    || target.fx_rate == null;
  const fx = resnapshot
    ? await rateOn(dbh, trip.base_currency, b.currency, spentDate)
    : { rate: target.fx_rate, date: target.fx_rate_date, source: target.fx_rate_source };
  const method = b.payment_method ?? 'cash';
  const defaultMarkup = Number(method === 'card' ? cfg.cardFeePct : cfg.cashSpreadPct);
  let markup: number;
  if (b.currency === trip.base_currency) {
    markup = 0;
  } else if (b.fx_markup_pct == null) {
    markup = defaultMarkup;
  } else {
    markup = Number(b.fx_markup_pct);
    if (!Number.isFinite(markup) || markup < 0 || markup > 100) {
      throw createError({ statusCode: 400, statusMessage: 'fx_markup_pct 必須是 0 到 100 之間的數字' });
    }
  }

  let shares: Map<string, number>;
  if (b.split.mode === 'equal') shares = splitEqually(amountMinor, b.split.members);
  else if (b.split.mode === 'shares') shares = splitByShares(amountMinor, b.split.shares);
  else shares = new Map(Object.entries(b.split.amounts).map(([k, v]) => [k, toMinor(v, b.currency)]));

  const shareSum = [...shares.values()].reduce((a, x) => a + x, 0);
  if (shareSum !== amountMinor) {
    throw createError({ statusCode: 400, statusMessage: `分攤合計 ${formatMoney(shareSum, b.currency)} `
      + `與支出金額 ${formatMoney(amountMinor, b.currency)} 不符` });
  }

  /**
   * 「只有一位付款人、而且沒帶金額」= 慣例上的全額付款(見 PayerEditor 的說明)。
   *
   * 抽成一個具名的值而不是在三個地方各寫一次 `b.payers.length === 1 && b.payers[0]!.amount == null`
   * —— 那三處(驗證合計、決定要 INSERT 哪一種、拿 member_id)必須永遠一致,
   * 分開寫就會有一天只改到其中兩處。順帶也讓 noUncheckedIndexedAccess 不必靠 ! 過關。
   */
  const soloPayer = b.payers.length === 1 ? b.payers[0]! : null;
  const payerIsFullAmount = !!soloPayer && soloPayer.amount == null;

  const payerSum = payerIsFullAmount
    ? amountMinor
    : b.payers.reduce((s, p) => s + toMinor(p.amount ?? 0, b.currency), 0);
  if (payerSum !== amountMinor) {
    throw createError({ statusCode: 400, statusMessage: `付款合計 ${formatMoney(payerSum, b.currency)} `
      + `與支出金額 ${formatMoney(amountMinor, b.currency)} 不符` });
  }

  // 成員驗證。跨旅程的成員 id、公費當個人花費的付款人、公費出現在分攤名單裡 ——
  // 三種都會靜靜把帳弄壞,完整推導見 expenses.post.ts 那段長註解。
  const memberRows = await dbh.prepare(
    `SELECT id, is_pot FROM members WHERE trip_id = ?`,
  ).bind(trip.id).all<{ id: string; is_pot: number }>();

  const byId = new Map((memberRows.results ?? []).map((m) => [m.id, m.is_pot]));
  const potId = (memberRows.results ?? []).find((m) => m.is_pot === 1)?.id ?? null;

  for (const p of b.payers) {
    if (!byId.has(p.member_id)) {
      throw createError({ statusCode: 400, statusMessage: '付款人不屬於這趟旅程' });
    }
    if (!(b.payers.length === 1 && p.amount == null)) {
      const minor = toMinor(p.amount ?? 0, b.currency);
      if (minor <= 0) {
        throw createError({
          statusCode: 400,
          statusMessage: '每個付款人的金額都必須大於 0(不出錢的人請直接不要列)',
        });
      }
    }
  }

  for (const memberId of shares.keys()) {
    if (!byId.has(memberId)) {
      throw createError({ statusCode: 400, statusMessage: '分攤的成員不屬於這趟旅程' });
    }
    if (potId && memberId === potId) {
      throw createError({
        statusCode: 400,
        statusMessage: '公費不能出現在分攤名單裡 —— 它是出錢的一方,不是受益人',
      });
    }
  }

  if (potId && b.kind === 'personal' && b.payers.some((p) => p.member_id === potId)) {
    throw createError({
      statusCode: 400,
      statusMessage: '個人花費不能由公費支付。從公費出的錢請記成共同花費(勾「這筆從公費付」)。',
    });
  }

  // ── 寫入 ────────────────────────────────────────────────────
  //
  // created_at 不在 SET 裡:它是「什麼時候被記下來」,不是消費時間
  // (消費時間是 spent_at)。改一個錯字就讓那筆跳到列表最上面是錯的。
  //
  // settlement_round_id 也不在 SET 裡:蓋章與拆章是結算回合的事
  // (rounds.post.ts 蓋、rounds/[id].delete.ts 拆),編輯支出不該碰它。
  //
  // ── 樂觀鎖:每一句都帶 settlement_round_id IS NULL ────────────
  //
  // 上面那個 409 是「先讀再寫」,而讀完到寫入之間隔著一次往返 ——
  // localhost 約 15ms,Workers 打遠端 D1 是幾十到幾百毫秒
  // (完整推導見 rounds.post.ts 的樂觀鎖說明)。那個空窗裡另一支手機
  // 按下結算就會把這筆蓋章,而蓋完章這裡照樣改得動:
  // 回合的淨額快照和轉帳金額還停在舊數字,「這 1,850 是怎麼來的」永遠答不出來,
  // 而且因為已經蓋章,使用者連自己改回去都不行。
  // (「儲存修改」和「結算」同時送出,實測 14/14 都留下一個算不出來的回合。)
  //
  // 所以把前提寫進 SQL 本身。前提不成立時 UPDATE / DELETE 都掃不到那一列、
  // INSERT 的 WHERE EXISTS 也不成立 → 整個 batch 是無操作
  // (不需要靠外鍵回滾,因為根本沒有任何一句寫得進去),
  // 然後用第一句的 changes = 0 認出來回 409。
  //
  // 這裡刻意用 `IS NULL` 而不是重寫上面那句 LEFT JOIN 的「撤銷過的不算數」:
  // 撤銷回合會把 settlement_round_id 寫回 NULL(見 rounds/[id].delete.ts),
  // 所以「撤銷後可以改」這條路徑仍然成立,兩者今天等價。
  // 哪天撤銷改成保留指標當軌跡,這裡和上面那句 SELECT 必須一起改。
  const stmts = [
    dbh.prepare(
      `UPDATE expenses SET
         kind = ?3, description = ?4, category = ?5, currency = ?6, amount_minor = ?7,
         payment_method = ?8, fx_rate = ?9, fx_rate_date = ?10, fx_rate_source = ?11,
         fx_rate_override = ?12, fx_markup_pct = ?13, spent_at = ?14, note = ?15
       WHERE id = ?1 AND trip_id = ?2 AND settlement_round_id IS NULL`,
    ).bind(
      id, trip.id, b.kind, b.description, b.category ?? null, b.currency, amountMinor,
      method, fx?.rate ?? null, fx?.date ?? null, fx?.source ?? null,
      b.fx_rate_override ?? null, markup, b.spent_at, b.note ?? null,
    ),

    // 子表沒有 trip_id 欄位,但「刪別趟的列」這件事仍然必須不可能發生 ——
    // 所以用子查詢把 trip_id 綁回去。單列的主鍵查找,成本可以忽略,
    // 換到的是「這個 batch 裡的每一句都關在這趟旅程裡」這個可以一眼看完的性質。
    // 同一個子查詢順便把上面那個前提也帶上:蓋章的支出,分攤列一列都不能刪。
    dbh.prepare(
      `DELETE FROM expense_payers
       WHERE expense_id IN (SELECT id FROM expenses
                            WHERE id = ?1 AND trip_id = ?2 AND settlement_round_id IS NULL)`,
    ).bind(id, trip.id),
    dbh.prepare(
      `DELETE FROM expense_shares
       WHERE expense_id IN (SELECT id FROM expenses
                            WHERE id = ?1 AND trip_id = ?2 AND settlement_round_id IS NULL)`,
    ).bind(id, trip.id),

    // INSERT 也要帶前提,否則前提不成立時舊的列留著、新的列又插進去,
    // 那筆支出的付款/分攤會變成兩倍 —— 比單純改錯金額還糟。
    ...(payerIsFullAmount
      ? [dbh.prepare(
          `INSERT INTO expense_payers (expense_id, member_id, amount_minor)
           SELECT ?1, ?3, ?4
           WHERE EXISTS (SELECT 1 FROM expenses
                         WHERE id = ?1 AND trip_id = ?2 AND settlement_round_id IS NULL)`,
        ).bind(id, trip.id, soloPayer!.member_id, amountMinor)]
      : b.payers.map((p) =>
          dbh.prepare(
            `INSERT INTO expense_payers (expense_id, member_id, amount_minor)
             SELECT ?1, ?3, ?4
             WHERE EXISTS (SELECT 1 FROM expenses
                           WHERE id = ?1 AND trip_id = ?2 AND settlement_round_id IS NULL)`,
          ).bind(id, trip.id, p.member_id, toMinor(p.amount ?? 0, b.currency)))),
    ...[...shares].map(([memberId, v]) =>
      dbh.prepare(
        `INSERT INTO expense_shares (expense_id, member_id, amount_minor)
         SELECT ?1, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM expenses
                       WHERE id = ?1 AND trip_id = ?2 AND settlement_round_id IS NULL)`,
      ).bind(id, trip.id, memberId, v)),
  ];

  const results = await dbh.batch(stmts);

  // 第一句改到 0 列 = 前提不成立。這時候資料庫一個字都沒被改到,
  // 只要把「為什麼」問清楚再回報就好 —— 這次額外的往返只發生在衝突路徑上。
  const changed = results[0]?.meta?.changes;
  if (typeof changed === 'number' && changed === 0) {
    const now = await readTarget();
    if (!now) throw createError({ statusCode: 404, statusMessage: '找不到這筆支出' });
    if (now.round_seq != null) throw stampedError(now);
    throw createError({
      statusCode: 409,
      statusMessage: '這筆支出在你按下儲存的這一瞬間被別人動了。什麼都沒有寫入,請重新整理再試一次。',
    });
  }

  return { id, fx_rate: fx?.rate ?? null, fx_rate_date: fx?.date ?? null, fx_markup_pct: markup };
});
