<script setup lang="ts">
/**
 * 總覽 —— 一頁看完這趟的全貌。
 *
 * 三塊,由上而下就是「我最想知道什麼」的順序:
 *  1. 公費還剩多少、誰出了多少（沒設公費就不顯示這塊）
 *  2. 這趟總共花了多少（逐幣別 + 換算本位幣的估算）
 *  3. 每人合計與淨額（誰墊得多、誰還要付）
 *
 * 逐幣別分開這件事在這頁同樣不能妥協:日幣和台幣不相加。
 * 只有「換算本位幣」那一欄是估算的參考值,而且必須標明。
 */
import type { Balance, Expense, Kind } from '~~/shared/types';
import { CURRENCY_LABEL, EXPONENT, formatMoney, fromMinor, toMinor } from '~~/shared/money';
import { splitEqually } from '~~/shared/split';

const tripId = useTripId();
const api = useApi();
const { trip, members, pot, people, memberName } = useTrip(tripId);

const baseCurrency = computed(() => trip.value?.base_currency ?? 'TWD');
const pageTitle = computed(() => (trip.value?.name ? `${trip.value.name} — 總覽` : '總覽'));
useHead({ title: pageTitle });

// ── 資料 ────────────────────────────────────────────────────
// 和支出頁共用同一組 useAsyncData key,切頁不會重抓
function useExpenses(kind: Kind) {
  return useAsyncData<Expense[]>(
    () => `expenses:${tripId.value}:${kind}`,
    () => api.get<Expense[]>(`/api/trips/${encodeURIComponent(tripId.value)}/expenses`, { kind }),
    { default: () => [], deep: false, dedupe: 'defer' },
  );
}
const sharedTrack = useExpenses('shared');
const personalTrack = useExpenses('personal');

const balanceState = useAsyncData<Balance | null>(
  () => `balance:${tripId.value}`,
  () => api.get<Balance>(`/api/trips/${encodeURIComponent(tripId.value)}/balance`),
  { default: () => null, deep: false, dedupe: 'defer' },
);

const balance = computed(() => balanceState.data.value);
const potInfo = computed(() => balance.value?.pot ?? null);

const loading = computed(() =>
  balanceState.status.value === 'pending' && !balance.value);
// 三個請求都要看。只看 balance 的話,/expenses 掛掉時畫面會顯示
// 「還沒有任何花費」蓋在一趟其實有花費的旅程上 —— 那是靜靜說謊。
const errorMessage = computed(() => {
  for (const e of [balanceState.error.value, sharedTrack.error.value, personalTrack.error.value]) {
    if (e && !isAbortError(e)) return api.errorMessage(e);
  }
  return null;
});

async function refreshAll() {
  await Promise.all([
    balanceState.refresh({ dedupe: 'cancel' }),
    sharedTrack.refresh({ dedupe: 'cancel' }),
    personalTrack.refresh({ dedupe: 'cancel' }),
  ]);
}

// ── 這趟總花費（逐幣別）────────────────────────────────────────
interface CurrencyTotal { currency: string; sharedMinor: number; personalMinor: number; count: number }

const totals = computed<CurrencyTotal[]>(() => {
  const map = new Map<string, CurrencyTotal>();
  const add = (list: Expense[], key: 'sharedMinor' | 'personalMinor') => {
    for (const e of list) {
      const row = map.get(e.currency)
        ?? { currency: e.currency, sharedMinor: 0, personalMinor: 0, count: 0 };
      row[key] += e.amount_minor;
      row.count += 1;
      map.set(e.currency, row);
    }
  };
  add(sharedTrack.data.value ?? [], 'sharedMinor');
  add(personalTrack.data.value ?? [], 'personalMinor');
  // 本位幣優先,其餘按代碼 —— 不用金額排,跨幣別比大小沒有意義
  return [...map.values()].sort((a, b) => {
    if (a.currency === b.currency) return 0;
    if (a.currency === baseCurrency.value) return -1;
    if (b.currency === baseCurrency.value) return 1;
    return a.currency.localeCompare(b.currency);
  });
});

const hasExpenses = computed(() => totals.value.length > 0);

// ── 每人合計 ────────────────────────────────────────────────
const ZERO = { sharedOwedBase: 0, personalBase: 0, totalBase: 0, unconverted: 0 };

const memberStats = computed(() => {
  const perMember = balance.value?.per_member ?? {};
  // 公費不是人,它的「合計花費」沒有意義(它付的錢已經分攤給人了),所以不列進來
  return people.value
    .map(m => ({ id: m.id, name: m.name, ...(perMember[m.id] ?? ZERO) }))
    .sort((a, b) => b.totalBase - a.totalBase);
});

const tripTotalBase = computed(() => memberStats.value.reduce((s, r) => s + r.totalBase, 0));
const unconvertedCount = computed(() => memberStats.value.reduce((s, r) => s + r.unconverted, 0));

/** 每人的淨額(逐幣別)—— 誰還要付、誰還能收 */
const netsByMember = computed(() => {
  const out = new Map<string, Array<{ currency: string; netMinor: number }>>();
  for (const [cur, block] of Object.entries(balance.value?.by_currency ?? {})) {
    for (const n of block.nets) {
      const list = out.get(n.memberId) ?? [];
      list.push({ currency: cur, netMinor: n.netMinor });
      out.set(n.memberId, list);
    }
  }
  return out;
});

// ── 投入 / 退還公費 ──────────────────────────────────────────
/**
 * 「投入公費」在資料上就是一筆 settlement:某人 → 公費。
 * 用 settlements 而不是新開一張表是刻意的 —— 那就是「錢從 A 移到 B」,
 * 和還款是同一件事,結算引擎已經正確處理了它對淨額的影響。
 *
 * ── UI 的關鍵決定:勾人,金額只填一次 ──────────────────────
 *
 * 投入公費**天生是集體行為**:「今天大家說好各拿 5,000 出來」是一個決定,
 * 不是 N 個決定。所以介面是「勾選誰參與 + 填一次金額」,
 * 而不是每個人開一次對話框填一次(兩個人就要開兩次,四個人四次)。
 *
 * 但資料模型仍然是逐人一筆金額 —— 因為「每人一樣」是常見情況而不是規則
 * (有人先墊多一點、有人身上剛好沒零錢)。所以留一個「自訂金額」的開關,
 * 打開後可以逐人微調。常見情況一次搞定,例外情況也表達得出來。
 */
const potSheetOpen = ref(false);
const potDirection = ref<'in' | 'out'>('in');
const potCurrency = ref('JPY');
/** 共用金額(人類單位)。切到自訂金額時當成各人的預設值。 */
const potAmount = ref<number | null>(null);
/** 勾選的成員 id */
const potPicked = ref<string[]>([]);
/** 打開後可以逐人微調 */
const potPerPerson = ref(false);
/** 成員 id -> 人類單位金額(只有 potPerPerson 時才用) */
const potAmounts = ref<Record<string, number | null>>({});
const potSaving = ref(false);
const potError = ref('');

const CURRENCIES = ['JPY', 'TWD'];

/** 輸入框的 step。日幣沒有輔幣,給 0.01 會讓瀏覽器允許打出 0.5 圓這種不存在的金額。 */
function stepFor(currency: string): string {
  return (EXPONENT[currency] ?? 2) === 0 ? '1' : '0.01';
}
const potStep = computed(() => stepFor(potCurrency.value));
function toMinorPot(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return toMinor(v, potCurrency.value);
}

function openPotSheet(direction: 'in' | 'out') {
  potDirection.value = direction;
  potCurrency.value = 'JPY';
  potAmount.value = null;
  // 預設全選 —— 投入公費幾乎都是全體一起,少數不參與的再取消勾選比較快
  potPicked.value = people.value.map(m => m.id);
  potPerPerson.value = false;
  potAmounts.value = {};
  potError.value = '';
  potSheetOpen.value = true;
}

const potPickedSet = computed(() => new Set(potPicked.value));
const isPicked = (id: string) => potPickedSet.value.has(id);

function togglePicked(id: string) {
  potPicked.value = isPicked(id)
    ? potPicked.value.filter(x => x !== id)
    : [...potPicked.value, id];
}
function pickAll() { potPicked.value = people.value.map(m => m.id); }
function pickNone() { potPicked.value = []; }

/**
 * 切到逐人模式時,把共用金額帶進每個人 —— 從零開始填太慢。
 *
 * 刻意做成一個明確的函式,而不是 watch(potPerPerson):下面的「平分」也要打開
 * 這個開關,但它自己已經把每個人的金額算好了。watch 是延後才跑的,
 * 會在平分寫完之後才把共用金額蓋回去,平分的結果就這樣無聲消失。
 */
function seedPerPersonFromShared() {
  const next: Record<string, number | null> = {};
  for (const m of people.value) next[m.id] = potAmount.value;
  potAmounts.value = next;
}
function togglePerPerson() {
  if (!potPerPerson.value) seedPerPersonFromShared();
  potPerPerson.value = !potPerPerson.value;
}

/**
 * 兩個金額欄位**互斥**:勾了「自訂金額」就只認下面每個人的欄位,
 * 沒勾就只認上面那個共用的。畫面上停用的那一個一定不參與計算。
 *
 * 舊版在逐人模式下會 fallback 回共用金額(還沒個別改過的人跟著上面走)。
 * 拿掉的理由:那讓一個**畫面上已經停用**的欄位繼續在背後決定金額 ——
 * 使用者看到的和送出去的不是同一件事,而「為什麼這個人是 5,000」
 * 在畫面上完全找不到出處。
 *
 * 舊註解擔心的是「先打開開關、共用欄位還是空的」會變成一個算不出總額
 * 又不解釋的死畫面。現在那條路徑是這樣講清楚的:
 *  1. 上面的欄位真的 disabled 並在 hint 說明金額改到下面填(不是壞掉);
 *  2. 下面每個人的欄位在逐人模式下是唯一可以打字的地方,而且長得像可輸入的;
 *  3. 全部都空的時候,問題區直接說「金額欄位換到下面了,請逐人填」,
 *     而不是列出一長串名字的「還沒填金額」。
 */
function amountOf(id: string): number | null {
  if (!potPerPerson.value) return potAmount.value;
  return potAmounts.value[id] ?? null;
}
function setAmountOf(id: string, v: number | null) {
  potAmounts.value = { ...potAmounts.value, [id]: v };
}

// ── 退還:平分剩餘 ───────────────────────────────────────────
/** 目前幣別的公費剩餘 —— 「平分」要分的就是這個數字。 */
const potRemainingMinor = computed(() => remainingOf(potCurrency.value));

/** 不能平分的原因。有值就 disabled,而且要把原因講出來。 */
const splitBlockedReason = computed<string>(() => {
  const label = CURRENCY_LABEL[potCurrency.value] ?? potCurrency.value;
  if (potRemainingMinor.value < 0) return `${label}的公費是超支的,沒有現金可以退還。`;
  if (potRemainingMinor.value === 0) return `${label}的公費剩餘是 0,沒有東西可以分。`;
  if (!potPicked.value.length) return '先勾選要退給誰,才知道這筆要分給幾個人。';
  return '';
});

/**
 * 把剩餘平分給勾選的人。旅程結束把剩下的現金分回去,最常見的就是這個動作。
 *
 * 一定要用 shared/split.ts 的 splitEqually():它用最大餘數法,保證
 * sum(每個人) **精確等於**剩餘。自己寫除法的話 JP¥67,885 分給 2 個人會變成
 * 33,942 × 2 = 67,884,少的那 1 圓會永遠卡在公費裡,剩餘再也歸不了零。
 *
 * 順手打開「自訂金額」—— 有餘數時每個人的數字本來就不一樣(33,943 / 33,942),
 * 一個共用欄位表達不出來。
 */
function splitRemainingEqually() {
  if (splitBlockedReason.value) return;
  const shares = splitEqually(potRemainingMinor.value, potPicked.value);
  const next: Record<string, number | null> = {};
  // 沒勾的人要清成 null,否則上一次平分的殘值會在重新勾選他之後突然冒出來
  for (const m of people.value) next[m.id] = null;
  for (const [id, minor] of shares) next[id] = fromMinor(minor, potCurrency.value);
  potAmounts.value = next;
  potPerPerson.value = true;

  /*
    分不到錢的人要取消勾選,不能留著一個 0。
    剩餘比人數還少的時候會走到這裡(JP¥1 分給 3 個人 = 1 / 0 / 0),
    而勾選的語意是「這個人會拿到錢」—— 留著 0 的話那兩個人既在名單上、
    金額又是 0,potMissing 會把他們當成「還沒填金額」,於是畫面一邊顯示著 0、
    一邊說你沒填,而且「記下來」是鎖住的,使用者完全不知道該做什麼。
    (退還 0 元本來就不該寫成一筆金流,server 端也會擋。)
  */
  potPicked.value = potPicked.value.filter(id => (shares.get(id) ?? 0) > 0);
}

/** 送給 API 的 entries。只含勾選、且金額 > 0 的人。 */
const potEntries = computed(() =>
  potPicked.value
    .map(id => ({ member_id: id, amount_minor: toMinorPot(amountOf(id)) }))
    .filter(e => e.amount_minor > 0));

const potTotalMinor = computed(() => potEntries.value.reduce((s, e) => s + e.amount_minor, 0));

/** 勾了人但金額沒填 —— 要講出來,不然使用者會以為按鈕壞了 */
const potMissing = computed(() =>
  potPicked.value.filter(id => toMinorPot(amountOf(id)) <= 0));

const potProblems = computed<string[]>(() => {
  const out: string[] = [];
  if (!potPicked.value.length) out.push('請至少勾選一個人');
  // 「先打開逐人開關、共用欄位還是空的」就是這條路徑。列出每一個人的名字
  // 在這裡沒有幫助 —— 要講的是「可以打字的欄位換到下面去了」。
  else if (potPerPerson.value && potMissing.value.length === potPicked.value.length) {
    out.push('已改成逐人填金額 —— 上面的共用欄位停用了,請在下面每個人自己的欄位填。');
  }
  else if (potMissing.value.length) {
    const names = potMissing.value.map(id => memberName(id)).join('、');
    out.push(`還沒填金額:${names}`);
  }
  return out;
});

const potCanSubmit = computed(() =>
  !!pot.value && potProblems.value.length === 0 && potEntries.value.length > 0 && !potSaving.value);

async function submitPot() {
  if (!potCanSubmit.value) return;
  potSaving.value = true;
  potError.value = '';
  try {
    // 一次寫完(server 用 dbh.batch)—— 不會出現「三個人裡寫進兩個」的半套狀態
    await api.post(`/api/trips/${encodeURIComponent(tripId.value)}/pot/moves`, {
      direction: potDirection.value,
      currency: potCurrency.value,
      entries: potEntries.value,
    });
    potSheetOpen.value = false;
    await refreshAll();
    // 紀錄展開著的話一起更新,不然剛記的那幾筆不在列表裡,看起來像沒寫進去
    if (movesOpen.value) await loadMoves();
  } catch (e) {
    potError.value = api.errorMessage(e);
  } finally {
    potSaving.value = false;
  }
}

// ── 逐筆金流:改金額 / 刪除 ──────────────────────────────────
/**
 * 為什麼要逐筆,而不是讓人改上面那個「誰投入的」合計:
 *
 * 那是**每人合計**。MIN 第一天投 5,000、第二天再投 5,000,合計顯示 10,000,
 * 這時候說「把它改成 8,000」是沒有指涉的 —— 要改哪一天那一筆? 所以修改一律
 * 以單筆為單位,而且列表要帶時間,人才分得出來是哪一筆。
 *
 * 在這之前唯一的更正手段是「記一筆反向的退還去沖銷」:剩餘會對,
 * 但帳面上留下兩筆從來沒發生過的金流 —— 數字對了,歷史是假的。
 */
interface PotMove {
  id: string;
  /** in = 人投入公費;out = 公費退還給人 */
  direction: 'in' | 'out';
  member_id: string;
  currency: string;
  amount_minor: number;
  settled_at: string;
  note: string | null;
}

const movesOpen = ref(false);
/** null = 還沒抓過 / 抓失敗(再展開一次會重抓);[] = 抓到了但沒有紀錄 */
const moves = ref<PotMove[] | null>(null);
const movesLoading = ref(false);
const movesError = ref('');

async function loadMoves() {
  movesLoading.value = true;
  movesError.value = '';
  try {
    const r = await api.get<{ moves: PotMove[] }>(
      `/api/trips/${encodeURIComponent(tripId.value)}/pot/moves`);
    moves.value = r?.moves ?? [];
  }
  catch (e) {
    if (isAbortError(e)) return;
    movesError.value = api.errorMessage(e);
    moves.value = null;
  }
  finally {
    movesLoading.value = false;
  }
}

function toggleMoves() {
  movesOpen.value = !movesOpen.value;
  cancelEdit();
  // 只在第一次展開時抓 —— 這頁進來就抓的話,多數人根本不會打開這一區
  if (movesOpen.value && moves.value == null && !movesLoading.value) void loadMoves();
}

/**
 * settled_at 來自 SQLite 的 datetime('now'):'2026-09-07 04:12:33'(UTC 但沒有 Z)。
 * 沒有時區標記時部分瀏覽器會當成當地時間,差 8 小時 —— 自己補上 Z。
 */
function moveTimeText(raw: string): string {
  if (!raw) return '';
  const t = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const iso = /([Zz]|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** 某幣別現在的公費剩餘。那個幣別還沒有任何金流時就是 0。 */
function remainingOf(currency: string): number {
  return potInfo.value?.by_currency.find(r => r.currency === currency)?.remainingMinor ?? 0;
}

/**
 * 把這一筆改成 nextMinor(刪除就是 0)之後,那個幣別的剩餘會變成多少。
 *
 * 確認文案一定要講得出這個數字 —— 「確定刪除?」沒有告訴使用者他會失去什麼,
 * 而公費的剩餘正是他唯一在乎的那個數。
 * 投入的一筆變小 → 剩餘跟著變小;退還的一筆變小 → 錢沒退出去,剩餘反而變大。
 */
function remainingAfter(m: PotMove, nextMinor: number): number {
  const delta = nextMinor - m.amount_minor;
  return remainingOf(m.currency) + (m.direction === 'in' ? delta : -delta);
}

const editingId = ref<string | null>(null);
/** 編輯中的金額(人類單位) */
const editAmount = ref<number | null>(null);
const moveSaving = ref(false);
/**
 * 單筆操作的錯誤。**409(改完剩餘會變負)的原文要原封不動顯示** ——
 * 那句話帶著數字,是使用者唯一能理解「為什麼被擋下來」的線索,
 * 換成「操作失敗」等於把它吞掉。
 */
const moveError = ref('');

const editing = computed<PotMove | null>(
  () => moves.value?.find(m => m.id === editingId.value) ?? null);

const editMinor = computed(() => {
  const m = editing.value;
  if (!m || editAmount.value == null || !Number.isFinite(editAmount.value)) return 0;
  return toMinor(editAmount.value, m.currency);
});

function startEdit(m: PotMove) {
  editingId.value = m.id;
  editAmount.value = fromMinor(m.amount_minor, m.currency);
  moveError.value = '';
}
function cancelEdit() {
  editingId.value = null;
  editAmount.value = null;
  moveError.value = '';
}

async function saveEdit() {
  const m = editing.value;
  if (!m || moveSaving.value) return;
  if (editMinor.value <= 0) {
    moveError.value = '金額要大於 0。想把這筆整個拿掉請用「刪除」。';
    return;
  }
  // 沒改就當成取消,不要為了同一個數字打一次 API
  if (editMinor.value === m.amount_minor) { cancelEdit(); return; }

  moveSaving.value = true;
  moveError.value = '';
  try {
    await api.patch(
      `/api/trips/${encodeURIComponent(tripId.value)}/pot/moves/${encodeURIComponent(m.id)}`,
      { amount_minor: editMinor.value });
    editingId.value = null;
    editAmount.value = null;
    // 兩邊都要重抓:列表是這一筆的新金額,balance 是上面那塊的剩餘
    await Promise.all([loadMoves(), refreshAll()]);
  }
  catch (e) {
    moveError.value = api.errorMessage(e);
  }
  finally {
    moveSaving.value = false;
  }
}

/** 刪除確認走 UiAppSheet,不用 window.confirm —— 那裡塞不進「剩餘會變成多少」。 */
const deleteTarget = ref<PotMove | null>(null);
const deletingMove = ref(false);
const deleteError = ref('');

function askDeleteMove(m: PotMove) {
  deleteTarget.value = m;
  deleteError.value = '';
}

async function confirmDeleteMove() {
  const m = deleteTarget.value;
  if (!m || deletingMove.value) return;
  deletingMove.value = true;
  deleteError.value = '';
  try {
    await api.del(
      `/api/trips/${encodeURIComponent(tripId.value)}/pot/moves/${encodeURIComponent(m.id)}`);
    deleteTarget.value = null;
    if (editingId.value === m.id) cancelEdit();
    await Promise.all([loadMoves(), refreshAll()]);
  }
  catch (e) {
    deleteError.value = api.errorMessage(e);
  }
  finally {
    deletingMove.value = false;
  }
}
</script>

<template>
  <div class="space-y-5 py-1 md:py-2">
    <div class="flex items-center gap-3">
      <h1 class="flex-1 text-xl font-bold">
        總覽
      </h1>
      <UiAppButton
        variant="ghost" class="shrink-0 px-3 text-xs"
        :loading="balanceState.status.value === 'pending' && !!balance"
        @click="refreshAll"
      >
        <Icon name="lucide:refresh-cw" size="14" /> 重新整理
      </UiAppButton>
    </div>

    <UiLoadingBlock v-if="loading" :rows="6" />

    <div v-else-if="errorMessage" class="card p-4">
      <p class="text-sm" style="color: var(--debit)">
        {{ errorMessage }}
      </p>
      <UiAppButton variant="ghost" class="mt-3" @click="refreshAll">
        再試一次
      </UiAppButton>
    </div>

    <template v-else>
      <!-- ── 公費 ── -->
      <section v-if="pot" class="card p-4">
        <div class="flex items-start gap-3">
          <span
            class="grid h-9 w-9 shrink-0 place-items-center rounded-full"
            style="background: color-mix(in oklab, var(--warn) 18%, transparent); color: var(--warn)"
          >
            <Icon name="lucide:piggy-bank" size="18" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="font-semibold">
              {{ pot.name }}
            </h2>
            <p class="mt-0.5 text-xs leading-relaxed" style="color: var(--text-muted)">
              剩餘 = 投入 − 公費付掉的 − 已退還。逐幣別分開算。
            </p>
          </div>
        </div>

        <!-- 還沒有任何金流 -->
        <div v-if="!potInfo?.by_currency.length" class="mt-3 rounded-xl px-3 py-3" style="background: var(--bg-sunken)">
          <p class="text-sm" style="color: var(--text-muted)">
            還沒有人投入公費。先記下每個人拿了多少錢出來,之後記帳時勾「這筆從{{ pot.name }}付」就會自動均分。
          </p>
        </div>

        <div v-for="row in potInfo?.by_currency ?? []" :key="row.currency" class="mt-3">
          <div class="rounded-xl px-3 py-3" style="background: var(--bg-sunken)">
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-xs font-semibold">
                {{ CURRENCY_LABEL[row.currency] ?? row.currency }}剩餘
              </span>
              <span class="text-lg font-bold tnum"
                    :style="{ color: row.remainingMinor < 0 ? 'var(--debit)' : 'var(--credit)' }">
                {{ formatMoney(row.remainingMinor, row.currency) }}
              </span>
            </div>

            <!-- 負數代表公費被超支:付出去的比收進來的多,有人先墊了 -->
            <p v-if="row.remainingMinor < 0" class="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed"
               style="color: var(--warn)">
              <Icon name="lucide:circle-alert" size="14" class="mt-px shrink-0" />
              <span>公費超支 —— 付出去的比投入的多,差額實際上是由付款的人先墊著。</span>
            </p>

            <dl class="mt-2.5 grid grid-cols-3 gap-2 text-center">
              <div>
                <dt class="text-[0.6875rem]" style="color: var(--text-muted)">投入</dt>
                <dd class="tnum text-sm">{{ formatMoney(row.contributedMinor, row.currency) }}</dd>
              </div>
              <div>
                <dt class="text-[0.6875rem]" style="color: var(--text-muted)">已支出</dt>
                <dd class="tnum text-sm">{{ formatMoney(row.spentMinor, row.currency) }}</dd>
              </div>
              <div>
                <dt class="text-[0.6875rem]" style="color: var(--text-muted)">已退還</dt>
                <dd class="tnum text-sm">{{ formatMoney(row.refundedMinor, row.currency) }}</dd>
              </div>
            </dl>
          </div>

          <!-- 誰拿多少錢出來 —— 這是使用者明確要看到的東西 -->
          <div v-if="row.contributions.length" class="mt-2">
            <h3 class="px-1 text-[0.6875rem] font-semibold" style="color: var(--text-muted)">
              誰投入的
            </h3>
            <ul class="mt-1 divide-y" style="border-color: var(--border)">
              <li v-for="c in row.contributions" :key="c.memberId"
                  class="flex items-center justify-between gap-3 py-2">
                <span class="min-w-0 flex-1 truncate text-sm">{{ memberName(c.memberId) }}</span>
                <UiMoney :minor="c.amountMinor" :currency="row.currency" size="sm" />
              </li>
            </ul>
          </div>

          <div v-if="row.refunds.length" class="mt-2">
            <h3 class="px-1 text-[0.6875rem] font-semibold" style="color: var(--text-muted)">
              已退還給
            </h3>
            <ul class="mt-1 divide-y" style="border-color: var(--border)">
              <li v-for="r in row.refunds" :key="r.memberId"
                  class="flex items-center justify-between gap-3 py-2">
                <span class="min-w-0 flex-1 truncate text-sm">{{ memberName(r.memberId) }}</span>
                <UiMoney :minor="r.amountMinor" :currency="row.currency" size="sm" />
              </li>
            </ul>
          </div>
        </div>

        <!--
          ── 逐筆金流 ──
          上面那兩份是**每人合計**,合計沒辦法指認「是哪一天那一筆」,
          所以改錯 / 刪掉一律從這裡進去。摘要留著,這只是多一層可展開的細節。
        -->
        <div v-if="potInfo?.by_currency.length" class="mt-3">
          <button
            type="button" class="moves-toggle"
            :aria-expanded="movesOpen"
            @click="toggleMoves"
          >
            <Icon name="lucide:receipt-text" size="15" class="shrink-0" style="color: var(--text-muted)" />
            <span class="min-w-0 flex-1 text-left text-sm font-medium">金流紀錄</span>
            <span class="shrink-0 text-xs" style="color: var(--text-muted)">記錯了可以改或刪</span>
            <Icon
              :name="movesOpen ? 'lucide:chevron-up' : 'lucide:chevron-down'"
              size="16" class="shrink-0" style="color: var(--text-muted)"
            />
          </button>

          <div v-if="movesOpen" class="card mt-2 overflow-hidden">
            <div class="row-head px-3 py-2 text-[0.6875rem] leading-relaxed" style="color: var(--text-muted)">
              逐筆列出,新的在最上面。改金額或刪除都只動被指定的那一筆。
            </div>

            <UiLoadingBlock v-if="movesLoading && moves == null" :rows="3" variant="plain" class="p-3" />

            <div v-else-if="movesError" class="p-3">
              <p class="text-sm leading-relaxed" style="color: var(--debit)">
                {{ movesError }}
              </p>
              <UiAppButton variant="ghost" class="mt-2" :loading="movesLoading" @click="loadMoves">
                再試一次
              </UiAppButton>
            </div>

            <p v-else-if="!moves?.length" class="p-3 text-sm leading-relaxed" style="color: var(--text-muted)">
              還沒有任何公費金流。
            </p>

            <div v-else class="divided">
              <div v-for="m in moves" :key="m.id" class="px-3 py-2.5">
                <div class="flex items-center gap-2">
                  <span
                    class="move-dir"
                    :style="m.direction === 'in'
                      ? { background: 'color-mix(in oklab, var(--credit) 15%, transparent)', color: 'var(--credit)' }
                      : { background: 'color-mix(in oklab, var(--warn) 18%, transparent)', color: 'var(--warn)' }"
                  >
                    {{ m.direction === 'in' ? '投入' : '退還' }}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-sm">{{ memberName(m.member_id) }}</span>

                  <div v-if="editingId === m.id" class="pick-amount">
                    <input
                      class="cell-input tnum" type="number" :step="stepFor(m.currency)"
                      min="0" inputmode="decimal" placeholder="0"
                      :value="editAmount ?? ''"
                      :aria-label="`${memberName(m.member_id)} 這筆的金額`"
                      @input="editAmount = ($event.target as HTMLInputElement).value === ''
                        ? null : Number(($event.target as HTMLInputElement).value)"
                    >
                  </div>
                  <UiMoney v-else :minor="m.amount_minor" :currency="m.currency" size="sm" />
                </div>

                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem]"
                     style="color: var(--text-muted)">
                  <span class="tnum shrink-0">{{ moveTimeText(m.settled_at) }}</span>
                  <span class="shrink-0">{{ CURRENCY_LABEL[m.currency] ?? m.currency }}</span>
                  <span v-if="m.note" class="min-w-0 truncate">{{ m.note }}</span>
                  <span class="flex-1" />
                  <!-- 兩顆動作綁成一組:窄版換行時要一起換,不能「刪除」自己掉到下一行 -->
                  <span class="flex shrink-0 items-center gap-1">
                    <template v-if="editingId === m.id">
                      <button type="button" class="link-btn" :disabled="moveSaving" @click="cancelEdit">
                        取消
                      </button>
                      <button type="button" class="link-btn" :disabled="moveSaving" @click="saveEdit">
                        <Icon v-if="moveSaving" name="lucide:loader-circle" size="13" class="animate-spin" />
                        <Icon v-else name="lucide:check" size="13" />
                        儲存
                      </button>
                    </template>
                    <template v-else>
                      <button type="button" class="link-btn" @click="startEdit(m)">
                        <Icon name="lucide:pencil" size="13" /> 改金額
                      </button>
                      <button type="button" class="link-btn link-danger" @click="askDeleteMove(m)">
                        <Icon name="lucide:trash-2" size="13" /> 刪除
                      </button>
                    </template>
                  </span>
                </div>

                <!-- 改完剩餘會變成多少 —— 送出前的人眼檢查,和刪除確認講的是同一件事 -->
                <p v-if="editingId === m.id" class="mt-1.5 text-[0.6875rem] leading-relaxed"
                   style="color: var(--text-muted)">
                  <template v-if="editMinor > 0">
                    改成 {{ formatMoney(editMinor, m.currency) }} 之後,{{ CURRENCY_LABEL[m.currency] ?? m.currency }}剩餘會從
                    <span class="tnum">{{ formatMoney(remainingOf(m.currency), m.currency) }}</span>
                    變成
                    <span
                      class="tnum font-semibold"
                      :style="{ color: remainingAfter(m, editMinor) < 0 ? 'var(--warn)' : 'var(--text)' }"
                    >{{ formatMoney(remainingAfter(m, editMinor), m.currency) }}</span>。
                  </template>
                  <template v-else>
                    金額要大於 0。想把這筆整個拿掉請用「刪除」。
                  </template>
                </p>
                <p v-if="editingId === m.id && moveError" class="mt-1.5 text-xs leading-relaxed"
                   role="alert" style="color: var(--debit)">
                  {{ moveError }}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div class="mt-3 flex gap-2">
          <UiAppButton variant="primary" block :disabled="!people.length" @click="openPotSheet('in')">
            <Icon name="lucide:plus" /> 投入公費
          </UiAppButton>
          <UiAppButton
            variant="ghost" block
            :disabled="!people.length || !potInfo?.by_currency.length"
            @click="openPotSheet('out')"
          >
            <Icon name="lucide:corner-down-left" /> 退還
          </UiAppButton>
        </div>
        <p v-if="!people.length" class="mt-2 text-xs" style="color: var(--warn)">
          這趟只有公費、沒有其他成員,先去「成員」加人。
        </p>
      </section>

      <!-- 沒設公費時給一個入口,不然使用者不知道有這功能 -->
      <section v-else class="card p-4">
        <h2 class="flex items-center gap-2 font-semibold">
          <Icon name="lucide:piggy-bank" size="18" style="color: var(--text-muted)" />
          還沒有設公費
        </h2>
        <p class="mt-1 text-sm leading-relaxed" style="color: var(--text-muted)">
          大家先各拿一筆錢出來放公費、吃飯門票直接從公費付的話,在「成員」頁建立公費,
          之後記帳勾一下就會自動均分,這裡也會算出還剩多少、誰出了多少。
        </p>
        <UiAppButton variant="ghost" class="mt-3" :to="`/t/${tripId}/members`">
          <Icon name="lucide:users" /> 去建立公費
        </UiAppButton>
      </section>

      <!-- ── 這趟總花費 ── -->
      <section class="card p-4">
        <h2 class="font-semibold">
          這趟總花費
        </h2>

        <UiEmptyState
          v-if="!hasExpenses"
          dense
          icon="lucide:receipt"
          title="還沒有任何花費"
          description="記第一筆之後,這裡會逐幣別列出共同與個人的合計。"
        >
          <UiAppButton :to="`/t/${tripId}/new`" icon="lucide:plus">
            記一筆
          </UiAppButton>
        </UiEmptyState>

        <template v-else>
          <div class="mt-2 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-[0.6875rem]" style="color: var(--text-muted)">
                  <th class="py-1.5 pr-2 font-semibold">幣別</th>
                  <th class="py-1.5 px-2 text-right font-semibold">共同</th>
                  <th class="py-1.5 px-2 text-right font-semibold">個人</th>
                  <th class="py-1.5 pl-2 text-right font-semibold">合計</th>
                </tr>
              </thead>
              <tbody class="divide-y" style="border-color: var(--border)">
                <tr v-for="row in totals" :key="row.currency">
                  <td class="py-2 pr-2">{{ CURRENCY_LABEL[row.currency] ?? row.currency }}</td>
                  <td class="tnum py-2 px-2 text-right">{{ formatMoney(row.sharedMinor, row.currency) }}</td>
                  <td class="tnum py-2 px-2 text-right">{{ formatMoney(row.personalMinor, row.currency) }}</td>
                  <td class="tnum py-2 pl-2 text-right font-semibold">
                    {{ formatMoney(row.sharedMinor + row.personalMinor, row.currency) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-xs leading-relaxed" style="color: var(--text-muted)">
            每個幣別各自一列,不相加 —— 日幣和台幣加在一起的數字沒有意義。
          </p>

          <div class="mt-3 flex items-baseline justify-between gap-3 rounded-xl px-3 py-2.5"
               style="background: var(--bg-sunken)">
            <span class="text-xs" style="color: var(--text-muted)">
              換算{{ CURRENCY_LABEL[baseCurrency] ?? baseCurrency }}(估算)
            </span>
            <span class="tnum text-base font-bold">{{ formatMoney(tripTotalBase, baseCurrency) }}</span>
          </div>
          <p v-if="unconvertedCount" class="mt-1.5 text-xs" style="color: var(--warn)">
            有 {{ unconvertedCount }} 筆沒有匯率可用,沒被算進換算金額裡。
          </p>
        </template>
      </section>

      <!-- ── 每人合計 ── -->
      <section v-if="memberStats.length" class="card p-4">
        <h2 class="font-semibold">
          每人合計
        </h2>
        <p class="mt-0.5 text-xs leading-relaxed" style="color: var(--text-muted)">
          共同分攤 + 個人花費 = 這個人這趟總共花了多少(換算{{ CURRENCY_LABEL[baseCurrency] ?? baseCurrency }},估算值)。
        </p>

        <ul class="mt-2 divide-y" style="border-color: var(--border)">
          <li v-for="m in memberStats" :key="m.id" class="py-2.5">
            <div class="flex items-center gap-3">
              <span
                class="grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-semibold"
                style="background: color-mix(in oklab, var(--brand) 15%, transparent); color: var(--brand)"
              >
                {{ m.name.slice(0, 1) }}
              </span>
              <span class="min-w-0 flex-1 truncate font-medium">{{ m.name }}</span>
              <UiMoney :minor="m.totalBase" :currency="baseCurrency" />
            </div>
            <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 pl-11 text-[0.6875rem]"
                 style="color: var(--text-muted)">
              <span class="tnum">共同 {{ formatMoney(m.sharedOwedBase, baseCurrency) }}</span>
              <span class="tnum">個人 {{ formatMoney(m.personalBase, baseCurrency) }}</span>
              <span
                v-for="n in netsByMember.get(m.id) ?? []" :key="n.currency"
                class="tnum"
                :style="{ color: n.netMinor < 0 ? 'var(--debit)' : 'var(--credit)' }"
              >
                {{ n.netMinor < 0 ? '還要付' : '可收回' }}
                {{ formatMoney(Math.abs(n.netMinor), n.currency) }}
              </span>
            </div>
          </li>
        </ul>

        <UiAppButton variant="ghost" class="mt-3" :to="`/t/${tripId}/settle`">
          <Icon name="lucide:scale" /> 看誰要給誰多少
        </UiAppButton>
      </section>

      <p v-if="balance?.disclaimer" class="px-1 text-[0.6875rem] leading-relaxed"
         style="color: var(--text-muted)">
        {{ balance.disclaimer }}<br>
        {{ balance.rate_attribution }}
      </p>
    </template>

    <!-- ── 投入 / 退還公費 ── -->
    <UiAppSheet
      v-model:open="potSheetOpen"
      :title="potDirection === 'in' ? `投入${pot?.name ?? '公費'}` : `${pot?.name ?? '公費'}退還`"
      :dismissible="!potSaving"
    >
      <div class="space-y-4">
        <p class="text-sm leading-relaxed" style="color: var(--text-muted)">
          <template v-if="potDirection === 'in'">
            大家說好各拿多少出來 —— 勾選參與的人,金額只要填一次。
          </template>
          <template v-else>
            公費退還 —— 勾選要退給誰,金額只要填一次。旅程結束把剩下的現金分回去時用。
          </template>
        </p>

        <!--
          幣別 + 共用金額。金額填一次,套用到所有勾選的人。
          打開「自訂金額」之後這個欄位會停用 —— 兩個金額欄位任何時候
          只有一個是活的,停用的那個不參與計算(見 amountOf 的說明)。
        -->
        <div class="grid grid-cols-2 gap-3">
          <UiAppField
            v-model="potCurrency" label="幣別" type="select"
            :options="CURRENCIES.map(c => ({ value: c, label: `${CURRENCY_LABEL[c] ?? c} (${c})` }))"
          />
          <UiAppField
            v-model.number="potAmount"
            :label="potPerPerson ? '每人金額(停用中)' : '每人金額'"
            type="number" :step="potStep" inputmode="decimal" placeholder="0"
            :disabled="potPerPerson"
            :hint="potPerPerson ? '金額改到下面每個人自己的欄位填' : undefined"
          />
        </div>

        <!-- 勾選參與的人 -->
        <div>
          <div class="mb-1.5 flex items-center gap-2">
            <span class="label mb-0 flex-1">
              {{ potDirection === 'in' ? '誰拿錢出來' : '退還給誰' }}
            </span>
            <button type="button" class="link-btn" @click="pickAll">
              全選
            </button>
            <button type="button" class="link-btn" @click="pickNone">
              全不選
            </button>
          </div>

          <div class="space-y-1.5">
            <div
              v-for="m in people" :key="m.id"
              class="pick-row" :class="{ 'is-on': isPicked(m.id) }"
            >
              <button
                type="button" class="pick-toggle"
                :aria-pressed="isPicked(m.id)"
                @click="togglePicked(m.id)"
              >
                <span class="pick-box" :class="{ 'is-on': isPicked(m.id) }">
                  <Icon v-if="isPicked(m.id)" name="lucide:check" size="14" />
                </span>
                <span class="truncate">{{ m.name }}</span>
              </button>

              <!--
                每個人的金額欄一直在,只是共用模式下停用 —— 它那時顯示的是
                上面那個共用金額(他會被記多少,不用心算)。
                欄位不隨模式消失才看得出來:開關切的是「哪一邊可以打字」。
              -->
              <div v-if="isPicked(m.id)" class="pick-amount" :class="{ 'is-off': !potPerPerson }">
                <input
                  class="cell-input tnum" type="number" :step="potStep"
                  min="0" inputmode="decimal" placeholder="0"
                  :value="amountOf(m.id) ?? ''"
                  :disabled="!potPerPerson"
                  :aria-label="`${m.name} 的金額`"
                  @input="setAmountOf(m.id, ($event.target as HTMLInputElement).value === ''
                    ? null : Number(($event.target as HTMLInputElement).value))"
                >
              </div>
            </div>
          </div>

          <!--
            平分只在退還時出現 —— 投入是「大家說好各拿多少」,沒有一個既有的
            總額可以分;退還則相反,要分的就是公費現在剩下的現金。
          -->
          <div v-if="potDirection === 'out'" class="mt-2.5">
            <UiAppButton
              variant="ghost" block
              :disabled="!!splitBlockedReason"
              @click="splitRemainingEqually"
            >
              <Icon name="lucide:split" />
              平分剩餘 {{ formatMoney(Math.max(potRemainingMinor, 0), potCurrency) }}
            </UiAppButton>
            <p
              class="mt-1.5 text-xs leading-relaxed"
              :style="{ color: splitBlockedReason ? 'var(--warn)' : 'var(--text-muted)' }"
            >
              <template v-if="splitBlockedReason">{{ splitBlockedReason }}</template>
              <template v-else>
                分給勾選的 {{ potPicked.length }} 個人。除不盡的餘數會分給前面幾個人,
                所以加起來精確等於剩餘 —— 不會有 1 塊錢卡在公費裡歸不了零。
              </template>
            </p>
          </div>

          <p v-if="!people.length" class="mt-2 text-xs" style="color: var(--warn)">
            這趟只有公費、沒有其他成員,先去「成員」頁加人。
          </p>
        </div>

        <!-- 例外情況的逃生門:多數時候每人一樣,但不是規則 -->
        <button
          type="button"
          class="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left"
          style="background: var(--bg-sunken)"
          :aria-pressed="potPerPerson"
          @click="togglePerPerson"
        >
          <span class="pick-box" :class="{ 'is-on': potPerPerson }">
            <Icon v-if="potPerPerson" name="lucide:check" size="14" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm">自訂金額</span>
            <span class="block text-xs" style="color: var(--text-muted)">
              <template v-if="potPerPerson">
                金額改由每個人自己的欄位決定,上面那個共用欄位停用中。
              </template>
              <template v-else>
                有人先墊多一點、或身上沒零錢的時候打開,可以逐人微調
                (上面填好的金額會先帶進每個人)。
              </template>
            </span>
          </span>
        </button>

        <!-- 合計。這是送出前最後一道人眼檢查。 -->
        <div
          v-if="potEntries.length"
          class="flex items-baseline justify-between gap-3 rounded-xl px-3 py-2.5"
          style="background: var(--bg-sunken)"
        >
          <span class="text-xs" style="color: var(--text-muted)">
            {{ potEntries.length }} 人 · 合計{{ potDirection === 'in' ? '投入' : '退還' }}
          </span>
          <span class="tnum text-base font-bold">
            {{ formatMoney(potTotalMinor, potCurrency) }}
          </span>
        </div>

        <div v-if="potProblems.length" class="card p-3 text-sm" role="alert" style="border-color: var(--warn)">
          <div v-for="p in potProblems" :key="p" class="flex items-center gap-2" style="color: var(--warn)">
            <Icon name="lucide:alert-circle" class="shrink-0" /> {{ p }}
          </div>
        </div>

        <p v-if="potError" class="text-sm" role="alert" style="color: var(--debit)">
          {{ potError }}
        </p>
      </div>

      <div class="mt-4 flex gap-2">
        <UiAppButton variant="ghost" block @click="potSheetOpen = false">
          取消
        </UiAppButton>
        <UiAppButton variant="primary" block :loading="potSaving" :disabled="!potCanSubmit" @click="submitPot">
          記下來
        </UiAppButton>
      </div>
    </UiAppSheet>

    <!--
      ── 刪除單筆金流的確認 ──
      文案必須說出後果:剩餘會從多少變成多少。只問「確定刪除?」等於要使用者
      自己心算公費還剩多少 —— 而那正是他刪這筆的原因。
    -->
    <UiAppSheet
      :open="!!deleteTarget"
      title="刪掉這筆公費金流?"
      :dismissible="!deletingMove"
      @update:open="(v) => !v && (deleteTarget = null)"
    >
      <div v-if="deleteTarget" class="space-y-3">
        <div class="rounded-xl px-3 py-2.5" style="background: var(--bg-sunken)">
          <div class="flex items-center gap-2">
            <span
              class="move-dir"
              :style="deleteTarget.direction === 'in'
                ? { background: 'color-mix(in oklab, var(--credit) 15%, transparent)', color: 'var(--credit)' }
                : { background: 'color-mix(in oklab, var(--warn) 18%, transparent)', color: 'var(--warn)' }"
            >
              {{ deleteTarget.direction === 'in' ? '投入' : '退還' }}
            </span>
            <span class="min-w-0 flex-1 truncate text-sm">{{ memberName(deleteTarget.member_id) }}</span>
            <UiMoney :minor="deleteTarget.amount_minor" :currency="deleteTarget.currency" size="sm" />
          </div>
          <p class="mt-1 text-[0.6875rem]" style="color: var(--text-muted)">
            <span class="tnum">{{ moveTimeText(deleteTarget.settled_at) }}</span>
            <span class="mx-1">·</span>
            <span>{{ CURRENCY_LABEL[deleteTarget.currency] ?? deleteTarget.currency }}</span>
          </p>
        </div>

        <p class="text-sm leading-relaxed">
          刪掉之後,{{ CURRENCY_LABEL[deleteTarget.currency] ?? deleteTarget.currency }}的{{ pot?.name ?? '公費' }}剩餘會從
          <span class="tnum font-semibold">{{ formatMoney(remainingOf(deleteTarget.currency), deleteTarget.currency) }}</span>
          變成
          <span class="tnum font-semibold">{{ formatMoney(remainingAfter(deleteTarget, 0), deleteTarget.currency) }}</span>。
          這筆會從歷史裡整個消失,無法復原。
        </p>

        <p v-if="remainingAfter(deleteTarget, 0) < 0" class="flex items-start gap-1.5 text-xs leading-relaxed"
           style="color: var(--warn)">
          <Icon name="lucide:circle-alert" size="14" class="mt-px shrink-0" />
          <span>這會讓剩餘變成負的(公費付出去的比手上的多),伺服器會擋下來。</span>
        </p>

        <p v-if="deleteError" class="text-sm leading-relaxed" role="alert" style="color: var(--debit)">
          {{ deleteError }}
        </p>
      </div>

      <template #footer>
        <UiAppButton variant="ghost" block :disabled="deletingMove" @click="deleteTarget = null">
          取消
        </UiAppButton>
        <UiAppButton variant="primary" block :loading="deletingMove" @click="confirmDeleteMove">
          刪除
        </UiAppButton>
      </template>
    </UiAppSheet>
  </div>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換。 */

.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-height: 32px;
  padding-inline: 0.5rem;
  border-radius: 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--brand);
  transition: background-color 0.15s ease;
}
@media (hover: hover) {
  .link-btn:hover {
    background: color-mix(in oklab, var(--brand) 10%, transparent);
  }
  .link-danger:hover {
    background: color-mix(in oklab, var(--debit) 10%, transparent);
  }
}
.link-btn:disabled {
  opacity: 0.45;
  pointer-events: none;
}
/* 刪除是唯一不可復原的動作,顏色要和「改金額」分得開 */
.link-danger {
  color: var(--debit);
}

/* 卡片內的列表分隔線 / 欄名列。和結算頁用同一組名字,不另外發明。 */
.divided > * + * {
  border-top: 1px solid var(--border);
}
.row-head {
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--border);
}

/* 金流紀錄的展開入口。做成一整條可按的列,手指好按。 */
.moves-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  padding-inline: 0.75rem;
  border-radius: 0.75rem;
  background: var(--bg-sunken);
  color: var(--text);
  transition: background-color 0.15s ease;
}
@media (hover: hover) {
  .moves-toggle:hover {
    background: color-mix(in oklab, var(--brand) 8%, var(--bg-sunken));
  }
}

/* 投入 / 退還的方向標。逐筆列表裡這是第一眼要分辨的東西。 */
.move-dir {
  flex-shrink: 0;
  padding: 0.125rem 0.4rem;
  border-radius: 0.375rem;
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
}

.pick-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.75rem;
  padding-right: 0.25rem;
  transition: background-color 0.15s ease;
}
.pick-row.is-on {
  background: var(--bg-sunken);
}
.pick-toggle {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  align-items: center;
  gap: 0.625rem;
  min-height: 48px;
  padding-inline: 0.5rem;
  border-radius: 0.75rem;
  font-size: 0.9375rem;
  color: var(--text);
  text-align: left;
}
.pick-box {
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
.pick-box.is-on {
  border-color: transparent;
  background: var(--brand);
}

.pick-amount {
  display: flex;
  align-items: center;
  width: 7rem;
  flex-shrink: 0;
  min-height: 44px;
  margin-block: 0.125rem;
  padding-inline: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--bg-elevated);
  transition: border-color 0.15s ease;
}
.pick-amount:focus-within {
  border-color: var(--brand);
}
/* 共用模式下這一欄是唯讀的鏡子(顯示上面填的金額),要看得出來不能打字 */
.pick-amount.is-off {
  background: transparent;
  border-color: transparent;
}
.cell-input:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
}
.cell-input {
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
.cell-input::-webkit-outer-spin-button,
.cell-input::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}

@media (prefers-reduced-motion: reduce) {
  .link-btn,
  .pick-row,
  .pick-box,
  .pick-amount,
  .moves-toggle {
    transition: none;
  }
}
</style>
