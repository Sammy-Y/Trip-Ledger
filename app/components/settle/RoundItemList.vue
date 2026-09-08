<script setup lang="ts">
import { formatMoney } from '~~/shared/money';

/**
 * 一次結算的「明細清單」。自動註冊名稱是 <SettleRoundItemList>。
 *
 * 這個元件就是使用者要的那份東西:**第一晚結算時,把那天每一筆花費攤開來看**——
 * 誰付的、誰分攤多少、每天小計多少。不是 debug dump,所以:
 *   · 按消費日分組,每天一個標頭 + 當天小計(對帳是按「天」在對的)
 *   · 每一筆都同時看得到「付款人」和「分攤的人」—— 這是兩組不同的人,
 *     只顯示金額的話沒有人敢拿這個數字去跟朋友要錢
 *   · 付款合計 / 分攤合計和支出金額對不上時**當場講出來**。
 *     preview 的 blocked_reason 只會說「有 N 筆對不上」,是哪幾筆要在這裡指出來。
 *
 * ⚠️ 這份清單的範圍是「還沒列入任何結算回合的支出」,而轉帳金額的範圍是
 * 整趟到現在的淨額 —— 兩個範圍刻意不同(理由見 server/utils/ledger.ts)。
 * 所以文案絕對不要暗示「這份清單的金額 = 下面那些轉帳」,那是不同的東西。
 *
 * 刻意只吃 names(Map)而不自己打 API:轉 id → 名字是 useTrip 的責任,
 * 這樣預覽面板和結算歷史可以共用同一個元件。
 */

/** 付款 / 分攤的一條。shared/types 的 Expense 直接餵進來就相容。 */
interface Line {
  member_id: string;
  amount_minor: number;
}

interface Item {
  id: string;
  description: string;
  /** 最小單位整數。JPY exponent 0、TWD 2,一律交給 <UiMoney> 印 */
  amount_minor: number;
  /** 'YYYY-MM-DD' 消費日,分組就是靠這個 */
  spent_at: string;
  note?: string | null;
  payers: Line[];
  shares: Line[];
}

const props = withDefaults(defineProps<{
  items: Item[];
  /** 這份清單的幣別。一個回合只結一個幣別,所以整份都是同一個 */
  currency: string;
  /** member_id -> 名字。由 useTrip 的 memberMap 傳進來 */
  names: Map<string, string>;
  /** 公費的 member_id。公費出現在付款人裡時要標出來,不然使用者會找不到那筆錢去哪了 */
  potId?: string | null;
}>(), {
  potId: null,
});

function nameOf(id: string): string {
  return props.names.get(id) ?? '未知成員';
}

// ── 日期標頭 ──────────────────────────────────────────────────
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 'YYYY-MM-DD' 要用當地時間組 Date。直接 new Date(字串) 會被當成 UTC 而差一天。 */
function parseDay(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 和支出列表同一套標頭文案(今天 / 昨天 / 9/5 週六),兩頁對照時不會覺得是兩個產品 */
function dayLabel(raw: string): string {
  const d = parseDay(raw);
  if (!d) return raw || '未填日期';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (diffDays === 0) return `今天 · ${md}`;
  if (diffDays === 1) return `昨天 · ${md}`;
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}/`;
  return `${year}${md} 週${WEEKDAY[d.getDay()]}`;
}

// ── 資料整理 ──────────────────────────────────────────────────
interface Chip {
  key: string;
  name: string;
  minor: number;
  /** 公費 —— 畫面上要標記,它不是人 */
  isPot: boolean;
}

function toChips(list: Line[] | undefined, prefix: string): Chip[] {
  return (list ?? [])
    .map((l, i) => ({
      key: `${prefix}:${l.member_id}:${i}`,
      name: nameOf(l.member_id),
      minor: l.amount_minor,
      isPot: !!props.potId && l.member_id === props.potId,
    }))
    // 金額大的排前面:誰墊得最多、誰分最多是使用者第一眼要找的
    .sort((a, b) => b.minor - a.minor || a.name.localeCompare(b.name));
}

interface Row {
  id: string;
  description: string;
  minor: number;
  note: string | null;
  payers: Chip[];
  shares: Chip[];
  /** 單一付款人而且就是全額 —— 最常見的情況,文案可以簡化成「○○ 全額墊付」 */
  singlePayer: boolean;
  /** 付款合計 − 支出金額。不為 0 就是這筆有問題 */
  payerDiff: number;
  /** 分攤合計 − 支出金額 */
  shareDiff: number;
}

interface DayGroup {
  date: string;
  label: string;
  rows: Row[];
  /** 當天小計。整份清單同一個幣別,所以這個加總是有意義的 */
  subtotal: number;
}

const groups = computed<DayGroup[]>(() => {
  // server 已經 ORDER BY spent_at ASC,但自己再排一次才不會因為
  // 上游改順序就冒出兩個同一天的標頭。同一天內維持原順序(記錄先後)。
  const sorted = [...props.items].sort((a, b) => (a.spent_at ?? '').localeCompare(b.spent_at ?? ''));

  const out: DayGroup[] = [];
  for (const item of sorted) {
    const payers = toChips(item.payers, `p:${item.id}`);
    const shares = toChips(item.shares, `s:${item.id}`);
    const paid = payers.reduce((s, c) => s + c.minor, 0);
    const owed = shares.reduce((s, c) => s + c.minor, 0);

    const row: Row = {
      id: item.id,
      description: item.description || '未填說明',
      minor: item.amount_minor,
      note: item.note ?? null,
      payers,
      shares,
      singlePayer: payers.length === 1 && paid === item.amount_minor,
      payerDiff: paid - item.amount_minor,
      shareDiff: owed - item.amount_minor,
    };

    const last = out[out.length - 1];
    if (last && last.date === item.spent_at) {
      last.rows.push(row);
      last.subtotal += row.minor;
    }
    else {
      out.push({ date: item.spent_at, label: dayLabel(item.spent_at), rows: [row], subtotal: row.minor });
    }
  }
  return out;
});

const total = computed(() => props.items.reduce((s, i) => s + i.amount_minor, 0));
/** 只有一天的話就不必再重複一次總計 —— 當天小計已經是那個數字 */
const showTotal = computed(() => groups.value.length > 1);
</script>

<template>
  <div>
    <section v-for="g in groups" :key="g.date" class="day">
      <!-- 日期標頭 + 當天小計 -->
      <h5 class="day-head">
        <span class="text-xs font-semibold">{{ g.label }}</span>
        <span class="day-count tnum">{{ g.rows.length }} 筆</span>
        <span class="flex-1" />
        <UiMoney :minor="g.subtotal" :currency="currency" size="sm" />
      </h5>

      <ul class="rows">
        <li v-for="row in g.rows" :key="row.id" class="row">
          <!-- 項目 + 金額 -->
          <div class="flex items-baseline gap-3">
            <p class="min-w-0 flex-1 text-sm leading-snug font-medium">{{ row.description }}</p>
            <UiMoney :minor="row.minor" :currency="currency" class="shrink-0" />
          </div>

          <!-- 誰付的錢 -->
          <p class="meta">
            <Icon name="lucide:wallet" size="12" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span class="meta-label">誰付的</span>
            <span class="chips">
              <template v-if="row.singlePayer">
                <span class="chip" :class="{ 'chip-pot': row.payers[0]?.isPot }">
                  {{ row.payers[0]?.name }}
                  <span class="chip-note">全額墊付</span>
                </span>
              </template>
              <template v-else-if="row.payers.length">
                <span
                  v-for="c in row.payers"
                  :key="c.key"
                  class="chip"
                  :class="{ 'chip-pot': c.isPot }"
                >
                  {{ c.name }}
                  <span class="chip-amount tnum">{{ formatMoney(c.minor, currency) }}</span>
                </span>
              </template>
              <span v-else class="chip chip-missing">沒有記錄付款人</span>
            </span>
          </p>

          <!-- 誰欠多少(分攤)。和付款人是兩組不同的人,所以分兩行列 -->
          <p class="meta">
            <Icon name="lucide:users" size="12" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span class="meta-label">誰要分攤</span>
            <span class="chips">
              <span
                v-for="c in row.shares"
                :key="c.key"
                class="chip"
                :class="{ 'chip-pot': c.isPot }"
              >
                {{ c.name }}
                <span class="chip-amount tnum">{{ formatMoney(c.minor, currency) }}</span>
              </span>
              <span v-if="!row.shares.length" class="chip chip-missing">沒有分攤紀錄</span>
            </span>
          </p>

          <p v-if="row.note" class="note">
            <Icon name="lucide:message-square-text" size="12" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0 whitespace-pre-wrap">{{ row.note }}</span>
          </p>

          <!--
            對不上就當場指名。blocked_reason 只會說「有 N 筆對不上」,
            使用者需要知道是哪一筆才修得動。
          -->
          <p v-if="row.payerDiff !== 0" class="mismatch">
            <Icon name="lucide:triangle-alert" size="12" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              付款合計比支出金額{{ row.payerDiff > 0 ? '多' : '少' }}
              <span class="tnum">{{ formatMoney(Math.abs(row.payerDiff), currency) }}</span>
              —— 這筆會擋住結算。
            </span>
          </p>
          <p v-if="row.shareDiff !== 0" class="mismatch">
            <Icon name="lucide:triangle-alert" size="12" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              分攤合計比支出金額{{ row.shareDiff > 0 ? '多' : '少' }}
              <span class="tnum">{{ formatMoney(Math.abs(row.shareDiff), currency) }}</span>
              —— 這筆會擋住結算。
            </span>
          </p>
        </li>
      </ul>
    </section>

    <!-- 跨兩天以上才顯示總計:只有一天的時候那個數字已經在日期標頭上了 -->
    <p v-if="showTotal" class="grand">
      <span class="text-xs font-semibold">明細合計</span>
      <span class="day-count tnum">{{ items.length }} 筆</span>
      <span class="flex-1" />
      <UiMoney :minor="total" :currency="currency" />
    </p>
  </div>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換 */

.day + .day {
  margin-top: 0.875rem;
}

.day-head,
.grand {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.375rem 0.625rem;
  border-radius: 0.5rem;
  background: var(--bg-sunken);
  color: var(--text);
}
.grand {
  margin-top: 0.875rem;
  border: 1px solid var(--border);
}

.day-count {
  flex-shrink: 0;
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.625rem;
  line-height: 1.4;
  background: color-mix(in oklab, var(--text-muted) 14%, transparent);
  color: var(--text-muted);
}

.rows {
  display: flex;
  flex-direction: column;
}
.row {
  padding: 0.625rem 0.125rem 0.75rem;
}
.row + .row {
  border-top: 1px dashed var(--border);
}

/* 「誰付的 / 誰要分攤」一行:圖示 + 標籤 + 一排會自動換行的 chip */
.meta {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  margin-top: 0.375rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-muted);
}
.meta-label {
  flex-shrink: 0;
  width: 3.5rem;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  min-width: 0;
}

.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 0.25rem;
  padding: 0.0625rem 0.4375rem;
  border-radius: 0.375rem;
  background: var(--bg-sunken);
  color: var(--text);
  font-size: 0.75rem;
}
.chip-amount {
  color: var(--text-muted);
}
.chip-note {
  font-size: 0.6875rem;
  color: var(--text-muted);
}
/* 公費不是人。付款人是公費時要看得出來,不然使用者會問「這筆誰墊的」 */
.chip-pot {
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
}
.chip-pot .chip-amount,
.chip-pot .chip-note {
  color: color-mix(in oklab, var(--brand) 78%, var(--text-muted));
}
.chip-missing {
  background: color-mix(in oklab, var(--warn) 16%, transparent);
  color: var(--text);
}

.note {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  margin-top: 0.375rem;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-muted);
}

.mismatch {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  margin-top: 0.375rem;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--warn);
}
</style>
