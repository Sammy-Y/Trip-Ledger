/**
 * SQL 安全性回歸測試。
 *
 * 這支不測行為,而是掃描原始碼、把「危險的寫法」本身當成失敗條件。
 * 理由:SQL injection 是那種「review 看漏一次就成立」的漏洞,
 * 靠人眼守不住,要靠測試守。
 *
 * 規則:
 *   1. .prepare() 裡的 SQL 一律是完全靜態的字串 —— 零插值。
 *      (即使插進去的是常數字面量也不允許 —— 那個寫法會讓下一個人以為
 *       「這裡可以插東西」,而他插的可能是使用者輸入。)
 *   2. 不准用字串串接組 SQL。
 *   3. 有佔位符就必須有 .bind()。
 *   4. 不准出現動態的 ORDER BY / GROUP BY / LIMIT
 *      (這三個無法參數化,只能用白名單映射,所以直接禁止動態拼接)。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { group, check, summary } from './_harness.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = [...walk('server'), ...walk('shared')];
console.log(`掃描 ${files.length} 個檔案`);

const violations: string[] = [];
let prepareCount = 0;

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const lineOf = (i: number) => src.slice(0, i).split('\n').length;

  // 規則 1:prepare(`...`) 的模板字串裡不得有 ${}
  for (const m of src.matchAll(/prepare\(\s*`([\s\S]*?)`/g)) {
    prepareCount++;
    if (m[1].includes('${')) {
      const ivs = [...m[1].matchAll(/\$\{[^}]*\}/g)].map((x) => x[0]).join(', ');
      violations.push(`${f}:${lineOf(m.index!)} prepare() 的 SQL 含插值 → ${ivs}`);
    }
  }

  // 規則 2:字串串接組 SQL
  for (const m of src.matchAll(/prepare\(\s*['"][\s\S]*?['"]\s*\+/g)) {
    violations.push(`${f}:${lineOf(m.index!)} 用字串串接組 SQL`);
  }

  // 規則 3:有佔位符就必須被 bind。
  // 兩種合法形態:
  //   (a) 直接鏈式:dbh.prepare(`...`).bind(x)
  //   (b) 存成變數稍後 bind:const stmt = dbh.prepare(`...`); ... stmt.bind(x)
  //       (fx.ts 就是這種 —— 預備一次,在迴圈裡逐次 bind,是正確且更有效率的用法)
  for (const m of src.matchAll(/(?:(const|let|var)\s+(\w+)\s*=\s*)?[\w.]*prepare\(\s*`([\s\S]*?)`\s*,?\s*\)([\s\S]{0,30})/g)) {
    const varName = m[2], sql = m[3], tail = m[4];
    if (!/\?\d*/.test(sql)) continue;                 // 沒有佔位符,不用管
    if (tail.includes('.bind')) continue;               // 形態 (a)
    if (varName && new RegExp(`\\b${varName}\\.bind\\(`).test(src)) continue;  // 形態 (b)
    violations.push(`${f}:${lineOf(m.index!)} 有佔位符但從未 .bind()`);
  }

  // 規則 4:動態 ORDER BY / GROUP BY / LIMIT
  for (const m of src.matchAll(/(ORDER\s+BY|GROUP\s+BY|LIMIT)\s*\$\{/gi)) {
    violations.push(`${f}:${lineOf(m.index!)} 動態 ${m[1]}(無法參數化,必須改用白名單)`);
  }

  // 規則 5:不准用 D1 的 .exec()(它接受多段 SQL 且不支援參數綁定)
  for (const m of src.matchAll(/\.exec\(/g)) {
    violations.push(`${f}:${lineOf(m.index!)} 使用 .exec()(不支援參數綁定)`);
  }
}

group('[SQL 安全] 掃描原始碼');
check(`找到 ${prepareCount} 個 prepare() 呼叫`, prepareCount > 20, `只找到 ${prepareCount},掃描規則可能失效`);
check('沒有任何 SQL 字串插值 / 串接 / 動態子句', violations.length === 0);
for (const v of violations) console.log(`     ✗ ${v}`);

process.exit(summary() > 0 ? 1 : 0);
