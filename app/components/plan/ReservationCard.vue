<script setup lang="ts">
import type { Reservation } from '~~/shared/types';

/**
 * 一筆預約。自動註冊名稱是 <PlanReservationCard>(元件放在 components/plan/ 底下,
 * Nuxt 會加路徑前綴)。
 *
 * 只負責顯示 —— 目前沒有「改狀態」的 API(只有 POST /reservations),
 * 所以卡片上不放 已訂到 / 取消 的按鈕,免得做出按了沒反應的假按鈕。
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
}>(), {
  altZoneLabel: undefined,
  altZoneOffsetMin: undefined,
});

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

        <p v-if="primaryTime" class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span class="tnum font-medium text-[var(--text)]">{{ primaryTime }}</span>
          <span class="text-xs text-[var(--text-muted)]">{{ zoneLabel }}</span>
          <span v-if="altTime" class="tnum text-xs text-[var(--text-muted)]">· {{ altTime }}</span>
        </p>
        <p v-else class="mt-1 text-sm text-[var(--text-muted)]">
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
  </article>
</template>
