import { toMinor, fromMinor, formatMinor, formatMoney, exchangeRate, exchangeCostMinor, formatRate, EXPONENT, CURRENCY_SYMBOL, CURRENCY_LABEL } from '../shared/money.ts';
import { group, check, eq, summary } from './_harness.ts';

group('[exponent] JPY 沒有輔幣，TWD 用分');
eq('JPY exponent = 0', EXPONENT.JPY, 0);
eq('TWD exponent = 2', EXPONENT.TWD, 2);

group('[toMinor] 人類單位 → 整數最小單位');
eq('13244 日圓 → 13244', toMinor(13244, 'JPY'), 13244);
eq('908.5 台幣 → 90850 分', toMinor(908.5, 'TWD'), 90850);
eq('908.567 台幣四捨五入 → 90857', toMinor(908.567, 'TWD'), 90857);
// 浮點陷阱：0.1+0.2 那一類。1.005 用二進位存其實略小於 1.005
eq('1.15 台幣 → 115（不是 114）', toMinor(1.15, 'TWD'), 115);
eq('未知幣別預設當 2 位小數', toMinor(1, 'XXX'), 100);
eq('0 → 0', toMinor(0, 'JPY'), 0);
eq('負數 -2062 台幣 → -206200', toMinor(-2062, 'TWD'), -206200);

group('[fromMinor] 反向轉換');
eq('13244 JPY minor → 13244', fromMinor(13244, 'JPY'), 13244);
eq('90850 TWD minor → 908.5', fromMinor(90850, 'TWD'), 908.5);

group('[round-trip] 來回轉換不可失真');
for (const [amt, cur] of [[13244, 'JPY'], [25000, 'JPY'], [908.5, 'TWD'], [2062, 'TWD'], [0.01, 'TWD']] as const) {
  eq(`${amt} ${cur} 來回一致`, fromMinor(toMinor(amt, cur), cur), amt);
}

group('[formatMinor] 千分位與小數位');
eq('JPY 不顯示小數', formatMinor(13244, 'JPY'), '13,244');
eq('TWD 固定兩位小數', formatMinor(90850, 'TWD'), '908.50');
eq('大數字千分位', formatMinor(194765, 'JPY'), '194,765');
eq('負數保留負號', formatMinor(-206200, 'TWD'), '-2,062.00');

group('[formatMoney] 帶幣別符號');
eq('JPY 用 JP¥（和 CN¥ 區分）', formatMoney(13244, 'JPY'), 'JP¥13,244');
eq('TWD 用 NT$', formatMoney(90850, 'TWD'), 'NT$908.50');

group('[真實資料] 使用者 Excel 的數字');
eq('3/8 吃飯 13,244 日圓', formatMoney(toMinor(13244, 'JPY'), 'JPY'), 'JP¥13,244');
eq('伊藤久右衛門 6,274 日圓', formatMoney(toMinor(6274, 'JPY'), 'JPY'), 'JP¥6,274');
eq('藥妝代購扣繳 -2,062 台幣', formatMoney(toMinor(-2062, 'TWD'), 'TWD'), 'NT$-2,062.00');
// 4415 JPY × 0.202623 × 1.015 ≈ 908.00 台幣
check('日幣換台幣的量級合理',
  Math.abs(fromMinor(90800, 'TWD') - 4415 * 0.202623 * 1.015) < 0.5,
  `${fromMinor(90800, 'TWD')} vs ${(4415 * 0.202623 * 1.015).toFixed(2)}`);

group('[幣別符號] 不可有兩個幣別共用同一符號');
{
  const seen = new Map<string, string>();
  let dup = '';
  for (const [code, sym] of Object.entries(CURRENCY_SYMBOL)) {
    if (seen.has(sym)) dup = `${seen.get(sym)} 與 ${code} 都用 ${sym}`;
    seen.set(sym, code);
  }
  check('每個幣別的符號都是唯一的', !dup, dup);
  check('每個支援的幣別都有中文名稱',
    Object.keys(CURRENCY_SYMBOL).every((c) => !!CURRENCY_LABEL[c]),
    Object.keys(CURRENCY_SYMBOL).filter((c) => !CURRENCY_LABEL[c]).join(','));
}

group('[換匯] 有效匯率 = 付出的 ÷ 換到的');
// 使用者實際的兩筆:出發前在台灣分次換好
const FIRST = { amount: 5000, cost: 105000 };    // 0.21  換 ¥5,000  → NT$1,050
const SECOND = { amount: 10000, cost: 205000 };  // 0.205 換 ¥10,000 → NT$2,050
eq('第 1 次 NT$1,050 換 ¥5,000 → 0.21',
  exchangeRate(FIRST.amount, 'JPY', FIRST.cost, 'TWD'), 0.21);
eq('第 2 次 NT$2,050 換 ¥10,000 → 0.205',
  exchangeRate(SECOND.amount, 'JPY', SECOND.cost, 'TWD'), 0.205);
eq('換到 0 沒有匯率可言（回 null，不是 Infinity）',
  exchangeRate(0, 'JPY', 105000, 'TWD'), null);

group('[換匯] 加權平均 = Σ付出 ÷ Σ換到');
{
  const totalAmount = FIRST.amount + SECOND.amount;   // 15,000
  const totalCost = FIRST.cost + SECOND.cost;         // NT$3,100
  const avg = exchangeRate(totalAmount, 'JPY', totalCost, 'TWD')!;
  eq('¥15,000 / NT$3,100 → 平均顯示 0.2067', formatRate(avg), '0.2067');

  // 反向:換入與換出的順序顛倒，總和不變 → 平均一定一樣。
  // 這條之所以是**結構性**成立的，就是因為資料庫存的是金額不是匯率
  // （存匯率就得把每筆的 rate 再平均，那個才會被順序和筆數影響）。
  const reversed = exchangeRate(
    SECOND.amount + FIRST.amount, 'JPY', SECOND.cost + FIRST.cost, 'TWD')!;
  eq('加權平均與紀錄順序無關', reversed, avg);

  // 這是「存 rate 就會算錯」的那個數字。差 0.4%，¥15,000 上是 12 塊台幣，
  // 金額差距越大差越多 —— 所以 schema 存兩邊的金額而不是匯率。
  const naive = (0.21 + 0.205) / 2;
  eq('把每筆的匯率再平均會得到 0.2075（錯的）', formatRate(naive), '0.2075');
  check('兩者確實不同（否則這條測試在守一個不存在的差別）', naive !== avg,
    `naive=${naive} weighted=${avg}`);
}

group('[換匯] 填匯率 → 自動算出台幣');
// 使用者講的是「我換 0.21」而不是「我付了 1,050」，表單要能雙向換算
eq('0.21 換 ¥5,000 → 付 NT$1,050', exchangeCostMinor(5000, 'JPY', 0.21, 'TWD'), 105000);
eq('0.205 換 ¥10,000 → 付 NT$2,050', exchangeCostMinor(10000, 'JPY', 0.205, 'TWD'), 205000);
for (const [amount, rate] of [[5000, 0.21], [10000, 0.205], [30000, 0.2067], [1, 0.21]] as const) {
  const cost = exchangeCostMinor(amount, 'JPY', rate, 'TWD');
  const back = exchangeRate(amount, 'JPY', cost, 'TWD')!;
  // 四捨五入到「分」之後反推，誤差不可超過半分除以金額
  check(`¥${amount} @ ${rate} 來回誤差在四捨五入之內`,
    Math.abs(back - rate) <= 0.005 / amount + 1e-12,
    `back=${back} rate=${rate} cost=${cost}`);
}
eq('匯率是 NaN 時回 0，不寫出 NaN', exchangeCostMinor(5000, 'JPY', Number.NaN, 'TWD'), 0);

group('[換匯] formatRate 用有效位數，不用固定小數位');
eq('0.21 不補零成 0.2100', formatRate(0.21), '0.21');
eq('0.20666… → 0.2067', formatRate(0.20666666666666667), '0.2067');
// 固定 4 位小數會把台幣→日幣印成 4.8123，韓元→台幣印成 0.0234（少一位有效數字）
eq('反方向 4.81234 → 4.812', formatRate(4.81234), '4.812');
eq('小數很多的幣別 0.023414 → 0.02341', formatRate(0.023414), '0.02341');
eq('null 顯示破折號而不是 NaN', formatRate(null), '—');

process.exit(summary() > 0 ? 1 : 0);
