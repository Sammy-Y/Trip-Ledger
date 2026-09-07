<script lang="ts">
/**
 * 付款人(誰墊的錢)。自動註冊名稱是 <ExpensePayerEditor>,
 * 不過 ExpenseForm 是用相對路徑明確 import 的,不依賴自動註冊。
 *
 * 這個編輯器只負責「誰墊錢」,和「誰受益」(SplitEditor)是兩組不同的人 ——
 * 例:喧刷卡付了 6,274,實際是民用 3,857、喧用 2,417。
 * 付款人 = 喧一個人;分攤 = 民 3,857 / 喧 2,417。
 *
 * 兩種模式:
 *   單一付款人 → model 只有一筆且 amount = null。
 *                server 的規則是「payers 只有一筆且沒帶 amount 就視為全額」,
 *                所以這裡刻意保持 amount = null,不要自己填金額進去。
 *   多人共同墊款 → 每人各填金額,合計必須等於支出金額。
 *
 * 合計 / 差額由 ExpenseForm 算好用 summary 傳進來 ——
 * 送出按鈕的啟用條件和這裡顯示的差額必須是同一個數字,不能各算一次。
 */
export interface PayerDraft {
  /** 成員 id */
  member_id: string;
  /** 人類單位金額(日幣 3857 就是 3857)。null = 還沒填 */
  amount: number | null;
}
</script>

<script setup lang="ts">
import type { Member } from '~~/shared/types';
import { CURRENCY_SYMBOL, formatMoney, fromMinor, toMinor } from '~~/shared/money';

const props = withDefaults(defineProps<{
  members: Member[];
  currency: string;
  /** 支出總額(最小單位)。0 = 還沒填金額 */
  amountMinor: number;
  /** 由 ExpenseForm 計算的合計 / 差額 */
  summary: { filledMinor: number; diffMinor: number; treatedAsFull: boolean };
  /** 個人花費:只會有一位「花錢的人」,不提供多人墊款 */
  singleOnly?: boolean;
  /** 區塊標題(個人花費時改成「這筆是誰花的」) */
  title?: string;
}>(), {
  singleOnly: false,
  title: '誰付的錢',
});

const model = defineModel<PayerDraft[]>({ required: true });

/** 多人墊款模式。初始值看 model 裡已經有幾筆(表單重掛載時才會 >1) */
const multi = ref(model.value.length > 1);

const symbol = computed(() => CURRENCY_SYMBOL[props.currency] ?? '');
/** 台幣可以填到分,日幣只到整數 */
const step = computed(() => (props.currency === 'JPY' ? 1 : 0.01));

const isMulti = computed(() => multi.value && !props.singleOnly);

/** 成員清單的順序 —— 選取結果照這個順序排,勾選誰都不會讓列表跳動 */
const memberOrder = computed(() => new Map(props.members.map((m, i) => [m.id, i])));

function sortRows(rows: PayerDraft[]): PayerDraft[] {
  return [...rows].sort(
    (a, b) => (memberOrder.value.get(a.member_id) ?? 0) - (memberOrder.value.get(b.member_id) ?? 0),
  );
}

const selectedIds = computed(() => new Set(model.value.map(p => p.member_id)));
function isSelected(id: string): boolean {
  return selectedIds.value.has(id);
}
function amountOf(id: string): number | null {
  return model.value.find(p => p.member_id === id)?.amount ?? null;
}

/** 單一模式:點一下就換人(不是勾選,是取代) */
function pickSingle(id: string): void {
  model.value = [{ member_id: id, amount: null }];
}

function toggle(id: string): void {
  if (isSelected(id)) {
    model.value = model.value.filter(p => p.member_id !== id);
    return;
  }
  model.value = sortRows([...model.value, { member_id: id, amount: null }]);
}

function setAmount(id: string, value: number | null): void {
  model.value = model.value.map(p => (p.member_id === id ? { ...p, amount: value } : p));
}

/** 空字串要變成 null(而不是 0),表單才分得出「還沒填」和「填了 0」 */
function onAmountInput(id: string, event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  if (raw === '') {
    setAmount(id, null);
    return;
  }
  const n = Number(raw);
  setAmount(id, Number.isFinite(n) ? n : null);
}

// ── 模式切換 ────────────────────────────────────────────────
function enableMulti(): void {
  multi.value = true;
}

/** 收回單一模式:留下第一位,並把金額清成 null(= 視為全額) */
function disableMulti(): void {
  multi.value = false;
  const first = model.value[0];
  model.value = first ? [{ member_id: first.member_id, amount: null }] : [];
}

// 切成個人花費時強制收回單一模式,不然會留下一堆填了金額的列
watch(() => props.singleOnly, (only) => {
  if (only && model.value.length > 1) disableMulti();
});

// 成員被刪掉 / 名單更新時,把不存在的人從選取中移除
watch(() => props.members, (list) => {
  const ids = new Set(list.map(m => m.id));
  const kept = model.value.filter(p => ids.has(p.member_id));
  if (kept.length !== model.value.length) model.value = kept;
});

// ── 快捷填法 ────────────────────────────────────────────────
/**
 * 平均分配墊款金額。刻意在「最小單位」上除,再換回人類單位,
 * 除不盡的餘數給前幾位 —— 這樣合計一定剛好等於支出金額,
 * 不會出現 908.5 / 3 = 302.83 × 3 = 908.49 這種差一分錢送不出去的狀況。
 */
function fillEvenly(): void {
  const rows = model.value;
  if (!rows.length || props.amountMinor <= 0) return;
  const base = Math.floor(props.amountMinor / rows.length);
  let remainder = props.amountMinor - base * rows.length;
  model.value = rows.map((p) => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    return { ...p, amount: fromMinor(base + extra, props.currency) };
  });
}

/** 把還沒填的差額補給某個人(常見情境:只知道其中一人付了多少) */
function fillRemainder(id: string): void {
  const current = amountOf(id);
  const currentMinor = current == null ? 0 : toMinor(current, props.currency);
  setAmount(id, fromMinor(currentMinor + props.summary.diffMinor, props.currency));
}

// ── 顯示用文字 ──────────────────────────────────────────────
const hasAmount = computed(() => props.amountMinor > 0);

/** 差額狀態:對上 / 還差 / 超出。文字要講清楚差多少,不能只說「不符」 */
const diffState = computed<{ tone: string; icon: string; text: string }>(() => {
  const { diffMinor } = props.summary;
  if (diffMinor === 0) {
    return { tone: 'var(--credit)', icon: 'lucide:check', text: '剛好對上支出金額' };
  }
  if (diffMinor > 0) {
    return {
      tone: 'var(--warn)',
      icon: 'lucide:circle-alert',
      text: `還差 ${formatMoney(diffMinor, props.currency)} 沒有人認`,
    };
  }
  return {
    tone: 'var(--debit)',
    icon: 'lucide:circle-alert',
    text: `超出 ${formatMoney(-diffMinor, props.currency)}`,
  };
});
</script>

<template>
  <section class="card p-3 md:p-4">
    <div class="mb-3 flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-semibold">
          {{ title }}
        </h2>
        <p class="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
          <template v-if="singleOnly">
            個人花費就記在這個人名下。
          </template>
          <template v-else-if="isMulti">
            每人填自己實際付出去的金額。
          </template>
          <template v-else>
            先墊錢的人。和「誰要分攤」是兩件事。
          </template>
        </p>
      </div>

      <button
        v-if="!singleOnly"
        type="button"
        class="link-btn shrink-0"
        @click="isMulti ? disableMulti() : enableMulti()"
      >
        <Icon :name="isMulti ? 'lucide:user' : 'lucide:users'" size="14" />
        {{ isMulti ? '單一付款人' : '多人墊款' }}
      </button>
    </div>

    <!-- ── 單一付款人:一排人名,點一下就選好 ── -->
    <div v-if="!isMulti" class="flex flex-wrap gap-2">
      <button
        v-for="m in members"
        :key="m.id"
        type="button"
        class="chip"
        :class="{ 'is-on': isSelected(m.id) }"
        :aria-pressed="isSelected(m.id)"
        @click="pickSingle(m.id)"
      >
        <Icon v-if="isSelected(m.id)" name="lucide:check" size="15" class="shrink-0" />
        <span class="truncate">{{ m.name }}</span>
      </button>
    </div>

    <!-- ── 多人共同墊款:勾選 + 各自金額 ── -->
    <div v-else class="space-y-1.5">
      <div
        v-for="m in members"
        :key="m.id"
        class="row"
        :class="{ 'is-on': isSelected(m.id) }"
      >
        <button
          type="button"
          class="row-toggle"
          :aria-pressed="isSelected(m.id)"
          @click="toggle(m.id)"
        >
          <span class="box" :class="{ 'is-on': isSelected(m.id) }">
            <Icon v-if="isSelected(m.id)" name="lucide:check" size="14" />
          </span>
          <span class="truncate">{{ m.name }}</span>
        </button>

        <div v-if="isSelected(m.id)" class="flex shrink-0 items-center gap-1.5">
          <!--
            這裡刻意用原生 input 而不是 <UiAppField>:每一列沒有可見的 label,
            要靠 aria-label 命名,而 UiAppField 沒有 ariaLabel prop
            (傳進去只會落在外層 div,輸入框本身會沒有無障礙名稱)。
          -->
          <div class="amount-cell">
            <span class="cur">{{ symbol }}</span>
            <input
              class="cell-input tnum"
              type="number"
              inputmode="decimal"
              :step="step"
              min="0"
              placeholder="0"
              :value="amountOf(m.id) ?? ''"
              :aria-label="`${m.name} 付了多少`"
              @input="onAmountInput(m.id, $event)"
            >
          </div>
          <button
            v-if="hasAmount && summary.diffMinor !== 0 && amountOf(m.id) === null"
            type="button"
            class="icon-btn"
            :aria-label="`把差額填給 ${m.name}`"
            :title="`把差額填給 ${m.name}`"
            @click="fillRemainder(m.id)"
          >
            <Icon name="lucide:wand-sparkles" size="16" />
          </button>
        </div>
      </div>
    </div>

    <!-- ── 合計 / 差額 ── -->
    <div class="mt-3 rounded-xl px-3 py-2.5" style="background: var(--bg-sunken)">
      <template v-if="!model.length">
        <p class="text-xs text-[var(--text-muted)]">
          還沒選付款人。沒有付款人就算不出誰欠誰,所以這欄一定要填。
        </p>
      </template>

      <template v-else-if="summary.treatedAsFull">
        <p class="flex items-start gap-1.5 text-xs leading-relaxed text-[var(--text-muted)]">
          <Icon name="lucide:info" size="14" class="mt-px shrink-0" />
          <span v-if="hasAmount">
            {{ members.find(m => m.id === model[0]?.member_id)?.name ?? '這個人' }}
            付了全額
            <UiMoney :minor="amountMinor" :currency="currency" size="sm" />
          </span>
          <span v-else>先填上面的金額,這裡就會顯示他付了多少。</span>
        </p>
      </template>

      <template v-else>
        <div class="flex items-center justify-between gap-3 text-xs">
          <span class="text-[var(--text-muted)]">已填 / 應為</span>
          <span class="tnum">
            <UiMoney :minor="summary.filledMinor" :currency="currency" size="sm" />
            <span class="mx-1 text-[var(--text-muted)]">/</span>
            <UiMoney :minor="amountMinor" :currency="currency" size="sm" />
          </span>
        </div>
        <p
          class="mt-1.5 flex items-center gap-1.5 text-xs font-medium"
          :style="{ color: diffState.tone }"
        >
          <Icon :name="diffState.icon" size="14" class="shrink-0" />
          <span>{{ diffState.text }}</span>
        </p>
        <button
          v-if="hasAmount && model.length > 1"
          type="button"
          class="link-btn mt-2"
          @click="fillEvenly"
        >
          <Icon name="lucide:split" size="14" />
          平均分配墊款
        </button>
      </template>
    </div>
  </section>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換。 */

.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 44px; /* 手機 tap target 下限 */
  max-width: 100%;
  padding-inline: 0.875rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 0.9375rem;
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.12s ease;
}
.chip:active {
  transform: scale(0.97);
}
.chip.is-on {
  border-color: transparent;
  background: color-mix(in oklab, var(--brand) 14%, transparent);
  color: var(--brand);
  font-weight: 600;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.75rem;
  padding-right: 0.25rem;
  transition: background-color 0.15s ease;
}
.row.is-on {
  background: var(--bg-sunken);
}
.row-toggle {
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
.box {
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
.box.is-on {
  border-color: transparent;
  background: var(--brand);
}

/* 列內金額欄:外觀對齊 main.css 的 .field,但把幣別符號放進框內左側 */
.amount-cell {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  width: 7rem;
  min-height: 44px;
  padding-inline: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-elevated);
  transition: border-color 0.15s ease;
}
.amount-cell:focus-within {
  border-color: var(--brand);
}
.cur {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
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
}
/* 上下小箭頭在記帳表單裡只會誤觸,而且會擠掉右對齊的金額 */
.cell-input::-webkit-outer-spin-button,
.cell-input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}
.cell-input {
  -moz-appearance: textfield;
  appearance: textfield;
}

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-height: 32px;
  padding-inline: 0.5rem;
  margin-inline: -0.5rem;
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

.icon-btn {
  display: grid;
  place-items: center;
  width: 2.25rem;
  height: 2.25rem;
  flex-shrink: 0;
  border-radius: 0.625rem;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--brand);
  transition: transform 0.12s ease;
}
.icon-btn:active {
  transform: scale(0.94);
}

@media (prefers-reduced-motion: reduce) {
  .chip,
  .row,
  .box,
  .link-btn,
  .icon-btn {
    transition: none;
  }
  .chip:active,
  .icon-btn:active {
    transform: none;
  }
}
</style>
