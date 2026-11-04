<script setup lang="ts">
/**
 * 記一筆 / 改一筆換匯。自動註冊名稱是 <FxExchangeSheet>。
 *
 * ── 這個表單存在的理由:使用者講的是匯率,不是台幣 ────────────────
 *
 * 「第一次我換 0.21」是他記得的東西;「我付了 1,050」要他自己乘一次。
 * 但資料庫存的是**兩邊的金額**(理由見 schema.sql 的 fx_exchanges),
 * 所以那次乘法一定要有人做 —— 讓表單做,而且**把結果顯示出來讓他確認**。
 *
 * 所以「匯率」和「付出台幣」是同一件事的兩個入口:
 *   填匯率 → 自動算出台幣
 *   填台幣 → 自動算出匯率
 * 兩邊**永遠同時顯示**,最後那道確認句講的是真正會被存進去的那兩個整數。
 *
 * ── 為什麼用 driver 而不是兩個 watch ────────────────────────────
 *
 * 雙向欄位最自然的寫法是「A 變了就寫 B、B 變了就寫 A」,而那個寫法會互相
 * 觸發:四捨五入讓回寫的值和原值差一點點,兩個 watch 就會來回抖到停不下來
 * (匯率 0.2067 → 台幣 1,033.50 → 匯率 0.20670 → …)。
 *
 * 這裡改成:**只有一個欄位是真的輸入,另一個一律是導出的**。
 * `driver` 記住使用者最後在哪一個欄位打字,另一個欄位的 getter 直接算給他看。
 * 沒有回寫,所以結構上不可能有迴圈;而且「哪一個數字是我填的」在畫面上
 * 也講得出來(下面那個 hint)。
 *
 * 換到的金額改動時兩種行為都對,而且都是使用者要的:
 *   填了匯率 → 改金額,台幣跟著變(匯率是我談好的)
 *   填了台幣 → 改金額,匯率跟著變(我就只付這麼多)
 */
import type { FxExchange, Member } from '~~/shared/types';
import {
  CURRENCY_LABEL, EXPONENT, exchangeCostMinor, exchangeRate,
  formatMoney, formatRate, fromMinor, toMinor,
} from '~~/shared/money';

const props = withDefaults(defineProps<{
  tripId: string;
  /** 真正的「人」。公費不能換匯(見 exchanges.post.ts),所以不該出現在這裡 */
  people: Member[];
  /** 旅程的本位幣。在台灣換日幣,付出去的就是這個 */
  baseCurrency: string;
  /** 有值 = 編輯那一列;null = 新增一筆 */
  editing?: FxExchange | null;
}>(), {
  editing: null,
});

const open = defineModel<boolean>('open', { default: false });

const emit = defineEmits<{
  /** 寫入成功。父層據此重抓 balance(錢包的數字)與清單 */
  saved: [];
}>();

const api = useApi();

/**
 * 支援的幣別。和 overview.vue 用同一份清單 ——
 * 資料庫的 currencies 表目前也只有這兩列,多給選項只會讓人選到寫不進去的幣別。
 */
const CURRENCIES = ['JPY', 'TWD'];

const memberId = ref('');
/** 換到的幣別 */
const currency = ref('JPY');
/** 付出的幣別 */
const costCurrency = ref('TWD');
/** 換到多少(人類單位) */
const amount = ref<number | null>(null);
/** 使用者填的匯率。driver === 'rate' 時才是真的輸入 */
const rateInput = ref<number | null>(null);
/** 使用者填的付出金額(人類單位)。driver === 'cost' 時才是真的輸入 */
const costInput = ref<number | null>(null);
/** 使用者最後在哪一個欄位打字。另一個一律是導出值 */
const driver = ref<'rate' | 'cost'>('rate');
const exchangedAt = ref('');
const note = ref('');
const saving = ref(false);
const errorMessage = ref('');

const isEdit = computed(() => !!props.editing);

/** 輸入框的 step。日幣沒有輔幣,給 0.01 會允許打出 0.5 圓這種不存在的金額。 */
function stepFor(cur: string): string {
  return (EXPONENT[cur] ?? 2) === 0 ? '1' : '0.01';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 重設表單。編輯時把那一列的值帶進來。
 *
 * 編輯**一律從 cost 進去**(driver = 'cost'):資料庫存的是金額,
 * 那才是既存的事實。從匯率進去的話,顯示的匯率會是反推出來的浮點數
 * (0.20666666666666667),而使用者當初填的是 0.2067 —— 他會以為系統改了他的數字。
 */
function reset() {
  const src = props.editing;
  errorMessage.value = '';
  if (src) {
    memberId.value = src.member_id;
    currency.value = src.currency;
    costCurrency.value = src.cost_currency;
    amount.value = fromMinor(src.amount_minor, src.currency);
    costInput.value = fromMinor(src.cost_minor, src.cost_currency);
    rateInput.value = null;
    driver.value = 'cost';
    exchangedAt.value = src.exchanged_at;
    note.value = src.note ?? '';
    return;
  }
  // 新增:只有一個人的時候直接選好他 —— 多數旅程就是自己一個人在記
  memberId.value = props.people.length === 1 ? props.people[0]!.id : '';
  costCurrency.value = props.baseCurrency;
  // 換到的預設成「不是本位幣的那一個」。在台灣換日幣是這個功能的主場景,
  // 而 currency === cost_currency 是寫不進去的(server 端與資料庫都擋)。
  currency.value = CURRENCIES.find(c => c !== props.baseCurrency) ?? 'JPY';
  amount.value = null;
  rateInput.value = null;
  costInput.value = null;
  driver.value = 'rate';
  exchangedAt.value = today();
  note.value = '';
}

// 每次打開都重設。關閉時不清 —— 送出失敗後使用者可能想再打開來看剛填了什麼。
watch(open, (isOpen) => { if (isOpen) reset(); });
// 編輯目標換了(清單上換按另一列的「改」)也要重帶
watch(() => props.editing?.id, () => { if (open.value) reset(); });

/**
 * 換到的和付出的不能是同一個幣別(同幣別沒有匯率可言,server 與資料庫都擋)。
 * 使用者把「換到」改成台幣時自動把「付出」挪到另一個,而不是等他送出才報錯 ——
 * 那個錯誤他無法從畫面上預期,只會覺得表單在刁難他。
 */
watch(currency, (next) => {
  if (costCurrency.value === next) {
    costCurrency.value = CURRENCIES.find(c => c !== next) ?? next;
  }
});
watch(costCurrency, (next) => {
  if (currency.value === next) {
    currency.value = CURRENCIES.find(c => c !== next) ?? next;
  }
});

const amountMinor = computed(
  () => (amount.value == null || !Number.isFinite(amount.value)
    ? 0
    : toMinor(amount.value, currency.value)),
);

/**
 * 真正會被存進去的「付出多少」。
 *
 * 四捨五入到最小單位**只在這裡發生一次**,而下面的確認句印的就是它 ——
 * 所以畫面上寫 NT$1,050 的時候,資料庫裡就是 105000,不會差幾分錢。
 */
const costMinor = computed(() => {
  if (driver.value === 'cost') {
    return (costInput.value == null || !Number.isFinite(costInput.value))
      ? 0
      : toMinor(costInput.value, costCurrency.value);
  }
  if (rateInput.value == null || amountMinor.value <= 0) return 0;
  return exchangeCostMinor(amountMinor.value, currency.value, rateInput.value, costCurrency.value);
});

/** 那兩個整數算出來的有效匯率。畫面上的「匯率」講的一律是這個。 */
const effectiveRate = computed(
  () => exchangeRate(amountMinor.value, currency.value, costMinor.value, costCurrency.value),
);

/**
 * 匯率欄位。driver 是它的時候顯示使用者打的字(不重新格式化,不然打到一半會跳);
 * 否則顯示導出值。
 *
 * toPrecision(6) 是為了不要在輸入框裡印出 0.20666666666666667 ——
 * 那個長度會把欄位撐開,而且看起來像系統在亂算。真正存進去的是金額,
 * 這個數字只是給人看的。
 */
const rateField = computed<number | null>({
  get() {
    if (driver.value === 'rate') return rateInput.value;
    const r = effectiveRate.value;
    return r == null ? null : Number(r.toPrecision(6));
  },
  set(v) {
    driver.value = 'rate';
    rateInput.value = v;
  },
});

/** 付出金額欄位。和上面對稱。 */
const costField = computed<number | null>({
  get() {
    if (driver.value === 'cost') return costInput.value;
    return costMinor.value > 0 ? fromMinor(costMinor.value, costCurrency.value) : null;
  },
  set(v) {
    driver.value = 'cost';
    costInput.value = v;
  },
});

const memberOptions = computed(
  () => props.people.map(m => ({ value: m.id, label: m.name })),
);
const currencyOptions = computed(
  () => CURRENCIES.map(c => ({ value: c, label: `${CURRENCY_LABEL[c] ?? c} (${c})` })),
);

/** 送不出去的原因。有值就 disabled,而且每一條都要講得出使用者能怎麼辦。 */
const problems = computed<string[]>(() => {
  const out: string[] = [];
  if (!props.people.length) {
    out.push('這趟還沒有成員(公費不算)。先去「成員」頁加人,才知道這筆換匯是誰換的。');
    return out;
  }
  if (!memberId.value) out.push('請選這筆是誰換的。');
  if (amountMinor.value <= 0) out.push(`請填換到多少${CURRENCY_LABEL[currency.value] ?? currency.value}。`);
  else if (costMinor.value <= 0) {
    out.push(driver.value === 'rate'
      ? '請填匯率(或直接填付出多少),兩個填一個就好。'
      : `請填付出多少${CURRENCY_LABEL[costCurrency.value] ?? costCurrency.value}。`);
  }
  if (!exchangedAt.value) out.push('請填換匯的日期。');
  return out;
});

const canSubmit = computed(() => problems.value.length === 0 && !saving.value);

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  errorMessage.value = '';
  try {
    const path = `/api/trips/${encodeURIComponent(props.tripId)}/fx/exchanges`;
    if (props.editing) {
      // 編輯只送可以改的四個欄位。成員 / 幣別不給改(見 [id].patch.ts),
      // 送過去也會被忽略 —— 那更糟,使用者會以為改成功了。
      await api.patch(`${path}/${encodeURIComponent(props.editing.id)}`, {
        amount_minor: amountMinor.value,
        cost_minor: costMinor.value,
        exchanged_at: exchangedAt.value,
        note: note.value.trim() || null,
      });
    }
    else {
      await api.post(path, {
        member_id: memberId.value,
        currency: currency.value,
        amount_minor: amountMinor.value,
        cost_currency: costCurrency.value,
        cost_minor: costMinor.value,
        exchanged_at: exchangedAt.value,
        note: note.value.trim() || undefined,
      });
    }
    open.value = false;
    emit('saved');
  }
  catch (e) {
    // server 的 statusMessage 原樣顯示 —— 那句話帶著數字和「可以怎麼辦」,
    // 換成「操作失敗」等於把使用者唯一的線索吞掉(同 overview.vue 的 moveError)。
    errorMessage.value = api.errorMessage(e);
  }
  finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiAppSheet
    v-model:open="open"
    :title="isEdit ? '改這筆換匯' : '記一筆換匯'"
    :dismissible="!saving"
  >
    <div class="space-y-4">
      <p class="text-sm leading-relaxed" style="color: var(--text-muted)">
        <template v-if="isEdit">
          金額、日期、備註可以改。要換人或換幣別的話請刪掉重記 ——
          這張紀錄不影響任何結算,刪掉是安全的。
        </template>
        <template v-else>
          出發前在台灣換的、當地 ATM 提的都算。
          <strong style="color: var(--text)">匯率和付出金額填一個就好</strong>,另一個會自動算出來。
        </template>
      </p>

      <!--
        誰換的。編輯時鎖住 —— 「記到別人頭上」不是改一個數字,那是刪掉重記
        (理由見 server 端的 [id].patch.ts)。鎖住而不是隱藏,才看得出這筆是誰的。
      -->
      <UiAppField
        v-model="memberId"
        label="誰換的"
        type="select"
        :options="memberOptions"
        :placeholder-option="memberOptions.length === 1 ? undefined : '請選擇'"
        :disabled="isEdit"
        :hint="isEdit ? '要換人請刪掉這筆重記' : undefined"
      />

      <!-- 換到多少 -->
      <div class="grid grid-cols-[1fr_1.4fr] gap-3">
        <UiAppField
          v-model="currency"
          label="換到"
          type="select"
          :options="currencyOptions"
          :disabled="isEdit"
        />
        <UiAppField
          v-model.number="amount"
          label="金額"
          type="number"
          :step="stepFor(currency)"
          min="0"
          inputmode="decimal"
          placeholder="0"
        />
      </div>

      <!--
        ── 匯率 / 付出金額:同一件事的兩個入口 ──
        兩個永遠同時顯示,使用者填哪一個都行。沒在打字的那一個是導出值,
        hint 會說明它是算出來的(不然他會以為系統擅自填了東西)。
      -->
      <div class="grid grid-cols-2 gap-3">
        <UiAppField
          v-model.number="rateField"
          label="匯率"
          type="number"
          step="0.0001"
          min="0"
          inputmode="decimal"
          placeholder="0.21"
          :hint="driver === 'rate'
            ? `1 ${currency} = ? ${costCurrency}`
            : '由付出金額算出來的'"
        />
        <UiAppField
          v-model.number="costField"
          label="付出"
          type="number"
          :step="stepFor(costCurrency)"
          min="0"
          inputmode="decimal"
          placeholder="0"
          :hint="driver === 'cost'
            ? (CURRENCY_LABEL[costCurrency] ?? costCurrency)
            : '由匯率算出來的'"
        />
      </div>

      <!--
        送出前最後一道人眼檢查。印的是**真正會被存進去的那兩個整數**
        和它們算出來的匯率 —— 使用者填 0.21、這裡顯示 NT$1,050,
        兩個數字都對得上他銀行帳戶扣掉的金額他才敢按下去。
      -->
      <div
        v-if="amountMinor > 0 && costMinor > 0"
        class="rounded-xl px-3 py-2.5"
        style="background: var(--bg-sunken)"
      >
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-xs" style="color: var(--text-muted)">會記下來的</span>
          <span class="tnum text-sm font-semibold">
            {{ formatMoney(costMinor, costCurrency) }} → {{ formatMoney(amountMinor, currency) }}
          </span>
        </div>
        <p class="mt-1 text-[0.6875rem]" style="color: var(--text-muted)">
          有效匯率 <span class="tnum">{{ formatRate(effectiveRate) }}</span>
          （1 {{ currency }} = {{ formatRate(effectiveRate) }} {{ costCurrency }}）
        </p>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <UiAppField v-model="exchangedAt" label="日期" type="date" />
        <UiAppField v-model="note" label="備註" placeholder="例:機場台銀" />
      </div>

      <div v-if="problems.length" class="card p-3 text-sm" role="alert" style="border-color: var(--warn)">
        <div v-for="p in problems" :key="p" class="flex items-start gap-2" style="color: var(--warn)">
          <Icon name="lucide:alert-circle" class="mt-0.5 shrink-0" />
          <span class="leading-relaxed">{{ p }}</span>
        </div>
      </div>

      <p v-if="errorMessage" class="text-sm leading-relaxed" role="alert" style="color: var(--debit)">
        {{ errorMessage }}
      </p>
    </div>

    <template #footer>
      <UiAppButton variant="ghost" block :disabled="saving" @click="open = false">
        取消
      </UiAppButton>
      <UiAppButton variant="primary" block :loading="saving" :disabled="!canSubmit" @click="submit">
        {{ isEdit ? '儲存' : '記下來' }}
      </UiAppButton>
    </template>
  </UiAppSheet>
</template>
