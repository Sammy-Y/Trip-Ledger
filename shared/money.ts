/** 幣別小數位。JPY 無輔幣，TWD 用分。前後端共用這一份，不要各自複製。 */
export const EXPONENT: Record<string, number> = { TWD: 2, JPY: 0 };
export const CURRENCY_LABEL: Record<string, string> = {
  TWD: '台幣', JPY: '日幣', USD: '美金', KRW: '韓元',
  EUR: '歐元', HKD: '港幣', CNY: '人民幣', THB: '泰銖', SGD: '新加坡幣',
};

/**
 * 幣別符號一律帶國別前綴,理由有兩個:
 *
 * 1. **消除歧義**:$ 被台幣/美金/港幣/新加坡幣共用,¥ 被日圓和人民幣共用。
 *    旅程裡同時出現兩種以上時,只看符號會分不出來。
 * 2. **視覺一致**:清單裡「NT$22,596」和「¥18,109」並排時,
 *    一個有前綴一個沒有,看起來像兩套規則。
 *
 * € ฿ ₩ 是各自獨有的符號,但為了上面第 2 點仍然加前綴 ——
 * 只有歐元例外,因為它不屬於單一國家,硬加 EU 反而不對。
 */
export const CURRENCY_SYMBOL: Record<string, string> = {
  TWD: 'NT$', JPY: 'JP¥', USD: 'US$', KRW: 'KR₩',
  EUR: '€', HKD: 'HK$', CNY: 'CN¥', THB: 'TH฿', SGD: 'SG$',
};

export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** (EXPONENT[currency] ?? 2));
}
export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** (EXPONENT[currency] ?? 2);
}
/** 3,857 / 1,234.56 這種帶千分位的顯示字串 */
export function formatMinor(minor: number, currency: string): string {
  const e = EXPONENT[currency] ?? 2;
  return fromMinor(minor, currency).toLocaleString('zh-TW', {
    minimumFractionDigits: e, maximumFractionDigits: e,
  });
}
/** ¥3,857 */
export function formatMoney(minor: number, currency: string): string {
  return `${CURRENCY_SYMBOL[currency] ?? ''}${formatMinor(minor, currency)}`;
}
