import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';
import { rateOn } from '../../../utils/fx';
import { toMinor, formatMoney } from '../../../utils/money';
import { splitEqually, splitByShares } from '../../../utils/settle';

/**
 * 新增支出。
 * split 三種模式,對應原 Excel 備註裡手寫的那些拆分:
 *   { mode:'equal',  members:[...] }                  均分(只列實際參與的人)
 *   { mode:'shares', shares:{ m1:2, m2:1 } }          按份數或百分比
 *   { mode:'exact',  amounts:{ m1:3857, m2:2417 } }   指定金額(伊藤久右衛門那種)
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

  if (!b?.description || !b?.currency || !b?.amount) {
    throw createError({ statusCode: 400, statusMessage: 'description / currency / amount required' });
  }
  if (!b.payers?.length) {
    // 沒有付款人就無法結算 —— 這正是原 Excel 卡住的地方,所以這裡直接擋掉。
    throw createError({ statusCode: 400, statusMessage: '至少要有一個付款人' });
  }
  // 少了 split 以前會直接 dereference b.split.mode → 英文的 500 Server Error。
  // 使用者看到「Server Error」只會以為系統壞了,而不是自己少送一個欄位。
  if (!b.split?.mode) {
    throw createError({ statusCode: 400, statusMessage: '缺少分攤方式(split)' });
  }

  const amountMinor = toMinor(b.amount, b.currency);
  const spentDate = (b.spent_at || new Date().toISOString()).slice(0, 10);

  // 匯率取「消費當日」而非「今天」,並在寫入時 snapshot 下來。
  const fx = await rateOn(dbh, trip.base_currency, b.currency, spentDate);
  const method = b.payment_method ?? 'cash';
  // 本位幣不需要換匯,任何加成都沒有意義 —— 使用者就算送了值也一律歸零。
  // 外幣則:有給就用給的(刷卡手續費各家不同,使用者最清楚自己那張卡),
  // 沒給才退回 runtimeConfig 的預設值。
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

  // 分攤先算成明確金額,並驗證守恆 —— 不守恆就退回,不要寫進 DB。
  let shares: Map<string, number>;
  if (b.split.mode === 'equal') shares = splitEqually(amountMinor, b.split.members);
  else if (b.split.mode === 'shares') shares = splitByShares(amountMinor, b.split.shares);
  else shares = new Map(Object.entries(b.split.amounts).map(([k, v]) => [k, toMinor(v, b.currency)]));

  const shareSum = [...shares.values()].reduce((a, x) => a + x, 0);
  if (shareSum !== amountMinor) {
    throw createError({ statusCode: 400, statusMessage: `分攤合計 ${formatMoney(shareSum, b.currency)} `
      + `與支出金額 ${formatMoney(amountMinor, b.currency)} 不符` });
  }

  const payerSum = b.payers.length === 1 && b.payers[0].amount == null
    ? amountMinor
    : b.payers.reduce((s, p) => s + toMinor(p.amount ?? 0, b.currency), 0);
  if (payerSum !== amountMinor) {
    throw createError({ statusCode: 400, statusMessage: `付款合計 ${formatMoney(payerSum, b.currency)} `
      + `與支出金額 ${formatMoney(amountMinor, b.currency)} 不符` });
  }

  // ── 成員驗證 ────────────────────────────────────────────────
  //
  // 這一段以前完全沒有,結果三種輸入都會回 201 然後靜靜把帳弄壞:
  //
  //  1. 付款人 / 分攤人是**別的旅程**的成員 id → 那些列會被算進 expense_payers,
  //     但成員名單裡查不到,畫面顯示「未知成員」而且結算永遠不平。
  //  2. **公費當個人花費的付款人** → 公費付了錢卻沒有人分攤,
  //     「公費剩餘 = −公費淨額」這個不變量直接破掉(實測差額等於該筆全額)。
  //  3. **公費出現在分攤名單裡** → 公費替自己分攤一份,等於它自己欠自己,
  //     結算會產生一筆莫名的公費轉帳。
  //
  // 結算是把這些錯誤變成真實金錢的那一步,所以擋在寫入的時候。
  const memberRows = await dbh.prepare(
    `SELECT id, is_pot FROM members WHERE trip_id = ?`,
  ).bind(trip.id).all<{ id: string; is_pot: number }>();

  const byId = new Map((memberRows.results ?? []).map((m) => [m.id, m.is_pot]));
  const potId = (memberRows.results ?? []).find((m) => m.is_pot === 1)?.id ?? null;

  for (const p of b.payers) {
    if (!byId.has(p.member_id)) {
      throw createError({ statusCode: 400, statusMessage: '付款人不屬於這趟旅程' });
    }
    // 「單一付款人不給金額 = 全額」是既有的慣例,那種情況不檢查金額
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

  const id = uid();
  const stmts = [
    dbh.prepare(
      `INSERT INTO expenses (id, trip_id, kind, description, category, currency, amount_minor,
         payment_method, fx_rate, fx_rate_date, fx_rate_source, fx_rate_override, fx_markup_pct, spent_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, trip.id, b.kind, b.description, b.category ?? null, b.currency, amountMinor,
      method, fx?.rate ?? null, fx?.date ?? null, fx?.source ?? null,
      b.fx_rate_override ?? null, markup, b.spent_at, b.note ?? null,
    ),
    ...(b.payers.length === 1 && b.payers[0].amount == null
      ? [dbh.prepare(`INSERT INTO expense_payers (expense_id, member_id, amount_minor) VALUES (?,?,?)`)
          .bind(id, b.payers[0].member_id, amountMinor)]
      : b.payers.map((p) =>
          dbh.prepare(`INSERT INTO expense_payers (expense_id, member_id, amount_minor) VALUES (?,?,?)`)
            .bind(id, p.member_id, toMinor(p.amount ?? 0, b.currency)))),
    ...[...shares].map(([memberId, v]) =>
      dbh.prepare(`INSERT INTO expense_shares (expense_id, member_id, amount_minor) VALUES (?,?,?)`)
        .bind(id, memberId, v)),
  ];

  await dbh.batch(stmts);
  setResponseStatus(event, 201);
  return { id, fx_rate: fx?.rate ?? null, fx_rate_date: fx?.date ?? null, fx_markup_pct: markup };
});
