/**
 * 編譯所有 .vue 檔。
 *
 * 為什麼需要:重複宣告、模板語法錯誤這類問題,`node --check` 看不到
 * (它只檢查 .ts),API 測試也全會通過 —— 但畫面根本打不開。
 * 這正是實際發生過的事:SplitEditor.vue 有兩份 readNumber,
 * 56 個 API 測試全綠,點進表單頁卻是一片紅。
 */
import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.vue')) out.push(p);
  }
  return out;
}

const files = walk('app');
let bad = 0;
console.log(`\n[Vue 編譯] ${files.length} 個 SFC`);
for (const f of files) {
  try {
    const { descriptor, errors } = parse(readFileSync(f, 'utf8'), { filename: f });
    if (errors.length) throw new Error(errors[0].message);
    if (descriptor.script || descriptor.scriptSetup) compileScript(descriptor, { id: f });
    console.log(`  ok   ${f}`);
  } catch (e) {
    console.log(`  FAIL ${f}\n       ${String(e.message).split('\n')[0]}`);
    bad++;
  }
}
console.log(`\n${files.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
