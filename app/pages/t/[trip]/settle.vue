<script setup lang="ts">
import type { Balance, Net, Transfer } from '~~/shared/types';
import { CURRENCY_LABEL, formatMoney } from '~~/shared/money';

/**
 * 結算 —— 「誰要給誰多少錢」。這頁是整個產品存在的理由。
 *
 * 三個不可妥協的規則:
 *  1. **逐幣別分開結算**。日幣和台幣絕不相加成一個總額,每個幣別自己一個區塊。
 *  2. 轉帳建議是貪婪近似解,文案寫「已簡化」而不是「最少」
 *     (最小化轉帳筆數可歸約到 Subset Sum,是 NP-Complete)。
 *  3. balance.disclaimer 與 balance.rate_attribution 必須顯示 ——
 *     前者是「換算值只是估算」的誠實聲明,後者是匯率來源的授權要求。
 *
 * 這頁是要拿給朋友看的,所以寧可多一行說明,也不要讓人懷疑數字是怎麼來的。
 */
useHead({ title: '結算 — 旅遊記帳' });

const tripId = useTripId();
const api = useApi();
const { members, memberName } = useTrip(tripId);

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

const refreshing = ref(false);
async function reload(): Promise<void> {
  refreshing.value = true;
  try {
    // 'cancel':標記還款後一定要拿到重算過的結果,不能沿用可能在路上的舊請求
    await balanceState.refresh({ dedupe: 'cancel' });
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
  transfers: TransferRow[];
  /** 非零淨額,應收多的排前面 */
  nets: Net[];
  /** 同幣別最大絕對淨額,bar 的分母 */
  maxAbs: number;
  /** 這個幣別淨額為 0(沒出現在 nets)的成員名字 */
  settledNames: string[];
}

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

  return codes.map((code) => {
    const bucket = b.by_currency[code]!;
    const rawNets = bucket.nets ?? [];
    const nets = [...rawNets].sort((a, c) => c.netMinor - a.netMinor);
    const withNet = new Set(nets.map(n => n.memberId));

    return {
      code,
      label: CURRENCY_LABEL[code] ?? code,
      // 大筆的排前面:先處理金額大的那幾筆最有感
      transfers: [...(bucket.transfers ?? [])]
        .sort((a, c) => c.amountMinor - a.amountMinor)
        .map((t, i) => ({ ...t, key: `${code}:${t.from}:${t.to}:${i}` })),
      nets,
      maxAbs: nets.reduce((max, n) => Math.max(max, Math.abs(n.netMinor)), 0),
      // server 的 nets 已濾掉 0,所以這些人就是已結清的人。
      // 不畫成一整列 ¥0,只在區塊底下列名字,免得洗掉真正要看的數字。
      settledNames: members.value.filter(m => !withNet.has(m.id)).map(m => m.name),
    };
  });
});

const hasCurrencies = computed(() => sections.value.length > 0);
const openTransferCount = computed(
  () => sections.value.reduce((sum, s) => sum + s.transfers.length, 0),
);
/** 有共同花費,而且每個幣別都不需要再轉帳 */
const allSettled = computed(() => hasCurrencies.value && openTransferCount.value === 0);

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

  const rows: MemberTotalRow[] = members.value.map(m => ({
    id: m.id,
    name: m.name,
    // per_member 只含「有分攤記錄」的人,沒花錢的成員也要出現(顯示 0),
    // 不然名單少一個人會讓人以為漏帳。
    ...(perMember[m.id] ?? ZERO_TOTALS),
  }));

  // 反過來:per_member 有、members 沒有的 id(成員被刪掉)也補上,不要靜靜漏掉一筆錢
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
        <p class="text-base font-semibold">已全部結清</p>
        <p class="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-[var(--text-muted)]">
          每個幣別的墊款都對得上,沒有人需要再轉帳給誰。之後再記共同花費,這裡會重新算。
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
            分 <span class="tnum">{{ sections.length }}</span> 個幣別各自結算。轉完錢在這頁按「標記已還款」。
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
            <template v-if="s.transfers.length">
              已簡化為 <span class="tnum font-medium text-[var(--text)]">{{ s.transfers.length }}</span> 筆轉帳
            </template>
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
            :disabled="posting && pending?.key !== t.key"
            @settle="askSettle(s, t)"
          />
        </div>
        <!-- 只有部分幣別結清時才提示;全部結清時上面的總覽已經講過了,不要重複三次 -->
        <div v-else-if="!allSettled" class="card">
          <UiEmptyState
            dense
            icon="lucide:circle-check"
            title="這個幣別不用轉帳"
            :description="`所有人在${s.label}的墊款都對得上了。`"
          />
        </div>

        <!-- 每人淨額 -->
        <div v-if="s.nets.length || s.settledNames.length" class="card overflow-hidden">
          <div class="row-head flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2.5">
            <h4 class="text-xs font-semibold">每人淨額</h4>
            <p class="text-[0.6875rem] text-[var(--text-muted)]">
              綠 + = 應收(別人還他)· 紅 − = 應付(他要還)
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
        </ul>
        <p class="attribution mt-3 pt-3 text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
          {{ balance.rate_attribution }}
        </p>
      </section>
    </template>

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

.attribution,
.hairline {
  border-top: 1px solid var(--border);
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
