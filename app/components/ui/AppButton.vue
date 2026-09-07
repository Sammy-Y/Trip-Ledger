<script setup lang="ts">
/**
 * 按鈕。自動註冊名稱是 <UiAppButton>(元件放在 components/ui/ 底下,Nuxt 會加路徑前綴)。
 *
 * - 套用設計系統的 .btn / .btn-primary / .btn-ghost(已含 min-height 44px 的 tap target)
 * - loading 時自己變成 disabled,不會被連點兩次送出兩筆
 * - 給了 to 就渲染成 <NuxtLink>(EmptyState 裡的「去記一筆」這種需求)
 * - 沒有 default slot 時會變成正方形的 icon 按鈕
 */
const props = withDefaults(defineProps<{
  /** primary = 實心品牌色(頁面主要動作);ghost = 次要動作 */
  variant?: 'primary' | 'ghost';
  /** true 時顯示轉圈並鎖住點擊 */
  loading?: boolean;
  disabled?: boolean;
  /** lucide 圖示名,例如 'lucide:plus'。loading 時會被轉圈取代 */
  icon?: string;
  /** 撐滿寬度。手機上的主要動作幾乎都要 block */
  block?: boolean;
  /** 表單裡要送出就設 'submit' */
  type?: 'button' | 'submit' | 'reset';
  /** 有值就渲染成連結(內部路由用相對路徑) */
  to?: string;
  /** 只有圖示、沒有文字時務必給,不然讀螢幕的人不知道這顆是什麼 */
  ariaLabel?: string;
}>(), {
  variant: 'primary',
  loading: false,
  disabled: false,
  icon: undefined,
  block: false,
  type: 'button',
  to: undefined,
  ariaLabel: undefined,
});

const slots = useSlots();

/** loading 也算不能按 */
const isInert = computed(() => props.disabled || props.loading);
/** 沒有文字內容 -> 正方形圖示按鈕 */
const iconOnly = computed(() => !slots.default);

// NuxtLink 要用 resolveComponent 才能丟給 <component :is>
const NuxtLinkComponent = resolveComponent('NuxtLink');
</script>

<template>
  <component
    :is="to ? NuxtLinkComponent : 'button'"
    :to="to || undefined"
    :type="to ? undefined : type"
    :disabled="to ? undefined : isInert"
    :aria-disabled="isInert || undefined"
    :aria-busy="loading || undefined"
    :aria-label="ariaLabel"
    class="btn"
    :class="[
      variant === 'primary' ? 'btn-primary' : 'btn-ghost',
      block && 'w-full',
      iconOnly ? 'px-0 w-11 shrink-0' : '',
      // NuxtLink 沒有 disabled 屬性,自己補上視覺與擋點擊
      to && isInert && 'opacity-40 pointer-events-none',
    ]"
  >
    <Icon
      v-if="loading"
      name="lucide:loader-circle"
      class="shrink-0 animate-spin"
      :size="iconOnly ? '20' : '18'"
    />
    <Icon
      v-else-if="icon"
      :name="icon"
      class="shrink-0"
      :size="iconOnly ? '20' : '18'"
    />
    <span v-if="!iconOnly" class="truncate"><slot /></span>
  </component>
</template>
