/**
 * 量 PBKDF2 的 CPU 成本,決定 nuxt.config.ts 的 pbkdf2Iterations 要設多少。
 *
 * ⚠️ 這是在 Node 上量的(OpenSSL),線上是 workerd(BoringSSL),數字不會完全一樣,
 * 但同一個數量級。真正的驗證是部署後看 Cloudflare dashboard 的 CPU time。
 *
 * Workers 免費版每次呼叫 10ms CPU;付費版 30 秒。
 *
 * 用法:node scripts/bench-pbkdf2.mjs
 */
const enc = new TextEncoder();
const key = await crypto.subtle.importKey('raw', enc.encode('correct horse battery staple'), 'PBKDF2', false, ['deriveBits']);

async function timeIter(iterations) {
  // 先熱身,避免第一次呼叫的初始化成本被算進去
  await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('s'), iterations: 1000 }, key, 256);
  const runs = 5;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) {
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('salt'), iterations }, key, 256);
  }
  return (performance.now() - t0) / runs;
}

console.log('迭代次數      每次耗時     10ms 預算');
console.log('─'.repeat(44));
for (const n of [10_000, 25_000, 50_000, 100_000, 200_000, 600_000]) {
  const ms = await timeIter(n);
  const verdict = ms <= 10 ? '✔ 放得下' : `✘ 超標 ${(ms / 10).toFixed(1)}x`;
  console.log(`${String(n).padStart(9)}  ${ms.toFixed(2).padStart(8)} ms   ${verdict}`);
}
