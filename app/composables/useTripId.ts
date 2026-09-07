import type { ComputedRef, Ref } from 'vue';

/**
 * 目前路由的旅程識別碼(/t/[trip] 的那一段)。
 *
 * 這一段通常是 trip id(從旅程列表點進來),但 server 的 requireTrip 也接受
 * share_token —— 舊的分享連結不會壞。所以這裡不假設格式,原樣傳給 API。
 * 所有 /t/[trip]/* 的畫面都靠這個 composable 取識別碼,
 * 不要各自去讀 route.params —— 路由結構要調整時才只有這一處要改。
 *
 * 不在旅程頁的路由(例如進入頁 /)回傳空字串,
 * 呼叫端用 `if (!tripId.value) return` 判斷即可,不必處理 undefined。
 */
export function useTripId(): ComputedRef<string> {
  const route = useRoute();
  return computed(() => {
    const raw = route.params.trip;
    const tripId = Array.isArray(raw) ? raw[0] : raw;
    return typeof tripId === 'string' ? tripId : '';
  });
}

/** 存在 localStorage 裡的「最近開啟的旅程」。 */
export interface RecentTrip {
  /** 旅程識別碼,即 /t/[trip] 的那一段 */
  id: string;
  /** 旅程名稱。首次記錄時可能還沒拿到,之後由外框補上 */
  name: string;
  /** 上次開啟時間(ISO 8601 字串),用來排序 */
  opened_at: string;
}

export interface UseRecentTrips {
  /** 依上次開啟時間新 → 舊排序 */
  recent: ComputedRef<RecentTrip[]>;
  /** 記住(或更新)一趟旅程;同 tripId 會就地更新名稱並移到最前面 */
  remember: (tripId: string, name?: string) => void;
  /** 從清單移除 */
  forget: (tripId: string) => void;
}

const RECENT_KEY = 'trip-ledger:recent-trips';
const RECENT_MAX = 8;

/**
 * 把 localStorage 讀回來的東西洗成可信任的形狀。
 * 舊版格式、被別的程式覆寫、手動改壞 —— 一律當成沒資料,不要讓進入頁掛掉。
 */
function sanitize(raw: unknown): RecentTrip[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentTrip[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<RecentTrip>;
    if (typeof r.id !== 'string' || !r.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : '',
      opened_at: typeof r.opened_at === 'string' ? r.opened_at : '',
    });
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

/**
 * 全域共用同一份狀態(createGlobalState 會把 ref 建在獨立的 effect scope,
 * 所以跨頁面切換不會重建、也不會隨某個元件卸載而失去跨分頁同步)。
 */
const useRecentTripsStore = createGlobalState((): Ref<RecentTrip[]> => {
  try {
    return useLocalStorage<RecentTrip[]>(RECENT_KEY, [], {
      // localStorage 有可能整個不能用:Safari 無痕、企業政策、瀏覽器封鎖網站資料。
      // useStorage 內部已經 try/catch 並在失敗時呼叫 onError,這裡吞掉錯誤 ——
      // ref 會退化成純記憶體狀態,少了「下次回來還記得」但畫面照樣正常。
      onError: () => {},
      serializer: {
        read: (value: string) => {
          try {
            return sanitize(JSON.parse(value));
          } catch {
            return [];
          }
        },
        write: (value: RecentTrip[]) => JSON.stringify(value),
      },
    });
  } catch {
    return ref<RecentTrip[]>([]);
  }
});

/**
 * 最近開啟過的旅程。進入頁用它列出捷徑,外框(default layout)在進入
 * 某趟旅程時用 remember() 把它記下來 —— 所以直接貼連結進來也會被記住。
 */
export function useRecentTrips(): UseRecentTrips {
  const store = useRecentTripsStore();

  const recent = computed<RecentTrip[]>(() =>
    [...store.value].sort((a, b) => (b.opened_at || '').localeCompare(a.opened_at || '')));

  function remember(tripId: string, name?: string): void {
    if (!tripId) return;
    const previous = store.value.find((t) => t.id === tripId);
    // 名稱可能還沒載到(第一次寫入時),別用空字串蓋掉已經記住的名稱
    const resolvedName = (name || previous?.name || '').trim();
    const next: RecentTrip = { id: tripId, name: resolvedName, opened_at: new Date().toISOString() };
    // 已經是同一筆、名稱也沒變 → 不寫入,免得每次 render 都動 localStorage
    if (previous && previous.name === resolvedName && store.value[0]?.id === tripId) {
      const age = Date.now() - Date.parse(previous.opened_at || '');
      if (Number.isFinite(age) && age < 60_000) return;
    }
    store.value = [next, ...store.value.filter((t) => t.id !== tripId)].slice(0, RECENT_MAX);
  }

  function forget(tripId: string): void {
    store.value = store.value.filter((t) => t.id !== tripId);
  }

  return { recent, remember, forget };
}
