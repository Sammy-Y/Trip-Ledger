import { db } from '../../../utils/cf';
import { requireTrip, uid } from '../../../utils/trip';

type Body = {
  from_member: string;
  to_member: string;
  currency: string;
  amount_minor: number;
  note?: string;
};

/**
 * 記一筆還款(結算頁的「標記已還款」)。
 *
 * 這裡收的是 amount_minor(最小單位整數),不是人類單位 ——
 * 因為金額直接來自 balance 的轉帳建議,不需要再過一次 toMinor,
 * 也避免浮點轉換讓還款額和應付額差一分錢、結算永遠歸不了零。
 */
export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const b = await readBody<Body>(event);

  if (!b?.from_member || !b?.to_member || !b?.currency) {
    throw createError({ statusCode: 400, statusMessage: 'from_member / to_member / currency required' });
  }
  if (b.from_member === b.to_member) {
    throw createError({ statusCode: 400, statusMessage: '付款人與收款人不能是同一個人' });
  }
  if (!Number.isInteger(b.amount_minor) || b.amount_minor <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'amount_minor 必須是大於 0 的整數(最小單位)' });
  }

  const [members, currency] = await Promise.all([
    dbh.prepare(`SELECT id FROM members WHERE trip_id = ? AND id IN (?, ?)`)
      .bind(trip.id, b.from_member, b.to_member).all<{ id: string }>(),
    dbh.prepare(`SELECT code FROM currencies WHERE code = ?`).bind(b.currency).first<{ code: string }>(),
  ]);

  // 兩個人都得在這趟旅程裡。少一個就代表 id 打錯或屬於別的旅程。
  if ((members.results ?? []).length !== 2) {
    throw createError({ statusCode: 400, statusMessage: '付款人或收款人不屬於這趟旅程' });
  }
  if (!currency) {
    throw createError({ statusCode: 400, statusMessage: `不支援的幣別 ${b.currency}` });
  }

  const id = uid();
  await dbh.prepare(
    `INSERT INTO settlements (id, trip_id, from_member, to_member, currency, amount_minor, note)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(id, trip.id, b.from_member, b.to_member, b.currency, b.amount_minor, b.note ?? null).run();

  setResponseStatus(event, 201);
  return {
    id,
    from_member: b.from_member,
    to_member: b.to_member,
    currency: b.currency,
    amount_minor: b.amount_minor,
  };
});
