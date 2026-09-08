/**
 * 跑完所有單元測試,而且**不會因為第一支失敗就吞掉後面的**。
 *
 * 為什麼需要這支:原本 `pnpm test` 是用 `&&` 串起來的,
 * 所以任何一支失敗後面全部不會執行 —— 實際踩到過:schema-types 掛掉時,
 * cron-config / vue-compile / 20,000 筆 fuzz 三支根本沒跑,
 * 而畫面上看起來只是「14 passed, 1 failed」,很容易誤判成「只有一個小問題」。
 *
 * 這支全部跑完再一次回報,exit code 只要有任何一支失敗就是 1。
 */
import { spawnSync } from 'node:child_process';

const SUITES = [
  ['settle', 'test/settle.test.ts'],
  ['money', 'test/money.test.ts'],
  ['split-preview', 'test/split-preview.test.ts'],
  ['expense-form-reset', 'test/expense-form-reset.test.ts'],
  ['ledger', 'test/ledger.test.ts'],
  ['sql-safety', 'test/sql-safety.test.ts'],
  ['schema-types', 'test/schema-types.test.ts'],
  ['cron-config', 'test/cron-config.test.ts'],
  ['vue-compile', 'test/vue-compile.test.mjs'],
  ['settle-fuzz', 'test/settle.fuzz.ts'],
];

const results = [];

for (const [name, file] of SUITES) {
  const args = file.endsWith('.mjs') ? [file] : ['--experimental-strip-types', file];
  const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
  results.push({ name, ok: res.status === 0, status: res.status });
}

console.log(`\n${'═'.repeat(60)}`);
for (const r of results) {
  console.log(`  ${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : `  (exit ${r.status})`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length}/${results.length} 個測試檔失敗:${failed.map((f) => f.name).join('、')}`
  : `\n全部 ${results.length} 個測試檔通過。`);

process.exit(failed.length ? 1 : 0);
