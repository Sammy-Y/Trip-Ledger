import type { ComputedRef } from 'vue';

/**
 * 登入狀態。
 *
 * 為什麼用 useState 而不是 ref:外框(default layout)和頁面都要知道
 * 現在是誰,兩邊必須看同一份。useState 的 key 保證全站只有一份實例。
 *
 * ⚠️ 這裡的東西**只用來決定畫面顯示什麼**,不是安全邊界。
 * 真正的權限在 server 端(server/utils/trip.ts 的 resolveTripAccess)。
 * 前端把 role 改成 'owner' 不會讓任何 API 多放行一個位元組。
 */

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
}

export interface UseAuth {
  user: ComputedRef<AuthUser | null>;
  isLoggedIn: ComputedRef<boolean>;
  /** 還沒問過 server「我是誰」。用來避免畫面先閃一下「未登入」再跳成登入。 */
  pending: ComputedRef<boolean>;
  /** 問一次 server 目前是誰。重複呼叫會共用同一個請求。 */
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (email: string, password: string, displayName?: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

export function useAuth(): UseAuth {
  const api = useApi();
  const user = useState<AuthUser | null>('auth:user', () => null);
  const loaded = useState<boolean>('auth:loaded', () => false);
  const inflight = useState<Promise<void> | null>('auth:inflight', () => null);

  async function refresh(): Promise<void> {
    // 外框和頁面會在同一個 tick 各叫一次,這裡讓後到的沿用前一個請求。
    if (inflight.value) return inflight.value;
    const p = (async () => {
      try {
        const res = await api.get<{ user: AuthUser | null }>('/api/auth/me');
        user.value = res.user;
      } catch {
        // 問不到就當作沒登入。這支不該讓整個畫面掛掉 ——
        // 沒登入的人本來就能用 share_token 記帳。
        user.value = null;
      } finally {
        loaded.value = true;
        inflight.value = null;
      }
    })();
    inflight.value = p;
    return p;
  }

  async function login(email: string, password: string): Promise<AuthUser> {
    const u = await api.post<AuthUser>('/api/auth/login', { email, password });
    user.value = u;
    loaded.value = true;
    return u;
  }

  async function register(email: string, password: string, displayName?: string): Promise<AuthUser> {
    const u = await api.post<AuthUser>('/api/auth/register', {
      email, password, display_name: displayName,
    });
    user.value = u;
    loaded.value = true;
    return u;
  }

  async function logout(): Promise<void> {
    await api.post('/api/auth/logout');
    user.value = null;
    // 登出後「我的旅程」一定要重抓 —— 否則畫面上還留著上一個人的列表。
    await refreshNuxtData('trips');
  }

  return {
    user: computed(() => user.value),
    isLoggedIn: computed(() => !!user.value),
    pending: computed(() => !loaded.value),
    refresh,
    login,
    register,
    logout,
  };
}
