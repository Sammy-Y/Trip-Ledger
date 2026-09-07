/**
 * 金額的基本運算改由 shared/money.ts 提供（前後端共用同一份，
 * 避免兩邊的 EXPONENT 各自漂移）。這裡只留 server 專用的換算邏輯。
 */
export { EXPONENT, toMinor, fromMinor, formatMinor, formatMoney } from '../../shared/money.ts';
import { EXPONENT } from '../../shared/money.ts';

/**
 * 把某幣別的金額換算成本位幣。
 *
 * 誠實聲明:這是「估算值」,不是你信用卡帳單上的數字。誤差有三層:
 *   1. 中價 vs 你實際換現金/刷卡的成本價,有價差
 *   2. 海外刷卡手續費(VISA/MC/JCB 約 1% + 銀行最高 0.5%;AmEx 2%)
 *   3. 刷卡是以「店家請款日」的匯率計價,請款日在消費後數日到數週
 * 所以 UI 上必須標示「估算值,實際以銀行請款為準」。
 */
export function convertToBase(args: {
  amountMinor: number;
  currency: string;
  baseCurrency: string;
  fxRate: number | null;          // 1 unit currency = fxRate units base(中價)
  fxRateOverride?: number | null;  // 使用者手填(例如照帳單回填),優先採用
  markupPct?: number;              // 加成:現金價差或刷卡手續費
}): number | null {
  const { amountMinor, currency, baseCurrency, fxRate, fxRateOverride, markupPct = 0 } = args;
  if (currency === baseCurrency) return amountMinor;

  const rate = fxRateOverride ?? fxRate;
  if (rate == null) return null;   // 沒有匯率就回 null,不要猜

  const eFrom = EXPONENT[currency] ?? 2;
  const eTo = EXPONENT[baseCurrency] ?? 2;
  const major = amountMinor / 10 ** eFrom;
  const effective = rate * (1 + markupPct / 100);
  return Math.round(major * effective * 10 ** eTo);
}
