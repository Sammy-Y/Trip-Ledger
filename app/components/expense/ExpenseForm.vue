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
import { previewShares } from '~~/shared/split';
import type { PayerDraft } from './PayerEditor.vue';
import type { SplitDraft } from './SplitEditor.vue';

const props = defineProps<{
  members: Member[];
  baseCurrency: string;
  /** 換匯加成的預設值(%),來自 server 設定 */
  fxDefaults?: { cash_spread_pct: number; card_fee_pct: number };
  submitting?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{ submit: [payload: Record<string, unknown>] }>();

/** 公費不是人。它可以付錢,但永遠不該出現在分攤名單裡。 */
const pot = computed<Member | null>(() => props.members.find((m) => m.is_pot) ?? null);
const people = computed<Member[]>(() => props.members.filter((m) => !m.is_pot));

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

/**
 * 成員載入後給預設值:第一個「人」付錢、全員均分。
 * 均分名單刻意排除公費 —— 公費是出錢的一方,不是受益人,
 * 把它勾進去會讓它替自己分攤一份,結算就錯了。
 */
watch(people, (ms) => {
  if (!ms.length) return;
  if (!payers.value.length) payers.value = [{ member_id: ms[0]!.id, amount: null }];
  if (!split.value.members.length) split.value = { ...split.value, members: ms.map((m) => m.id) };
}, { immediate: true });

const amountMinor = computed(() =>
  amountInput.value == null || Number.isNaN(amountInput.value)
    ? 0 : toMinor(amountInput.value, currency.value));

// ── 公費 ────────────────────────────────────────────────────
/**
 * 「這筆是公費付的」。打開之後付款人固定是公費、分攤固定是全體成員均分 ——
 * 這就是公費的定義:大家先把錢拿出來,之後從那筆錢付,誰都不用再各付各的。
 * 所以這裡直接把付款人與分攤鎖住,不讓使用者手動改到自相矛盾的組合。
 */
const fromPot = ref(false);

/** 切到個人花費、或這趟根本沒設公費時,這個開關要自動關掉 */
watch([kind, pot], () => {
  if (kind.value !== 'shared' || !pot.value) fromPot.value = false;
});

watch([fromPot, pot, people, kind], () => {
  if (!fromPot.value || kind.value !== 'shared') return;
  const potId = pot.value?.id;
  if (!potId) return;
  payers.value = [{ member_id: potId, amount: null }];
  split.value = { ...split.value, mode: 'equal', members: people.value.map((m) => m.id) };
});

// ── 付款試算 ──
const payerSummary = computed(() => {
  const single = payers.value.length === 1 && payers.value[0]?.amount == null;
  const filledMinor = single
    ? amountMinor.value
    : payers.value.reduce((s, p) => s + (p.amount ? toMinor(p.amount, currency.value) : 0), 0);
  return { filledMinor, diffMinor: amountMinor.value - filledMinor, treatedAsFull: single };
});

/** 個人花費的「分攤」對象:就是付款人自己 */
const personalOwner = computed(() => payers.value[0]?.member_id ?? '');

// ── 分攤試算(和 server 同一份演算法,而且和測試同一份程式碼)──
// 規則本體在 shared/split.ts 的 previewShares() —— 抽出去才測得到。
// 個人花費「全額算給付款人」這條規則原本埋在這裡,結果送出鈕被永久鎖住
// 而 56 個 API 測試全綠,因為沒有任何測試碰得到 .vue 裡的 computed。
const splitPreview = computed<Record<string, number>>(() => previewShares({
  kind: kind.value,
  amountMinor: amountMinor.value,
  draft: split.value,
  ownerId: personalOwner.value,
  toMinorFn: (v) => toMinor(v, currency.value),
}));

const splitSumMinor = computed(() => Object.values(splitPreview.value).reduce((a, b) => a + b, 0));
const splitDiffMinor = computed(() => amountMinor.value - splitSumMinor.value);

// ── 送出前的驗證(和 server 的規則一致)──
const problems = computed(() => {
  const out: string[] = [];
  if (!description.value.trim()) out.push('請填寫說明');
  if (!amountMinor.value) out.push('請填寫金額');
  if (!payers.value.length || payers.value.some((p) => !p.member_id)) out.push('請選擇付款人');
  else if (payerSummary.value.diffMinor !== 0) out.push('付款金額合計與支出金額不符');
  // 個人花費的分攤是自動推出來的,不會、也不該有「請選擇分攤的人」這種問題
  if (kind.value === 'shared') {
    if (!Object.keys(splitPreview.value).length) out.push('請選擇分攤的人');
    else if (splitDiffMinor.value !== 0) out.push('分攤金額合計與支出金額不符');
  }
  return out;
});
const canSubmit = computed(() => problems.value.length === 0 && !props.submitting);

function buildPayload() {
  const d = split.value;
  let splitPayload: Record<string, unknown>;
  // 個人花費:全額算給付款人自己。用 exact 而不是 equal,
  // 因為 equal 會在未來多人時被誤解成「均分給這些人」。
  if (kind.value === 'personal') {
    splitPayload = { mode: 'exact', amounts: { [personalOwner.value]: amountInput.value } };
  }
  else if (d.mode === 'equal') splitPayload = { mode: 'equal', members: d.members };
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
    // 本位幣不需要換匯,送 undefined 讓 server 自己歸零
    fx_markup_pct: isForeign.value ? markupPct.value : undefined,
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

// ── 換匯加成:刷卡的國外交易手續費 / 現金的換匯價差 ──────────────
/**
 * 台灣發卡行的「國外交易手續費」= 國際組織費 + 發卡行加收,
 * 實務上 Visa / Mastercard / JCB 多為合計 **1.5%**(AmEx 約 2%)。
 * 所以預設值放 1.5%,但各家卡真的不一樣 —— 使用者自己最清楚,要能改。
 *
 * 預設值的唯一來源是 server 的 runtimeConfig(cardFeePct / cashSpreadPct),
 * 經 GET /api/trips/:trip 的 fx_defaults 帶進來,前端不自己寫死一份。
 */
const DEFAULT_MARKUP = { cash: 1.5, card: 1.5 };

const markupDefault = computed(() => {
  if (!isForeign.value) return 0;
  const d = props.fxDefaults;
  return paymentMethod.value === 'card'
    ? (d?.card_fee_pct ?? DEFAULT_MARKUP.card)
    : (d?.cash_spread_pct ?? DEFAULT_MARKUP.cash);
});

const markupInput = ref<number | null>(null);
/** 使用者自己改過的話,就不要再被切換付款方式蓋掉 */
const markupTouched = ref(false);

/** 沒被改過就跟著付款方式 / 幣別自動帶入預設值 */
watch(markupDefault, (next) => {
  if (!markupTouched.value) markupInput.value = next;
}, { immediate: true });

const markupPct = computed(() => {
  if (!isForeign.value) return 0;
  const v = markupInput.value;
  return v == null || !Number.isFinite(v) ? markupDefault.value : v;
});

function resetMarkup(): void {
  markupTouched.value = false;
  markupInput.value = markupDefault.value;
}

/** 加成之後,1 外幣實際被當成多少本位幣 —— 讓使用者看得到這個%到底影響什麼 */
const markupHint = computed(() => {
  const pct = markupPct.value;
  if (!isForeign.value) return '';
  if (!pct) return '不加計任何手續費,直接用當日中價換算。';
  return `換算時在當日中價上加 ${pct}% —— ${
    paymentMethod.value === 'card' ? '相當於國外交易手續費' : '相當於換鈔價差'}。`;
});
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

      <!-- 國外交易手續費 / 換鈔價差。有預設值,但一定要能改 —— 每張卡都不一樣 -->
      <div v-if="isForeign">
        <div class="flex items-baseline justify-between gap-2">
          <span class="label">
            {{ paymentMethod === 'card' ? '國外交易手續費' : '換匯價差' }}
          </span>
          <button
            v-if="markupPct !== markupDefault"
            type="button" class="text-xs" style="color: var(--brand)"
            @click="resetMarkup">
            回到預設 {{ markupDefault }}%
          </button>
        </div>
        <div class="markup-cell">
          <input
            v-model.number="markupInput"
            class="cell-input tnum" type="number" step="0.1" min="0" max="100"
            inputmode="decimal" :placeholder="String(markupDefault)"
            :aria-label="paymentMethod === 'card' ? '國外交易手續費百分比' : '換匯價差百分比'"
            @input="markupTouched = true" />
          <span class="cur">%</span>
        </div>
        <p class="mt-1.5 text-xs leading-relaxed" style="color: var(--text-muted)">
          {{ markupHint }}
          <template v-if="paymentMethod === 'card' && !markupTouched">
            台灣的 Visa / Mastercard / JCB 多為 1.5%(AmEx 約 2%),你的卡不同的話直接改。
          </template>
        </p>
      </div>

      <UiAppField v-model="category" label="分類" placeholder="餐飲 / 交通 / 購物(選填)" />
    </div>

    <!-- ── 公費:一鍵套用「公費付錢、全員均分」 ── -->
    <div v-if="kind === 'shared' && pot" class="card p-4">
      <button type="button" class="flex w-full items-center gap-3 text-left" @click="fromPot = !fromPot">
        <span class="pot-box" :class="{ 'is-on': fromPot }">
          <Icon v-if="fromPot" name="lucide:check" size="14" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-semibold">這筆從{{ pot.name }}付</span>
          <span class="block text-xs" style="color: var(--text-muted)">
            付款人設為{{ pot.name }},並由 {{ people.length }} 位成員均分。
          </span>
        </span>
      </button>
      <p v-if="fromPot" class="mt-3 flex items-start gap-1.5 text-xs leading-relaxed"
         style="color: var(--text-muted)">
        <Icon name="lucide:info" size="14" class="mt-px shrink-0" />
        <span>
          付款人與分攤已鎖定。{{ pot.name }}本身不分攤 ——
          它是出錢的一方,剩多少會在「總覽」算出來。
        </span>
      </p>
    </div>

    <ExpensePayerEditor
      v-if="!fromPot"
      v-model="payers" :members="members" :currency="currency"
      :amount-minor="amountMinor" :summary="payerSummary" />

    <ExpenseSplitEditor
      v-if="kind === 'shared' && !fromPot"
      v-model="split" :members="people" :currency="currency"
      :amount-minor="amountMinor" :preview="splitPreview"
      :sum-minor="splitSumMinor" :diff-minor="splitDiffMinor" />

    <div v-else-if="kind === 'personal'" class="card p-4 text-sm" style="color: var(--text-muted)">
      <Icon name="lucide:user" class="inline mr-1.5" />
      個人花費不分攤,全額算在付款人自己頭上。
    </div>

    <!-- 公費模式:不給編輯,但要看得到結果,不然是黑箱 -->
    <div v-else-if="fromPot" class="card p-4">
      <h2 class="text-sm font-semibold">每人分攤</h2>
      <ul class="mt-2 space-y-1">
        <li v-for="m in people" :key="m.id" class="flex items-center justify-between gap-3 text-sm">
          <span class="truncate">{{ m.name }}</span>
          <UiMoney :minor="splitPreview[m.id] ?? 0" :currency="currency" size="sm" />
        </li>
      </ul>
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

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換。 */

/* 百分比輸入框:外觀對齊 SplitEditor 的列內數字欄,單位放在框內 */
.markup-cell {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  width: 7rem;
  min-height: 44px;
  padding-inline: 0.625rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-elevated);
  transition: border-color 0.15s ease;
}
.markup-cell:focus-within {
  border-color: var(--brand);
}
.markup-cell .cur {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.markup-cell .cell-input {
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
.markup-cell .cell-input::-webkit-outer-spin-button,
.markup-cell .cell-input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}

.pot-box {
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
.pot-box.is-on {
  border-color: transparent;
  background: var(--brand);
}

@media (prefers-reduced-motion: reduce) {
  .markup-cell,
  .pot-box {
    transition: none;
  }
}
</style>
