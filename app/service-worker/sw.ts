/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: any };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

/**
 * 推播刻意不帶 payload(見 server/utils/push.ts),
 * 所以這裡收到 push 後自己回打 API 取要顯示的內容。
 * 好處:不用實作 aes128gcm 加密,行程細節也不經過第三方推播服務。
 */
self.addEventListener('push', (event: PushEvent) => {
  event.waitUntil((async () => {
    let title = '訂位即將開放';
    let body = '點開看哪一家';
    let url = '/';
    try {
      const tripId = await readTripId();
      if (tripId) {
        // 點通知要能直接開到那趟旅程的預約頁,而不是丟使用者回首頁自己找。
        url = `/t/${tripId}/plan`;
        const res = await fetch(`/api/trips/${tripId}/reservations/due`);
        if (res.ok) {
          const list = (await res.json()) as Array<{ name: string; note?: string }>;
          if (list?.[0]) {
            title = `${list[0].name} 即將開放訂位`;
            body = list[0].note || '準備搶位';
          }
        }
      }
    } catch {
      // 取不到內容就用預設文案 —— 不要因為抓不到細節就整個通知不出來
    }
    await self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'reservation',
      // 帶著網址,notificationclick 才知道要開哪裡
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil((async () => {
    // 已經開著的分頁優先聚焦,不要每次都開新視窗
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      if (c.url.includes(url)) return c.focus();
    }
    await self.clients.openWindow(url);
  })());
});

/** 前端訂閱推播時要把旅程識別碼寫進這個 cache,SW 才知道要打哪個 trip。 */
async function readTripId(): Promise<string | null> {
  const cache = await caches.open('trip-ledger-meta');
  const hit = await cache.match('/__token');
  return hit ? hit.text() : null;
}
