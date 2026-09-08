import { db } from '../../utils/cf';
import { destroySession } from '../../utils/auth';

export default defineEventHandler(async (event) => {
  await destroySession(event, db(event));
  return { ok: true };
});
