import { sendEmptyPush, type VapidConfig } from './push';

/**
 * 預約開放時間提醒 —— 你 Excel「預訂」工作表的功能化。
 * (這是我在 Funliday / Wanderlog / 各家分帳 App 都找不到的功能。)
 *
 * 設計:一個 每5分鐘 的 cron 掃 DB,而不是每家餐廳開一個 cron。
 * Cloudflare 免費方案每帳號只有 5 個 Cron Triggers,掃表只吃 1 個就能處理任意數量預約。
 * 每天 288 次呼叫,對 10 萬次/日的額度是零頭。
 */
export async function runReminders(dbh: D1Database, vapid: VapidConfig, nowIso: string) {
  const due = await dbh.prepare(
    `SELECT id, trip_id, name FROM reservations
     WHERE status = 'pending'
       AND opens_at_utc IS NOT NULL
       AND reminded_at IS NULL
       AND datetime(opens_at_utc, '-' || remind_before_min || ' minutes') <= ?
       AND datetime(opens_at_utc) >= datetime(?, '-1 day')`,
  ).bind(nowIso, nowIso).all<{ id: string; trip_id: string; name: string }>();

  const rows = due.results ?? [];
  if (!rows.length) return { due: 0, sent: 0, pruned: 0 };

  let sent = 0, pruned = 0;
  for (const r of rows) {
    const subs = await dbh.prepare(
      `SELECT endpoint FROM push_subscriptions WHERE trip_id = ?`,
    ).bind(r.trip_id).all<{ endpoint: string }>();

    for (const s of subs.results ?? []) {
      const out = await sendEmptyPush(vapid, s.endpoint);
      if (out === 'sent') sent++;
      // 410 Gone 就清掉,否則每 5 分鐘都在重試死訂閱
      else if (out === 'gone') {
        await dbh.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(s.endpoint).run();
        pruned++;
      }
    }
    await dbh.prepare(`UPDATE reservations SET reminded_at = ? WHERE id = ?`).bind(nowIso, r.id).run();
  }
  return { due: rows.length, sent, pruned };
}
