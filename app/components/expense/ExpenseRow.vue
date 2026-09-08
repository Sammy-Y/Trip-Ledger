<script setup lang="ts">
import type { Expense } from '~~/shared/types';

/**
 * 支出列表的一列(可點開明細)。
 *
 * 一列要在一眼之內回答四件事:買了什麼、多少錢、誰墊的、幾個人分。
 * 「誰墊錢」和「誰受益」是兩組不同的人,所以付款人與分攤人數要分開顯示,
 * 不能只印一個名字 —— 那會讓人誤以為付款人就是唯一的使用者。
 *
 * 手機:兩行(說明 / 付款人 · 分攤 · 付款方式)+ 右側金額。
 * md 以上:攤平成表格式的欄位,掃視一整趟旅程時比較快。
 */
const props = withDefaults(defineProps<{
  expense: Expense;
  /** member_id -> 名字。由 useTrip 的 memberMap 傳進來,不要每列自己查 API */
  names: Map<string, string>;
  expanded?: boolean;
  /** 展開後那塊明細的 id,做 aria-controls */
  detailId?: string;
}>(), {
  expanded: false,
  detailId: undefined,
});

defineEmits<{ toggle: [] }>();

function nameOf(id: string): string {
  return props.names.get(id) ?? '未知成員';
}

const payers = computed(() => props.expense.payers ?? []);
const shares = computed(() => props.expense.shares ?? []);
const isPersonal = computed(() => props.expense.kind === 'personal');

/** 頭像那個字:共同帳看「誰墊的錢」,個人帳看「算在誰身上」 */
const leadName = computed(() => {
  const primary = isPersonal.value ? shares.value[0] : payers.value[0];
  const backup = isPersonal.value ? payers.value[0] : shares.value[0];
  const line = primary ?? backup;
  return line ? nameOf(line.member_id) : '';
});
const leadInitial = computed(() => (leadName.value ? [...leadName.value][0]! : '?'));

const payerText = computed(() => {
  const list = payers.value;
  if (!list.length) return '未記付款人';
  const first = nameOf(list[0]!.member_id);
  if (list.length === 1) return isPersonal.value ? first : `${first} 墊付`;
  return `${first} 等 ${list.length} 人墊付`;
});

const shareText = computed(() => {
  const list = shares.value;
  if (!list.length) return isPersonal.value ? '未指定' : '未分攤';
  if (isPersonal.value) {
    return list.length === 1 ? `記在 ${nameOf(list[0]!.member_id)}` : `${list.length} 人`;
  }
  return `${list.length} 人分攤`;
});

/** 手機那行 meta:個人帳只有一個人,不必再寫「誰墊付、幾人分攤」 */
const metaParts = computed(() => (
  isPersonal.value
    ? [leadName.value || '未指定']
    : [payerText.value, shareText.value]
));

const METHODS = {
  cash: { icon: 'lucide:banknote', label: '現金' },
  card: { icon: 'lucide:credit-card', label: '刷卡' },
} as const;
const method = computed(() => METHODS[props.expense.payment_method] ?? METHODS.cash);
</script>

<template>
  <button
    type="button"
    class="exp-row"
    :aria-expanded="expanded"
    :aria-controls="detailId"
    @click="$emit('toggle')"
  >
    <!-- 頭像:誰墊的錢(個人帳則是算在誰身上) -->
    <span class="avatar" aria-hidden="true">{{ leadInitial }}</span>

    <span class="min-w-0 flex-1 text-left">
      <span class="flex items-baseline gap-1.5">
        <span class="truncate text-[0.9375rem] leading-tight font-medium text-[var(--text)]">
          {{ expense.description || '未填說明' }}
        </span>
        <span v-if="expense.category" class="chip shrink-0">{{ expense.category }}</span>
        <!--
          已列入結算回合的標記。使用者的需求原話是「已結清的記錄就標記起來,
          下次從尚未被標記的地方開始結算」—— 後半段(結算範圍)在 server 做完了,
          但前半段是**看得見的標記**,少了它使用者根本不知道哪幾筆已經算過。
          文案刻意不寫「已結清」:章是蓋在支出上,而債是由那個回合的轉帳
          「整批」清掉的,不是一筆一筆對應。
        -->
        <span v-if="expense.settlement_round_id" class="chip chip-settled shrink-0">
          <Icon name="lucide:lock" size="9" />
          已結算
        </span>
      </span>

      <!-- 手機:付款人 · 分攤 · 付款方式 擠在第二行 -->
      <span class="mt-1 flex items-center gap-1.5 text-xs leading-none text-[var(--text-muted)] md:hidden">
        <span class="truncate">{{ metaParts.join(' · ') }}</span>
        <span class="method shrink-0">
          <Icon :name="method.icon" size="11" />
          {{ method.label }}
        </span>
      </span>
    </span>

    <!-- md 以上:攤成欄位 -->
    <span class="col-payer hidden truncate text-xs text-[var(--text-muted)] md:block">
      {{ payerText }}
    </span>
    <span class="col-share hidden truncate text-xs text-[var(--text-muted)] md:block">
      {{ shareText }}
    </span>
    <span class="col-method hidden md:block">
      <span class="method">
        <Icon :name="method.icon" size="11" />
        {{ method.label }}
      </span>
    </span>

    <span class="col-amount text-right">
      <UiMoney :minor="expense.amount_minor" :currency="expense.currency" />
    </span>

    <Icon
      name="lucide:chevron-down"
      size="16"
      class="shrink-0 text-[var(--text-muted)] transition-transform duration-200"
      :class="expanded ? 'rotate-180' : ''"
      aria-hidden="true"
    />
  </button>
</template>

<style scoped>
/* 顏色全部走 main.css 的 CSS 變數,深色模式自動跟著換。 */

.exp-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.75rem;
  min-height: 60px; /* 遠超 44px 的 tap target */
  padding: 0.625rem 0.875rem;
  text-align: left;
  transition: background-color 0.15s ease;
}

/*
 * md 以上是表格式排版,所以用 grid 而不是 flex。
 *
 * 用 flex 的話,金額欄寬度會隨內容變動(「¥99」對上「NT$22,596.00」差很多),
 * 而寬度的變化會被 flex-1 的說明欄吸收 —— 結果是「付款人 / 分攤 / 付款方式」
 * 這三欄在每一列都落在不同的水平位置,整排看起來是歪的。
 * grid 把每一欄釘在固定軌道上,不管內容多長都對齊。
 *
 * 金額欄 9.5rem 是為了容納最長的情況(NT$ + 千分位 + 兩位小數,如 NT$22,596.00)。
 */
@media (min-width: 768px) {
  .exp-row {
    display: grid;
    grid-template-columns:
      2.25rem          /* 頭像 */
      minmax(0, 1fr)   /* 說明(唯一會伸縮的欄) */
      7rem             /* 付款人 */
      6rem             /* 分攤 */
      3.75rem          /* 現金 / 刷卡 */
      9.5rem           /* 金額 */
      1rem;            /* 展開箭頭 */
  }
}

.col-payer,
.col-share,
.col-method {
  min-width: 0;
}
.col-amount {
  min-width: 0;
  justify-self: end;
}
@media (hover: hover) {
  .exp-row:hover {
    background: var(--bg-sunken);
  }
}
.exp-row:active {
  background: var(--bg-sunken);
}
.exp-row[aria-expanded='true'] {
  background: var(--bg-sunken);
}

.avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 600;
  background: color-mix(in oklab, var(--brand) 14%, transparent);
  color: var(--brand);
}

/* 分類標籤 */
.chip {
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.625rem;
  line-height: 1.4;
  background: var(--bg-sunken);
  color: var(--text-muted);
}
.chip-settled {
  display: inline-flex;
  align-items: center;
  gap: 0.1875rem;
  background: color-mix(in oklab, var(--credit) 15%, transparent);
  color: var(--credit);
}
/* 展開 / hover 時列背景會變成 sunken,標籤要換個底色才看得出層次 */
.exp-row[aria-expanded='true'] .chip-settled,
.exp-row:hover .chip-settled {
  background: color-mix(in oklab, var(--credit) 20%, transparent);
}
/* 展開 / hover 時列背景會變成 sunken,標籤要換個底色才看得出層次 */
.exp-row[aria-expanded='true'] .chip {
  background: var(--bg);
}
@media (hover: hover) {
  .exp-row:hover .chip {
    background: var(--bg);
  }
}

/* 現金 / 刷卡 */
.method {
  display: inline-flex;
  align-items: center;
  gap: 0.1875rem;
  white-space: nowrap;
  font-size: 0.625rem;
  color: var(--text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .exp-row {
    transition: none;
  }
}
</style>
