-- 多使用者存取控制。issue #3
--
-- 在這之前完全沒有權限層:GET /api/trips 列出所有人的旅程(還附 share_token),
-- 而 requireTrip 只要 id 或 token 對得上就放行。要開放給不認識的使用者,
-- 這兩件事都必須擋掉。
--
-- 採用「混合式」:建立者有帳號,旅伴憑分享連結免註冊就能記帳。
-- 理由是旅遊分帳的天然形狀 —— 一個人開團、其他人被拉進來。
-- 強迫五個旅伴都註冊會直接殺死使用率。
--
-- 三張表的分工:
--   users         帳號本身
--   sessions      一個瀏覽器一筆。user_id 為 NULL 代表「訪客」——
--                 登入與未登入共用同一套 cookie 機制,requireTrip 只有一條路徑要走。
--   session_trips 訪客憑 share_token 解鎖過的旅程(登入者不用這張,走 trip_access)
--   trip_access   帳號對旅程的正式權限
--
--   pnpm db:migrate          （本機）
--   pnpm db:migrate:remote   （線上）

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  -- 一律存小寫。比對前在 server 端 toLowerCase,不依賴 SQLite 的 COLLATE。
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  -- PBKDF2-SHA256。Workers 沒有原生 bcrypt/argon2,WebCrypto 的 PBKDF2 是
  -- 唯一不用背 WASM 就能用的選項。三個參數都存下來,之後要調高迭代次數時
  -- 舊密碼還驗得過(登入成功時再用新參數重算)。
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  password_iter  INTEGER NOT NULL,
  -- 暴力破解防護。連續失敗累加,成功歸零;超過門檻就鎖到 locked_until。
  failed_count   INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  -- cookie 裡的是原始 token,這裡存的是它的 SHA-256。
  -- 資料庫被看光也無法冒用 session(和密碼一樣的道理)。
  id           TEXT PRIMARY KEY,
  -- NULL = 訪客 session(只靠 share_token 進來,沒有帳號)
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS session_trips (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, trip_id)
);

-- 為什麼是獨立一張表而不是 trips.owner_id:
-- 「把旅程轉移給別人」「一趟多個 owner」都不用再改 schema。
CREATE TABLE IF NOT EXISTS trip_access (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','editor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (trip_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_access_user ON trip_access(user_id);

-- 既有旅程刻意不塞 trip_access —— 它們是「無主旅程」,
-- 仍可用 share_token 進入,等註冊後在 UI 上認領。
