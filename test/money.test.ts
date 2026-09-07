import { toMinor, fromMinor, formatMinor, formatMoney, EXPONENT, CURRENCY_SYMBOL, CURRENCY_LABEL } from '../shared/money.ts';
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

process.exit(summary() > 0 ? 1 : 0);
