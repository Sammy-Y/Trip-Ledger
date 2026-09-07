<script setup lang="ts">
/**
 * 旅程列表 —— 概念上等於「打開旅遊資料夾,看到裡面好幾個 Excel」。
 *
 * 刻意不做權限、不要求輸入 tripId:這是自己和幾個朋友用的工具,
 * 多一層識別碼只是讓每次進來都要記一串亂碼。
 * (分享連結 /t/<id> 仍然有效,要丟給旅伴時用。)
 */
interface TripRow {
  id: string; name: string; base_currency: string;
  start_date: string | null; end_date: string | null;
  share_token: string; created_at: string;
  member_count: number; expense_count: number; last_spent_at: string | null;
}

const api = useApi();
const { data, pending, error, refresh } = await useAsyncData('trips', () => api.get<TripRow[]>('/api/trips'));
const trips = computed(() => data.value ?? []);

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

/** 「3 人 · 47 筆 · 最後記帳 3/13」 */
function subtitle(t: TripRow): string {
  const parts = [`${t.member_count} 人`, `${t.expense_count} 筆`];
  if (t.last_spent_at) parts.push(t.last_spent_at.slice(5).replace('-', '/'));
  return parts.join(' · ');
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-6 space-y-5">
    <header class="flex items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">我的旅程</h1>
        <p class="text-sm mt-0.5" style="color: var(--text-muted)">記帳、分帳、看誰欠誰</p>
      </div>
      <UiAppButton variant="primary" @click="showNew = true">
        <Icon name="lucide:plus" /> 新增
      </UiAppButton>
    </header>

    <UiLoadingBlock v-if="pending && !trips.length" :rows="3" />

    <p v-else-if="error" class="card p-4 text-sm" style="color: var(--debit)">
      載入失敗:{{ error.message }}
    </p>

    <UiEmptyState
      v-else-if="!trips.length"
      icon="lucide:luggage"
      title="還沒有任何旅程"
      description="建立第一趟旅程,把行程中的花費記下來,回家就不用再算誰欠誰。">
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
          <button type="button" class="p-2 rounded-lg shrink-0" style="color: var(--text-muted)"
                  :aria-label="`刪除 ${t.name}`" @click="confirmTarget = t">
            <Icon name="lucide:trash-2" />
          </button>
        </div>
      </li>
    </ul>

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
