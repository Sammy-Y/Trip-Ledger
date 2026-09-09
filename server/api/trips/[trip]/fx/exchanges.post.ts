import { db } from '../../../../utils/cf';
import { requireTrip, uid } from '../../../../utils/trip';
import {
  normalizeExchangedAt,
  requirePositiveMinor,
} from '../../../../utils/exchange';

/**
 * 記一筆換匯。
 *
 * ── body 只收金額,不收匯率 ─────────────────────────────────────
 *
 * 使用者講的是「我換 0.21」,但**表單負責把它換成台幣**,API 收到的一律是
 * 兩個整數。理由和資料表存兩邊金額是同一個(見 schema.sql 的 fx_exchanges):
 *
 *  1. 有一個 source of truth 就好。API 同時收 rate 和 cost 的話,
 *     兩個對不起來時要挑一個 —— 而挑錯的那次會讓畫面上顯示的台幣
 *     和資料庫存的差幾塊錢,使用者永遠查不出為什麼。
 *  2. 四捨五入只發生一次,而且發生在使用者**看得到**的地方:
 *     表單上「付出 NT$1,050」那個數字就是存進去的數字。
 *
 * 表單那邊的雙向換算走 shared/money.ts 的 exchangeCostMinor(),
 * 和這裡讀出來算有效匯率的 exchangeRate() 是同一份定義的兩個方向。
 *
 * ── 一次一筆,不做批次 ──────────────────────────────────────────
 *
 * 對照 pot/moves.post.ts:投入公費**天生是集體行為**(「今天大家說好各拿
 * 5,000 出來」是一個決定),所以那支收 entries[] 一次寫完。
 * 換匯相反 —— 每個人自己去銀行、自己的匯率、自己的日期,
 * 沒有任何一次換匯是「大家一起」發生的。硬做成批次只會多一層
 * 誰都用不到的巢狀結構。
 */
type Body = {
  member_id: string;
  /** 換到的 */
  currency: string;
  amount_minor: number;
  /** 付出的。不給就用旅程的本位幣(在台灣換日幣,付出去的就是台幣) */
  cost_currency?: string;
  cost_minor: number;
  /** YYYY-MM-DD。不給就是今天 */
  exchanged_at?: string;
  note?: string;
};

export default defineEventHandler(async (event) => {
  const dbh = db(event);
  const trip = await requireTrip(event, dbh);
  const b = await readBody<Body>(event);

  if (!b?.member_id) throw createError({ statusCode: 400, statusMessage: '缺少 member_id(是誰換的)' });
  if (!b?.currency) throw createError({ statusCode: 400, statusMessage: '缺少 currency(換到什麼幣別)' });

  const amountMinor = requirePositiveMinor(b.amount_minor, 'amount_minor', '換到的金額');
  const costMinor = requirePositiveMinor(b.cost_minor, 'cost_minor', '付出的金額');
  const exchangedAt = normalizeExchangedAt(b.exchanged_at);

  // 在台灣換日幣,付出去的就是台幣 —— 也就是旅程的本位幣。
  // 讓它有預設值是因為前端 99% 的情況不需要選,而少一個選項就少一個填錯的機會。
  const costCurrency = b.cost_currency || trip.base_currency;

  // 同幣別「換匯」沒有意義(匯率恆為 1),而且它會讓錢包的兩邊互相抵銷:
  // 換入 +10,000、換出 −10,000,剩餘一動也不動,而清單上多一筆莫名的紀錄。
  // 資料庫的 CHECK 也擋,這裡擋是為了給出看得懂的訊息。
  if (b.currency === costCurrency) {
    throw createError({
      statusCode: 400,
      statusMessage: `換到的和付出的都是 ${b.currency} —— 同幣別之間沒有匯率可言。`
        + '要記「領現金」的話那不是換匯,直接記一筆支出比較準。',
    });
  }

  const [member, got, paid] = await Promise.all([
    // is_pot 一起撈回來:公費不能換匯,而那個判斷需要這個欄位
    dbh.prepare(`SELECT id, name, is_pot FROM members WHERE id = ? AND trip_id = ?`)
      .bind(b.member_id, trip.id).first<{ id: string; name: string; is_pot: number }>(),
    dbh.prepare(`SELECT code FROM currencies WHERE code = ?`).bind(b.currency).first<{ code: string }>(),
    dbh.prepare(`SELECT code FROM currencies WHERE code = ?`).bind(costCurrency).first<{ code: string }>(),
  ]);

  // trip_id 一起寫進 WHERE,所以「別趟的成員 id」和「不存在的 id」是同一個結果。
  // 分開回報等於告訴對方那個 id 存在(同 utils/trip.ts 的 notFound)。
  if (!member) {
    throw createError({ statusCode: 400, statusMessage: '換匯的成員不屬於這趟旅程' });
  }
  /*
    ── 公費不能換匯 ──────────────────────────────────────────────

    這張 issue 明確不碰公費的匯率:公費是一個信封,它的錢是**成員投入的**,
    不是它自己去銀行換的。允許公費有換匯紀錄的話,同一個實體上會同時掛著
    兩個定義不同的「剩餘」:
      公費剩餘(utils/pot.ts)   = 投入 − 付掉 − 退還
      錢包剩餘(utils/wallet.ts) = 換入 − 離手 + 收到
    兩個數字在畫面上並排、名字都叫剩餘、而且永遠不一樣 —— 沒有人分得出
    該相信哪一個。所以擋在寫入的時候。
  */
  if (member.is_pot) {
    throw createError({
      statusCode: 400,
      statusMessage: `${member.name}是公費,公費不會自己去換錢 —— 它的錢是大家投入的。`
        + '請選實際去換匯的那個人;公費的剩餘在總覽的公費區塊看。',
    });
  }
  if (!got) throw createError({ statusCode: 400, statusMessage: `不支援的幣別 ${b.currency}` });
  if (!paid) throw createError({ statusCode: 400, statusMessage: `不支援的幣別 ${costCurrency}` });

  const id = uid();
  await dbh.prepare(
    `INSERT INTO fx_exchanges
       (id, trip_id, member_id, currency, amount_minor, cost_currency, cost_minor, exchanged_at, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(
    id, trip.id, member.id, b.currency, amountMinor,
    costCurrency, costMinor, exchangedAt, b.note?.trim() || null,
  ).run();

  setResponseStatus(event, 201);
  // 回整列而不是只回 id:前端記完一筆之後要馬上把它插進清單,
  // 少了任何一個欄位就得再打一次 GET(而那次往返在國外的行動網路上有感)。
  return {
    id,
    member_id: member.id,
    currency: b.currency,
    amount_minor: amountMinor,
    cost_currency: costCurrency,
    cost_minor: costMinor,
    exchanged_at: exchangedAt,
    note: b.note?.trim() || null,
  };
});
