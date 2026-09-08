<script setup lang="ts">
import { formatMoney } from '~~/shared/money';

/**
 * 某個幣別裡「一個人的淨額」一列。自動註冊名稱是 <SettleMemberBalanceRow>。
 *
 * 淨額語意(分帳的核心):
 *   > 0 = 應收,他先墊了錢,別人要還他 → --credit(綠)
 *   < 0 = 應付,他要還別人            → --debit(紅)
 *   = 0 = 已結清                     → 灰
 * 上色與 +/- 交給 <UiMoney signed> 統一處理,這裡不自己算顏色。
 *
 * bar 是相對長度(ratio),以該幣別最大絕對值為 100%:
 * 向右綠 = 應收、向左紅 = 應付,一眼就能看出誰墊得最多。
 *
 * ⚠️ **公費不會用這個元件。** 它不是人,「應收 / 應付」的語意套在它身上是錯的
 * (新語意下它的淨額就等於公費付掉的錢),所以結算頁把它從淨額列表濾掉、
 * 改成卡片上方單獨一行 —— 同一欄擺兩種意義的數字是使用者看不懂的主因。
 */
const props = withDefaults(defineProps<{
  /** 成員名字(頁面用 useTrip 的 memberName 轉好再傳進來) */
  name: string;
  /** 最小單位整數的淨額。>0 應收 <0 應付 */
  netMinor: number;
  /** 這個區塊的幣別 */
  currency: string;
  /** 0..1,相對於同幣別最大絕對淨額。0 或不給就不畫 bar */
  ratio?: number;
}>(), {
  ratio: 0,
});

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0]! : '?';
}

const avatarInitial = computed(() => initial(props.name));

const state = computed<'credit' | 'debit' | 'zero'>(() => {
  if (props.netMinor > 0) return 'credit';
  if (props.netMinor < 0) return 'debit';
  return 'zero';
});

const stateLabel = computed(() => ({
  credit: '應收 · 別人要還他',
  debit: '應付 · 他要還別人',
  zero: '已結清',
}[state.value]));

/** bar 的半邊寬度(%)。中線是 0,所以單邊最多 50% */
const barWidth = computed(() => {
  const r = Number.isFinite(props.ratio) ? Math.min(Math.max(props.ratio, 0), 1) : 0;
  return r * 50;
});
const showBar = computed(() => barWidth.value > 0 && state.value !== 'zero');

const barStyle = computed(() => {
  const width = `${barWidth.value}%`;
  return state.value === 'credit'
    ? { left: '50%', width, background: 'var(--credit)' }
    : { right: '50%', width, background: 'var(--debit)' };
});

const rowLabel = computed(() => {
  const amount = formatMoney(Math.abs(props.netMinor), props.currency);
  if (state.value === 'credit') return `${props.name} 應收 ${amount}`;
  if (state.value === 'debit') return `${props.name} 應付 ${amount}`;
  return `${props.name} 已結清`;
});
</script>

<template>
  <div class="px-4 py-3" :aria-label="rowLabel">
    <div class="flex items-center gap-3">
      <span class="avatar" :class="`avatar-${state}`">{{ avatarInitial }}</span>

      <div class="min-w-0 flex-1">
        <p class="truncate text-sm leading-tight font-medium">{{ name }}</p>
        <p class="mt-0.5 text-[0.6875rem] leading-none text-[var(--text-muted)]">
          {{ stateLabel }}
        </p>
      </div>

      <UiMoney :minor="netMinor" :currency="currency" signed />
    </div>

    <!-- 相對長度 bar。中線 = 0,右綠應收 / 左紅應付 -->
    <div v-if="showBar" class="track" aria-hidden="true">
      <span class="tick" />
      <span class="fill" :style="barStyle" />
    </div>
  </div>
</template>

<style scoped>
.avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1;
}
.avatar-credit {
  background: color-mix(in oklab, var(--credit) 14%, transparent);
  color: var(--credit);
}
.avatar-debit {
  background: color-mix(in oklab, var(--debit) 14%, transparent);
  color: var(--debit);
}
.avatar-zero {
  background: var(--bg-sunken);
  color: var(--text-muted);
}

.track {
  position: relative;
  height: 0.25rem;
  margin-top: 0.625rem;
  border-radius: 999px;
  background: var(--bg-sunken);
}
.tick {
  position: absolute;
  inset-block: 0;
  left: 50%;
  width: 1px;
  background: var(--border);
}
.fill {
  position: absolute;
  inset-block: 0;
  border-radius: 999px;
}
</style>
