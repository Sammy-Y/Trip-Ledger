<script setup lang="ts">
import type { Balance, Expense, Kind, SettlementRound } from '~~/shared/types';
import { CURRENCY_LABEL, formatMoney } from '~~/shared/money';
import ExpenseRow from '~/components/expense/ExpenseRow.vue';
import ExpenseDetail from '~/components/expense/ExpenseDetail.vue';

/**
 * 支出列表 —— 一趟旅程的預設畫面。
 *
 * 三個設計決定:
 *  1. **雙軌帳本**:共同(要分攤、進結算)和個人(只算自己)是兩個 Tab,
 *     各自打 GET /expenses?kind=...。兩軌都會在進頁時抓起來 ——
 *     頂部摘要卡本來就要同時顯示兩軌的數字,所以切 Tab 是零延遲的。
 *  2. **逐幣別、絕不相加**。摘要卡與日期小計都是每個幣別一行。
 *     日幣加台幣得到的數字沒有意義,那正是原本 Excel 的錯。
 *  3. **點開就看得到組成**。付款人與分攤人是兩組不同的人,
 *     加上當時的匯率與來源 —— 使用者要敢拿這個數字去跟朋友要錢。
 */
const tripId = useTripId();
const api = useApi();
const { trip, members, memberMap, memberName, fxDefaults } = useTrip(tripId);

const baseCurrency = computed(() => trip.value?.base_currency ?? 'TWD');
const baseLabel = computed(() => CURRENCY_LABEL[baseCurrency.value] ?? baseCurrency.value);

// 用 computed 而不是 getter,ref/computed 是 useHead 最沒有爭議的反應式寫法
const pageTitle = computed(() => (trip.value?.name ? `${trip.value.name} — 支出` : '支出'));
useHead({ title: pageTitle });

// ── 資料 ────────────────────────────────────────────────────
/** 每一軌一個 useAsyncData(key 帶 kind),所以切 Tab 不會重抓已經有的那一軌 */
function useExpenses(kind: Kind) {
  return useAsyncData<Expense[]>(
    () => `expenses:${tripId.value}:${kind}`,
    () => api.get<Expense[]>(`/api/trips/${encodeURIComponent(tripId.value)}/expenses`, { kind }),
    { default: () => [], deep: false, dedupe: 'defer' },
  );
}
const sharedTrack = useExpenses('shared');
const personalTrack = useExpenses('personal');

/** per_member 的本位幣統計。刪除後要一起 refresh,不然合計會停在舊數字 */
const balanceState = useAsyncData<Balance | null>(
  () => `balance:${tripId.value}`,
  () => api.get<Balance>(`/api/trips/${encodeURIComponent(tripId.value)}/balance`),
  { default: () => null, deep: false, dedupe: 'defer' },
);

const sharedList = computed<Expense[]>(() => sharedTrack.data.value ?? []);
const personalList = computed<Expense[]>(() => personalTrack.data.value ?? []);

// ── Tab ────────────────────────────────────────────────────
const tab = ref<Kind>('shared');
const TABS = [
  { kind: 'shared' as Kind, label: '共同', icon: 'lucide:users' },
  { kind: 'personal' as Kind, label: '個人', icon: 'lucide:user' },
];

const activeTrack = computed(() => (tab.value === 'shared' ? sharedTrack : personalTrack));
const activeList = computed<Expense[]>(() => (tab.value === 'shared' ? sharedList.value : personalList.value));
function countOf(kind: Kind): number {
  return (kind === 'shared' ? sharedList.value : personalList.value).length;
}

/** 錯誤要顯示出來,但被取消的請求(離開頁面 / 換 tripId)不算錯誤 */
function messageOf(raw: unknown): string | null {
  if (!raw || isAbortError(raw)) return null;
  return api.errorMessage(raw);
}
const listError = computed(() => messageOf(activeTrack.value.error.value));
const listLoading = computed(() => activeTrack.value.status.value === 'pending' && !activeList.value.length);

const totalCount = computed(() => sharedList.value.length + personalList.value.length);
const summaryLoading = computed(() => (
  (sharedTrack.status.value === 'pending' || personalTrack.status.value === 'pending')
  && totalCount.value === 0
));
/** 載入失敗時不要擺一張全是「—」的摘要卡在錯誤訊息上面 */
const showSummary = computed(() => summaryLoading.value || totalCount.value > 0);

// 切 Tab 就把展開的明細收起來,不然回到另一軌會看到殘留的展開狀態
const openId = ref<string | null>(null);
watch(tab, () => { openId.value = null; });

function toggle(id: string): void {
  openId.value = openId.value === id ? null : id;
}

function selectTab(kind: Kind): void {
  tab.value = kind;
}
/** 左右鍵在兩個 Tab 之間移動(segmented control 的鍵盤慣例) */
function moveTab(step: number): void {
  const index = TABS.findIndex((t) => t.kind === tab.value);
  const next = TABS[(index + step + TABS.length) % TABS.length];
  if (next) tab.value = next.kind;
}

async function retry(): Promise<void> {
  await Promise.all([
    activeTrack.value.refresh({ dedupe: 'cancel' }),
    balanceState.refresh({ dedupe: 'cancel' }),
  ]);
}

// ── 摘要:逐幣別加總,絕不把日幣台幣加成一個數字 ──────────────
interface CurrencyTotal { currency: string; minor: number; count: number }

function totalsByCurrency(list: Expense[]): CurrencyTotal[] {
  const map = new Map<string, CurrencyTotal>();
  for (const e of list) {
    const row = map.get(e.currency) ?? { currency: e.currency, minor: 0, count: 0 };
    row.minor += e.amount_minor;
    row.count += 1;
    map.set(e.currency, row);
  }
  // 跨幣別的金額大小沒有可比性,所以排序只看「本位幣優先,再按代碼」——
  // 用 minor 排會讓 ¥1,000 看起來比 NT$900 大。
  return [...map.values()].sort((a, b) => {
    if (a.currency === b.currency) return 0;
    if (a.currency === baseCurrency.value) return -1;
    if (b.currency === baseCurrency.value) return 1;
    return a.currency.localeCompare(b.currency);
  });
}

/** 摘要卡的兩軌。兩軌並列是刻意的:使用者想知道的就是「共同多少、自己多少」。 */
const trackSummaries = computed(() => [
  {
    kind: 'shared' as Kind,
    label: '共同花費',
    hint: '要分攤、進結算',
    icon: 'lucide:users',
    totals: totalsByCurrency(sharedList.value),
  },
  {
    kind: 'personal' as Kind,
    label: '個人花費',
    hint: '只算自己,不分攤',
    icon: 'lucide:user',
    totals: totalsByCurrency(personalList.value),
  },
]);

// ── 摘要:每人合計(換算本位幣,估算值)────────────────────────
interface MemberStat {
  id: string; name: string;
  sharedOwedBase: number; personalBase: number; totalBase: number; unconverted: number;
}
const ZERO = { sharedOwedBase: 0, personalBase: 0, totalBase: 0, unconverted: 0 };

const memberStats = computed<MemberStat[]>(() => {
  const perMember = balanceState.data.value?.per_member ?? {};
  const rows: MemberStat[] = members.value.map((m) => ({
    id: m.id, name: m.name, ...(perMember[m.id] ?? ZERO),
  }));
  // balance 裡有、成員名單裡沒有的(成員已被移除)也要列出來,不然合計會少一塊
  for (const [id, stat] of Object.entries(perMember)) {
    if (!rows.some((r) => r.id === id)) rows.push({ id, name: memberName(id), ...stat });
  }
  return rows.sort((a, b) => b.totalBase - a.totalBase);
});

/** 每人合計相加 = 這趟總花費(換算本位幣)。這是估算值,一定要標明。 */
const tripTotalBase = computed(() => memberStats.value.reduce((s, r) => s + r.totalBase, 0));
const unconvertedCount = computed(() => memberStats.value.reduce((s, r) => s + r.unconverted, 0));
const balanceError = computed(() => messageOf(balanceState.error.value));
const balanceLoading = computed(() => balanceState.status.value === 'pending' && !balanceState.data.value);

// 換算免責聲明與匯率來源標註是資料來源的授權要求 —— 有顯示換算金額的地方就要跟著出現
const disclaimer = computed(() => balanceState.data.value?.disclaimer ?? '');
const rateAttribution = computed(() => balanceState.data.value?.rate_attribution ?? '');

const perMemberOpen = ref(false);

// ── 篩選 ────────────────────────────────────────────────────
/**
 * 依日期 / 付款人篩選。
 *
 * 在前端做而不是打 API:一趟旅程幾十筆,全部已經在記憶體裡,
 * 前端篩是瞬間的;走 API 反而多一次往返、還要處理載入狀態。
 * 選項也直接從當前資料推導 —— 只列出真的出現過的日期與付款人,
 * 不會出現「選了卻沒有結果」的死選項。
 */
const filterDate = ref('');
const filterPayer = ref('');

/** 切換共同/個人時清掉篩選 —— 兩邊的付款人與日期不一定重疊,留著會看到空清單 */
watch(tab, () => { filterDate.value = ''; filterPayer.value = ''; });

const dateOptions = computed(() => {
  const seen = new Set<string>();
  const out: Array<{ value: string; label: string }> = [];
  // 用 activeList 而不是 filteredList:選項要永遠是「這個 tab 有哪些日期」,
  // 若跟著篩選結果縮減,選了某天之後就只剩那一個選項,換不回其他天。
  for (const e of activeList.value) {
    if (!e.spent_at || seen.has(e.spent_at)) continue;
    seen.add(e.spent_at);
    out.push({ value: e.spent_at, label: dayLabel(e.spent_at) });
  }
  return out;
});

const payerOptions = computed(() => {
  const seen = new Set<string>();
  for (const e of activeList.value) for (const p of e.payers ?? []) seen.add(p.member_id);
  return members.value
    .filter((m) => seen.has(m.id))
    .map((m) => ({ value: m.id, label: m.name }));
});

const filteredList = computed<Expense[]>(() => activeList.value.filter((e) => {
  if (filterDate.value && e.spent_at !== filterDate.value) return false;
  if (filterPayer.value && !(e.payers ?? []).some((p) => p.member_id === filterPayer.value)) return false;
  return true;
}));

const filterActive = computed(() => !!filterDate.value || !!filterPayer.value);
function clearFilters(): void { filterDate.value = ''; filterPayer.value = ''; }

// ── 排序 ────────────────────────────────────────────────────
/**
 * 預設按日期(server 已經 ORDER BY spent_at DESC),另外提供按金額排序。
 *
 * ⚠️ 金額排序刻意**在同一幣別內**進行,而且清單會改成平鋪、不再按日期分組:
 *  - 跨幣別比大小沒有意義(¥1,000 排在 NT$900 前面是錯的),
 *    所以先按幣別分堆(本位幣優先),再在每堆裡比金額。
 *  - 日期分組和金額排序天生衝突 —— 硬要兩者並存,得到的是
 *    「每天各自排好」而不是使用者想要的「這趟最貴的是哪幾筆」。
 */
type SortKey = 'date' | 'amount-desc' | 'amount-asc';

const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'date', label: '日期(新→舊)' },
  { value: 'amount-desc', label: '金額(高→低)' },
  { value: 'amount-asc', label: '金額(低→高)' },
];

const sortKey = ref<SortKey>('date');
/** 金額排序時改成平鋪清單,日期分組會失去意義 */
const byAmount = computed(() => sortKey.value !== 'date');

/** 幣別的排序權重:本位幣優先,其餘按代碼 */
function currencyRank(cur: string): string {
  return cur === baseCurrency.value ? ` ${cur}` : cur;
}

const sortedList = computed<Expense[]>(() => {
  if (!byAmount.value) return filteredList.value;
  const dir = sortKey.value === 'amount-desc' ? -1 : 1;
  return [...filteredList.value].sort((a, b) => {
    const ra = currencyRank(a.currency), rb = currencyRank(b.currency);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (a.amount_minor !== b.amount_minor) return (a.amount_minor - b.amount_minor) * dir;
    // 同額時用日期當第二鍵,順序才穩定(不會每次重繪跳動)
    return a.spent_at < b.spent_at ? 1 : a.spent_at > b.spent_at ? -1 : 0;
  });
});

/** 金額排序時,每個幣別一段(段標顯示幣別與小計) */
interface AmountGroup { currency: string; items: Expense[]; minor: number }

const amountGroups = computed<AmountGroup[]>(() => {
  const out: AmountGroup[] = [];
  for (const e of sortedList.value) {
    const last = out[out.length - 1];
    if (last && last.currency === e.currency) { last.items.push(e); last.minor += e.amount_minor; }
    else out.push({ currency: e.currency, items: [e], minor: e.amount_minor });
  }
  return out;
});

// ── 日期分組 ────────────────────────────────────────────────
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 'YYYY-MM-DD' 用當地時間組出 Date。直接 new Date(字串) 會被當成 UTC 而差一天。 */
function parseDay(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

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

interface DayGroup { date: string; label: string; items: Expense[]; totals: CurrencyTotal[] }

/** server 已經 ORDER BY spent_at DESC,所以照順序掃一遍就能分組 */
const groups = computed<DayGroup[]>(() => {
  const out: DayGroup[] = [];
  // 這裡吃 filteredList(不是 activeList)—— 清單本體才是要被篩選的東西。
  // 而 Tab 徽章、摘要卡總計、篩選下拉的選項都必須用未篩選的 activeList。
  for (const e of filteredList.value) {
    const last = out[out.length - 1];
    if (last && last.date === e.spent_at) last.items.push(e);
    else out.push({ date: e.spent_at, label: dayLabel(e.spent_at), items: [e], totals: [] });
  }
  for (const g of out) g.totals = totalsByCurrency(g.items);
  return out;
});

// ── 日期收合 ────────────────────────────────────────────────
/**
 * 每天可以收合起來。狀態存 localStorage 並以 trip 為 key,
 * 這樣「已經對過帳的日子收起來」在重新整理後還在。
 *
 * 存「收合的日期」而不是「展開的日期」:新增一天時預設是展開的,
 * 使用者不會因為記錄了新支出卻看不到而困惑。
 */
const collapsedDates = useLocalStorage<string[]>(
  computed(() => `trip-ledger:collapsed:${tripId.value}`),
  [],
  {
    // localStorage 可能被封鎖(無痕視窗、瀏覽器設定),不能讓它炸掉整頁
    onError: () => {},
    serializer: {
      read: (v: string) => { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } },
      write: (v: string[]) => JSON.stringify(v),
    },
  },
);

const collapsedSet = computed(() => new Set(collapsedDates.value));
const isCollapsed = (date: string): boolean => collapsedSet.value.has(date);

function toggleDay(date: string): void {
  collapsedDates.value = isCollapsed(date)
    ? collapsedDates.value.filter((d) => d !== date)
    : [...collapsedDates.value, date];
}

/** 只要還有一天是展開的,主動作就是「全部收合」 */
const anyExpanded = computed(() => groups.value.some((g) => !isCollapsed(g.date)));

function toggleAll(): void {
  collapsedDates.value = anyExpanded.value ? groups.value.map((g) => g.date) : [];
}

// ── 結算章:這筆是第幾次結算蓋的 ─────────────────────────────
/**
 * 列首的鎖(aria-label)和明細裡的說明都要講「第 N 次結算」,
 * 但 GET /expenses 只給 settlement_round_id —— seq 在結算歷史裡,
 * 所以在這裡查一次做成 id -> seq 的表。
 *
 * 刻意 immediate: false:多數旅程在結算之前一筆章都沒有,
 * 不該為了一個可能永遠用不到的標籤,每次進列表都多打一次 API。
 * key 和結算頁用同一個,從結算頁走過來時直接吃快取,不會重抓。
 */
const roundsState = useAsyncData<SettlementRound[]>(
  () => `rounds:${tripId.value}`,
  () => api.get<SettlementRound[]>(`/api/trips/${encodeURIComponent(tripId.value)}/rounds`),
  { default: () => [], immediate: false, deep: false, dedupe: 'defer' },
);

const hasSettled = computed(() => (
  sharedList.value.some((e) => e.settlement_round_id)
  || personalList.value.some((e) => e.settlement_round_id)
));

watch(hasSettled, (yes) => {
  if (yes && roundsState.status.value === 'idle') roundsState.execute();
}, { immediate: true });

const roundSeqById = computed(() => new Map<string, number>(
  (roundsState.data.value ?? []).map((r) => [r.id, r.seq]),
));

/** 查不到就回 null —— 元件會退回只說「已結算」,不會顯示「第 null 次」 */
function roundSeqOf(expense: Expense): number | null {
  const id = expense.settlement_round_id;
  return id ? roundSeqById.value.get(id) ?? null : null;
}

// ── 編輯 ────────────────────────────────────────────────────
/**
 * 編輯用 bottom sheet,不開獨立路由。三個理由:
 *
 *  1. **資料已經在手上。** GET /expenses 回傳的每筆都帶完整的 payers / shares,
 *     sheet 直接把物件遞給 ExpenseForm 就能預填。獨立路由等於重新載入整趟支出、
 *     只為了在裡面找出一筆(server 沒有查單筆的端點),還要多一次載入狀態。
 *  2. **手機單手操作。** sheet 從下方升起,主要動作(儲存修改)落在拇指區;
 *     關掉之後列表還停在原本的捲動位置、原本展開的那一列。
 *     換成路由就是離開再回來,捲動位置與展開狀態都得自己重建。
 *  3. **和刪除確認一致。** 這頁的刪除本來就是 UiAppSheet,
 *     Esc / 點背景關閉 / 焦點鎖那些行為不必再實作一次,也不會兩處不一樣。
 *
 * 代價是編輯狀態不在網址上(不能分享、重新整理會關掉)——
 * 記帳是幾十秒就結束的動作,不值得為此付上面三項成本。
 */
const editTarget = ref<Expense | null>(null);
const editOpen = ref(false);
const saving = ref(false);
const editError = ref<string | null>(null);

function askEdit(expense: Expense): void {
  editTarget.value = expense;
  editError.value = null;
  editOpen.value = true;
}

async function saveEdit(payload: Record<string, unknown>): Promise<void> {
  const expense = editTarget.value;
  if (!expense || saving.value) return;
  saving.value = true;
  editError.value = null;
  try {
    // PATCH 是整筆取代(payload 和 POST 完全相同),不是部分更新 ——
    // 表單本來就把每一欄都送出,沒有「只改一欄」這種中間狀態要處理。
    await api.patch(
      `/api/trips/${encodeURIComponent(tripId.value)}/expenses/${encodeURIComponent(expense.id)}`,
      payload,
    );
    editOpen.value = false;
    showToast(`已更新「${String(payload.description || expense.description || '這筆花費')}」`);

    // 共同 ↔ 個人 被改掉時,把 Tab 切到它的新家。
    // 不切的話,使用者按完儲存只會看到那筆從眼前消失 —— 那看起來像刪掉了,不像搬家。
    const nextKind: Kind = payload.kind === 'personal' ? 'personal' : 'shared';
    if (nextKind !== expense.kind) tab.value = nextKind;

    // 編輯可以把共同改成個人(或反過來),所以兩軌都要重抓 ——
    // 只抓原本那一軌的話,那筆會從舊 tab 消失但不會出現在新 tab。
    await Promise.all([
      sharedTrack.refresh({ dedupe: 'cancel' }),
      personalTrack.refresh({ dedupe: 'cancel' }),
      balanceState.refresh({ dedupe: 'cancel' }),
    ]);
  }
  catch (e) {
    editError.value = api.errorMessage(e, '儲存失敗,請再試一次。');
  }
  finally {
    saving.value = false;
  }
}

// ── 刪除 ────────────────────────────────────────────────────
const target = ref<Expense | null>(null);
const confirmOpen = ref(false);
const deleting = ref(false);
const deleteError = ref('');

function askDelete(expense: Expense): void {
  target.value = expense;
  deleteError.value = '';
  confirmOpen.value = true;
}

async function confirmDelete(): Promise<void> {
  const expense = target.value;
  if (!expense || deleting.value) return;
  deleting.value = true;
  deleteError.value = '';
  try {
    await api.del(
      `/api/trips/${encodeURIComponent(tripId.value)}/expenses/${encodeURIComponent(expense.id)}`,
    );
    confirmOpen.value = false;
    if (openId.value === expense.id) openId.value = null;
    showToast(`已刪除「${expense.description || '這筆花費'}」`);
    // 只重抓被影響的那一軌 + balance(結算與合計都要立刻跟著變)
    const track = expense.kind === 'shared' ? sharedTrack : personalTrack;
    await Promise.all([
      track.refresh({ dedupe: 'cancel' }),
      balanceState.refresh({ dedupe: 'cancel' }),
    ]);
  }
  catch (e) {
    deleteError.value = api.errorMessage(e, '刪除失敗,請再試一次。');
  }
  finally {
    deleting.value = false;
  }
}

// ── 刪除後的提示 ────────────────────────────────────────────
const toastText = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(text: string): void {
  toastText.value = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastText.value = ''; }, 2800);
}
onBeforeUnmount(() => clearTimeout(toastTimer));
</script>

<template>
  <div>
    <!-- ═════════ 頂部摘要卡 ═════════ -->
    <section v-if="showSummary" class="card mb-4 p-4 md:p-5">
      <div class="mb-3.5 flex items-baseline justify-between gap-3">
        <h2 class="text-sm font-semibold text-[var(--text)]">這趟花費</h2>
        <p v-if="totalCount" class="text-xs text-[var(--text-muted)]">
          共 <span class="tnum">{{ totalCount }}</span> 筆
        </p>
      </div>

      <UiLoadingBlock v-if="summaryLoading" :rows="2" variant="plain" label="正在算這趟的花費" />

      <template v-else>
        <!-- 兩軌各自逐幣別列出。日幣台幣不會被加成一個數字。 -->
        <div class="grid gap-4 sm:grid-cols-2 sm:gap-6">
          <div v-for="track in trackSummaries" :key="track.kind">
            <h3 class="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
              <Icon :name="track.icon" size="13" />
              {{ track.label }}
            </h3>

            <ul v-if="track.totals.length" class="flex flex-col gap-1">
              <li
                v-for="row in track.totals"
                :key="row.currency"
                class="flex items-baseline gap-2"
              >
                <UiMoney :minor="row.minor" :currency="row.currency" size="lg" />
                <span class="text-[0.6875rem] text-[var(--text-muted)]">
                  {{ CURRENCY_LABEL[row.currency] ?? row.currency }}
                  · <span class="tnum">{{ row.count }}</span> 筆
                </span>
              </li>
            </ul>
            <p v-else class="text-2xl leading-tight font-semibold text-[var(--text-muted)]">—</p>

            <p class="mt-1 text-[0.6875rem] text-[var(--text-muted)]">{{ track.hint }}</p>
          </div>
        </div>

        <!-- 每人合計:唯一會做跨幣別換算的地方,所以要標明是估算 -->
        <div class="mt-4 border-t pt-3" style="border-color: var(--border)">
          <button
            type="button"
            class="permember-toggle"
            :aria-expanded="perMemberOpen"
            aria-controls="per-member-panel"
            @click="perMemberOpen = !perMemberOpen"
          >
            <span class="flex min-w-0 items-center gap-1.5">
              <Icon name="lucide:calculator" size="14" class="shrink-0 text-[var(--text-muted)]" />
              <span class="truncate text-xs font-medium text-[var(--text)]">每人合計</span>
              <span class="shrink-0 text-[0.6875rem] text-[var(--text-muted)]">換算{{ baseLabel }}·估算</span>
            </span>
            <span class="flex shrink-0 items-center gap-1">
              <span v-if="balanceLoading" class="h-4 w-16 animate-pulse rounded-full bg-[var(--bg-sunken)]" />
              <span v-else-if="!balanceError" class="tnum text-sm font-medium text-[var(--text)]">
                ≈ {{ formatMoney(tripTotalBase, baseCurrency) }}
              </span>
              <Icon
                name="lucide:chevron-down"
                size="15"
                class="text-[var(--text-muted)] transition-transform duration-200"
                :class="perMemberOpen ? 'rotate-180' : ''"
              />
            </span>
          </button>

          <div v-if="perMemberOpen" id="per-member-panel" class="mt-2.5">
            <p v-if="balanceError" class="flex flex-wrap items-center gap-2 text-xs text-[var(--debit)]">
              <span>{{ balanceError }}</span>
              <button type="button" class="underline underline-offset-2" @click="retry()">重試</button>
            </p>

            <UiLoadingBlock v-else-if="balanceLoading" :rows="3" variant="plain" label="正在算每人合計" />

            <template v-else>
              <p v-if="!memberStats.length" class="text-xs leading-relaxed text-[var(--text-muted)]">
                還沒有成員,所以算不出每人合計。
                <NuxtLink :to="`/t/${tripId}/members`" class="underline underline-offset-2">去新增成員</NuxtLink>
              </p>

              <ul v-else class="flex flex-col">
                <li v-for="row in memberStats" :key="row.id" class="stat-row">
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-[var(--text)]">{{ row.name }}</span>
                    <span class="block text-[0.6875rem] text-[var(--text-muted)]">
                      共同 <span class="tnum">{{ formatMoney(row.sharedOwedBase, baseCurrency) }}</span>
                      · 個人 <span class="tnum">{{ formatMoney(row.personalBase, baseCurrency) }}</span>
                    </span>
                  </span>
                  <UiMoney :minor="row.totalBase" :currency="baseCurrency" />
                </li>
              </ul>

              <p v-if="unconvertedCount" class="mt-2 flex items-start gap-1.5 text-[0.6875rem] text-[var(--warn)]">
                <Icon name="lucide:triangle-alert" size="13" class="mt-0.5 shrink-0" />
                <span>有 <span class="tnum">{{ unconvertedCount }}</span> 筆找不到匯率,沒有計入合計。</span>
              </p>

              <p v-if="disclaimer" class="mt-2 text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
                {{ disclaimer }}
              </p>
              <p v-if="rateAttribution" class="mt-1 text-[0.625rem] text-[var(--text-muted)]">
                {{ rateAttribution }}
              </p>
            </template>
          </div>
        </div>
      </template>
    </section>

    <!-- ═════════ 雙軌 Tab ═════════ -->
    <div
      v-if="totalCount > 0"
      role="tablist"
      aria-label="帳本"
      class="mb-3 flex gap-1 rounded-xl p-1"
      style="background: var(--bg-sunken)"
      @keydown.left.prevent="moveTab(-1)"
      @keydown.right.prevent="moveTab(1)"
    >
      <button
        v-for="item in TABS"
        :key="item.kind"
        type="button"
        role="tab"
        :aria-selected="tab === item.kind"
        :tabindex="tab === item.kind ? 0 : -1"
        aria-controls="expense-panel"
        class="seg"
        :class="{ 'is-active': tab === item.kind }"
        @click="selectTab(item.kind)"
      >
        <Icon :name="item.icon" size="15" class="shrink-0" />
        <span>{{ item.label }}</span>
        <span class="seg-count tnum">{{ countOf(item.kind) }}</span>
      </button>
    </div>

    <!-- ═════════ 列表 ═════════ -->
    <div id="expense-panel" role="tabpanel" :aria-label="tab === 'shared' ? '共同花費' : '個人花費'">
      <!-- 錯誤 -->
      <div v-if="listError" class="card p-5 text-center">
        <Icon name="lucide:cloud-off" size="22" class="mb-2 text-[var(--text-muted)]" />
        <p class="text-sm text-[var(--debit)]">{{ listError }}</p>
        <UiAppButton variant="ghost" icon="lucide:rotate-cw" class="mt-3" @click="retry()">
          重新載入
        </UiAppButton>
      </div>

      <!-- 載入中 -->
      <UiLoadingBlock v-else-if="listLoading" :rows="5" label="正在載入花費" />

      <!-- 整趟都還沒有資料 -->
      <div v-else-if="!totalCount" class="card">
        <UiEmptyState
          icon="lucide:receipt"
          title="這趟還沒有任何花費"
          description="在店門口付完錢就順手記一筆,回國才不用翻收據對帳。共同花費會自動分攤,個人花費只算你自己的。"
        >
          <UiAppButton :to="`/t/${tripId}/new`" icon="lucide:plus">記第一筆</UiAppButton>
          <UiAppButton variant="ghost" :to="`/t/${tripId}/members`" icon="lucide:users">
            先確認成員
          </UiAppButton>
        </UiEmptyState>
      </div>

      <!-- 這一軌是空的,但另一軌有資料 -->
      <div v-else-if="!activeList.length" class="card">
        <UiEmptyState
          dense
          :icon="tab === 'shared' ? 'lucide:users' : 'lucide:user'"
          :title="tab === 'shared' ? '還沒有共同花費' : '還沒有個人花費'"
          :description="tab === 'shared'
            ? '住宿、交通、一起吃的那幾餐記在這裡,結算時會算出誰欠誰多少。'
            : '自己買的伴手禮、扭蛋、咖啡記在這裡 —— 只算進你自己的統計,不會分給別人。'"
        >
          <UiAppButton :to="`/t/${tripId}/new`" icon="lucide:plus">記一筆</UiAppButton>
        </UiEmptyState>
      </div>

      <!-- 有資料:按日期分組,每天可收合 -->
      <div v-else class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-2 px-1">
          <select v-model="filterDate" class="filter-select" aria-label="依日期篩選">
            <option value="">所有日期</option>
            <option v-for="d in dateOptions" :key="d.value" :value="d.value">{{ d.label }}</option>
          </select>

          <select v-model="filterPayer" class="filter-select" aria-label="依付款人篩選">
            <option value="">{{ tab === 'shared' ? '所有付款人' : '所有人' }}</option>
            <option v-for="m in payerOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>

          <select v-model="sortKey" class="filter-select" aria-label="排序方式">
            <option v-for="s in SORTS" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>

          <button v-if="filterActive" type="button" class="filter-clear" @click="clearFilters">
            <Icon name="lucide:x" size="12" />
            清除
          </button>

          <span v-if="filterActive" class="text-[0.6875rem] text-[var(--text-muted)]">
            {{ filteredList.length }} / {{ activeList.length }} 筆
          </span>

          <span class="flex-1" />

          <!-- 金額排序時是平鋪清單,沒有可收合的「天」 -->
          <button v-if="!byAmount" type="button" class="day-toggle-all" @click="toggleAll">
            <Icon :name="anyExpanded ? 'lucide:chevrons-down-up' : 'lucide:chevrons-up-down'" size="13" />
            {{ anyExpanded ? '全部收合' : '全部展開' }}
          </button>
        </div>

        <!-- 篩到沒東西時要講清楚是篩選造成的,不要讓人以為資料不見了 -->
        <div v-if="!sortedList.length" class="card px-4 py-8 text-center">
          <p class="text-sm text-[var(--text-muted)]">這個條件下沒有支出。</p>
          <button type="button" class="filter-clear mx-auto mt-3" @click="clearFilters">
            <Icon name="lucide:x" size="12" /> 清除篩選
          </button>
        </div>

        <!-- ── 金額排序:平鋪,按幣別分段 ── -->
        <template v-else-if="byAmount">
          <section v-for="group in amountGroups" :key="group.currency">
            <h3 class="mb-1.5 flex items-baseline gap-2 px-1 pr-1 md:pr-[2.625rem]">
              <span class="text-xs font-semibold">{{ CURRENCY_LABEL[group.currency] ?? group.currency }}</span>
              <span class="text-[0.6875rem] text-[var(--text-muted)]">{{ group.items.length }} 筆</span>
              <span class="flex-1" />
              <span class="tnum text-[0.6875rem]">{{ formatMoney(group.minor, group.currency) }}</span>
            </h3>
            <ul class="flex flex-col gap-2">
              <li v-for="expense in group.items" :key="expense.id" class="card overflow-hidden">
                <ExpenseRow
                  :expense="expense"
                  :names="memberMap"
                  :expanded="openId === expense.id"
                  :detail-id="`detail-${expense.id}`"
                  :round-seq="roundSeqOf(expense)"
                  @toggle="toggle(expense.id)"
                />
                <Transition name="detail">
                  <div v-if="openId === expense.id" :id="`detail-${expense.id}`">
                    <ExpenseDetail
                      :expense="expense"
                      :names="memberMap"
                      :base-currency="baseCurrency"
                      :round-seq="roundSeqOf(expense)"
                      @edit="askEdit(expense)"
                      @delete="askDelete(expense)"
                    />
                  </div>
                </Transition>
              </li>
            </ul>
          </section>
          <p class="px-1 text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
            金額排序在同一幣別內進行 —— 日幣和台幣的數字沒有可比性,不會混在一起排。
          </p>
        </template>

        <section v-for="group in groups" v-else :key="group.date">
          <!--
            右側 padding 要對齊列裡的金額欄右緣:
            列的 padding-right 0.875rem + 箭頭 1rem + gap 0.75rem = 2.625rem。
            否則標頭總計會比下面每一列的金額多凸出去一截。
          -->
          <h3 class="mb-1.5">
            <button
              type="button"
              class="day-header pl-1 pr-1 md:pr-[2.625rem]"
              :aria-expanded="!isCollapsed(group.date)"
              :aria-controls="`day-${group.date}`"
              @click="toggleDay(group.date)"
            >
              <Icon
                name="lucide:chevron-down"
                size="14"
                class="shrink-0 transition-transform duration-200"
                :class="isCollapsed(group.date) ? '-rotate-90' : ''"
                aria-hidden="true"
              />
              <span class="text-xs font-semibold">{{ group.label }}</span>
              <!-- 收合時要看得出「裡面還有東西」,不然會以為資料不見了 -->
              <span v-if="isCollapsed(group.date)" class="day-count">{{ group.items.length }} 筆</span>
              <span class="flex-1" />
              <span class="flex flex-wrap items-baseline justify-end gap-x-2 text-[0.6875rem]">
                <span v-for="row in group.totals" :key="row.currency" class="tnum">
                  {{ formatMoney(row.minor, row.currency) }}
                </span>
              </span>
            </button>
          </h3>

          <ul v-show="!isCollapsed(group.date)" :id="`day-${group.date}`" class="flex flex-col gap-2">
            <li v-for="expense in group.items" :key="expense.id" class="card overflow-hidden">
              <ExpenseRow
                :expense="expense"
                :names="memberMap"
                :expanded="openId === expense.id"
                :detail-id="`detail-${expense.id}`"
                :round-seq="roundSeqOf(expense)"
                @toggle="toggle(expense.id)"
              />
              <Transition name="detail">
                <div v-if="openId === expense.id" :id="`detail-${expense.id}`">
                  <ExpenseDetail
                    :expense="expense"
                    :names="memberMap"
                    :base-currency="baseCurrency"
                    :round-seq="roundSeqOf(expense)"
                    @edit="askEdit(expense)"
                    @delete="askDelete(expense)"
                  />
                </div>
              </Transition>
            </li>
          </ul>
        </section>

        <!-- 讓最後一列不要被右下角的浮動按鈕壓到 -->
        <div class="h-14" aria-hidden="true" />
      </div>
    </div>

    <!-- ═════════ 浮動「記一筆」 ═════════ -->
    <NuxtLink :to="`/t/${tripId}/new`" class="fab">
      <Icon name="lucide:plus" size="20" class="shrink-0" />
      <span>記一筆</span>
    </NuxtLink>

    <!-- ═════════ 編輯支出 ═════════ -->
    <UiAppSheet
      v-model:open="editOpen"
      title="編輯這筆花費"
      size="lg"
      :dismissible="!saving"
    >
      <!--
        v-if 帶 members.length:SplitEditor 會在成員名單「變動」時把新成員自動加進均分名單,
        名單還沒載完就掛載表單,等它載完就會把預填好的分攤對象改掉。
        key 綁 id:換一筆編輯時整個表單重掛載,不會留著上一筆的草稿。
        --form-sticky-bg:表單底部那顆黏著的送出鈕要跟 sheet 的底色一致(見 ExpenseForm)。
      -->
      <div
        v-if="editTarget && members.length"
        :key="editTarget.id"
        style="--form-sticky-bg: var(--bg-elevated)"
      >
        <ExpenseForm
          :members="members"
          :base-currency="baseCurrency"
          :fx-defaults="fxDefaults"
          :initial="editTarget"
          submit-label="儲存修改"
          :submitting="saving"
          :error-message="editError"
          @submit="saveEdit"
        />
      </div>
    </UiAppSheet>

    <!-- ═════════ 刪除二次確認 ═════════ -->
    <UiAppSheet
      v-model:open="confirmOpen"
      title="刪掉這筆花費?"
      size="sm"
      :dismissible="!deleting"
    >
      <div v-if="target" class="rounded-xl p-3" style="background: var(--bg-sunken)">
        <p class="flex items-baseline justify-between gap-3">
          <span class="min-w-0 flex-1 truncate text-sm font-medium">
            {{ target.description || '未填說明' }}
          </span>
          <UiMoney :minor="target.amount_minor" :currency="target.currency" />
        </p>
        <p class="mt-1 text-xs text-[var(--text-muted)]">
          <span class="tnum">{{ target.spent_at }}</span>
          · {{ target.kind === 'shared' ? '共同花費' : '個人花費' }}
          · {{ target.payment_method === 'card' ? '刷卡' : '現金' }}
        </p>
      </div>

      <p class="mt-3 text-sm leading-relaxed text-[var(--text-muted)]">
        {{ target?.kind === 'shared'
          ? '刪掉之後結算會立刻重算,誰欠誰多少會跟著變。這個動作沒辦法復原。'
          : '刪掉之後這個人的個人花費統計會跟著變。這個動作沒辦法復原。' }}
      </p>

      <p v-if="deleteError" class="mt-3 flex items-start gap-1.5 text-sm text-[var(--debit)]">
        <Icon name="lucide:circle-alert" size="15" class="mt-0.5 shrink-0" />
        <span>{{ deleteError }}</span>
      </p>

      <template #footer>
        <UiAppButton variant="ghost" block :disabled="deleting" @click="confirmOpen = false">
          取消
        </UiAppButton>
        <UiAppButton block icon="lucide:trash-2" :loading="deleting" @click="confirmDelete()">
          {{ deleting ? '刪除中' : '確定刪除' }}
        </UiAppButton>
      </template>
    </UiAppSheet>

    <!-- ═════════ 刪除完的提示 ═════════ -->
    <Transition name="toast">
      <p v-if="toastText" class="toast" role="status">
        <Icon name="lucide:check" size="15" class="shrink-0" />
        <span class="truncate">{{ toastText }}</span>
      </p>
    </Transition>
  </div>
</template>

<style scoped>
/* 顏色全部走 main.css 的 CSS 變數,深色模式自動跟著換。 */

/* ── 雙軌 Tab(segmented control)── */
.seg {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-height: 38px;
  border-radius: 0.625rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-muted);
  transition: background-color 0.18s ease, color 0.18s ease, transform 0.12s ease;
}
.seg:active {
  transform: scale(0.985);
}
.seg.is-active {
  background: var(--bg-elevated);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}
.seg-count {
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 500;
  background: color-mix(in oklab, var(--text-muted) 14%, transparent);
  color: var(--text-muted);
}
.seg.is-active .seg-count {
  background: color-mix(in oklab, var(--brand) 15%, transparent);
  color: var(--brand);
}

/* ── 每人合計的展開列 ── */
.permember-toggle {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 44px;
  padding-inline: 0.25rem;
  margin-inline: -0.25rem;
  border-radius: 0.625rem;
  text-align: left;
  transition: background-color 0.15s ease;
}
@media (hover: hover) {
  .permember-toggle:hover {
    background: var(--bg-sunken);
  }
}

.stat-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 44px;
  padding-block: 0.25rem;
}
.stat-row + .stat-row {
  border-top: 1px solid var(--border);
}

/* ── 明細展開 ──
   高度動畫在 iOS 上容易抖,只做淡入 + 輕微上移,版面不會跳。 */
.detail-enter-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.detail-enter-from {
  opacity: 0;
  transform: translateY(-0.25rem);
}
.detail-leave-active {
  transition: opacity 0.12s ease;
}
.detail-leave-to {
  opacity: 0;
}

/* ── 浮動「記一筆」──
   手機上疊在 tab bar 上方、拇指可及;md 以上落在右下角。 */
.fab {
  position: fixed;
  right: 1rem;
  bottom: calc(56px + var(--safe-b) + 0.875rem);
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 48px;
  padding-inline: 1.125rem;
  border-radius: 999px;
  font-size: 0.9375rem;
  font-weight: 600;
  background: var(--brand);
  color: var(--brand-text);
  box-shadow: 0 6px 20px -4px color-mix(in oklab, var(--brand) 55%, transparent),
              0 2px 6px rgb(0 0 0 / 12%);
  transition: transform 0.14s ease, box-shadow 0.18s ease;
}
.fab:active {
  transform: scale(0.96);
}
@media (min-width: 48rem) {
  .fab {
    right: 1.5rem;
    bottom: 1.5rem;
  }
}

/* ── 刪除後的提示 ── */
.toast {
  position: fixed;
  left: 50%;
  bottom: calc(56px + var(--safe-b) + 4.5rem);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  max-width: min(20rem, calc(100vw - 2rem));
  padding: 0.5rem 0.875rem;
  border-radius: 999px;
  font-size: 0.8125rem;
  background: var(--text);
  color: var(--bg);
  box-shadow: 0 8px 24px -6px rgb(0 0 0 / 35%);
  transform: translateX(-50%);
}
@media (min-width: 48rem) {
  .toast {
    bottom: 5.5rem;
  }
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, translate 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  translate: 0 0.5rem;
}

@media (prefers-reduced-motion: reduce) {
  .seg,
  .fab,
  .permember-toggle,
  .detail-enter-active,
  .detail-leave-active,
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
  .seg:active,
  .fab:active {
    transform: none;
  }
  .toast-enter-from,
  .toast-leave-to {
    translate: none;
  }
}

/* 日期標頭:整條可點,收合該天 */
.day-header {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.375rem;
  min-height: 32px;          /* 手機上要好點,但別大到把列表撐散 */
  border-radius: 0.5rem;
  color: var(--text-muted);
  text-align: left;
  transition: background-color 0.15s ease, color 0.15s ease;
}
@media (hover: hover) {
  .day-header:hover { background: var(--bg-sunken); color: var(--text); }
}
.day-header:active { background: var(--bg-sunken); }

/* 收合時顯示筆數,讓人知道內容只是被收起來、不是不見了 */
.day-count {
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.625rem;
  line-height: 1.4;
  background: var(--bg-sunken);
  color: var(--text-muted);
}

.day-toggle-all {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.5rem;
  font-size: 0.6875rem;
  color: var(--text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
@media (hover: hover) {
  .day-toggle-all:hover { background: var(--bg-sunken); color: var(--text); }
}

@media (prefers-reduced-motion: reduce) {
  .day-header, .day-toggle-all { transition: none; }
}

/* 篩選:用原生 select,手機上會跳系統選單,比自製下拉好用 */
.filter-select {
  min-height: 32px;
  padding: 0 1.75rem 0 0.625rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 0.75rem;
  /* 自繪箭頭,避免各家瀏覽器原生樣式不一致 */
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: right 0.75rem center, right 0.5rem center;
  background-size: 4px 4px, 4px 4px;
  background-repeat: no-repeat;
}
.filter-select:focus { outline: none; border-color: var(--brand); }

.filter-clear {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-height: 32px;
  padding: 0 0.625rem;
  border-radius: 0.5rem;
  background: var(--bg-sunken);
  color: var(--text-muted);
  font-size: 0.6875rem;
  transition: color 0.15s ease;
}
@media (hover: hover) {
  .filter-clear:hover { color: var(--text); }
}
@media (prefers-reduced-motion: reduce) {
  .filter-clear { transition: none; }
}
</style>
