/**
 * Cron 設定同步測試。
 *
 * 背景:Nitro 宣稱會依 nuxt.config.ts 的 scheduledTasks 自動生成 wrangler 的
 * Cron Triggers,但實測不會(build 後 .output 裡沒有任何 crons 設定)。
 * 所以 wrangler.jsonc 必須手動維護一份,而兩邊一旦不同步:
 *   - wrangler 有、nuxt 沒有 → Cloudflare 會觸發,但 Nitro 找不到對應 task
 *   - nuxt 有、wrangler 沒有 → task 永遠不會被觸發,而且**完全沒有錯誤訊息**
 * 後者特別危險,所以用測試釘住。
 */
import { readFileSync } from 'node:fs';
import { group, check, eq, summary } from './_harness.ts';

const nuxtCfg = readFileSync('nuxt.config.ts', 'utf8');
const wranglerRaw = readFileSync('wrangler.jsonc', 'utf8');
// 去掉 // 註解才能當 JSON 解析(jsonc)
const wrangler = JSON.parse(wranglerRaw.replace(/^\s*\/\/.*$/gm, ''));

function cronsFromNuxt(): string[] {
  const m = nuxtCfg.match(/scheduledTasks\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([^'"]*[*\d][^'"]*)['"]\s*:/g)].map((x) => x[1]);
}

const fromNuxt = cronsFromNuxt().sort();
const fromWrangler = [...(wrangler.triggers?.crons ?? [])].sort();

group('[Cron] nuxt.config.ts 與 wrangler.jsonc 必須一致');
check('nuxt.config.ts 有解析到 scheduledTasks', fromNuxt.length > 0, JSON.stringify(fromNuxt));
check('wrangler.jsonc 有宣告 triggers.crons', fromWrangler.length > 0,
  'Nitro 不會自動生成,少了這段排程永遠不會跑且沒有錯誤訊息');
eq('兩邊的 cron 表達式完全相同', fromNuxt, fromWrangler);

group('[Cron] 表達式格式');
for (const c of fromWrangler) {
  check(`「${c}」是合法的 5 欄位 cron`, c.trim().split(/\s+/).length === 5, c);
}

group('[部署設定] wrangler.jsonc 的必要欄位');
check('有指向 build 產物 main', wrangler.main === '.output/server/index.mjs', wrangler.main);
check('有 assets 目錄', wrangler.assets?.directory === '.output/public', JSON.stringify(wrangler.assets));
check('有 D1 binding "DB"', wrangler.d1_databases?.[0]?.binding === 'DB');
// 這條會在部署前提醒:placeholder 還沒換成真的 database_id
const dbId = wrangler.d1_databases?.[0]?.database_id ?? '';
if (dbId.includes('local-dev') || dbId.includes('<')) {
  console.log(`  note database_id 仍是 placeholder(${dbId})— 部署前要換成 wrangler d1 create 回傳的真值`);
}

process.exit(summary() > 0 ? 1 : 0);
