/**
 * useApi —— 全站唯一的 API 進出口。
 *
 * 為什麼要包一層:
 *  1. server 端錯誤是用 createError({ statusCode, statusMessage }) 丟出來的,
 *     $fetch 收到後會塞在 err.data.statusMessage 裡,直接 {{ err }} 出來是一坨物件。
 *     這裡統一抽成「可以直接印在畫面上的中文字串」。
 *  2. 網路斷線 / 逾時 / 500 這些沒有 statusMessage 的情況,也要有像人話的訊息。
 *
 * 用法:
 *   const { get, post, del } = useApi()
 *   const list = await get<Expense[]>(`/api/trips/${tripId}/expenses`, { kind: 'shared' })
 *   try { await post(`/api/trips/${tripId}/expenses`, payload) }
 *   catch (e) { errorMsg.value = (e as Error).message }   // 已經是可顯示的訊息
 */

/** 送出去的 query string 參數。undefined / null 會被自動略掉。 */
export type ApiQuery = Record<string, string | number | boolean | null | undefined>;

/**
 * 所有從 useApi 丟出來的錯誤都是這個型別。
 * message 保證是「可以直接顯示給使用者看」的字串,不需要再加工。
 */
export class ApiError extends Error {
  /** HTTP 狀態碼。0 代表請求根本沒送到(斷網、CORS、逾時)。 */
  readonly statusCode: number;
  /** server 回傳的原始 body,debug 用。 */
  readonly data: unknown;

  constructor(message: string, statusCode = 0, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

/**
 * HTTP 的預設 reason phrase。這些字串等於「server 沒有給我們有用的訊息」,
 * 所以要換成下面那組中文說明。
 */
const GENERIC_REASONS = new Set([
  'bad request', 'unauthorized', 'payment required', 'forbidden', 'not found',
  'method not allowed', 'not acceptable', 'request timeout', 'conflict', 'gone',
  'unprocessable entity', 'too many requests', 'internal server error',
  'not implemented', 'bad gateway', 'service unavailable', 'gateway timeout',
  'error', 'fetch failed', 'failed to fetch', 'load failed', 'networkerror',
  // Nitro 沒被攔截的例外(例如 D1 丟出來的 SQL 錯誤)statusMessage 就是這句。
  // 少了它,使用者按下儲存會看到一個英文的「Server Error」——
  // 那既沒說明發生什麼事,也沒告訴他該怎麼辦。
  'server error',
]);

/** 沒有 statusMessage 可用時,依狀態碼給的說明。 */
function fallbackForStatus(statusCode: number): string | undefined {
  if (statusCode === 0) {
    // import.meta.client 之外(理論上不會發生,SPA 全在 client)就不猜
    if (import.meta.client && typeof navigator !== 'undefined' && navigator.onLine === false) {
      return '目前沒有網路連線,連上網之後再試一次。';
    }
    return '連不上伺服器,請檢查網路連線後再試一次。';
  }
  if (statusCode === 400 || statusCode === 422) return '送出的資料有問題,請檢查各欄位後再送出。';
  if (statusCode === 401 || statusCode === 403) return '沒有權限存取這個旅程。';
  if (statusCode === 404) return '找不到資料。請確認分享連結 / share tripId 是否正確。';
  if (statusCode === 408 || statusCode === 504) return '連線逾時,請再試一次。';
  if (statusCode === 429) return '操作太頻繁,請稍等一下再試。';
  if (statusCode >= 500) return '伺服器出了點狀況,請稍後再試一次。';
  return undefined;
}

function firstUsefulString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const s = c.trim();
    if (!s) continue;
    if (GENERIC_REASONS.has(s.toLowerCase())) continue;
    // ofetch 的原始 message 長這樣: [POST] "/api/x": 400 Bad Request —— 不給使用者看
    if (/^\[[A-Z]+\]\s/.test(s)) continue;
    return s;
  }
  return undefined;
}

/** DOMException 的 name 可能在 error 上,也可能被 ofetch 包進 cause 裡。 */
function errorNames(e: unknown): string[] {
  if (!e || typeof e !== 'object') return [];
  const anyE = e as { name?: unknown; cause?: { name?: unknown } };
  return [anyE.name, anyE.cause?.name].filter((n): n is string => typeof n === 'string');
}

/** 請求被取消(元件卸載、tripId 換掉導致 useAsyncData 重抓)。這不是錯誤,不該顯示。 */
export function isAbortError(e: unknown): boolean {
  return errorNames(e).includes('AbortError');
}

function isTimeoutError(e: unknown): boolean {
  return errorNames(e).includes('TimeoutError');
}

function readStatusCode(e: unknown): number {
  if (!e || typeof e !== 'object') return 0;
  const anyE = e as Record<string, unknown>;
  const raw = anyE.statusCode ?? anyE.status
    ?? (anyE.response as Record<string, unknown> | undefined)?.status
    ?? (anyE.data as Record<string, unknown> | undefined)?.statusCode;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把任何東西($fetch 的 FetchError、useFetch/useAsyncData 的 NuxtError、
 * ApiError、隨便一個 Error、甚至字串)轉成可以直接顯示的訊息。
 *
 * useTrip 之外的 useFetch/useAsyncData 也可以拿這個來處理 error.value。
 */
export function apiErrorMessage(e: unknown, fallback = '發生未知的錯誤,請稍後再試。'): string {
  if (e == null) return fallback;
  if (typeof e === 'string') return firstUsefulString(e) ?? fallback;
  if (e instanceof ApiError) return e.message;
  if (isTimeoutError(e)) return '連線逾時。網路好像不太穩,請再試一次。';

  const anyE = e as Record<string, unknown>;
  const rawData = anyE.data;
  // server 回傳的 body。h3 的錯誤 body 是 { statusCode, statusMessage, message }
  const body = (rawData && typeof rawData === 'object' ? rawData : {}) as Record<string, unknown>;
  const statusCode = readStatusCode(e);

  /**
   * 5xx 分兩種,而且只有 statusMessage 分得出來:
   *   - server 自己丟的(createError({ statusCode: 500, statusMessage: '算出非法的轉帳金額…' }))
   *     → statusMessage 是寫給使用者看的中文,照顯示。
   *   - **沒被攔截的例外**(D1 的 SQL 錯誤之類)→ statusMessage 是 Nitro 補的
   *     'Server Error',而 body.message 是例外原文
   *     (「D1_ERROR: UNIQUE constraint failed: expense_shares…」)。
   *     那是給開發者看的,絕不能丟到使用者臉上 —— 他既看不懂也無能為力,
   *     這種情況要退回「伺服器出了點狀況,請稍後再試」。
   * 所以 5xx 時只信 statusMessage,不看 message。
   */
  const serverFault = statusCode >= 500;

  // 優先序:server 明確給的 statusMessage > body 的 message > error 物件本身的欄位
  // (注意 FetchError.statusMessage 讀的是 HTTP statusText,中文會被 h3 過濾掉,
  //  所以一定要先看 body.statusMessage)
  const explicit = firstUsefulString(
    body.statusMessage,
    serverFault ? undefined : body.message,
    serverFault ? undefined : (typeof rawData === 'string' ? rawData : undefined),
    anyE.statusMessage,
    serverFault ? undefined : anyE.message,
  );
  return explicit ?? fallbackForStatus(statusCode) ?? fallback;
}

/** 把任何錯誤正規化成 ApiError(message 已可顯示)。 */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const err = new ApiError(apiErrorMessage(e), readStatusCode(e), (e as { data?: unknown })?.data);
  if (e instanceof Error) err.stack = e.stack;
  return err;
}

/** 去掉 undefined / null,避免 query 出現 kind=undefined。 */
function cleanQuery(query?: ApiQuery): Record<string, string | number | boolean> | undefined {
  if (!query) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface ApiClient {
  /** GET。query 會自動清掉 undefined/null/空字串。 */
  get: <T>(url: string, query?: ApiQuery) => Promise<T>;
  /** POST JSON。 */
  post: <T>(url: string, body?: unknown) => Promise<T>;
  /** PATCH JSON(部分更新,例如改成員名字)。 */
  patch: <T>(url: string, body?: unknown) => Promise<T>;
  /** DELETE。 */
  del: <T>(url: string, query?: ApiQuery) => Promise<T>;
  /** 手動把別處(例如 useFetch)的錯誤轉成可顯示訊息。 */
  errorMessage: (e: unknown, fallback?: string) => string;
}

export function useApi(): ApiClient {
  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    opts: { query?: ApiQuery; body?: unknown } = {},
  ): Promise<T> {
    try {
      return await $fetch<T>(url, {
        method,
        query: cleanQuery(opts.query),
        body: opts.body as Record<string, unknown> | undefined,
        // 預設不重試。記帳是寫入操作,重試會變成重複記一筆。
        retry: 0,
        timeout: 15_000,
      });
    }
    catch (e) {
      // 被取消的請求原封不動丟回去 —— useAsyncData 靠 DOMException 判斷「這是取消不是失敗」,
      // 包成 ApiError 會讓它誤判成錯誤,畫面就會閃出一個假的錯誤訊息。
      if (isAbortError(e)) throw e;
      throw toApiError(e);
    }
  }

  return {
    get: <T>(url: string, query?: ApiQuery) => request<T>('GET', url, { query }),
    post: <T>(url: string, body?: unknown) => request<T>('POST', url, { body }),
    patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, { body }),
    del: <T>(url: string, query?: ApiQuery) => request<T>('DELETE', url, { query }),
    errorMessage: apiErrorMessage,
  };
}
