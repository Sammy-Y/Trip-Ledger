import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue';

/**
 * usePushSubscription —— 訂位開放前的 Web Push 提醒。
 *
 * 這是「預約」頁的核心價值:日本熱門餐廳每月 1 號 12:00 開放下兩個月的訂位,
 * 沒在那一分鐘按下去就吃不到。所以提醒必須由伺服器推,不能只靠使用者記得回來看。
 *
 * 整條鏈路(讀過 server/utils/reminders.ts 與 app/service-worker/sw.ts 後對齊):
 *   1. 這裡拿 Notification 權限 → pushManager.subscribe() → POST /api/trips/:trip/push
 *   2. cron(每 5 分鐘)掃 reservations,到了 opens_at_utc - remind_before_min 就發「空推播」
 *   3. Service Worker 收到空推播後,自己回打 /api/trips/:trip/reservations/due 取內容
 *      —— 它是從 caches 的 'trip-ledger-meta' / '/__token' 讀 tripId 的,
 *      所以**訂閱時一定要把 tripId 寫進那個 cache**,否則推播會退回沒有店名的預設文案。
 *
 * 三個一定會遇到、而且不能讓畫面壞掉的現實:
 *   - iOS 只有「加到主畫面」之後才有 Push API。純 Safari 分頁裡 window.PushManager
 *     根本不存在,所以要分辨「這台不支援」和「這台只是還沒安裝」,給的指引完全不同。
 *   - 伺服器的 VAPID public key 放在 runtimeConfig(非 public),目前沒有任何端點吐出來
 *     (已確認 GET /api/trips/:trip 只回 { trip, members })。拿不到金鑰就退化成
 *     'no-server-key',畫面照樣顯示倒數,只是不推播。
 *   - 使用者可能之前按過「封鎖」。那時 requestPermission() 不會再跳窗,
 *     只能叫他去瀏覽器設定改,所以要看得出 'denied' 這個狀態。
 *
 * 用法:
 *   const push = usePushSubscription(useTripId())
 *   <UiAppButton :loading="push.busy.value" @click="push.subscribe()">開啟提醒</UiAppButton>
 */

/** 為什麼現在還不能訂閱。null = 可以按(或已經訂閱好了)。 */
export type PushBlocker =
  /** 沒有阻礙 */
  | null
  /** 這個瀏覽器沒有 Push API(且不是 iOS 待安裝的情況) */
  | 'no-browser-support'
  /** iOS:要先「分享 → 加到主畫面」,從主畫面開啟才有 Push API */
  | 'needs-install'
  /** 使用者封鎖了通知,只能去系統/瀏覽器設定改 */
  | 'denied'
  /** 伺服器沒有提供 VAPID public key,推播發不出去 */
  | 'no-server-key';

export interface UsePushSubscription {
  /** 這個瀏覽器有沒有 Service Worker + Push + Notification。 */
  supported: ComputedRef<boolean>;
  /** 是不是從主畫面 / 獨立視窗開啟的(iOS 推播的前提)。 */
  standalone: ComputedRef<boolean>;
  /** iOS 上還在 Safari 分頁裡 —— 要先加到主畫面。 */
  needsInstall: ComputedRef<boolean>;
  /** 'default' | 'granted' | 'denied'。不支援時固定是 'default'。 */
  permission: Ref<NotificationPermission>;
  /** 這台裝置已經訂閱了這趟旅程的提醒。 */
  subscribed: Ref<boolean>;
  /** 正在請求權限 / 訂閱 / 上傳訂閱。 */
  busy: Ref<boolean>;
  /** 可以直接顯示的錯誤訊息;沒有錯誤時是空字串。 */
  error: Ref<string>;
  /** 目前擋住訂閱的原因,決定畫面要給哪一段指引。 */
  blocker: ComputedRef<PushBlocker>;
  /** 使用者按下按鈕時呼叫(必須來自點擊手勢,瀏覽器才會跳權限視窗)。 */
  subscribe: () => Promise<boolean>;
  /** 重新確認這台裝置目前的訂閱狀態。 */
  refresh: () => Promise<void>;
}

/** Service Worker 讀 share tripId 的地方(見 app/service-worker/sw.ts 的 readTripId)。 */
const TOKEN_CACHE = 'trip-ledger-meta';
const TOKEN_CACHE_KEY = '/__token';

/** navigator.serviceWorker.ready 在沒有 SW 的環境會永遠 pending,所以要自己設上限。 */
const SW_READY_TIMEOUT_MS = 8000;

/** 目前不存在;存在的話回 { publicKey } / { key } / 純字串都收。 */
const VAPID_ENDPOINT = '/api/vapid-key';

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** VAPID public key 是 base64url,subscribe() 要的是位元組。 */
/*
  回傳型別要寫成 `Uint8Array<ArrayBuffer>`,不能只寫 `Uint8Array`。
  TypeScript 5.7 起 Uint8Array 對 buffer 型別泛型化,裸寫等於 `Uint8Array<ArrayBufferLike>`,
  而 ArrayBufferLike 含 SharedArrayBuffer —— 那不是合法的 BufferSource,
  於是 `pushManager.subscribe({ applicationServerKey })` 兩個多載都對不上。
  `new Uint8Array(length)` 實際產生的就是 ArrayBuffer 版本,所以這只是把事實寫出來。
*/
function decodeVapidKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * 舊訂閱可能是用別把金鑰建的(例如伺服器換過 VAPID key)。
 * 那種訂閱推不出去,而且 subscribe() 會直接丟 InvalidStateError,
 * 所以要先比對、不一樣就退訂再重訂。
 */
function sameApplicationServerKey(existing: ArrayBuffer | null, want: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  if (a.length !== want.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== want[i]) return false;
  }
  return true;
}

/** iPadOS 桌面模式會回報 Macintosh,所以要靠觸控點數補判。 */
function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  if (iosStandalone === true) return true;
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: minimal-ui)').matches;
  }
  catch {
    return false;
  }
}

export function usePushSubscription(tripId: MaybeRefOrGetter<string>): UsePushSubscription {
  const api = useApi();

  const tripToken = computed(() => String(toValue(tripId) ?? '').trim());

  const hasApi = ref(false);
  const isIos = ref(false);
  const isStandalone = ref(false);

  const permission = ref<NotificationPermission>('default');
  const subscribed = ref(false);
  const busy = ref(false);
  const error = ref('');

  /** 'unknown' 代表還沒去問過伺服器 —— 沒必要在每次進頁面時就打一支可能 404 的端點。 */
  const serverKey = ref<'unknown' | 'ready' | 'missing'>('unknown');
  let cachedKey = '';

  const supported = computed(() => hasApi.value);
  const standalone = computed(() => isStandalone.value);
  /** iOS + 還在瀏覽器分頁裡 + 真的沒有 Push API → 就是「還沒加到主畫面」 */
  const needsInstall = computed(() => isIos.value && !isStandalone.value && !hasApi.value);

  const blocker = computed<PushBlocker>(() => {
    if (needsInstall.value) return 'needs-install';
    if (!hasApi.value) return 'no-browser-support';
    if (permission.value === 'denied') return 'denied';
    // 已經訂閱成功的裝置不需要再看到「沒有金鑰」——那是伺服器端的事,不是這台裝置的狀態
    if (serverKey.value === 'missing' && !subscribed.value) return 'no-server-key';
    return null;
  });

  function detectEnvironment(): void {
    isIos.value = detectIos();
    isStandalone.value = detectStandalone();
    hasApi.value = typeof window !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window;
    if (hasApi.value) permission.value = Notification.permission;
  }

  /**
   * 把 share tripId 寫進 cache 給 Service Worker 讀。
   * 寫不進去只代表推播會退回「訂位即將開放」的預設文案,不該讓訂閱本身失敗。
   */
  async function rememberTokenForServiceWorker(value: string): Promise<void> {
    try {
      const store = (globalThis as { caches?: CacheStorage }).caches;
      if (!store || !value) return;
      const cache = await store.open(TOKEN_CACHE);
      await cache.put(TOKEN_CACHE_KEY, new Response(value, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }));
    }
    catch {
      // 無痕模式 / 封鎖網站資料時 caches 會丟錯,忽略
    }
  }

  /**
   * 找 VAPID public key。
   * runtimeConfig.public 先看(不用發請求);再試 /api/vapid-key。
   * 兩邊都沒有就記成 'missing',之後不再重試,畫面改顯示「伺服器還沒設定推播」。
   */
  async function resolveVapidKey(): Promise<string> {
    if (cachedKey) return cachedKey;

    const publicConfig = useRuntimeConfig().public as Record<string, unknown>;
    const fromConfig = firstString(publicConfig.vapidPublicKey, publicConfig.vapid_public_key);
    if (fromConfig) {
      cachedKey = fromConfig;
      serverKey.value = 'ready';
      return cachedKey;
    }

    if (serverKey.value === 'missing') return '';

    try {
      const res = await api.get<unknown>(VAPID_ENDPOINT);
      const key = typeof res === 'string'
        ? firstString(res)
        : firstString(
            (res as Record<string, unknown>)?.publicKey,
            (res as Record<string, unknown>)?.key,
            (res as Record<string, unknown>)?.vapidPublicKey,
            (res as Record<string, unknown>)?.vapid_public_key,
          );
      if (key) {
        cachedKey = key;
        serverKey.value = 'ready';
        return key;
      }
    }
    catch {
      // 端點不存在(404)是預期情況之一,不是要顯示給使用者的錯誤
    }

    serverKey.value = 'missing';
    return '';
  }

  async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
    try {
      const existing = await navigator.serviceWorker.getRegistration();
      if (existing?.active) return existing;
      return await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)),
      ]);
    }
    catch {
      return null;
    }
  }

  /** 這台裝置目前是不是已經訂閱了。 */
  async function refresh(): Promise<void> {
    detectEnvironment();
    if (!hasApi.value) {
      subscribed.value = false;
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      subscribed.value = !!existing && permission.value === 'granted';
      // 訂閱是跟著裝置走的,旅程換了要讓 SW 知道現在該打哪一個 trip 的 due 清單
      if (subscribed.value) await rememberTokenForServiceWorker(tripToken.value);
    }
    catch {
      subscribed.value = false;
    }
  }

  async function requestPermission(): Promise<NotificationPermission> {
    // 舊 Safari 只有 callback 版;新版回 Promise。兩種都接,Promise 會忽略第二次 resolve。
    const result = await new Promise<NotificationPermission>((resolve) => {
      try {
        const maybe = Notification.requestPermission(resolve);
        if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve('denied'));
      }
      catch {
        resolve('denied');
      }
    });
    permission.value = result ?? Notification.permission;
    return permission.value;
  }

  async function subscribe(): Promise<boolean> {
    if (busy.value) return false;
    error.value = '';

    if (!tripToken.value) {
      error.value = '找不到這趟旅程的代碼,請重新從分享連結進來。';
      return false;
    }

    detectEnvironment();
    if (needsInstall.value) {
      error.value = 'iPhone / iPad 要先把這頁「加到主畫面」,從主畫面的圖示打開才能開啟提醒。';
      return false;
    }
    if (!hasApi.value) {
      error.value = '這個瀏覽器不支援網頁推播。開放時間仍會顯示倒數,建議自己再設一個手機鬧鐘。';
      return false;
    }

    busy.value = true;
    try {
      if ((await requestPermission()) !== 'granted') {
        error.value = permission.value === 'denied'
          ? '通知被封鎖了。請到瀏覽器/系統的通知設定把這個網站改成允許,再回來開啟。'
          : '還沒拿到通知權限,請在跳出的視窗選「允許」。';
        return false;
      }

      const registration = await getRegistration();
      if (!registration) {
        error.value = '背景服務還沒準備好。請重新載入頁面後再試一次。';
        return false;
      }

      let subscription = await registration.pushManager.getSubscription();
      const keyText = await resolveVapidKey();

      if (!subscription) {
        if (!keyText) {
          error.value = '伺服器還沒設定推播金鑰(VAPID),提醒暫時發不出來。開放時間仍會顯示倒數。';
          return false;
        }
        subscription = await registration.pushManager.subscribe({
          // 空推播也算「使用者看得到的通知」,一律要 true,否則 Chrome 會拒絕
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(keyText),
        });
      }
      else if (keyText) {
        // 伺服器換過金鑰的話,舊訂閱推不出去 —— 退掉重訂
        const want = decodeVapidKey(keyText);
        if (!sameApplicationServerKey(subscription.options.applicationServerKey, want)) {
          await subscription.unsubscribe().catch(() => {});
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: want,
          });
        }
      }

      const payload = subscription.toJSON();
      if (!payload.endpoint || !payload.keys?.p256dh || !payload.keys?.auth) {
        error.value = '瀏覽器給的訂閱資料不完整,請重新載入頁面再試一次。';
        return false;
      }

      // server 端 ON CONFLICT(endpoint) DO NOTHING,所以重複送同一個 endpoint 是安全的
      await api.post(`/api/trips/${encodeURIComponent(tripToken.value)}/push`, {
        endpoint: payload.endpoint,
        keys: { p256dh: payload.keys.p256dh, auth: payload.keys.auth },
      });

      await rememberTokenForServiceWorker(tripToken.value);
      subscribed.value = true;
      return true;
    }
    catch (e) {
      error.value = api.errorMessage(e, '開啟提醒失敗,請稍後再試一次。');
      return false;
    }
    finally {
      busy.value = false;
    }
  }

  onMounted(() => {
    void refresh();
  });

  // 換旅程(同一個畫面切 tripId)時重新確認,並更新 SW 要打的 trip
  watch(tripToken, (value) => {
    if (value) void refresh();
  });

  return {
    supported,
    standalone,
    needsInstall,
    permission,
    subscribed,
    busy,
    error,
    blocker,
    subscribe,
    refresh,
  };
}
