<script setup lang="ts">
import { formatMoney } from '~~/shared/money';

/**
 * 一筆轉帳建議:「民 → 喧 ¥4,415」。自動註冊名稱是 <SettleTransferCard>
 * (元件放在 components/settle/ 底下,Nuxt 會加路徑前綴)。
 *
 * 刻意只收「名字」而不是 member_id:轉 id → 名字是 useTrip 的責任,
 * 這個元件保持純顯示,才能在任何列表裡重複使用、也好測。
 *
 * 「標記已還款」只 emit 事件,實際打 API / 確認對話框由頁面負責 ——
 * 寫入操作集中在一處才不會有兩個地方各自送出。
 */
const props = withDefaults(defineProps<{
  /** 付款方(欠錢的人)的名字 */
  fromName: string;
  /** 收款方(墊錢的人)的名字 */
  toName: string;
  /** 最小單位整數。直接用 balance 給的 amountMinor,不要先除以 100 */
  amountMinor: number;
  /** 這個區塊的幣別。日幣台幣分開結算,絕不相加 */
  currency: string;
  /** 這筆正在送出 */
  loading?: boolean;
  /** 別筆正在送出時鎖住,避免同時記兩筆還款 */
  disabled?: boolean;
}>(), {
  loading: false,
  disabled: false,
});

const emit = defineEmits<{
  /** 使用者按下「標記已還款」。頁面接手做確認與 POST /settlements */
  settle: [];
}>();

/** 頭像用名字的第一個字(中文名很短,第一個字最好認) */
function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0]! : '?';
}

const fromInitial = computed(() => initial(props.fromName));
const toInitial = computed(() => initial(props.toName));

/** 給讀螢幕的人一句完整的話,而不是散落的三個欄位 */
const summary = computed(
  () => `${props.fromName} 要給 ${props.toName} ${formatMoney(props.amountMinor, props.currency)}`,
);
</script>

<template>
  <article class="card flex flex-col p-4" :aria-label="summary">
    <!-- 誰給誰。付款方紅(應付)、收款方綠(應收),和下面每人淨額的顏色語意一致 -->
    <div class="flex items-center gap-2">
      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        <span class="avatar avatar-debit">{{ fromInitial }}</span>
        <div class="min-w-0">
          <p class="truncate text-sm leading-tight font-medium">{{ fromName }}</p>
          <p class="mt-0.5 text-[0.6875rem] leading-none text-[var(--text-muted)]">付款</p>
        </div>
      </div>

      <span class="arrow" aria-hidden="true">
        <Icon name="lucide:arrow-right" size="15" />
      </span>

      <div class="flex min-w-0 flex-1 items-center justify-end gap-2.5">
        <div class="min-w-0 text-right">
          <p class="truncate text-sm leading-tight font-medium">{{ toName }}</p>
          <p class="mt-0.5 text-[0.6875rem] leading-none text-[var(--text-muted)]">收款</p>
        </div>
        <span class="avatar avatar-credit">{{ toInitial }}</span>
      </div>
    </div>

    <!-- 金額。右對齊 + .tnum(UiMoney 內建),卡片並排時數字才不會跳動 -->
    <div class="divider mt-3.5 flex items-baseline justify-between gap-3 pt-3.5">
      <span class="text-xs text-[var(--text-muted)]">轉帳金額</span>
      <UiMoney :minor="amountMinor" :currency="currency" size="lg" />
    </div>

    <UiAppButton
      class="mt-3.5"
      block
      icon="lucide:check"
      :loading="loading"
      :disabled="disabled"
      @click="emit('settle')"
    >
      標記已還款
    </UiAppButton>
  </article>
</template>

<style scoped>
/* 顏色全走 main.css 的變數,深色模式自動跟著換 */
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
.avatar-debit {
  background: color-mix(in oklab, var(--debit) 14%, transparent);
  color: var(--debit);
}
.avatar-credit {
  background: color-mix(in oklab, var(--credit) 14%, transparent);
  color: var(--credit);
}

.arrow {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 999px;
  background: var(--bg-sunken);
  color: var(--text-muted);
}

.divider {
  border-top: 1px solid var(--border);
}
</style>
