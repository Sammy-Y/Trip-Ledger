import type { H3Event } from 'h3';

/**
 * 取 Cloudflare binding。
 *
 * 為什麼要這一層:binding 的取法在 Nitro 版本之間變過
 *   - Nitro v3 / Nuxt 5:event.req.runtime.cloudflare.env
 *   - Nitro v2 / Nuxt 3:event.context.cloudflare.env
 * 兩個都試,拿不到就明確報錯,不要讓它靜靜地回 undefined 然後在 SQL 那行才炸。
 */
export function cfEnv(event: H3Event): Record<string, any> {
  const e = event as any;
  const env = e?.req?.runtime?.cloudflare?.env ?? e?.context?.cloudflare?.env;
  if (!env) {
    throw createError({
      statusCode: 500,
      statusMessage: '拿不到 Cloudflare binding。本機請確認 wrangler.jsonc 的 d1_databases 已宣告;'
        + '線上請確認部署 preset 是 cloudflare_module。',
    });
  }
  return env;
}

export function db(event: H3Event): D1Database {
  const d = cfEnv(event).DB;
  if (!d) throw createError({ statusCode: 500, statusMessage: 'D1 binding "DB" 不存在' });
  return d;
}

/**
 * 在 scheduled task 裡試著取 D1。
 *
 * ⚠️ 這條路徑我無法驗證。Nitro 官方文件沒有記載 task 裡怎麼取 Cloudflare binding
 * (task 跑在請求生命週期外),社群回報的做法是開 experimental.asyncContext。
 * 所以這裡「試著拿,拿不到就回 null」,由呼叫端改走 self-fetch 後路 ——
 * 不管 asyncContext 有沒有效,cron 都能動。
 */
export function taskDb(context?: any): D1Database | null {
  const candidates = [
    context?.cloudflare?.env,
    context?.event?.req?.runtime?.cloudflare?.env,
    context?.event?.context?.cloudflare?.env,
    (globalThis as any).__env__,
  ];
  for (const env of candidates) {
    if (env?.DB) return env.DB as D1Database;
  }
  return null;
}

/**
 * 後路:對自己的公開網址發一次真實 HTTP 請求,讓工作在「有 binding 的請求情境」裡執行。
 * 代價是多一次 invocation + 一個 subrequest,對一天一次 / 五分鐘一次的 cron 可忽略。
 */
export async function selfFetch(path: string, origin: string, secret: string) {
  if (!origin) return { ok: false as const, error: 'NUXT_PUBLIC_ORIGIN 未設定,self-fetch 後路無法使用' };
  const res = await fetch(new URL(path, origin), {
    method: 'POST',
    headers: { 'x-task-secret': secret, 'content-type': 'application/json' },
  });
  const body = await res.text();
  return res.ok
    ? { ok: true as const, via: 'self-fetch', body }
    : { ok: false as const, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
}
