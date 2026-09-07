<script setup lang="ts">
/**
 * 骨架載入。自動註冊名稱是 <UiLoadingBlock>。
 *
 * 版型刻意做成「左邊兩行文字 + 右邊一段金額」——
 * 跟支出列表、成員列表、結算列表的實際版型一致,所以資料進來時不會整頁跳動。
 *
 *   <UiLoadingBlock v-if="pending" :rows="4" />
 *
 * variant:
 *   'list'  每列一張 .card(支出 / 預約 / 成員列表用)
 *   'plain' 不包卡片,只有灰條(卡片內部的區塊用)
 */
const props = withDefaults(defineProps<{
  /** 要畫幾列骨架。抓一個接近真實資料量的數字,不要只畫 1 列 */
  rows?: number;
  variant?: 'list' | 'plain';
  /** 右側是否留金額欄位的位置 */
  amount?: boolean;
  /** 給讀螢幕的人聽的狀態文字 */
  label?: string;
}>(), {
  rows: 3,
  variant: 'list',
  amount: true,
  label: '載入中',
});

/** 每列寬度稍微不同,看起來比較像真的文字而不是色塊 */
const WIDTHS = ['62%', '48%', '72%', '55%', '66%'];
const items = computed(() =>
  Array.from({ length: Math.max(1, Math.floor(props.rows)) }, (_, i) => ({
    key: i,
    width: WIDTHS[i % WIDTHS.length]!,
  })),
);
</script>

<template>
  <div class="animate-pulse space-y-2" role="status" aria-busy="true">
    <span class="sr-only">{{ label }}</span>

    <div
      v-for="item in items"
      :key="item.key"
      class="flex items-center gap-3"
      :class="variant === 'list' ? 'card px-4 py-3.5' : 'py-1'"
    >
      <div class="min-w-0 flex-1 space-y-2">
        <div
          class="h-3.5 rounded-full"
          :style="{ width: item.width, background: 'var(--bg-sunken)' }"
        />
        <div
          class="h-2.5 w-1/4 rounded-full"
          style="background: var(--bg-sunken)"
        />
      </div>
      <div
        v-if="amount"
        class="h-4 w-20 shrink-0 rounded-full"
        style="background: var(--bg-sunken)"
      />
    </div>
  </div>
</template>
