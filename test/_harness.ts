/** 極簡測試骨架。刻意不裝框架 —— node --experimental-strip-types 就能跑。 */
let pass = 0, fail = 0;
const failures: string[] = [];

export function group(name: string) { console.log(`\n${name}`); }

export function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
}

export function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, a === e ? '' : `got ${a} want ${e}`);
}

export function summary() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log('失敗項目:\n  - ' + failures.join('\n  - '));
  return fail;
}
