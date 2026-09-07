<script lang="ts">
import type { SplitMode } from '~~/shared/types';

/**
 * 分攤(誰受益 / 誰要出這筆錢)。自動註冊名稱是 <ExpenseSplitEditor>,
 * 不過 ExpenseForm 是用相對路徑明確 import 的,不依賴自動註冊。
 *
 * 三種模式對應 server 的 split payload:
 *   均分      → { mode:'equal',  members:[...] }        只列實際參與的人
 *   按份數    → { mode:'shares', shares:{ id: 份數 } }   2:1:1 或百分比都可以
 *   指定金額  → { mode:'exact',  amounts:{ id: 金額 } }  每人直接填
 *
 * 三種模式的 draft 各自獨立保存 —— 切模式回來時剛剛填的東西還在,
 * 不會被清掉(在店門口單手操作時最怕手滑切模式,一切就白填)。
 *
 * 每人分到多少(preview)、合計、差額都由 ExpenseForm 算好傳進來:
 * 送出按鈕的啟用條件必須和畫面上顯示的數字是同一份計算,不能各算一次。
 */
// 型別本體在 shared/split.ts —— 和 previewShares() 放一起,
// 才不會出現「draft 的形狀改了但算分攤的那份沒跟著改」。
export type { SplitDraft } from '~~/shared/split';
</script>

<script setup lang="ts">
import type { Member } from '~~/shared/types';
import { CURRENCY_SYMBOL, EXPONENT, formatMoney, fromMinor } from '~~/shared/money';

const props = defineProps<{
  members: Member[];
  currency: string;
  /** 支出總額(最小單位)。0 = 還沒填金額 */
  amountMinor: number;
  /** 成員 id -> 分到的最小單位金額。由 ExpenseForm 用和 server 相同的演算法算出 */
  preview: Record<string, number>;
  /** preview 的合計(最小單位) */
  sumMinor: number;
  /** 支出金額 - 合計。0 = 對上了 */
  diffMinor: number;
}>();

const model = defineModel<SplitDraft>({ required: true });

const MODES: Array<{ value: SplitMode; label: string; icon: string }> = [
  { value: 'equal', label: '均分', icon: 'lucide:equal' },
  { value: 'shares', label: '按份數', icon: 'lucide:chart-pie' },
  { value: 'exact', label: '指定金額', icon: 'lucide:pencil' },
];

const MODE_HINT: Record<SplitMode, string> = {
  equal: '勾選一起分攤的人,預設全選。',
  shares: '填份數,例如 2:1:1。填百分比(50/25/25)也可以,系統按比例換算。',
  exact: '每人直接填實際金額。留空的人不列入這筆分攤。',
};

const symbol = computed(() => CURRENCY_SYMBOL[props.currency] ?? '');
/** 台幣可以填到分,日幣只到整數 */
const step = computed(() => 1 / 10 ** (EXPONENT[props.currency] ?? 2));
const hasAmount = computed(() => props.amountMinor > 0);

/** 空字串要變成 null(而不是 0),才分得出「還沒填」和「填了 0」 */
function readNumber(event: Event): number | null {
  const raw = (event.target as HTMLInputElement).value;
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function setMode(mode: SplitMode): void {
  model.value = { ...model.value, mode };
}

// ── 均分 ────────────────────────────────────────────────────
const equalSet = computed(() => new Set(model.value.members));
function isJoined(id: string): boolean {
  return equalSet.value.has(id);
}
function toggleJoined(id: string): void {
  const next = isJoined(id)
    ? model.value.members.filter(x => x !== id)
    : props.members.filter(m => m.id === id || equalSet.value.has(m.id)).map(m => m.id);
  model.value = { ...model.value, members: next };
}
function selectAll(): void {
  model.value = { ...model.value, members: props.members.map(m => m.id) };
}
function selectNone(): void {
  model.value = { ...model.value, members: [] };
}

/**
 * 均分除不盡時,server 用「最大餘數法」把餘數各給 1 個最小單位,
 * 拿到多的是誰依成員 id 排序決定(結果可重現,方便日後對帳)。
 * 這裡從 preview 反推出「誰多分了」,直接把名字寫出來 ——
 * 使用者看到自己多 1 元卻沒解釋,會以為程式算錯。
 */
const equalRemainder = computed<{ names: string[]; unit: string } | null>(() => {
  if (model.value.mode !== 'equal' || !hasAmount.value) return null;
  const ids = model.value.members;
  if (ids.length < 2) return null;
  const values = ids.map(id => props.preview[id] ?? 0);
  const min = Math.min(...values);
  const extras = ids.filter(id => (props.preview[id] ?? 0) > min);
  if (!extras.length) return null;
  const nameOf = (id: string) => props.members.find(m => m.id === id)?.name ?? '成員';
  return { names: extras.map(nameOf), unit: formatMoney(1, props.currency) };
});

// ── 按份數 ──────────────────────────────────────────────────
function shareOf(id: string): number | null {
  return model.value.shares[id] ?? null;
}
function setShare(id: string, value: number | null): void {
  model.value = { ...model.value, shares: { ...model.value.shares, [id]: value } };
}
/** 份數合計,用來算每人的百分比 */
const shareTotal = computed(() =>
  props.members.reduce((sum, m) => sum + Math.max(0, shareOf(m.id) ?? 0), 0));

function sharePercent(id: string): string | null {
  const total = shareTotal.value;
  const value = shareOf(id) ?? 0;
  if (total <= 0 || value <= 0) return null;
  const pct = (value / total) * 100;
  return `${pct.toLocaleString('zh-TW', { maximumFractionDigits: 1 })}%`;
}
function setAllShares(value: number | null): void {
  const next: Record<string, number | null> = {};
  for (const m of props.members) next[m.id] = value;
  model.value = { ...model.value, shares: next };
}

// ── 指定金額 ────────────────────────────────────────────────
function amountOf(id: string): number | null {
  return model.value.amounts[id] ?? null;
}
function setAmount(id: string, value: number | null): void {
  model.value = { ...model.value, amounts: { ...model.value.amounts, [id]: value } };
}
/** 把差額補給某個人 —— 最後一個人的金額幾乎都是「剩下的」 */
function fillRemainder(id: string): void {
  const currentMinor = props.preview[id] ?? 0;
  const nextMinor = currentMinor + props.diffMinor;
  model.value = {
    ...model.value,
    amounts: { ...model.value.amounts, [id]: nextMinor / 10 ** exponent.value },
  };
}
/** 從均分帶入,再手動微調 —— 比一個一個從零開始填快得多 */
function prefillFromEqual(): void {
  if (!hasAmount.value) return;
  const ids = props.members.map(m => m.id).sort();
  const n = ids.length;
  if (!n) return;
  const base = Math.floor(props.amountMinor / n);
  let remainder = props.amountMinor - base * n;
  const next: Record<string, number | null> = {};
  for (const id of ids) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    next[id] = (base + extra) / 10 ** exponent.value;
  }
  model.value = { ...model.value, amounts: next };
}

const exponent = computed(() => (props.currency === 'JPY' ? 0 : 2));


// ── 合計 / 差額 ─────────────────────────────────────────────
/** 參與人數(依模式各自判定) */
const joinedCount = computed(() => {
  if (model.value.mode === 'equal') return model.value.members.length;
  if (model.value.mode === 'shares') {
    return props.members.filter(m => (shareOf(m.id) ?? 0) > 0).length;
  }
  return props.members.filter(m => amountOf(m.id) != null).length;
});

const diffState = computed<{ tone: string; icon: string; text: string }>(() => {
  if (props.diffMinor === 0) {
    return { tone: 'var(--credit)', icon: 'lucide:check', text: '合計剛好等於支出金額' };
  }
  if (props.diffMinor > 0) {
    return {
      tone: 'var(--warn)',
      icon: 'lucide:circle-alert',
      text: `還差 ${formatMoney(props.diffMinor, props.currency)} 沒分出去`,
    };
  }
  return {
    tone: 'var(--debit)',
    icon: 'lucide:circle-alert',
    text: `超出 ${formatMoney(-props.diffMinor, props.currency)}`,
  };
});

// 成員名單變動:把不存在的人從三種 draft 裡清掉,新成員自動加入均分
watch(() => props.members, (list) => {
  const ids = new Set(list.map(m => m.id));
  const keptMembers = model.value.members.filter(id => ids.has(id));
  const newIds = list.filter(m => !model.value.members.includes(m.id) && !seen.value.has(m.id));
  const nextMembers = [...keptMembers, ...newIds.map(m => m.id)];
  const pick = <T,>(source: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(source).filter(([id]) => ids.has(id)));
  model.value = {
    ...model.value,
    members: list.filter(m => nextMembers.includes(m.id)).map(m => m.id),
    shares: pick(model.value.shares),
    amounts: pick(model.value.amounts),
  };
  seen.value = ids;
});
/** 已經處理過的成員 id —— 用來分辨「新加入的成員」和「使用者自己取消勾選的人」 */
const seen = ref(new Set(props.members.map(m => m.id)));
</script>

<template>
  <section class="card p-3 md:p-4">
    <div class="mb-3">
      <h2 class="text-sm font-semibold">
        誰要分攤
      </h2>
      <p class="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
        實際受益的人。和上面「誰付的錢」可以完全不同。
      </p>
    </div>

    <!-- ── 模式切換 ── -->
    <div class="seg" role="group" aria-label="分攤方式">
      <button
        v-for="m in MODES"
        :key="m.value"
        type="button"
        class="seg-btn"
        :class="{ 'is-on': model.mode === m.value }"
        :aria-pressed="model.mode === m.value"
        @click="setMode(m.value)"
      >
        <Icon :name="m.icon" size="15" class="shrink-0" />
        <span>{{ m.label }}</span>
      </button>
    </div>
    <p class="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
      {{ MODE_HINT[model.mode] }}
    </p>

    <!-- ── 均分 ── -->
    <div v-if="model.mode === 'equal'" class="mt-3">
      <div class="mb-1.5 flex items-center justify-end gap-1">
        <button type="button" class="link-btn" @click="selectAll">
          全選
        </button>
        <button type="button" class="link-btn" @click="selectNone">
          全不選
        </button>
      </div>
      <div class="space-y-1.5">
        <div
          v-for="m in members"
          :key="m.id"
          class="row"
          :class="{ 'is-on': isJoined(m.id) }"
        >
          <button
            type="button"
            class="row-toggle"
            :aria-pressed="isJoined(m.id)"
            @click="toggleJoined(m.id)"
          >
            <span class="box" :class="{ 'is-on': isJoined(m.id) }">
              <Icon v-if="isJoined(m.id)" name="lucide:check" size="14" />
            </span>
            <span class="truncate">{{ m.name }}</span>
          </button>
          <span v-if="isJoined(m.id) && hasAmount" class="shrink-0 pr-2">
            <UiMoney :minor="preview[m.id] ?? 0" :currency="currency" size="sm" />
          </span>
        </div>
      </div>
      <p
        v-if="equalRemainder"
        class="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-[var(--text-muted)]"
      >
        <Icon name="lucide:info" size="14" class="mt-px shrink-0" />
        <span>
          除不盡,{{ equalRemainder.names.join('、') }}
          各多分攤 {{ equalRemainder.unit }}(依成員代碼排序,同一筆的結果固定不變)。
        </span>
      </p>
    </div>

    <!-- ── 按份數 ── -->
    <div v-else-if="model.mode === 'shares'" class="mt-3">
      <div class="mb-1.5 flex items-center justify-end gap-1">
        <button type="button" class="link-btn" @click="setAllShares(1)">
          每人 1 份
        </button>
        <button type="button" class="link-btn" @click="setAllShares(null)">
          全部清空
        </button>
      </div>
      <div class="space-y-1.5">
        <div
          v-for="m in members"
          :key="m.id"
          class="row"
          :class="{ 'is-on': (shareOf(m.id) ?? 0) > 0 }"
        >
          <span class="row-label">{{ m.name }}</span>
          <span
            v-if="hasAmount && (shareOf(m.id) ?? 0) > 0"
            class="shrink-0 text-xs text-[var(--text-muted)]"
          >
            {{ sharePercent(m.id) }}
          </span>
          <span v-if="hasAmount && (shareOf(m.id) ?? 0) > 0" class="shrink-0">
            <UiMoney :minor="preview[m.id] ?? 0" :currency="currency" size="sm" />
          </span>
          <div class="amount-cell shares-cell">
            <input
              class="cell-input tnum"
              type="number"
              inputmode="decimal"
              step="0.5"
              min="0"
              placeholder="0"
              :value="shareOf(m.id) ?? ''"
              :aria-label="`${m.name} 的份數`"
              @input="setShare(m.id, readNumber($event))"
            >
            <span class="cur">份</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 指定金額 ── -->
    <div v-else class="mt-3">
      <div class="mb-1.5 flex items-center justify-end gap-1">
        <button type="button" class="link-btn" :disabled="!hasAmount" @click="prefillFromEqual">
          <Icon name="lucide:equal" size="14" />
          從均分帶入
        </button>
      </div>
      <div class="space-y-1.5">
        <div
          v-for="m in members"
          :key="m.id"
          class="row"
          :class="{ 'is-on': amountOf(m.id) != null }"
        >
          <span class="row-label">{{ m.name }}</span>
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
              :aria-label="`${m.name} 分攤多少`"
              @input="setAmount(m.id, readNumber($event))"
            >
          </div>
          <button
            v-if="hasAmount && diffMinor !== 0"
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

    <!-- ── 合計 / 差額(三種模式都要即時顯示)── -->
    <div class="mt-3 rounded-xl px-3 py-2.5" style="background: var(--bg-sunken)">
      <template v-if="!hasAmount">
        <p class="text-xs text-[var(--text-muted)]">
          填上面的金額之後,這裡會即時顯示每人分攤多少。
        </p>
      </template>
      <template v-else-if="joinedCount === 0">
        <p class="text-xs" style="color: var(--warn)">
          還沒有人要分攤這筆。共同花費至少要有一個人。
        </p>
      </template>
      <template v-else>
        <div class="flex items-center justify-between gap-3 text-xs">
          <span class="text-[var(--text-muted)]">
            {{ joinedCount }} 人分攤 · 合計 / 應為
          </span>
          <span class="tnum">
            <UiMoney :minor="sumMinor" :currency="currency" size="sm" />
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
      </template>
    </div>
  </section>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換。 */

.seg {
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--border);
  border-radius: 0.875rem;
  background: var(--bg-sunken);
}
.seg-btn {
  display: inline-flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  min-width: 0;
  min-height: 40px; /* + 容器 padding = 48px tap target */
  padding-inline: 0.375rem;
  border-radius: 0.625rem;
  font-size: 0.875rem;
  color: var(--text-muted);
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.12s ease;
}
.seg-btn:active {
  transform: scale(0.97);
}
.seg-btn.is-on {
  background: color-mix(in oklab, var(--brand) 14%, var(--bg-elevated));
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
.row-label {
  flex: 1 1 0;
  min-width: 0;
  padding-inline: 0.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9375rem;
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

/* 列內數字欄:外觀對齊 main.css 的 .field,單位放在框內 */
.amount-cell {
  display: flex;
  align-items: center;
  gap: 0.25rem;
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
.amount-cell:focus-within {
  border-color: var(--brand);
}
.shares-cell {
  width: 5.5rem;
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
  -moz-appearance: textfield;
  appearance: textfield;
}
.cell-input::-webkit-outer-spin-button,
.cell-input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}

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
.link-btn:disabled {
  opacity: 0.4;
  pointer-events: none;
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
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--brand);
  transition: transform 0.12s ease;
}
.icon-btn:active {
  transform: scale(0.94);
}

@media (prefers-reduced-motion: reduce) {
  .seg-btn,
  .row,
  .box,
  .amount-cell,
  .link-btn,
  .icon-btn {
    transition: none;
  }
  .seg-btn:active,
  .icon-btn:active {
    transform: none;
  }
}
</style>
