<script setup lang="ts">
/**
 * 整體外框。
 *
 * 手機(< md):頂部細標頭(旅程名 + 分享)+ 固定在底部的 tab bar,
 *              主要動作留在拇指可及的下緣 —— 這是站在店門口單手操作的工具。
 * md 以上   :左側 240px 直向 rail(品牌 / 旅程名 / 導覽 / 分享),底部 tab bar 隱藏。
 *
 * 沒有 tripId 的路由(例如進入頁 /)不顯示任何導覽,內容區也不留 rail 的位置。
 */
const route = useRoute();
const tripId = useTripId();

/** 有 tripId 才代表「在某趟旅程裡」,才需要導覽 */
const inTrip = computed(() => !!tripId.value);

// useTrip 以 tripId 當 useAsyncData 的 key,所以 layout 和 page 同時呼叫
// 也只會打一次 API、看到同一份資料。沒有 tripId 時它自己不會發請求。
const { trip, pending } = useTrip(tripId);

const tripName = computed(() => trip.value?.name?.trim() || '');
/** 名稱還在路上時顯示骨架,不要讓標頭空一下再跳出文字 */
const tripLoading = computed(() => pending.value && !tripName.value);
/** 載不到名稱時的替代標題:至少讓使用者看得出自己在哪趟旅程 */
const tripFallback = computed(() => (tripId.value ? `旅程 ${tripId.value.slice(0, 6)}` : '旅遊記帳'));

// 進到任何旅程頁就記進「最近開啟」—— 直接貼連結進來的人也會被記住,
// 下次回進入頁就有一鍵回去的捷徑。
const { remember } = useRecentTrips();
watch(
  [tripId, tripName],
  ([currentToken, currentName]) => {
    if (currentToken) remember(currentToken, currentName);
  },
  { immediate: true },
);

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const nav = computed<NavItem[]>(() => {
  const base = `/t/${tripId.value}`;
  return [
    { to: base, label: '支出', icon: 'lucide:receipt-text' },
    { to: `${base}/new`, label: '記一筆', icon: 'lucide:circle-plus' },
    { to: `${base}/settle`, label: '結算', icon: 'lucide:scale' },
    { to: `${base}/plan`, label: '預約', icon: 'lucide:calendar-clock' },
    { to: `${base}/members`, label: '成員', icon: 'lucide:users' },
  ];
});

/**
 * 支出列表是預設頁,只在完全相符時 active(否則每一頁都會把它一起點亮);
 * 其餘頁允許底下再長出子路由(例如日後的支出詳情頁)。
 */
function isActive(to: string): boolean {
  const trim = (p: string) => p.replace(/\/+$/, '') || '/';
  const path = trim(route.path);
  const target = trim(to);
  if (target === trim(`/t/${tripId.value}`)) return path === target;
  return path === target || path.startsWith(`${target}/`);
}

// ── 分享連結 ────────────────────────────────────────────────
type ShareState = 'idle' | 'copied' | 'error';
const shareState = ref<ShareState>('idle');
let shareTimer: ReturnType<typeof setTimeout> | undefined;

const SHARE_UI: Record<ShareState, { icon: string; label: string; short: string; tone: string }> = {
  idle: { icon: 'lucide:link', label: '分享連結', short: '分享', tone: '' },
  copied: { icon: 'lucide:check', label: '已複製連結', short: '已複製', tone: 'text-[var(--credit)]' },
  error: { icon: 'lucide:triangle-alert', label: '複製失敗,請手動複製網址', short: '失敗', tone: 'text-[var(--warn)]' },
};
const shareUi = computed(() => SHARE_UI[shareState.value]);

/** navigator.clipboard 只在 HTTPS / localhost 可用,失敗就走 execCommand 後路 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function legacyCopy(text: string): boolean {
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.top = '0';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

async function copyShareLink(): Promise<void> {
  // 複製當前頁網址 —— 旅伴點進來會落在同一個畫面,而且每頁都有導覽可以走去別處
  const url = window.location.href;
  const ok = (await writeClipboard(url)) || legacyCopy(url);
  shareState.value = ok ? 'copied' : 'error';
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    shareState.value = 'idle';
  }, 2400);
}

onBeforeUnmount(() => clearTimeout(shareTimer));
</script>

<template>
  <div class="min-h-[100dvh] bg-[var(--bg)]">
    <!-- ───────── md 以上:左側直向 rail ───────── -->
    <aside
      v-if="inTrip"
      class="hidden md:fixed md:inset-y-0 md:left-0 md:z-30 md:flex md:w-60 md:flex-col
             md:overflow-y-auto md:overscroll-contain
             md:border-r md:border-[var(--border)] md:bg-[var(--bg-elevated)] md:px-3 md:py-5"
    >
      <NuxtLink
        to="/"
        class="mb-4 inline-flex w-fit items-center gap-2 rounded-lg px-2 py-1 text-xs
               text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <Icon name="lucide:plane-takeoff" size="14" />
        <span>旅遊記帳</span>
      </NuxtLink>

      <div class="mb-6 px-2">
        <div v-if="tripLoading" class="h-6 w-36 animate-pulse rounded-md bg-[var(--bg-sunken)]" />
        <h1 v-else class="text-lg leading-snug font-semibold text-balance text-[var(--text)]">
          {{ tripName || tripFallback }}
        </h1>
      </div>

      <nav aria-label="旅程導覽" class="flex flex-col gap-1">
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="rail-link"
          :class="{ 'is-active': isActive(item.to) }"
          :aria-current="isActive(item.to) ? 'page' : undefined"
        >
          <Icon :name="item.icon" size="18" class="shrink-0" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="mt-auto pt-6">
        <UiAppButton
          variant="ghost"
          block
          :icon="shareUi.icon"
          :class="['text-sm', shareUi.tone]"
          @click="copyShareLink"
        >
          {{ shareUi.label }}
        </UiAppButton>
        <p class="mt-2 px-1 text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
          有連結就能一起記帳,旅伴不必註冊。
        </p>
      </div>
    </aside>

    <!-- ───────── 手機:頂部標頭 ───────── -->
    <header v-if="inTrip" class="appbar sticky top-0 z-20 md:hidden">
      <div class="flex min-h-14 items-center gap-3 px-4">
        <div class="min-w-0 flex-1">
          <NuxtLink
            to="/"
            class="inline-flex items-center gap-1 text-[0.625rem] leading-none text-[var(--text-muted)]"
          >
            <Icon name="lucide:plane-takeoff" size="11" />
            <span>旅遊記帳</span>
          </NuxtLink>
          <div v-if="tripLoading" class="mt-1.5 h-4 w-32 animate-pulse rounded bg-[var(--bg-sunken)]" />
          <h1 v-else class="mt-0.5 truncate text-[0.9375rem] font-semibold text-[var(--text)]">
            {{ tripName || tripFallback }}
          </h1>
        </div>

        <UiAppButton
          variant="ghost"
          :icon="shareUi.icon"
          :aria-label="shareUi.label"
          :class="['shrink-0', 'px-3', 'text-xs', shareUi.tone]"
          @click="copyShareLink"
        >
          {{ shareUi.short }}
        </UiAppButton>
      </div>
    </header>

    <!-- ───────── 內容區 ───────── -->
    <main :class="inTrip ? 'md:pl-60' : ''">
      <div
        class="page-shell mx-auto w-full max-w-2xl px-4 pt-4 md:max-w-4xl md:px-8 md:pt-8"
        :class="{ 'has-tabbar': inTrip }"
      >
        <slot />
      </div>
    </main>

    <!-- ───────── 手機:底部 tab bar ───────── -->
    <nav v-if="inTrip" aria-label="旅程導覽" class="tabbar fixed inset-x-0 bottom-0 z-30 md:hidden">
      <div class="flex items-stretch">
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="tab-link"
          :class="{ 'is-active': isActive(item.to) }"
          :aria-current="isActive(item.to) ? 'page' : undefined"
        >
          <span class="tab-icon"><Icon :name="item.icon" size="20" /></span>
          <span>{{ item.label }}</span>
        </NuxtLink>
      </div>
    </nav>
  </div>
</template>

<style scoped>
/* 顏色全部走 main.css 的 CSS 變數,深色模式自動跟著換,不寫死任何 hex。 */

/* ── 手機頂部標頭 ── */
.appbar {
  background: color-mix(in oklab, var(--bg-elevated) 82%, transparent);
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(14px) saturate(1.6);
  -webkit-backdrop-filter: blur(14px) saturate(1.6);
}

/* ── md 以上的左側 rail 項目 ── */
.rail-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 44px; /* tap target 下限 */
  padding-inline: 0.75rem;
  border-radius: 0.75rem;
  font-size: 0.9375rem;
  color: var(--text-muted);
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.12s ease;
}
@media (hover: hover) {
  .rail-link:hover {
    background: var(--bg-sunken);
    color: var(--text);
  }
}
.rail-link:active {
  transform: scale(0.985);
}
.rail-link.is-active {
  background: color-mix(in oklab, var(--brand) 13%, transparent);
  color: var(--brand);
  font-weight: 600;
}

/* ── 手機底部 tab bar ── */
.tabbar {
  background: color-mix(in oklab, var(--bg-elevated) 88%, transparent);
  border-top: 1px solid var(--border);
  backdrop-filter: blur(14px) saturate(1.6);
  -webkit-backdrop-filter: blur(14px) saturate(1.6);
  /* iOS 底部安全區:home indicator 不要蓋住 tab */
  padding-bottom: var(--safe-b);
}
.tab-link {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.125rem;
  min-height: 56px;
  padding: 0.4rem 0.125rem;
  font-size: 0.6875rem;
  line-height: 1;
  color: var(--text-muted);
  transition: color 0.15s ease, transform 0.12s ease;
}
.tab-link:active {
  transform: scale(0.93);
}
.tab-link.is-active {
  color: var(--brand);
  font-weight: 600;
}
.tab-icon {
  display: grid;
  place-items: center;
  width: 2.5rem;
  height: 1.75rem;
  border-radius: 999px;
  transition: background-color 0.18s ease;
}
.tab-link.is-active .tab-icon {
  background: color-mix(in oklab, var(--brand) 15%, transparent);
}

/* ── 內容區底部留白 ──
   有 tab bar 時要多留 tab 高度 + iOS 安全區,內容才不會被遮住。 */
.page-shell {
  padding-bottom: 2.5rem;
}
.page-shell.has-tabbar {
  padding-bottom: calc(56px + var(--safe-b) + 1.5rem);
}
@media (min-width: 48rem) {
  /* md 以上底部 tab bar 隱藏,不需要那段留白 */
  .page-shell.has-tabbar {
    padding-bottom: 3rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rail-link,
  .tab-link,
  .tab-icon {
    transition: none;
  }
  .rail-link:active,
  .tab-link:active {
    transform: none;
  }
}
</style>
