<script setup lang="ts">
/**
 * 旅程列表 —— 概念上等於「打開旅遊資料夾,看到裡面好幾個 Excel」。
 *
 * ⚠️ 這一頁以前列的是資料庫裡**所有**旅程(server 端沒有 WHERE)。
 * 現在 server 只回「這個 session 有權存取的」,所以這裡拿到什麼就顯示什麼,
 * 前端不再做任何過濾 —— 過濾是 server 的責任,在前端補一層只會讓人誤以為安全。
 *
 * 三種身分會看到不同的東西:
 *   已登入   → 自己建立的 + 用連結進去過的
 *   訪客     → 只有用分享連結解鎖過的那幾趟(他不能建立新的,見下)
 *   全新訪客 → 空的,引導他登入
 *
 * ── 那段文案為什麼一直留著 ─────────────────────────────────
 *
 * 標題與三條賣點對已登入的人也留在旅程列表上方,不是只給陌生人看的 landing。
 * 理由是這個 App 的核心主張("誰墊的錢和誰真的用了是兩件事")本身就是使用者
 * 每次回來要重新想起的東西 —— 它解釋了為什麼記帳表單要分「付款人」和「分攤」
 * 兩區、為什麼結算頁要逐幣別分開。把它藏在只有陌生人看得到的地方,
 * 等於這個產品最重要的一句話只講一次。
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

/**
 * 訪客手上的那幾趟只綁在這個瀏覽器的 session 上。
 *
 * 現在建立旅程一定要登入,所以訪客列表裡的旅程一定是**別人的**、
 * 靠分享連結解鎖進來的 —— 清掉瀏覽器資料不會弄丟任何帳(owner 那邊都在),
 * 只是要再開一次那條連結。所以這句提示的語氣要比以前輕:
 * 以前匿名建立的旅程真的會永久消失,那是「痛哭失聲」級別;現在不是。
 */
const guestList = computed(() => !isLoggedIn.value && trips.value.length > 0);
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
/**
 * 認領無主旅程。
 *
 * 建立旅程現在要登入,所以**不會再有新的**無主旅程 —— 這條路徑只服務
 * 那個規則上線前建立的那幾趟(進得去、記得帳,但沒有 owner 所以誰都刪不掉)。
 * 全部認領完之後這段程式碼就沒有使用者了,但留著:它是那些既有資料
 * 唯一的出口,而 server 端的 /claim 也還在。
 */
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
 * **永遠顯示**(登入與否都一樣),理由見檔頭那段。
 * 差別只在下面接的是「登入 / 建立帳號」還是旅程列表。
 *
 * 刻意不看 pending:setup 裡的兩個 await(旅程列表與 /auth/me)都在首次
 * 渲染前就 resolve,所以不會先閃一下再跳。
 */

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
    <!--
      標題與三條賣點:登入與否都顯示。理由見檔頭 ——
      它解釋了為什麼記帳表單要分「付款人」和「分攤」、為什麼結算逐幣別分開,
      那是使用者每次回來都要重新想起的東西,不是只給陌生人看的招牌。
    -->
    <section :class="isLoggedIn ? 'pb-1' : 'pb-2 md:py-4'">
      <div class="flex items-start justify-between gap-3">
        <span class="hero-badge">
          <Icon name="lucide:luggage" size="14" />
          旅遊記帳 · 多人分帳
        </span>
        <!-- 登入後帳號的出入口收在這裡,不另外開一列 header -->
        <div v-if="isLoggedIn" class="flex shrink-0 items-center gap-2">
          <span class="max-w-[10rem] truncate text-sm" style="color: var(--text-muted)">
            {{ user?.display_name }}
          </span>
          <button
            type="button" class="rounded-lg p-2" style="color: var(--text-muted)"
            aria-label="登出" @click="signOut"
          >
            <Icon name="lucide:log-out" size="18" />
          </button>
        </div>
      </div>

      <h1
        class="hero-title mt-4 font-bold leading-tight tracking-tight"
        :class="isLoggedIn ? 'text-2xl md:text-3xl' : 'text-3xl md:text-4xl'"
      >
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

      <!--
        沒登入時這裡是唯一的出口 —— **不再有「不用帳號也能開始記」**。
        建立旅程現在要登入(理由見 server/api/trips/index.post.ts 的長註解):
        匿名建立會生出沒有 owner、誰都刪不掉、建立者換個分頁就找不到的旅程。
        但第三條賣點「旅伴不用註冊」仍然成立 —— 那是**加入別人的**旅程,
        持有分享連結本身就是憑證,和「開一趟新的」是兩件風險不同的事。
      -->
      <div v-if="!isLoggedIn" class="mt-7 flex flex-wrap items-center gap-2.5">
        <NuxtLink to="/login?mode=register">
          <UiAppButton variant="primary" icon="lucide:user-plus">
            建立帳號
          </UiAppButton>
        </NuxtLink>
        <NuxtLink to="/login">
          <UiAppButton variant="ghost">登入</UiAppButton>
        </NuxtLink>
      </div>

      <div v-else class="mt-6">
        <UiAppButton variant="primary" icon="lucide:plus" @click="showNew = true">
          新的旅程
        </UiAppButton>
      </div>

      <p
        v-if="!isLoggedIn"
        class="hero-note mt-6 text-xs leading-relaxed"
        style="color: var(--text-muted)"
      >
        旅伴收到分享連結的話不用註冊,直接點開就能一起記帳 —— 帳號只有開新旅程的人需要。
      </p>
    </section>

    <!--
      訪客手上的旅程一定是**別人的**(建立要登入),靠分享連結解鎖進來的。
      所以清掉瀏覽器資料不會弄丟任何帳 —— owner 那邊都在,只是要再開一次連結。
      語氣因此比以前輕:以前匿名建立的旅程真的會永久消失。
    -->
    <div v-if="guestList" class="card flex items-start gap-3 p-4">
      <Icon name="lucide:info" class="mt-0.5 shrink-0" style="color: var(--text-muted)" />
      <div class="min-w-0 flex-1 text-sm">
        <p class="font-medium">你正在用訪客身分</p>
        <p class="mt-0.5" style="color: var(--text-muted)">
          這幾趟是靠分享連結進來的,只記在這個瀏覽器裡 ——
          換裝置或清除資料之後要再開一次那條連結。
          有帳號的話自己的旅程就會跟著你走。
        </p>
        <NuxtLink to="/login?mode=register" class="mt-2 inline-block font-medium" style="color: var(--brand)">
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

    <!--
      只有**已登入**且還沒有旅程的人需要這一塊。
      沒登入的人上面 hero 的「建立帳號 / 登入」就是他的下一步,
      再畫一個「建立旅程」的空狀態只會給他一顆按了會被 401 擋掉的鈕。

      ⚠️ 這裡**刻意不放按鈕**。它出現的條件是「已登入且沒有旅程」,
      而那個條件成立的時候,上面 hero 的「新的旅程」一定也在畫面上
      (它對已登入的人是常駐的)—— 兩顆功能一模一樣的主要按鈕同時出現,
      使用者得先判斷它們是不是同一件事。留說明、不留鈕:
      這一塊的價值是那段文字(講清楚一趟旅程是什麼、分享連結怎麼用),
      按鈕本來就在上面。
    -->
    <UiEmptyState
      v-else-if="!trips.length && isLoggedIn"
      icon="lucide:luggage"
      title="還沒有任何旅程"
      description="用上面的「新的旅程」開一趟,把行程中的花費記下來,回家就不用再算誰欠誰。
        建好之後把分享連結丟給旅伴,他們不用註冊就能一起記。"
    />

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
