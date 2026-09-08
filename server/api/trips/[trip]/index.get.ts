import { db } from '../../../utils/cf';
import { resolveTripAccess } from '../../../utils/trip';

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  // 這支是每個旅程畫面的入口,所以順便把權限資訊一起帶出去,
  // 前端不用再打一支 API 才知道該不該顯示「刪除」「分享」「認領」。
  const { trip, role, orphan, shareToken, session } = await resolveTripAccess(event, dbh);
  const cfg = useRuntimeConfig(event);

  // 公費排在最後 —— 它不是人,在成員名單裡混在中間會讓人以為多了一個旅伴。
  const members = await dbh.prepare(
    `SELECT id, name, is_pot FROM members WHERE trip_id = ? ORDER BY is_pot, name`,
  ).bind(trip.id).all<{ id: string; name: string; is_pot: number }>();

  return {
    trip,
    /** 'owner' | 'editor'。owner 才能刪除旅程、看得到分享連結。 */
    role,
    /** 還沒有任何帳號擁有這趟。登入的人可以按「認領」。 */
    orphan,
    /** 只有 owner 拿得到。editor 一律是 null —— 鑰匙不該再被轉發出去。 */
    share_token: shareToken,
    /** 沒登入的人在這趟記的帳,換瀏覽器就找不回來,前端要提醒。 */
    anonymous: !session.userId,
    members: members.results ?? [],
    // 記帳表單要顯示「刷卡預設加計多少手續費」並讓使用者改。
    // 值的來源仍然只有 runtimeConfig 一處,不在前端複製一份預設值。
    fx_defaults: {
      cash_spread_pct: Number(cfg.cashSpreadPct),
      card_fee_pct: Number(cfg.cardFeePct),
    },
  };
});
