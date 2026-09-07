import { taskDb, selfFetch } from '../../utils/cf';
import { syncRates } from '../../utils/fx';

export default defineTask({
  meta: { name: 'fx:sync', description: '每日抓匯率寫入 fx_rates 快照表' },
  async run({ context }) {
    const cfg = useRuntimeConfig();
    const dbh = taskDb(context);

    // 首選:直接用 binding。拿不到就走 self-fetch 後路(見 utils/cf.ts 說明)。
    if (dbh) {
      const r = await syncRates(dbh, { base: cfg.fxBase as string, sourceUrl: cfg.fxSourceUrl as string });
      console.log('[fx:sync] via binding', JSON.stringify(r));
      return { result: r };
    }
    const r = await selfFetch('/api/admin/sync-rates', cfg.publicOrigin as string, cfg.taskSecret as string);
    console.log('[fx:sync] via self-fetch', JSON.stringify(r));
    return { result: r };
  },
});
