import { taskDb, selfFetch } from '../../utils/cf';
import { runReminders } from '../../utils/reminders';

export default defineTask({
  meta: { name: 'reminders:run', description: '掃預約開放時間,到期就發 Web Push' },
  async run({ payload, context }) {
    const cfg = useRuntimeConfig();
    const dbh = taskDb(context);

    // scheduledTime 由 Nitro 自動帶入;沒有就退回現在時間。
    const at = (payload as any)?.scheduledTime ?? Date.now();
    const nowIso = new Date(at).toISOString().replace('T', ' ').slice(0, 19);

    if (dbh) {
      const r = await runReminders(dbh, {
        privateJwk: cfg.vapidPrivateJwk as string,
        publicKey: cfg.vapidPublicKey as string,
        subject: cfg.vapidSubject as string,
      }, nowIso);
      console.log('[reminders:run] via binding', JSON.stringify(r));
      return { result: r };
    }
    const r = await selfFetch('/api/admin/run-reminders', cfg.publicOrigin as string, cfg.taskSecret as string);
    console.log('[reminders:run] via self-fetch', JSON.stringify(r));
    return { result: r };
  },
});
