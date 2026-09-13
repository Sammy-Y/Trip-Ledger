<script setup lang="ts">
import type {
  Balance, Net, RoundPreview, RoundPreviewBlock, SettlementRound, Transfer,
} from '~~/shared/types';
import { CURRENCY_LABEL, formatMoney } from '~~/shared/money';

/**
 * 結算 —— 「誰要給誰多少錢」。這頁是整個產品存在的理由。
 *
 * 五個不可妥協的規則:
 *  1. **逐幣別分開結算**。日幣和台幣絕不相加成一個總額,每個幣別自己一個區塊。
 *  2. 轉帳建議是貪婪近似解,文案寫「已簡化」而不是「最少」
 *     (最小化轉帳筆數可歸約到 Subset Sum,是 NP-Complete)。
 *  3. balance.disclaimer 與 balance.rate_attribution 必須顯示 ——
 *     前者是「換算值只是估算」的誠實聲明,後者是匯率來源的授權要求。
 *  4. **公費不參與這頁的算術。** 它只以「還剩多少 / 超支多少」出現一行現況,
 *     實際的投入 / 退還動作一律歸「總覽」。理由見下面那一整段 ——
 *     順帶保住鐵則:任一端是公費的轉帳建議永遠不會長出寫入按鈕
 *     (公費根本不在 nets 裡,minCashFlow 生不出那種腿)。
 *  5. 被結算蓋章的支出叫「已列入第 N 次結算」,**不是「已結清」**。
 *     債務是由那一輪的轉帳整體清掉的,不是一筆一筆對消 ——
 *     叫它「已結清」會讓人以為可以逐筆勾銷,那個心智模型會算錯錢。
 *
 * ══ 公費在這頁只是一則現況,不參與任何算術 ═══════════════════
 *
 * 兩本分開的帳(見 server/utils/ledger.ts):
 *
 *   信封    餘額 = 投入 − 公費付掉的 − 已退還。公費付的支出在記帳當下就從
 *           餘額扣掉,不追究是誰用的,所以**一毛人對人的債都不產生**。
 *   人對人  只看誰自己先墊了錢。公費從頭到尾不出現在這頁的淨額裡。
 *
 * 使用者親口描述的規格是:「A 先墊錢,但就是 A 墊錢,跟公費沒關係,
 * 不會變多,不會變少,也跟 A 拿出多少公費沒關係。」
 *
 * 所以這頁的公費那一行是**一則現況**(信封還剩多少 / 超支多少),
 * 不是算式的一半 —— 它和下面每個人的淨額沒有任何加總關係。
 * 曾經有一版把投入算進淨額、宣稱「下面每個人的淨額加起來剛好是這個數」,
 * 那讓人對人的債被偷偷改道走信封:
 *
 *   三人各投 5,000(信封 15,000,一毛沒花),A 自己墊了 3,000 的飯三人均分
 *     那個版本  這頁寫「人跟人之間不用轉帳」,改成信封退 A 7,000 / B 4,000 / C 4,000
 *     這一版    B→A 1,000、C→A 1,000,信封照舊各退 5,000
 *
 * 兩種走法每個人最後都掏 1,000,錢沒有算錯。但前者在畫面上寫
 * 「人跟人之間不用轉帳」,而事實是 B 和 C 各欠 A 一千 —— 那不是簡化,是說謊。
 *
 * ⚠️ 信封的餘額**不代表現在可以去要錢**:那筆現金旅程還沒結束就還要用。
 * 所以它永遠不會長成一筆可以按下去的轉帳,旅程結束到「總覽」按「退還」。
 *
 * ══ 結算回合(rounds)的兩個範圍 ═══════════════════════════════
 *
 * 這頁同時顯示兩種範圍的數字,而它們**刻意不同**:
 *   明細範圍  只有 settlement_round_id IS NULL 的支出 → 「本次要結算」列的那幾筆
 *   算術範圍  整趟到目前為止的共同花費(含公費付掉的)→ 所有的淨額與轉帳金額
 *
 * 只把未結的子集拿來算會**重複要錢**(settlement 這一列沒有任何欄位指向
 * 它清掉的是哪一筆債,所以真子集一定會遇到「還款在範圍內、對應的債在範圍外」),
 * 完整推導在 server/utils/ledger.ts。畫面上因此必須明講「金額不是上面那幾筆的加總」,
 * 否則使用者會自己去驗、發現對不起來,然後不敢信任這個 App。
 *
 * 這頁是要拿給朋友看的,所以寧可多一行說明,也不要讓人懷疑數字是怎麼來的。
 */
useHead({ title: '結算 — 旅遊記帳' });

const tripId = useTripId();
const api = useApi();
// people = 扣掉公費的真人。這一頁的兩張表都只講真人 —— 公費不是人,
// 「他這趟花了多少」「他應收應付多少」套在它身上都沒有意義。
const { people, memberName, memberMap, pot } = useTrip(tripId);

/** 公費的 member_id。這趟沒設公費時是 null。 */
const potId = computed<string | null>(() => pot.value?.id ?? null);
const potName = computed(() => pot.value?.name ?? '公費');

// ── 資料 ──────────────────────────────────────────────────────
// 以 tripId 當 key,和 useTrip 同一套做法:tripId 變了自動重抓。
const balanceState = useAsyncData<Balance | null>(
  () => `balance:${tripId.value}`,
  () => api.get<Balance>(`/api/trips/${encodeURIComponent(tripId.value)}/balance`),
  {
    enabled: computed(() => !!tripId.value),
    default: () => null,
    deep: false,
    dedupe: 'defer',
  },
);

const balance = computed<Balance | null>(() => balanceState.data.value ?? null);
/** 第一次載入(還沒有任何資料)才顯示骨架;refresh 時保留舊數字不要跳空 */
const firstLoad = computed(() => balanceState.status.value === 'pending' && !balance.value);
const loadError = computed<string | null>(() => {
  const e = balanceState.error.value;
  // 被取消的請求(換頁 / 換 tripId)不是錯誤
  if (!e || isAbortError(e)) return null;
  return api.errorMessage(e);
});

// ── 結算回合 ──────────────────────────────────────────────────
/**
 * 三份資料,分開抓:
 *   preview  這一輪要結什麼(明細 + 結果)
 *   rounds   結算歷史列表
 *   detail   某一輪的完整明細(展開時才抓)
 *
 * 刻意不合併成一支 API:歷史列表就算 preview 掛了也該看得到
 * (「幾個月後回來查這 1,850 是什麼」不該被今天的網路問題擋住)。
 */
const previewState = useAsyncData<RoundPreview | null>(
  () => `rounds-preview:${tripId.value}`,
  () => api.get<RoundPreview>(`/api/trips/${encodeURIComponent(tripId.value)}/rounds/preview`),
  {
    enabled: computed(() => !!tripId.value),
    default: () => null,
    deep: false,
    dedupe: 'defer',
  },
);

const roundsState = useAsyncData<SettlementRound[]>(
  () => `rounds:${tripId.value}`,
  () => api.get<SettlementRound[]>(`/api/trips/${encodeURIComponent(tripId.value)}/rounds`),
  {
    enabled: computed(() => !!tripId.value),
    default: () => [],
    deep: false,
    dedupe: 'defer',
  },
);

/** 一次只展開一輪 —— 和支出列表的 openId 同一套做法,不會殘留一堆展開狀態 */
const openRoundId = ref<string | null>(null);

/**
 * 展開那一輪的明細。key 帶 roundId,所以同一輪收起再展開會沿用已抓到的資料;
 * 但結算 / 撤銷之後一定要 refresh,不然會顯示過期的快照。
 */
const detailState = useAsyncData<RoundDetail | null>(
  () => `round-detail:${tripId.value}:${openRoundId.value ?? ''}`,
  () => {
    const id = openRoundId.value;
    if (!id) return Promise.resolve(null);
    return api.get<RoundDetail>(
      `/api/trips/${encodeURIComponent(tripId.value)}/rounds/${encodeURIComponent(id)}`,
    );
  },
  {
    // 刻意**不用 enabled**。這裡靠的是「反應式 key 變了就重抓」——
    // 和 useTrip / balance 同一個機制,已知有效。
    // 用 enabled 從 false 翻成 true 來觸發第一次抓取是另一條路徑,
    // 萬一那條沒觸發,展開歷史就會永遠停在載入中(而且不會有任何錯誤訊息)。
    // 沒有 openRoundId 時 handler 直接回 null,不會打出任何請求。
    default: () => null,
    deep: false,
    dedupe: 'defer',
  },
);

/** GET /rounds/:id 的形狀。shared/types 沒有宣告(這頁是唯一的消費者)。 */
interface RoundDetail {
  id: string;
  currency: string;
  seq: number;
  label: string | null;
  note: string | null;
  created_at: string;
  reverted_at: string | null;
  items: Array<{
    id: string; description: string; amount_minor: number; spent_at: string;
    note?: string | null;
    payers: Array<{ member_id: string; amount_minor: number }>;
    shares: Array<{ member_id: string; amount_minor: number }>;
  }>;
  nets: Array<{ memberId: string; netMinor: number }>;
  transfers: Array<{
    id: string; from_member: string; to_member: string;
    currency: string; amount_minor: number; settled_at: string;
  }>;
}

const preview = computed<RoundPreview | null>(() => previewState.data.value ?? null);
const previewBlocks = computed<RoundPreviewBlock[]>(() => preview.value?.blocks ?? []);
const rounds = computed<SettlementRound[]>(() => roundsState.data.value ?? []);
const roundDetail = computed<RoundDetail | null>(() => detailState.data.value ?? null);

/** 被取消的請求(換頁 / 換 tripId)不是錯誤,不要顯示 */
function messageOf(raw: unknown): string | null {
  if (!raw || isAbortError(raw)) return null;
  return api.errorMessage(raw);
}
const previewError = computed(() => messageOf(previewState.error.value));
/** 第一次載入才顯示骨架;refresh 時保留舊面板不要跳空 */
const previewPending = computed(
  () => previewState.status.value === 'pending' && !preview.value,
);
const roundsError = computed(() => messageOf(roundsState.error.value));
const detailError = computed(() => messageOf(detailState.error.value));
const detailPending = computed(() => detailState.status.value === 'pending');
const roundsFirstLoad = computed(
  () => roundsState.status.value === 'pending' && rounds.value.length === 0,
);

function toggleRound(id: string): void {
  openRoundId.value = openRoundId.value === id ? null : id;
}

const refreshing = ref(false);
/**
 * 任何寫入之後都要重抓**全部四份**。
 *
 * 少抓一份就會出現「畫面上還是舊的」而使用者照著舊畫面再按一次 ——
 * 結算和標記還款都是寫真實金錢的操作,重複寫入就是重複要錢。
 */
async function reload(): Promise<void> {
  refreshing.value = true;
  try {
    // 'cancel':標記還款後一定要拿到重算過的結果,不能沿用可能在路上的舊請求
    await Promise.all([
      balanceState.refresh({ dedupe: 'cancel' }),
      previewState.refresh({ dedupe: 'cancel' }),
      roundsState.refresh({ dedupe: 'cancel' }),
      openRoundId.value ? detailState.refresh({ dedupe: 'cancel' }) : Promise.resolve(),
    ]);
  }
  finally {
    refreshing.value = false;
  }
}

// ── 逐幣別分區 ────────────────────────────────────────────────
interface TransferRow extends Transfer {
  key: string;
}
interface CurrencySection {
  code: string;
  /** 【日幣】【台幣】 */
  label: string;
  /** 兩端都是真人的轉帳建議 —— 這頁**只顯示這些**,也只有這些能按「標記已還款」 */
  transfers: TransferRow[];
  /** 真人的非零淨額,應收多的排前面。公費濾掉了(見下面 nets 的註解) */
  nets: Net[];
  /** 同幣別最大絕對淨額,bar 的分母 */
  maxAbs: number;
  /** 這個幣別淨額為 0(沒出現在 nets)的**真人**名字 */
  settledNames: string[];
  /**
   * 這個幣別的公費現況。null = 沒設公費 / 這個幣別的公費從沒經手過錢
   *   → 那一整塊不畫。
   */
  pot: PotLine | null;
  /** 這個幣別的結算預覽區塊。preview 還沒回來 / 抓失敗時是 null */
  preview: RoundPreviewBlock | null;
}

/** 卡片上方那一行公費要講的四個數字 —— 信封那一本帳的全部內容。 */
interface PotLine {
  /** 投入 − 付掉 − 已退還。>0 信封裡還有現金,<0 超支 */
  remainingMinor: number;
  contributedMinor: number;
  spentMinor: number;
  refundedMinor: number;
}

/**
 * 幣別 → 這個幣別的公費現況。
 *
 * 刻意讀 `pot.by_currency[]` 而不是從 nets 反推公費那一列:那幾個欄位
 * 總覽頁本來就在用(標題是「投入 / 已支出 / 剩餘」),兩頁指到同一組數字,
 * 使用者跨頁對帳時不會看到兩個「差不多但不一樣」的金額。
 *
 * 這裡是信封那一本帳唯一的來源 —— 結算的算術裡根本沒有公費(見 utils/ledger.ts),
 * 所以沒有第二條路徑可以對照。那是刻意的取捨:換來的是信封變成一個
 * 可以獨立對帳的現金餘額,而不是一個要靠淨額反推的量。
 */
const potByCurrency = computed<Record<string, PotLine>>(() => {
  const out: Record<string, PotLine> = {};
  for (const r of balance.value?.pot?.by_currency ?? []) {
    // 三個數字全是 0 = 這個幣別的信封從來沒動過,那一塊不必畫。
    if (!r.contributedMinor && !r.spentMinor && !r.refundedMinor) continue;
    out[r.currency] = {
      remainingMinor: r.remainingMinor,
      contributedMinor: r.contributedMinor,
      spentMinor: r.spentMinor,
      refundedMinor: r.refundedMinor,
    };
  }
  return out;
});

const sections = computed<CurrencySection[]>(() => {
  const b = balance.value;
  if (!b) return [];
  const base = b.base_currency;

  // 外幣(旅行中真正在花的那個)排前面,本位幣排最後 —— 順序固定,
  // 標記還款後區塊不會上下跳。
  const codes = Object.keys(b.by_currency).sort((a, c) => {
    const aBase = a === base ? 1 : 0;
    const cBase = c === base ? 1 : 0;
    if (aBase !== cBase) return aBase - cBase;
    return a.localeCompare(c);
  });

  const touchesPot = (t: Transfer) => !!potId.value
    && (t.from === potId.value || t.to === potId.value);

  return codes.map((code) => {
    const bucket = b.by_currency[code]!;
    /*
      公費本來就不在 bucket.nets 裡(見 server/utils/ledger.ts:它不進算術)。
      這個 filter 因此是**防線**而不是功能:萬一哪天公費重新進了淨額,
      這頁也不會把它畫成一列「應收 / 應付」—— 那兩個詞套在一個信封上是錯的。
    */
    const nets = (bucket.nets ?? [])
      .filter(n => n.memberId !== potId.value)
      .sort((a, c) => c.netMinor - a.netMinor);
    const withNet = new Set(nets.map(n => n.memberId));

    /*
      ⚠️ 只渲染 recorded(兩端都是真人)。公費不在 nets 裡(見 utils/ledger.ts),
      所以 minCashFlow 根本生不出碰到它的腿 —— deferred 恆為空。
      這兩個欄位留著當**防線**:萬一哪天公費重新進了淨額,它的腿會落進 deferred
      而不是被寫成真的轉帳(那等於第一晚就把信封清空,而那筆錢明天還要用)。
      server 的 balance 已經直接給 recorded;萬一是舊版沒有這個欄位,
      就用 potId 自己濾一次,不要退回「全部都能按」。
    */
    const recorded = bucket.recorded ?? (bucket.transfers ?? []).filter(t => !touchesPot(t));

    return {
      code,
      label: CURRENCY_LABEL[code] ?? code,
      // 大筆的排前面:先處理金額大的那幾筆最有感
      transfers: [...recorded]
        .sort((a, c) => c.amountMinor - a.amountMinor)
        .map((t, i) => ({ ...t, key: `${code}:${t.from}:${t.to}:${i}` })),
      nets,
      maxAbs: nets.reduce((max, n) => Math.max(max, Math.abs(n.netMinor)), 0),
      // server 的 nets 已濾掉 0,所以這些人就是已結清的人。
      // 不畫成一整列 ¥0,只在區塊底下列名字,免得洗掉真正要看的數字。
      // 公費不算在這裡面 —— 這張卡整張只講真人,公費出現在名單裡會讓人以為它是人。
      settledNames: people.value.filter(m => !withNet.has(m.id)).map(m => m.name),
      pot: potByCurrency.value[code] ?? null,
      preview: previewBlocks.value.find(p => p.currency === code) ?? null,
    };
  });
});

/**
 * preview 有、但 balance 沒有的幣別。
 *
 * 理論上兩邊都走 utils/ledger.ts 所以幣別集合一致,但明細與算術是兩個查詢 ——
 * 寧可多畫一塊,也不要讓某個幣別的結算面板整個消失。
 */
const orphanBlocks = computed<RoundPreviewBlock[]>(() => {
  const known = new Set(sections.value.map(s => s.code));
  return previewBlocks.value.filter(b => !known.has(b.currency));
});

const hasCurrencies = computed(() => sections.value.length > 0);
const openTransferCount = computed(
  () => sections.value.reduce((sum, s) => sum + s.transfers.length, 0),
);
/** 有共同花費,而且每個幣別都不需要人跟人之間再轉帳 */
const allSettled = computed(() => hasCurrencies.value && openTransferCount.value === 0);

/**
 * 「人跟人之間不用轉帳」底下那句話。
 *
 * 公費不進這頁的算術(見檔頭),所以「有淨額卻沒有轉帳建議」這個狀態
 * **不可能發生**了 —— nets 非空就一定配得出至少一條腿。
 * 留著那個分支是防線:真的走到了代表 minCashFlow 出了問題,
 * 而那時候說「已結清」會讓人把一筆沒清掉的債當成清了。
 */
function noTransferHint(s: CurrencySection): string {
  if (!s.nets.length) return `所有人在${s.label}的墊款都對得上了。`;
  return `所有人在${s.label}的墊款彼此都對得上了。`;
}

// ── 每人這趟總花費(換算本位幣的估算值) ──────────────────────
interface MemberTotalRow {
  id: string;
  name: string;
  sharedOwedBase: number;
  personalBase: number;
  totalBase: number;
  unconverted: number;
}

const ZERO_TOTALS = { sharedOwedBase: 0, personalBase: 0, totalBase: 0, unconverted: 0 };

const memberTotals = computed<MemberTotalRow[]>(() => {
  const b = balance.value;
  if (!b) return [];
  const perMember = b.per_member ?? {};

  /*
    只列真人。公費**不出現在這張表裡** —— 它不會有分攤,所以永遠是一列全 0,
    而那一列除了雜訊什麼都不是,還會讓人以為公費是第三個旅伴。
    (總覽頁的「每人合計」早就是這樣做的,兩頁要一致。)
  */
  const rows: MemberTotalRow[] = people.value.map(m => ({
    id: m.id,
    name: m.name,
    // per_member 只含「有分攤記錄」的人,沒花錢的成員也要出現(顯示 0),
    // 不然名單少一個人會讓人以為漏帳。
    ...(perMember[m.id] ?? ZERO_TOTALS),
  }));

  /*
    反過來:per_member 有、上面那份名單沒有的 id 也要補上,不要靜靜漏掉一筆錢。
    兩種情況會走到這裡:
      ① 成員被刪掉了,但他的分攤還在(那筆錢要看得見)
      ② **公費身上出現了分攤** —— 那是資料壞掉(有人把公費放進分攤名單,
         或把已經有帳的成員改標成公費),那會讓信封的餘額和實際狀況對不上。
    所以上面排除公費、這裡不排除,是刻意的:正常情況它不出現,
    真的出事的時候它必須出現,而不是被藏起來。
  */
  const known = new Set(rows.map(r => r.id));
  for (const [id, v] of Object.entries(perMember)) {
    if (!known.has(id)) rows.push({ id, name: memberName(id), ...v });
  }

  return rows.sort((a, c) => c.totalBase - a.totalBase || a.name.localeCompare(c.name));
});

const baseCurrency = computed(() => balance.value?.base_currency ?? 'TWD');
const baseLabel = computed(() => CURRENCY_LABEL[baseCurrency.value] ?? baseCurrency.value);

const grandTotals = computed(() => memberTotals.value.reduce(
  (acc, r) => ({
    shared: acc.shared + r.sharedOwedBase,
    personal: acc.personal + r.personalBase,
    total: acc.total + r.totalBase,
    unconverted: acc.unconverted + r.unconverted,
  }),
  { shared: 0, personal: 0, total: 0, unconverted: 0 },
));

/** 全部是 0 又沒有無法換算的紀錄 → 這趟還沒開始記帳,不要畫一堆 0 */
const showTotals = computed(
  () => memberTotals.value.length > 0
    && (grandTotals.value.total !== 0 || grandTotals.value.unconverted > 0),
);

// ── 標記已還款 ────────────────────────────────────────────────
interface PendingSettle {
  key: string;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  currency: string;
  amountMinor: number;
}

const confirmOpen = ref(false);
const pending = ref<PendingSettle | null>(null);
const posting = ref(false);
const postError = ref<string | null>(null);

function askSettle(section: CurrencySection, t: TransferRow): void {
  pending.value = {
    key: t.key,
    from: t.from,
    to: t.to,
    fromName: memberName(t.from),
    toName: memberName(t.to),
    currency: section.code,
    amountMinor: t.amountMinor,
  };
  postError.value = null;
  confirmOpen.value = true;
}

async function confirmSettle(): Promise<void> {
  const t = pending.value;
  if (!t || posting.value) return;
  posting.value = true;
  postError.value = null;
  try {
    // 這支收的是 amount_minor(最小單位整數),和新增支出的人類單位 amount 不同。
    // 原封不動把 balance 給的數字送回去,才不會差一分錢讓餘額永遠歸不了零。
    await api.post(`/api/trips/${encodeURIComponent(tripId.value)}/settlements`, {
      from_member: t.from,
      to_member: t.to,
      currency: t.currency,
      amount_minor: t.amountMinor,
    });
    confirmOpen.value = false;
    flash(`已記下還款:${t.fromName} → ${t.toName} ${formatMoney(t.amountMinor, t.currency)}`);
    await reload();
  }
  catch (e) {
    // 錯誤留在面板裡,使用者可以直接再試一次,不用重新找那張卡
    postError.value = (e as Error).message;
  }
  finally {
    posting.value = false;
  }
}

// ── 關閉一次結算回合 ──────────────────────────────────────────
/**
 * **單階段。** 關閉回合等於宣告「這些錢已經付了」,沒有 paid_at、沒有「之後再逐筆勾」。
 *
 * 兩階段(先產生待付清單、之後逐筆標記)會讓同一筆債同時出現在回合裡
 * 和上面的「標記已還款」按鈕旁,而兩邊都沒有 idempotency ——
 * 點兩次就會在 1,500 的債上記下 3,000,然後帳本開始要求反向轉帳。
 * 所以確認面板必須把「這是已付款的宣告」講到不可能誤解;
 * 想要部分付款的人應該不要關回合,先用上面的按鈕逐筆標記。
 */
const closeOpen = ref(false);
const closeTarget = ref<RoundPreviewBlock | null>(null);
const closeLabel = ref('');
const closing = ref(false);
const closeError = ref<string | null>(null);

/** 收 null 也不會炸:模板裡 v-if 過的東西,TS 在事件處理器上看不出已經 narrow 過 */
function askClose(block: RoundPreviewBlock | null): void {
  if (!block) return;
  closeTarget.value = block;
  closeLabel.value = '';
  closeError.value = null;
  closeOpen.value = true;
}

const closeRecorded = computed(() => closeTarget.value?.recorded ?? []);
const closeRecordedTotal = computed(
  () => closeRecorded.value.reduce((s, t) => s + t.amountMinor, 0),
);
const closeCurrencyLabel = computed(() => {
  const code = closeTarget.value?.currency ?? '';
  return CURRENCY_LABEL[code] ?? code;
});

async function confirmClose(): Promise<void> {
  const b = closeTarget.value;
  if (!b || closing.value) return;
  closing.value = true;
  closeError.value = null;
  try {
    /*
      expect 是「我看到的畫面長這樣」的指紋。兩個人同時操作時,
      server 會拿它跟現況核對,不一致就回 409 叫我們重新整理 ——
      否則會照著舊畫面關掉一個內容已經變了的回合(例如別人剛記了一筆帳,
      那筆會被蓋章進這一輪,但轉帳金額是舊的)。
    */
    const res = await api.post<{ id: string; seq: number }>(
      `/api/trips/${encodeURIComponent(tripId.value)}/rounds`,
      {
        currency: b.currency,
        label: closeLabel.value.trim() || undefined,
        expect: { item_count: b.item_count, recorded_count: (b.recorded ?? []).length },
      },
    );
    closeOpen.value = false;
    const n = (b.recorded ?? []).length;
    flash(
      `已完成【${CURRENCY_LABEL[b.currency] ?? b.currency}】第 ${res?.seq ?? b.seq} 次結算`
      + `:${b.item_count} 筆明細已標記為「已列入第 ${res?.seq ?? b.seq} 次結算」`
      + (n ? `,${n} 筆轉帳已記為已付款。` : '。'),
    );
    // 剛結完的那一輪自動展開,使用者馬上看得到「記下了什麼」
    if (res?.id) openRoundId.value = res.id;
    await reload();
  }
  catch (e) {
    // 錯誤留在面板裡(尤其 409「請重新整理再結算」),不要把使用者丟回頁面
    closeError.value = (e as Error).message;
  }
  finally {
    closing.value = false;
  }
}

// ── 撤銷一次結算回合 ──────────────────────────────────────────
/**
 * 誤按「結算」是會發生的事,而結算寫的是真實金錢的紀錄。
 * 撤銷會刪掉這一輪產生的轉帳(只有 source='round' 的)、把章拆掉,
 * 並留下 reverted_at —— 那一列不會消失,帳上看得出「這裡曾經結算過又撤銷」。
 */
const revertOpen = ref(false);
const revertTarget = ref<SettlementRound | null>(null);
const reverting = ref(false);
const revertError = ref<string | null>(null);

/** 有寫入正在進行 → 其他寫入按鈕全部鎖住,不要讓同一個人同時改兩處帳 */
const busy = computed(() => posting.value || closing.value || reverting.value);

function askRevert(round: SettlementRound): void {
  revertTarget.value = round;
  revertError.value = null;
  revertOpen.value = true;
}

async function confirmRevert(): Promise<void> {
  const r = revertTarget.value;
  if (!r || reverting.value) return;
  reverting.value = true;
  revertError.value = null;
  try {
    await api.del(
      `/api/trips/${encodeURIComponent(tripId.value)}/rounds/${encodeURIComponent(r.id)}`,
    );
    revertOpen.value = false;
    flash(
      `已撤銷【${CURRENCY_LABEL[r.currency] ?? r.currency}】第 ${r.seq} 次結算`
      + `:${r.transfer_count} 筆轉帳已刪除,${r.item_count} 筆明細回到「還沒結算」。`,
    );
    // 保持展開:撤銷後那一輪的內容會變空,使用者要看得到「真的撤掉了」
    openRoundId.value = r.id;
    await reload();
  }
  catch (e) {
    revertError.value = (e as Error).message;
  }
  finally {
    reverting.value = false;
  }
}

// ── 成功提示 ──────────────────────────────────────────────────
const flashMessage = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function flash(message: string): void {
  flashMessage.value = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashMessage.value = null;
  }, 6000);
}

onBeforeUnmount(() => clearTimeout(flashTimer));
</script>

<template>
  <div class="space-y-5 md:space-y-6">
    <!-- ───────── 頁首 ───────── -->
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-xl leading-tight font-semibold md:text-2xl">結算</h2>
        <p class="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
          誰要給誰多少錢。日幣和台幣各自結算,不會加在一起。
        </p>
      </div>
      <UiAppButton
        variant="ghost"
        icon="lucide:refresh-cw"
        aria-label="重新計算"
        :loading="refreshing"
        @click="reload"
      />
    </header>

    <!-- ───────── 記下還款的成功提示 ───────── -->
    <Transition name="flash">
      <div
        v-if="flashMessage"
        class="card flex items-start gap-2.5 p-3.5"
        role="status"
        style="border-color: color-mix(in oklab, var(--credit) 38%, var(--border))"
      >
        <Icon
          name="lucide:circle-check"
          size="18"
          class="mt-px shrink-0"
          style="color: var(--credit)"
        />
        <p class="min-w-0 flex-1 text-sm leading-relaxed">{{ flashMessage }}</p>
        <button
          type="button"
          class="-m-1 shrink-0 rounded-full p-1 text-[var(--text-muted)] transition active:scale-90"
          aria-label="關閉提示"
          @click="flashMessage = null"
        >
          <Icon name="lucide:x" size="16" />
        </button>
      </div>
    </Transition>

    <!-- ───────── 載入 / 錯誤 ───────── -->
    <template v-if="firstLoad">
      <div class="space-y-3">
        <div class="h-5 w-24 animate-pulse rounded-md bg-[var(--bg-sunken)]" />
        <div class="grid gap-2.5 lg:grid-cols-2">
          <UiLoadingBlock :rows="2" label="正在計算結算金額" />
          <UiLoadingBlock :rows="2" class="hidden lg:block" />
        </div>
        <div class="card p-4">
          <UiLoadingBlock :rows="3" variant="plain" />
        </div>
      </div>
    </template>

    <div
      v-else-if="loadError && !balance"
      class="card p-5 text-center"
      style="border-color: color-mix(in oklab, var(--debit) 35%, var(--border))"
    >
      <Icon
        name="lucide:cloud-alert"
        size="26"
        class="mx-auto mb-2"
        style="color: var(--debit)"
      />
      <p class="text-sm font-semibold">算不出結算金額</p>
      <p class="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-[var(--text-muted)]">
        {{ loadError }}
      </p>
      <UiAppButton
        class="mt-4"
        variant="ghost"
        icon="lucide:rotate-cw"
        :loading="refreshing"
        @click="reload"
      >
        再試一次
      </UiAppButton>
    </div>

    <template v-else-if="balance">
      <!-- refresh 失敗時舊數字還在畫面上,要講清楚「這不是最新的」 -->
      <p
        v-if="loadError"
        class="flex items-start gap-2 text-xs leading-relaxed"
        style="color: var(--warn)"
      >
        <Icon name="lucide:triangle-alert" size="14" class="mt-px shrink-0" />
        <span>重新計算失敗({{ loadError }})。下面顯示的是上一次算出來的結果。</span>
      </p>

      <!-- ───────── 總覽 ───────── -->
      <section
        v-if="allSettled"
        class="card p-6 text-center"
        style="border-color: color-mix(in oklab, var(--credit) 38%, var(--border))"
      >
        <div class="settled-badge">
          <Icon name="lucide:check-check" size="26" />
        </div>
        <p class="text-base font-semibold">人跟人之間已經全部結清</p>
        <p class="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-[var(--text-muted)]">
          每個幣別的墊款都對得上,沒有人需要再轉帳給誰。之後再記共同花費,這裡會重新算。
        </p>
        <!--
          有設公費就留一句指路:人跟人之間清乾淨了不等於整趟結束了,
          信封裡可能還有現金。金額不寫在這裡 —— 各幣別的那一行已經有了,
          這裡只負責讓人知道還有一步要做。
        -->
        <p
          v-if="potId"
          class="mx-auto mt-2.5 max-w-sm text-xs leading-relaxed text-[var(--text-muted)]"
        >
          {{ potName }}裡如果還有現金,旅程結束到「總覽」按「退還」分回去 ——
          那一步不會出現在這頁的轉帳清單裡。
        </p>
      </section>

      <section v-else-if="hasCurrencies" class="card flex items-center gap-3.5 p-4">
        <div class="open-badge">
          <Icon name="lucide:arrow-left-right" size="20" />
        </div>
        <div class="min-w-0">
          <p class="text-sm font-semibold">
            還有 <span class="tnum">{{ openTransferCount }}</span> 筆款要轉
          </p>
          <p class="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
            分 <span class="tnum">{{ sections.length }}</span> 個幣別各自結算。
            一次結掉整輪用各幣別的「結算這一輪」;只有某個人先還了錢就按那一筆的「標記已還款」。
          </p>
        </div>
      </section>

      <!-- ───────── 還沒有共同花費 ───────── -->
      <section v-if="!hasCurrencies" class="card">
        <UiEmptyState
          icon="lucide:scale"
          title="還沒有東西可以結算"
          description="結算要有「誰付了錢、誰要分攤」才算得出來。記一筆共同花費、選好付款人和分攤的人,這頁就會告訴你誰該給誰多少。"
        >
          <UiAppButton :to="`/t/${tripId}/new`" icon="lucide:plus">
            記一筆共同花費
          </UiAppButton>
        </UiEmptyState>
      </section>

      <!-- ───────── 逐幣別區塊 ───────── -->
      <section
        v-for="s in sections"
        :key="s.code"
        class="space-y-3"
        :aria-label="`${s.label}結算`"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 class="text-lg font-semibold">
            【{{ s.label }}】<span class="ml-1 text-xs font-normal text-[var(--text-muted)]">{{ s.code }}</span>
          </h3>
          <p class="text-xs text-[var(--text-muted)]">
            <!-- 「已簡化」不是「最少」:最小化轉帳筆數可歸約到 Subset Sum,是 NP-Complete -->
            <template v-if="s.transfers.length">
              已簡化為 <span class="tnum font-medium text-[var(--text)]">{{ s.transfers.length }}</span> 筆轉帳
            </template>
            <!-- 還有淨額卻沒有轉帳建議 → 剩下的都在信封那一段,不能說「已結清」 -->
            <template v-else-if="s.nets.length">人跟人之間不用轉帳</template>
            <template v-else>這個幣別已結清</template>
          </p>
        </div>

        <!--
          轉帳建議。兩欄從 lg 才開始:md 的時候左側 rail 已經吃掉 240px,
          剩下的寬度切兩半會把名字擠成「小…」,不如先維持單欄。
        -->
        <div v-if="s.transfers.length" class="grid gap-2.5 lg:grid-cols-2">
          <SettleTransferCard
            v-for="t in s.transfers"
            :key="t.key"
            :from-name="memberName(t.from)"
            :to-name="memberName(t.to)"
            :amount-minor="t.amountMinor"
            :currency="s.code"
            :loading="posting && pending?.key === t.key"
            :disabled="busy && pending?.key !== t.key"
            @settle="askSettle(s, t)"
          />
        </div>
        <!-- 只有部分幣別結清時才提示;全部結清時上面的總覽已經講過了,不要重複三次 -->
        <div v-else-if="!allSettled" class="card">
          <UiEmptyState
            dense
            icon="lucide:circle-check"
            title="人跟人之間不用轉帳"
            :description="noTransferHint(s)"
          />
        </div>

        <p v-if="s.transfers.length" class="px-1 text-xs leading-relaxed text-[var(--text-muted)]">
          某個人先把錢還了 → 按那一筆的「標記已還款」。
          今晚要一次把整輪結掉 → 用下面的「本次要結算」。
        </p>

        <!-- 每人淨額 -->
        <div v-if="s.nets.length || s.settledNames.length" class="card overflow-hidden">
          <div class="row-head flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2.5">
            <h4 class="text-xs font-semibold">每人淨額</h4>
            <p class="text-[0.6875rem] text-[var(--text-muted)]">
              綠 + = 應收(還可以收回)· 紅 − = 應付(還要付出去)
            </p>
          </div>

          <!--
            公費現況。放在真人淨額的**上面**、而且刻意長得不像一列淨額 ——
            它和下面那排數字**沒有任何加總關係**(兩本分開的帳,見檔頭)。
            它在這裡只回答一個問題:信封現在還有多少錢。

            第二行要同時講清楚兩件事:這個數字怎麼來的,以及
            **現在不要去動它** —— 少了後半句,看到一筆餘額的人會直接開始
            跟朋友分錢,而那筆現金明天還要買車票。
          -->
          <div v-if="s.pot" class="pot-line">
            <div class="flex items-baseline justify-between gap-3">
              <p class="flex items-center gap-1.5 text-xs font-semibold">
                <Icon
                  name="lucide:piggy-bank"
                  size="14"
                  class="shrink-0"
                  style="color: var(--brand)"
                />
                {{ potName }}{{ s.pot.remainingMinor < 0 ? '超支' : '還剩' }}
              </p>
              <UiMoney
                :minor="Math.abs(s.pot.remainingMinor)"
                :currency="s.code"
              />
            </div>

            <p class="mt-1.5 text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
              投入 <span class="tnum">{{ formatMoney(s.pot.contributedMinor, s.code) }}</span>
              <template v-if="s.pot.spentMinor">
                、{{ potName }}付掉 <span class="tnum">{{ formatMoney(s.pot.spentMinor, s.code) }}</span>
              </template>
              <template v-if="s.pot.refundedMinor">
                、已退還 <span class="tnum">{{ formatMoney(s.pot.refundedMinor, s.code) }}</span>
              </template>。
              <template v-if="s.pot.remainingMinor > 0">
                <b>那筆錢明天還要用,不用現在轉帳</b> —— 旅程結束到「總覽」按「退還」分回去。
              </template>
              <template v-else-if="s.pot.remainingMinor < 0">
                {{ potName }}付出去的比手上的多,差額是當時付錢的人先墊著的 ——
                到「總覽」按「投入{{ potName }}」補上。
              </template>
              <template v-else>
                信封剛好用完。
              </template>
              <span class="block mt-1">
                {{ potName }}付掉的支出不會出現在下面的淨額裡 ——
                那筆錢在記帳當下就從信封扣掉了,沒有人要為它還錢給誰。
              </span>
            </p>
          </div>

          <div class="divided">
            <SettleMemberBalanceRow
              v-for="n in s.nets"
              :key="n.memberId"
              :name="memberName(n.memberId)"
              :net-minor="n.netMinor"
              :currency="s.code"
              :ratio="s.maxAbs ? Math.abs(n.netMinor) / s.maxAbs : 0"
            />

            <p
              v-if="s.settledNames.length"
              class="flex items-start gap-2 px-4 py-3 text-xs leading-relaxed text-[var(--text-muted)]"
            >
              <Icon name="lucide:check" size="14" class="mt-0.5 shrink-0" />
              <span>
                <template v-if="s.nets.length">其他人在{{ s.label }}沒有未結的金額:</template>
                <template v-else>所有人在{{ s.label }}都沒有未結的金額:</template>
                {{ s.settledNames.join('、') }}
              </span>
            </p>
          </div>
        </div>

        <!-- ── 本次要結算(明細 → 結果 → 結算)── -->
        <SettleRoundPanel
          v-if="s.preview"
          :block="s.preview"
          :names="memberMap"
          :pot-id="potId"
          :pot-name="potName"
          :closing="closing && closeTarget?.currency === s.code"
          :disabled="busy && closeTarget?.currency !== s.code"
          @close="askClose(s.preview)"
        />
        <UiLoadingBlock
          v-else-if="previewPending && !previewError"
          :rows="2"
          label="正在整理這次要結算的明細"
        />
        <p
          v-else-if="previewError"
          class="flex items-start gap-2 px-1 text-xs leading-relaxed"
          style="color: var(--warn)"
        >
          <Icon name="lucide:triangle-alert" size="14" class="mt-px shrink-0" />
          <span>
            載不到「本次要結算」的明細({{ previewError }})。上面的淨額與轉帳建議還是正確的,
            只是現在沒辦法結算這一輪。
          </span>
        </p>
      </section>

      <!--
        preview 有、balance 沒有的幣別。兩邊都走同一份 ledger 所以理論上不會發生,
        但寧可多畫一塊,也不要讓某個幣別的結算面板整個消失(那會掉錢)。
      -->
      <section
        v-for="b in orphanBlocks"
        :key="`orphan:${b.currency}`"
        class="space-y-3"
        :aria-label="`${b.currency}結算`"
      >
        <h3 class="text-lg font-semibold">
          【{{ CURRENCY_LABEL[b.currency] ?? b.currency }}】<span
            class="ml-1 text-xs font-normal text-[var(--text-muted)]"
          >{{ b.currency }}</span>
        </h3>
        <SettleRoundPanel
          :block="b"
          :names="memberMap"
          :pot-id="potId"
          :pot-name="potName"
          :closing="closing && closeTarget?.currency === b.currency"
          :disabled="busy && closeTarget?.currency !== b.currency"
          @close="askClose(b)"
        />
      </section>

      <!-- ───────── 每人這趟總花費 ───────── -->
      <section v-if="showTotals" class="space-y-3">
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 class="text-lg font-semibold">每人這趟花費</h3>
          <p class="text-xs text-[var(--text-muted)]">
            換算成{{ baseLabel }}的估算值
          </p>
        </div>

        <!-- 全隊合計。共同 + 個人 = 這趟總支出 -->
        <div class="card p-4">
          <div class="flex items-baseline justify-between gap-3">
            <p class="text-xs text-[var(--text-muted)]">這趟總支出(全員)</p>
            <UiMoney :minor="grandTotals.total" :currency="baseCurrency" size="lg" />
          </div>
          <div class="hairline mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 pt-3">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-xs text-[var(--text-muted)]">共同花費</span>
              <UiMoney :minor="grandTotals.shared" :currency="baseCurrency" size="sm" />
            </div>
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-xs text-[var(--text-muted)]">個人花費</span>
              <UiMoney :minor="grandTotals.personal" :currency="baseCurrency" size="sm" />
            </div>
          </div>
        </div>

        <p
          v-if="grandTotals.unconverted > 0"
          class="flex items-start gap-2 text-xs leading-relaxed"
          style="color: var(--warn)"
        >
          <Icon name="lucide:triangle-alert" size="14" class="mt-px shrink-0" />
          <span>
            有 <span class="tnum">{{ grandTotals.unconverted }}</span> 筆沒有匯率無法換算,
            沒有計入下面的{{ baseLabel }}合計。上面各幣別的結算金額不受影響。
          </span>
        </p>

        <div class="card overflow-hidden">
          <!-- md 以上是表格,欄名放這裡;手機每個數字自己帶標籤 -->
          <div class="row-head hidden md:grid md:grid-cols-[minmax(0,1fr)_repeat(3,6rem)] md:items-center md:gap-3 md:px-4 md:py-2.5">
            <span class="text-xs font-semibold">成員</span>
            <span class="text-right text-xs font-semibold text-[var(--text-muted)]">共同分攤</span>
            <span class="text-right text-xs font-semibold text-[var(--text-muted)]">個人花費</span>
            <span class="text-right text-xs font-semibold">我合計</span>
          </div>

          <div class="divided">
            <div
              v-for="r in memberTotals"
              :key="r.id"
              class="px-4 py-3 md:grid md:grid-cols-[minmax(0,1fr)_repeat(3,6rem)] md:items-center md:gap-3"
            >
              <div class="flex min-w-0 items-center gap-3">
                <span class="avatar">{{ [...(r.name.trim() || '?')][0] }}</span>
                <div class="min-w-0">
                  <p class="truncate text-sm leading-tight font-medium">{{ r.name }}</p>
                  <p
                    v-if="r.unconverted > 0"
                    class="mt-0.5 flex items-center gap-1 text-[0.6875rem] leading-none"
                    style="color: var(--warn)"
                  >
                    <Icon name="lucide:triangle-alert" size="11" />
                    <span><span class="tnum">{{ r.unconverted }}</span> 筆無匯率未計入</span>
                  </p>
                </div>
              </div>

              <!--
                md:contents 讓這三格在 md 以上直接變成表格的三欄。
                手機是兩欄 + 「我合計」獨立一行:窄螢幕塞三個金額會擠到溢出,
                而且使用者最在意的就是合計,給它自己一行剛好。
              -->
              <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 md:mt-0 md:contents">
                <div class="md:text-right">
                  <p class="text-[0.6875rem] leading-none text-[var(--text-muted)] md:hidden">共同分攤</p>
                  <p class="mt-1 text-[var(--text-muted)] md:mt-0">
                    <UiMoney :minor="r.sharedOwedBase" :currency="baseCurrency" />
                  </p>
                </div>
                <div class="md:text-right">
                  <p class="text-[0.6875rem] leading-none text-[var(--text-muted)] md:hidden">個人花費</p>
                  <p class="mt-1 text-[var(--text-muted)] md:mt-0">
                    <UiMoney :minor="r.personalBase" :currency="baseCurrency" />
                  </p>
                </div>
                <!-- 邊框用 Tailwind 而非 scoped class:scoped 選擇器的 specificity 較高,
                     md:border-t-0 會蓋不掉 -->
                <div
                  class="col-span-2 flex items-baseline justify-between gap-2 border-t border-[var(--border)] pt-2
                         md:col-span-1 md:block md:border-t-0 md:pt-0 md:text-right"
                >
                  <p class="text-[0.6875rem] text-[var(--text-muted)] md:hidden">我合計</p>
                  <UiMoney :minor="r.totalBase" :currency="baseCurrency" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <p class="px-1 text-xs leading-relaxed text-[var(--text-muted)]">
          「我合計」= 共同花費裡我該分攤的 + 我自己的個人花費。這是換算成{{ baseLabel }}後的估算,
          不是任何一個幣別的結算金額。
        </p>
      </section>

      <!-- ───────── 這些數字怎麼來的(必須顯示) ───────── -->
      <section class="card p-4">
        <h3 class="flex items-center gap-2 text-sm font-semibold">
          <Icon name="lucide:info" size="16" class="shrink-0 text-[var(--text-muted)]" />
          關於這些數字
        </h3>
        <ul class="mt-2.5 space-y-2 text-xs leading-relaxed text-[var(--text-muted)]">
          <li>{{ balance.disclaimer }}</li>
          <li>
            轉帳建議是把彼此的債務抵銷後的簡化結果,不保證是筆數最少的組合;
            金額一定對得上,筆數可能還有別的組法。
          </li>
          <li>每個幣別各自結算。跨幣別的換算只用在上面的「這趟花費」參考數字,不會混進轉帳金額。</li>
          <li>
            每人淨額 = 他自己先墊掉的 − 他該分攤的 − 他已經收到的還款。
          </li>
          <li v-if="potId">
            <strong class="font-medium text-[var(--text)]">{{ potName }}完全不進這頁的算術</strong> ——
            用{{ potName }}付的錢在記帳當下就從信封扣掉了,不追究是誰用的,
            所以它一毛人對人的債都不產生;投入 / 退還也只是把現金搬進搬出信封,
            不是還款。
            <br>
            換句話說:<b>某個人先墊了錢,就是他墊的</b>,不會因為他拿出多少
            {{ potName }}而變多或變少。{{ potName }}還剩多少是另一本帳,在「總覽」。
          </li>
          <li>
            結算的<strong class="font-medium text-[var(--text)]">明細</strong>只列還沒列入任何結算的那幾筆,
            但<strong class="font-medium text-[var(--text)]">金額</strong>一律是把整趟到現在的共同花費<template
              v-if="potId"
            >(含{{ potName }}付掉的)</template>一起算出來的。
            只算未結的那一小段會重複要錢,所以刻意不那樣算。
          </li>
          <li>
            結算過的支出會標記成「已列入第 N 次結算」,而不是「已結清」——
            債務是由那一輪的轉帳整體清掉的,不是一筆一筆對消。
          </li>
        </ul>
        <p class="attribution mt-3 pt-3 text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
          {{ balance.rate_attribution }}
        </p>
      </section>
    </template>

    <!--
      ───────── 結算歷史 ─────────
      刻意放在 balance 的 v-if 之外:幾個月後回來查「這 1,850 是什麼」
      不該被今天算不出淨額(網路 / 匯率)擋住。
    -->
    <section class="space-y-3" aria-label="結算歷史">
      <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 class="text-lg font-semibold">結算歷史</h3>
        <p v-if="rounds.length" class="text-xs text-[var(--text-muted)]">
          共 <span class="tnum font-medium text-[var(--text)]">{{ rounds.length }}</span> 次
        </p>
      </div>

      <UiLoadingBlock v-if="roundsFirstLoad" :rows="2" label="正在載入結算歷史" />

      <div
        v-else-if="roundsError && !rounds.length"
        class="card p-4 text-center"
        style="border-color: color-mix(in oklab, var(--debit) 35%, var(--border))"
      >
        <p class="text-sm leading-relaxed" style="color: var(--debit)">{{ roundsError }}</p>
        <UiAppButton
          class="mt-3"
          variant="ghost"
          icon="lucide:rotate-cw"
          :loading="refreshing"
          @click="reload"
        >
          再試一次
        </UiAppButton>
      </div>

      <div v-else-if="!rounds.length" class="card">
        <UiEmptyState
          dense
          icon="lucide:history"
          title="還沒有結算過"
          description="每天晚上(或旅程結束)按一次「結算這一輪」,這裡就會留下那一次列入了哪些明細、誰給誰多少。之後有人問起就答得出來。"
        />
      </div>

      <template v-else>
        <p class="px-1 text-xs leading-relaxed text-[var(--text-muted)]">
          點開任一次就看得到當時列入的明細、記下的轉帳與淨額快照 ——
          幾個月後有人問「這筆錢是什麼」也答得出來。
        </p>
        <div class="space-y-2.5">
          <SettleRoundHistoryCard
            v-for="r in rounds"
            :key="r.id"
            :round="r"
            :names="memberMap"
            :pot-id="potId"
            :expanded="openRoundId === r.id"
            :detail="openRoundId === r.id ? roundDetail : null"
            :loading="openRoundId === r.id && detailPending"
            :error="openRoundId === r.id ? detailError : null"
            :reverting="reverting && revertTarget?.id === r.id"
            :disabled="busy"
            @toggle="toggleRound(r.id)"
            @revert="askRevert(r)"
          />
        </div>
        <p
          v-if="roundsError"
          class="flex items-start gap-2 px-1 text-xs leading-relaxed"
          style="color: var(--warn)"
        >
          <Icon name="lucide:triangle-alert" size="14" class="mt-px shrink-0" />
          <span>重新載入歷史失敗({{ roundsError }})。上面是上一次拿到的清單。</span>
        </p>
      </template>
    </section>

    <!-- ───────── 標記已還款的確認 ───────── -->
    <UiAppSheet
      v-model:open="confirmOpen"
      title="標記已還款?"
      :dismissible="!posting"
      @close="postError = null"
    >
      <div v-if="pending">
        <div class="flex items-center justify-between gap-3 rounded-xl px-3.5 py-3" style="background: var(--bg-sunken)">
          <p class="min-w-0 text-sm">
            <span class="font-medium">{{ pending.fromName }}</span>
            <Icon name="lucide:arrow-right" size="14" class="mx-1.5 inline align-[-0.1em] text-[var(--text-muted)]" />
            <span class="font-medium">{{ pending.toName }}</span>
          </p>
          <UiMoney
            :minor="pending.amountMinor"
            :currency="pending.currency"
            with-label
            class="shrink-0"
          />
        </div>

        <p class="mt-3.5 text-sm leading-relaxed text-[var(--text-muted)]">
          這會記下一筆還款,結算金額會立刻重算。請先確認錢真的已經給出去了 ——
          記錄後沒辦法在畫面上刪掉。
        </p>

        <p
          v-if="postError"
          class="mt-3.5 flex items-start gap-2 text-sm leading-relaxed"
          style="color: var(--debit)"
        >
          <Icon name="lucide:triangle-alert" size="15" class="mt-0.5 shrink-0" />
          <span>{{ postError }}</span>
        </p>
      </div>

      <template #footer>
        <UiAppButton variant="ghost" block :disabled="posting" @click="confirmOpen = false">
          取消
        </UiAppButton>
        <UiAppButton block icon="lucide:check" :loading="posting" @click="confirmSettle">
          確認已還款
        </UiAppButton>
      </template>
    </UiAppSheet>

    <!--
      ───────── 結算這一輪的確認 ─────────
      這是**單階段**的:按下去就等於宣告那些錢已經付了,沒有「之後再標記已付」。
      所以這裡必須把它講到不可能誤解 —— 兩階段的設計會讓同一筆債
      同時出現在回合裡和「標記已還款」旁邊,點兩次就在 1,500 的債上記下 3,000。
    -->
    <UiAppSheet
      v-model:open="closeOpen"
      size="lg"
      :title="closeTarget ? `結算【${closeCurrencyLabel}】第 ${closeTarget.seq} 次?` : '結算這一輪?'"
      :dismissible="!closing"
      @close="closeError = null"
    >
      <div v-if="closeTarget">
        <!--
          最重要的一句話放最上面,不要藏在說明的第三行。
          ⚠️ 沒有轉帳的時候必須換一套說法 —— 「宣告 0 筆轉帳已經付了」
          既是廢話又會讓人以為自己漏看了什麼(實測踩到)。
        -->
        <p class="declare">
          <Icon name="lucide:circle-alert" size="16" class="mt-px shrink-0" style="color: var(--warn)" />
          <span v-if="closeRecorded.length">
            按下確認等於宣告下面
            <span class="tnum font-semibold">{{ closeRecorded.length }}</span> 筆轉帳
            <strong class="font-semibold">已經付了</strong>。
            這是一次完成的動作,<strong class="font-semibold">沒有「之後再標記已付」</strong>——
            錢還沒給出去就先不要結算。
            只有某幾個人先還了的話,回上一頁用那一筆的「標記已還款」比較準。
          </span>
          <span v-else>
            這一輪<strong class="font-semibold">沒有任何轉帳要記</strong>——
            算下來沒有人需要付錢給別人,所以按下確認<strong class="font-semibold">不會</strong>宣告任何人付了錢,
            只是把下面那些明細標記成已列入這一輪。
          </span>
        </p>

        <!-- 會被寫進帳的那些 -->
        <section v-if="closeRecorded.length" class="mt-4">
          <h4 class="sheet-title">會記下這些轉帳</h4>
          <SettleRoundTransferList
            :transfers="closeRecorded"
            :currency="closeTarget.currency"
            :names="memberMap"
            :pot-id="potId"
            tone="recorded"
          />
        </section>

        <ul class="mt-4 space-y-2 text-sm leading-relaxed text-[var(--text-muted)]">
          <li class="flex items-start gap-2">
            <Icon name="lucide:stamp" size="15" class="mt-0.5 shrink-0" />
            <span>
              <span class="tnum">{{ closeTarget.item_count }}</span> 筆明細會被標記成
              「已列入第 <span class="tnum">{{ closeTarget.seq }}</span> 次結算」。
              下次結算就從還沒標記的那些開始 —— 那是<strong class="font-medium text-[var(--text)]">顯示用的標記</strong>,
              不是「這一筆已結清」。
            </span>
          </li>
          <li v-if="closeRecorded.length" class="flex items-start gap-2">
            <Icon name="lucide:coins" size="15" class="mt-0.5 shrink-0" />
            <span>
              轉帳合計
              <span class="tnum font-medium text-[var(--text)]">
                {{ formatMoney(closeRecordedTotal, closeTarget.currency) }}
              </span>。
              金額是把整趟到現在的帳一起抵銷後的結果,不是上面那幾筆明細的加總。
            </span>
          </li>
          <!--
            這裡刻意**不列公費的腿**。它們的意思是「結束時退還多少 / 還要補多少」,
            是總覽頁的動作 —— 出現在「這一步會寫下什麼」的清單裡,
            只會讓人以為按下結算會動到信封裡的現金。
          -->
          <li class="flex items-start gap-2">
            <Icon name="lucide:undo-2" size="15" class="mt-0.5 shrink-0" />
            <span>按錯了可以在「結算歷史」撤銷,轉帳會刪掉、明細會回到還沒結算。</span>
          </li>
        </ul>

        <div class="mt-4">
          <UiAppField
            v-model="closeLabel"
            label="這次結算的標記(選填)"
            placeholder="例:第一晚對帳"
            hint="會顯示在結算歷史上,之後比較好認是哪一次。"
            :disabled="closing"
          />
        </div>

        <p
          v-if="closeError"
          class="mt-3.5 flex items-start gap-2 text-sm leading-relaxed"
          style="color: var(--debit)"
        >
          <Icon name="lucide:triangle-alert" size="15" class="mt-0.5 shrink-0" />
          <span>{{ closeError }}</span>
        </p>
      </div>

      <template #footer>
        <UiAppButton variant="ghost" block :disabled="closing" @click="closeOpen = false">
          取消
        </UiAppButton>
        <UiAppButton block icon="lucide:stamp" :loading="closing" @click="confirmClose">
          確認已付款並結算
        </UiAppButton>
      </template>
    </UiAppSheet>

    <!-- ───────── 撤銷結算的確認 ───────── -->
    <UiAppSheet
      v-model:open="revertOpen"
      size="sm"
      :title="revertTarget ? `撤銷第 ${revertTarget.seq} 次結算?` : '撤銷這次結算?'"
      :dismissible="!reverting"
      @close="revertError = null"
    >
      <div v-if="revertTarget">
        <div class="rounded-xl px-3.5 py-3" style="background: var(--bg-sunken)">
          <p class="text-sm font-medium">
            【{{ CURRENCY_LABEL[revertTarget.currency] ?? revertTarget.currency }}】第
            <span class="tnum">{{ revertTarget.seq }}</span> 次結算
          </p>
          <p class="mt-1 text-xs text-[var(--text-muted)]">
            <span class="tnum">{{ revertTarget.item_count }}</span> 筆明細
            · <span class="tnum">{{ revertTarget.transfer_count }}</span> 筆轉帳<template
              v-if="revertTarget.transfer_count"
            > · 合計
              <span class="tnum">
                {{ formatMoney(revertTarget.transfer_total_minor, revertTarget.currency) }}
              </span>
            </template>
          </p>
        </div>

        <ul class="mt-3.5 space-y-2 text-sm leading-relaxed text-[var(--text-muted)]">
          <li class="flex items-start gap-2">
            <Icon name="lucide:trash-2" size="15" class="mt-0.5 shrink-0" />
            <!-- 沒有轉帳的回合(只蓋章)不要寫「0 筆會被刪除」,那句話沒有意義 -->
            <span v-if="revertTarget.transfer_count">
              這一輪記下的 <span class="tnum">{{ revertTarget.transfer_count }}</span> 筆轉帳會被
              <strong class="font-medium text-[var(--text)]">刪除</strong>,結算金額立刻重算。
            </span>
            <span v-else>
              這一輪沒有記下任何轉帳(當時算下來沒有人要付錢),所以沒有款項會被刪除。
            </span>
          </li>
          <li class="flex items-start gap-2">
            <Icon name="lucide:rotate-ccw" size="15" class="mt-0.5 shrink-0" />
            <span>
              <span class="tnum">{{ revertTarget.item_count }}</span> 筆明細會回到
              <strong class="font-medium text-[var(--text)]">還沒結算</strong>,
              下次結算又會出現在「本次要結算」裡。
            </span>
          </li>
          <li class="flex items-start gap-2">
            <Icon name="lucide:shield-check" size="15" class="mt-0.5 shrink-0" />
            <span>
              你自己按「標記已還款」記的還款、以及投入 / 退還{{ potName }}的紀錄
              <strong class="font-medium text-[var(--text)]">不會</strong>被動到 ——
              那些是真的發生過的付款。
            </span>
          </li>
        </ul>

        <p class="mt-3.5 text-xs leading-relaxed text-[var(--text-muted)]">
          這一列會留在歷史裡並標成「已撤銷」,帳上看得出這裡曾經結算過又撤銷。
        </p>

        <p
          v-if="revertError"
          class="mt-3.5 flex items-start gap-2 text-sm leading-relaxed"
          style="color: var(--debit)"
        >
          <Icon name="lucide:triangle-alert" size="15" class="mt-0.5 shrink-0" />
          <span>{{ revertError }}</span>
        </p>
      </div>

      <template #footer>
        <UiAppButton variant="ghost" block :disabled="reverting" @click="revertOpen = false">
          取消
        </UiAppButton>
        <UiAppButton block icon="lucide:undo-2" :loading="reverting" @click="confirmRevert">
          撤銷這次結算
        </UiAppButton>
      </template>
    </UiAppSheet>
  </div>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換,不寫死 hex、不用 dark: 前綴 */

/* 卡片內的列表分隔線。子元件的 root 也會帶上這個 scope id,所以對 <Settle*> 一樣有效 */
.divided > * + * {
  border-top: 1px solid var(--border);
}

/* 卡片內的欄名列 / 小標題列 */
.row-head {
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--border);
}

/* 公費現況那一行。底色刻意和下面的淨額列不同 ——
   它是另一本帳的現況,不是某個人的應收 / 應付,
   和下面那排數字沒有任何加總關係。 */
.pot-line {
  padding: 0.75rem 1rem;
  background: color-mix(in oklab, var(--brand) 6%, transparent);
  border-bottom: 1px solid var(--border);
}

.attribution,
.hairline {
  border-top: 1px solid var(--border);
}

/* 結算確認面板最上面那句宣告。用警示框而不是灰字 ——
   「按下去等於錢已經付了」是這個動作唯一不可逆的部分,不能長得像註腳。 */
.declare {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.75rem;
  border-radius: 0.75rem;
  font-size: 0.875rem;
  line-height: 1.7;
  background: color-mix(in oklab, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in oklab, var(--warn) 34%, var(--border));
  color: var(--text);
}

.sheet-title {
  margin-bottom: 0.5rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted);
}

.settled-badge,
.open-badge {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 1rem;
}
.settled-badge {
  width: 3rem;
  height: 3rem;
  margin: 0 auto 0.75rem;
  background: color-mix(in oklab, var(--credit) 14%, transparent);
  color: var(--credit);
}
.open-badge {
  width: 2.5rem;
  height: 2.5rem;
  background: color-mix(in oklab, var(--brand) 14%, transparent);
  color: var(--brand);
}

/* 每人花費那張表的頭像 */
.avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1;
}

/* 成功提示滑入 */
.flash-enter-active,
.flash-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.flash-enter-from,
.flash-leave-to {
  opacity: 0;
  transform: translateY(-0.375rem);
}

@media (prefers-reduced-motion: reduce) {
  .flash-enter-active,
  .flash-leave-active {
    transition-duration: 0.01ms;
  }
  .flash-enter-from,
  .flash-leave-to {
    transform: none;
  }
}
</style>
