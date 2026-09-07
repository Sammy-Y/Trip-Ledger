import { db } from '../../utils/cf';
import { runReminders } from '../../utils/reminders';

export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig(event);
  if (cfg.taskSecret && getHeader(event, 'x-task-secret') !== cfg.taskSecret) {
    throw createError({ statusCode: 401, statusMessage: 'bad task secret' });
  }
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return await runReminders(db(event), {
    privateJwk: cfg.vapidPrivateJwk as string,
    publicKey: cfg.vapidPublicKey as string,
    subject: cfg.vapidSubject as string,
  }, nowIso);
});
