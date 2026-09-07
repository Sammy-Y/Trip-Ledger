<script setup lang="ts">
/**
 * 記一筆支出。這是整個 App 最重要的畫面。
 *
 * 兩個設計重點:
 *
 * 1. **付款人與分攤人是分開的兩組人。**
 *    例如「喧刷卡付了 6,274,但實際是民用 3,857、喧用 2,417」——
 *    付款人是喧,分攤是民/喧各自的金額。原本 Excel 只能把這種事寫進備註,
 *    所以永遠算不出誰欠誰。
 *
 * 2. **即時試算,不讓 server 的 400 打臉使用者。**
 *    分攤與付款的合計必須等於支出金額,server 會擋。
 *    但使用者不該在按下送出後才知道差了 3 塊 —— 所以這裡用
 *    shared/split.ts(和 server 同一份程式碼)即時算出差額並顯示。
 */
import type { Kind, PaymentMethod, Member } from '~~/shared/types';
import { toMinor, EXPONENT, CURRENCY_LABEL } from '~~/shared/money';
import { splitEqually, splitByShares } from '~~/shared/split';
import type { PayerDraft } from './PayerEditor.vue';
import type { SplitDraft } from './SplitEditor.vue';

const props = defineProps<{
  members: Member[];
  baseCurrency: string;
  submitting?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{ submit: [payload: Record<string, unknown>] }>();

const CURRENCIES = ['JPY', 'TWD'];

/** 今天(當地時區)的 YYYY-MM-DD。不能用 toISOString,那是 UTC,晚上會少一天。 */
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const kind = ref<Kind>('shared');
const description = ref('');
const category = ref('');
const currency = ref('JPY');
const amountInput = ref<number | null>(null);
const paymentMethod = ref<PaymentMethod>('cash');
const spentAt = ref(todayLocal());
const note = ref('');
const fxOverride = ref<number | null>(null);
const showAdvanced = ref(false);

const payers = ref<PayerDraft[]>([]);
const split = ref<SplitDraft>({ mode: 'equal', members: [], shares: {}, amounts: {} });

/** 成員載入後給預設值:第一個人付錢、全員均分。 */
watch(() => props.members, (ms) => {
  if (!ms.length) return;
  if (!payers.value.length) payers.value = [{ member_id: ms[0]!.id, amount: null }];
  if (!split.value.members.length) split.value = { ...split.value, members: ms.map((m) => m.id) };
}, { immediate: true });

/** 個人花費:分攤就是付款人自己,不需要使用者再選一次。 */
watch([kind, payers], () => {
  if (kind.value !== 'personal') return;
  const owner = payers.value[0]?.member_id;
  if (owner) split.value = { mode: 'exact', members: [owner], shares: {}, amounts: { [owner]: null } };
}, { deep: true });

const amountMinor = computed(() =>
  amountInput.value == null || Number.isNaN(amountInput.value)
    ? 0 : toMinor(amountInput.value, currency.value));

// ── 付款試算 ──
const payerSummary = computed(() => {
  const single = payers.value.length === 1 && payers.value[0]?.amount == null;
  const filledMinor = single
    ? amountMinor.value
    : payers.value.reduce((s, p) => s + (p.amount ? toMinor(p.amount, currency.value) : 0), 0);
  return { filledMinor, diffMinor: amountMinor.value - filledMinor, treatedAsFull: single };
});

// ── 分攤試算(和 server 同一份演算法)──
const splitPreview = computed<Record<string, number>>(() => {
  const d = split.value;
  if (!amountMinor.value) return {};
  if (d.mode === 'equal') {
    return d.members.length ? Object.fromEntries(splitEqually(amountMinor.value, d.members)) : {};
  }
  if (d.mode === 'shares') {
    const s: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.shares)) if (v && v > 0) s[k] = v;
    return Object.keys(s).length ? Object.fromEntries(splitByShares(amountMinor.value, s)) : {};
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(d.amounts)) if (v != null && v !== 0) out[k] = toMinor(v, currency.value);
  return out;
});

const splitSumMinor = computed(() => Object.values(splitPreview.value).reduce((a, b) => a + b, 0));
const splitDiffMinor = computed(() => amountMinor.value - splitSumMinor.value);

// ── 送出前的驗證(和 server 的規則一致)──
const problems = computed(() => {
  const out: string[] = [];
  if (!description.value.trim()) out.push('請填寫說明');
  if (!amountMinor.value) out.push('請填寫金額');
  if (!payers.value.length || payers.value.some((p) => !p.member_id)) out.push('請選擇付款人');
  else if (payerSummary.value.diffMinor !== 0) out.push('付款金額合計與支出金額不符');
  if (!Object.keys(splitPreview.value).length) out.push('請選擇分攤的人');
  else if (splitDiffMinor.value !== 0) out.push('分攤金額合計與支出金額不符');
  return out;
});
const canSubmit = computed(() => problems.value.length === 0 && !props.submitting);

function buildPayload() {
  const d = split.value;
  let splitPayload: Record<string, unknown>;
  if (d.mode === 'equal') splitPayload = { mode: 'equal', members: d.members };
  else if (d.mode === 'shares') {
    const s: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.shares)) if (v && v > 0) s[k] = v;
    splitPayload = { mode: 'shares', shares: s };
  } else {
    const a: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.amounts)) if (v != null && v !== 0) a[k] = v;
    splitPayload = { mode: 'exact', amounts: a };
  }
  return {
    kind: kind.value,
    description: description.value.trim(),
    category: category.value.trim() || undefined,
    currency: currency.value,
    // 注意:這裡送「人類單位」,server 會自己轉最小單位(和 settlements 端點不同)
    amount: amountInput.value,
    payment_method: paymentMethod.value,
    spent_at: spentAt.value,
    note: note.value.trim() || undefined,
    fx_rate_override: fxOverride.value ?? undefined,
    payers: payers.value.map((p) => (p.amount == null ? { member_id: p.member_id } : { member_id: p.member_id, amount: p.amount })),
    split: splitPayload,
  };
}

function onSubmit() {
  if (!canSubmit.value) return;
  emit('submit', buildPayload());
}

const isForeign = computed(() => currency.value !== props.baseCurrency);
const amountStep = computed(() => (EXPONENT[currency.value] === 0 ? '1' : '0.01'));
</script>

<template>
  <form class="space-y-5" @submit.prevent="onSubmit">
    <!-- 共同 / 個人:雙軌帳本的入口,放最上面 -->
    <div class="card p-1.5 grid grid-cols-2 gap-1.5">
      <button
        v-for="opt in ([{ v: 'shared', l: '共同花費', d: '要分攤' }, { v: 'personal', l: '個人花費', d: '只算我的' }] as const)"
        :key="opt.v" type="button"
        class="rounded-xl py-2.5 px-3 text-center transition"
        :style="kind === opt.v
          ? 'background: color-mix(in oklab, var(--brand) 15%, transparent); color: var(--brand)'
          : 'color: var(--text-muted)'"
        @click="kind = opt.v">
        <div class="font-semibold text-sm">{{ opt.l }}</div>
        <div class="text-xs opacity-70">{{ opt.d }}</div>
      </button>
    </div>

    <div class="card p-4 space-y-4">
      <UiAppField v-model="description" label="說明" placeholder="例如:3/8 吃飯" required />

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UiAppField
          v-model="currency" label="幣別" type="select"
          :options="CURRENCIES.map((c) => ({ value: c, label: `${CURRENCY_LABEL[c] ?? c} (${c})` }))" />
        <UiAppField
          v-model.number="amountInput" label="金額" type="number"
          :step="amountStep" inputmode="decimal" placeholder="0" required />
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UiAppField v-model="spentAt" label="日期" type="date" />
        <div>
          <span class="label">付款方式</span>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="m in ([{ v: 'cash', l: '現金', i: 'lucide:banknote' }, { v: 'card', l: '刷卡', i: 'lucide:credit-card' }] as const)"
              :key="m.v" type="button" class="btn"
              :class="paymentMethod === m.v ? 'btn-primary' : 'btn-ghost'"
              @click="paymentMethod = m.v">
              <Icon :name="m.i" /> {{ m.l }}
            </button>
          </div>
        </div>
      </div>

      <!-- 換算誤差要講清楚,不要讓使用者以為這是精準金額 -->
      <p v-if="isForeign" class="text-xs leading-relaxed" style="color: var(--text-muted)">
        <template v-if="paymentMethod === 'card'">
          刷卡以「店家請款日」的匯率計價,通常在消費後數日至數週。系統先用當日中價加計手續費估算,
          實際金額以銀行帳單為準 —— 收到帳單後可用下方的「覆寫匯率」回填正確數字。
        </template>
        <template v-else>
          現金以當日中價加計換匯價差估算,與你實際換到的匯率會有落差。
        </template>
      </p>

      <UiAppField v-model="category" label="分類" placeholder="餐飲 / 交通 / 購物(選填)" />
    </div>

    <ExpensePayerEditor
      v-model="payers" :members="members" :currency="currency"
      :amount-minor="amountMinor" :summary="payerSummary" />

    <ExpenseSplitEditor
      v-if="kind === 'shared'"
      v-model="split" :members="members" :currency="currency"
      :amount-minor="amountMinor" :preview="splitPreview"
      :sum-minor="splitSumMinor" :diff-minor="splitDiffMinor" />

    <div v-else class="card p-4 text-sm" style="color: var(--text-muted)">
      <Icon name="lucide:user" class="inline mr-1.5" />
      個人花費不分攤,全額算在付款人自己頭上。
    </div>

    <!-- 進階:匯率覆寫。收合起來,因為多數時候不需要 -->
    <div v-if="isForeign" class="card p-4">
      <button type="button" class="w-full flex items-center justify-between text-sm font-medium"
              @click="showAdvanced = !showAdvanced">
        <span>進階:自訂匯率</span>
        <Icon :name="showAdvanced ? 'lucide:chevron-up' : 'lucide:chevron-down'" />
      </button>
      <div v-if="showAdvanced" class="mt-3 space-y-2">
        <UiAppField
          v-model.number="fxOverride" type="number" step="0.000001"
          :label="`1 ${currency} = ? ${baseCurrency}`" placeholder="留空則用當日匯率" />
        <p class="text-xs" style="color: var(--text-muted)">
          收到信用卡帳單後,可以用帳單上的實際匯率回填,這筆的換算金額就會精準。
        </p>
      </div>
    </div>

    <UiAppField v-model="note" label="備註" type="textarea" placeholder="選填" />

    <!-- 差額要在送出前就講明白,不要讓 server 的 400 來打臉 -->
    <div v-if="problems.length" class="card p-3 text-sm" style="border-color: var(--warn)">
      <div v-for="p in problems" :key="p" class="flex items-center gap-2" style="color: var(--warn)">
        <Icon name="lucide:alert-circle" class="shrink-0" /> {{ p }}
      </div>
    </div>
    <div v-if="errorMessage" class="card p-3 text-sm" style="border-color: var(--debit); color: var(--debit)">
      {{ errorMessage }}
    </div>

    <!-- 手機上黏在底部,拇指可及 -->
    <div class="sticky bottom-0 pt-2 pb-1"
         style="background: linear-gradient(to top, var(--bg) 60%, transparent)">
      <UiAppButton type="submit" variant="primary" block :disabled="!canSubmit" :loading="submitting">
        <Icon name="lucide:check" /> 記下這筆
      </UiAppButton>
    </div>
  </form>
</template>
