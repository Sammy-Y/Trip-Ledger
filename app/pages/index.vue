<script setup lang="ts">
/**
 * 旅程列表 —— 概念上等於「打開旅遊資料夾,看到裡面好幾個 Excel」。
 *
 * ⚠️ 這一頁以前列的是資料庫裡**所有**旅程(server 端沒有 WHERE)。
 * 現在 server 只回「這個 session 有權存取的」,所以這裡拿到什麼就顯示什麼,
 * 前端不再做任何過濾 —— 過濾是 server 的責任,在前端補一層只會讓人誤以為安全。
 *
 * 三種身分會看到不同的東西:
 *   已登入      → 自己建立的 + 用連結進去過的
 *   訪客(有過操作)→ 這個瀏覽器用連結解鎖過的,並提示註冊才不會弄丟
 *   全新訪客     → 空的,引導他建立或登入
 */
interface TripRow {
  id: string; name: string; base_currency: string;
  start_date: string | null; end_date: string | null;
  created_at: string;
  /** 'owner' 才看得到 share_token 和刪除鈕 */
  role: 'owner' | 'editor';
  /** owner 才有值 */
  share_token: string | null;
  /** 沒有任何帳號擁有這趟。登入後可以認領 */
  orphan: boolean;
  member_count: number; expense_count: number; last_spent_at: string | null;
}

const api = useApi();
// 解構出來模板才不用寫 .value(和 useTrip 的用法一致)。
// refresh 兩邊都有,所以 auth 這邊改個名。
const { user, isLoggedIn, refresh: refreshAuth, logout } = useAuth();

const { data, pending, error, refresh } = await useAsyncData('trips', () => api.get<TripRow[]>('/api/trips'));
const trips = computed(() => data.value ?? []);

await refreshAuth();

/** 沒登入卻已經有旅程 = 這些資料只綁在這個瀏覽器上,清了就沒了。 */
const atRisk = computed(() => !isLoggedIn.value && trips.value.length > 0);
/** 已登入時才有意義:哪些是還沒收編的無主旅程。 */
const claimable = computed(() => trips.value.filter((t) => t.orphan));

const creating = ref(false);
const showNew = ref(false);
const form = reactive({ name: '', base_currency: 'TWD', members: ['', ''] });
const errorMessage = ref<string | null>(null);

async function createTrip() {
  const name = form.name.trim();
  if (!name || creating.value) return;
  creating.value = true;
  errorMessage.value = null;
  try {
    const res = await api.post<{ id: string }>('/api/trips', {
      name,
      base_currency: form.base_currency,
      members: form.members.map((m) => m.trim()).filter(Boolean),
    });
    await navigateTo(`/t/${res.id}`);
  } catch (e) {
    errorMessage.value = (e as Error).message;
  } finally {
    creating.value = false;
  }
}

const removing = ref<string | null>(null);
const confirmTarget = ref<TripRow | null>(null);

async function removeTrip() {
  const t = confirmTarget.value;
  if (!t) return;
  removing.value = t.id;
  try {
    await api.del(`/api/trips/${t.id}`);
    confirmTarget.value = null;
    await refresh();
  } catch (e) {
    errorMessage.value = (e as Error).message;
  } finally {
    removing.value = null;
  }
}

const claiming = ref<string | null>(null);

/** 把無主旅程收為己有。要登入,所以沒登入時先送去登入頁再回來。 */
async function claim(t: TripRow) {
  if (!isLoggedIn.value) {
    await navigateTo(`/login?redirect=${encodeURIComponent('/')}`);
    return;
  }
  claiming.value = t.id;
  errorMessage.value = null;
  try {
    await api.post(`/api/trips/${t.id}/claim`);
    await refresh();
  } catch (e) {
    errorMessage.value = (e as Error).message;
  } finally {
    claiming.value = null;
  }
}

async function signOut() {
  await logout();
  await refresh();
}

/**
 * 陌生人第一次進來要看到的東西。
 *
 * 沒登入、而且這個瀏覽器一趟旅程都沒有 —— 對這個人來說「我的旅程 /
 * 還沒有任何旅程」是沒有意義的:他還沒有任何資料,那句話只是在描述空集合。
 * 要先回答「這是什麼、為什麼要用」。一旦登入或建了第一趟就換回列表。
 *
 * 刻意不看 pending:setup 裡的兩個 await(旅程列表與 /auth/me)都在首次
 * 渲染前就 resolve,所以不會先閃一下 hero 再跳成列表。
 */
const showHero = computed(() => !isLoggedIn.value && !trips.value.length);

/**
 * 三個賣點。
 *
 * 每一條只講一件事 —— 原本這些話是塞在一段三句話的副標裡,
 * 四個賣點擠在一起讀起來像功能列表,手機上更是一整片灰字。
 *
 * 「不會被混成一個數字」刻意不用「加成」:這個 App 裡「加成」專指匯率加成
 * (fx_markup_pct,刷卡手續費那個),拿它來表達「加在一起」會讓人以為在講手續費。
 */
const HERO_POINTS = [
  '日幣台幣各自結算,不會被混成一個數字',
  '共同花費自動分攤,個人花費只算自己的',
  '旅伴不用註冊,丟連結就能一起記',
];

/** 「3 人 · 47 筆 · 3/13」 */
function subtitle(t: TripRow): string {
  const parts = [`${t.member_count} 人`, `${t.expense_count} 筆`];
  if (t.last_spent_at) parts.push(t.last_spent_at.slice(5).replace('-', '/'));
  return parts.join(' · ');
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-6 space-y-5">
    <!-- 第一次進來的人看到的不是空列表,而是「這是什麼」。理由見 showHero -->
    <section v-if="showHero" class="pb-2 md:py-4">
      <span class="hero-badge">
        <Icon name="lucide:luggage" size="14" />
        旅遊記帳 · 多人分帳
      </span>

      <h1 class="hero-title mt-4 text-3xl font-bold leading-tight tracking-tight md:text-4xl">
        出國花的每一筆,回國前分乾淨
      </h1>

      <p class="hero-sub mt-3 leading-relaxed" style="color: var(--text-muted)">
        誰墊的錢、誰真的用了,分開記 —— 所以算得出誰該給誰多少。
      </p>

      <ul class="mt-5 space-y-2.5">
        <li v-for="point in HERO_POINTS" :key="point" class="flex items-start gap-2.5 text-sm">
          <Icon name="lucide:check" size="16" class="mt-0.5 shrink-0" style="color: var(--credit)" />
          <span>{{ point }}</span>
        </li>
      </ul>

      <div class="mt-7 flex flex-wrap items-center gap-2.5">
        <UiAppButton variant="primary" @click="showNew = true">
          <Icon name="lucide:plus" /> 建立第一趟旅程
        </UiAppButton>
        <NuxtLink to="/login">
          <UiAppButton variant="ghost">登入</UiAppButton>
        </NuxtLink>
      </div>

      <!--
        免註冊是這個產品的賣點,但它有代價,而且代價要在他按下去**之前**講。
        事後才說「你的資料只在這個瀏覽器裡」等於騙他一次。
      -->
      <p class="hero-note mt-6 text-xs leading-relaxed" style="color: var(--text-muted)">
        不用帳號也能開始記 —— 但那樣旅程只存在這個瀏覽器裡,清除資料或換裝置就找不回來。
      </p>
    </section>

    <header v-else class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="text-2xl font-bold">我的旅程</h1>
        <p class="text-sm mt-0.5 truncate" style="color: var(--text-muted)">
          <template v-if="isLoggedIn">{{ user?.display_name }}</template>
          <template v-else>記帳、分帳、看誰欠誰</template>
        </p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <NuxtLink v-if="!isLoggedIn" to="/login">
          <UiAppButton variant="ghost">登入</UiAppButton>
        </NuxtLink>
        <button
          v-else type="button" class="p-2 rounded-lg" style="color: var(--text-muted)"
          aria-label="登出" @click="signOut">
          <Icon name="lucide:log-out" />
        </button>
        <UiAppButton variant="primary" @click="showNew = true">
          <Icon name="lucide:plus" /> 新增
        </UiAppButton>
      </div>
    </header>

    <!--
      沒登入但已經有旅程 —— 這是最容易讓人痛哭失聲的情境:
      清一次瀏覽器資料,整趟的帳就再也找不回來了。所以講得直白一點。
    -->
    <div v-if="atRisk" class="card p-4 flex items-start gap-3">
      <Icon name="lucide:triangle-alert" class="mt-0.5 shrink-0" style="color: var(--debit)" />
      <div class="min-w-0 flex-1 text-sm">
        <p class="font-medium">這些旅程只存在這個瀏覽器裡</p>
        <p class="mt-0.5" style="color: var(--text-muted)">
          清除瀏覽器資料或換一台裝置就找不回來了。建立帳號就能永久保存。
        </p>
        <NuxtLink to="/login?mode=register" class="inline-block mt-2 font-medium" style="color: var(--brand)">
          建立帳號 →
        </NuxtLink>
      </div>
    </div>

    <div v-else-if="isLoggedIn && claimable.length" class="card p-4 text-sm">
      <p class="font-medium">有 {{ claimable.length }} 趟旅程還沒有擁有者</p>
      <p class="mt-0.5" style="color: var(--text-muted)">
        認領之後才能刪除它們,換裝置登入也找得回來。
      </p>
    </div>

    <UiLoadingBlock v-if="pending && !trips.length" :rows="3" />

    <p v-else-if="error" class="card p-4 text-sm" style="color: var(--debit)">
      載入失敗:{{ error.message }}
    </p>

    <UiEmptyState
      v-else-if="!trips.length && !showHero"
      icon="lucide:luggage"
      title="還沒有任何旅程"
      :description="isLoggedIn
        ? '建立第一趟旅程,把行程中的花費記下來,回家就不用再算誰欠誰。'
        : '建立第一趟旅程,或是打開旅伴傳給你的分享連結。'">
      <UiAppButton variant="primary" @click="showNew = true">
        <Icon name="lucide:plus" /> 建立旅程
      </UiAppButton>
    </UiEmptyState>

    <ul v-else class="grid gap-3 md:grid-cols-2">
      <li v-for="t in trips" :key="t.id">
        <div class="card p-4 h-full flex items-start gap-3 transition hover:shadow-sm">
          <NuxtLink :to="`/t/${t.id}`" class="flex items-start gap-3 flex-1 min-w-0">
            <span class="grid place-items-center w-10 h-10 rounded-xl shrink-0"
                  style="background: color-mix(in oklab, var(--brand) 13%, transparent); color: var(--brand)">
              <Icon name="lucide:folder" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block font-semibold truncate">{{ t.name }}</span>
              <span class="block text-sm mt-0.5 tnum" style="color: var(--text-muted)">
                {{ subtitle(t) }}
              </span>
            </span>
          </NuxtLink>

          <!-- 無主旅程:給一個認領的入口,而不是一個按了會 403 的刪除鈕 -->
          <button
            v-if="t.orphan" type="button"
            class="text-sm px-2 py-1 rounded-lg shrink-0 font-medium"
            style="color: var(--brand)"
            :disabled="claiming === t.id"
            :aria-label="`認領 ${t.name}`"
            @click="claim(t)">
            {{ claiming === t.id ? '認領中…' : '認領' }}
          </button>

          <!-- 只有 owner 刪得掉。editor 看不到這個鈕(server 端也會擋) -->
          <button
            v-else-if="t.role === 'owner'" type="button"
            class="p-2 rounded-lg shrink-0" style="color: var(--text-muted)"
            :aria-label="`刪除 ${t.name}`" @click="confirmTarget = t">
            <Icon name="lucide:trash-2" />
          </button>
        </div>
      </li>
    </ul>

    <p v-if="errorMessage && !showNew" class="text-sm" style="color: var(--debit)">{{ errorMessage }}</p>

    <!-- 建立旅程 -->
    <UiAppSheet v-model:open="showNew" title="新的旅程">
      <form class="space-y-4" @submit.prevent="createTrip">
        <UiAppField v-model="form.name" label="旅程名稱" placeholder="例如:2026/03 神戶京都宇治" required />
        <UiAppField
          v-model="form.base_currency" label="本位幣" type="select"
          :options="[{ value: 'TWD', label: '台幣 (TWD)' }, { value: 'JPY', label: '日幣 (JPY)' }]" />
        <div>
          <span class="label">成員</span>
          <div class="space-y-2">
            <input
              v-for="(_, i) in form.members" :key="i" v-model="form.members[i]"
              class="field" :placeholder="`第 ${i + 1} 位`" :aria-label="`成員 ${i + 1}`" />
          </div>
          <button type="button" class="text-sm mt-2" style="color: var(--brand)"
                  @click="form.members.push('')">
            <Icon name="lucide:plus" class="inline" /> 再加一位
          </button>
        </div>
        <p v-if="!isLoggedIn" class="text-sm" style="color: var(--text-muted)">
          你還沒登入。這趟旅程會綁在這個瀏覽器上,換裝置就找不回來了。
        </p>
        <p v-if="errorMessage" class="text-sm" style="color: var(--debit)">{{ errorMessage }}</p>
        <UiAppButton type="submit" variant="primary" block :loading="creating" :disabled="!form.name.trim()">
          建立
        </UiAppButton>
      </form>
    </UiAppSheet>

    <!-- 刪除確認(不用 window.confirm) -->
    <UiAppSheet :open="!!confirmTarget" title="刪除旅程" @update:open="(v) => !v && (confirmTarget = null)">
      <p class="text-sm">
        確定要刪除「{{ confirmTarget?.name }}」嗎?
        這趟的 {{ confirmTarget?.expense_count }} 筆記帳會一併消失,無法復原。
      </p>
      <div class="flex gap-2 mt-4">
        <UiAppButton variant="ghost" block @click="confirmTarget = null">取消</UiAppButton>
        <UiAppButton variant="primary" block :loading="!!removing" @click="removeTrip">刪除</UiAppButton>
      </div>
    </UiAppSheet>
  </div>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換,不寫死 hex、不用 dark: 前綴 */

/* 標題上方那顆小標。用 brand 的低透明度底色而不是實色 ——
   它是定位說明,不該比下面的標題還搶眼。 */
.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
}

/* 標題與副標的折行。
   `pretty` 會避免行末留下孤字 —— 375px 下副標原本折成「…分開記 —— 所 / 以算得出…」,
   把「所以」拆開讀起來會頓一下,而 hero 是整頁最多人看的文字。
   不支援的瀏覽器會忽略它,只是回到預設折行,不影響版面。 */
.hero-title,
.hero-sub {
  text-wrap: pretty;
}

/* 免註冊的代價那句。用上分隔線而不是加重字色 ——
   它是註腳的地位,但必須看得到,不能被當成裝飾略過。 */
.hero-note {
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
</style>
