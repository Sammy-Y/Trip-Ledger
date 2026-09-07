<script setup lang="ts">
/** 成員管理 + 分享連結。 */
const route = useRoute();
const tripId = computed(() => String(route.params.trip ?? ''));
const { trip, members, pending, refresh } = useTrip(tripId);
const api = useApi();

const newName = ref('');
const adding = ref(false);
const errorMessage = ref<string | null>(null);

async function addMember() {
  const name = newName.value.trim();
  if (!name || adding.value) return;
  adding.value = true;
  errorMessage.value = null;
  try {
    await api.post(`/api/trips/${encodeURIComponent(tripId.value)}/members`, { name });
    newName.value = '';
    await refresh();
  } catch (e) {
    errorMessage.value = (e as Error).message;
  } finally {
    adding.value = false;
  }
}

const shareUrl = computed(() =>
  import.meta.client ? `${location.origin}/t/${tripId.value}` : `/t/${tripId.value}`);
const copied = ref(false);

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    errorMessage.value = '複製失敗,請手動選取網址複製';
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-4 md:py-6 space-y-5">
    <h1 class="text-xl font-bold">成員</h1>

    <div class="card p-4">
      <UiLoadingBlock v-if="pending && !members.length" :rows="3" />
      <ul v-else-if="members.length" class="divide-y" style="border-color: var(--border)">
        <li v-for="m in members" :key="m.id" class="flex items-center gap-3 py-2.5">
          <span class="grid place-items-center w-9 h-9 rounded-full text-sm font-semibold shrink-0"
                style="background: color-mix(in oklab, var(--brand) 15%, transparent); color: var(--brand)">
            {{ m.name.slice(0, 1) }}
          </span>
          <span class="font-medium">{{ m.name }}</span>
        </li>
      </ul>
      <p v-else class="text-sm py-2" style="color: var(--text-muted)">還沒有成員,先加一個吧。</p>

      <form class="flex gap-2 mt-3" @submit.prevent="addMember">
        <input v-model="newName" class="field flex-1" placeholder="成員名字" aria-label="成員名字" />
        <UiAppButton type="submit" variant="primary" :loading="adding" :disabled="!newName.trim()">
          <Icon name="lucide:plus" /> 新增
        </UiAppButton>
      </form>
      <p v-if="errorMessage" class="text-sm mt-2" style="color: var(--debit)">{{ errorMessage }}</p>
    </div>

    <!-- 這是這個產品降低協作門檻的核心設計,文案要把它講出來 -->
    <div class="card p-4 space-y-3">
      <div>
        <h2 class="font-semibold">分享給旅伴</h2>
        <p class="text-sm mt-1" style="color: var(--text-muted)">
          把這個連結丟到 LINE 群組,朋友點開就能一起記帳 —— 不用下載 App、不用註冊。
          旅途中大家各自記自己付的那筆,回家就不用再翻聊天紀錄回想誰付了什麼。
        </p>
      </div>
      <div class="flex gap-2">
        <input :value="shareUrl" readonly class="field flex-1 text-sm" aria-label="分享連結"
               @focus="(e) => (e.target as HTMLInputElement).select()" />
        <UiAppButton variant="ghost" @click="copyLink">
          <Icon :name="copied ? 'lucide:check' : 'lucide:copy'" />
          {{ copied ? '已複製' : '複製' }}
        </UiAppButton>
      </div>
    </div>
  </div>
</template>
