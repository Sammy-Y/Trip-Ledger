import { splitEqually, splitByShares, minCashFlow, netBalances } from '../server/utils/settle.ts';

// 固定種子的 PRNG,讓失敗案例可重現。
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const ri = (n: number) => Math.floor(rnd() * n);

let bad = 0;
for (let iter = 0; iter < 20000; iter++) {
  const n = 2 + ri(9);                       // 2..10 人
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  const amount = 1 + ri(500000);

  // 隨機挑一個分攤方式
  const shares = rnd() < 0.5
    ? splitEqually(amount, ids)
    : splitByShares(amount, Object.fromEntries(ids.map((id) => [id, 1 + ri(20)])));
  const sumShares = [...shares.values()].reduce((a, b) => a + b, 0);
  if (sumShares !== amount) { console.log(`SPLIT LEAK iter=${iter} ${sumShares} != ${amount}`); bad++; break; }

  // 隨機多位付款人,總額必須等於 amount
  const payers: Array<{ memberId: string; amountMinor: number }> = [];
  let left = amount;
  const np = 1 + ri(Math.min(3, n));
  for (let i = 0; i < np; i++) {
    const take = i === np - 1 ? left : ri(left + 1);
    payers.push({ memberId: ids[ri(n)], amountMinor: take });
    left -= take;
  }

  const nets = netBalances({
    paid: payers,
    owed: [...shares].map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
    settled: [],
  });

  const netSum = nets.reduce((s, x) => s + x.netMinor, 0);
  if (netSum !== 0) { console.log(`NET NOT ZERO iter=${iter} ${netSum}`); bad++; break; }

  const transfers = minCashFlow(nets);
  const after = new Map(nets.map((x) => [x.memberId, x.netMinor]));
  for (const t of transfers) {
    after.set(t.from, (after.get(t.from) ?? 0) + t.amountMinor);
    after.set(t.to, (after.get(t.to) ?? 0) - t.amountMinor);
  }
  if (![...after.values()].every((v) => v === 0)) {
    console.log(`NOT SETTLED iter=${iter}`, JSON.stringify(nets), JSON.stringify(transfers)); bad++; break;
  }
  if (transfers.some((t) => t.amountMinor <= 0)) { console.log(`NON-POSITIVE iter=${iter}`); bad++; break; }
  if (transfers.length > Math.max(0, nets.length - 1)) { console.log(`TOO MANY iter=${iter} ${transfers.length} > ${nets.length - 1}`); bad++; break; }
}
console.log(bad === 0 ? '20000 random cases: all settled to zero, no leaks, <= n-1 transfers' : 'FUZZ FAILED');
process.exit(bad === 0 ? 0 : 1);
