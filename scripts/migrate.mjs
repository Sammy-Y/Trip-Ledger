/**
 * 依序套用 migrations/*.sql。
 *
 * 為什麼需要這支而不是直接 `wrangler d1 execute --file`:
 *
 *  1. 有多個 migration 檔,要按檔名順序全部跑過。
 *  2. **重跑要是安全的。** SQLite 沒有 `ADD COLUMN IF NOT EXISTS`,
 *     已經套用過的 migration 會噴 "duplicate column name"。
 *     那不是錯誤,是「這一步早就做完了」—— 所以這裡把它視為成功,
 *     其他錯誤才真的中止。這讓 `pnpm db:migrate` 可以無腦重複執行。
 *
 * 用法:node scripts/migrate.mjs --local | --remote
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const target = process.argv.includes('--remote') ? '--remote' : '--local';
const dir = 'migrations';

/** 已經套用過的痕跡。看到這些就當成功。 */
const ALREADY_APPLIED = [
  'duplicate column name',
  'already exists',
];

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
if (!files.length) {
  console.log('沒有 migration 可以跑。');
  process.exit(0);
}

console.log(`套用 ${files.length} 個 migration 到 ${target.slice(2)} 資料庫\n`);

let failed = 0;

for (const file of files) {
  const res = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'trip-ledger', target, `--file=${join(dir, file)}`, '-y'],
    { encoding: 'utf8' },
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const skipped = ALREADY_APPLIED.some((needle) => output.toLowerCase().includes(needle));

  if (res.status === 0) {
    console.log(`  ✔ ${file}`);
  } else if (skipped) {
    console.log(`  · ${file}  (已經套用過,跳過)`);
  } else {
    failed++;
    console.log(`  ✘ ${file}`);
    console.log(output.split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

console.log(failed ? `\n${failed} 個 migration 失敗。` : '\n全部完成。');
process.exit(failed ? 1 : 0);
