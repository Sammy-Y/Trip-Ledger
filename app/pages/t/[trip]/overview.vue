<script setup lang="ts">
/**
 * 總覽 —— 一頁看完這趟的全貌。
 *
 * 三塊,由上而下就是「我最想知道什麼」的順序:
 *  1. 公費還剩多少、誰出了多少（沒設公費就不顯示這塊）
 *  2. 這趟總共花了多少（逐幣別 + 換算本位幣的估算）
 *  3. 每人合計與淨額（誰墊得多、誰還要付）
 *
 * 逐幣別分開這件事在這頁同樣不能妥協:日幣和台幣不相加。
 * 只有「換算本位幣」那一欄是估算的參考值,而且必須標明。
 */
import type { Balance, Expense, Kind } from '~~/shared/types';
import { CURRENCY_LABEL, formatMoney } from '~~/shared/money';

const tripId = useTripId();
const api = useApi();
const { trip, members, pot, people, memberName } = useTrip(tripId);

const baseCurrency = computed(() => trip.value?.base_currency ?? 'TWD');
const pageTitle = computed(() => (trip.value?.name ? `${trip.value.name} — 總覽` : '總覽'));
useHead({ title: pageTitle });

// ── 資料 ────────────────────────────────────────────────────
// 和支出頁共用同一組 useAsyncData key,切頁不會重抓
function useExpenses(kind: Kind) {
  return useAsyncData<Expense[]>(
    () => `expenses:${tripId.value}:${kind}`,
    () => api.get<Expense[]>(`/api/trips/${encodeURIComponent(tripId.value)}/expenses`, { kind }),
    { default: () => [], deep: false, dedupe: 'defer' },
  );
}
const sharedTrack = useExpenses('shared');
const personalTrack = useExpenses('personal');

const balanceState = useAsyncData<Balance | null>(
  () => `balance:${tripId.value}`,
  () => api.get<Balance>(`/api/trips/${encodeURIComponent(tripId.value)}/balance`),
  { default: () => null, deep: false, dedupe: 'defer' },
);

const balance = computed(() => balanceState.data.value);
const potInfo = computed(() => balance.value?.pot ?? null);

const loading = computed(() =>
  balanceState.status.value === 'pending' && !balance.value);
// 三個請求都要看。只看 balance 的話,/expenses 掛掉時畫面會顯示
// 「還沒有任何花費」蓋在一趟其實有花費的旅程上 —— 那是靜靜說謊。
const errorMessage = computed(() => {
  for (const e of [balanceState.error.value, sharedTrack.error.value, personalTrack.error.value]) {
    if (e && !isAbortError(e)) return api.errorMessage(e);
  }
  return null;
});

async function refreshAll() {
  await Promise.all([
    balanceState.refresh({ dedupe: 'cancel' }),
    sharedTrack.refresh({ dedupe: 'cancel' }),
    personalTrack.refresh({ dedupe: 'cancel' }),
  ]);
}

// ── 這趟總花費（逐幣別）────────────────────────────────────────
interface CurrencyTotal { currency: string; sharedMinor: number; personalMinor: number; count: number }

const totals = computed<CurrencyTotal[]>(() => {
  const map = new Map<string, CurrencyTotal>();
  const add = (list: Expense[], key: 'sharedMinor' | 'personalMinor') => {
    for (const e of list) {
      const row = map.get(e.currency)
        ?? { currency: e.currency, sharedMinor: 0, personalMinor: 0, count: 0 };
      row[key] += e.amount_minor;
      row.count += 1;
      map.set(e.currency, row);
    }
  };
  add(sharedTrack.data.value ?? [], 'sharedMinor');
  add(personalTrack.data.value ?? [], 'personalMinor');
  // 本位幣優先,其餘按代碼 —— 不用金額排,跨幣別比大小沒有意義
  return [...map.values()].sort((a, b) => {
    if (a.currency === b.currency) return 0;
    if (a.currency === baseCurrency.value) return -1;
    if (b.currency === baseCurrency.value) return 1;
    return a.currency.localeCompare(b.currency);
  });
});

const hasExpenses = computed(() => totals.value.length > 0);

// ── 每人合計 ────────────────────────────────────────────────
const ZERO = { sharedOwedBase: 0, personalBase: 0, totalBase: 0, unconverted: 0 };

const memberStats = computed(() => {
  const perMember = balance.value?.per_member ?? {};
  // 公費不是人,它的「合計花費」沒有意義(它付的錢已經分攤給人了),所以不列進來
  return people.value
    .map(m => ({ id: m.id, name: m.name, ...(perMember[m.id] ?? ZERO) }))
    .sort((a, b) => b.totalBase - a.totalBase);
});

const tripTotalBase = computed(() => memberStats.value.reduce((s, r) => s + r.totalBase, 0));
const unconvertedCount = computed(() => memberStats.value.reduce((s, r) => s + r.unconverted, 0));

/** 每人的淨額(逐幣別)—— 誰還要付、誰還能收 */
const netsByMember = computed(() => {
  const out = new Map<string, Array<{ currency: string; netMinor: number }>>();
  for (const [cur, block] of Object.entries(balance.value?.by_currency ?? {})) {
    for (const n of block.nets) {
      const list = out.get(n.memberId) ?? [];
      list.push({ currency: cur, netMinor: n.netMinor });
      out.set(n.memberId, list);
    }
  }
  return out;
});

// ── 投入 / 退還公費 ──────────────────────────────────────────
/**
 * 「投入公費」在資料上就是一筆 settlement:某人 → 公費。
 * 用 settlements 而不是新開一張表是刻意的 —— 那就是「錢從 A 移到 B」,
 * 和還款是同一件事,結算引擎已經正確處理了它對淨額的影響。
 *
 * ── UI 的關鍵決定:勾人,金額只填一次 ──────────────────────
 *
 * 投入公費**天生是集體行為**:「今天大家說好各拿 5,000 出來」是一個決定,
 * 不是 N 個決定。所以介面是「勾選誰參與 + 填一次金額」,
 * 而不是每個人開一次對話框填一次(兩個人就要開兩次,四個人四次)。
 *
 * 但資料模型仍然是逐人一筆金額 —— 因為「每人一樣」是常見情況而不是規則
 * (有人先墊多一點、有人身上剛好沒零錢)。所以留一個「每人金額不同」的開關,
 * 打開後可以逐人微調。常見情況一次搞定,例外情況也表達得出來。
 */
const potSheetOpen = ref(false);
const potDirection = ref<'in' | 'out'>('in');
const potCurrency = ref('JPY');
/** 共用金額(人類單位)。每人金額不同時當成各人的預設值。 */
const potAmount = ref<number | null>(null);
/** 勾選的成員 id */
const potPicked = ref<string[]>([]);
/** 打開後可以逐人微調 */
const potPerPerson = ref(false);
/** 成員 id -> 人類單位金額(只有 potPerPerson 時才用) */
const potAmounts = ref<Record<string, number | null>>({});
const potSaving = ref(false);
const potError = ref('');

const CURRENCIES = ['JPY', 'TWD'];

const potExponent = computed(() => (potCurrency.value === 'JPY' ? 0 : 2));
const potStep = computed(() => (potExponent.value === 0 ? '1' : '0.01'));
function toMinorPot(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 10 ** potExponent.value);
}

function openPotSheet(direction: 'in' | 'out') {
  potDirection.value = direction;
  potCurrency.value = 'JPY';
  potAmount.value = null;
  // 預設全選 —— 投入公費幾乎都是全體一起,少數不參與的再取消勾選比較快
  potPicked.value = people.value.map(m => m.id);
  potPerPerson.value = false;
  potAmounts.value = {};
  potError.value = '';
  potSheetOpen.value = true;
}

const potPickedSet = computed(() => new Set(potPicked.value));
const isPicked = (id: string) => potPickedSet.value.has(id);

function togglePicked(id: string) {
  potPicked.value = isPicked(id)
    ? potPicked.value.filter(x => x !== id)
    : [...potPicked.value, id];
}
function pickAll() { potPicked.value = people.value.map(m => m.id); }
function pickNone() { potPicked.value = []; }

/** 切到逐人模式時,把共用金額帶進每個人 —— 從零開始填太慢 */
watch(potPerPerson, (on) => {
  if (!on) return;
  const next: Record<string, number | null> = {};
  for (const m of people.value) next[m.id] = potAmount.value;
  potAmounts.value = next;
});

function amountOf(id: string): number | null {
  if (!potPerPerson.value) return potAmount.value;
  // 逐人模式下,還沒被個別改過的人仍然跟著上面那個共用金額走。
  // 否則「先打開逐人開關、才輸入金額」的順序會讓上面的欄位變成死的:
  // 打了數字合計還是 0,畫面只說「還沒填金額」而不解釋為什麼。
  const own = potAmounts.value[id];
  return own == null ? potAmount.value : own;
}
function setAmountOf(id: string, v: number | null) {
  potAmounts.value = { ...potAmounts.value, [id]: v };
}

/** 送給 API 的 entries。只含勾選、且金額 > 0 的人。 */
const potEntries = computed(() =>
  potPicked.value
    .map(id => ({ member_id: id, amount_minor: toMinorPot(amountOf(id)) }))
    .filter(e => e.amount_minor > 0));

const potTotalMinor = computed(() => potEntries.value.reduce((s, e) => s + e.amount_minor, 0));

/** 勾了人但金額沒填 —— 要講出來,不然使用者會以為按鈕壞了 */
const potMissing = computed(() =>
  potPicked.value.filter(id => toMinorPot(amountOf(id)) <= 0));

const potProblems = computed<string[]>(() => {
  const out: string[] = [];
  if (!potPicked.value.length) out.push('請至少勾選一個人');
  else if (potMissing.value.length) {
    const names = potMissing.value.map(id => memberName(id)).join('、');
    out.push(`還沒填金額:${names}`);
  }
  return out;
});

const potCanSubmit = computed(() =>
  !!pot.value && potProblems.value.length === 0 && potEntries.value.length > 0 && !potSaving.value);

async function submitPot() {
  if (!potCanSubmit.value) return;
  potSaving.value = true;
  potError.value = '';
  try {
    // 一次寫完(server 用 dbh.batch)—— 不會出現「三個人裡寫進兩個」的半套狀態
    await api.post(`/api/trips/${encodeURIComponent(tripId.value)}/pot/moves`, {
      direction: potDirection.value,
      currency: potCurrency.value,
      entries: potEntries.value,
    });
    potSheetOpen.value = false;
    await refreshAll();
  } catch (e) {
    potError.value = api.errorMessage(e);
  } finally {
    potSaving.value = false;
  }
}
</script>

<template>
  <div class="space-y-5 py-1 md:py-2">
    <div class="flex items-center gap-3">
      <h1 class="flex-1 text-xl font-bold">
        總覽
      </h1>
      <UiAppButton
        variant="ghost" class="shrink-0 px-3 text-xs"
        :loading="balanceState.status.value === 'pending' && !!balance"
        @click="refreshAll"
      >
        <Icon name="lucide:refresh-cw" size="14" /> 重新整理
      </UiAppButton>
    </div>

    <UiLoadingBlock v-if="loading" :rows="6" />

    <div v-else-if="errorMessage" class="card p-4">
      <p class="text-sm" style="color: var(--debit)">
        {{ errorMessage }}
      </p>
      <UiAppButton variant="ghost" class="mt-3" @click="refreshAll">
        再試一次
      </UiAppButton>
    </div>

    <template v-else>
      <!-- ── 公費 ── -->
      <section v-if="pot" class="card p-4">
        <div class="flex items-start gap-3">
          <span
            class="grid h-9 w-9 shrink-0 place-items-center rounded-full"
            style="background: color-mix(in oklab, var(--warn) 18%, transparent); color: var(--warn)"
          >
            <Icon name="lucide:piggy-bank" size="18" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="font-semibold">
              {{ pot.name }}
            </h2>
            <p class="mt-0.5 text-xs leading-relaxed" style="color: var(--text-muted)">
              剩餘 = 投入 − 公費付掉的 − 已退還。逐幣別分開算。
            </p>
          </div>
        </div>

        <!-- 還沒有任何金流 -->
        <div v-if="!potInfo?.by_currency.length" class="mt-3 rounded-xl px-3 py-3" style="background: var(--bg-sunken)">
          <p class="text-sm" style="color: var(--text-muted)">
            還沒有人投入公費。先記下每個人拿了多少錢出來,之後記帳時勾「這筆從{{ pot.name }}付」就會自動均分。
          </p>
        </div>

        <div v-for="row in potInfo?.by_currency ?? []" :key="row.currency" class="mt-3">
          <div class="rounded-xl px-3 py-3" style="background: var(--bg-sunken)">
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-xs font-semibold">
                {{ CURRENCY_LABEL[row.currency] ?? row.currency }}剩餘
              </span>
              <span class="text-lg font-bold tnum"
                    :style="{ color: row.remainingMinor < 0 ? 'var(--debit)' : 'var(--credit)' }">
                {{ formatMoney(row.remainingMinor, row.currency) }}
              </span>
            </div>

            <!-- 負數代表公費被超支:付出去的比收進來的多,有人先墊了 -->
            <p v-if="row.remainingMinor < 0" class="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed"
               style="color: var(--warn)">
              <Icon name="lucide:circle-alert" size="14" class="mt-px shrink-0" />
              <span>公費超支 —— 付出去的比投入的多,差額實際上是由付款的人先墊著。</span>
            </p>

            <dl class="mt-2.5 grid grid-cols-3 gap-2 text-center">
              <div>
                <dt class="text-[0.6875rem]" style="color: var(--text-muted)">投入</dt>
                <dd class="tnum text-sm">{{ formatMoney(row.contributedMinor, row.currency) }}</dd>
              </div>
              <div>
                <dt class="text-[0.6875rem]" style="color: var(--text-muted)">已支出</dt>
                <dd class="tnum text-sm">{{ formatMoney(row.spentMinor, row.currency) }}</dd>
              </div>
              <div>
                <dt class="text-[0.6875rem]" style="color: var(--text-muted)">已退還</dt>
                <dd class="tnum text-sm">{{ formatMoney(row.refundedMinor, row.currency) }}</dd>
              </div>
            </dl>
          </div>

          <!-- 誰拿多少錢出來 —— 這是使用者明確要看到的東西 -->
          <div v-if="row.contributions.length" class="mt-2">
            <h3 class="px-1 text-[0.6875rem] font-semibold" style="color: var(--text-muted)">
              誰投入的
            </h3>
            <ul class="mt-1 divide-y" style="border-color: var(--border)">
              <li v-for="c in row.contributions" :key="c.memberId"
                  class="flex items-center justify-between gap-3 py-2">
                <span class="min-w-0 flex-1 truncate text-sm">{{ memberName(c.memberId) }}</span>
                <UiMoney :minor="c.amountMinor" :currency="row.currency" size="sm" />
              </li>
            </ul>
          </div>

          <div v-if="row.refunds.length" class="mt-2">
            <h3 class="px-1 text-[0.6875rem] font-semibold" style="color: var(--text-muted)">
              已退還給
            </h3>
            <ul class="mt-1 divide-y" style="border-color: var(--border)">
              <li v-for="r in row.refunds" :key="r.memberId"
                  class="flex items-center justify-between gap-3 py-2">
                <span class="min-w-0 flex-1 truncate text-sm">{{ memberName(r.memberId) }}</span>
                <UiMoney :minor="r.amountMinor" :currency="row.currency" size="sm" />
              </li>
            </ul>
          </div>
        </div>

        <div class="mt-3 flex gap-2">
          <UiAppButton variant="primary" block :disabled="!people.length" @click="openPotSheet('in')">
            <Icon name="lucide:plus" /> 投入公費
          </UiAppButton>
          <UiAppButton
            variant="ghost" block
            :disabled="!people.length || !potInfo?.by_currency.length"
            @click="openPotSheet('out')"
          >
            <Icon name="lucide:corner-down-left" /> 退還
          </UiAppButton>
        </div>
        <p v-if="!people.length" class="mt-2 text-xs" style="color: var(--warn)">
          這趟只有公費、沒有其他成員,先去「成員」加人。
        </p>
      </section>

      <!-- 沒設公費時給一個入口,不然使用者不知道有這功能 -->
      <section v-else class="card p-4">
        <h2 class="flex items-center gap-2 font-semibold">
          <Icon name="lucide:piggy-bank" size="18" style="color: var(--text-muted)" />
          還沒有設公費
        </h2>
        <p class="mt-1 text-sm leading-relaxed" style="color: var(--text-muted)">
          大家先各拿一筆錢出來放公費、吃飯門票直接從公費付的話,在「成員」頁建立公費,
          之後記帳勾一下就會自動均分,這裡也會算出還剩多少、誰出了多少。
        </p>
        <UiAppButton variant="ghost" class="mt-3" :to="`/t/${tripId}/members`">
          <Icon name="lucide:users" /> 去建立公費
        </UiAppButton>
      </section>

      <!-- ── 這趟總花費 ── -->
      <section class="card p-4">
        <h2 class="font-semibold">
          這趟總花費
        </h2>

        <UiEmptyState
          v-if="!hasExpenses"
          dense
          icon="lucide:receipt"
          title="還沒有任何花費"
          description="記第一筆之後,這裡會逐幣別列出共同與個人的合計。"
        >
          <UiAppButton :to="`/t/${tripId}/new`" icon="lucide:plus">
            記一筆
          </UiAppButton>
        </UiEmptyState>

        <template v-else>
          <div class="mt-2 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-[0.6875rem]" style="color: var(--text-muted)">
                  <th class="py-1.5 pr-2 font-semibold">幣別</th>
                  <th class="py-1.5 px-2 text-right font-semibold">共同</th>
                  <th class="py-1.5 px-2 text-right font-semibold">個人</th>
                  <th class="py-1.5 pl-2 text-right font-semibold">合計</th>
                </tr>
              </thead>
              <tbody class="divide-y" style="border-color: var(--border)">
                <tr v-for="row in totals" :key="row.currency">
                  <td class="py-2 pr-2">{{ CURRENCY_LABEL[row.currency] ?? row.currency }}</td>
                  <td class="tnum py-2 px-2 text-right">{{ formatMoney(row.sharedMinor, row.currency) }}</td>
                  <td class="tnum py-2 px-2 text-right">{{ formatMoney(row.personalMinor, row.currency) }}</td>
                  <td class="tnum py-2 pl-2 text-right font-semibold">
                    {{ formatMoney(row.sharedMinor + row.personalMinor, row.currency) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-xs leading-relaxed" style="color: var(--text-muted)">
            每個幣別各自一列,不相加 —— 日幣和台幣加在一起的數字沒有意義。
          </p>

          <div class="mt-3 flex items-baseline justify-between gap-3 rounded-xl px-3 py-2.5"
               style="background: var(--bg-sunken)">
            <span class="text-xs" style="color: var(--text-muted)">
              換算{{ CURRENCY_LABEL[baseCurrency] ?? baseCurrency }}(估算)
            </span>
            <span class="tnum text-base font-bold">{{ formatMoney(tripTotalBase, baseCurrency) }}</span>
          </div>
          <p v-if="unconvertedCount" class="mt-1.5 text-xs" style="color: var(--warn)">
            有 {{ unconvertedCount }} 筆沒有匯率可用,沒被算進換算金額裡。
          </p>
        </template>
      </section>

      <!-- ── 每人合計 ── -->
      <section v-if="memberStats.length" class="card p-4">
        <h2 class="font-semibold">
          每人合計
        </h2>
        <p class="mt-0.5 text-xs leading-relaxed" style="color: var(--text-muted)">
          共同分攤 + 個人花費 = 這個人這趟總共花了多少(換算{{ CURRENCY_LABEL[baseCurrency] ?? baseCurrency }},估算值)。
        </p>

        <ul class="mt-2 divide-y" style="border-color: var(--border)">
          <li v-for="m in memberStats" :key="m.id" class="py-2.5">
            <div class="flex items-center gap-3">
              <span
                class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
                style="background: color-mix(in oklab, var(--brand) 15%, transparent); color: var(--brand)"
              >
                {{ m.name.slice(0, 1) }}
              </span>
              <span class="min-w-0 flex-1 truncate font-medium">{{ m.name }}</span>
              <UiMoney :minor="m.totalBase" :currency="baseCurrency" />
            </div>
            <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 pl-11 text-[0.6875rem]"
                 style="color: var(--text-muted)">
              <span class="tnum">共同 {{ formatMoney(m.sharedOwedBase, baseCurrency) }}</span>
              <span class="tnum">個人 {{ formatMoney(m.personalBase, baseCurrency) }}</span>
              <span
                v-for="n in netsByMember.get(m.id) ?? []" :key="n.currency"
                class="tnum"
                :style="{ color: n.netMinor < 0 ? 'var(--debit)' : 'var(--credit)' }"
              >
                {{ n.netMinor < 0 ? '還要付' : '可收回' }}
                {{ formatMoney(Math.abs(n.netMinor), n.currency) }}
              </span>
            </div>
          </li>
        </ul>

        <UiAppButton variant="ghost" class="mt-3" :to="`/t/${tripId}/settle`">
          <Icon name="lucide:scale" /> 看誰要給誰多少
        </UiAppButton>
      </section>

      <p v-if="balance?.disclaimer" class="px-1 text-[0.6875rem] leading-relaxed"
         style="color: var(--text-muted)">
        {{ balance.disclaimer }}<br>
        {{ balance.rate_attribution }}
      </p>
    </template>

    <!-- ── 投入 / 退還公費 ── -->
    <UiAppSheet
      v-model:open="potSheetOpen"
      :title="potDirection === 'in' ? `投入${pot?.name ?? '公費'}` : `${pot?.name ?? '公費'}退還`"
      :dismissible="!potSaving"
    >
      <div class="space-y-4">
        <p class="text-sm leading-relaxed" style="color: var(--text-muted)">
          <template v-if="potDirection === 'in'">
            大家說好各拿多少出來 —— 勾選參與的人,金額只要填一次。
          </template>
          <template v-else>
            公費退還 —— 勾選要退給誰,金額只要填一次。旅程結束把剩下的現金分回去時用。
          </template>
        </p>

        <!-- 幣別 + 共用金額。金額填一次,套用到所有勾選的人。 -->
        <div class="grid grid-cols-2 gap-3">
          <UiAppField
            v-model="potCurrency" label="幣別" type="select"
            :options="CURRENCIES.map(c => ({ value: c, label: `${CURRENCY_LABEL[c] ?? c} (${c})` }))"
          />
          <UiAppField
            v-model.number="potAmount"
            :label="potPerPerson ? '金額(預設值)' : '每人金額'"
            type="number" :step="potStep" inputmode="decimal" placeholder="0"
          />
        </div>

        <!-- 勾選參與的人 -->
        <div>
          <div class="mb-1.5 flex items-center gap-2">
            <span class="label mb-0 flex-1">
              {{ potDirection === 'in' ? '誰拿錢出來' : '退還給誰' }}
            </span>
            <button type="button" class="link-btn" @click="pickAll">
              全選
            </button>
            <button type="button" class="link-btn" @click="pickNone">
              全不選
            </button>
          </div>

          <div class="space-y-1.5">
            <div
              v-for="m in people" :key="m.id"
              class="pick-row" :class="{ 'is-on': isPicked(m.id) }"
            >
              <button
                type="button" class="pick-toggle"
                :aria-pressed="isPicked(m.id)"
                @click="togglePicked(m.id)"
              >
                <span class="pick-box" :class="{ 'is-on': isPicked(m.id) }">
                  <Icon v-if="isPicked(m.id)" name="lucide:check" size="14" />
                </span>
                <span class="truncate">{{ m.name }}</span>
              </button>

              <!-- 逐人模式:每個人自己一個金額欄 -->
              <div v-if="potPerPerson && isPicked(m.id)" class="pick-amount">
                <input
                  class="cell-input tnum" type="number" :step="potStep"
                  min="0" inputmode="decimal" placeholder="0"
                  :value="amountOf(m.id) ?? ''"
                  :aria-label="`${m.name} 的金額`"
                  @input="setAmountOf(m.id, ($event.target as HTMLInputElement).value === ''
                    ? null : Number(($event.target as HTMLInputElement).value))"
                >
              </div>
              <!-- 共用模式:顯示他會被記多少,不用心算 -->
              <span v-else-if="isPicked(m.id) && potTotalMinor > 0" class="shrink-0 pr-2">
                <UiMoney :minor="toMinorPot(potAmount)" :currency="potCurrency" size="sm" />
              </span>
            </div>
          </div>

          <p v-if="!people.length" class="mt-2 text-xs" style="color: var(--warn)">
            這趟只有公費、沒有其他成員,先去「成員」頁加人。
          </p>
        </div>

        <!-- 例外情況的逃生門:多數時候每人一樣,但不是規則 -->
        <button
          type="button"
          class="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left"
          style="background: var(--bg-sunken)"
          :aria-pressed="potPerPerson"
          @click="potPerPerson = !potPerPerson"
        >
          <span class="pick-box" :class="{ 'is-on': potPerPerson }">
            <Icon v-if="potPerPerson" name="lucide:check" size="14" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm">每人金額不同</span>
            <span class="block text-xs" style="color: var(--text-muted)">
              有人先墊多一點、或身上沒零錢的時候打開,可以逐人微調。
            </span>
          </span>
        </button>

        <!-- 合計。這是送出前最後一道人眼檢查。 -->
        <div
          v-if="potEntries.length"
          class="flex items-baseline justify-between gap-3 rounded-xl px-3 py-2.5"
          style="background: var(--bg-sunken)"
        >
          <span class="text-xs" style="color: var(--text-muted)">
            {{ potEntries.length }} 人 · 合計{{ potDirection === 'in' ? '投入' : '退還' }}
          </span>
          <span class="tnum text-base font-bold">
            {{ formatMoney(potTotalMinor, potCurrency) }}
          </span>
        </div>

        <div v-if="potProblems.length" class="card p-3 text-sm" role="alert" style="border-color: var(--warn)">
          <div v-for="p in potProblems" :key="p" class="flex items-center gap-2" style="color: var(--warn)">
            <Icon name="lucide:alert-circle" class="shrink-0" /> {{ p }}
          </div>
        </div>

        <p v-if="potError" class="text-sm" role="alert" style="color: var(--debit)">
          {{ potError }}
        </p>
      </div>

      <div class="mt-4 flex gap-2">
        <UiAppButton variant="ghost" block @click="potSheetOpen = false">
          取消
        </UiAppButton>
        <UiAppButton variant="primary" block :loading="potSaving" :disabled="!potCanSubmit" @click="submitPot">
          記下來
        </UiAppButton>
      </div>
    </UiAppSheet>
  </div>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換。 */

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
}

.pick-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.75rem;
  padding-right: 0.25rem;
  transition: background-color 0.15s ease;
}
.pick-row.is-on {
  background: var(--bg-sunken);
}
.pick-toggle {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  align-items: center;
  gap: 0.625rem;
  min-height: 48px;
  padding-inline: 0.5rem;
  border-radius: 0.75rem;
  font-size: 0.9375rem;
  color: var(--text);
  text-align: left;
}
.pick-box {
  display: grid;
  place-items: center;
  width: 1.375rem;
  height: 1.375rem;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-elevated);
  color: var(--brand-text);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.pick-box.is-on {
  border-color: transparent;
  background: var(--brand);
}

.pick-amount {
  display: flex;
  align-items: center;
  width: 7rem;
  flex-shrink: 0;
  min-height: 44px;
  margin-block: 0.125rem;
  padding-inline: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-elevated);
  transition: border-color 0.15s ease;
}
.pick-amount:focus-within {
  border-color: var(--brand);
}
.cell-input {
  flex: 1 1 0;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: none;
  text-align: right;
  font-size: 0.9375rem;
  color: var(--text);
  -moz-appearance: textfield;
  appearance: textfield;
}
.cell-input::-webkit-outer-spin-button,
.cell-input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}

@media (prefers-reduced-motion: reduce) {
  .link-btn,
  .pick-row,
  .pick-box,
  .pick-amount {
    transition: none;
  }
}
</style>
