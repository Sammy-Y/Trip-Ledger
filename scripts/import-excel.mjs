/**
 * 把「202603 神戶京都宇治.xlsx」整份匯入。
 *
 * 走 API 而不是直接寫 D1 —— 這樣才會經過 server 的驗證邏輯,
 * 是對整條路徑的真實測試,而不只是塞資料進資料庫。
 *
 * 用法:node scripts/import-excel.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://localhost:3000';

// ── 來源資料(從 xlsx 抽出,原樣保留)──────────────────────────
// 共同花費:項目 | 幣別 | 金額 | 人員(付款人) | 備註
// ⚠️ 27 筆裡只有 2 筆填了「人員」。這正是原 Excel 算不出「誰欠誰」的原因。
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
   '3/9｜米果玩具 1,735 (公)\n3/9｜平等院線香 1,200 (民)\n3/10｜線香 6,270 (民)\n3/12｜扭蛋 600 (喧)'],
  ['雜項',                'JPY',  4310, null, null,
   '3/8｜2/b 吊飾 1,320 (公)\n3/11｜飯店稅金 800 (公)\n3/12｜暖暖包 100 (喧)\n3/13｜3coins 2,090 (民)'],
];

// 個人花費:項目 | 幣別 | 金額 | 人員(擁有者)
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

// 預訂(來自「預訂」工作表)。開放預約時間是 JST,要轉 UTC(日本固定 +9,無日光節約)。
const RESERVATIONS = [
  ['空蟬亭', 'https://www.tablecheck.com/shops/karasemitei/reserve',
   '2026-02-01T12:00:00+09:00', '2/1要訂位,每月1號中午12:00開放預約,預訂下兩個月內的座位'],
  ['朝食喜心', 'https://www.tablecheck.com/shops/kishin-kyoto/reserve',
   '2026-02-01T09:00:00+09:00', '2/1開放預訂'],
  ['Moritaya - Kiyamachi', 'https://yoyaku.toreta.in/moritayakiyamachi/#/',
   '2026-02-02T18:00:00+09:00', '提前三個月預訂,12/10訂位。壽喜燒'],
  ['忍轟 (LINE Reservate)', 'https://www.instagram.com/yakinikuen_ning/',
   '2026-03-11T18:30:00+09:00', '東心斎橋総本店,燒肉,用LINE訂位'],
  ['Grilled Yakitori Tokoha Namba', 'https://booking.resty.jp/webrsv/vacant/s021025102/22195',
   null, '生雞肉、生雞蛋拌飯'],
];

const TRIP_START = '2026-03-08';
const DEFAULT_PAYER = 'MIN';   // 原始資料沒有付款人時用它,並在備註標明

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

// 成員取自「下拉清單」工作表(權威來源),與 Excel 的「/2」公式一致
const trip = await req('POST', '/api/trips', {
  name: '2026/03 神戶京都宇治（Excel 匯入）',
  base_currency: 'TWD',
  members: ['MIN', 'Hsuan'],
});
const { members } = await req('GET', `/api/trips/${trip.share_token}`);
const id = Object.fromEntries(members.map((m) => [m.name, m.id]));
const ALL = [id['MIN'], id['Hsuan']];
console.log(`旅程建立: ${trip.id}\n成員: ${members.map((m) => m.name).join(' / ')}\n`);

let ok = 0, fail = 0, noPayer = 0;
const failures = [];

console.log('── 共同花費 ──');
for (const [desc, cur, amt, payer, date, note] of SHARED) {
  const missing = !payer;
  if (missing) noPayer++;
  const notes = [note, missing ? '⚠ 原 Excel 未記錄付款人,匯入時暫記為 MIN' : null]
    .filter(Boolean).join('\n\n');
  try {
    await req('POST', `/api/trips/${trip.share_token}/expenses`, {
      kind: 'shared', description: desc, currency: cur, amount: amt,
      payment_method: 'cash', spent_at: date || TRIP_START,
      note: notes || undefined,
      payers: [{ member_id: id[payer || DEFAULT_PAYER] }],
      split: { mode: 'equal', members: ALL },   // Excel 的 /2 就是全員均分
    });
    ok++;
    console.log(`  ✔ ${desc.padEnd(22)} ${cur} ${String(amt).padStart(7)}${missing ? '  (無付款人→MIN)' : `  付款:${payer}`}`);
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
for (const [name, url, opensJst, note] of RESERVATIONS) {
  try {
    // JST → UTC。存成 SQLite 的 datetime 可比較格式。
    const opensUtc = opensJst
      ? new Date(opensJst).toISOString().replace('T', ' ').slice(0, 19)
      : null;
    await req('POST', `/api/trips/${trip.share_token}/reservations`, {
      name, url, opens_at_utc: opensUtc, remind_before_min: 10, note,
    });
    resOk++;
    console.log(`  ✔ ${name.padEnd(30)} ${opensJst ? `${opensJst} → ${opensUtc} UTC` : '(未設開放時間)'}`);
  } catch (e) {
    console.log(`  ✘ ${name} → ${e.message}`);
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`支出: ${ok} 成功 / ${fail} 失敗   預訂: ${resOk}/${RESERVATIONS.length}`);
console.log(`⚠ 共同花費有 ${noPayer}/${SHARED.length} 筆在原 Excel 沒有記錄付款人`);
if (failures.length) { console.log('\n失敗明細:'); failures.forEach((f) => console.log('  ' + f)); }
console.log(`\n開啟: ${BASE}/t/${trip.id}`);
console.log(`trip id: ${trip.id}`);
