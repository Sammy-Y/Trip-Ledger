<script setup lang="ts">
/** 記一筆支出。表單本體在 ExpenseForm,這頁只負責取資料與送出。 */
const route = useRoute();
const tripId = computed(() => String(route.params.trip ?? ''));
const { trip, members, pending, refresh } = useTrip(tripId);
const api = useApi();

const submitting = ref(false);
const errorMessage = ref<string | null>(null);
const saved = ref<{ fx_rate: number | null; fx_rate_date: string | null; fx_rate_source?: string | null } | null>(null);

async function onSubmit(payload: Record<string, unknown>) {
  submitting.value = true;
  errorMessage.value = null;
  try {
    const res = await api.post<{ id: string; fx_rate: number | null; fx_rate_date: string | null; fx_rate_source?: string | null }>(
      `/api/trips/${encodeURIComponent(tripId.value)}/expenses`, payload);
    saved.value = res;
    // 讓使用者看到「用了哪天的匯率」再離開 —— 這是可稽核性的一部分
    setTimeout(() => navigateTo(`/t/${encodeURIComponent(tripId.value)}`), 1400);
  } catch (e) {
    errorMessage.value = (e as Error).message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-4 md:py-6">
    <h1 class="text-xl font-bold mb-4">記一筆</h1>

    <UiLoadingBlock v-if="pending && !members.length" :rows="6" />

    <UiEmptyState
      v-else-if="!members.length"
      icon="lucide:users"
      title="還沒有成員"
      description="要先有成員才能記帳 —— 系統得知道誰付的錢、誰要分攤。">
      <UiAppButton variant="primary" @click="navigateTo(`/t/${tripId}/members`)">
        <Icon name="lucide:user-plus" /> 去新增成員
      </UiAppButton>
    </UiEmptyState>

    <div v-else-if="saved" class="card p-5 text-center space-y-2">
      <Icon name="lucide:check-circle" class="text-3xl" style="color: var(--credit)" />
      <p class="font-semibold">已記下</p>
      <p v-if="saved.fx_rate" class="text-sm" style="color: var(--text-muted)">
        套用 {{ saved.fx_rate_date }} 的匯率 {{ saved.fx_rate.toFixed(6) }}
        <span v-if="saved.fx_rate_source?.includes('fallback')" style="color: var(--warn)">(近似值)</span>
      </p>
    </div>

    <ExpenseForm
      v-else
      :members="members"
      :base-currency="trip?.base_currency ?? 'TWD'"
      :submitting="submitting"
      :error-message="errorMessage"
      @submit="onSubmit" />
  </div>
</template>
