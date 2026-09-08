<script setup lang="ts">
/**
 * 記一筆支出。這是整個 App 最重要的畫面。
 *
 * 三個設計重點:
 *
 * 1. **付款人與分攤人是分開的兩組人。**
 *    例如「喧刷卡付了 6,274,但實際是民用 3,857、喧用 2,417」——
 *    付款人是喧,分攤是民/喧各自的金額。原本 Excel 只能把這種事寫進備註,
 *    所以永遠算不出誰欠誰。
 *
 * 2. **即時試算,不讓 server 的 400 打臉使用者。**
 *    分攤與付款的合計必須等於支出金額,server 會擋。
 *    但使用者不該在按下送出後才知道差了 3 塊 —— 所以這裡用
 *    shared/split.ts(和 server 同一份程式碼)即時算出差額並顯示。
 *
 * 3. **新增與編輯共用同一份表單。**
 *    給了 initial 就是編輯(把既有支出預填進來),沒給就是記新的一筆。
 *    刻意不複製一份「編輯版表單」—— 兩邊的驗證、試算、公費規則必須永遠一致,
 *    分成兩份的那一刻就注定會有一邊先壞掉。送出的 payload 兩邊完全相同
 *    (PATCH 是整筆取代語意),差別只在呼叫端打 POST 還是 PATCH。
 */
import type { Kind, PaymentMethod, Member, Expense } from '~~/shared/types';
import { toMinor, fromMinor, EXPONENT, CURRENCY_LABEL } from '~~/shared/money';
import { previewShares, splitEqually } from '~~/shared/split';
import type { PayerDraft } from './PayerEditor.vue';
import type { SplitDraft } from './SplitEditor.vue';

const props = defineProps<{
  members: Member[];
  baseCurrency: string;
  /** 換匯加成的預設值(%),來自 server 設定 */
  fxDefaults?: { cash_spread_pct: number; card_fee_pct: number };
  submitting?: boolean;
  errorMessage?: string | null;
  /**
   * 要編輯的既有支出。給了就預填,沒給就是空白的新表單。
   * 直接吃列表頁已經有的 Expense —— GET /expenses 回傳的每筆都帶完整的
   * payers / shares,所以編輯不需要另外開一個「查單筆」的端點。
   */
  initial?: Expense | null;
  /** 送出鈕的文案。編輯時要改成「儲存修改」之類,不然使用者會以為又記了一筆新的。 */
  submitLabel?: string;
}>();

const emit = defineEmits<{ submit: [payload: Record<string, unknown>] }>();

/** 公費不是人。它可以付錢,但永遠不該出現在分攤名單裡。 */
const pot = computed<Member | null>(() => props.members.find((m) => m.is_pot) ?? null);
const people = computed<Member[]>(() => props.members.filter((m) => !m.is_pot));

const CURRENCIES = ['JPY', 'TWD'];

/** 今天(當地時區)的 YYYY-MM-DD。不能用 toISOString,那是 UTC,晚上會少一天。 */
function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const kind = ref<Kind>('shared');
const description = ref('');
const category = ref('');
const currency = ref('JPY');
const amountInput = ref<number | null>(null);
const paymentMethod = ref<PaymentMethod>('cash');
const spentAt = ref(todayLocal());
const note = ref('');
const fxOverride = ref<number | null>(null);
const showAdvanced = ref(false);

const payers = ref<PayerDraft[]>([]);
const split = ref<SplitDraft>({ mode: 'equal', members: [], shares: {}, amounts: {} });

/**
 * 成員載入後給預設值:第一個「人」付錢、全員均分。
 * 均分名單刻意排除公費 —— 公費是出錢的一方,不是受益人,
 * 把它勾進去會讓它替自己分攤一份,結算就錯了。
 */
watch(people, (ms) => {
  if (!ms.length) return;
  if (!payers.value.length) payers.value = [{ member_id: ms[0]!.id, amount: null }];
  if (!split.value.members.length) split.value = { ...split.value, members: ms.map((m) => m.id) };
}, { immediate: true });

const amountMinor = computed(() =>
  amountInput.value == null || Number.isNaN(amountInput.value)
    ? 0 : toMinor(amountInput.value, currency.value));

// ── 公費 ────────────────────────────────────────────────────
/**
 * 「這筆是公費付的」。打開之後付款人固定是公費、分攤固定是全體成員均分 ——
 * 這就是公費的定義:大家先把錢拿出來,之後從那筆錢付,誰都不用再各付各的。
 * 所以這裡直接把付款人與分攤鎖住,不讓使用者手動改到自相矛盾的組合。
 */
const fromPot = ref(false);

/**
 * applyInitial 正在把既有支出灌回表單 —— 這段期間 fromPot 的連動要靜音。
 *
 * 用普通變數而不是 ref:它只在同一個同步區塊內被讀寫(設 true → 改 fromPot →
 * 下面那個 watcher 以 flush:'pre' 在同一輪跑完 → nextTick 設回 false),
 * 做成 ref 只會多一份沒有人訂閱的響應式依賴。
 */
let potSyncSuspended = false;

/** 切到個人花費、或這趟根本沒設公費時,這個開關要自動關掉 */
watch([kind, pot], () => {
  if (kind.value !== 'shared' || !pot.value) fromPot.value = false;
});

watch([fromPot, pot, people, kind], () => {
  // applyInitial 開開關的那一拍要跳過:那筆帳的付款人與分攤已經是正確的值,
  // 這裡再套一次會把它改寫成「全員均分」(見 applyInitial 的說明)。
  if (potSyncSuspended) return;
  if (!fromPot.value || kind.value !== 'shared') return;
  const potId = pot.value?.id;
  if (!potId) return;
  payers.value = [{ member_id: potId, amount: null }];
  split.value = { ...split.value, mode: 'equal', members: people.value.map((m) => m.id) };
});

/**
 * 「誰付的錢」可以挑誰 —— **只有真人**。
 *
 * 公費要付錢走下面那個「這筆從{公費}付」的開關,不在人名列裡挑。
 * 兩個入口並存的時候,公費會以一顆和真人長得一模一樣的 chip 出現在付款人列中,
 * 使用者只能從名字猜出它不是人;而且挑了它之後分攤欄仍然要自己填,
 * 做出來的東西和開關做的並不一樣(開關會連分攤一起鎖成全員均分)。
 * 同一件事有兩條會得到不同結果的路徑,那條沒有護欄的就是純粹的多餘。
 *
 * 唯一的例外是「這筆帳現在真的掛在公費名下、但開關沒開」——
 * 也就是多人墊款其中一位是公費(只有直接打 API 造得出來)。名單裡不放它的話,
 * PayerEditor 的成員 watcher 會把它從草稿裡默默刪掉,使用者一進編輯
 * 就看到「還差 X 沒有人認」,而畫面上完全看不出少的是誰。
 */
const payerChoices = computed<Member[]>(() => {
  const p = pot.value;
  if (!p || fromPot.value) return people.value;
  return payers.value.some((x) => x.member_id === p.id) ? props.members : people.value;
});


// ── 付款試算 ──
const payerSummary = computed(() => {
  const single = payers.value.length === 1 && payers.value[0]?.amount == null;
  const filledMinor = single
    ? amountMinor.value
    : payers.value.reduce((s, p) => s + (p.amount ? toMinor(p.amount, currency.value) : 0), 0);
  return { filledMinor, diffMinor: amountMinor.value - filledMinor, treatedAsFull: single };
});

/** 個人花費的「分攤」對象:就是付款人自己 */
const personalOwner = computed(() => payers.value[0]?.member_id ?? '');

// ── 分攤試算(和 server 同一份演算法,而且和測試同一份程式碼)──
// 規則本體在 shared/split.ts 的 previewShares() —— 抽出去才測得到。
// 個人花費「全額算給付款人」這條規則原本埋在這裡,結果送出鈕被永久鎖住
// 而 56 個 API 測試全綠,因為沒有任何測試碰得到 .vue 裡的 computed。
const splitPreview = computed<Record<string, number>>(() => previewShares({
  kind: kind.value,
  amountMinor: amountMinor.value,
  draft: split.value,
  ownerId: personalOwner.value,
  toMinorFn: (v) => toMinor(v, currency.value),
}));

const splitSumMinor = computed(() => Object.values(splitPreview.value).reduce((a, b) => a + b, 0));
const splitDiffMinor = computed(() => amountMinor.value - splitSumMinor.value);

// ── 送出前的驗證(和 server 的規則一致)──
const problems = computed(() => {
  const out: string[] = [];
  if (!description.value.trim()) out.push('請填寫說明');
  if (!amountMinor.value) out.push('請填寫金額');
  if (!payers.value.length || payers.value.some((p) => !p.member_id)) out.push('請選擇付款人');
  else if (payerSummary.value.diffMinor !== 0) out.push('付款金額合計與支出金額不符');
  // 個人花費的分攤是自動推出來的,不會、也不該有「請選擇分攤的人」這種問題
  if (kind.value === 'shared') {
    if (!Object.keys(splitPreview.value).length) out.push('請選擇分攤的人');
    else if (splitDiffMinor.value !== 0) out.push('分攤金額合計與支出金額不符');
  }
  return out;
});
const canSubmit = computed(() => problems.value.length === 0 && !props.submitting);

function buildPayload() {
  const d = split.value;
  let splitPayload: Record<string, unknown>;
  // 個人花費:全額算給付款人自己。用 exact 而不是 equal,
  // 因為 equal 會在未來多人時被誤解成「均分給這些人」。
  if (kind.value === 'personal') {
    splitPayload = { mode: 'exact', amounts: { [personalOwner.value]: amountInput.value } };
  }
  else if (d.mode === 'equal') splitPayload = { mode: 'equal', members: d.members };
  else if (d.mode === 'shares') {
    const s: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.shares)) if (v && v > 0) s[k] = v;
    splitPayload = { mode: 'shares', shares: s };
  } else {
    const a: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.amounts)) if (v != null && v !== 0) a[k] = v;
    splitPayload = { mode: 'exact', amounts: a };
  }
  return {
    kind: kind.value,
    description: description.value.trim(),
    category: category.value.trim() || undefined,
    currency: currency.value,
    // 注意:這裡送「人類單位」,server 會自己轉最小單位(和 settlements 端點不同)
    amount: amountInput.value,
    payment_method: paymentMethod.value,
    spent_at: spentAt.value,
    note: note.value.trim() || undefined,
    fx_rate_override: fxOverride.value ?? undefined,
    // 本位幣不需要換匯,送 undefined 讓 server 自己歸零
    fx_markup_pct: isForeign.value ? markupPct.value : undefined,
    payers: payers.value.map((p) => (p.amount == null ? { member_id: p.member_id } : { member_id: p.member_id, amount: p.amount })),
    split: splitPayload,
  };
}

function onSubmit() {
  if (!canSubmit.value) return;
  emit('submit', buildPayload());
}

// ── 連續記帳 ────────────────────────────────────────────────
const descriptionField = ref<{ focus: () => void } | null>(null);

/**
 * 記完一筆之後把表單準備好記下一筆。**呼叫端是「記一筆」那頁**(編輯不會用到)。
 *
 * 分成兩堆,判準是「這個欄位換一筆之後還會不會是同一個值」:
 *
 *   清掉  說明 / 金額 / 分類 / 備註 / 覆寫匯率
 *         這些是「這一筆是什麼」。留著等於把上一筆的內容偷偷掛到下一筆上,
 *         而使用者只會檢查自己剛打的那格。覆寫匯率尤其危險 —— 它是照著
 *         某一張信用卡帳單填的,套到下一筆就是一個沒人會發現的錯誤匯率。
 *
 *   留著  幣別 / 日期 / 付款方式 / 共同或個人 / 付款人 / 分攤 / 公費開關 / 換匯加成
 *         這些是「現在在什麼情境記帳」。在京都的居酒屋連記三筆,幣別、日期、
 *         誰付的、幾個人分,三次都一樣 —— 每記一筆就重設一次,等於逼使用者
 *         把同樣的東西再點三遍,那正是這個功能要解決的問題。
 *
 * (使用者明確要求過幣別不要跳回預設值;上面那條規則把它一起涵蓋了。)
 */
function startNextEntry(): void {
  description.value = '';
  amountInput.value = null;
  category.value = '';
  note.value = '';
  fxOverride.value = null;
  showAdvanced.value = false;
  // 手機上點完送出鍵盤會收起來,focus 回說明欄可以直接接著打下一筆。
  nextTick(() => descriptionField.value?.focus());
}

defineExpose({ startNextEntry });

const isForeign = computed(() => currency.value !== props.baseCurrency);
const amountStep = computed(() => (EXPONENT[currency.value] === 0 ? '1' : '0.01'));

// ── 換匯加成:只有刷卡預設要加 ────────────────────────────────
/**
 * **刷卡**才有國外交易手續費:國際組織費 + 發卡行加收,
 * 台灣的 Visa / Mastercard / JCB 實務上合計約 **1.5%**(AmEx 約 2%)。
 *
 * **現金預設 0%。** 這個團的做法是出發前就在台灣把現金換好,
 * 那筆錢的成本在換鈔當下就固定了 —— 記帳時再加一次價差等於重複計價,
 * 算出來的台幣金額會比實際付出的還多。
 * (在當地 ATM 提領或臨櫃換的話才有價差,那種情況逐筆自己填。)
 *
 * 兩個預設值的唯一來源都是 server 的 runtimeConfig(cardFeePct / cashSpreadPct),
 * 經 GET /api/trips/:trip 的 fx_defaults 帶進來,前端不自己寫死一份。
 */
const DEFAULT_MARKUP = { cash: 0, card: 1.5 };

/**
 * 某個「(幣別, 付款方式)」組合的預設加成。
 * 刻意做成吃參數的函式,而不是只留下面那個 computed —— applyInitial 要問的是
 * **存下來那筆自己的組合**的預設值,而 computed 只認得當下 ref 的值。
 */
function defaultMarkupFor(cur: string, method: PaymentMethod): number {
  // 本位幣不需要換匯,任何加成都沒有意義(和 server 同一條規則)
  if (cur === props.baseCurrency) return 0;
  const d = props.fxDefaults;
  return method === 'card'
    ? (d?.card_fee_pct ?? DEFAULT_MARKUP.card)
    : (d?.cash_spread_pct ?? DEFAULT_MARKUP.cash);
}

const markupDefault = computed(() => defaultMarkupFor(currency.value, paymentMethod.value));

const markupInput = ref<number | null>(null);
/** 使用者自己改過的話,就不要再被切換付款方式蓋掉 */
const markupTouched = ref(false);

/** 沒被改過就跟著付款方式 / 幣別自動帶入預設值 */
watch(markupDefault, (next) => {
  if (!markupTouched.value) markupInput.value = next;
}, { immediate: true });

const markupPct = computed(() => {
  if (!isForeign.value) return 0;
  const v = markupInput.value;
  return v == null || !Number.isFinite(v) ? markupDefault.value : v;
});

function resetMarkup(): void {
  markupTouched.value = false;
  markupInput.value = markupDefault.value;
}

/** 加成之後,1 外幣實際被當成多少本位幣 —— 讓使用者看得到這個%到底影響什麼 */
const markupHint = computed(() => {
  const pct = markupPct.value;
  if (!isForeign.value) return '';
  if (!pct) {
    return paymentMethod.value === 'cash'
      ? '直接用當日中價換算,不加計價差(現金出發前就換好了)。'
      : '不加計任何手續費,直接用當日中價換算。';
  }
  return `換算時在當日中價上加 ${pct}% —— ${
    paymentMethod.value === 'card' ? '相當於國外交易手續費' : '相當於換鈔價差'}。`;
});

// ── 編輯:把既有支出預填回表單 ────────────────────────────────
const submitText = computed(() => props.submitLabel || '記下這筆');

/**
 * 分攤模式的反推 —— 這是整個編輯功能唯一有失真的地方,所以講清楚。
 *
 * DB 只存「算完的每人金額」(expense_shares),**不存當初選的是
 * equal / shares / exact**。所以編輯時只能從金額回推,而回推必然會失真。
 *
 * 判定規則:拿 shared/split.ts 的 splitEqually()(和 server 寫入時同一份程式碼)
 * 重算一次,每個人都對得上才算 equal,否則一律 exact。
 * 刻意用重算而不是「大家金額一樣就是均分」—— 100 日圓三個人分是 34/33/33,
 * 只比相等會把一個貨真價實的均分誤判成自訂金額。
 *
 * 兩個已知失真,**都是預期行為,不是 bug**:
 *
 *  1. 舊資料裡原本選「按份數」(2:1:1)的,進來會顯示成「指定金額」。
 *     份數本身沒有被存下來,救不回來 —— 而且表單已經不再提供那個模式
 *     (見 SplitEditor 的說明),所以這條只會發生在改動之前記的帳上。
 *  2. 原本用「指定金額」手動填出剛好等於均分的數字,進來會顯示成「均分」。
 *
 * 兩種情況下畫面顯示的每人金額都和 DB 一模一樣,直接按儲存也不會改動任何數字 ——
 * 「送出後的 shares 金額 === 進來時的 shares 金額」才是這裡要保證的不變量,
 * 「還原使用者當初點了哪顆按鈕」做不到,也不影響帳的正確性。
 *
 * 真正會咬人的是第 1 種的後續操作:使用者若在按份數的支出上改了總金額,
 * 系統會按「指定金額」原封不動保留舊的每人金額,合計就對不上 ——
 * 但這時 SplitEditor 的差額提示會立刻紅字擋住送出,不會靜靜寫錯帳。
 */
function inferSplit(src: Expense): SplitDraft {
  const lines = src.shares ?? [];
  const ids = lines.map((s) => s.member_id);
  const equal = splitEqually(src.amount_minor, ids);
  const isEqual = ids.length > 0 && lines.every((s) => equal.get(s.member_id) === s.amount_minor);
  return {
    mode: isEqual ? 'equal' : 'exact',
    // 三種模式的草稿都填好(份數除外,它無從回推)——
    // 使用者切到別的模式時看到的是同一批人,不會突然變成空白。
    members: ids,
    shares: {},
    amounts: Object.fromEntries(lines.map((s) => [s.member_id, fromMinor(s.amount_minor, src.currency)])),
  };
}

/**
 * 預填。難點是單位:DB 的 payers / shares 是 amount_minor(日幣 3857、台幣 123456),
 * 而表單欄位是人類單位 —— 一律走 shared/money.ts 的 fromMinor(),不自己寫除法,
 * 不然 TWD 的兩位小數遲早會在某個地方被除錯。
 */
function applyInitial(src: Expense): void {
  kind.value = src.kind;
  description.value = src.description ?? '';
  category.value = src.category ?? '';
  currency.value = src.currency;
  amountInput.value = fromMinor(src.amount_minor, src.currency);
  paymentMethod.value = src.payment_method;
  spentAt.value = src.spent_at;
  note.value = src.note ?? '';
  fxOverride.value = src.fx_rate_override;
  // 有覆寫匯率就把進階區打開 —— 收起來的話使用者會看不到自己當初填的數字,
  // 以為它不見了(而它其實還在,而且正影響換算結果)。
  showAdvanced.value = src.fx_rate_override != null;

  /**
   * 加成:存下來的值就是當初的決定,markupDefault 的 watcher 不能在下一拍
   * 用預設值蓋掉它 —— 使用者只是進來改個說明,刷卡手續費就被偷偷從 2% 改回 1.5%。
   * 所以初次載入時**必須**擋住那個 watcher。
   *
   * 但無條件 `markupTouched = true` 擋得太久 —— 它擋的是這張表單的一輩子,
   * 連使用者自己在編輯中換付款方式都不再帶入預設值:JPY 現金(0%)改成刷卡,
   * 手續費會留在 0% 送出,而同一筆用「記一筆」新增成刷卡卻是 1.5% ——
   * 同一筆花費新增和編輯算出不同的本位幣金額。反方向(刷卡改現金)更糟,
   * 把國外交易手續費留在現金花費上,多算 1.5%。
   *
   * 所以只有「當初真的自訂過」才算 touched:把存下來的值和**它自己那個
   * (幣別, 付款方式) 組合**的預設值比,不一樣才是使用者動過手。當初就是走預設的,
   * 就繼續跟隨預設,換付款方式時預設值才跟得上;自訂過的值依舊不會被蓋掉。
   * (比的時候用 defaultMarkupFor(src...) 而不是 markupDefault —— 後者是 computed,
   * 講的是「當下 ref 的組合」,依賴 applyInitial 裡的賦值順序太脆。)
   */
  const savedMarkup = src.fx_markup_pct ?? 0;
  markupInput.value = savedMarkup;
  markupTouched.value = savedMarkup !== defaultMarkupFor(src.currency, src.payment_method);

  /**
   * 付款人:server 對「單一付款人」是把全額寫進 expense_payers 的,
   * 所以讀回來一定有金額。這裡把它還原成 amount = null(= 慣例上的「全額」),
   * PayerEditor 才會停在單一付款人模式,而不是一進來就變成多人墊款、
   * 逼使用者面對一個他從來沒填過的金額欄。
   */
  const paid = src.payers ?? [];
  const single = paid.length === 1 && paid[0]!.amount_minor === src.amount_minor;
  payers.value = paid.map((p) => ({
    member_id: p.member_id,
    amount: single ? null : fromMinor(p.amount_minor, src.currency),
  }));

  split.value = inferSplit(src);

  /**
   * 公費開關:這筆真的是公費付的就打開它。
   *
   * 以前這裡刻意保持關閉,理由是 fromPot 會**改寫**付款人與分攤成
   * 「公費付、全員均分」—— 猜錯(公費付但只有兩個人分攤)等於在使用者
   * 沒動手的情況下改掉他的帳。那個顧慮是對的,但關掉開關的代價更大:
   * 付款人選單現在只放真人(見 payerChoices),開關關著的話這筆帳的付款人
   * 就變成一個選單裡不存在的選項,而畫面上還同時顯示「這筆從公費付」沒有勾。
   *
   * 所以改成「打開開關,但擋掉那一次改寫」——potSyncSuspended 讓連動的
   * watcher 跳過這一拍,載進來的 payers / shares 原封不動。使用者不動手的話
   * 送出去的還是同一筆數字;真的想重新套用公費規則,取消勾選再勾一次就會生效。
   *
   * 判定用「單一付款人而且就是公費」。多人墊款其中一位是公費(只有直接打 API
   * 造得出來)不算 —— 那種形狀沒辦法用這個開關表達,交給 payerChoices 的
   * 例外分支把公費留在選單裡。
   */
  const potId = pot.value?.id;
  const paidByPot = !!potId && paid.length === 1 && paid[0]!.member_id === potId;
  if (fromPot.value !== paidByPot) {
    potSyncSuspended = true;
    fromPot.value = paidByPot;
    nextTick(() => { potSyncSuspended = false; });
  }
}

/**
 * immediate:編輯用的 sheet 是帶著資料一起掛載的,不能等到下一拍才填 ——
 * PayerEditor 的「單一 / 多人」模式是在它自己的 setup 讀 model 長度決定的,
 * 晚一步填,它就已經用空的 model 決定好模式了。
 */
watch(() => props.initial, (src) => {
  if (src) applyInitial(src);
}, { immediate: true });
</script>

<template>
  <form class="space-y-5" @submit.prevent="onSubmit">
    <!-- 共同 / 個人:雙軌帳本的入口,放最上面 -->
    <div class="card p-1.5 grid grid-cols-2 gap-1.5">
      <button
        v-for="opt in ([{ v: 'shared', l: '共同花費', d: '要分攤' }, { v: 'personal', l: '個人花費', d: '只算我的' }] as const)"
        :key="opt.v" type="button"
        class="rounded-xl py-2.5 px-3 text-center transition"
        :style="kind === opt.v
          ? 'background: color-mix(in oklab, var(--brand) 15%, transparent); color: var(--brand)'
          : 'color: var(--text-muted)'"
        @click="kind = opt.v">
        <div class="font-semibold text-sm">{{ opt.l }}</div>
        <div class="text-xs opacity-70">{{ opt.d }}</div>
      </button>
    </div>

    <div class="card p-4 space-y-4">
      <UiAppField
        ref="descriptionField"
        v-model="description" label="說明" placeholder="例如:3/8 吃飯" required />

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UiAppField
          v-model="currency" label="幣別" type="select"
          :options="CURRENCIES.map((c) => ({ value: c, label: `${CURRENCY_LABEL[c] ?? c} (${c})` }))" />
        <UiAppField
          v-model.number="amountInput" label="金額" type="number"
          :step="amountStep" inputmode="decimal" placeholder="0" required />
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UiAppField v-model="spentAt" label="日期" type="date" />
        <div>
          <span class="label">付款方式</span>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="m in ([{ v: 'cash', l: '現金', i: 'lucide:banknote' }, { v: 'card', l: '刷卡', i: 'lucide:credit-card' }] as const)"
              :key="m.v" type="button" class="btn"
              :class="paymentMethod === m.v ? 'btn-primary' : 'btn-ghost'"
              @click="paymentMethod = m.v">
              <Icon :name="m.i" /> {{ m.l }}
            </button>
          </div>
        </div>
      </div>

      <!-- 換算誤差要講清楚,不要讓使用者以為這是精準金額 -->
      <p v-if="isForeign" class="text-xs leading-relaxed" style="color: var(--text-muted)">
        <template v-if="paymentMethod === 'card'">
          刷卡以「店家請款日」的匯率計價,通常在消費後數日至數週。系統先用當日中價加計手續費估算,
          實際金額以銀行帳單為準 —— 收到帳單後可用下方的「覆寫匯率」回填正確數字。
        </template>
        <template v-else>
          現金直接用當日中價換算,不加計價差 —— 出發前換好的現金,成本在換鈔當下就固定了。
          在當地才換的話可以自己填價差。
        </template>
      </p>

      <!-- 國外交易手續費 / 換鈔價差。有預設值,但一定要能改 —— 每張卡都不一樣 -->
      <div v-if="isForeign">
        <div class="flex items-baseline justify-between gap-2">
          <span class="label">
            {{ paymentMethod === 'card' ? '國外交易手續費' : '換匯價差' }}
          </span>
          <button
            v-if="markupPct !== markupDefault"
            type="button" class="text-xs" style="color: var(--brand)"
            @click="resetMarkup">
            回到預設 {{ markupDefault }}%
          </button>
        </div>
        <div class="markup-cell">
          <input
            v-model.number="markupInput"
            class="cell-input tnum" type="number" step="0.1" min="0" max="100"
            inputmode="decimal" :placeholder="String(markupDefault)"
            :aria-label="paymentMethod === 'card' ? '國外交易手續費百分比' : '換匯價差百分比'"
            @input="markupTouched = true" />
          <span class="cur">%</span>
        </div>
        <p class="mt-1.5 text-xs leading-relaxed" style="color: var(--text-muted)">
          {{ markupHint }}
          <template v-if="paymentMethod === 'card' && !markupTouched">
            台灣的 Visa / Mastercard / JCB 多為 1.5%(AmEx 約 2%),你的卡不同的話直接改。
          </template>
          <template v-else-if="paymentMethod === 'cash' && !markupTouched">
            在當地 ATM 提領或臨櫃換鈔才有價差,那種情況填進來。
          </template>
        </p>
      </div>

      <UiAppField v-model="category" label="分類" placeholder="餐飲 / 交通 / 購物(選填)" />
    </div>

    <!-- ── 公費:一鍵套用「公費付錢、全員均分」 ── -->
    <div v-if="kind === 'shared' && pot" class="card p-4">
      <button type="button" class="flex w-full items-center gap-3 text-left" @click="fromPot = !fromPot">
        <span class="pot-box" :class="{ 'is-on': fromPot }">
          <Icon v-if="fromPot" name="lucide:check" size="14" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-semibold">這筆從{{ pot.name }}付</span>
          <span class="block text-xs" style="color: var(--text-muted)">
            付款人設為{{ pot.name }},並由 {{ people.length }} 位成員均分。
          </span>
        </span>
      </button>
      <p v-if="fromPot" class="mt-3 flex items-start gap-1.5 text-xs leading-relaxed"
         style="color: var(--text-muted)">
        <Icon name="lucide:info" size="14" class="mt-px shrink-0" />
        <span>
          付款人與分攤已鎖定。{{ pot.name }}本身不分攤 ——
          它是出錢的一方,剩多少會在「總覽」算出來。
        </span>
      </p>
    </div>

    <ExpensePayerEditor
      v-if="!fromPot"
      v-model="payers" :members="payerChoices" :currency="currency"
      :amount-minor="amountMinor" :summary="payerSummary" />

    <ExpenseSplitEditor
      v-if="kind === 'shared' && !fromPot"
      v-model="split" :members="people" :currency="currency"
      :amount-minor="amountMinor" :preview="splitPreview"
      :sum-minor="splitSumMinor" :diff-minor="splitDiffMinor" />

    <div v-else-if="kind === 'personal'" class="card p-4 text-sm" style="color: var(--text-muted)">
      <Icon name="lucide:user" class="inline mr-1.5" />
      個人花費不分攤,全額算在付款人自己頭上。
    </div>

    <!-- 公費模式:不給編輯,但要看得到結果,不然是黑箱 -->
    <div v-else-if="fromPot" class="card p-4">
      <h2 class="text-sm font-semibold">每人分攤</h2>
      <ul class="mt-2 space-y-1">
        <li v-for="m in people" :key="m.id" class="flex items-center justify-between gap-3 text-sm">
          <span class="truncate">{{ m.name }}</span>
          <UiMoney :minor="splitPreview[m.id] ?? 0" :currency="currency" size="sm" />
        </li>
      </ul>
    </div>

    <!-- 進階:匯率覆寫。收合起來,因為多數時候不需要 -->
    <div v-if="isForeign" class="card p-4">
      <button type="button" class="w-full flex items-center justify-between text-sm font-medium"
              @click="showAdvanced = !showAdvanced">
        <span>進階:自訂匯率</span>
        <Icon :name="showAdvanced ? 'lucide:chevron-up' : 'lucide:chevron-down'" />
      </button>
      <div v-if="showAdvanced" class="mt-3 space-y-2">
        <UiAppField
          v-model.number="fxOverride" type="number" step="0.000001"
          :label="`1 ${currency} = ? ${baseCurrency}`" placeholder="留空則用當日匯率" />
        <p class="text-xs" style="color: var(--text-muted)">
          收到信用卡帳單後,可以用帳單上的實際匯率回填,這筆的換算金額就會精準。
        </p>
      </div>
    </div>

    <UiAppField v-model="note" label="備註" type="textarea" placeholder="選填" />

    <!-- 差額要在送出前就講明白,不要讓 server 的 400 來打臉 -->
    <div v-if="problems.length" class="card p-3 text-sm" style="border-color: var(--warn)">
      <div v-for="p in problems" :key="p" class="flex items-center gap-2" style="color: var(--warn)">
        <Icon name="lucide:alert-circle" class="shrink-0" /> {{ p }}
      </div>
    </div>
    <div v-if="errorMessage" class="card p-3 text-sm" style="border-color: var(--debit); color: var(--debit)">
      {{ errorMessage }}
    </div>

    <!--
      手機上黏在底部,拇指可及。
      漸層底色預設是頁面底色,但這張表單也會被放進 UiAppSheet(編輯支出),
      那裡的底是 --bg-elevated —— 深色模式下兩者差得出來,會露出一條色帶。
      所以留一個 --form-sticky-bg 讓容器覆寫,而不是在這裡寫死。
    -->
    <div class="sticky bottom-0 pt-2 pb-1"
         style="background: linear-gradient(to top, var(--form-sticky-bg, var(--bg)) 60%, transparent)">
      <UiAppButton type="submit" variant="primary" block :disabled="!canSubmit" :loading="submitting">
        <Icon name="lucide:check" /> {{ submitText }}
      </UiAppButton>
    </div>
  </form>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換。 */

/* 百分比輸入框:外觀對齊 SplitEditor 的列內數字欄,單位放在框內 */
.markup-cell {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  width: 7rem;
  min-height: 44px;
  padding-inline: 0.625rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-elevated);
  transition: border-color 0.15s ease;
}
.markup-cell:focus-within {
  border-color: var(--brand);
}
.markup-cell .cur {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.markup-cell .cell-input {
  flex: 1 1 0;
  min-width: 0;
  background: transparent;
  border: 0;
  outline: none;
  text-align: right;
  font-size: 0.9375rem;
  color: var(--text);
  -moz-appearance: textfield;
  appearance: textfield;
}
.markup-cell .cell-input::-webkit-outer-spin-button,
.markup-cell .cell-input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}

.pot-box {
  display: grid;
  place-items: center;
  width: 1.375rem;
  height: 1.375rem;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-elevated);
  color: var(--brand-text);
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.pot-box.is-on {
  border-color: transparent;
  background: var(--brand);
}

@media (prefers-reduced-motion: reduce) {
  .markup-cell,
  .pot-box {
    transition: none;
  }
}
</style>
