/**
 * 結算引擎。
 *
 * 兩個刻意的設計決定:
 *
 * 1. 結算「分幣別各自進行」,絕不把日幣和台幣加在一起。
 *    你 Excel 的 SUM(C2:C74)=194,765 把兩種幣別直接相加,那個數字沒有意義。
 *    這裡的做法跟「旅收」一樣:該還日幣的和該還台幣的分開列,換算只作參考顯示。
 *
 * 2. 用貪婪法減少轉帳筆數,但**不宣稱是最少筆數**。
 *    「最小化轉帳次數」可歸約到 Subset Sum,屬 NP-Complete,沒有多項式時間最佳解;
 *    Splitwise 自己也是用啟發式。所以 UI 文案要寫「已簡化」而不是「最少」。
 *    這裡用的是標準 min-cash-flow greedy,O(n²),2–10 人規模在前端即時算完。
 */

// 拆分演算法住在 shared/,前端表單即時試算會用到同一份。
export { splitEqually, splitByShares } from '../../shared/split.ts';

export type Net = { memberId: string; netMinor: number };  // >0 應收, <0 應付
export type Transfer = { from: string; to: string; amountMinor: number };

/**
 * 由「誰付了」和「誰該分攤」推出每人淨額。
 * 這一步是結算的前提 —— 若共同支出沒記錄付款人,整個結算根本無法啟動,
 * 這正是你 Excel 卡住的地方(33 筆共同花費只有 2 筆填了付款人)。
 */
export function netBalances(input: {
  paid: Array<{ memberId: string; amountMinor: number }>;
  owed: Array<{ memberId: string; amountMinor: number }>;
  settled: Array<{ from: string; to: string; amountMinor: number }>;
}): Net[] {
  const net = new Map<string, number>();
  const bump = (id: string, v: number) => net.set(id, (net.get(id) ?? 0) + v);

  for (const p of input.paid) bump(p.memberId, p.amountMinor);
  for (const o of input.owed) bump(o.memberId, -o.amountMinor);
  // 已還的款:付款方減少債務(淨額上升),收款方相應下降。
  for (const s of input.settled) {
    bump(s.from, s.amountMinor);
    bump(s.to, -s.amountMinor);
  }

  return [...net.entries()]
    .map(([memberId, netMinor]) => ({ memberId, netMinor }))
    .filter((n) => n.netMinor !== 0)
    .sort((a, b) => a.memberId < b.memberId ? -1 : 1);
}

/** 標準 min-cash-flow greedy:反覆把最大債權人與最大債務人配對沖銷。 */
export function minCashFlow(nets: Net[]): Transfer[] {
  const pool = nets.map((n) => ({ ...n })).filter((n) => n.netMinor !== 0);
  const transfers: Transfer[] = [];

  // 每輪 amount = min(credit, -debt),所以至少有一人歸零並被移出 pool,
  // 因此 n 輪一定夠(最後一人的淨額必為 0,因為總和為 0)。
  // 上限必須用「初始人數」算,不能寫成 guard < pool.length —— pool 會邊縮邊比,
  // 會在還有債務未沖銷時就提前結束。
  const maxIterations = pool.length;
  for (let guard = 0; guard < maxIterations && pool.length > 1; guard++) {
    let maxCreditor = 0, maxDebtor = 0;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].netMinor > pool[maxCreditor].netMinor) maxCreditor = i;
      if (pool[i].netMinor < pool[maxDebtor].netMinor) maxDebtor = i;
    }
    const credit = pool[maxCreditor].netMinor;
    const debt = pool[maxDebtor].netMinor;
    if (credit <= 0 || debt >= 0) break;   // 已全部歸零

    const amount = Math.min(credit, -debt);
    transfers.push({
      from: pool[maxDebtor].memberId,
      to: pool[maxCreditor].memberId,
      amountMinor: amount,
    });
    pool[maxCreditor].netMinor -= amount;
    pool[maxDebtor].netMinor += amount;

    // 移除已歸零的人(從後往前刪,避免索引位移)。
    for (const i of [maxCreditor, maxDebtor].sort((a, b) => b - a)) {
      if (pool[i].netMinor === 0) pool.splice(i, 1);
    }
  }
  return transfers;
}

/** 每個成員在一趟旅程的個人視角:共同分攤 + 個人花費 = 我總共花了多少。 */
export type MemberSummary = {
  memberId: string;
  sharedOwedMinor: number;    // 共同花費裡我應分攤的
  personalMinor: number;      // 我自己的個人花費
  totalMinor: number;         // 兩者相加 —— 你 Excel 想要的那個數字
  paidMinor: number;          // 我實際墊出去的
  netMinor: number;           // >0 別人該還我, <0 我該還別人
};
