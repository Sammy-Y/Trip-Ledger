<script setup lang="ts">
import type { Reservation } from '~~/shared/types';

/**
 * 預約清單 —— 搶訂位用。
 *
 * 為什麼要有這頁:日本熱門餐廳的規則是「每月 1 號中午 12:00 開放下兩個月的座位」,
 * 那一分鐘沒按下去就吃不到。使用者原本用 Excel 記這些時間點,
 * 但 Excel 不會在開放前拍你肩膀 —— 這頁的核心價值就是那則提醒。
 *
 * 時區是這頁最容易錯的地方:API 存的 opens_at_utc 是 UTC,
 * 但使用者腦子裡想的是「日本時間 12 點」。所以表單讓使用者選時區輸入,
 * 並且在送出前把三個時區的對照(日本 / 台灣 / UTC)直接印在畫面上讓他確認。
 * 日本與台灣都沒有日光節約時間,偏移是固定的 +9 / +8,不需要時區資料庫。
 */
const tripId = useTripId();
const api = useApi();

useHead({ title: '預約清單 — 旅遊記帳' });

// ── 固定偏移時區 ────────────────────────────────────────────
const ZONES = [
  { id: 'JST', label: '日本時間', short: '日本', offsetMin: 9 * 60, utc: 'UTC+9' },
  { id: 'TWN', label: '台灣時間', short: '台灣', offsetMin: 8 * 60, utc: 'UTC+8' },
] as const;

type ZoneId = typeof ZONES[number]['id'];

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 把後端的時間字串當 UTC 解析。
 *
 * 不能直接 Date.parse():D1 的 datetime('now') 存的是 'YYYY-MM-DD HH:MM:SS'
 * (UTC,但字串裡沒有 Z),而 Date.parse 對這種非 ISO 格式會**當成本地時間**,
 * 在台灣就整整差 8 小時、倒數全錯。
 * (components/plan/ReservationCard.vue 也有一份同樣的函式 —— shared/ 不在這次
 *  可改的範圍內,所以刻意各留一份,而不是硬塞進別人負責的檔案。)
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

/** 某個固定偏移時區裡的「牆上時鐘」。 */
function partsInZone(ms: number, offsetMin: number) {
  const d = new Date(ms + offsetMin * 60_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: WEEKDAYS[d.getUTCDay()] ?? '',
    hh: pad2(d.getUTCHours()),
    mm: pad2(d.getUTCMinutes()),
  };
}

/** 2026/10/01 (四) 12:00 */
function formatFull(ms: number, offsetMin: number): string {
  const p = partsInZone(ms, offsetMin);
  return `${p.year}/${pad2(p.month)}/${pad2(p.day)} (${p.weekday}) ${p.hh}:${p.mm}`;
}

// ── 現在時間(整頁共用一個計時器,不要每張卡片各自 setInterval)────
const now = ref(Date.now());
useIntervalFn(() => {
  now.value = Date.now();
}, 30_000);

// 手機切回這個 App 時馬上校正,不然倒數會停在切走的那一刻
const visibility = useDocumentVisibility();
watch(visibility, (v) => {
  if (v === 'visible') now.value = Date.now();
});

// ── 顯示時區(記在這台裝置上)────────────────────────────────
const displayZoneId = useLocalStorage<ZoneId>('trip-ledger:plan-zone', 'JST', {
  onError: () => {},
});
const displayZone = computed(() => ZONES.find(z => z.id === displayZoneId.value) ?? ZONES[0]);
const altZone = computed(() => ZONES.find(z => z.id !== displayZone.value.id) ?? ZONES[1]);

// ── 清單 ────────────────────────────────────────────────────
const listState = useAsyncData<Reservation[]>(
  () => `reservations:${tripId.value}`,
  () => api.get<Reservation[]>(`/api/trips/${encodeURIComponent(tripId.value)}/reservations`),
  { default: () => [], deep: false },
);

const reservations = computed(() => listState.data.value ?? []);
const loading = computed(() => listState.status.value === 'pending' && !reservations.value.length);
const loadError = computed(() => {
  const e = listState.error.value;
  if (!e || isAbortError(e)) return '';
  return api.errorMessage(e, '預約清單載入失敗。');
});

interface Row { r: Reservation; ms: number | null }

const rows = computed<Row[]>(() => reservations.value.map(r => ({ r, ms: parseUtc(r.opens_at_utc) })));

/** 已經開放、狀態卻還是「待訂」——最容易被漏掉的一群,排最上面。 */
const openNow = computed(() =>
  rows.value
    .filter(x => x.r.status === 'pending' && x.ms !== null && x.ms <= now.value)
    // 剛開放的還有機會訂到,排前面
    .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)));

const upcoming = computed(() =>
  rows.value
    .filter(x => x.r.status === 'pending' && x.ms !== null && x.ms > now.value)
    .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0)));

const undated = computed(() => rows.value.filter(x => x.r.status === 'pending' && x.ms === null));

/**
 * 已訂到的:自己一區,而且**按訂位時間排序**(不是按開放時間)。
 * 訂到之後使用者關心的是「接下來哪一餐先到」,開放時間已經沒有用了。
 */
const booked = computed(() =>
  rows.value
    .filter(x => x.r.status === 'booked')
    .map(x => ({ ...x, bookedMs: parseUtc(x.r.booked_for_utc) }))
    .sort((a, b) =>
      (a.bookedMs ?? Number.MAX_SAFE_INTEGER) - (b.bookedMs ?? Number.MAX_SAFE_INTEGER)));

const cancelled = computed(() =>
  rows.value
    .filter(x => x.r.status === 'cancelled')
    .sort((a, b) => (a.ms ?? Number.MAX_SAFE_INTEGER) - (b.ms ?? Number.MAX_SAFE_INTEGER)));

const hasAny = computed(() => reservations.value.length > 0);
const hasDated = computed(() => rows.value.some(x => x.ms !== null));
const pendingCount = computed(() => upcoming.value.length + undated.value.length);

/** 「下一個」的倒數,放在頁首讓人一眼看到最緊急的是哪一筆。 */
const nextUp = computed(() => {
  const first = upcoming.value[0];
  if (!first || first.ms === null) return null;
  const totalMin = Math.max(0, Math.floor((first.ms - now.value) / 60_000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  let left: string;
  if (days >= 1) left = hours ? `${days} 天 ${hours} 小時` : `${days} 天`;
  else if (hours >= 1) left = minutes ? `${hours} 小時 ${minutes} 分` : `${hours} 小時`;
  else left = totalMin < 1 ? '不到 1 分鐘' : `${minutes} 分`;
  return { name: first.r.name, left };
});

// ── 推播提醒 ────────────────────────────────────────────────
const push = usePushSubscription(tripId);

interface PushUi {
  icon: string;
  tone: 'credit' | 'warn' | 'brand' | 'muted';
  title: string;
  body: string;
  action?: string;
  steps?: string[];
}

const pushUi = computed<PushUi>(() => {
  if (push.subscribed.value) {
    return {
      icon: 'lucide:bell-ring',
      tone: 'credit',
      title: '這台裝置會在開放前收到提醒',
      body: '提醒由伺服器推送,關掉頁面也收得到。換手機、重裝或清掉網站資料之後要再開一次。',
    };
  }
  switch (push.blocker.value) {
    case 'needs-install':
      return {
        icon: 'lucide:share',
        tone: 'warn',
        title: 'iPhone 要先加到主畫面才收得到提醒',
        body: 'iOS 只允許「已安裝」的網頁推播。加完之後從主畫面的圖示打開這一頁,再回來按開啟。',
        steps: [
          '在 Safari 按下方中間的「分享」',
          '往下找「加到主畫面」',
          '打開主畫面上的圖示,回到這頁開啟提醒',
        ],
      };
    case 'denied':
      return {
        icon: 'lucide:bell-off',
        tone: 'warn',
        title: '通知被封鎖了',
        body: '瀏覽器不會再跳出詢問視窗。請到瀏覽器或系統的通知設定,把這個網站改回「允許」,再回來這頁開啟。',
      };
    case 'no-browser-support':
      return {
        icon: 'lucide:bell-off',
        tone: 'muted',
        title: '這個瀏覽器不支援網頁推播',
        body: '開放時間照樣會顯示倒數。想保險一點,可以在手機時鐘另外設一個鬧鐘。',
      };
    case 'no-server-key':
      return {
        icon: 'lucide:bell-off',
        tone: 'muted',
        title: '伺服器還沒設定推播金鑰',
        body: 'VAPID 金鑰設好之後才推得出通知。在那之前預約還是記得下來、倒數也照樣走。',
      };
    default:
      return {
        icon: 'lucide:bell',
        tone: 'brand',
        title: '開啟開放前提醒',
        body: '熱門店家開放後幾分鐘就滿。讓伺服器在開放前推一則通知,不用一直自己回來看。',
        action: '開啟提醒',
      };
  }
});

const TONE_STYLE: Record<'credit' | 'warn' | 'brand' | 'muted', Record<string, string>> = {
  credit: { background: 'color-mix(in oklab, var(--credit) 15%, transparent)', color: 'var(--credit)' },
  warn: { background: 'color-mix(in oklab, var(--warn) 18%, transparent)', color: 'var(--warn)' },
  brand: { background: 'color-mix(in oklab, var(--brand) 13%, transparent)', color: 'var(--brand)' },
  muted: { background: 'var(--bg-sunken)', color: 'var(--text-muted)' },
};

const pushIconStyle = computed(() => TONE_STYLE[pushUi.value.tone]);

// ── 新增預約 ────────────────────────────────────────────────
const DEFAULT_TIME = '12:00';

const sheetOpen = ref(false);
const saving = ref(false);
const formError = ref('');
const justAdded = ref('');
let addedTimer: ReturnType<typeof setTimeout> | undefined;

const form = reactive({
  name: '',
  url: '',
  date: '',
  time: DEFAULT_TIME,
  zoneId: 'JST' as ZoneId,
  remind: 30,
  bookingName: '',
  partySize: null as number | null,
  note: '',
});

const zoneOptions = ZONES.map(z => ({ value: z.id, label: `${z.label}(${z.utc})` }));

const REMIND_OPTIONS = [
  { value: 0, label: '時間到才提醒' },
  { value: 10, label: '提前 10 分鐘' },
  { value: 30, label: '提前 30 分鐘' },
  { value: 60, label: '提前 1 小時' },
  { value: 180, label: '提前 3 小時' },
  { value: 720, label: '提前 12 小時' },
  { value: 1440, label: '提前 1 天' },
];

const inputZone = computed(() => ZONES.find(z => z.id === form.zoneId) ?? ZONES[0]);

/**
 * 使用者輸入的是「當地牆上時鐘」。先用 Z 把那串數字當 UTC 讀進來(這樣就完全
 * 不受這台裝置本身的時區影響),再減掉當地偏移,得到真正的 UTC 瞬間。
 */
const opensMs = computed<number | null>(() => {
  if (!form.date || !form.time) return null;
  const raw = form.time.trim();
  const normalized = /^\d{1,2}:\d{2}$/.test(raw) ? `${raw.padStart(5, '0')}:00` : raw;
  const wall = Date.parse(`${form.date}T${normalized}Z`);
  if (!Number.isFinite(wall)) return null;
  return wall - inputZone.value.offsetMin * 60_000;
});

/** 送給 API 的值。2026-10-01T03:00:00Z */
const opensAtUtc = computed<string | null>(() =>
  (opensMs.value === null ? null : `${new Date(opensMs.value).toISOString().slice(0, 19)}Z`));

const preview = computed(() => {
  const ms = opensMs.value;
  if (ms === null) return null;
  return {
    zones: ZONES.map(z => ({
      id: z.id,
      label: z.label,
      text: formatFull(ms, z.offsetMin),
      isInput: z.id === form.zoneId,
    })),
    iso: opensAtUtc.value ?? '',
    remindAt: form.remind > 0 ? formatFull(ms - form.remind * 60_000, inputZone.value.offsetMin) : null,
    past: ms <= now.value,
  };
});

/** 貼 tabelog.com/… 這種沒有 scheme 的網址很常見,自己補上 https://。 */
const normalizedUrl = computed(() => {
  const raw = form.url.trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, '')}`;
});

const urlHint = computed(() => {
  if (!form.url.trim()) return '訂位頁面或餐廳官網,搶位時直接從這裡點過去。';
  return normalizedUrl.value === form.url.trim() ? undefined : `會存成 ${normalizedUrl.value}`;
});

const timeError = computed(() => (form.date && !form.time ? '填了日期就要填時刻(例如 12:00)。' : ''));
const canSave = computed(() => !!form.name.trim() && !timeError.value && !saving.value);

/** 「下個月 1 號」這種快捷:日本餐廳的開放日幾乎都是 1 號。 */
function firstOfMonth(monthDelta: number): string {
  const p = partsInZone(now.value, inputZone.value.offsetMin);
  const d = new Date(Date.UTC(p.year, p.month - 1 + monthDelta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
}

/**
 * 只給還沒過去的 1 號,最多兩個。
 * 已經過完的 1 號選了也不會有提醒(cron 只看未來的時間點),擺在那裡只會誤導。
 */
const quickDates = computed(() => {
  const candidates: Array<[number, string]> = [[0, '本月 1 號'], [1, '下個月 1 號'], [2, '下下個月 1 號']];
  const out: Array<{ label: string; value: string }> = [];
  for (const [delta, label] of candidates) {
    const value = firstOfMonth(delta);
    const ms = Date.parse(`${value}T${DEFAULT_TIME}:00Z`) - inputZone.value.offsetMin * 60_000;
    if (!Number.isFinite(ms) || ms <= now.value) continue;
    out.push({ label, value });
    if (out.length >= 2) break;
  }
  return out;
});

function applyQuickDate(value: string): void {
  form.date = value;
  if (!form.time) form.time = DEFAULT_TIME;
}

function openSheet(): void {
  formError.value = '';
  form.zoneId = displayZone.value.id;
  sheetOpen.value = true;
}

function resetForm(): void {
  form.name = '';
  form.url = '';
  form.date = '';
  form.time = DEFAULT_TIME;
  form.remind = 30;
  form.bookingName = '';
  form.partySize = null;
  form.note = '';
  formError.value = '';
}

async function save(): Promise<void> {
  if (!canSave.value) return;
  const name = form.name.trim();
  saving.value = true;
  formError.value = '';
  try {
    await api.post(`/api/trips/${encodeURIComponent(tripId.value)}/reservations`, {
      name,
      url: normalizedUrl.value || undefined,
      opens_at_utc: opensAtUtc.value ?? undefined,
      remind_before_min: form.remind,
      booking_name: form.bookingName.trim() || undefined,
      party_size: form.partySize == null || !Number.isFinite(form.partySize)
        ? undefined
        : Math.trunc(form.partySize),
      note: form.note.trim() || undefined,
    });
    // POST 只回 { id },拿不到整筆資料 —— 重抓清單比自己拼一筆假的可靠
    await listState.refresh({ dedupe: 'cancel' });
    sheetOpen.value = false;
    justAdded.value = name;
    clearTimeout(addedTimer);
    addedTimer = setTimeout(() => {
      justAdded.value = '';
    }, 4000);
  }
  catch (e) {
    formError.value = api.errorMessage(e, '新增失敗,請稍後再試一次。');
  }
  finally {
    saving.value = false;
  }
}

const timeFieldId = useId();

// ── 訂位:打勾「我訂到了」/ 改訂位時間 ────────────────────────
/**
 * 「訂到了」和「開放搶」是兩個不同的時間,所以這是一個獨立的面板,
 * 不是把上面那個新增表單改標題重用 —— 兩者要填的欄位根本不一樣:
 * 新增填的是「幾號幾點開放」,這裡填的是「訂到哪一天哪一餐、用誰的名字、幾位」。
 */
const bookSheetOpen = ref(false);
const bookSaving = ref(false);
const bookError = ref('');
/** 正在送 PATCH 的那筆 id —— 卡片上的按鈕要跟著鎖住 */
const busyId = ref('');

const bookForm = reactive({
  id: '',
  storeName: '',
  date: '',
  time: '18:00',
  zoneId: 'JST' as ZoneId,
  bookingName: '',
  partySize: null as number | null,
  note: '',
});

const bookZone = computed(() => ZONES.find(z => z.id === bookForm.zoneId) ?? ZONES[0]);

/** 和新增表單同一套換算:先把輸入當 UTC 讀,再減掉當地偏移 */
const bookedMs = computed<number | null>(() => {
  if (!bookForm.date || !bookForm.time) return null;
  const raw = bookForm.time.trim();
  const normalized = /^\d{1,2}:\d{2}$/.test(raw) ? `${raw.padStart(5, '0')}:00` : raw;
  const wall = Date.parse(`${bookForm.date}T${normalized}Z`);
  if (!Number.isFinite(wall)) return null;
  return wall - bookZone.value.offsetMin * 60_000;
});

const bookedAtUtc = computed<string | null>(() =>
  (bookedMs.value === null ? null : `${new Date(bookedMs.value).toISOString().slice(0, 19)}Z`));

const bookPreview = computed(() => {
  const ms = bookedMs.value;
  if (ms === null) return null;
  return ZONES.map(z => ({
    id: z.id,
    label: z.label,
    text: formatFull(ms, z.offsetMin),
    isInput: z.id === bookForm.zoneId,
  }));
});

const bookTimeError = computed(() =>
  (bookForm.date && !bookForm.time ? '填了日期就要填時刻(例如 18:00)。' : ''));
const canSaveBooking = computed(() => !bookTimeError.value && !bookSaving.value);

/** 把 UTC 字串拆回「某時區的牆上時鐘」,填回表單好編輯 */
function splitToZone(utc: string | null, offsetMin: number): { date: string; time: string } | null {
  const ms = parseUtc(utc);
  if (ms === null) return null;
  const p = partsInZone(ms, offsetMin);
  return {
    date: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    time: `${p.hh}:${p.mm}`,
  };
}

function openBookSheet(r: Reservation): void {
  bookError.value = '';
  bookForm.id = r.id;
  bookForm.storeName = r.name;
  bookForm.zoneId = displayZone.value.id;
  const existing = splitToZone(r.booked_for_utc, displayZone.value.offsetMin);
  bookForm.date = existing?.date ?? '';
  bookForm.time = existing?.time ?? '18:00';
  bookForm.bookingName = r.booking_name ?? '';
  bookForm.partySize = r.party_size ?? null;
  bookForm.note = r.note ?? '';
  bookSheetOpen.value = true;
}

async function saveBooking(): Promise<void> {
  if (!canSaveBooking.value || !bookForm.id) return;
  bookSaving.value = true;
  bookError.value = '';
  try {
    await api.patch(
      `/api/trips/${encodeURIComponent(tripId.value)}/reservations/${encodeURIComponent(bookForm.id)}`,
      {
        status: 'booked',
        booked_for_utc: bookedAtUtc.value,
        booking_name: bookForm.bookingName.trim() || null,
        party_size: bookForm.partySize == null || !Number.isFinite(bookForm.partySize)
          ? null
          : Math.trunc(bookForm.partySize),
        note: bookForm.note.trim() || null,
      },
    );
    await listState.refresh({ dedupe: 'cancel' });
    bookSheetOpen.value = false;
  }
  catch (e) {
    bookError.value = api.errorMessage(e, '儲存失敗,請稍後再試一次。');
  }
  finally {
    bookSaving.value = false;
  }
}

/** setStatus 失敗時要有地方顯示 —— 它沒有面板可以放錯誤訊息 */
const loadErrorOverride = ref('');

/** 取消 / 改回待訂。狀態改變不需要面板,直接送。 */
async function setStatus(r: Reservation, status: 'pending' | 'cancelled'): Promise<void> {
  if (busyId.value) return;
  busyId.value = r.id;
  try {
    await api.patch(
      `/api/trips/${encodeURIComponent(tripId.value)}/reservations/${encodeURIComponent(r.id)}`,
      { status },
    );
    await listState.refresh({ dedupe: 'cancel' });
  }
  catch (e) {
    loadErrorOverride.value = api.errorMessage(e, '更新失敗,請稍後再試一次。');
  }
  finally {
    busyId.value = '';
  }
}

onBeforeUnmount(() => clearTimeout(addedTimer));
</script>

<template>
  <div>
    <!-- ───────── 頁首 ───────── -->
    <header class="mb-4">
      <h1 class="text-xl font-semibold text-[var(--text)] md:text-2xl">
        預約
      </h1>
      <p class="mt-1.5 max-w-prose text-sm leading-relaxed text-[var(--text-muted)]">
        日本熱門餐廳大多是<strong class="font-medium text-[var(--text)]">每月 1 號中午 12:00</strong>開放下兩個月的座位,
        錯過那一分鐘就吃不到。把開放時間記在這裡,到時候讓它提醒你。
      </p>

      <div v-if="hasAny" class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span class="text-[var(--text-muted)]">
          <span class="tnum font-semibold text-[var(--text)]">{{ pendingCount }}</span> 筆待訂
        </span>
        <span v-if="openNow.length" class="tnum" style="color: var(--warn)">
          {{ openNow.length }} 筆已開放待確認
        </span>
        <span v-if="nextUp" class="text-[var(--text-muted)]">
          下一個 · {{ nextUp.name }}
          <span class="tnum font-semibold text-[var(--brand)]">還有 {{ nextUp.left }}</span>
        </span>
      </div>
    </header>

    <!-- ───────── 推播提醒 ───────── -->
    <section class="card mb-4 p-4">
      <div class="flex items-start gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-xl" :style="pushIconStyle">
          <Icon :name="pushUi.icon" size="18" />
        </span>

        <div class="min-w-0 flex-1">
          <h2 class="text-sm leading-snug font-semibold text-[var(--text)]">
            {{ pushUi.title }}
          </h2>
          <p class="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            {{ pushUi.body }}
          </p>

          <ol
            v-if="pushUi.steps"
            class="mt-2.5 flex flex-col gap-1.5 text-xs leading-relaxed text-[var(--text-muted)]"
          >
            <li v-for="(step, i) in pushUi.steps" :key="i" class="flex items-start gap-2">
              <span
                class="tnum mt-px grid size-4 shrink-0 place-items-center rounded-full text-[0.625rem] font-semibold"
                style="background: var(--bg-sunken); color: var(--text)"
              >{{ i + 1 }}</span>
              <span>{{ step }}</span>
            </li>
          </ol>

          <UiAppButton
            v-if="pushUi.action"
            class="mt-3 text-sm"
            icon="lucide:bell"
            :loading="push.busy.value"
            @click="push.subscribe()"
          >
            {{ pushUi.action }}
          </UiAppButton>

          <p v-if="push.error.value" class="mt-2 flex items-start gap-1.5 text-xs text-[var(--debit)]">
            <Icon name="lucide:circle-alert" size="14" class="mt-px shrink-0" />
            <span>{{ push.error.value }}</span>
          </p>
        </div>
      </div>
    </section>

    <!-- ───────── 新增 + 顯示時區 ───────── -->
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <UiAppButton
        icon="lucide:plus"
        class="flex-1 md:flex-none"
        @click="openSheet()"
      >
        新增預約
      </UiAppButton>

      <div
        v-if="hasDated"
        class="ml-auto inline-flex items-center gap-1 rounded-xl p-1"
        style="background: var(--bg-sunken)"
        role="group"
        aria-label="時間顯示時區"
      >
        <button
          v-for="z in ZONES"
          :key="z.id"
          type="button"
          class="zone-btn"
          :class="{ 'is-active': z.id === displayZone.id }"
          :aria-pressed="z.id === displayZone.id"
          @click="displayZoneId = z.id"
        >
          {{ z.short }}
        </button>
      </div>
    </div>

    <p
      v-if="justAdded"
      class="mb-3 flex items-start gap-1.5 text-sm"
      style="color: var(--credit)"
    >
      <Icon name="lucide:circle-check" size="15" class="mt-0.5 shrink-0" />
      <span>已加入「{{ justAdded }}」。</span>
    </p>

    <p
      v-if="loadError || loadErrorOverride"
      class="mb-3 flex items-start gap-1.5 text-sm text-[var(--debit)]"
    >
      <Icon name="lucide:circle-alert" size="15" class="mt-0.5 shrink-0" />
      <span>{{ loadError || loadErrorOverride }}</span>
    </p>

    <!-- ───────── 清單 ───────── -->
    <UiLoadingBlock v-if="loading" :rows="3" label="預約清單載入中" />

    <div v-else-if="!hasAny" class="card">
      <UiEmptyState
        icon="lucide:calendar-clock"
        title="還沒有要搶的預約"
        description="先把想吃的店和開放訂位的時間記下來。開放前這裡會推一則通知給你,不用自己一直算日子。"
      >
        <UiAppButton icon="lucide:plus" @click="openSheet()">
          新增第一筆預約
        </UiAppButton>
      </UiEmptyState>
    </div>

    <div v-else class="flex flex-col gap-6">
      <section v-if="openNow.length">
        <h2 class="section-title" style="color: var(--warn)">
          <Icon name="lucide:alarm-clock" size="14" class="shrink-0" />
          已開放,待確認
          <span class="tnum font-normal opacity-70">{{ openNow.length }}</span>
        </h2>
        <div class="flex flex-col gap-2.5">
          <PlanReservationCard
            v-for="row in openNow"
            :key="row.r.id"
            :reservation="row.r"
            :now="now"
            :zone-label="displayZone.label"
            :zone-offset-min="displayZone.offsetMin"
            :alt-zone-label="altZone.short"
            :alt-zone-offset-min="altZone.offsetMin"
            :busy="busyId === row.r.id"
            @book="openBookSheet(row.r)"
            @edit="openBookSheet(row.r)"
            @cancel="setStatus(row.r, 'cancelled')"
            @reopen="setStatus(row.r, 'pending')"
          />
        </div>
      </section>

      <section v-if="upcoming.length">
        <h2 class="section-title">
          <Icon name="lucide:timer" size="14" class="shrink-0" />
          即將開放
          <span class="tnum font-normal opacity-70">{{ upcoming.length }}</span>
        </h2>
        <div class="flex flex-col gap-2.5">
          <PlanReservationCard
            v-for="row in upcoming"
            :key="row.r.id"
            :reservation="row.r"
            :now="now"
            :zone-label="displayZone.label"
            :zone-offset-min="displayZone.offsetMin"
            :alt-zone-label="altZone.short"
            :alt-zone-offset-min="altZone.offsetMin"
            :busy="busyId === row.r.id"
            @book="openBookSheet(row.r)"
            @edit="openBookSheet(row.r)"
            @cancel="setStatus(row.r, 'cancelled')"
            @reopen="setStatus(row.r, 'pending')"
          />
        </div>
      </section>

      <section v-if="undated.length">
        <h2 class="section-title">
          <Icon name="lucide:calendar-off" size="14" class="shrink-0" />
          還沒定時間
          <span class="tnum font-normal opacity-70">{{ undated.length }}</span>
        </h2>
        <div class="flex flex-col gap-2.5">
          <PlanReservationCard
            v-for="row in undated"
            :key="row.r.id"
            :reservation="row.r"
            :now="now"
            :zone-label="displayZone.label"
            :zone-offset-min="displayZone.offsetMin"
            :alt-zone-label="altZone.short"
            :alt-zone-offset-min="altZone.offsetMin"
            :busy="busyId === row.r.id"
            @book="openBookSheet(row.r)"
            @edit="openBookSheet(row.r)"
            @cancel="setStatus(row.r, 'cancelled')"
            @reopen="setStatus(row.r, 'pending')"
          />
        </div>
        <p class="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
          沒有開放時間就沒辦法提醒。查到之後重新加一筆帶時間的,或直接在店家頁面確認。
        </p>
      </section>

      <!-- 已訂到:按「訂到哪一餐」排序,這是行程真正要看的一區 -->
      <section v-if="booked.length">
        <h2 class="section-title" style="color: var(--credit)">
          <Icon name="lucide:circle-check" size="14" class="shrink-0" />
          已訂到
          <span class="tnum font-normal opacity-70">{{ booked.length }}</span>
        </h2>
        <div class="flex flex-col gap-2.5">
          <PlanReservationCard
            v-for="row in booked"
            :key="row.r.id"
            :reservation="row.r"
            :now="now"
            :zone-label="displayZone.label"
            :zone-offset-min="displayZone.offsetMin"
            :alt-zone-label="altZone.short"
            :alt-zone-offset-min="altZone.offsetMin"
            :busy="busyId === row.r.id"
            @book="openBookSheet(row.r)"
            @edit="openBookSheet(row.r)"
            @cancel="setStatus(row.r, 'cancelled')"
            @reopen="setStatus(row.r, 'pending')"
          />
        </div>
        <p class="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
          這一區按訂位時間排序(不是開放時間)。時間有變就按「改訂位」——
          不用刪掉重建,提醒紀錄會留著。
        </p>
      </section>

      <section v-if="cancelled.length">
        <h2 class="section-title">
          <Icon name="lucide:archive" size="14" class="shrink-0" />
          已取消
          <span class="tnum font-normal opacity-70">{{ cancelled.length }}</span>
        </h2>
        <div class="flex flex-col gap-2.5">
          <PlanReservationCard
            v-for="row in cancelled"
            :key="row.r.id"
            :reservation="row.r"
            :now="now"
            :zone-label="displayZone.label"
            :zone-offset-min="displayZone.offsetMin"
            :alt-zone-label="altZone.short"
            :alt-zone-offset-min="altZone.offsetMin"
            :busy="busyId === row.r.id"
            @book="openBookSheet(row.r)"
            @edit="openBookSheet(row.r)"
            @cancel="setStatus(row.r, 'cancelled')"
            @reopen="setStatus(row.r, 'pending')"
          />
        </div>
      </section>
    </div>

    <!-- ───────── 新增預約(手機從下方滑上來)───────── -->
    <UiAppSheet
      v-model:open="sheetOpen"
      title="新增預約"
      size="lg"
      :dismissible="!saving"
      @close="resetForm"
    >
      <form id="reservation-form" class="flex flex-col gap-4 pb-1" @submit.prevent="save">
        <UiAppField
          v-model="form.name"
          label="店名 / 項目"
          placeholder="例:鮨さいとう"
          required
          autofocus
        />

        <UiAppField
          v-model="form.url"
          label="訂位連結"
          type="text"
          placeholder="tabelog.com/…"
          inputmode="url"
          autocomplete="url"
          :hint="urlHint"
        />

        <!-- ── 開放時間 ── -->
        <div>
          <span class="label">開放預約的時間</span>

          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="q in quickDates"
              :key="q.value"
              type="button"
              class="chip"
              :class="{ 'is-active': form.date === q.value }"
              @click="applyQuickDate(q.value)"
            >
              {{ q.label }}
            </button>
          </div>

          <div class="mt-2 grid gap-2 sm:grid-cols-2">
            <UiAppField v-model="form.date" type="date" />
            <div>
              <input
                :id="timeFieldId"
                v-model="form.time"
                type="time"
                class="field tnum"
                step="60"
                aria-label="開放時刻"
              >
            </div>
          </div>

          <div class="mt-2">
            <UiAppField
              v-model="form.zoneId"
              type="select"
              :options="zoneOptions"
              hint="填當地時間就好。日本與台灣都沒有日光節約,偏移固定 +9 / +8。"
            />
          </div>

          <p v-if="timeError" class="mt-1.5 flex items-start gap-1 text-xs text-[var(--debit)]">
            <Icon name="lucide:circle-alert" size="14" class="mt-px shrink-0" />
            <span>{{ timeError }}</span>
          </p>
          <p v-else-if="!form.date" class="mt-1.5 text-xs leading-relaxed text-[var(--text-muted)]">
            還不知道時間也可以先建立,之後會列在「還沒定時間」——不過那樣就不會有提醒。
          </p>
        </div>

        <!-- ── 換算確認 ── -->
        <div
          v-if="preview"
          class="rounded-xl p-3"
          style="background: var(--bg-sunken); border: 1px solid var(--border)"
        >
          <p class="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
            <Icon name="lucide:globe" size="14" class="shrink-0" />
            確認一下時間對不對
          </p>

          <dl class="flex flex-col gap-1.5 text-xs">
            <div
              v-for="z in preview.zones"
              :key="z.id"
              class="flex items-baseline justify-between gap-3"
            >
              <dt class="shrink-0" :class="z.isInput ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-muted)]'">
                {{ z.label }}<span v-if="z.isInput" class="ml-1 font-normal text-[var(--brand)]">你輸入的</span>
              </dt>
              <dd class="tnum text-right" :class="z.isInput ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-muted)]'">
                {{ z.text }}
              </dd>
            </div>
            <div class="flex items-baseline justify-between gap-3 border-t pt-1.5" style="border-color: var(--border)">
              <dt class="shrink-0 text-[var(--text-muted)]">
                存進資料庫(UTC)
              </dt>
              <dd class="tnum text-right text-[var(--text-muted)]">
                {{ preview.iso }}
              </dd>
            </div>
          </dl>

          <p v-if="preview.remindAt" class="mt-2 flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
            <Icon name="lucide:bell" size="13" class="mt-0.5 shrink-0" />
            <span>提醒會在 <span class="tnum font-medium text-[var(--text)]">{{ preview.remindAt }}</span>({{ inputZone.label }})前後送出。</span>
          </p>

          <p v-if="preview.past" class="mt-2 flex items-start gap-1.5 text-xs" style="color: var(--warn)">
            <Icon name="lucide:triangle-alert" size="13" class="mt-0.5 shrink-0" />
            <span>這個時間已經過了,不會再發提醒。確認一下年月是不是選錯。</span>
          </p>
        </div>

        <UiAppField
          v-model="form.remind"
          label="提前多久提醒"
          type="select"
          :options="REMIND_OPTIONS"
          hint="伺服器每 5 分鐘檢查一次,通知會在設定的時間點前後幾分鐘送到。要準時搶位就多留一點。"
        />

        <div class="grid gap-3 sm:grid-cols-2">
          <UiAppField
            v-model="form.bookingName"
            label="訂位名字"
            placeholder="例:Sammy Yang"
            hint="打算用誰的名字訂。訂到之後還能改。"
          />
          <UiAppField
            v-model.number="form.partySize"
            label="人數"
            type="number"
            min="1"
            step="1"
            inputmode="numeric"
            placeholder="2"
          />
        </div>

        <UiAppField
          v-model="form.note"
          label="備註"
          type="textarea"
          :rows="2"
          placeholder="例:只收 4 人以下 / 要先加官方 LINE"
        />

        <p v-if="formError" class="flex items-start gap-1.5 text-sm text-[var(--debit)]">
          <Icon name="lucide:circle-alert" size="15" class="mt-0.5 shrink-0" />
          <span>{{ formError }}</span>
        </p>
      </form>

      <template #footer>
        <UiAppButton variant="ghost" block :disabled="saving" @click="sheetOpen = false">
          取消
        </UiAppButton>
        <UiAppButton
          block
          type="submit"
          form="reservation-form"
          icon="lucide:check"
          :loading="saving"
          :disabled="!canSave"
        >
          {{ saving ? '新增中' : '新增' }}
        </UiAppButton>
      </template>
    </UiAppSheet>

    <!-- ───────── 訂到了 / 改訂位時間 ───────── -->
    <UiAppSheet
      v-model:open="bookSheetOpen"
      :title="`訂位資訊 — ${bookForm.storeName}`"
      size="lg"
      :dismissible="!bookSaving"
    >
      <form id="booking-form" class="flex flex-col gap-4 pb-1" @submit.prevent="saveBooking">
        <p class="text-sm leading-relaxed text-[var(--text-muted)]">
          填「實際訂到哪一餐」——和上面的開放時間是兩件不同的事。
          例如 10/1 開放搶,訂到的是隔年 1/1 晚上 18:30,這裡就填 1/1 18:30。
        </p>

        <!-- ── 訂位時間 ── -->
        <div>
          <span class="label">訂到的日期與時刻</span>
          <div class="grid gap-2 sm:grid-cols-2">
            <UiAppField v-model="bookForm.date" type="date" />
            <div>
              <input
                v-model="bookForm.time"
                type="time"
                class="field tnum"
                step="60"
                aria-label="訂位時刻"
              >
            </div>
          </div>

          <div class="mt-2">
            <UiAppField
              v-model="bookForm.zoneId"
              type="select"
              :options="zoneOptions"
              hint="填當地時間。日本沒有日光節約,偏移固定 +9。"
            />
          </div>

          <p v-if="bookTimeError" class="mt-1.5 flex items-start gap-1 text-xs text-[var(--debit)]">
            <Icon name="lucide:circle-alert" size="14" class="mt-px shrink-0" />
            <span>{{ bookTimeError }}</span>
          </p>
          <p v-else-if="!bookForm.date" class="mt-1.5 text-xs leading-relaxed text-[var(--text-muted)]">
            先標成已訂到、時間之後再補也可以 —— 那樣清單上會提醒你這筆還缺時間。
          </p>
        </div>

        <!-- ── 時區換算確認 ── -->
        <div
          v-if="bookPreview"
          class="rounded-xl p-3"
          style="background: var(--bg-sunken); border: 1px solid var(--border)"
        >
          <p class="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
            <Icon name="lucide:globe" size="14" class="shrink-0" />
            確認一下時間對不對
          </p>
          <dl class="flex flex-col gap-1.5 text-xs">
            <div v-for="z in bookPreview" :key="z.id" class="flex items-baseline justify-between gap-3">
              <dt
                class="shrink-0"
                :class="z.isInput ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-muted)]'"
              >
                {{ z.label }}<span v-if="z.isInput" class="ml-1 font-normal text-[var(--brand)]">你輸入的</span>
              </dt>
              <dd
                class="tnum text-right"
                :class="z.isInput ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-muted)]'"
              >
                {{ z.text }}
              </dd>
            </div>
          </dl>
        </div>

        <UiAppField
          v-model="bookForm.bookingName"
          label="訂位名字"
          placeholder="例:Sammy Yang"
          hint="日本餐廳現場是喊名字的。用哪個名字訂的就填那個,記錯會進不去。"
        />

        <UiAppField
          v-model.number="bookForm.partySize"
          label="人數"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          placeholder="2"
          hint="要改人數通常得重訂,所以記下來。"
        />

        <UiAppField
          v-model="bookForm.note"
          label="備註"
          type="textarea"
          :rows="2"
          placeholder="例:訂到吧台 / 遲到 15 分鐘會被取消"
        />

        <p v-if="bookError" class="flex items-start gap-1.5 text-sm text-[var(--debit)]">
          <Icon name="lucide:circle-alert" size="15" class="mt-0.5 shrink-0" />
          <span>{{ bookError }}</span>
        </p>
      </form>

      <template #footer>
        <UiAppButton variant="ghost" block :disabled="bookSaving" @click="bookSheetOpen = false">
          取消
        </UiAppButton>
        <UiAppButton
          block
          type="submit"
          form="booking-form"
          icon="lucide:check"
          :loading="bookSaving"
          :disabled="!canSaveBooking"
        >
          {{ bookSaving ? '儲存中' : '儲存' }}
        </UiAppButton>
      </template>
    </UiAppSheet>
  </div>
</template>

<style scoped>
/* 顏色一律走 main.css 的 CSS 變數,深色模式自動跟著換。 */

.section-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin-bottom: 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted);
}

/* 顯示時區切換。次要控件,但點擊區還是給滿 44px */
.zone-btn {
  min-height: 36px;
  min-width: 52px;
  padding-inline: 0.75rem;
  border-radius: 0.625rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.zone-btn.is-active {
  background: var(--bg-elevated);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
}

/* 日期快捷 */
.chip {
  min-height: 36px;
  padding-inline: 0.75rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-sunken);
  font-size: 0.8125rem;
  color: var(--text-muted);
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.chip:active {
  transform: scale(0.98);
}
.chip.is-active {
  border-color: var(--brand);
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .zone-btn,
  .chip {
    transition: none;
  }
  .chip:active {
    transform: none;
  }
}
</style>
