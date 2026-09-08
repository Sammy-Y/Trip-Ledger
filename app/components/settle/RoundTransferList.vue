<script setup lang="ts">
import { formatMoney } from '~~/shared/money';

/**
 * 「A → B ¥N」一整排。自動註冊名稱是 <SettleRoundTransferList>。
 *
 * 這是結算的**結果**:看完明細之後,使用者要的就是一句「誰拿多少給誰」。
 * 所以金額用大字、方向用箭頭,不需要任何解讀。
 *
 * tone 決定這一排的視覺層級,差別是**這些錢還沒付 / 已經成為紀錄**:
 *
 *   recorded  主色框。「按下結算就會寫成 settlements 的那幾筆」—— 這才是結果。
 *   deferred  灰底虛線。唯讀、已成定局的紀錄(結算歷史裡「當時記下的轉帳」)。
 *
 * 這個元件刻意連 slot 都不吃:它永遠只是顯示,沒有任何路徑能讓某一列
 * 長出寫入按鈕 —— 寫入一律由頁面負責,才不會有兩個地方各自送出。
 *
 * ⚠️ 結算頁**不顯示任何一端是公費的腿**(以前那些走 tone="deferred")。
 * 那幾條的意思是「旅程結束時退還多少 / 還要補多少」,是總覽頁的動作;
 * 畫在轉帳清單裡會讓人以為現在就該把信封清空,而那筆錢明天還要用。
 * 理由見 pages/t/[trip]/settle.vue 檔頭。
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
  /** 'recorded' = 還沒付、按下結算會寫進帳(主色);'deferred' = 已成定局的紀錄(灰) */
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
/* 已成定局的紀錄:灰底虛線,和「還沒付的結果」明顯不同層級 */
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
