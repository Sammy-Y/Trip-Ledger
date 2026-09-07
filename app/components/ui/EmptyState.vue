<script setup lang="ts">
/**
 * 空狀態。自動註冊名稱是 <UiEmptyState>。
 *
 * 空狀態要告訴使用者「下一步做什麼」,不要只寫「沒有資料」。
 *
 *   <UiEmptyState
 *     icon="lucide:receipt"
 *     title="還沒有任何花費"
 *     description="在店門口付完錢就順手記一筆,回國才不用對帳對到天亮。"
 *   >
 *     <UiAppButton :to="`/t/${tripId}/new`" icon="lucide:plus">記一筆</UiAppButton>
 *   </UiEmptyState>
 */
withDefaults(defineProps<{
  /** lucide 圖示名,例如 'lucide:receipt' */
  icon?: string;
  /** 一句話講清楚現在是什麼狀況 */
  title: string;
  /** 引導文案:告訴使用者接下來可以做什麼 */
  description?: string;
  /** 密集版(放在卡片裡、或當作列表區塊的空狀態時用) */
  dense?: boolean;
}>(), {
  icon: 'lucide:inbox',
  description: undefined,
  dense: false,
});
</script>

<template>
  <div
    class="flex flex-col items-center justify-center text-center"
    :class="dense ? 'px-4 py-8' : 'px-6 py-14'"
  >
    <div
      class="mb-4 flex items-center justify-center rounded-2xl"
      :class="dense ? 'size-11' : 'size-14'"
      style="background: var(--bg-sunken); border: 1px solid var(--border)"
    >
      <Icon
        :name="icon"
        :size="dense ? '20' : '24'"
        class="text-[var(--text-muted)]"
      />
    </div>

    <p class="font-semibold" :class="dense ? 'text-sm' : 'text-base'">
      {{ title }}
    </p>
    <p
      v-if="description"
      class="mt-1.5 max-w-[22rem] text-sm leading-relaxed text-[var(--text-muted)]"
    >
      {{ description }}
    </p>

    <!-- 行動按鈕放這裡。多顆會自動並排,手機窄的時候換行 -->
    <div v-if="$slots.default" class="mt-5 flex flex-wrap items-center justify-center gap-2">
      <slot />
    </div>
  </div>
</template>
