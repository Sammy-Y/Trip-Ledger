import { db } from '../../../../utils/cf';
import { requireTrip, uid } from '../../../../utils/trip';

/**
 * 一次記錄多筆公費金流(投入 / 退還)。
 *
 * 為什麼需要批次而不是叫前端呼叫 N 次 settlements.post:
 *
 *  1. **公費投入天生是集體行為。** 「今天大家說好各拿 5,000 出來」是一個決定,
 *     不是 N 個決定。拆成 N 次請求的話,第 3 個人失敗時前 2 個已經寫進去了,
 *     使用者要自己去結算頁把它們找出來刪掉 —— 而畫面上公費的剩餘已經是錯的。
 *     用 dbh.batch() 一次寫完,要嘛全部成功要嘛全部沒發生。
 *  2. 少了 N−1 次往返。手機在國外用行動網路,每次往返都有感。
 *
 * 金額仍然是**逐人**給的(entries[].amount_minor),不是給一個共用金額 ——
 * 「每人一樣」是最常見的情況,但不是規則(有人先墊多一點、有人身上沒零錢),
 * 所以資料模型不該把「一樣」寫死。UI 負責讓常見情況只輸入一次。
 */
type Entry = { member_id: string; amount_minor: number };
type Body = {
  /** in = 人投入公費;out = 公費退還給人 */
  direction: 'in' | 'out';
  currency: string;
  entries: Entry[];
  note?: string;
};

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const b = await readBody<Body>(event);

  if (b?.direction !== 'in' && b?.direction !== 'out') {
    throw createError({ statusCode: 400, statusMessage: 'direction 只能是 in 或 out' });
  }
  if (!b?.currency) throw createError({ statusCode: 400, statusMessage: '缺少幣別' });
  if (!Array.isArray(b.entries) || b.entries.length === 0) {
    throw createError({ statusCode: 400, statusMessage: '至少要勾選一個人' });
  }

  // 同一個人出現兩次 —— 幾乎一定是 UI 的 bug,靜靜寫兩筆會讓公費剩餘莫名少一截
  const seen = new Set<string>();
  for (const e of b.entries) {
    if (!e?.member_id) throw createError({ statusCode: 400, statusMessage: 'entries 少了 member_id' });
    if (seen.has(e.member_id)) {
      throw createError({ statusCode: 400, statusMessage: '同一個成員出現兩次' });
    }
    seen.add(e.member_id);
    if (!Number.isInteger(e.amount_minor) || e.amount_minor <= 0) {
      throw createError({
        statusCode: 400,
        statusMessage: '每個人的金額都必須是大於 0 的整數(最小單位)',
      });
    }
  }

  const [pot, currency, memberRows] = await Promise.all([
    dbh.prepare(`SELECT id, name FROM members WHERE trip_id = ? AND is_pot = 1`)
      .bind(trip.id).first<{ id: string; name: string }>(),
    dbh.prepare(`SELECT code FROM currencies WHERE code = ?`).bind(b.currency).first<{ code: string }>(),
    dbh.prepare(`SELECT id FROM members WHERE trip_id = ? AND is_pot = 0`)
      .bind(trip.id).all<{ id: string }>(),
  ]);

  if (!pot) {
    throw createError({ statusCode: 400, statusMessage: '這趟還沒有設公費。請先到「成員」頁建立。' });
  }
  if (!currency) {
    throw createError({ statusCode: 400, statusMessage: `不支援的幣別 ${b.currency}` });
  }

  // 只有「人」可以投入或收到退還。公費對自己轉帳沒有意義,而且會讓淨額算錯。
  const people = new Set((memberRows.results ?? []).map((m) => m.id));
  for (const e of b.entries) {
    if (!people.has(e.member_id)) {
      throw createError({
        statusCode: 400,
        statusMessage: '勾選的成員不屬於這趟旅程,或那是公費本身(公費不能投入自己)',
      });
    }
  }

  const inbound = b.direction === 'in';
  const total = b.entries.reduce((s, e) => s + e.amount_minor, 0);

  // ── 退還不能超過公費手上有的錢 ──────────────────────────────
  //
  // 這不是防手滑而已,是防**憑空製造債務**。退還會寫成 settlement(公費 → 人),
  // 而 settlement 會直接影響淨額。退還一筆公費從來沒收到的錢,
  // 會讓收款人的淨額多出那麼多,結算就會叫**另一個人**付一筆根本不存在的錢
  // 給他 —— 而且那筆會被結算回合寫成真的轉帳。
  // (實測:對一個從未持有台幣的公費退還 999,900,結算馬上長出一筆假的人對人轉帳。)
  //
  // 而且目前沒有「刪掉單筆 settlement」的功能,所以寫錯了就拔不掉。寧可擋在這裡。
  if (!inbound) {
    const flow = await dbh.prepare(
      `SELECT
         COALESCE((SELECT SUM(amount_minor) FROM settlements
                    WHERE trip_id = ?1 AND currency = ?2 AND to_member = ?3), 0) AS contributed,
         COALESCE((SELECT SUM(amount_minor) FROM settlements
                    WHERE trip_id = ?1 AND currency = ?2 AND from_member = ?3), 0) AS refunded,
         COALESCE((SELECT SUM(p.amount_minor) FROM expense_payers p
                    JOIN expenses e ON e.id = p.expense_id
                    WHERE e.trip_id = ?1 AND e.currency = ?2 AND p.member_id = ?3), 0) AS spent`,
    ).bind(trip.id, b.currency, pot.id)
      .first<{ contributed: number; refunded: number; spent: number }>();

    const remaining = (flow?.contributed ?? 0) - (flow?.spent ?? 0) - (flow?.refunded ?? 0);
    if (total > remaining) {
      throw createError({
        statusCode: 400,
        statusMessage: remaining <= 0
          ? `${pot.name}目前沒有可退還的${b.currency}(剩餘 ${remaining})。`
            + '要先有人投入、或先把公費付掉的支出記進來。'
          : `退還金額 ${total} 超過${pot.name}剩下的 ${remaining} ${b.currency}。`
            + '退還不能超過公費手上的錢 —— 否則會憑空生出一筆債務。',
      });
    }
  }

  const note = b.note?.trim() || (inbound ? '投入公費' : '公費退還');

  const stmts = b.entries.map((e) =>
    dbh.prepare(
      `INSERT INTO settlements (id, trip_id, from_member, to_member, currency, amount_minor, note)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      uid(), trip.id,
      inbound ? e.member_id : pot.id,
      inbound ? pot.id : e.member_id,
      b.currency, e.amount_minor, note,
    ));

  await dbh.batch(stmts);

  setResponseStatus(event, 201);
  return {
    direction: b.direction,
    currency: b.currency,
    count: b.entries.length,
    total_minor: total,
    pot: { id: pot.id, name: pot.name },
  };
});
