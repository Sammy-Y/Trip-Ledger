import { db } from '../../utils/cf';
import { syncRates } from '../../utils/fx';

/** 手動觸發 + 給 scheduled task 當 self-fetch 後路用。 */
export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig(event);
  requireTaskSecret(event, cfg.taskSecret as string);
  return await syncRates(db(event), {
    base: cfg.fxBase as string,
    sourceUrl: cfg.fxSourceUrl as string,
  });
});

function requireTaskSecret(event: any, secret: string) {
  // 有設密鑰就強制驗;沒設(本機開發)就放行。
  if (!secret) return;
  if (getHeader(event, 'x-task-secret') !== secret) {
    throw createError({ statusCode: 401, statusMessage: 'bad task secret' });
  }
}
