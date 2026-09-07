/**
 * 匯率同步與查詢。
 *
 * 刻意寫成「把 db 當參數傳進來」的純函式,不從 event 或 async context 自己撈 binding。
 * 這樣 API route 和 scheduled task 都能呼叫,也能在 node 裡直接測。
 *
 * 為什麼不用台灣銀行牌告:
 *   台銀 CSV(rate.bot.com.tw/xrt/flcsv/0/day)有 JS bot challenge,實測從機房 IP
 *   只會拿到 "Challenge Validation" 頁,換 User-Agent 也無效 → Worker 一定被擋。
 *   (台銀是唯一有現金/即期買賣四價的權威來源,真要那個精度得靠家用網路的機器抓再回填。)
 *
 * open.er-api.com 給的是**中價**,不是你換現金或刷卡的成本價 —— 價差在 money.ts 用 markup 處理。
 */
export type FxConfig = { base: string; sourceUrl: string };

const WANTED = ['JPY', 'USD', 'KRW', 'EUR', 'HKD', 'CNY', 'THB', 'SGD'];

export async function syncRates(dbh: D1Database, cfg: FxConfig) {
  const url = `${cfg.sourceUrl}/${cfg.base}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` };

  const data = (await res.json()) as {
    result?: string;
    time_last_update_utc?: string;
    rates?: Record<string, number>;
  };
  if (data.result !== 'success' || !data.rates) return { ok: false as const, error: 'unexpected payload' };

  const rateDate = new Date(data.time_last_update_utc ?? Date.now()).toISOString().slice(0, 10);
  const stmt = dbh.prepare(
    `INSERT INTO fx_rates (rate_date, base, currency, rate, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(rate_date, base, currency) DO UPDATE SET
       rate = excluded.rate, source = excluded.source, fetched_at = datetime('now')`,
  );

  const batch = [];
  for (const code of WANTED) {
    // 回傳是「1 base = N foreign」,我們要存「1 foreign = ? base」,取倒數。
    const perBase = data.rates[code];
    if (!perBase || perBase <= 0) continue;
    batch.push(stmt.bind(rateDate, cfg.base, code, 1 / perBase, 'open.er-api.com'));
  }
  if (batch.length) await dbh.batch(batch);
  return { ok: true as const, date: rateDate, count: batch.length };
}

/**
 * 取某日匯率。優先往前找「消費當日或之前」最近的一筆。
 *
 * 若完全找不到(常見於補登或從 Excel 匯入舊行程 —— 免費 API 只給最新匯率,
 * 沒有歷史資料可回填),則退而使用**現有最早**的一筆,並把 source 標成
 * `fallback:earliest`。這樣做的理由:
 *   - 回傳 null 會讓 expenses.fx_rate 留空,之後任何統計都得再猜一次匯率
 *   - 標記來源讓它可稽核 —— UI 可以提示「此筆為近似匯率」並讓使用者用
 *     fx_rate_override 照信用卡帳單回填正確數字
 */
export async function rateOn(dbh: D1Database, base: string, currency: string, onDate: string) {
  if (currency === base) return { rate: 1, date: onDate, source: 'identity', approximate: false };

  const onOrBefore = await dbh.prepare(
    `SELECT rate, rate_date, source FROM fx_rates
     WHERE base = ? AND currency = ? AND rate_date <= ?
     ORDER BY rate_date DESC LIMIT 1`,
  ).bind(base, currency, onDate).first<{ rate: number; rate_date: string; source: string }>();
  if (onOrBefore) {
    return { rate: onOrBefore.rate, date: onOrBefore.rate_date, source: onOrBefore.source, approximate: false };
  }

  const earliest = await dbh.prepare(
    `SELECT rate, rate_date, source FROM fx_rates
     WHERE base = ? AND currency = ?
     ORDER BY rate_date ASC LIMIT 1`,
  ).bind(base, currency).first<{ rate: number; rate_date: string; source: string }>();
  if (!earliest) return null;

  return {
    rate: earliest.rate,
    date: earliest.rate_date,
    source: `${earliest.source} (fallback:earliest)`,
    approximate: true,
  };
}
