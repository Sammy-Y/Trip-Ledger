import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';
import { rateOn } from '../../../utils/fx';
import { toMinor } from '../../../utils/money';
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

  const amountMinor = toMinor(b.amount, b.currency);
  const spentDate = (b.spent_at || new Date().toISOString()).slice(0, 10);

  // 匯率取「消費當日」而非「今天」,並在寫入時 snapshot 下來。
  const fx = await rateOn(dbh, trip.base_currency, b.currency, spentDate);
  const method = b.payment_method ?? 'cash';
  const markup = b.currency === trip.base_currency
    ? 0
    : Number(method === 'card' ? cfg.cardFeePct : cfg.cashSpreadPct);

  // 分攤先算成明確金額,並驗證守恆 —— 不守恆就退回,不要寫進 DB。
  let shares: Map<string, number>;
  if (b.split.mode === 'equal') shares = splitEqually(amountMinor, b.split.members);
  else if (b.split.mode === 'shares') shares = splitByShares(amountMinor, b.split.shares);
  else shares = new Map(Object.entries(b.split.amounts).map(([k, v]) => [k, toMinor(v, b.currency)]));

  const shareSum = [...shares.values()].reduce((a, x) => a + x, 0);
  if (shareSum !== amountMinor) {
    throw createError({ statusCode: 400, statusMessage: `分攤合計 ${shareSum} 與支出金額 ${amountMinor} 不符` });
  }

  const payerSum = b.payers.length === 1 && b.payers[0].amount == null
    ? amountMinor
    : b.payers.reduce((s, p) => s + toMinor(p.amount ?? 0, b.currency), 0);
  if (payerSum !== amountMinor) {
    throw createError({ statusCode: 400, statusMessage: `付款合計 ${payerSum} 與支出金額 ${amountMinor} 不符` });
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
