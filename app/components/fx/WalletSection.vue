<script setup lang="ts">
/**
 * 錢包 —— 「我手上還剩多少現金」。自動註冊名稱是 <FxWalletSection>。issue #6
 *
 * ── 這一區在回答三個問題 ────────────────────────────────────────
 *
 *   我這趟換了多少日幣?折合台幣多少?   → 換匯那一列(含加權平均匯率)
 *   我花了多少日幣?                     → 自己花 / 投入公費 分開兩列
 *   **我手上還剩多少?**                 → 還剩
 *
 * 三個數字**刻意分開顯示**,因為「我口袋剩多少」和「我花在自己身上多少」
 * 是兩種讀法而且兩個都要:投入公費的錢確實離手了(所以要從剩餘扣掉),
 * 但那不是「我花的」(它會回到公費、最後退還)。合成一個數字之後兩題都答不出來。
 *
 * ── 為什麼整區包成一個元件 ──────────────────────────────────────
 *
 * overview.vue 已經 1200 多行,而這一區自己就有清單、表單、刪除確認三塊狀態。
 * 塞進去的話那頁的 script 會有兩套互不相干的 CRUD 狀態機並排
 * (公費金流一套、換匯一套),而它們的變數名字只差一兩個字 ——
 * 那是「改到錯的那一套」最好的溫床。
 *
 * 父層只需要:給 wallets、給人名單、聽 changed 去重抓 balance。
 */
import type { FxExchange, Member, WalletCurrency, WalletSummary } from '~~/shared/types';
import { CURRENCY_LABEL, exchangeRate, formatMoney, formatRate } from '~~/shared/money';

const props = defineProps<{
  tripId: string;
  /** balance.wallets。完全沒有換匯紀錄時是空陣列 */
  wallets: WalletSummary[];
  /** 真正的「人」(不含公費)。公費不能換匯,見 server 端 exchanges.post.ts */
  people: Member[];
  baseCurrency: string;
  /** 公費的名字,用在「投入公費」那一列的標籤。沒設公費時是 null */
  potName: string | null;
}>();

const emit = defineEmits<{
  /** 換匯紀錄有變動 —— 父層要重抓 balance,錢包的每個數字都會變 */
  changed: [];
}>();

const api = useApi();
const basePath = computed(() => `/api/trips/${encodeURIComponent(props.tripId)}/fx/exchanges`);

// ── 錢包的顯示 ──────────────────────────────────────────────
/**
 * 加權平均匯率。付出的幣別只有一種時才算得出來 ——
 * 一個錢包同時用台幣和美金換進來的話,「平均匯率」是哪一個幣別的平均?
 * 沒有答案,所以回 null 而不是硬算一個看起來像數字的東西。
 *
 * 算的是 Σ付出 ÷ Σ換到,不是把每筆的匯率再平均
 * (那個會得到 0.2075 而正確答案是 0.2067,推導見 schema.sql 的 fx_exchanges)。
 */
function avgRateOf(row: WalletCurrency): number | null {
  if (row.costs.length !== 1) return null;
  const paid = row.costs[0]!;
  return exchangeRate(row.exchangedInMinor, row.currency, paid.amountMinor, paid.currency);
}

/** 「NT$3,100 · 平均 0.2067」。多種付出幣別時只列金額,不講平均。 */
function costText(row: WalletCurrency): string {
  if (!row.costs.length) return '';
  const amounts = row.costs.map(c => formatMoney(c.amountMinor, c.currency)).join(' + ');
  const rate = avgRateOf(row);
  return rate == null ? amounts : `${amounts} · 平均 ${formatRate(rate)}`;
}

/**
 * 一塊錢包裡要列出來的「離手 / 收到」明細。
 *
 * 前兩列(自己花、投入公費)**一律顯示,即使是 0** —— 它們是這一區的主要內容,
 * 忽隱忽現的話使用者每次看到的版面都不一樣,而且 0 本身是有意義的答案
 * (「我還沒開始花」)。後面三列只在非 0 時出現:多數旅程根本不會用到,
 * 常駐三個 0 只會把真正要看的四個數字擠掉。
 */
function linesOf(row: WalletCurrency) {
  const potLabel = props.potName ? `投入${props.potName}` : '投入公費';
  const out: Array<{ key: string; label: string; minor: number; sign: '-' | '+' }> = [
    { key: 'cash', label: '自己花', minor: row.cashSpentMinor, sign: '-' },
    { key: 'pot', label: potLabel, minor: row.potContributedMinor, sign: '-' },
  ];
  // 拿這個幣別再去換別的:換回台幣、當地 ATM 用日幣現金換……都是這一種。
  // 漏掉它的症狀正好是這個功能最不能出的錯:把日幣換回台幣之後,
  // 錢包還說你手上有那筆錢。
  if (row.exchangedOutMinor) {
    out.push({ key: 'out', label: '換成其他幣別', minor: row.exchangedOutMinor, sign: '-' });
  }
  if (row.repaidOutMinor) {
    out.push({ key: 'repaid', label: '還款付出', minor: row.repaidOutMinor, sign: '-' });
  }
  if (row.receivedInMinor) {
    out.push({ key: 'received', label: '收到還款 / 退還', minor: row.receivedInMinor, sign: '+' });
  }
  return out;
}

// ── 換匯紀錄清單 ────────────────────────────────────────────
/** null = 還沒抓過 / 抓失敗(再展開一次會重抓);[] = 抓到了但沒有紀錄 */
const list = ref<FxExchange[] | null>(null);
const listOpen = ref(false);
const listLoading = ref(false);
const listError = ref('');

async function loadList() {
  listLoading.value = true;
  listError.value = '';
  try {
    const r = await api.get<{ exchanges: FxExchange[] }>(basePath.value);
    list.value = r?.exchanges ?? [];
  }
  catch (e) {
    if (isAbortError(e)) return;
    listError.value = api.errorMessage(e);
    list.value = null;
  }
  finally {
    listLoading.value = false;
  }
}

function toggleList() {
  listOpen.value = !listOpen.value;
  // 只在第一次展開時抓 —— 多數人進總覽是要看剩餘,不是看逐筆紀錄
  if (listOpen.value && list.value == null && !listLoading.value) void loadList();
}

const memberName = (id: string) =>
  props.people.find(m => m.id === id)?.name ?? '未知成員';

/** 這一列的有效匯率。單筆的匯率就是「付出 ÷ 換到」,和加權平均同一個定義。 */
const rateOf = (e: FxExchange) =>
  exchangeRate(e.amount_minor, e.currency, e.cost_minor, e.cost_currency);

/** exchanged_at 是 'YYYY-MM-DD',直接切出月/日 —— 不用 Date,免掉時區偏移。 */
function dayText(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw ?? '');
  return m ? `${m[2]}/${m[3]}` : (raw ?? '');
}

// ── 新增 / 編輯 ─────────────────────────────────────────────
const sheetOpen = ref(false);
/** null = 新增;有值 = 改那一列 */
const editing = ref<FxExchange | null>(null);

function openCreate() {
  editing.value = null;
  sheetOpen.value = true;
}
function openEdit(e: FxExchange) {
  editing.value = e;
  sheetOpen.value = true;
}

async function onSaved() {
  // 父層重抓 balance(錢包的數字),這裡重抓清單。
  emit('changed');
  // 清單已經展開過就一起更新;沒展開過的話,第一次記完直接打開 ——
  // 剛記的那一筆看得到,才知道自己記進去了(而且「改 / 刪」的入口只在這裡)。
  if (list.value == null) listOpen.value = true;
  await loadList();
}

// ── 刪除 ────────────────────────────────────────────────────
const deleteTarget = ref<FxExchange | null>(null);
const deleting = ref(false);
const deleteError = ref('');

/**
 * 刪掉這一筆之後,哪幾塊錢包會變成多少。
 *
 * 「確定刪除?」沒有告訴使用者他會失去什麼,而剩餘正是他唯一在乎的那個數字
 * (同 overview.vue 的公費刪除確認)。而且這裡有**兩邊**:
 * 換到的那個幣別會少,付出的那個幣別(如果他也有那塊錢包)會多回來。
 *
 * 最後一筆的情況要特別講:那塊錢包會整個消失,而不是「剩餘變成 0」——
 * 錢包只在「他換到過這個幣別」時才存在(見 server/utils/wallet.ts)。
 */
const deleteImpact = computed(() => {
  const e = deleteTarget.value;
  if (!e) return [];
  const rows: Array<{
    key: string; currency: string; from: number; to: number; vanishes: boolean;
  }> = [];
  const walletOf = (currency: string) => props.wallets
    .find(w => w.memberId === e.member_id)?.by_currency
    .find(c => c.currency === currency) ?? null;

  const got = walletOf(e.currency);
  if (got) {
    // 這塊錢包只剩這一筆換入的話,刪掉之後它就不存在了(不是剩餘變 0)
    const others = (list.value ?? []).filter(
      x => x.id !== e.id && x.member_id === e.member_id && x.currency === e.currency);
    rows.push({
      key: 'got',
      currency: e.currency,
      from: got.remainingMinor,
      to: got.remainingMinor - e.amount_minor,
      vanishes: others.length === 0,
    });
  }
  const paid = walletOf(e.cost_currency);
  if (paid) {
    rows.push({
      key: 'paid',
      currency: e.cost_currency,
      from: paid.remainingMinor,
      to: paid.remainingMinor + e.cost_minor,
      vanishes: false,
    });
  }
  return rows;
});

function askDelete(e: FxExchange) {
  deleteTarget.value = e;
  deleteError.value = '';
}

async function confirmDelete() {
  const e = deleteTarget.value;
  if (!e || deleting.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await api.del(`${basePath.value}/${encodeURIComponent(e.id)}`);
    deleteTarget.value = null;
    emit('changed');
    await loadList();
  }
  catch (err) {
    deleteError.value = api.errorMessage(err);
  }
  finally {
    deleting.value = false;
  }
}
</script>

<template>
  <section class="card p-4">
    <div class="flex items-start gap-3">
      <span
        class="grid h-9 w-9 shrink-0 place-items-center rounded-full"
        style="background: color-mix(in oklab, var(--brand) 15%, transparent); color: var(--brand)"
      >
        <Icon name="lucide:wallet" size="18" />
      </span>
      <div class="min-w-0 flex-1">
        <h2 class="font-semibold">
          錢包
        </h2>
        <p class="mt-0.5 text-xs leading-relaxed" style="color: var(--text-muted)">
          剩餘 = 換到的 − 離手的 + 收到的。逐幣別、逐人分開算。
        </p>
      </div>
    </div>

    <!--
      還沒有任何換匯紀錄。入口一定要在這裡 ——
      沒有入口的話這個功能等於不存在(同「還沒有設公費」那張卡的做法)。
    -->
    <div v-if="!wallets.length" class="mt-3 rounded-xl px-3 py-3" style="background: var(--bg-sunken)">
      <p class="text-sm leading-relaxed" style="color: var(--text-muted)">
        還沒有任何換匯紀錄。把出發前在台灣換的每一筆記下來(換到多少、匯率或付出多少),
        這裡就會算出實際成本的加權平均匯率,以及旅途中最想知道的那一個數字:
        <strong style="color: var(--text)">手上還剩多少現金</strong>。
      </p>
    </div>

    <div v-for="w in wallets" :key="w.memberId" class="mt-3">
      <h3 class="flex items-center gap-2 px-1 text-sm font-semibold">
        <span
          class="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[0.6875rem] font-semibold"
          style="background: color-mix(in oklab, var(--brand) 15%, transparent); color: var(--brand)"
        >{{ w.name.slice(0, 1) }}</span>
        {{ w.name }}
      </h3>

      <div
        v-for="row in w.by_currency" :key="row.currency"
        class="mt-1.5 rounded-xl px-3 py-3"
        style="background: var(--bg-sunken)"
      >
        <!-- 換到多少(以及它實際花了多少台幣、平均匯率多少) -->
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-xs font-semibold">
            換到的{{ CURRENCY_LABEL[row.currency] ?? row.currency }}
          </span>
          <UiMoney :minor="row.exchangedInMinor" :currency="row.currency" size="sm" />
        </div>
        <p v-if="costText(row)" class="mt-0.5 text-[0.6875rem] tnum" style="color: var(--text-muted)">
          {{ costText(row) }}
        </p>

        <!-- 離手 / 收到的明細 -->
        <dl class="mt-2 space-y-1">
          <div v-for="line in linesOf(row)" :key="line.key" class="flex items-baseline justify-between gap-3">
            <dt class="text-xs" style="color: var(--text-muted)">
              {{ line.label }}
            </dt>
            <dd class="tnum text-xs">
              {{ line.sign }}{{ formatMoney(line.minor, row.currency) }}
            </dd>
          </div>
        </dl>

        <!-- 還剩多少 —— 這一區存在的理由,所以它是唯一放大的數字 -->
        <div
          class="mt-2 flex items-baseline justify-between gap-3 border-t pt-2"
          style="border-color: var(--border)"
        >
          <span class="text-xs font-semibold">還剩</span>
          <span
            class="tnum text-lg font-bold"
            :style="{ color: row.remainingMinor < 0 ? 'var(--debit)' : 'var(--credit)' }"
          >{{ formatMoney(row.remainingMinor, row.currency) }}</span>
        </div>

        <!--
          負數只警告不阻擋:最常見的原因是在當地 ATM 提過款還沒記,
          而那是「少記了一筆」而不是「記錯了」。擋下來只會讓人沒辦法繼續記帳。
        -->
        <p
          v-if="row.remainingMinor < 0"
          class="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed"
          style="color: var(--warn)"
        >
          <Icon name="lucide:circle-alert" size="14" class="mt-px shrink-0" />
          <span>
            花掉的比換到的多 —— 通常是在當地 ATM 提過款、或有人先幫你墊了現金還沒記進來。
            補記一筆換匯就會歸位。
          </span>
        </p>
      </div>
    </div>

    <!--
      ── 逐筆換匯紀錄 ──
      上面是加總,加總沒辦法指認「是哪一天那一筆」,所以改錯 / 刪掉一律從這裡進去
      (同公費金流那一區的判斷)。
    -->
    <div class="mt-3">
      <button
        type="button" class="list-toggle"
        :aria-expanded="listOpen"
        @click="toggleList"
      >
        <Icon name="lucide:arrow-left-right" size="15" class="shrink-0" style="color: var(--text-muted)" />
        <span class="min-w-0 flex-1 text-left text-sm font-medium">換匯紀錄</span>
        <span class="shrink-0 text-xs" style="color: var(--text-muted)">記錯了可以改或刪</span>
        <Icon
          :name="listOpen ? 'lucide:chevron-up' : 'lucide:chevron-down'"
          size="16" class="shrink-0" style="color: var(--text-muted)"
        />
      </button>

      <div v-if="listOpen" class="card mt-2 overflow-hidden">
        <div class="row-head px-3 py-2 text-[0.6875rem] leading-relaxed" style="color: var(--text-muted)">
          逐筆列出,新的在最上面。這張紀錄不影響任何結算 —— 改或刪都不會動到誰欠誰。
        </div>

        <UiLoadingBlock v-if="listLoading && list == null" :rows="3" variant="plain" class="p-3" />

        <div v-else-if="listError" class="p-3">
          <p class="text-sm leading-relaxed" style="color: var(--debit)">
            {{ listError }}
          </p>
          <UiAppButton variant="ghost" class="mt-2" :loading="listLoading" @click="loadList">
            再試一次
          </UiAppButton>
        </div>

        <p v-else-if="!list?.length" class="p-3 text-sm leading-relaxed" style="color: var(--text-muted)">
          還沒有任何換匯紀錄。
        </p>

        <div v-else class="divided">
          <div v-for="e in list" :key="e.id" class="px-3 py-2.5">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-sm">{{ memberName(e.member_id) }}</span>
              <UiMoney :minor="e.amount_minor" :currency="e.currency" size="sm" />
            </div>

            <div
              class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem]"
              style="color: var(--text-muted)"
            >
              <span class="tnum shrink-0">{{ dayText(e.exchanged_at) }}</span>
              <span class="tnum shrink-0">{{ formatMoney(e.cost_minor, e.cost_currency) }}</span>
              <span class="tnum shrink-0">@ {{ formatRate(rateOf(e)) }}</span>
              <span v-if="e.note" class="min-w-0 truncate">{{ e.note }}</span>
              <span class="flex-1" />
              <!-- 兩顆動作綁成一組:窄版換行時要一起換,不能「刪除」自己掉到下一行 -->
              <span class="flex shrink-0 items-center gap-1">
                <button type="button" class="link-btn" @click="openEdit(e)">
                  <Icon name="lucide:pencil" size="13" /> 改
                </button>
                <button type="button" class="link-btn link-danger" @click="askDelete(e)">
                  <Icon name="lucide:trash-2" size="13" /> 刪除
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <UiAppButton
      variant="primary" block class="mt-3"
      :disabled="!people.length"
      @click="openCreate"
    >
      <Icon name="lucide:plus" /> 記一筆換匯
    </UiAppButton>
    <p v-if="!people.length" class="mt-2 text-xs" style="color: var(--warn)">
      這趟還沒有成員(公費不算),先去「成員」頁加人 —— 換匯一定是某個人去換的。
    </p>

    <FxExchangeSheet
      v-model:open="sheetOpen"
      :trip-id="tripId"
      :people="people"
      :base-currency="baseCurrency"
      :editing="editing"
      @saved="onSaved"
    />

    <!--
      ── 刪除確認 ──
      文案要說出後果:哪幾塊錢包的剩餘會從多少變成多少。
      只問「確定刪除?」等於要使用者自己心算,而那正是他刪這筆的原因。
    -->
    <UiAppSheet
      :open="!!deleteTarget"
      title="刪掉這筆換匯?"
      :dismissible="!deleting"
      @update:open="(v) => !v && (deleteTarget = null)"
    >
      <div v-if="deleteTarget" class="space-y-3">
        <div class="rounded-xl px-3 py-2.5" style="background: var(--bg-sunken)">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-sm">{{ memberName(deleteTarget.member_id) }}</span>
            <UiMoney :minor="deleteTarget.amount_minor" :currency="deleteTarget.currency" size="sm" />
          </div>
          <p class="mt-1 text-[0.6875rem] tnum" style="color: var(--text-muted)">
            {{ dayText(deleteTarget.exchanged_at) }}
            <span class="mx-1">·</span>
            {{ formatMoney(deleteTarget.cost_minor, deleteTarget.cost_currency) }}
            <span class="mx-1">·</span>
            @ {{ formatRate(rateOf(deleteTarget)) }}
          </p>
        </div>

        <ul v-if="deleteImpact.length" class="space-y-1.5 text-sm leading-relaxed">
          <li v-for="imp in deleteImpact" :key="imp.key">
            <template v-if="imp.vanishes">
              這是{{ memberName(deleteTarget.member_id) }}唯一一筆換到{{ CURRENCY_LABEL[imp.currency] ?? imp.currency }}的紀錄
              —— 刪掉之後那塊錢包會整個消失(他沒換過那個幣別,就沒有「還剩多少」可言)。
            </template>
            <template v-else>
              {{ CURRENCY_LABEL[imp.currency] ?? imp.currency }}的剩餘會從
              <span class="tnum font-semibold">{{ formatMoney(imp.from, imp.currency) }}</span>
              變成
              <span class="tnum font-semibold">{{ formatMoney(imp.to, imp.currency) }}</span>。
            </template>
          </li>
        </ul>

        <p class="text-sm leading-relaxed" style="color: var(--text-muted)">
          這筆會從歷史裡整個消失,無法復原。
          <strong style="color: var(--text)">誰欠誰、結算回合都不會受影響</strong> ——
          換匯紀錄不參與任何計價。
        </p>

        <p v-if="deleteError" class="text-sm leading-relaxed" role="alert" style="color: var(--debit)">
          {{ deleteError }}
        </p>
      </div>

      <template #footer>
        <UiAppButton variant="ghost" block :disabled="deleting" @click="deleteTarget = null">
          取消
        </UiAppButton>
        <UiAppButton variant="primary" block :loading="deleting" @click="confirmDelete">
          刪除
        </UiAppButton>
      </template>
    </UiAppSheet>
  </section>
</template>

<style scoped>
/*
  顏色一律走 main.css 的變數,深色模式自動跟著換。
  這幾個 class 和 overview.vue 的公費金流區用同一組名字與規格 ——
  兩區在同一頁上下並排,長得不一樣會看起來像兩套 UI。
  (scoped style 不能跨元件共用,所以是複製而不是 import;
   規格有變的話兩邊要一起改。)
*/

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-height: 32px;
  padding-inline: 0.5rem;
  border-radius: 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--brand);
  transition: background-color 0.15s ease;
}
@media (hover: hover) {
  .link-btn:hover {
    background: color-mix(in oklab, var(--brand) 10%, transparent);
  }
  .link-danger:hover {
    background: color-mix(in oklab, var(--debit) 10%, transparent);
  }
}
.link-btn:disabled {
  opacity: 0.45;
  pointer-events: none;
}
/* 刪除是唯一不可復原的動作,顏色要和「改」分得開 */
.link-danger {
  color: var(--debit);
}

.divided > * + * {
  border-top: 1px solid var(--border);
}
.row-head {
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--border);
}

/* 清單的展開入口。做成一整條可按的列,手指好按。 */
.list-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  padding-inline: 0.75rem;
  border-radius: 0.75rem;
  background: var(--bg-sunken);
  color: var(--text);
  transition: background-color 0.15s ease;
}
@media (hover: hover) {
  .list-toggle:hover {
    background: color-mix(in oklab, var(--brand) 8%, var(--bg-sunken));
  }
}

@media (prefers-reduced-motion: reduce) {
  .link-btn,
  .list-toggle {
    transition: none;
  }
}
</style>
