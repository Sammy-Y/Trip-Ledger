<script setup lang="ts">
import type { SettlementRound } from '~~/shared/types';
import { CURRENCY_LABEL } from '~~/shared/money';

/**
 * 結算歷史裡的一列。自動註冊名稱是 <SettleRoundHistoryCard>。
 *
 * 存在的理由只有一個:**幾個月後有人問「這 1,850 是什麼」,要答得出來。**
 * 所以展開後三塊一起給:
 *   當時記下的轉帳(結果)· 當時列入的明細(依據)· 當時的淨額快照(算式)
 *
 * ⚠️ nets 是**快照**不是即時重算。之後有人補登支出、改名字、刪帳,
 * 重算會得到不同數字 —— 但當時就是照這份付的錢,所以畫面上要標明它是快照。
 *
 * 資料抓取與撤銷都不在這裡:detail 由頁面用 useAsyncData 抓好傳進來,
 * 撤銷只 emit 事件。寫入集中在頁面一處才不會有兩個地方各自送出。
 */

/** 付款 / 分攤的一條 */
interface Line {
  member_id: string;
  amount_minor: number;
}

interface DetailItem {
  id: string;
  description: string;
  amount_minor: number;
  spent_at: string;
  note?: string | null;
  payers: Line[];
  shares: Line[];
}

/** settlements 這一列的原始形狀(snake_case,和 API 一致) */
interface DetailTransfer {
  id: string;
  from_member: string;
  to_member: string;
  currency: string;
  amount_minor: number;
  settled_at: string;
}

interface RoundDetail {
  id: string;
  currency: string;
  seq: number;
  label: string | null;
  note: string | null;
  created_at: string;
  reverted_at: string | null;
  items: DetailItem[];
  nets: Array<{ memberId: string; netMinor: number }>;
  transfers: DetailTransfer[];
}

const props = withDefaults(defineProps<{
  round: SettlementRound;
  /** member_id -> 名字。由 useTrip 的 memberMap 傳進來 */
  names: Map<string, string>;
  potId?: string | null;
  expanded?: boolean;
  /** GET /rounds/:id 的結果。收起來的時候是 null */
  detail?: RoundDetail | null;
  loading?: boolean;
  /** 已經是可顯示的中文訊息(useApi 保證) */
  error?: string | null;
  /** 這一輪正在撤銷 */
  reverting?: boolean;
  /** 別的地方正在寫入 → 鎖住動作 */
  disabled?: boolean;
}>(), {
  potId: null,
  expanded: false,
  detail: null,
  loading: false,
  error: null,
  reverting: false,
  disabled: false,
});

const emit = defineEmits<{
  toggle: [];
  /** 使用者按下撤銷。確認面板與 DELETE 由頁面負責 */
  revert: [];
}>();

function nameOf(id: string): string {
  return props.names.get(id) ?? '未知成員';
}

const label = computed(() => CURRENCY_LABEL[props.round.currency] ?? props.round.currency);
const reverted = computed(() => !!props.round.reverted_at);

/**
 * created_at 來自 SQLite 的 datetime('now'),長這樣:'2026-09-07 15:41:19'(UTC 但沒有 Z)。
 * 直接 new Date() 在部分瀏覽器會當成當地時間,差 8 小時 —— 沒有時區標記就自己補 Z。
 */
function parseDbTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const t = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const iso = /([Zz]|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function timeText(raw: string | null | undefined): string {
  const d = parseDbTime(raw);
  if (!d) return '';
  return d.toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

const createdText = computed(() => timeText(props.round.created_at));
const revertedText = computed(() => timeText(props.round.reverted_at));

/** 轉帳清單的欄位是 snake_case,轉成 <SettleRoundTransferList> 吃的形狀 */
const transferRows = computed(() => (props.detail?.transfers ?? []).map((t) => ({
  from: t.from_member,
  to: t.to_member,
  amountMinor: t.amount_minor,
})));

interface NetRow {
  key: string;
  name: string;
  minor: number;
  isPot: boolean;
}

/** 應收多的排前面,和結算頁的「每人淨額」同一個順序 */
const netRows = computed<NetRow[]>(() => [...(props.detail?.nets ?? [])]
  .sort((a, b) => b.netMinor - a.netMinor)
  .map((n, i) => ({
    key: `${n.memberId}:${i}`,
    name: nameOf(n.memberId),
    minor: n.netMinor,
    isPot: !!props.potId && n.memberId === props.potId,
  })));

const panelId = computed(() => `round-detail-${props.round.id}`);
</script>

<template>
  <article class="card overflow-hidden">
    <!-- ── 標頭:整條可點,展開當時的明細 ── -->
    <h4>
      <button
        type="button"
        class="head"
        :aria-expanded="expanded"
        :aria-controls="panelId"
        @click="emit('toggle')"
      >
        <Icon
          name="lucide:chevron-down"
          size="15"
          class="shrink-0 text-[var(--text-muted)] transition-transform duration-200"
          :class="expanded ? '' : '-rotate-90'"
          aria-hidden="true"
        />

        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span class="text-sm font-semibold">
              【{{ label }}】第 <span class="tnum">{{ round.seq }}</span> 次結算
            </span>
            <span v-if="reverted" class="badge-reverted">已撤銷</span>
            <span v-if="round.label" class="badge-label">{{ round.label }}</span>
          </span>
          <span class="mt-1 block text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
            <span class="tnum">{{ createdText }}</span>
            · <span class="tnum">{{ round.item_count }}</span> 筆明細
            · <span class="tnum">{{ round.transfer_count }}</span> 筆轉帳
          </span>
        </span>

        <!-- 只蓋章、沒有轉帳的回合不要顯示「轉帳合計 ¥0」—— 那看起來像資料壞了 -->
        <span class="shrink-0 text-right">
          <template v-if="round.transfer_count">
            <UiMoney :minor="round.transfer_total_minor" :currency="round.currency" />
            <span class="mt-0.5 block text-[0.625rem] leading-none text-[var(--text-muted)]">轉帳合計</span>
          </template>
          <span v-else class="text-[0.6875rem] text-[var(--text-muted)]">無轉帳</span>
        </span>
      </button>
    </h4>

    <!-- ── 展開:當時的結果 / 依據 / 算式 ── -->
    <div v-if="expanded" :id="panelId" class="body">
      <UiLoadingBlock v-if="loading && !detail" :rows="3" variant="plain" label="正在載入這次結算的明細" />

      <p v-else-if="error" class="err">
        <Icon name="lucide:cloud-alert" size="15" class="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{{ error }}</span>
      </p>

      <template v-else-if="detail">
        <!-- 撤銷過的要第一句就講清楚,不然下面空的清單會讓人以為資料壞了 -->
        <p v-if="reverted" class="notice">
          <Icon name="lucide:undo-2" size="15" class="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            這次結算已於 <span class="tnum">{{ revertedText }}</span> 撤銷 ——
            當時記下的轉帳已經刪掉,明細也回到「還沒結算」,所以下面看到的清單是空的。
            這一列刻意留著,帳上看得出這裡曾經結算過又撤銷。
          </span>
        </p>

        <p v-if="detail.note" class="note">
          <Icon name="lucide:message-square-text" size="13" class="mt-0.5 shrink-0" aria-hidden="true" />
          <span class="whitespace-pre-wrap">{{ detail.note }}</span>
        </p>

        <!-- ① 結果:當時記下的轉帳 -->
        <section>
          <h5 class="sect-title">
            <Icon name="lucide:arrow-left-right" size="13" aria-hidden="true" />
            <span>當時記下的轉帳</span>
            <span v-if="transferRows.length" class="sect-count tnum">{{ transferRows.length }} 筆</span>
          </h5>
          <SettleRoundTransferList
            v-if="transferRows.length"
            :transfers="transferRows"
            :currency="detail.currency"
            :names="names"
            :pot-id="potId"
            tone="deferred"
            class="mt-2"
          />
          <p v-else class="hint">
            <template v-if="reverted">已隨撤銷刪除。</template>
            <template v-else>
              這一輪沒有轉帳 —— 當時算下來沒有人需要付錢給別人,只是把明細蓋上章。
            </template>
          </p>
        </section>

        <!-- ② 依據:當時列入的明細 -->
        <section class="topline">
          <h5 class="sect-title">
            <Icon name="lucide:receipt-text" size="13" aria-hidden="true" />
            <span>當時列入的明細</span>
            <span v-if="detail.items.length" class="sect-count tnum">{{ detail.items.length }} 筆</span>
          </h5>
          <SettleRoundItemList
            v-if="detail.items.length"
            :items="detail.items"
            :currency="detail.currency"
            :names="names"
            :pot-id="potId"
            class="mt-2"
          />
          <p v-else class="hint">
            <template v-if="reverted">明細已回到「還沒結算」,所以不再掛在這一輪上。</template>
            <template v-else>這一輪沒有列入任何新明細。</template>
          </p>
        </section>

        <!-- ③ 算式:當時的淨額快照 -->
        <section v-if="netRows.length" class="topline">
          <h5 class="sect-title">
            <Icon name="lucide:calculator" size="13" aria-hidden="true" />
            <span>當時的淨額快照</span>
          </h5>
          <ul class="nets">
            <li v-for="n in netRows" :key="n.key">
              <span class="min-w-0 flex-1 truncate text-sm">
                {{ n.name }}
                <span v-if="n.isPot" class="pot-tag">公費</span>
              </span>
              <UiMoney :minor="n.minor" :currency="detail.currency" signed size="sm" />
            </li>
          </ul>
          <p class="hint">
            這是結算當下存下來的<strong class="font-medium text-[var(--text)]">快照</strong>,含公費、加起來必為 0。
            之後補登支出或改名字都不會動到它 —— 當時就是照這份數字付的錢。
            綠 + = 應收、紅 − = 應付。
          </p>
        </section>

        <!-- ── 撤銷 ── -->
        <div v-if="!reverted" class="topline">
          <UiAppButton
            variant="ghost"
            icon="lucide:undo-2"
            :loading="reverting"
            :disabled="disabled"
            @click="emit('revert')"
          >
            撤銷這次結算
          </UiAppButton>
          <p class="hint">
            <template v-if="transferRows.length">
              撤銷會刪掉上面那 <span class="tnum">{{ transferRows.length }}</span> 筆轉帳,並把
            </template>
            <template v-else>這一輪沒有轉帳可刪,撤銷只會把</template>
            <span class="tnum">{{ detail.items.length }}</span> 筆明細退回「還沒結算」。
            你自己按「標記已還款」記的還款、以及投入公費的紀錄都不會被動到。
          </p>
        </div>
      </template>
    </div>
  </article>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換 */
.head {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.625rem;
  min-height: 56px;
  padding: 0.75rem 0.875rem;
  text-align: left;
  transition: background-color 0.15s ease;
}
@media (hover: hover) {
  .head:hover {
    background: var(--bg-sunken);
  }
}
.head:active {
  background: var(--bg-sunken);
}

.badge-reverted {
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 600;
  background: color-mix(in oklab, var(--warn) 22%, transparent);
  color: var(--text);
}
.badge-label {
  padding: 0.0625rem 0.375rem;
  border-radius: 0.375rem;
  font-size: 0.625rem;
  background: var(--bg-sunken);
  color: var(--text-muted);
}

.body {
  padding: 0 0.875rem 0.875rem;
  border-top: 1px solid var(--border);
  background: var(--bg-sunken);
}
.body > * {
  margin-top: 0.875rem;
}

.sect-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted);
}
.sect-count {
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 500;
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
}

.topline {
  padding-top: 0.875rem;
  border-top: 1px solid var(--border);
}

.nets {
  display: flex;
  flex-direction: column;
  margin-top: 0.25rem;
}
.nets > li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 2rem;
}
.nets > li + li {
  border-top: 1px dashed var(--border);
}
.pot-tag {
  margin-left: 0.25rem;
  padding: 0.0625rem 0.3125rem;
  border-radius: 0.25rem;
  font-size: 0.625rem;
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
}

/* 說明文字。裡面會夾 <span class="tnum"> 的數字,所以絕不能是 flex ——
   那會把「撤銷會刪掉上面那」「2」「筆轉帳」切成三個 flex item,換行就爛了。 */
.hint {
  margin-top: 0.5rem;
  font-size: 0.6875rem;
  line-height: 1.6;
  color: var(--text-muted);
}
/* 備註列有圖示,要 flex 才能讓圖示不被文字推歪 */
.note {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  margin-top: 0.5rem;
  font-size: 0.6875rem;
  line-height: 1.6;
  color: var(--text-muted);
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.625rem 0.75rem;
  border-radius: 0.75rem;
  font-size: 0.75rem;
  line-height: 1.6;
  background: color-mix(in oklab, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in oklab, var(--warn) 32%, var(--border));
  color: var(--text);
}

.err {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--debit);
}

@media (prefers-reduced-motion: reduce) {
  .head {
    transition: none;
  }
}
</style>
