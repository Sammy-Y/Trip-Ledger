/**
 * 把「202603 神戶京都宇治.xlsx」整份匯入。
 *
 * 走 API 而不是直接寫 D1 —— 這樣才會經過 server 的驗證邏輯,
 * 是對整條路徑的真實測試,而不只是塞資料進資料庫。
 *
 * ══ 「人員」欄留空 = 公費支出 ══════════════════════════════════
 *
 * 共同花費 27 筆裡有 25 筆的「人員」欄是空的。這件事以前的處理方式是
 * 「暫記為 MIN,並在備註標一個 ⚠」—— 那是把一個未知硬塞給一個人,
 * 結算出來的「誰欠誰」是假的,而且假得很有說服力(有金額、有付款人)。
 *
 * 專案作者確認了原檔的真實語意:沒寫付款人,就代表那筆是從公費出的。
 * 這也和備註裡自己出現的「(公費)」互相印證 —— 原檔確實有公費這個概念,
 * 只是沒有一欄可以記它。所以現在:
 *
 *   人員留空        → 付款人 = 公費成員(is_pot=1),分攤 = 只有真人均分
 *   人員有填(2 筆) → 付款人 = 那個人,分攤 = 只有真人均分
 *
 * 公費**永遠不進分攤名單**:它是出錢的一方,不是受益人。
 * (server 端會 400 擋掉,見 expenses.post.ts 的「成員驗證」段。)
 *
 * ⚠️ 匯入後公費的淨額會是一個很大的負數,那是對的:這支腳本只知道公費
 * 「付掉了多少」,不知道每個人「投入了多少」—— 原 Excel 沒有記投入。
 * 投入要在總覽頁用「投入」手動補,補完公費才會平。
 *
 * 用法:node scripts/import-excel.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:3000';

// ── 來源資料(從 xlsx 抽出)────────────────────────────────────
//
// 一處刻意的改寫:原始備註寫的是「(公)」,這裡展開成「(公費)」。
// 原檔沒有任何地方定義「公」是什麼(全檔搜「公費」是 0 筆命中),
// 語意是專案作者提供的 —— 那是一筆從公費出的錢,不是某個人付的。
// 備註欄的用途是讓人日後看得懂這筆總額是怎麼組成的,
// 所以這裡選清楚而不選逐字轉錄。
// 共同花費:項目 | 幣別 | 金額 | 人員(付款人,null = 公費) | 日期 | 備註
const SHARED = [
  ['機票（來回）',        'TWD', 22596, null,    null, null],
  ['住宿(大阪)',          'TWD',  6633, null,    null, null],
  ['住宿(京都)',          'TWD',  7111, null,    null, null],
  ['國泰旅平險+不便險',   'TWD',  1798, null,    null, null],
  ['E-SIM DJB',           'TWD',  1404, null,    null, null],
  ['Klook 行程 (伊根)',   'TWD',  3250, null,    null, null],
  ['機場計程車',          'TWD',   413, null,    null, null],
  ['回程高鐵',            'TWD',  1080, null,    null, null],
  ['Icoca加值',           'JPY', 10000, 'MIN',   null, null],
  ['Icoca加值',           'TWD',  1617, 'Hsuan', null, null],
  ['3/8 吃飯',            'JPY', 13244, null, '2026-03-08', null],
  ['3/8 超商、超市',      'JPY',   662, null, '2026-03-08', null],
  ['3/9 吃飯',            'JPY', 18109, null, '2026-03-09', null],
  ['3/9 超商、超市',      'JPY',    99, null, '2026-03-09', null],
  ['3/10 吃飯',           'JPY', 24796, null, '2026-03-10', null],
  ['3/10 超商、超市',     'JPY',  2337, null, '2026-03-10', null],
  ['3/11 吃飯',           'JPY', 14555, null, '2026-03-11', null],
  ['3/11 超商、超市',     'JPY',  1870, null, '2026-03-11', null],
  ['3/12 吃飯',           'JPY',  4790, null, '2026-03-12', null],
  ['3/12 超商、超市',     'JPY',  3477, null, '2026-03-12', null],
  ['3/13 吃飯',           'JPY',  6904, null, '2026-03-13', null],
  ['3/13 超商、超市',     'JPY',  5523, null, '2026-03-13', null],
  ['3/13 勝尾寺計程車',   'JPY',  3400, null, '2026-03-13', null],
  ['門票、御守合計',      'JPY',  8100, null, null,
   '平等院門票 1400\n(清水1000+金閣1000+下鴨御守1500) / 民 1,500 (下鴨御守)\n伊根 400 (舟屋參觀門票) / 天橋立瓦片 300\n勝尾寺門票1000'],
  ['伴手禮總計',          'JPY', 16882, null, null,
   '3/8｜草莓餅乾 2,969 (喧)\n3/9｜伊藤久右衛門 6,274 (民: 3857 / 喧: 2417)\n3/10｜西尾抹茶夾心捲 (民 - 未標示金額)\n3/12｜伊根伴手禮 2,600 (喧刷卡)\n3/13｜砂糖樹 2,592 (民)\n3/13｜阪急洋芋片 2,447 (喧)'],
  ['線香、玩具',          'JPY',  9805, null, null,
   '3/9｜米果玩具 1,735 (公費)\n3/9｜平等院線香 1,200 (民)\n3/10｜線香 6,270 (民)\n3/12｜扭蛋 600 (喧)'],
  ['雜項',                'JPY',  4310, null, null,
   '3/8｜2/b 吊飾 1,320 (公費)\n3/11｜飯店稅金 800 (公費)\n3/12｜暖暖包 100 (喧)\n3/13｜3coins 2,090 (民)'],
];

// 個人花費:項目 | 幣別 | 金額 | 人員(擁有者)
// 這裡沒有「留空 = 公費」的問題 —— 個人花費原檔每一筆都有人員,
// 而且公費本來就不能當個人花費的付款人(server 會 400)。
const PERSONAL = [
  ['北臉紫標後背包',   'JPY', 25000, 'MIN'],
  ['Human made 吊飾',  'JPY',  3300, 'MIN'],
  ['無印良品襪子',     'JPY',  2970, 'MIN'],   // 原式 =990*3
  ['H&M 衣服',         'JPY',  3418, 'MIN'],
  ['Needles褲子',      'JPY', 21000, 'MIN'],
  ['勝尾寺達摩',       'JPY',  6000, 'MIN'],
  ['Tutu anna 襪子',   'JPY',  1089, 'Hsuan'],
  ['H&M 衣服',         'JPY',  1619, 'Hsuan'],
  ['Uniqlo',           'JPY',  5462, 'Hsuan'],
  ['香水',             'JPY',  2500, 'Hsuan'],
  ['藥妝、化妝品',     'JPY', 26594, 'Hsuan'],
  ['藥妝代購，扣繳',   'TWD', -2062, 'Hsuan'], // 負數:代購扣繳
  ['勝尾寺達摩',       'JPY',  1000, 'Hsuan'],
];

// 預訂(來自「預訂」工作表)。項目 | 網址 | 開放預約(JST) | 訂位名字 | 備註
// 開放預約時間是 JST,要轉 UTC(日本固定 +9,無日光節約)。
//
// 訂位名字**不是「預訂」工作表的欄位** —— 那張表根本沒有這一欄。
// 下面三筆的名字是從「行程」工作表抄來的(原檔把訂位人寫在行程說明裡):
// 空蟬亭 / 朝食喜心 記的是「Sammy Yang」,忍轟 記的是「Sammy」。
// 兩者不統一是原檔就這樣,照抄不合併 —— 日本餐廳現場是喊名字的,
// 猜錯比留空更糟。剩下兩筆行程表也沒寫,就留 null。
//
// 刻意**不填 booked_for_utc**:原檔「預約時段」欄的年份是 2025,
// 比這趟旅程早一年,顯然是沿用舊表沒改。直接匯入會在行程頁生出
// 錯得很像真的日期。年份要怎麼修正還沒有決定,所以先不寫。
const RESERVATIONS = [
  ['空蟬亭', 'https://www.tablecheck.com/shops/karasemitei/reserve',
   '2026-02-01T12:00:00+09:00', 'Sammy Yang',
   '2/1要訂位,每月1號中午12:00開放預約,預訂下兩個月內的座位'],
  ['朝食喜心', 'https://www.tablecheck.com/shops/kishin-kyoto/reserve',
   '2026-02-01T09:00:00+09:00', 'Sammy Yang', '2/1開放預訂'],
  ['Moritaya - Kiyamachi', 'https://yoyaku.toreta.in/moritayakiyamachi/#/',
   '2026-02-02T18:00:00+09:00', null, '提前三個月預訂,12/10訂位。壽喜燒'],
  ['忍轟 (LINE Reservate)', 'https://www.instagram.com/yakinikuen_ning/',
   '2026-03-11T18:30:00+09:00', 'Sammy', '東心斎橋総本店,燒肉,用LINE訂位'],
  ['Grilled Yakitori Tokoha Namba', 'https://booking.resty.jp/webrsv/vacant/s021025102/22195',
   null, null, '生雞肉、生雞蛋拌飯'],
];

const TRIP_START = '2026-03-08';
const POT_NAME = '公費';
// 人員留空的那 25 筆要寫進備註的說明。不再是 ⚠ ——
// 「這筆從公費付」是一個已確認的事實,不是匯入時的權宜之計。
const POT_NOTE = `由${POT_NAME}支付:原 Excel 的「人員」欄留空,而留空就代表這筆是從${POT_NAME}出的錢。`;

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt.slice(0, 300) }; }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${json.statusMessage || json.message || txt.slice(0, 200)}`);
  return json;
}

console.log(`匯入目標: ${BASE}\n`);

// 匯率必須先有,否則每筆的 fx_rate 都會是 null
await req('POST', '/api/admin/sync-rates');

// 成員取自「下拉清單」工作表(權威來源),與 Excel 的「/2」公式一致。
// pot 讓 server 順手建一個 is_pot=1 的成員 —— 25 筆留空的付款人要記到它身上。
const trip = await req('POST', '/api/trips', {
  name: '2026/03 神戶京都宇治（Excel 匯入）',
  base_currency: 'TWD',
  members: ['MIN', 'Hsuan'],
  pot: POT_NAME,
});
const { members } = await req('GET', `/api/trips/${trip.share_token}`);

// 公費用 is_pot 認,不用名字認 —— 名字只是顯示用的,改名不該讓匯入靜靜壞掉。
const potId = members.find((m) => m.is_pot === 1)?.id;
// 名字→id 的表**只收真人**。這樣就算資料裡的人員欄哪天出現「公費」兩個字,
// 也不會被解析成公費付款,而是直接 undefined 然後炸掉(炸掉比默默記錯好)。
const people = members.filter((m) => m.is_pot === 0);
const id = Object.fromEntries(people.map((m) => [m.name, m.id]));
// 均分名單:只有真人。公費進分攤等於它自己欠自己,server 會 400。
const ALL = people.map((m) => m.id);

if (!potId) throw new Error('公費成員沒有建起來 —— POST /api/trips 的 pot 參數沒生效?');
if (!ALL.length) throw new Error('沒有任何真人成員,無法均分');

console.log(`旅程建立: ${trip.id}`);
console.log(`成員: ${people.map((m) => m.name).join(' / ')}   公費: ${POT_NAME}\n`);

let ok = 0, fail = 0, fromPot = 0;
const failures = [];

console.log('── 共同花費 ──');
for (const [desc, cur, amt, payer, date, note] of SHARED) {
  // 沒有 payer 不是「缺資料」,而是一個有意義的值:這筆從公費付。
  const byPot = !payer;
  if (byPot) fromPot++;
  const notes = [note, byPot ? POT_NOTE : null].filter(Boolean).join('\n\n');
  try {
    await req('POST', `/api/trips/${trip.share_token}/expenses`, {
      kind: 'shared', description: desc, currency: cur, amount: amt,
      payment_method: 'cash', spent_at: date || TRIP_START,
      note: notes || undefined,
      payers: [{ member_id: byPot ? potId : id[payer] }],
      split: { mode: 'equal', members: ALL },   // Excel 的 /2 就是真人全員均分
    });
    ok++;
    console.log(`  ✔ ${desc.padEnd(22)} ${cur} ${String(amt).padStart(7)}  付款:${byPot ? `${POT_NAME}(人員留空)` : payer}`);
  } catch (e) {
    fail++; failures.push(`${desc}: ${e.message}`);
    console.log(`  ✘ ${desc} → ${e.message}`);
  }
}

console.log('\n── 個人花費 ──');
for (const [desc, cur, amt, owner] of PERSONAL) {
  try {
    await req('POST', `/api/trips/${trip.share_token}/expenses`, {
      kind: 'personal', description: desc, currency: cur, amount: amt,
      payment_method: 'cash', spent_at: TRIP_START,
      payers: [{ member_id: id[owner] }],
      split: { mode: 'exact', amounts: { [id[owner]]: amt } },
    });
    ok++;
    console.log(`  ✔ ${desc.padEnd(22)} ${cur} ${String(amt).padStart(7)}  ${owner}`);
  } catch (e) {
    fail++; failures.push(`${desc}: ${e.message}`);
    console.log(`  ✘ ${desc} → ${e.message}`);
  }
}

console.log('\n── 預訂 ──');
let resOk = 0;
for (const [name, url, opensJst, bookingName, note] of RESERVATIONS) {
  try {
    // JST → UTC。存成 SQLite 的 datetime 可比較格式。
    const opensUtc = opensJst
      ? new Date(opensJst).toISOString().replace('T', ' ').slice(0, 19)
      : null;
    await req('POST', `/api/trips/${trip.share_token}/reservations`, {
      name, url, opens_at_utc: opensUtc,
      booking_name: bookingName ?? undefined,
      remind_before_min: 10, note,
    });
    resOk++;
    const who = bookingName ? `  訂位名:${bookingName}` : '';
    console.log(`  ✔ ${name.padEnd(30)} ${opensJst ? `${opensJst} → ${opensUtc} UTC` : '(未設開放時間)'}${who}`);
  } catch (e) {
    console.log(`  ✘ ${name} → ${e.message}`);
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`支出: ${ok} 成功 / ${fail} 失敗   預訂: ${resOk}/${RESERVATIONS.length}`);
// 這個數字要一直印出來:它是原 Excel 算不出「誰欠誰」的原因,
// 也是解釋「為什麼公費付了這麼多筆」的唯一線索。
console.log(`ℹ 共同花費有 ${fromPot}/${SHARED.length} 筆在原 Excel 沒有記錄付款人,`);
console.log(`  依「人員留空 = ${POT_NAME}支出」的語意,這些都匯入成由${POT_NAME}支付的共同花費。`);
console.log(`  ${POT_NAME}目前淨額會是負的 —— 每個人投入了多少原檔沒記,請到總覽頁用「投入」補上。`);
console.log(`ℹ 預訂的「預約時段」沒有匯入(原檔年份是 2025,待人工確認後再補 booked_for_utc)。`);
if (failures.length) { console.log('\n失敗明細:'); failures.forEach((f) => console.log('  ' + f)); }
console.log(`\n開啟: ${BASE}/t/${trip.id}`);
console.log(`trip id: ${trip.id}`);
