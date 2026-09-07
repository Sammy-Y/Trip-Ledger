<script setup lang="ts">
import { formatMoney } from '~~/shared/money';

/**
 * 「A → B ¥N」一整排。自動註冊名稱是 <SettleRoundTransferList>。
 *
 * 這是結算的**結果**:看完明細之後,使用者要的就是一句「誰拿多少給誰」。
 * 所以金額用大字、方向用箭頭,不需要任何解讀。
 *
 * tone 決定這一排是什麼性質,兩者的差別是**會不會被寫進帳**:
 *
 *   recorded  兩端都是真人 → 結算回合會真的寫成 settlements。可以有動作按鈕。
 *   deferred  任一端是公費 → **唯讀,永遠不寫入。**
 *             第一天晚上公費淨額 = −(手上剩的現金),照著轉等於把公費清空退還,
 *             而那筆錢明天還要用。公費的結算在旅程結束用總覽的「退還」處理。
 *
 * 所以這個元件在 deferred 的時候刻意連 slot 都不吃 —— 沒有任何路徑
 * 能讓它長出一顆會寫入公費腿的按鈕。
 */
interface TransferInput {
  from: string;
  to: string;
  /** 最小單位整數。原封不動用後端給的數字,不要先除以 100 */
  amountMinor: number;
}

const props = withDefaults(defineProps<{
  transfers: TransferInput[];
  currency: string;
  /** member_id -> 名字。由 useTrip 的 memberMap 傳進來 */
  names: Map<string, string>;
  /** 'recorded' = 會寫進帳(主色);'deferred' = 唯讀的公費腿(灰) */
  tone?: 'recorded' | 'deferred';
  /** 公費的 member_id,用來在列上標出哪一端是公費 */
  potId?: string | null;
  /** 兩筆以上才有意義的合計列。單筆時金額已經在列上了 */
  showTotal?: boolean;
}>(), {
  tone: 'recorded',
  potId: null,
  showTotal: true,
});

function nameOf(id: string): string {
  return props.names.get(id) ?? '未知成員';
}
function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0]! : '?';
}

const isDeferred = computed(() => props.tone === 'deferred');

interface Row {
  key: string;
  fromName: string;
  toName: string;
  fromInitial: string;
  toInitial: string;
  fromIsPot: boolean;
  toIsPot: boolean;
  minor: number;
  /** 給讀螢幕的人一句完整的話,而不是散落的三個欄位 */
  label: string;
}

const rows = computed<Row[]>(() => props.transfers.map((t, i) => {
  const fromName = nameOf(t.from);
  const toName = nameOf(t.to);
  return {
    key: `${t.from}:${t.to}:${i}`,
    fromName,
    toName,
    fromInitial: initial(fromName),
    toInitial: initial(toName),
    fromIsPot: !!props.potId && t.from === props.potId,
    toIsPot: !!props.potId && t.to === props.potId,
    minor: t.amountMinor,
    label: `${fromName} 給 ${toName} ${formatMoney(t.amountMinor, props.currency)}`,
  };
}));

const total = computed(() => props.transfers.reduce((s, t) => s + t.amountMinor, 0));
const withTotal = computed(() => props.showTotal && rows.value.length > 1);
</script>

<template>
  <div>
    <ul class="rows">
      <li
        v-for="row in rows"
        :key="row.key"
        class="row"
        :class="isDeferred ? 'row-deferred' : 'row-recorded'"
        :aria-label="row.label"
      >
        <!-- 誰 → 誰。付款方在左、收款方在右,和每人淨額的顏色語意一致 -->
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <span class="avatar" :class="row.fromIsPot ? 'avatar-pot' : 'avatar-debit'">
            {{ row.fromInitial }}
          </span>
          <span class="min-w-0 truncate text-sm font-medium">{{ row.fromName }}</span>

          <Icon
            name="lucide:arrow-right"
            size="15"
            class="mx-0.5 shrink-0 text-[var(--text-muted)]"
            aria-hidden="true"
          />

          <span class="avatar" :class="row.toIsPot ? 'avatar-pot' : 'avatar-credit'">
            {{ row.toInitial }}
          </span>
          <span class="min-w-0 truncate text-sm font-medium">{{ row.toName }}</span>
        </div>

        <UiMoney
          :minor="row.minor"
          :currency="currency"
          :size="isDeferred ? 'md' : 'lg'"
          class="shrink-0"
        />
      </li>
    </ul>

    <p v-if="withTotal" class="total">
      <span class="text-xs">合計 <span class="tnum">{{ rows.length }}</span> 筆</span>
      <span class="flex-1" />
      <UiMoney :minor="total" :currency="currency" size="sm" />
    </p>
  </div>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換 */
.rows {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 3rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.75rem;
  border: 1px solid var(--border);
}
/* 會被寫進帳的那些:主色框,視覺上就是「這才是結果」 */
.row-recorded {
  background: color-mix(in oklab, var(--brand) 7%, var(--bg-elevated));
  border-color: color-mix(in oklab, var(--brand) 30%, var(--border));
}
/* 公費的腿:灰底,和上面的結果明顯不同層級 —— 它現在不用轉 */
.row-deferred {
  background: var(--bg-sunken);
  border-style: dashed;
}

.avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 999px;
  font-size: 0.75rem;
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
/* 公費不是人,不該被塗成應收 / 應付的顏色 */
.avatar-pot {
  background: color-mix(in oklab, var(--brand) 14%, transparent);
  color: var(--brand);
}

.total {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px dashed var(--border);
  color: var(--text-muted);
}
</style>
