import { splitEqually, splitByShares, netBalances, minCashFlow } from '../server/utils/settle.ts';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

console.log('\n[splitEqually] 餘數必須完全分配,不能憑空生出或蒸發');
{
  // 3 人分 10000 日圓:3334 + 3333 + 3333 = 10000
  const s = splitEqually(10000, ['b', 'a', 'c']);
  check('sum == amount', sum(s) === 10000, `got ${sum(s)}`);
  check('每人差距 <= 1', Math.max(...s.values()) - Math.min(...s.values()) <= 1);
  const s2 = splitEqually(100, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  check('7 人分 100 也守恆', sum(s2) === 100, `got ${sum(s2)}`);
  const s3 = splitEqually(13244, ['民', '喧', '公']);
  check('你 Excel 的 3/8 吃飯 13244 三人分', sum(s3) === 13244, `got ${sum(s3)}`);
}

console.log('\n[splitByShares] 非均分 / 部分成員參與');
{
  // 伊藤久右衛門 6274,實際是 民 3857 / 喧 2417 —— 用指定金額比例還原
  const s = splitByShares(6274, { min: 3857, hsuan: 2417 });
  check('sum == amount', sum(s) === 6274, `got ${sum(s)}`);
  check('民 = 3857', s.get('min') === 3857, `got ${s.get('min')}`);
  const p = splitByShares(1000, { a: 50, b: 25, c: 25 });
  check('百分比 50/25/25 守恆', sum(p) === 1000, `got ${sum(p)}`);
  const odd = splitByShares(1000, { a: 1, b: 1, c: 1 });
  check('1:1:1 分 1000 守恆', sum(odd) === 1000, `got ${sum(odd)}`);
}

console.log('\n[netBalances + minCashFlow] 核心:誰欠誰多少');
{
  // 場景:3 人,A 墊了 30000,B 墊了 0,C 墊了 0,全員均分
  const shares = splitEqually(30000, ['A', 'B', 'C']);
  const nets = netBalances({
    paid: [{ memberId: 'A', amountMinor: 30000 }],
    owed: [...shares].map(([memberId, amountMinor]) => ({ memberId, amountMinor })),
    settled: [],
  });
  check('淨額總和為 0', nets.reduce((s, n) => s + n.netMinor, 0) === 0);
  const t = minCashFlow(nets);
  check('2 筆轉帳即可解決', t.length === 2, `got ${t.length}`);
  check('全部流向 A', t.every((x) => x.to === 'A'));
  check('轉帳總額 = 20000', t.reduce((s, x) => s + x.amountMinor, 0) === 20000);
}

console.log('\n[minCashFlow] 環狀債務應被壓縮');
{
  // A 欠 B 1000, B 欠 C 1000, C 欠 A 1000 → 淨額全為 0,應該 0 筆轉帳
  const nets = netBalances({
    paid: [{ memberId: 'A', amountMinor: 1000 }, { memberId: 'B', amountMinor: 1000 }, { memberId: 'C', amountMinor: 1000 }],
    owed: [{ memberId: 'A', amountMinor: 1000 }, { memberId: 'B', amountMinor: 1000 }, { memberId: 'C', amountMinor: 1000 }],
    settled: [],
  });
  check('環狀債務淨額歸零 → 0 筆轉帳', minCashFlow(nets).length === 0, `got ${minCashFlow(nets).length}`);
}

console.log('\n[minCashFlow] 較複雜的多人情境');
{
  const nets = [
    { memberId: 'A', netMinor: 5000 },
    { memberId: 'B', netMinor: -2000 },
    { memberId: 'C', netMinor: -3000 },
    { memberId: 'D', netMinor: 4000 },
    { memberId: 'E', netMinor: -4000 },
  ];
  const t = minCashFlow(nets);
  const moved = t.reduce((s, x) => s + x.amountMinor, 0);
  check('轉帳總額 = 債務總額 9000', moved === 9000, `got ${moved}`);
  check('筆數 <= n-1', t.length <= nets.length - 1, `got ${t.length}`);
  // 驗證套用轉帳後每人歸零
  const after = new Map(nets.map((n) => [n.memberId, n.netMinor]));
  for (const x of t) {
    after.set(x.from, after.get(x.from)! + x.amountMinor);
    after.set(x.to, after.get(x.to)! - x.amountMinor);
  }
  check('套用後全部歸零', [...after.values()].every((v) => v === 0), JSON.stringify([...after]));
}

console.log('\n[settled] 已還款要被扣掉');
{
  const nets = netBalances({
    paid: [{ memberId: 'A', amountMinor: 30000 }],
    owed: [{ memberId: 'A', amountMinor: 10000 }, { memberId: 'B', amountMinor: 10000 }, { memberId: 'C', amountMinor: 10000 }],
    settled: [{ from: 'B', to: 'A', amountMinor: 10000 }],
  });
  const t = minCashFlow(nets);
  check('B 已還款後只剩 C 要還', t.length === 1 && t[0].from === 'C' && t[0].to === 'A',
        JSON.stringify(t));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
