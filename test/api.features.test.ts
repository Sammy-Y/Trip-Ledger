/**
 * 新功能的 API 整合測試。打真實 dev server + 真實本機 D1,不 mock。
 *
 *   pnpm dev            # 另一個終端
 *   pnpm test:features
 *
 * 涵蓋:
 *   - 公費（is_pot）:唯一性、投入/支出/退還的收支、公費淨額 = 公費花費
 *     （淨額不含投入/退還 —— 見 server/utils/ledger.ts 開頭）
 *   - 成員改名 / 刪除:有帳的人不准刪（否則 CASCADE 會無聲破壞守恆）
 *   - 刷卡手續費 fx_markup_pct:預設值、自訂值、本位幣歸零、範圍驗證
 *   - 預約:訂位時間與開放時間是兩個獨立欄位、PATCH 改訂位、訂位名字/人數
 */
import { group, check, eq, summary } from './_harness.ts';

const BASE = process.argv[2] || process.env.BASE_URL || '';

async function findBase(): Promise<string | null> {
  const cands = BASE ? [BASE] : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
  for (const b of cands) {
    try {
      const r = await fetch(`${b}/api/trips/__probe__`, { signal: AbortSignal.timeout(3000) });
      if (r.status === 404 || r.ok) return b;
    } catch { /* 試下一個 */ }
  }
  return null;
}

const base = await findBase();
if (!base) {
  console.log('\n⚠ 找不到執行中的 dev server。請先 `pnpm dev`,再重跑這支測試。');
  process.exit(2);
}
console.log(`dev server: ${base}`);

type J = Record<string, any>;
async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: J }> {
  const r = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: J = {};
  const txt = await r.text();
  try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt.slice(0, 200) }; }
  return { status: r.status, json };
}
const get = (p: string) => req('GET', p);
const post = (p: string, b?: unknown) => req('POST', p, b);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);
const del = (p: string) => req('DELETE', p);

await post('/api/admin/sync-rates');

// ═══════════════════════════════════════════════════════════════
group('[公費] 建立與唯一性');

const trip = await post('/api/trips', {
  name: `公費測試 ${Date.now()}`, base_currency: 'TWD',
  members: ['民', '喧'], pot: '公費',
});
eq('建立旅程(含公費) → 201', trip.status, 201);
const T = trip.json.share_token;

const tripRes = await get(`/api/trips/${T}`);
eq('三個成員(兩人 + 公費)', tripRes.json.members?.length, 3);

const members: Array<{ id: string; name: string; is_pot: number }> = tripRes.json.members ?? [];
const id: Record<string, string> = {};
for (const m of members) id[m.name] = m.id;

const potMember = members.filter((m) => m.is_pot === 1);
eq('剛好一個 is_pot = 1', potMember.length, 1);
eq('公費就是那個叫「公費」的', potMember[0]?.name, '公費');
check('人的 is_pot 是 0', members.filter((m) => m.name !== '公費').every((m) => m.is_pot === 0));

// 公費排在最後 —— 它不是人,不該混在成員名單中間
eq('公費排在成員名單最後', members[members.length - 1]?.name, '公費');

check('回傳 fx_defaults', typeof tripRes.json.fx_defaults?.card_fee_pct === 'number',
  JSON.stringify(tripRes.json.fx_defaults));
eq('刷卡手續費預設 1.5%', tripRes.json.fx_defaults?.card_fee_pct, 1.5);
// 現金預設 0% —— 出發前在台灣換好的現金,成本在換鈔當下就固定了,
// 記帳時再加一次價差是重複計價。只有在當地才換的情況要自己填。
eq('現金價差預設 0%', tripRes.json.fx_defaults?.cash_spread_pct, 0);

const dupPot = await post(`/api/trips/${T}/members`, { name: '公費2', is_pot: true });
eq('第二個公費 → 400', dupPot.status, 400);
check('錯誤訊息說得出已經有公費', String(dupPot.json.statusMessage ?? '').includes('公費'),
  String(dupPot.json.statusMessage));

const dupName = await post(`/api/trips/${T}/members`, { name: '民' });
eq('重複的成員名字 → 400', dupName.status, 400);

// ═══════════════════════════════════════════════════════════════
group('[公費] 投入 → 支出 → 剩餘');

// 民、喧各投入 ¥10,000（settlement:人 → 公費）
for (const who of ['民', '喧']) {
  const r = await post(`/api/trips/${T}/settlements`, {
    from_member: id[who], to_member: id['公費'],
    currency: 'JPY', amount_minor: 10000, note: '投入公費',
  });
  check(`${who}投入 ¥10,000`, r.status === 200 || r.status === 201, String(r.status));
}

// 公費付掉晚餐 ¥6,000（兩人均分）+ 門票 ¥4,000（兩人均分）
for (const [desc, amt] of [['晚餐', 6000], ['門票', 4000]] as const) {
  const r = await post(`/api/trips/${T}/expenses`, {
    kind: 'shared', description: desc, currency: 'JPY', amount: amt,
    payment_method: 'cash', spent_at: '2026-03-08',
    payers: [{ member_id: id['公費'] }],
    split: { mode: 'equal', members: [id['民'], id['喧']] },
  });
  check(`公費付${desc} ¥${amt}`, r.status === 201, String(r.status));
}

const bal = await get(`/api/trips/${T}/balance`);
eq('balance → 200', bal.status, 200);

const pot = bal.json.pot;
check('balance 有 pot 區塊', !!pot, JSON.stringify(bal.json.pot));
eq('pot.name', pot?.name, '公費');

const jpyPot = (pot?.by_currency ?? []).find((r: J) => r.currency === 'JPY');
check('公費有日幣收支', !!jpyPot, JSON.stringify(pot?.by_currency));
eq('投入合計 ¥20,000', jpyPot?.contributedMinor, 20000);
eq('已支出 ¥10,000', jpyPot?.spentMinor, 10000);
eq('已退還 ¥0', jpyPot?.refundedMinor, 0);
eq('剩餘 ¥10,000', jpyPot?.remainingMinor, 10000);
eq('兩個人各投入一筆', jpyPot?.contributions?.length, 2);
check('每筆投入都是 ¥10,000',
  (jpyPot?.contributions ?? []).every((c: J) => c.amountMinor === 10000),
  JSON.stringify(jpyPot?.contributions));

// ── 淨額不含投入/退還(見 server/utils/ledger.ts 開頭)────────────
//
// 舊的不變量是「剩餘 = −公費淨額」;那條**故意被拿掉了** ——
// 剩餘只住在 pot.by_currency(總覽頁讀它),結算的算術裡不再有「信封剩多少」。
// 換上來的是這兩條,同樣是兩條獨立路徑算出同一個數字:
//   公費淨額 === spentMinor        (expense_payers 直接加總 vs netBalances 的加減)
//   Σ(真人淨額) === −spentMinor    (零和的另一半)
const jpyNets = new Map<string, number>(
  (bal.json.by_currency?.JPY?.nets ?? []).map((n: J) => [n.memberId, n.netMinor]));
eq('公費淨額 = 公費花掉的錢', jpyNets.get(id['公費']), jpyPot?.spentMinor);
eq('Σ(真人淨額) = −公費花費',
  [...jpyNets].filter(([m]) => m !== id['公費']).reduce((a, [, v]) => a + v, 0),
  -(jpyPot?.spentMinor ?? 0));
eq('日幣淨額總和為 0', [...jpyNets.values()].reduce((a, b) => a + b, 0), 0);

// 投入 ¥10,000 各自不進淨額,所以看到的只有「他分攤了 5,000 還沒付」。
// 舊語意在這裡是 +5000/+5000 —— 那是「信封裡的 10,000 被拆成兩列掛在他們身上」。
eq('民的淨額 −5000（他分攤了 5,000，投入不算）', jpyNets.get(id['民']), -5000);
eq('喧的淨額 −5000', jpyNets.get(id['喧']), -5000);

group('[公費] 退還');
const refund = await post(`/api/trips/${T}/settlements`, {
  from_member: id['公費'], to_member: id['民'],
  currency: 'JPY', amount_minor: 5000, note: '公費退還',
});
check('公費退還民 ¥5,000', refund.status === 200 || refund.status === 201, String(refund.status));

const bal2 = await get(`/api/trips/${T}/balance`);
const jpyPot2 = (bal2.json.pot?.by_currency ?? []).find((r: J) => r.currency === 'JPY');
eq('已退還 ¥5,000', jpyPot2?.refundedMinor, 5000);
eq('剩餘降到 ¥5,000', jpyPot2?.remainingMinor, 5000);
eq('退還紀錄一筆', jpyPot2?.refunds?.length, 1);

const jpyNets2 = new Map<string, number>(
  (bal2.json.by_currency?.JPY?.nets ?? []).map((n: J) => [n.memberId, n.netMinor]));
// 退還是公費 → 人,同樣不進淨額 —— 所以整組淨額**逐位元不變**。
// 這一條是「只排投入、忘了排退還」的專屬陷阱:那種寫法下民的淨額會變成 0。
eq('退還後 淨額逐位元不變',
  JSON.stringify(bal2.json.by_currency?.JPY?.nets),
  JSON.stringify(bal.json.by_currency?.JPY?.nets));
eq('退還後 民的淨額還是 −5000（退還不是還債，是把信封裡的錢拿回去）',
  jpyNets2.get(id['民']), -5000);
eq('退還後 公費淨額還是 = 公費花費', jpyNets2.get(id['公費']), jpyPot2?.spentMinor);
// 而剩餘確實跟著退還變了 —— 它只是不再和淨額掛在一起。
eq('剩餘降到 ¥5,000（總覽頁的數字照舊會動）', jpyPot2?.remainingMinor, 5000);

group('[公費] 沒設公費的旅程 pot = null');
const noPotTrip = await post('/api/trips', {
  name: `無公費 ${Date.now()}`, base_currency: 'TWD', members: ['甲'],
});
const noPotBal = await get(`/api/trips/${noPotTrip.json.share_token}/balance`);
eq('pot 是 null', noPotBal.json.pot, null);

// ═══════════════════════════════════════════════════════════════
group('[成員] 改名');

const rename = await patch(`/api/trips/${T}/members/${id['喧']}`, { name: '喧喧' });
eq('改名 → 200', rename.status, 200);
eq('名字改掉了', rename.json.name, '喧喧');

const afterRename = await get(`/api/trips/${T}`);
check('清單裡看到新名字',
  (afterRename.json.members ?? []).some((m: J) => m.name === '喧喧'),
  JSON.stringify(afterRename.json.members));

const renameClash = await patch(`/api/trips/${T}/members/${id['喧']}`, { name: '民' });
eq('改成別人的名字 → 400', renameClash.status, 400);

const renameEmpty = await patch(`/api/trips/${T}/members/${id['喧']}`, { name: '   ' });
eq('改成空白 → 400', renameEmpty.status, 400);

eq('改不存在的成員 → 404',
  (await patch(`/api/trips/${T}/members/00000000-0000-0000-0000-000000000000`, { name: 'x' })).status, 404);

group('[成員] 刪除:有帳的不准刪');

// 民有分攤、也有還款紀錄 → 一定要被擋住。
// 這條是最重要的一項:expense_shares 對 members 是 ON DELETE CASCADE,
// 真的刪下去會讓分攤金額無聲對不上,而且不會有任何錯誤訊息。
const delBusy = await del(`/api/trips/${T}/members/${id['民']}`);
eq('刪有帳的成員 → 409', delBusy.status, 409);
check('訊息說明原因', String(delBusy.json.statusMessage ?? '').includes('不能刪除'),
  String(delBusy.json.statusMessage));

// 確認真的沒被刪掉
const stillThere = await get(`/api/trips/${T}`);
check('民還在名單裡', (stillThere.json.members ?? []).some((m: J) => m.id === id['民']));

// 守恆沒被破壞
const balAfterFailedDelete = await get(`/api/trips/${T}/balance`);
const netsAfter = (balAfterFailedDelete.json.by_currency?.JPY?.nets ?? []).map((n: J) => n.netMinor);
eq('淨額總和仍為 0', netsAfter.reduce((a: number, b: number) => a + b, 0), 0);

// 沒有任何帳的成員可以刪
const fresh = await post(`/api/trips/${T}/members`, { name: '路人' });
eq('新增沒有帳的成員 → 201', fresh.status, 201);
const delFresh = await del(`/api/trips/${T}/members/${fresh.json.id}`);
check('刪沒有帳的成員 → 成功', delFresh.status === 200 || delFresh.status === 204, String(delFresh.status));
eq('刪不存在的成員 → 404',
  (await del(`/api/trips/${T}/members/00000000-0000-0000-0000-000000000000`)).status, 404);

group('[成員] 用過的公費不准取消公費身分');
const unsetPot = await patch(`/api/trips/${T}/members/${id['公費']}`, { is_pot: false });
eq('取消用過的公費 → 400', unsetPot.status, 400);

// ═══════════════════════════════════════════════════════════════
group('[刷卡手續費] fx_markup_pct');

async function makeExpense(body: J) {
  const r = await post(`/api/trips/${T}/expenses`, {
    kind: 'personal', currency: 'JPY', amount: 1000,
    spent_at: '2026-03-08',
    payers: [{ member_id: id['民'] }],
    split: { mode: 'exact', amounts: { [id['民']]: 1000 } },
    ...body,
  });
  return r;
}

const cardDefault = await makeExpense({ description: '刷卡預設', payment_method: 'card' });
eq('刷卡不給 markup → 201', cardDefault.status, 201);
eq('套用預設 1.5%', cardDefault.json.fx_markup_pct, 1.5);

const cashDefault = await makeExpense({ description: '現金預設', payment_method: 'cash' });
eq('現金套用預設 0%(不加價差)', cashDefault.json.fx_markup_pct, 0);

// 在當地才換鈔的情況:自己填得進去
const cashCustom = await makeExpense({
  description: '現金當地換鈔 0.8%', payment_method: 'cash', fx_markup_pct: 0.8,
});
eq('現金自訂 0.8% 被採用', cashCustom.json.fx_markup_pct, 0.8);

const cardCustom = await makeExpense({
  description: '刷卡自訂 2%', payment_method: 'card', fx_markup_pct: 2,
});
eq('自訂 2% 被採用', cardCustom.json.fx_markup_pct, 2);

const cardZero = await makeExpense({
  description: '刷卡免手續費', payment_method: 'card', fx_markup_pct: 0,
});
eq('0% 要被採用(不能被當成沒給而套預設)', cardZero.json.fx_markup_pct, 0);

const twdMarkup = await post(`/api/trips/${T}/expenses`, {
  kind: 'personal', description: '台幣不該有加成', currency: 'TWD', amount: 100,
  payment_method: 'card', fx_markup_pct: 5, spent_at: '2026-03-08',
  payers: [{ member_id: id['民'] }],
  split: { mode: 'exact', amounts: { [id['民']]: 100 } },
});
eq('本位幣一律 0%(送了 5 也歸零)', twdMarkup.json.fx_markup_pct, 0);

const badMarkup = await makeExpense({
  description: '超出範圍', payment_method: 'card', fx_markup_pct: 150,
});
eq('markup 150 → 400', badMarkup.status, 400);
eq('markup 負數 → 400',
  (await makeExpense({ description: '負數', payment_method: 'card', fx_markup_pct: -1 })).status, 400);

// 手續費真的要影響換算金額,不能只是存起來不用
const listed = await get(`/api/trips/${T}/expenses?kind=personal`);
const zeroRow = (listed.json as any[]).find((e: J) => e.description === '刷卡免手續費');
const twoRow = (listed.json as any[]).find((e: J) => e.description === '刷卡自訂 2%');
eq('0% 的那筆存下來是 0', zeroRow?.fx_markup_pct, 0);
eq('2% 的那筆存下來是 2', twoRow?.fx_markup_pct, 2);

// ═══════════════════════════════════════════════════════════════
group('[預約] 開放時間與訂位時間是兩件事');

const res = await post(`/api/trips/${T}/reservations`, {
  name: '空蟬亭',
  url: 'https://www.tablecheck.com/shops/karasemitei/reserve',
  // 2026/10/01 12:00 JST = 03:00 UTC —— 什麼時候開放搶
  opens_at_utc: '2026-10-01T03:00:00Z',
  remind_before_min: 30,
  booking_name: 'Sammy Yang',
  party_size: 2,
  note: '每月 1 號 12:00(JST)開放下兩個月',
});
eq('新增預約 → 201', res.status, 201);
eq('沒給訂位時間 → status 是 pending', res.json.status, 'pending');
const RID = res.json.id;

const list1 = await get(`/api/trips/${T}/reservations`);
const row1 = (list1.json as any[]).find((r: J) => r.id === RID);
check('回傳 booking_name', row1?.booking_name === 'Sammy Yang', JSON.stringify(row1));
eq('回傳 party_size', row1?.party_size, 2);
eq('還沒有訂位時間', row1?.booked_for_utc, null);
check('開放時間有值', !!row1?.opens_at_utc, String(row1?.opens_at_utc));

group('[預約] 打勾「我訂到了」+ 填訂位時間');
// 隔年 1/1 18:30 JST = 1/1 09:30 UTC —— 訂到的是哪一餐
const booked = await patch(`/api/trips/${T}/reservations/${RID}`, {
  status: 'booked',
  booked_for_utc: '2027-01-01T09:30:00Z',
  party_size: 4,
});
eq('PATCH → 200', booked.status, 200);
eq('狀態變成 booked', booked.json.status, 'booked');
check('訂位時間寫進去了', String(booked.json.booked_for_utc).startsWith('2027-01-01'),
  String(booked.json.booked_for_utc));
eq('人數改成 4', booked.json.party_size, 4);
// 這是這個功能的重點:兩個時間各自獨立,填了訂位時間不會蓋掉開放時間
check('開放時間沒有被動到', String(booked.json.opens_at_utc).startsWith('2026-10-01'),
  String(booked.json.opens_at_utc));
eq('沒送的欄位保持原值(booking_name)', booked.json.booking_name, 'Sammy Yang');

group('[預約] 訂位時間可以改（1/1 沒位子改 1/3）');
const moved = await patch(`/api/trips/${T}/reservations/${RID}`, {
  booked_for_utc: '2027-01-03T11:00:00Z',
});
eq('改時間 → 200', moved.status, 200);
check('新時間生效', String(moved.json.booked_for_utc).startsWith('2027-01-03'),
  String(moved.json.booked_for_utc));
eq('狀態還是 booked(沒送 status 就不該變)', moved.json.status, 'booked');
eq('人數保持 4', moved.json.party_size, 4);

group('[預約] 清空欄位 vs 不動欄位');
// null = 明確清掉;欄位不出現 = 不要動。COALESCE 分不出這兩者,所以要測。
const cleared = await patch(`/api/trips/${T}/reservations/${RID}`, { booked_for_utc: null });
eq('送 null 會清成 NULL', cleared.json.booked_for_utc, null);
eq('同一次請求沒送的 booking_name 沒被清掉', cleared.json.booking_name, 'Sammy Yang');

const restored = await patch(`/api/trips/${T}/reservations/${RID}`, {
  booked_for_utc: '2027-01-03T11:00:00Z',
});
check('可以再填回去', !!restored.json.booked_for_utc, String(restored.json.booked_for_utc));

group('[預約] 狀態切換與驗證');
eq('取消 → cancelled',
  (await patch(`/api/trips/${T}/reservations/${RID}`, { status: 'cancelled' })).json.status, 'cancelled');
eq('改回待訂 → pending',
  (await patch(`/api/trips/${T}/reservations/${RID}`, { status: 'pending' })).json.status, 'pending');
eq('亂給 status → 400',
  (await patch(`/api/trips/${T}/reservations/${RID}`, { status: 'whatever' })).status, 400);
eq('人數 0 → 400',
  (await patch(`/api/trips/${T}/reservations/${RID}`, { party_size: 0 })).status, 400);
eq('店名清空 → 400',
  (await patch(`/api/trips/${T}/reservations/${RID}`, { name: '  ' })).status, 400);
eq('改不存在的預約 → 404',
  (await patch(`/api/trips/${T}/reservations/00000000-0000-0000-0000-000000000000`, { status: 'booked' })).status,
  404);

group('[預約] 建立時直接帶訂位時間');
const direct = await post(`/api/trips/${T}/reservations`, {
  name: '朝食喜心', booked_for_utc: '2027-01-02T00:00:00Z', booking_name: '民', party_size: 2,
});
eq('新增 → 201', direct.status, 201);
eq('有訂位時間就自動算 booked', direct.json.status, 'booked');

process.exit(summary() > 0 ? 1 : 0);
