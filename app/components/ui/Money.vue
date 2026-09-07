<script setup lang="ts">
import { CURRENCY_LABEL, formatMinor, formatMoney } from '~~/shared/money';

/**
 * 金額顯示。自動註冊名稱是 <UiMoney>。
 *
 * 唯一該用來把 amount_minor 印到畫面上的東西 —— 絕對不要直接 {{ e.amount_minor }},
 * JPY 的 exponent 是 0、TWD 是 2,少了這層 908.00 台幣會印成 90800。
 *
 *   <UiMoney :minor="e.amount_minor" :currency="e.currency" />        ¥13,244
 *   <UiMoney :minor="net" currency="JPY" signed size="lg" />          +¥3,857(綠色)
 *
 * signed 的語意(分帳的核心):正數 = 應收(別人要還他,綠 --credit)、
 * 負數 = 應付(紅 --debit)、0 = 已結清(灰)。
 */
const props = withDefaults(defineProps<{
  /** 最小單位的整數金額(amount_minor)。 */
  minor: number;
  /** 'TWD' | 'JPY'。用旅程 / 支出上的 currency 欄位帶進來。 */
  currency: string;
  /** true = 依正負上色並強制顯示 +/-。用在結算頁的淨額。 */
  signed?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** 隱藏幣別符號,只顯示數字(欄位標題已經標明幣別時用)。 */
  bare?: boolean;
  /** 在金額後面加上「日幣 / 台幣」。跨幣別混排的列表用,避免看錯。 */
  withLabel?: boolean;
}>(), {
  signed: false,
  size: 'md',
  bare: false,
  withLabel: false,
});

const safeMinor = computed(() => (Number.isFinite(props.minor) ? props.minor : 0));

/** 正負號自己前置,formatMoney 只吃絕對值,才不會出現 ¥-3,857 這種排版 */
const sign = computed(() => {
  if (safeMinor.value < 0) return '-';
  return props.signed && safeMinor.value > 0 ? '+' : '';
});

const body = computed(() => {
  const abs = Math.abs(safeMinor.value);
  return props.bare ? formatMinor(abs, props.currency) : formatMoney(abs, props.currency);
});

const sizeClass = computed(() => ({
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-2xl tracking-tight',
}[props.size]));

/** 只出一個字重的 class,避免 font-medium / font-semibold 互相打架 */
const weightClass = computed(
  () => (props.size === 'lg' || props.signed ? 'font-semibold' : 'font-medium'),
);

/** signed 才上色。0 用灰色 —— 「已結清」不該是綠的。 */
const colorStyle = computed(() => {
  if (!props.signed) return undefined;
  if (safeMinor.value > 0) return { color: 'var(--credit)' };
  if (safeMinor.value < 0) return { color: 'var(--debit)' };
  return { color: 'var(--text-muted)' };
});

const label = computed(() => CURRENCY_LABEL[props.currency] ?? props.currency);

/** 給讀螢幕的人:+ 讀成「應收」比讀成「加」清楚 */
const ariaLabel = computed(() => {
  if (!props.signed) return undefined;
  const amount = formatMoney(Math.abs(safeMinor.value), props.currency);
  if (safeMinor.value > 0) return `應收 ${amount}`;
  if (safeMinor.value < 0) return `應付 ${amount}`;
  return `已結清 ${amount}`;
});
</script>

<template>
  <span
    class="tnum whitespace-nowrap"
    :class="[sizeClass, weightClass]"
    :style="colorStyle"
    :aria-label="ariaLabel"
  >{{ sign }}{{ body }}<span
    v-if="withLabel"
    class="ml-1 text-[0.75em] font-normal text-[var(--text-muted)]"
  >{{ label }}</span></span>
</template>
