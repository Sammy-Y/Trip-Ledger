<script setup lang="ts">
import type { Expense } from '~~/shared/types';
import { CURRENCY_LABEL, EXPONENT, formatMoney, fromMinor } from '~~/shared/money';
import { splitEqually } from '~~/shared/split';

/**
 * 一筆支出的完整組成 —— 這頁最重要的一塊。
 *
 * 使用者要敢拿結算的數字去跟朋友要錢,就必須能回推每一筆是怎麼算出來的:
 *   1. 誰墊了多少(payers)
 *   2. 誰該分攤多少(shares)—— 和付款人是兩組不同的人
 *   3. 合計對不對得起支出金額(對不上就明白標出來,不要靜靜藏著)
 *   4. 當時用的是哪一天、哪裡來的匯率,有沒有加價差
 * 所以這裡刻意把每一條都攤開,而不是只顯示一個總額。
 */
const props = withDefaults(defineProps<{
  expense: Expense;
  /** member_id -> 名字。由 useTrip 的 memberMap 傳進來 */
  names: Map<string, string>;
  /** 旅程本位幣,用來顯示「約等於多少」的估算值 */
  baseCurrency?: string;
  /** 被蓋章的那次結算是第幾次(列表頁查結算歷史後傳進來)。null = 查不到 */
  roundSeq?: number | null;
  /** 公費的 member_id。這趟沒設公費時是 null */
  potId?: string | null;
}>(), {
  baseCurrency: 'TWD',
  roundSeq: null,
  potId: null,
});

defineEmits<{ edit: []; delete: [] }>();

function nameOf(id: string): string {
  return props.names.get(id) ?? '未知成員';
}

const isPersonal = computed(() => props.expense.kind === 'personal');
const amountMinor = computed(() => props.expense.amount_minor);

/**
 * 一列付款 / 分攤。
 *
 * 刻意**不帶百分比**:這裡的問題永遠是「我要付多少」,金額就是答案,
 * 而 50% 是同一個數字換一種比較難用的講法。兩個數字並排的時候,
 * 眼睛還得先挑出哪個才是要看的那個。合計對不對得上有下面的 mismatch 那行在守,
 * 不需要靠百分比露出破綻。
 */
interface Line {
  key: string;
  /** 成員 id。分攤方式的回推要用它去比對均分的結果,不能只留名字 */
  id: string;
  name: string;
  minor: number;
}

function toLines(list: Array<{ member_id: string; amount_minor: number }>): Line[] {
  return list
    .map((l, i) => ({
      key: `${l.member_id}:${i}`,
      id: l.member_id,
      name: nameOf(l.member_id),
      minor: l.amount_minor,
    }))
    .sort((a, b) => b.minor - a.minor);
}

const payerLines = computed(() => toLines(props.expense.payers ?? []));
const shareLines = computed(() => toLines(props.expense.shares ?? []));

const payerTotal = computed(() => payerLines.value.reduce((s, l) => s + l.minor, 0));
const shareTotal = computed(() => shareLines.value.reduce((s, l) => s + l.minor, 0));
const payerDiff = computed(() => payerTotal.value - amountMinor.value);
const shareDiff = computed(() => shareTotal.value - amountMinor.value);

/** 只有一個付款人、而且金額就是全額 —— 這是最常見的情況,不必再顯示合計列 */
const singlePayer = computed(() => payerLines.value.length === 1 && payerDiff.value === 0);

/**
 * 這筆是公費付的 —— 錢直接從信封扣掉。
 *
 * 分攤明細對這種帳沒有可以行動的資訊:公費的錢是大家一開始就先拿出來的,
 * 這一筆花掉之後不是誰墊給誰,只有信封的剩餘變少。把「HSUAN 7,500 /
 * MIN 7,500」列成一份清單,讀起來像兩個人各自欠了一筆,而那不是這筆帳的意思。
 * 所以下面用一句話取代那份清單。
 *
 * ⚠️ 那句話**不能宣稱「沒有人要再付給誰」**。那只在「大家投入的比例和消耗的
 * 比例一致」時才成立 —— 投入不均的時候,公費付掉的支出照樣會長出真的人對人
 * 轉帳(MIN 投 5 萬、HSUAN 投 0、公費花 32,114 均分 → recorded 是
 * 「HSUAN → MIN 16,057」,按下去會寫進 settlements)。而這個元件只拿得到
 * **單筆支出**,沒有任何資訊可以下那個結論:它不知道誰投入了多少。
 * 所以這句話只陳述這一筆做了什麼(從信封扣掉、剩餘變少),
 * 「所以誰要給誰多少」交給結算頁 —— 那裡才看得到整趟。
 *
 * shares 本身沒有被刪掉,也不該刪:它就是每個人從公費消耗了多少,
 * 直接進每個人的淨額(見 server/utils/ledger.ts)。這裡只是不把它畫成清單。
 */
const paidByPot = computed(() => (
  !!props.potId
  && payerLines.value.length === 1
  && payerLines.value[0]!.id === props.potId
));

/**
 * 分攤方式沒有存在 DB 裡,只能從金額回推。
 *
 * 判定要和編輯表單用**同一條規則**(shared/split.ts 的 splitEqually),
 * 否則同一筆會出現「明細寫自訂金額、點編輯卻停在均分」的矛盾。
 * 這也是為什麼不能只比「大家金額一樣」—— 100 日圓三個人分是 34/33/33,
 * 那是不折不扣的均分,只是餘數被分掉了。
 */
const splitHint = computed(() => {
  const lines = shareLines.value;
  if (isPersonal.value || paidByPot.value || lines.length < 2) return '';
  const equal = splitEqually(amountMinor.value, lines.map((l) => l.id));
  if (!lines.every((l) => equal.get(l.id) === l.minor)) return '自訂金額';
  const values = lines.map((l) => l.minor);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const cur = props.expense.currency;
  return min === max
    ? `平均分攤,每人 ${formatMoney(min, cur)}`
    : `平均分攤,除不盡的餘數已分配(每人 ${formatMoney(min, cur)} 或 ${formatMoney(max, cur)})`;
});

// ── 匯率(可稽核的關鍵)───────────────────────────────────────
const isBaseCurrency = computed(() => props.expense.currency === props.baseCurrency);
const markupPct = computed(() => props.expense.fx_markup_pct ?? 0);
const midRate = computed(() => props.expense.fx_rate);
const overrideRate = computed(() => props.expense.fx_rate_override);
/** override 優先(使用者照信用卡帳單回填的才是真的) */
const usedRate = computed(() => overrideRate.value ?? midRate.value);
const effectiveRate = computed(() => (
  usedRate.value == null ? null : usedRate.value * (1 + markupPct.value / 100)
));

/** 和 server 的 convertToBase 同一套算法,顯示出來的數字才會跟結算頁一致 */
const convertedMinor = computed<number | null>(() => {
  if (isBaseCurrency.value) return amountMinor.value;
  if (effectiveRate.value == null) return null;
  const eTo = EXPONENT[props.baseCurrency] ?? 2;
  return Math.round(
    fromMinor(amountMinor.value, props.expense.currency) * effectiveRate.value * 10 ** eTo,
  );
});

function fmtRate(rate: number): string {
  return rate.toLocaleString('zh-TW', { maximumSignificantDigits: 6 });
}

const currencyLabel = computed(() => CURRENCY_LABEL[props.expense.currency] ?? props.expense.currency);
const baseLabel = computed(() => CURRENCY_LABEL[props.baseCurrency] ?? props.baseCurrency);
const rateLine = computed(() => (
  effectiveRate.value == null
    ? ''
    : `1 ${currencyLabel.value} ≈ ${fmtRate(effectiveRate.value)} ${baseLabel.value}`
));

/** 匯率來源被標成 fallback 的,代表那天沒有資料、拿了最接近的一筆頂替 */
const isApproximateSource = computed(() => !!props.expense.fx_rate_source?.includes('fallback'));

// ── 記錄時間 ────────────────────────────────────────────────
/**
 * created_at 來自 SQLite 的 datetime('now'),長這樣:'2026-09-07 04:12:33'(UTC 但沒有 Z)。
 * 直接 new Date() 在部分瀏覽器會當成當地時間,差 8 小時 —— 沒有時區標記就自己補 Z。
 */
function parseDbTime(raw: string | null): Date | null {
  if (!raw) return null;
  const t = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const iso = /([Zz]|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const createdText = computed(() => {
  const d = parseDbTime(props.expense.created_at);
  if (!d) return '';
  return d.toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
});
</script>

<template>
  <div class="border-t px-4 pt-3.5 pb-4" style="border-color: var(--border); background: var(--bg-sunken)">
    <!-- 金額本體:原幣 + 換算估算值 -->
    <div class="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div class="flex items-baseline gap-2">
        <UiMoney :minor="amountMinor" :currency="expense.currency" size="lg" />
        <span class="text-xs text-[var(--text-muted)]">{{ currencyLabel }}</span>
      </div>
      <p v-if="!isBaseCurrency" class="text-xs text-[var(--text-muted)]">
        <template v-if="convertedMinor != null">
          ≈ <span class="tnum">{{ formatMoney(convertedMinor, baseCurrency) }}</span>
          <span class="ml-1">({{ baseLabel }}估算)</span>
        </template>
        <template v-else>沒有可用匯率,無法換算</template>
      </p>
    </div>

    <!-- 付款人 vs 分攤:兩組不同的人,並排放才看得出差別 -->
    <div class="grid gap-4 md:grid-cols-2 md:gap-6">
      <!-- ── 誰墊的錢 ── -->
      <section>
        <h4 class="sect-title">
          <Icon name="lucide:wallet" size="13" />
          <span>誰付的錢</span>
          <span v-if="payerLines.length > 1" class="sect-count">{{ payerLines.length }} 人</span>
        </h4>

        <ul v-if="payerLines.length" class="lines">
          <li v-for="line in payerLines" :key="line.key">
            <span class="truncate">{{ line.name }}</span>
            <UiMoney :minor="line.minor" :currency="expense.currency" size="sm" />
          </li>
          <li v-if="!singlePayer" class="total">
            <span>付款合計</span>
            <UiMoney :minor="payerTotal" :currency="expense.currency" size="sm" />
          </li>
        </ul>
        <p v-else class="empty">沒有記錄付款人。</p>

        <p v-if="payerDiff !== 0 && payerLines.length" class="mismatch">
          <Icon name="lucide:triangle-alert" size="13" class="mt-0.5 shrink-0" />
          <span>
            付款合計比支出金額
            {{ payerDiff > 0 ? '多' : '少' }}
            <span class="tnum">{{ formatMoney(Math.abs(payerDiff), expense.currency) }}</span>
          </span>
        </p>
      </section>

      <!--
        ── 誰要分攤 ──
        公費付的那種不列名單:錢是大家一開始就拿出來放進信封的,
        這一筆花掉之後沒有人要再付給誰,列出來只會讀成「兩個人各欠一筆」。
      -->
      <section>
        <h4 class="sect-title">
          <Icon :name="paidByPot ? 'lucide:piggy-bank' : (isPersonal ? 'lucide:user' : 'lucide:users')" size="13" />
          <span>{{ paidByPot ? '怎麼算的' : (isPersonal ? '記在誰身上' : '誰要分攤') }}</span>
          <span v-if="!paidByPot && !isPersonal && shareLines.length" class="sect-count">{{ shareLines.length }} 人</span>
        </h4>

        <!--
          `&& shareLines.length` 是刻意的:完全沒有分攤紀錄的公費支出要落回
          下面那句「沒有分攤紀錄,這筆不會進結算」,不能被這段話蓋掉。
          (API 兩支端點都驗過合計,所以只有匯入腳本 / 手動 SQL 造得出這種列 ——
           而那正是 findUnbalancedExpenses 存在的理由,畫面不能反而變成一片正常。)
        -->
        <p v-if="paidByPot && shareLines.length" class="text-sm leading-relaxed text-[var(--text-muted)]">
          直接從{{ payerLines[0]?.name }}扣掉,不是誰先墊的 ——
          這筆會讓{{ payerLines[0]?.name }}的剩餘少
          <UiMoney :minor="amountMinor" :currency="expense.currency" size="sm" />,
          由 {{ shareLines.length }} 個人一起用掉。
          <span class="block mt-1">誰最後要付給誰,看「結算」—— 那要看整趟每個人投入多少。</span>
        </p>

        <template v-else>
          <ul v-if="shareLines.length" class="lines">
            <li v-for="line in shareLines" :key="line.key">
              <span class="truncate">{{ line.name }}</span>
              <UiMoney :minor="line.minor" :currency="expense.currency" size="sm" />
            </li>
            <li v-if="shareLines.length > 1" class="total">
              <span>分攤合計</span>
              <UiMoney :minor="shareTotal" :currency="expense.currency" size="sm" />
            </li>
          </ul>
          <p v-else class="empty">
            {{ isPersonal ? '沒有指定歸屬。' : '沒有分攤紀錄,這筆不會進結算。' }}
          </p>
        </template>

        <p v-if="splitHint" class="mt-1.5 text-[0.6875rem] text-[var(--text-muted)]">
          {{ splitHint }}
        </p>

        <!--
          `|| paidByPot`:公費那條分支不畫清單,所以「沒有 shares」不再有
          任何畫面說得出來,警告是唯一的線索。少了它,一筆壞掉的公費支出
          在明細頁看起來會完全正常,而結算頁那邊已經被 blocked_reason 擋死了。
        -->
        <p v-if="shareDiff !== 0 && (shareLines.length || paidByPot)" class="mismatch">
          <Icon name="lucide:triangle-alert" size="13" class="mt-0.5 shrink-0" />
          <span>
            分攤合計比支出金額
            {{ shareDiff > 0 ? '多' : '少' }}
            <span class="tnum">{{ formatMoney(Math.abs(shareDiff), expense.currency) }}</span>
          </span>
        </p>
      </section>
    </div>

    <!-- ── 匯率:可稽核的關鍵。哪一天、哪裡來的、有沒有加價差 ── -->
    <section v-if="!isBaseCurrency" class="mt-4 rounded-xl p-3" style="background: var(--bg)">
      <h4 class="sect-title">
        <Icon name="lucide:arrow-right-left" size="13" />
        <span>換算匯率</span>
        <span v-if="overrideRate != null" class="sect-count">手動指定</span>
        <span v-else-if="isApproximateSource" class="sect-count">近似</span>
      </h4>

      <template v-if="usedRate != null">
        <p class="text-sm font-medium text-[var(--text)]">
          <span class="tnum">{{ rateLine }}</span>
        </p>
        <dl class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.6875rem] text-[var(--text-muted)]">
          <dt>採用匯率</dt>
          <dd class="tnum">
            {{ fmtRate(usedRate) }}
            <span v-if="overrideRate != null">(手動填入,不是當日中價)</span>
          </dd>

          <template v-if="overrideRate != null && midRate != null">
            <dt>當日中價</dt>
            <dd class="tnum">{{ fmtRate(midRate) }}</dd>
          </template>

          <template v-if="markupPct">
            <dt>加計價差</dt>
            <dd class="tnum">
              {{ markupPct > 0 ? '+' : '' }}{{ markupPct }}%
              <span>({{ expense.payment_method === 'card' ? '海外刷卡手續費假設' : '換現金價差假設' }})</span>
            </dd>
          </template>

          <template v-if="expense.fx_rate_date">
            <dt>匯率日期</dt>
            <dd class="tnum">{{ expense.fx_rate_date }}</dd>
          </template>

          <template v-if="expense.fx_rate_source">
            <dt>資料來源</dt>
            <dd class="break-all">{{ expense.fx_rate_source }}</dd>
          </template>
        </dl>
        <p class="mt-2 text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
          換算值為估算。刷卡以店家請款日的匯率計價,實際金額以銀行帳單為準。
        </p>
      </template>
      <p v-else class="text-xs leading-relaxed text-[var(--text-muted)]">
        這筆沒有存到匯率,所以不會計入本位幣的合計。之後可以照帳單回填。
      </p>
    </section>

    <!-- ── 備註 ── -->
    <section v-if="expense.note" class="mt-4">
      <h4 class="sect-title">
        <Icon name="lucide:message-square-text" size="13" />
        <span>備註</span>
      </h4>
      <p class="text-sm leading-relaxed whitespace-pre-wrap text-[var(--text)]">{{ expense.note }}</p>
    </section>

    <!-- ── 記錄資訊 + 刪除 ── -->
    <div
      class="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-3"
      style="border-color: var(--border)"
    >
      <p class="text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
        <span>消費日 <span class="tnum">{{ expense.spent_at }}</span></span>
        <template v-if="createdText">
          <span class="mx-1">·</span>
          <span>記錄於 <span class="tnum">{{ createdText }}</span></span>
        </template>
        <span class="mx-1">·</span>
        <span class="tnum">#{{ expense.id.slice(0, 8) }}</span>
      </p>

      <!--
        已列入結算回合的支出不能改也不能刪(server 兩邊都回 409)。
        入口直接不畫出來並說明原因 —— 讓人按下去、把表單填完、才在送出時看到
        「不能修改」是很差的體驗,而且會讓人以為是系統壞了。
        這段文字也是列首那個鎖的完整版:圖示只說得出「鎖住了」,
        說不出「第幾次結算」和「怎麼解開」。
      -->
      <span v-if="expense.settlement_round_id" class="settled-note">
        <Icon name="lucide:lock" size="13" class="shrink-0" />
        <span>
          已列入{{ roundSeq ? `第 ${roundSeq} 次` : '' }}結算,不能修改或刪除。
          要改請先到結算頁撤銷那次結算。
        </span>
      </span>
      <span v-else class="flex items-center gap-1">
        <button type="button" class="act-btn" @click="$emit('edit')">
          <Icon name="lucide:pencil" size="15" />
          <span>編輯</span>
        </button>
        <button type="button" class="act-btn is-danger" @click="$emit('delete')">
          <Icon name="lucide:trash-2" size="15" />
          <span>刪除這筆</span>
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* 顏色全部走 main.css 的 CSS 變數,深色模式自動跟著換。 */

.settled-note {
  display: inline-flex;
  align-items: flex-start;
  gap: 0.3rem;
  max-width: 22rem;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--text-muted);
}

.sect-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-bottom: 0.5rem;
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

/* 每一條付款 / 分攤。金額欄固定靠右,人名再長也不會把金額推歪 */
.lines {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  font-size: 0.875rem;
  color: var(--text);
}
.lines > li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 1.75rem;
}
.lines > li > :first-child {
  flex: 1 1 auto;
  min-width: 0;
}
.lines > li > :last-child {
  margin-left: auto;
  text-align: right;
}
.lines > li.total {
  margin-top: 0.25rem;
  padding-top: 0.375rem;
  border-top: 1px dashed var(--border);
  font-size: 0.75rem;
  color: var(--text-muted);
}

.empty {
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.mismatch {
  display: flex;
  align-items: flex-start;
  gap: 0.25rem;
  margin-top: 0.5rem;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--warn);
}

/*
 * 編輯 / 刪除:都不做成搶眼的實心鈕(明細是拿來讀的,不是拿來動手的),
 * 但點擊區維持 44px。刪除用 --debit 提示破壞性,編輯用中性色 ——
 * 兩顆並排時,顏色是唯一能防止手滑按錯的東西。
 */
.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 44px;
  padding-inline: 0.75rem;
  border-radius: 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-muted);
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.12s ease;
}
.act-btn.is-danger {
  color: var(--debit);
  /* 最後一顆的內距要抵銷掉,文字才對齊右邊的內容邊界 */
  margin-right: -0.75rem;
}
@media (hover: hover) {
  .act-btn:hover {
    background: var(--bg);
    color: var(--text);
  }
  .act-btn.is-danger:hover {
    background: color-mix(in oklab, var(--debit) 10%, transparent);
    color: var(--debit);
  }
}
.act-btn:active {
  transform: scale(0.98);
  background: var(--bg);
}
.act-btn.is-danger:active {
  background: color-mix(in oklab, var(--debit) 10%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .act-btn {
    transition: none;
  }
  .act-btn:active {
    transform: none;
  }
}
</style>
