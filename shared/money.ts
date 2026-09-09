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

/**
 * ── 換匯的算術 ───────────────────────────────────────────────
 *
 * 出發前在台灣分次換好日幣,是這趟旅程真正的成本來源。而 fx_exchanges
 * **存兩邊的金額,不存匯率**(理由見 schema.sql 那張表的說明):
 * 匯率是導出值,存金額才能保持整數精確、不累積誤差。
 *
 * 所以「匯率」在整個 codebase 只有這一個定義,前後端共用同一份 ——
 * 表單的雙向換算、清單的每筆有效匯率、錢包的加權平均,全部走這裡。
 * 各自寫一份除法的下場是「表單顯示 0.21、清單顯示 0.2100000001」。
 */

/**
 * 有效匯率 = 付出的 ÷ 換到的(兩邊都先換成人類單位)。
 *
 * 付 NT$1,050 換到 ¥5,000 → 1050 / 5000 = 0.21,也就是「1 日圓 = 0.21 台幣」,
 * 和 fx_rates.rate 的方向一致(1 unit of currency = rate units of base)。
 *
 * **加權平均就是把兩邊各自加總之後再除**:
 *   (1050 + 2050) / (5000 + 10000) = 3100 / 15000 = 0.206666…
 * 這也是「加權平均與紀錄順序無關」的原因 —— 它是兩個總和的比值,
 * 不是把每筆的匯率再平均一次(那樣才會被順序和筆數影響)。
 *
 * 換到 0 的話沒有匯率可言,回 null 而不是 Infinity ——
 * 資料庫的 CHECK 已經擋掉 0,但這裡不建立在那個假設上。
 */
export function exchangeRate(
  amountMinor: number,
  currency: string,
  costMinor: number,
  costCurrency: string,
): number | null {
  const got = fromMinor(amountMinor, currency);
  if (!got || !Number.isFinite(got)) return null;
  const paid = fromMinor(costMinor, costCurrency);
  if (!Number.isFinite(paid)) return null;
  return paid / got;
}

/**
 * 反過來:知道匯率和要換到多少,算出要付多少(最小單位整數)。
 *
 * 使用者講的是「我換 0.21」而不是「我付了 1,050」,所以表單要能填匯率
 * 自動算出台幣。四捨五入到最小單位在這裡發生一次 ——
 * 送出去的一定是那個整數,畫面上顯示的也是那個整數,不會出現
 * 「畫面 1,050、存進去 1,049.997」這種對不起來的狀況。
 */
export function exchangeCostMinor(
  amountMinor: number,
  currency: string,
  rate: number,
  costCurrency: string,
): number {
  if (!Number.isFinite(rate)) return 0;
  return toMinor(fromMinor(amountMinor, currency) * rate, costCurrency);
}

/**
 * 匯率的顯示字串。
 *
 * 用**有效位數**而不是固定小數位:同一個 formatter 要同時應付
 * 0.2067(日幣→台幣)、4.8123(台幣→日幣)和 0.02341(韓元→台幣),
 * 固定 4 位小數會把最後那個印成 0.0234(少一位有效數字)。
 *
 * 0.21 印成 '0.21' 而不是 '0.2100' —— 使用者輸入的就是 0.21,
 * 補零會讓人以為系統改過他填的數字。
 */
export function formatRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return rate.toLocaleString('zh-TW', { maximumSignificantDigits: 4 });
}
