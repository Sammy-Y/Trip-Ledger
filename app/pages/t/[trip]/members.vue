<script setup lang="ts">
/**
 * 成員管理 + 分享連結。
 *
 * 「刪除」刻意只開放給沒有帳的成員 —— server 會擋(見 members/[id].delete.ts):
 * expense_payers / expense_shares 對 members 是 ON DELETE CASCADE,
 * 有帳的人被刪掉會讓分攤金額無聲對不上,結算從此算錯而且沒有錯誤訊息。
 * 所以「打錯字」用改名解決,刪除只留給「這個人根本不該在名單裡」。
 */
import type { Member } from '~~/shared/types';

const route = useRoute();
const tripId = computed(() => String(route.params.trip ?? ''));
const { members, pot, people, pending, refresh } = useTrip(tripId);
const api = useApi();

const errorMessage = ref<string | null>(null);

// ── 新增 ────────────────────────────────────────────────────
const newName = ref('');
const adding = ref(false);

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
    errorMessage.value = api.errorMessage(e);
  } finally {
    adding.value = false;
  }
}

// ── 建立公費 ────────────────────────────────────────────────
const potName = ref('公費');
const addingPot = ref(false);

async function addPot() {
  const name = potName.value.trim() || '公費';
  if (addingPot.value) return;
  addingPot.value = true;
  errorMessage.value = null;
  try {
    await api.post(`/api/trips/${encodeURIComponent(tripId.value)}/members`, { name, is_pot: true });
    await refresh();
  } catch (e) {
    errorMessage.value = api.errorMessage(e);
  } finally {
    addingPot.value = false;
  }
}

// ── 編輯名稱 ────────────────────────────────────────────────
const editingId = ref<string | null>(null);
const editName = ref('');
const savingId = ref<string | null>(null);

function startEdit(m: Member) {
  editingId.value = m.id;
  editName.value = m.name;
  errorMessage.value = null;
}
function cancelEdit() {
  editingId.value = null;
  editName.value = '';
}

async function saveEdit(m: Member) {
  const name = editName.value.trim();
  if (!name || savingId.value) return;
  if (name === m.name) return cancelEdit();
  savingId.value = m.id;
  errorMessage.value = null;
  try {
    await api.patch(`/api/trips/${encodeURIComponent(tripId.value)}/members/${encodeURIComponent(m.id)}`, { name });
    cancelEdit();
    await refresh();
  } catch (e) {
    errorMessage.value = api.errorMessage(e);
  } finally {
    savingId.value = null;
  }
}

// ── 刪除 ────────────────────────────────────────────────────
const target = ref<Member | null>(null);
const confirmOpen = ref(false);
const deleting = ref(false);
const deleteError = ref('');

function askDelete(m: Member) {
  target.value = m;
  deleteError.value = '';
  confirmOpen.value = true;
}

async function confirmDelete() {
  const m = target.value;
  if (!m || deleting.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await api.del(`/api/trips/${encodeURIComponent(tripId.value)}/members/${encodeURIComponent(m.id)}`);
    confirmOpen.value = false;
    target.value = null;
    await refresh();
  } catch (e) {
    // 有帳的成員 server 會回 409,訊息裡already說明了原因,直接顯示在對話框裡
    deleteError.value = api.errorMessage(e);
  } finally {
    deleting.value = false;
  }
}

// ── 分享連結 ────────────────────────────────────────────────
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
  <div class="mx-auto w-full max-w-2xl space-y-5 px-4 py-4 md:py-6">
    <h1 class="text-xl font-bold">
      成員
    </h1>

    <div class="card p-4">
      <UiLoadingBlock v-if="pending && !members.length" :rows="3" />

      <ul v-else-if="members.length" class="divide-y" style="border-color: var(--border)">
        <li v-for="m in members" :key="m.id" class="flex items-center gap-3 py-2.5">
          <span
            class="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold"
            :style="m.is_pot
              ? 'background: color-mix(in oklab, var(--warn) 18%, transparent); color: var(--warn)'
              : 'background: color-mix(in oklab, var(--brand) 15%, transparent); color: var(--brand)'"
          >
            <Icon v-if="m.is_pot" name="lucide:piggy-bank" size="18" />
            <template v-else>{{ m.name.slice(0, 1) }}</template>
          </span>

          <!-- 編輯中 -->
          <template v-if="editingId === m.id">
            <input
              v-model="editName"
              class="field min-w-0 flex-1"
              :aria-label="`${m.name} 的新名字`"
              @keydown.enter.prevent="saveEdit(m)"
              @keydown.esc="cancelEdit"
            >
            <UiAppButton
              variant="primary" class="shrink-0 px-3"
              :loading="savingId === m.id" :disabled="!editName.trim()"
              @click="saveEdit(m)"
            >
              <Icon name="lucide:check" />
            </UiAppButton>
            <UiAppButton variant="ghost" class="shrink-0 px-3" @click="cancelEdit">
              <Icon name="lucide:x" />
            </UiAppButton>
          </template>

          <!-- 一般顯示 -->
          <template v-else>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{{ m.name }}</span>
              <span v-if="m.is_pot" class="block text-xs" style="color: var(--text-muted)">
                公費 · 不參與分攤
              </span>
            </span>
            <button
              type="button" class="icon-btn shrink-0"
              :aria-label="`重新命名 ${m.name}`" :title="`重新命名 ${m.name}`"
              @click="startEdit(m)"
            >
              <Icon name="lucide:pencil" size="16" />
            </button>
            <button
              type="button" class="icon-btn icon-btn-danger shrink-0"
              :aria-label="`刪除 ${m.name}`" :title="`刪除 ${m.name}`"
              @click="askDelete(m)"
            >
              <Icon name="lucide:trash-2" size="16" />
            </button>
          </template>
        </li>
      </ul>

      <p v-else class="py-2 text-sm" style="color: var(--text-muted)">
        還沒有成員,先加一個吧。
      </p>

      <form class="mt-3 flex gap-2" @submit.prevent="addMember">
        <input v-model="newName" class="field flex-1" placeholder="成員名字" aria-label="成員名字">
        <UiAppButton type="submit" variant="primary" :loading="adding" :disabled="!newName.trim()">
          <Icon name="lucide:plus" /> 新增
        </UiAppButton>
      </form>

      <p v-if="errorMessage" class="mt-2 text-sm" style="color: var(--debit)">
        {{ errorMessage }}
      </p>
      <p class="mt-2 text-xs leading-relaxed" style="color: var(--text-muted)">
        已經有支出或還款紀錄的成員不能刪除 —— 那會讓分攤金額對不上、結算算錯。
        名字打錯的話用改名就好,改了之後所有既有紀錄都會跟著顯示新名字。
      </p>
    </div>

    <!-- ── 公費 ── -->
    <div class="card space-y-3 p-4">
      <div>
        <h2 class="flex items-center gap-2 font-semibold">
          <Icon name="lucide:piggy-bank" size="18" style="color: var(--warn)" />
          公費
        </h2>
        <p class="mt-1 text-sm leading-relaxed" style="color: var(--text-muted)">
          出國常見的做法:大家先各拿一筆錢出來放公費,吃飯、門票直接從公費付,
          不用每筆都分帳。記帳時勾「這筆從公費付」就會自動由全體成員均分,
          剩多少、誰出了多少都在「總覽」看得到。
        </p>
      </div>

      <div v-if="pot" class="flex items-center gap-2 rounded-xl px-3 py-2.5" style="background: var(--bg-sunken)">
        <Icon name="lucide:check" size="16" style="color: var(--credit)" />
        <span class="min-w-0 flex-1 text-sm">
          已設定:<span class="font-medium">{{ pot.name }}</span>
        </span>
        <UiAppButton variant="ghost" class="shrink-0 px-3 text-xs" :to="`/t/${tripId}/overview`">
          看收支
        </UiAppButton>
      </div>

      <form v-else class="flex gap-2" @submit.prevent="addPot">
        <input v-model="potName" class="field flex-1" placeholder="公費" aria-label="公費名稱">
        <UiAppButton type="submit" variant="primary" :loading="addingPot">
          <Icon name="lucide:plus" /> 建立公費
        </UiAppButton>
      </form>
      <p v-if="!pot" class="text-xs" style="color: var(--text-muted)">
        一趟旅程一個公費。它會出現在成員名單裡(標成公費),但不會被算進任何分攤。
      </p>
      <p v-else-if="!people.length" class="text-xs" style="color: var(--warn)">
        目前只有公費、沒有其他成員 —— 先加人,公費的支出才有人可以分攤。
      </p>
    </div>

    <!-- 這是這個產品降低協作門檻的核心設計,文案要把它講出來 -->
    <div class="card space-y-3 p-4">
      <div>
        <h2 class="font-semibold">
          分享給旅伴
        </h2>
        <p class="mt-1 text-sm" style="color: var(--text-muted)">
          把這個連結丟到 LINE 群組,朋友點開就能一起記帳 —— 不用下載 App、不用註冊。
          旅途中大家各自記自己付的那筆,回家就不用再翻聊天紀錄回想誰付了什麼。
        </p>
      </div>
      <div class="flex gap-2">
        <input
          :value="shareUrl" readonly class="field flex-1 text-sm" aria-label="分享連結"
          @focus="(e) => (e.target as HTMLInputElement).select()"
        >
        <UiAppButton variant="ghost" @click="copyLink">
          <Icon :name="copied ? 'lucide:check' : 'lucide:copy'" />
          {{ copied ? '已複製' : '複製' }}
        </UiAppButton>
      </div>
    </div>

    <UiAppSheet v-model:open="confirmOpen" title="刪除成員">
      <p class="text-sm leading-relaxed">
        要把「{{ target?.name }}」從這趟旅程移除嗎?
      </p>
      <p v-if="deleteError" class="mt-3 text-sm leading-relaxed" style="color: var(--debit)">
        {{ deleteError }}
      </p>
      <div class="mt-4 flex gap-2">
        <UiAppButton variant="ghost" block @click="confirmOpen = false">
          取消
        </UiAppButton>
        <UiAppButton variant="primary" block :loading="deleting" @click="confirmDelete">
          刪除
        </UiAppButton>
      </div>
    </UiAppSheet>
  </div>
</template>

<style scoped>
.icon-btn {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 0.625rem;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
  transition: color 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
}
.icon-btn:active {
  transform: scale(0.94);
}
@media (hover: hover) {
  .icon-btn:hover {
    color: var(--text);
  }
  .icon-btn-danger:hover {
    color: var(--debit);
    border-color: var(--debit);
  }
}
@media (prefers-reduced-motion: reduce) {
  .icon-btn {
    transition: none;
  }
  .icon-btn:active {
    transform: none;
  }
}
</style>
