import { db } from '../../utils/cf';
import { syncRates } from '../../utils/fx';
import { purgeExpiredSessions } from '../../utils/auth';

/** 手動觸發 + 給 scheduled task 當 self-fetch 後路用。 */
export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig(event);
  requireTaskSecret(event, cfg.taskSecret as string);
  const dbh = db(event);
  const rates = await syncRates(dbh, {
    base: cfg.fxBase as string,
    sourceUrl: cfg.fxSourceUrl as string,
  });
  // 順便清掉過期的 session。搭在每日匯率同步上,不必為它多開一個 cron ——
  // 這件事一天做一次綽綽有餘。
  const purged = await purgeExpiredSessions(dbh);
  return { ...rates, purged_sessions: purged };
});

function requireTaskSecret(event: any, secret: string) {
  // 有設密鑰就強制驗;沒設(本機開發)就放行。
  if (!secret) return;
  if (getHeader(event, 'x-task-secret') !== secret) {
    throw createError({ statusCode: 401, statusMessage: 'bad task secret' });
  }
}
