<script setup lang="ts">
import type { Reservation } from '~~/shared/types';

/**
 * 一筆預約。自動註冊名稱是 <PlanReservationCard>(元件放在 components/plan/ 底下,
 * Nuxt 會加路徑前綴)。
 *
 * 卡片上顯示**兩個不同的時間**,這是最容易看錯的地方:
 *   開放時間(opens_at_utc)    什麼時候可以開始搶 → 倒數與提醒看這個
 *   訂位時間(booked_for_utc)  訂到的是哪一餐     → 行程看這個
 * 兩者可能差好幾個月(「10/1 開放搶隔年 1/1 的位子」),所以一定要分開標示,
 * 絕不能共用一個「時間」欄位。
 *
 * 狀態改變不在這裡做,交給父層(plan.vue)——
 * 它才有 API client 和清單重抓的能力。
 *
 * 時間全部由外面的 now(epoch ms)驅動:清單上十幾張卡片共用一個計時器,
 * 不要每張卡片各自 setInterval。
 */
const props = withDefaults(defineProps<{
  reservation: Reservation;
  /** 目前時間(epoch ms)。由清單頁每分鐘更新一次。 */
  now: number;
  /** 主要顯示時區的名稱,例如「日本時間」 */
  zoneLabel: string;
  /** 主要顯示時區與 UTC 的偏移(分鐘)。日本 +540、台灣 +480。 */
  zoneOffsetMin: number;
  /** 次要對照時區(小字)。不給就不顯示。 */
  altZoneLabel?: string;
  altZoneOffsetMin?: number;
  /** 這張卡正在送出中(父層在打 PATCH) */
  busy?: boolean;
}>(), {
  altZoneLabel: undefined,
  altZoneOffsetMin: undefined,
  busy: false,
});

const emit = defineEmits<{
  /** 打勾「我訂到了」—— 父層會打開填訂位時間的面板 */
  book: [];
  /** 編輯(改訂位時間 / 名字 / 人數) */
  edit: [];
  /** 標成已取消 */
  cancel: [];
  /** 改回待訂 */
  reopen: [];
}>();

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/**
 * 把 DB 的時間字串當 UTC 解析。
 *
 * 這裡不能直接 Date.parse():D1 的 datetime('now') 寫進去的是
 * 'YYYY-MM-DD HH:MM:SS'(UTC,但沒有 Z),而 Date.parse 對這種非 ISO 格式
 * 會**當成瀏覽器本地時間**,在台灣就會整整差 8 小時、倒數全錯。
 * (同一份邏輯也存在 pages/t/[trip]/plan.vue —— 這兩個檔案是這次能改的範圍,
 *  shared/ 不屬於我,所以刻意各留一份而不是硬塞到別人的檔案裡。)
 */
function parseUtc(value: string | null | undefined): number | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const withT = raw.replace(' ', 'T');
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(withT);
  const ms = Date.parse(hasZone ? withT : `${withT}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** 取某個固定偏移時區的「牆上時鐘」欄位。日本與台灣都沒有日光節約,偏移是常數。 */
function partsInZone(ms: number, offsetMin: number) {
  const shifted = new Date(ms + offsetMin * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    year: shifted.getUTCFullYear(),
    date: `${pad(shifted.getUTCMonth() + 1)}/${pad(shifted.getUTCDate())}`,
    weekday: WEEKDAYS[shifted.getUTCDay()] ?? '',
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

const opensMs = computed(() => parseUtc(props.reservation.opens_at_utc));
const msLeft = computed(() => (opensMs.value === null ? null : opensMs.value - props.now));

type CardState = 'booked' | 'cancelled' | 'undated' | 'open' | 'soon' | 'upcoming';

/** 一小時內就算「快開了」,值得用警示色搶注意力。 */
const SOON_MS = 60 * 60_000;

const state = computed<CardState>(() => {
  const r = props.reservation;
  if (r.status === 'booked') return 'booked';
  if (r.status === 'cancelled') return 'cancelled';
  if (msLeft.value === null) return 'undated';
  if (msLeft.value <= 0) return 'open';
  return msLeft.value <= SOON_MS ? 'soon' : 'upcoming';
});

/** 「2 天 3 小時」/「3 小時 20 分」/「12 分」。天數在前,不要印成 51 小時。 */
function humanize(ms: number): string {
  const totalMin = Math.floor(Math.abs(ms) / 60_000);
  if (totalMin < 1) return '不到 1 分鐘';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  if (days >= 1) return hours ? `${days} 天 ${hours} 小時` : `${days} 天`;
  if (hours >= 1) return minutes ? `${hours} 小時 ${minutes} 分` : `${hours} 小時`;
  return `${minutes} 分`;
}

const pill = computed<{ icon: string; text: string; tone: 'warn' | 'brand' | 'credit' | 'muted' }>(() => {
  switch (state.value) {
    case 'open':
      return {
        icon: 'lucide:alarm-clock',
        text: `已開放 ${humanize(msLeft.value ?? 0)}`,
        tone: 'warn',
      };
    case 'soon':
      return { icon: 'lucide:alarm-clock', text: `還有 ${humanize(msLeft.value ?? 0)}`, tone: 'warn' };
    case 'upcoming':
      return { icon: 'lucide:timer', text: `還有 ${humanize(msLeft.value ?? 0)}`, tone: 'brand' };
    case 'booked':
      return { icon: 'lucide:circle-check', text: '已訂到', tone: 'credit' };
    case 'cancelled':
      return { icon: 'lucide:ban', text: '已取消', tone: 'muted' };
    default:
      return { icon: 'lucide:calendar-off', text: '未定時間', tone: 'muted' };
  }
});

const TONE_STYLE: Record<'warn' | 'brand' | 'credit' | 'muted', Record<string, string>> = {
  warn: { background: 'color-mix(in oklab, var(--warn) 18%, transparent)', color: 'var(--warn)' },
  brand: { background: 'color-mix(in oklab, var(--brand) 13%, transparent)', color: 'var(--brand)' },
  credit: { background: 'color-mix(in oklab, var(--credit) 15%, transparent)', color: 'var(--credit)' },
  muted: { background: 'var(--bg-sunken)', color: 'var(--text-muted)' },
};

const pillStyle = computed(() => TONE_STYLE[pill.value.tone]);

/** 已開放但還是 pending 的那幾筆最容易被漏掉,左側加一條警示色。 */
const accentStyle = computed(() => {
  if (state.value === 'open') return { boxShadow: 'inset 3px 0 0 0 var(--warn)' };
  if (state.value === 'soon') return { boxShadow: 'inset 3px 0 0 0 var(--warn)' };
  return undefined;
});

/** 主要時間。跨年份時才印年份,平常省掉。 */
const primaryTime = computed(() => {
  if (opensMs.value === null) return null;
  const p = partsInZone(opensMs.value, props.zoneOffsetMin);
  const thisYear = partsInZone(props.now, props.zoneOffsetMin).year;
  const datePart = p.year === thisYear ? p.date : `${p.year}/${p.date}`;
  return `${datePart} (${p.weekday}) ${p.time}`;
});

/**
 * 對照時區。日本 00:30 在台灣是前一天 23:30,所以日期不同時要把日期一起印出來,
 * 不然會看成同一天。
 */
const altTime = computed(() => {
  if (opensMs.value === null || props.altZoneOffsetMin === undefined || !props.altZoneLabel) return null;
  const main = partsInZone(opensMs.value, props.zoneOffsetMin);
  const alt = partsInZone(opensMs.value, props.altZoneOffsetMin);
  const sameDay = main.date === alt.date && main.year === alt.year;
  return `${props.altZoneLabel} ${sameDay ? alt.time : `${alt.date} ${alt.time}`}`;
});

// ── 訂位時間(和開放時間是兩件事)────────────────────────────
const bookedMs = computed(() => parseUtc(props.reservation.booked_for_utc));

/** 訂到的那一餐。跨年份時印年份 —— 「10 月訂隔年 1 月」是常態,不印年份會看錯。 */
const bookedTime = computed(() => {
  if (bookedMs.value === null) return null;
  const p = partsInZone(bookedMs.value, props.zoneOffsetMin);
  const thisYear = partsInZone(props.now, props.zoneOffsetMin).year;
  const datePart = p.year === thisYear ? p.date : `${p.year}/${p.date}`;
  return `${datePart} (${p.weekday}) ${p.time}`;
});

/** 訂位時間也要有對照時區 —— 日本 00:30 在台灣是前一天,看錯就搭錯車 */
const bookedAltTime = computed(() => {
  if (bookedMs.value === null || props.altZoneOffsetMin === undefined || !props.altZoneLabel) return null;
  const main = partsInZone(bookedMs.value, props.zoneOffsetMin);
  const alt = partsInZone(bookedMs.value, props.altZoneOffsetMin);
  const sameDay = main.date === alt.date && main.year === alt.year;
  return `${props.altZoneLabel} ${sameDay ? alt.time : `${alt.date} ${alt.time}`}`;
});

/** 已訂到但沒填是哪一餐 —— 這筆資料等於沒用,要提示補上 */
const bookedMissingTime = computed(() =>
  props.reservation.status === 'booked' && bookedMs.value === null);

/** 訂位時間已經過了(飯已經吃完了) */
const bookedPast = computed(() =>
  bookedMs.value !== null && bookedMs.value < props.now);

const partyText = computed(() => {
  const n = props.reservation.party_size;
  return n && n > 0 ? `${n} 位` : null;
});

const remindText = computed(() => {
  const min = props.reservation.remind_before_min;
  if (opensMs.value === null) return '設好開放時間才能提醒';
  if (!min || min <= 0) return '時間到才提醒';
  if (min % 1440 === 0) return `開放前 ${min / 1440} 天提醒`;
  if (min % 60 === 0) return `開放前 ${min / 60} 小時提醒`;
  return `開放前 ${min} 分鐘提醒`;
});

const remindedAt = computed(() => {
  const ms = parseUtc(props.reservation.reminded_at);
  if (ms === null) return null;
  const p = partsInZone(ms, props.zoneOffsetMin);
  return `已於 ${p.date} ${p.time} 提醒過`;
});

/** 連結上顯示網域就好 —— 訂位網址通常又長又醜。 */
const linkLabel = computed(() => {
  const url = props.reservation.url;
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  }
  catch {
    return '訂位連結';
  }
});

const dimmed = computed(() => props.reservation.status === 'cancelled');
</script>

<template>
  <article
    class="card px-4 py-3.5 transition"
    :class="dimmed ? 'opacity-60' : ''"
    :style="accentStyle"
  >
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <h3
          class="text-[0.9375rem] leading-snug font-semibold text-[var(--text)]"
          :class="dimmed ? 'line-through' : ''"
        >
          {{ reservation.name }}
        </h3>

        <!-- 訂位資訊:訂到之後,「訂到哪一餐」比「什麼時候開放」重要,所以排前面 -->
        <p v-if="bookedTime" class="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span class="shrink-0 text-xs font-semibold" style="color: var(--credit)">訂位</span>
          <span class="tnum font-semibold text-[var(--text)]">{{ bookedTime }}</span>
          <span class="text-xs text-[var(--text-muted)]">{{ zoneLabel }}</span>
          <span v-if="bookedAltTime" class="tnum text-xs text-[var(--text-muted)]">· {{ bookedAltTime }}</span>
        </p>

        <p
          v-if="reservation.booking_name || partyText"
          class="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-[var(--text-muted)]"
        >
          <span v-if="reservation.booking_name" class="inline-flex items-center gap-1">
            <Icon name="lucide:user" size="12" class="shrink-0" />
            {{ reservation.booking_name }}
          </span>
          <span v-if="partyText" class="inline-flex items-center gap-1">
            <Icon name="lucide:users" size="12" class="shrink-0" />
            {{ partyText }}
          </span>
        </p>

        <!-- 開放時間。已訂到之後就退成小字,它的任務已經完成了 -->
        <p
          v-if="primaryTime"
          class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
          :class="bookedTime ? 'text-xs' : 'text-sm'"
        >
          <span class="shrink-0 text-xs text-[var(--text-muted)]">開放</span>
          <span class="tnum text-[var(--text)]" :class="bookedTime ? '' : 'font-medium'">{{ primaryTime }}</span>
          <span v-if="!bookedTime" class="text-xs text-[var(--text-muted)]">{{ zoneLabel }}</span>
          <span v-if="altTime && !bookedTime" class="tnum text-xs text-[var(--text-muted)]">· {{ altTime }}</span>
        </p>
        <p v-else-if="!bookedTime" class="mt-1 text-sm text-[var(--text-muted)]">
          還沒填開放時間
        </p>
      </div>

      <span
        class="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
        :style="pillStyle"
      >
        <Icon :name="pill.icon" size="13" class="shrink-0" />
        <span class="tnum whitespace-nowrap">{{ pill.text }}</span>
      </span>
    </div>

    <p
      v-if="state === 'open'"
      class="mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
      style="color: var(--warn)"
    >
      <Icon name="lucide:triangle-alert" size="13" class="mt-0.5 shrink-0" />
      <span>開放時間已經過了,狀態還是「待訂」。訂到了或放棄了,記得回來確認一下。</span>
    </p>

    <p
      v-if="bookedMissingTime"
      class="mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
      style="color: var(--warn)"
    >
      <Icon name="lucide:calendar-off" size="13" class="mt-0.5 shrink-0" />
      <span>標成已訂到,但沒填訂到哪一餐。按「改訂位」補上時間。</span>
    </p>

    <p
      v-else-if="bookedPast"
      class="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-[var(--text-muted)]"
    >
      <Icon name="lucide:check" size="13" class="mt-0.5 shrink-0" />
      <span>這一餐已經過了。</span>
    </p>

    <p v-if="reservation.note" class="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
      {{ reservation.note }}
    </p>

    <div class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <a
        v-if="reservation.url"
        :href="reservation.url"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex min-h-9 items-center gap-1.5 rounded-lg pr-2 text-xs font-medium
               text-[var(--brand)] transition active:scale-[0.98]"
      >
        <Icon name="lucide:external-link" size="14" class="shrink-0" />
        <span class="max-w-[12rem] truncate">{{ linkLabel }}</span>
      </a>

      <span class="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
        <Icon name="lucide:bell" size="13" class="shrink-0" />
        {{ remindText }}
      </span>

      <span v-if="remindedAt" class="tnum inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
        <Icon name="lucide:check" size="13" class="shrink-0" />
        {{ remindedAt }}
      </span>
    </div>

    <!-- ── 動作 ── -->
    <div class="mt-2.5 flex flex-wrap gap-1.5 border-t pt-2.5" style="border-color: var(--border)">
      <button
        v-if="reservation.status !== 'booked'"
        type="button" class="act act-primary" :disabled="busy"
        @click="emit('book')"
      >
        <Icon name="lucide:circle-check" size="14" class="shrink-0" />
        我訂到了
      </button>

      <button
        v-if="reservation.status === 'booked'"
        type="button" class="act" :disabled="busy"
        @click="emit('edit')"
      >
        <Icon name="lucide:calendar-cog" size="14" class="shrink-0" />
        改訂位
      </button>

      <button
        v-if="reservation.status === 'pending'"
        type="button" class="act" :disabled="busy"
        @click="emit('edit')"
      >
        <Icon name="lucide:pencil" size="14" class="shrink-0" />
        編輯
      </button>

      <span class="flex-1" />

      <button
        v-if="reservation.status !== 'cancelled'"
        type="button" class="act act-muted" :disabled="busy"
        @click="emit('cancel')"
      >
        <Icon name="lucide:ban" size="14" class="shrink-0" />
        取消
      </button>

      <button
        v-else
        type="button" class="act" :disabled="busy"
        @click="emit('reopen')"
      >
        <Icon name="lucide:rotate-ccw" size="14" class="shrink-0" />
        改回待訂
      </button>
    </div>
  </article>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換。 */
.act {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-height: 36px;
  padding-inline: 0.625rem;
  border-radius: 0.625rem;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text);
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.12s ease;
}
.act:active {
  transform: scale(0.97);
}
.act:disabled {
  opacity: 0.5;
  pointer-events: none;
}
.act-primary {
  border-color: transparent;
  background: color-mix(in oklab, var(--credit) 15%, transparent);
  color: var(--credit);
}
.act-muted {
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
}
@media (hover: hover) {
  .act-muted:hover {
    color: var(--debit);
  }
}
@media (prefers-reduced-motion: reduce) {
  .act {
    transition: none;
  }
  .act:active {
    transform: none;
  }
}
</style>
