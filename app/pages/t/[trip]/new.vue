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
 * 游標回到說明欄。上方出現一條可以點回列表的確認訊息。
 *
 * 要離開的人照舊有下面的導覽列,以及那條訊息裡的「看支出列表」。
 */
const route = useRoute();
const tripId = computed(() => String(route.params.trip ?? ''));
const { trip, members, fxDefaults, pending } = useTrip(tripId);
const api = useApi();

const submitting = ref(false);
const errorMessage = ref<string | null>(null);

interface SavedEntry {
  id: string;
  description: string;
  fx_rate: number | null;
  fx_rate_date: string | null;
  fx_rate_source?: string | null;
}

/** 最近成功記下的那一筆。顯示到下一次送出為止 —— 匯率是可稽核性的一部分。 */
const saved = ref<SavedEntry | null>(null);
/** 這一輪連續記了幾筆。讓使用者知道自己真的記進去了幾筆,而不用切去列表數。 */
const savedCount = ref(0);

const form = useTemplateRef<{ startNextEntry: () => void }>('form');

async function onSubmit(payload: Record<string, unknown>) {
  submitting.value = true;
  errorMessage.value = null;
  try {
    const res = await api.post<SavedEntry>(
      `/api/trips/${encodeURIComponent(tripId.value)}/expenses`, payload);
    saved.value = { ...res, description: String(payload.description ?? '') };
    savedCount.value += 1;
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
      <!--
        確認訊息留在表單**上方**而不是取代表單:取代的話畫面會閃一下、
        使用者的手要重新找輸入框,而連續記帳最在意的就是那幾秒。
        它一直留到下一次送出 —— 匯率(用了哪一天、是不是近似值)是這個 App
        的可稽核性承諾,一秒就消失的話等於沒說。
      -->
      <div
        v-if="saved"
        class="card mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 p-3"
        style="border-color: color-mix(in oklab, var(--credit) 40%, var(--border))"
        role="status"
      >
        <Icon name="lucide:check-circle" size="18" class="shrink-0" style="color: var(--credit)" />
        <p class="min-w-0 flex-1 text-sm">
          已記下<span class="font-semibold">{{ saved.description || '這筆' }}</span>
          <span v-if="saved.fx_rate" class="ml-1 text-xs" style="color: var(--text-muted)">
            · 套用 {{ saved.fx_rate_date }} 的匯率 {{ saved.fx_rate.toFixed(6) }}
            <span v-if="saved.fx_rate_source?.includes('fallback')" style="color: var(--warn)">(近似值)</span>
          </span>
        </p>
        <NuxtLink :to="`/t/${tripId}`" class="shrink-0 text-xs font-medium" style="color: var(--brand)">
          看支出列表
        </NuxtLink>
      </div>

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
  </div>
</template>
