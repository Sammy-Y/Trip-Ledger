import { db } from '../../../../utils/cf';
import { requireTrip } from '../../../../utils/trip';
import type { Reservation } from '../../../../../shared/types';

/**
 * 更新一筆預約 —— 打勾「我訂到了」、改訂位時間、補訂位名字。
 *
 * 為什麼需要這支:原本只有 POST,所以「訂到了」這件事沒辦法記,
 * 卡片上連按鈕都不敢放(見 ReservationCard 原本的註解)。
 * 而「訂到的時間要改」更是常態 —— 1/1 沒位子改訂 1/3,
 * 不該逼使用者刪掉重建(那會連提醒紀錄一起弄掉)。
 *
 * ── SQL 寫法的取捨 ────────────────────────────────────────────
 * 專案規定 SQL 必須是完全靜態的字串,不准動態拼 SET 子句
 * (見 test/sql-safety.test.ts)。但部分更新有三種語意要分清楚:
 *   欄位沒出現在 body  → 不要動
 *   欄位 = null        → 清成 NULL(例如取消訂位時間)
 *   欄位 = 值          → 寫入
 *
 * COALESCE(?, col) 分不出前兩者(都當成「不要動」),
 * 所以每個欄位配一個「有沒有出現」的旗標,用
 *   CASE WHEN ?flag = 1 THEN ?value ELSE col END
 * 表達。SQL 仍然是完全靜態的,語意也完整。
 */
type Body = Partial<{
  name: string;
  url: string | null;
  opens_at_utc: string | null;
  booked_for_utc: string | null;
  booking_name: string | null;
  party_size: number | null;
  remind_before_min: number;
  status: 'pending' | 'booked' | 'cancelled';
  note: string | null;
}>;

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少預約 id' });

  const b = (await readBody<Body>(event)) ?? {};

  const existing = await dbh.prepare(
    `SELECT id FROM reservations WHERE trip_id = ? AND id = ?`,
  ).bind(trip.id, id).first<{ id: string }>();
  if (!existing) throw createError({ statusCode: 404, statusMessage: '找不到這筆預約' });

  const has = (key: keyof Body) => (Object.prototype.hasOwnProperty.call(b, key) ? 1 : 0);

  if (has('name') && !String(b.name ?? '').trim()) {
    throw createError({ statusCode: 400, statusMessage: '店名不能是空的' });
  }
  if (has('status') && !['pending', 'booked', 'cancelled'].includes(String(b.status))) {
    throw createError({ statusCode: 400, statusMessage: 'status 只能是 pending / booked / cancelled' });
  }
  if (has('party_size') && b.party_size != null) {
    const n = Number(b.party_size);
    if (!Number.isInteger(n) || n < 1) {
      throw createError({ statusCode: 400, statusMessage: '人數必須是大於 0 的整數' });
    }
  }
  if (has('remind_before_min')) {
    const n = Number(b.remind_before_min);
    if (!Number.isFinite(n) || n < 0) {
      throw createError({ statusCode: 400, statusMessage: '提醒時間必須是 0 或正數(分鐘)' });
    }
  }

  await dbh.prepare(
    `UPDATE reservations SET
       name              = CASE WHEN ?3  = 1 THEN ?4  ELSE name              END,
       url               = CASE WHEN ?5  = 1 THEN ?6  ELSE url               END,
       opens_at_utc      = CASE WHEN ?7  = 1 THEN ?8  ELSE opens_at_utc      END,
       booked_for_utc    = CASE WHEN ?9  = 1 THEN ?10 ELSE booked_for_utc    END,
       booking_name      = CASE WHEN ?11 = 1 THEN ?12 ELSE booking_name      END,
       party_size        = CASE WHEN ?13 = 1 THEN ?14 ELSE party_size        END,
       remind_before_min = CASE WHEN ?15 = 1 THEN ?16 ELSE remind_before_min END,
       status            = CASE WHEN ?17 = 1 THEN ?18 ELSE status            END,
       note              = CASE WHEN ?19 = 1 THEN ?20 ELSE note              END
     WHERE trip_id = ?1 AND id = ?2`,
  ).bind(
    trip.id, id,
    has('name'), b.name?.trim() ?? null,
    has('url'), b.url ?? null,
    has('opens_at_utc'), b.opens_at_utc ?? null,
    has('booked_for_utc'), b.booked_for_utc ?? null,
    has('booking_name'), b.booking_name?.trim() || null,
    has('party_size'), b.party_size ?? null,
    has('remind_before_min'), b.remind_before_min ?? null,
    has('status'), b.status ?? null,
    has('note'), b.note?.trim() || null,
  ).run();

  const row = await dbh.prepare(
    `SELECT id, name, url, opens_at_utc, booked_for_utc, booking_name, party_size,
            remind_before_min, reminded_at, status, note
     FROM reservations WHERE trip_id = ? AND id = ?`,
  ).bind(trip.id, id).first<Reservation>();

  return row;
});
