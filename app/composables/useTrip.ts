import type { MaybeRefOrGetter } from 'vue';
import type { Member, Trip } from '~~/shared/types';

/**
 * useTrip —— 旅程本身 + 成員名單。
 *
 * 幾乎每個畫面都需要「把 member_id 換成名字」,所以這件事集中在這裡做一次,
 * 不要各頁自己再打一次 /api/trips/:trip。
 *
 * 用 useAsyncData + 以 tripId 當 key,所以:
 *  - 同一個 tripId 在同一頁被多個元件(layout + page)呼叫時共用同一份資料、只打一次 API
 *  - tripId 變了會自動重新抓
 *  - 新增成員後呼叫 refresh() 就會更新,且所有用到的元件同步更新
 *
 * 用法:
 *   const route = useRoute()
 *   const { trip, members, memberName, pending, error, refresh } = useTrip(() => route.params.trip as string)
 */

/** 換匯加成的預設值(%)。來源是 server 的 runtimeConfig,前端不另外複製一份。 */
export interface FxDefaults {
  cash_spread_pct: number;
  card_fee_pct: number;
}

export interface TripPayload {
  trip: Trip;
  members: Member[];
  fx_defaults?: FxDefaults;
}

/** server 還沒回來之前先用這組,畫面不會閃一下空白 */
const FX_FALLBACK: FxDefaults = { cash_spread_pct: 1.5, card_fee_pct: 1.5 };

/** memberName 查不到時的預設顯示字串。 */
const UNKNOWN_MEMBER = '未知成員';

export function useTrip(tripId: MaybeRefOrGetter<string>) {
  const api = useApi();

  /** 正規化後的 tripId(去空白)。空字串代表還沒有 tripId,不要打 API。 */
  const tripToken = computed(() => String(toValue(tripId) ?? '').trim());
  const hasToken = computed(() => tripToken.value.length > 0);

  const state = useAsyncData<TripPayload | null>(
    // 反應式 key:tripId 換了 Nuxt 會自己重新執行,且同 key 共用快取
    () => `trip:${tripToken.value}`,
    () => api.get<TripPayload>(`/api/trips/${encodeURIComponent(tripToken.value)}`),
    {
      // 沒有 tripId 就不要發請求(例如首頁還沒輸入)
      enabled: hasToken,
      default: () => null,
      // trip / members 是整包換掉,不需要深層響應
      deep: false,
      // layout 和 page 會同時呼叫 useTrip:'defer' 讓後到的那個共用同一個請求,
      // 而不是把前一個取消再發一次(預設 'cancel' 會打兩次)
      dedupe: 'defer',
    },
  );

  /**
   * 手動重抓。刻意用 'cancel':新增成員後一定要拿到最新結果,
   * 不能沿用可能已經在路上的舊請求。
   */
  function refresh(): Promise<void> {
    return state.refresh({ dedupe: 'cancel' });
  }

  const trip = computed<Trip | null>(() => state.data.value?.trip ?? null);
  const members = computed<Member[]>(() => state.data.value?.members ?? []);

  /** 公費(is_pot = 1)。沒設定的話是 null。一趟最多一個,由資料庫的 unique index 保證。 */
  const pot = computed<Member | null>(() => members.value.find(m => m.is_pot) ?? null);
  /** 真正的「人」—— 分攤名單要用這個,公費不該是受益人。 */
  const people = computed<Member[]>(() => members.value.filter(m => !m.is_pot));

  const fxDefaults = computed<FxDefaults>(() => state.data.value?.fx_defaults ?? FX_FALLBACK);

  /** id -> name 的查表。members 變了才重算。 */
  const memberMap = computed<Map<string, string>>(
    () => new Map(members.value.map(m => [m.id, m.name])),
  );

  /**
   * 把 member_id 轉成名字。這是其他畫面最常用的東西。
   * 查不到(成員被刪、資料還沒載完)會回 fallback,絕對不會回 undefined,
   * 所以模板裡可以直接 {{ memberName(p.member_id) }}。
   */
  function memberName(id: string | null | undefined, fallback = UNKNOWN_MEMBER): string {
    if (!id) return fallback;
    return memberMap.value.get(id) ?? fallback;
  }

  /** 頭像用的一個字。用名字的第一個字(中文名很短,取第一個字最好認)。 */
  function memberInitial(id: string | null | undefined): string {
    const name = memberName(id, '');
    return name ? [...name][0]! : '?';
  }

  return {
    /** 旅程本身。載入中或失敗時是 null。 */
    trip,
    /** 成員名單,公費排在最後(server 端 ORDER BY is_pot, name)。載入中是 []。 */
    members,
    /** 公費成員本身;這趟沒設公費時是 null。 */
    pot,
    /** 扣掉公費之後真正的人。分攤名單一律用這個。 */
    people,
    /** 換匯加成的預設值(%),來自 server 設定。 */
    fxDefaults,
    /** member_id -> 名字。查不到回 '未知成員'(可用第二個參數換 fallback)。 */
    memberName,
    /** member_id -> 名字的第一個字,畫頭像用。 */
    memberInitial,
    /** Map<member_id, name>,需要自己遍歷時用。 */
    memberMap,
    /** 正在載入。第一次載入與 refresh 都會是 true。 */
    pending: computed(() => state.status.value === 'pending'),
    /** 可以直接顯示的錯誤訊息字串;沒錯誤時是 null。原始物件在 rawError。 */
    error: computed<string | null>(() => {
      const e = state.error.value;
      // 被取消的請求(換 tripId / 離開頁面)不是錯誤,不要顯示
      if (!e || isAbortError(e)) return null;
      return api.errorMessage(e);
    }),
    /** 原始 NuxtError,需要看 statusCode 時用(例如 404 要導回首頁)。 */
    rawError: state.error,
    /** 'idle' | 'pending' | 'success' | 'error'。idle = 還沒有 tripId。 */
    status: state.status,
    /** 重新抓 trip + members。新增/刪除成員後要呼叫。 */
    refresh,
    /** 目前用的 tripId(已去空白)。 */
    tripToken,
    /** 有沒有 tripId 可用。沒有的話 status 會停在 idle。 */
    hasToken,
  };
}
