<script setup lang="ts">
/**
 * 記一筆支出。表單本體在 ExpenseForm,這頁只負責取資料與送出。
 *
 * ── 記完不離開這一頁 ────────────────────────────────────────
 *
 * 以前送出成功會顯示一張「已記下」的卡片,1.4 秒後自動跳回支出列表。
 * 那對「記一筆」是對的,對真實的使用方式是錯的:結完帳站在店門口的人
 * 通常一次要記好幾筆(晚餐、飲料、隔壁買的伴手禮),而每記一筆就被踢回
 * 列表頁、再點一次「記一筆」、幣別和付款人又回到預設值 —— 光是重新選
 * 那幾個欄位就比打金額還久。
 *
 * 所以現在:送出成功 → 留在這頁、清掉「這一筆是什麼」、保留「現在在什麼
 * 情境記帳」(幣別、日期、付款人、分攤…見 ExpenseForm.startNextEntry),
 * 游標回到說明欄。
 *
 * 確認訊息是**浮起來一下就消失的 toast**,不是卡片。試過卡片版本
 * (帶邊框、匯率、「看支出列表」連結固定在表單上方)—— 那東西太重了:
 * 它把整張表單往下推,而且一直留在畫面上,連續記三筆就看三次同一塊東西。
 * 使用者要的只是「有沒有存進去」這一個訊號,那用一句話兩秒鐘就夠。
 *
 * 匯率沒有因此消失 —— 它在支出明細裡(ExpenseDetail 的「換算匯率」那節),
 * 那裡才是回頭稽核的地方;記帳當下沒有人在核匯率。
 * 「記了幾筆」留在標題旁邊,那是 toast 消失之後唯一還看得到的證據。
 */
const route = useRoute();
const tripId = computed(() => String(route.params.trip ?? ''));
const { trip, members, fxDefaults, pending } = useTrip(tripId);
const api = useApi();

const submitting = ref(false);
const errorMessage = ref<string | null>(null);

/** 這一輪連續記了幾筆。toast 消失之後,這是唯一還看得到的「有記進去」的證據。 */
const savedCount = ref(0);

/** toast 的文字。null = 不顯示。 */
const toast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(text: string): void {
  toast.value = text;
  // 連按兩次的話重新計時,不要讓第一次的 timer 把第二次的訊息提早收掉。
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 2600);
}
// 元件卸載時要清掉 —— 否則 timer 會在頁面已經不在的時候寫一個死掉的 ref。
onBeforeUnmount(() => clearTimeout(toastTimer));

const form = useTemplateRef<{ startNextEntry: () => void }>('form');

async function onSubmit(payload: Record<string, unknown>) {
  submitting.value = true;
  errorMessage.value = null;
  try {
    await api.post<{ id: string }>(
      `/api/trips/${encodeURIComponent(tripId.value)}/expenses`, payload);
    savedCount.value += 1;
    const what = String(payload.description ?? '').trim();
    showToast(what ? `已記下「${what}」` : '已記下');
    form.value?.startNextEntry();
  }
  catch (e) {
    errorMessage.value = (e as Error).message;
  }
  finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-4 md:py-6">
    <div class="mb-4 flex items-baseline gap-2">
      <h1 class="text-xl font-bold">
        記一筆
      </h1>
      <span v-if="savedCount" class="text-xs" style="color: var(--text-muted)">
        這一輪已記 <span class="tnum font-semibold">{{ savedCount }}</span> 筆
      </span>
    </div>

    <UiLoadingBlock v-if="pending && !members.length" :rows="6" />

    <UiEmptyState
      v-else-if="!members.length"
      icon="lucide:users"
      title="還沒有成員"
      description="要先有成員才能記帳 —— 系統得知道誰付的錢、誰要分攤。"
    >
      <UiAppButton variant="primary" @click="navigateTo(`/t/${tripId}/members`)">
        <Icon name="lucide:user-plus" /> 去新增成員
      </UiAppButton>
    </UiEmptyState>

    <template v-else>
      <ExpenseForm
        ref="form"
        :members="members"
        :base-currency="trip?.base_currency ?? 'TWD'"
        :fx-defaults="fxDefaults"
        :submitting="submitting"
        :error-message="errorMessage"
        @submit="onSubmit"
      />
    </template>

    <!--
      浮起來一下就消失的確認訊息。

      fixed 而不是塞進版面裡:塞進去會把整張表單往下推,而使用者剛按完送出、
      手正要打下一筆的說明 —— 那一推會讓輸入框跑掉。
      pointer-events-none 讓它不擋任何點擊(它沒有可以按的東西)。
      bottom 要閃開手機的 tab bar 與 iOS 的 home indicator。
    -->
    <Transition name="toast">
      <p v-if="toast" class="toast" role="status">
        <Icon name="lucide:check" size="15" class="shrink-0" />
        <span class="truncate">{{ toast }}</span>
      </p>
    </Transition>
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  /* 手機:tab bar(約 56px)+ 安全區之上。桌機沒有 tab bar,靠底就好 */
  bottom: calc(4.75rem + var(--safe-b, 0px));
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  max-width: min(22rem, calc(100vw - 2rem));
  padding: 0.5rem 0.875rem;
  border-radius: 999px;
  background: color-mix(in oklab, var(--credit) 16%, var(--bg-elevated));
  border: 1px solid color-mix(in oklab, var(--credit) 35%, transparent);
  color: var(--text);
  font-size: 0.8125rem;
  font-weight: 500;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
  pointer-events: none;
}
@media (min-width: 768px) {
  .toast {
    bottom: 1.5rem;
  }
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(0.5rem);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: opacity 0.18s ease;
  }
  .toast-enter-from,
  .toast-leave-to {
    transform: translateX(-50%);
  }
}
</style>
