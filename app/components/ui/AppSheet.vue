<script setup lang="ts">
/**
 * 彈出面板。自動註冊名稱是 <UiAppSheet>。
 *
 * 手機 = 從底部滑上來的 bottom sheet(拇指可及);md 以上 = 置中對話框。
 * 用來取代 window.alert / confirm / prompt —— 那些在 PWA 裡又醜又不能客製,一律不用。
 *
 *   <UiAppSheet v-model:open="showConfirm" title="刪除這筆花費?">
 *     <p class="text-sm text-[var(--text-muted)]">刪掉之後結算會立刻重算,無法復原。</p>
 *     <template #footer>
 *       <UiAppButton variant="ghost" block @click="showConfirm = false">取消</UiAppButton>
 *       <UiAppButton block :loading="deleting" @click="remove()">刪除</UiAppButton>
 *     </template>
 *   </UiAppSheet>
 *
 * 行為:Esc 關閉、點背景關閉、開啟時鎖住背景滾動、開啟時焦點移進面板並鎖在裡面(Tab 循環)、
 * 關閉後焦點回到原本的元素。
 */
const props = withDefaults(defineProps<{
  /** 標題。留空就不畫標題列(整片自由排版) */
  title?: string;
  /**
   * 可否用 Esc / 點背景關閉。送出中想避免使用者手滑關掉時設 false
   * (右上角的 X 也會跟著隱藏,只能由程式關閉)
   */
  dismissible?: boolean;
  /** md 以上的對話框寬度 */
  size?: 'sm' | 'md' | 'lg';
}>(), {
  title: undefined,
  dismissible: true,
  size: 'md',
});

/** v-model:open */
const open = defineModel<boolean>('open', { default: false });

const emit = defineEmits<{
  /** 面板關閉後觸發(不論來自 Esc、背景、X 或程式)。適合用來重設表單狀態 */
  close: [];
}>();

const panelEl = useTemplateRef<HTMLElement>('panelEl');
const titleId = useId();

const widthClass = computed(() => ({
  sm: 'md:max-w-sm',
  md: 'md:max-w-md',
  lg: 'md:max-w-xl',
}[props.size]));

/** force = 由 X 或程式觸發,不受 dismissible 限制 */
function close(force = false) {
  if (!force && !props.dismissible) return;
  if (!open.value) return;
  open.value = false;
}

// ---- 背景滾動鎖 -------------------------------------------------------------
let savedOverflow: string | null = null;

function lockScroll() {
  if (savedOverflow !== null) return;
  savedOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
}
function unlockScroll() {
  if (savedOverflow === null) return;
  document.body.style.overflow = savedOverflow;
  savedOverflow = null;
}

// ---- 焦點管理 ---------------------------------------------------------------
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

let lastFocused: HTMLElement | null = null;

function focusableInPanel(): HTMLElement[] {
  const root = panelEl.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    // 隱藏起來的(display:none)不算,offsetParent 為 null 就是看不到
    .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return;

  if (e.key === 'Escape') {
    if (!props.dismissible) return;
    e.preventDefault();
    close();
    return;
  }

  // Tab 鎖在面板內,不要跑到背景的頁面上
  if (e.key !== 'Tab' || !panelEl.value) return;
  const nodes = focusableInPanel();
  if (!nodes.length) {
    e.preventDefault();
    panelEl.value.focus();
    return;
  }
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement;
  const insidePanel = active instanceof Node && panelEl.value.contains(active);

  if (e.shiftKey && (active === first || !insidePanel)) {
    e.preventDefault();
    last.focus();
  }
  else if (!e.shiftKey && (active === last || !insidePanel)) {
    e.preventDefault();
    first.focus();
  }
}

watch(open, async (isOpen, wasOpen) => {
  if (isOpen) {
    lastFocused = document.activeElement as HTMLElement | null;
    lockScroll();
    await nextTick();
    // 焦點先落在面板本身,而不是第一顆按鈕 —— 手機上直接 focus 輸入框會彈鍵盤遮住內容
    panelEl.value?.focus();
  }
  else if (wasOpen) {
    unlockScroll();
    emit('close');
    // 焦點還回原本的觸發元件,鍵盤使用者才不會被丟回頁面頂端
    lastFocused?.focus?.();
    lastFocused = null;
  }
});

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  if (open.value) lockScroll();
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  unlockScroll();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4"
      >
        <!-- 背景遮罩。點一下關閉(dismissible 為 false 時不理它) -->
        <div
          class="sheet-backdrop absolute inset-0"
          :aria-hidden="true"
          @click="close()"
        />

        <div
          ref="panelEl"
          class="sheet-panel card relative flex max-h-[88dvh] w-full flex-col rounded-t-2xl rounded-b-none md:max-h-[85dvh] md:rounded-2xl"
          :class="widthClass"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          :aria-label="title ? undefined : '對話框'"
          tabindex="-1"
        >
          <!-- 手機上的抓握提示條。md 以上是對話框就不需要 -->
          <div
            class="mx-auto mt-2.5 h-1 w-9 shrink-0 rounded-full md:hidden"
            style="background: var(--border)"
          />

          <div
            v-if="title || dismissible"
            class="flex shrink-0 items-start gap-2 px-4 pt-3 pb-2"
          >
            <h2 v-if="title" :id="titleId" class="min-w-0 flex-1 pt-1.5 text-base font-semibold">
              {{ title }}
            </h2>
            <div v-else class="flex-1" />
            <button
              v-if="dismissible"
              type="button"
              class="-mr-1 flex size-9 shrink-0 items-center justify-center rounded-full transition active:scale-95"
              style="color: var(--text-muted)"
              aria-label="關閉"
              @click="close(true)"
            >
              <Icon name="lucide:x" size="20" />
            </button>
          </div>

          <!-- 內容。過長會自己滾,面板本身不會超出畫面 -->
          <div
            class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1"
            :style="$slots.footer
              ? { paddingBottom: '1rem' }
              : { paddingBottom: 'calc(var(--safe-b) + 1rem)' }"
          >
            <slot />
          </div>

          <!-- 動作列。手機上放在拇指可及的下緣,按鈕給 block 就會平分寬度 -->
          <div
            v-if="$slots.footer"
            class="flex shrink-0 items-center gap-2 border-t px-4 pt-3"
            style="border-color: var(--border); padding-bottom: calc(var(--safe-b) + 0.75rem)"
          >
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sheet-backdrop {
  background: rgb(0 0 0 / 45%);
  backdrop-filter: blur(2px);
}

/* 遮罩淡入、面板滑上來(md 以上改成輕微縮放) */
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.2s ease;
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-active .sheet-panel,
.sheet-leave-active .sheet-panel {
  transition: transform 0.26s cubic-bezier(0.32, 0.72, 0, 1);
}
.sheet-enter-from .sheet-panel,
.sheet-leave-to .sheet-panel {
  transform: translateY(100%);
}

@media (min-width: 768px) {
  .sheet-enter-from .sheet-panel,
  .sheet-leave-to .sheet-panel {
    transform: translateY(0.5rem) scale(0.97);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sheet-enter-active,
  .sheet-leave-active,
  .sheet-enter-active .sheet-panel,
  .sheet-leave-active .sheet-panel {
    transition-duration: 0.01ms;
  }
  .sheet-enter-from .sheet-panel,
  .sheet-leave-to .sheet-panel {
    transform: none;
  }
}
</style>
