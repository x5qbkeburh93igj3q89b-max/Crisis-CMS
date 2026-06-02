// db.js — SQLite データ層（Node組み込み node:sqlite。ネイティブビルド不要 / 要 Node 22.5+）
// マルチテナント構成:
//   master ユーザー（site_id=null）= 運営者。全サイトとアカウントを管理。
//   サイトごとに owner/editor/viewer のエンドユーザーが紐づく（users.site_id）。
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const DB_PATH = process.env.DB_PATH || "mycms.db";
const db = new DatabaseSync(DB_PATH);
try { db.exec("PRAGMA journal_mode = WAL;"); } catch { /* 非対応FSではデフォルトjournalで継続 */ }
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  settings TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  passhash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',   -- 'master' | 'owner' | 'editor' | 'viewer'
  site_id INTEGER,                       -- master は NULL
  created_at INTEGER NOT NULL,
  FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  blocks TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  blocks TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER,
  filename TEXT, prompt TEXT, data TEXT,
  created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS form_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  page_id INTEGER,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  page_key TEXT NOT NULL,
  ref TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_views ON page_views(site_id, ts);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  cover TEXT,
  excerpt TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  page_key TEXT,
  visitor TEXT,
  type TEXT NOT NULL,   -- 'engage'(num=秒) | 'scroll'(num=%) | 'conversion'(num=1, label)
  num REAL DEFAULT 0,
  label TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events ON events(site_id, type, ts);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- 'growth' | 'a11y'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done' | 'dismissed'
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ts INTEGER NOT NULL
);
`);
try { db.exec("ALTER TABLE page_views ADD COLUMN device TEXT"); } catch {}
try { db.exec("ALTER TABLE page_views ADD COLUMN variant TEXT"); } catch {}
try { db.exec("ALTER TABLE posts ADD COLUMN scheduled_at INTEGER"); } catch {}
try { db.exec("ALTER TABLE form_submissions ADD COLUMN status TEXT NOT NULL DEFAULT '未対応'"); } catch {}
// マイグレーション（既存DBに列を追加。すでにあればエラーを無視）
try { db.exec("ALTER TABLE pages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'"); } catch { /* 既存 */ }
try { db.exec("ALTER TABLE page_views ADD COLUMN visitor TEXT"); } catch {}
try { db.exec("ALTER TABLE page_views ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE pages ADD COLUMN slug TEXT"); } catch {}
try { db.exec("ALTER TABLE pages ADD COLUMN parent_id INTEGER"); } catch {}
// 既存ページで slug が未設定のものに自動生成
try {
  const noSlug = db.prepare("SELECT id, name FROM pages WHERE slug IS NULL OR slug=''").all();
  const used = new Set();
  noSlug.forEach(p => {
    let base = String(p.name || "page").toLowerCase().replace(/[^\w぀-ゟ゠-ヿ一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "page";
    let s = base, n = 2;
    while (used.has(s)) s = base + "-" + n++;
    used.add(s);
    db.prepare("UPDATE pages SET slug=? WHERE id=?").run(s, p.id);
  });
} catch {}

const now = () => Date.now();
const num = (v) => (typeof v === "bigint" ? Number(v) : v);
const defaultSettings = () => JSON.stringify({
  siteTitle: "新しいサイト", maxWidth: 960, font: "system-ui, sans-serif",
  accent: "#5b8cff", pageBg: "#ffffff", textColor: "#111111", fullWidth: false,
});

/* ============ ユーザー ============ */
export function createUser({ email, name, password, role = "owner", siteId = null }) {
  const passhash = bcrypt.hashSync(password, 10);
  const info = db.prepare("INSERT INTO users (email,name,passhash,role,site_id,created_at) VALUES (?,?,?,?,?,?)")
    .run(email.toLowerCase(), name, passhash, role, siteId, now());
  return getUser(num(info.lastInsertRowid));
}
export const getUser = (id) => db.prepare("SELECT * FROM users WHERE id=?").get(id);
export const getUserByEmail = (email) => db.prepare("SELECT * FROM users WHERE email=?").get(String(email).toLowerCase());
export const listUsersBySite = (siteId) =>
  db.prepare("SELECT id,email,name,role,site_id,created_at FROM users WHERE site_id=? ORDER BY id").all(siteId);
export const countMasters = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='master'").get().c;
export function verifyPassword(user, password) { return user && bcrypt.compareSync(password, user.passhash); }
export function setPassword(id, password) { db.prepare("UPDATE users SET passhash=? WHERE id=?").run(bcrypt.hashSync(password, 10), id); }
export function setUserName(id, name) { db.prepare("UPDATE users SET name=? WHERE id=?").run(name, id); }
export function setUserRole(id, role) { db.prepare("UPDATE users SET role=? WHERE id=?").run(role, id); }
export function deleteUser(id) { db.prepare("DELETE FROM users WHERE id=?").run(id); }

/* ============ セッション ============ */
export function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)").run(token, userId, now());
  return token;
}
export function getSessionUser(token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(token);
  return s ? getUser(s.user_id) : null;
}
export function destroySession(token) { db.prepare("DELETE FROM sessions WHERE token=?").run(token); }

/* ============ サイト（テナント） ============ */
export function createSite({ title, slug }) {
  const info = db.prepare("INSERT INTO sites (title,slug,settings,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(title, slug, defaultSettingsWithTitle(title), now(), now());
  const id = num(info.lastInsertRowid);
  // 初期ページ
  db.prepare("INSERT INTO pages (site_id,name,position,blocks,updated_at) VALUES (?,?,?,?,?)")
    .run(id, "ホーム", 0, "[]", now());
  return getSite(id);
}
function defaultSettingsWithTitle(title) {
  const s = JSON.parse(defaultSettings()); s.siteTitle = title; return JSON.stringify(s);
}
export const slugExists = (slug) => !!db.prepare("SELECT 1 FROM sites WHERE slug=?").get(slug);
export function getSite(id) {
  const s = db.prepare("SELECT * FROM sites WHERE id=?").get(id);
  return s ? { ...s, settings: JSON.parse(s.settings) } : null;
}
export function getSiteBySlug(slug) {
  const s = db.prepare("SELECT * FROM sites WHERE slug=?").get(slug);
  return s ? { ...s, settings: JSON.parse(s.settings) } : null;
}
export function listSites() {
  return db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM pages p WHERE p.site_id=s.id) AS page_count,
      (SELECT COUNT(*) FROM users u WHERE u.site_id=s.id) AS user_count
    FROM sites s ORDER BY s.id`).all()
    .map(s => ({ ...s, settings: JSON.parse(s.settings) }));
}
export function updateSiteSettings(id, settings) {
  db.prepare("UPDATE sites SET settings=?, title=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(settings), settings.siteTitle || "サイト", now(), id);
}
export function setPublished(id, published) { db.prepare("UPDATE sites SET published=?, updated_at=? WHERE id=?").run(published ? 1 : 0, now(), id); }
export function deleteSite(id) { db.prepare("DELETE FROM sites WHERE id=?").run(id); }

/* ============ ページ ============ */
const parsePage = (p) => p ? { ...p, blocks: JSON.parse(p.blocks), meta: JSON.parse(p.meta || "{}") } : null;
export function listPages(siteId) {
  return db.prepare("SELECT * FROM pages WHERE site_id=? ORDER BY position,id").all(siteId).map(parsePage);
}
export const getPage = (id) => parsePage(db.prepare("SELECT * FROM pages WHERE id=?").get(id));
export const getPageBySlug = (siteId, slug) => parsePage(db.prepare("SELECT * FROM pages WHERE site_id=? AND slug=?").get(siteId, slug));
export function savePageMeta(id, meta) { db.prepare("UPDATE pages SET meta=? WHERE id=?").run(JSON.stringify(meta || {}), id); }
function uniquePageSlug(siteId, base, excludeId = null) {
  let s = base, n = 2;
  while (true) {
    const row = db.prepare("SELECT id FROM pages WHERE site_id=? AND slug=?").get(siteId, s);
    if (!row || row.id === excludeId) return s;
    s = base + "-" + n++;
  }
}
export function createPage(siteId, name, parentId = null) {
  const pos = (db.prepare("SELECT MAX(position) m FROM pages WHERE site_id=?").get(siteId).m ?? -1) + 1;
  const base = String(name || "page").toLowerCase().replace(/[^\w぀-ゟ゠-ヿ一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "page";
  const slug = uniquePageSlug(siteId, base);
  const info = db.prepare("INSERT INTO pages (site_id,name,slug,parent_id,position,blocks,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(siteId, name, slug, parentId || null, pos, "[]", now());
  return getPage(num(info.lastInsertRowid));
}
export function renamePage(id, name) {
  const pg = getPage(id);
  if (!pg) return;
  const base = String(name || "page").toLowerCase().replace(/[^\w぀-ゟ゠-ヿ一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "page";
  const slug = uniquePageSlug(pg.site_id, base, id);
  db.prepare("UPDATE pages SET name=?,slug=? WHERE id=?").run(name, slug, id);
}
export function setPageSlug(id, slug) {
  const pg = getPage(id);
  if (!pg) return;
  const safe = uniquePageSlug(pg.site_id, slug, id);
  db.prepare("UPDATE pages SET slug=? WHERE id=?").run(safe, id);
  return safe;
}
export function setPageParent(id, parentId) { db.prepare("UPDATE pages SET parent_id=? WHERE id=?").run(parentId || null, id); }
export function deletePage(id) { db.prepare("DELETE FROM pages WHERE id=?").run(id); }
export function savePageBlocks(id, blocks, author) {
  const json = JSON.stringify(blocks);
  db.prepare("UPDATE pages SET blocks=?, updated_at=?, updated_by=? WHERE id=?").run(json, now(), author || null, id);
  db.prepare("INSERT INTO revisions (page_id,blocks,author,created_at) VALUES (?,?,?,?)").run(id, json, author || null, now());
  db.prepare(`DELETE FROM revisions WHERE page_id=? AND id NOT IN
    (SELECT id FROM revisions WHERE page_id=? ORDER BY id DESC LIMIT 20)`).run(id, id);
}

/* ============ アセット（メディア） ============ */
export function saveAsset({ siteId, filename, prompt, data, createdBy }) {
  const info = db.prepare("INSERT INTO assets (site_id,filename,prompt,data,created_by,created_at) VALUES (?,?,?,?,?,?)")
    .run(siteId, filename, prompt, data, createdBy, now());
  return num(info.lastInsertRowid);
}
export const listAssets = (siteId) =>
  db.prepare("SELECT id,filename,prompt,data,created_at FROM assets WHERE site_id=? ORDER BY id DESC LIMIT 200").all(siteId);
export const deleteAsset = (id, siteId) => db.prepare("DELETE FROM assets WHERE id=? AND site_id=?").run(id, siteId);

/* ============ 問い合わせフォーム送信 ============ */
export function addSubmission({ siteId, pageId, data }) {
  const info = db.prepare("INSERT INTO form_submissions (site_id,page_id,data,created_at) VALUES (?,?,?,?)")
    .run(siteId, pageId || null, JSON.stringify(data), now());
  return num(info.lastInsertRowid);
}
export const listSubmissions = (siteId) =>
  db.prepare("SELECT id,page_id,data,status,created_at FROM form_submissions WHERE site_id=? ORDER BY id DESC LIMIT 500").all(siteId)
    .map(s => ({ ...s, data: JSON.parse(s.data) }));
export const setSubmissionStatus = (id, siteId, status) => db.prepare("UPDATE form_submissions SET status=? WHERE id=? AND site_id=?").run(status, id, siteId);
export const deleteSubmission = (id, siteId) => db.prepare("DELETE FROM form_submissions WHERE id=? AND site_id=?").run(id, siteId);
export const countSubmissions = (siteId) => db.prepare("SELECT COUNT(*) c FROM form_submissions WHERE site_id=?").get(siteId).c;

/* ============ アクセス解析 ============ */
export function addView({ siteId, pageKey, ref, visitor, isNew, device, variant }) {
  db.prepare("INSERT INTO page_views (site_id,page_key,ref,visitor,is_new,device,variant,ts) VALUES (?,?,?,?,?,?,?,?)")
    .run(siteId, String(pageKey || "/").slice(0, 200), (ref || "").slice(0, 300), (visitor || "").slice(0, 40), isNew ? 1 : 0, (device || "").slice(0, 12), (variant || "").slice(0, 4), now());
}
export function addEvent({ siteId, pageKey, visitor, type, num, label }) {
  db.prepare("INSERT INTO events (site_id,page_key,visitor,type,num,label,ts) VALUES (?,?,?,?,?,?,?)")
    .run(siteId, String(pageKey || "").slice(0, 200), (visitor || "").slice(0, 40), type, +num || 0, (label || "").slice(0, 100), now());
}
// opts: { from, to (ms), granularity, pageKey, device }
export function analyticsSummary(siteId, opts = {}) {
  const from = opts.from || (now() - 30 * 86400000);
  const to = opts.to || now();
  const conds = ["site_id=?", "ts>=?", "ts<=?"]; const args = [siteId, from, to];
  if (opts.pageKey) { conds.push("page_key=?"); args.push(opts.pageKey); }
  if (opts.device) { conds.push("device=?"); args.push(opts.device); }
  const where = "WHERE " + conds.join(" AND ");
  const one = (sql, a = args) => db.prepare(sql).get(...a);

  const pv = one(`SELECT COUNT(*) c FROM page_views ${where}`).c;
  const users = one(`SELECT COUNT(DISTINCT visitor) c FROM page_views ${where} AND visitor<>''`).c;
  const newUsers = one(`SELECT COUNT(*) c FROM (SELECT visitor, MIN(ts) m FROM page_views WHERE site_id=? AND visitor<>'' ${opts.pageKey ? "AND page_key=?" : ""} ${opts.device ? "AND device=?" : ""} GROUP BY visitor) WHERE m>=? AND m<=?`,
    [siteId, ...(opts.pageKey ? [opts.pageKey] : []), ...(opts.device ? [opts.device] : []), from, to]).c;
  const sessions = one(`SELECT COUNT(*) c FROM (SELECT DISTINCT visitor, strftime('%Y-%m-%d', ts/1000,'unixepoch','localtime') d FROM page_views ${where} AND visitor<>'')`).c;
  const refCount = one(`SELECT COUNT(DISTINCT ref) c FROM page_views ${where} AND ref<>''`).c;
  const pvPerSession = sessions ? +(pv / sessions).toFixed(2) : 0;

  // 直帰: 1セッション(訪問者×日)で1PVのみ
  const bounce = one(`SELECT COUNT(*) c FROM (SELECT visitor, strftime('%Y-%m-%d', ts/1000,'unixepoch','localtime') d, COUNT(*) v FROM page_views ${where} AND visitor<>'' GROUP BY visitor,d HAVING v=1)`).c;
  const bounceRate = sessions ? +(bounce / sessions * 100).toFixed(1) : 0;

  // 滞在時間・エンゲージ・コンバージョンは events から（同じ期間/絞り込み）
  const econds = ["site_id=?", "ts>=?", "ts<=?"]; const eargs = [siteId, from, to];
  if (opts.pageKey) { econds.push("page_key=?"); eargs.push(opts.pageKey); }
  const ewhere = "WHERE " + econds.join(" AND ");
  const eone = (sql, t) => db.prepare(sql).get(...eargs, t);
  const avgTimeRow = db.prepare(`SELECT AVG(num) a, COUNT(*) c FROM events ${ewhere} AND type='engage'`).get(...eargs);
  const avgTime = avgTimeRow.a ? Math.round(avgTimeRow.a) : 0;
  const engagedSessions = db.prepare(`SELECT COUNT(*) c FROM (SELECT DISTINCT visitor, strftime('%Y-%m-%d', ts/1000,'unixepoch','localtime') d FROM events ${ewhere} AND type='engage' AND num>=10)`).get(...eargs).c;
  const engagementRate = sessions ? +(engagedSessions / sessions * 100).toFixed(1) : 0;
  const conversions = db.prepare(`SELECT COUNT(*) c FROM events ${ewhere} AND type='conversion'`).get(...eargs).c;
  const conversionRate = sessions ? +(conversions / sessions * 100).toFixed(2) : 0;

  const byPage = db.prepare(`SELECT page_key, COUNT(*) c FROM page_views ${where} GROUP BY page_key ORDER BY c DESC LIMIT 30`).all(...args);
  const byRef = db.prepare(`SELECT ref, COUNT(*) v, COUNT(DISTINCT visitor) u FROM page_views ${where} AND ref<>'' GROUP BY ref ORDER BY v DESC LIMIT 20`).all(...args);
  const byDevice = db.prepare(`SELECT COALESCE(NULLIF(device,''),'unknown') device, COUNT(*) c FROM page_views ${where} GROUP BY device ORDER BY c DESC`).all(...args);

  const fmt = opts.granularity === "month" ? "%Y-%m" : opts.granularity === "week" ? "%Y-W%W" : "%Y-%m-%d";
  const series = db.prepare(`SELECT strftime('${fmt}', ts/1000,'unixepoch','localtime') d, COUNT(*) pv, COUNT(DISTINCT visitor) u
    FROM page_views ${where} GROUP BY d ORDER BY d`).all(...args);
  const convSeries = db.prepare(`SELECT strftime('${fmt}', ts/1000,'unixepoch','localtime') d, COUNT(*) c
    FROM events ${ewhere} AND type='conversion' GROUP BY d ORDER BY d`).all(...eargs);

  return { range: { from, to, granularity: opts.granularity || "day", pageKey: opts.pageKey || "", device: opts.device || "" },
           kpi: { pv, users, newUsers, sessions, refCount, pvPerSession, bounceRate, avgTime, engagementRate, engagedSessions, conversions, conversionRate },
           byPage, byRef, byDevice, series, convSeries };
}
export const listViewPageKeys = (siteId) =>
  db.prepare("SELECT page_key, COUNT(*) c FROM page_views WHERE site_id=? GROUP BY page_key ORDER BY c DESC").all(siteId).map(r => r.page_key);

/* ============ リビジョン（版管理） ============ */
export const listRevisions = (pageId) =>
  db.prepare("SELECT id,author,created_at FROM revisions WHERE page_id=? ORDER BY id DESC LIMIT 20").all(pageId);
export const getRevision = (id) => db.prepare("SELECT * FROM revisions WHERE id=?").get(id);

/* ============ 予約投稿 ============ */
export function schedulePost(id, scheduledAt) { db.prepare("UPDATE posts SET status='scheduled', scheduled_at=? WHERE id=?").run(scheduledAt, id); }
export function publishDuePosts() {
  const due = db.prepare("SELECT id FROM posts WHERE status='scheduled' AND scheduled_at<=?").all(now());
  for (const r of due) db.prepare("UPDATE posts SET status='published', published_at=?, scheduled_at=NULL WHERE id=?").run(now(), r.id);
  return due.length;
}

/* ============ AI改善提案（承認キュー） ============ */
export function addSuggestion({ siteId, kind, title, body }) {
  const info = db.prepare("INSERT INTO suggestions (site_id,kind,title,body,status,created_at) VALUES (?,?,?,?,'pending',?)").run(siteId, kind, title, body, now());
  return num(info.lastInsertRowid);
}
export const listSuggestions = (siteId, status) => status
  ? db.prepare("SELECT * FROM suggestions WHERE site_id=? AND status=? ORDER BY id DESC").all(siteId, status)
  : db.prepare("SELECT * FROM suggestions WHERE site_id=? ORDER BY id DESC LIMIT 50").all(siteId);
export const countPendingSuggestions = (siteId) => db.prepare("SELECT COUNT(*) c FROM suggestions WHERE site_id=? AND status='pending'").get(siteId).c;
export const setSuggestionStatus = (id, siteId, status) => db.prepare("UPDATE suggestions SET status=? WHERE id=? AND site_id=?").run(status, id, siteId);

/* ============ 監査ログ ============ */
export function addLog({ siteId, actor, action, detail }) {
  db.prepare("INSERT INTO audit_logs (site_id,actor,action,detail,ts) VALUES (?,?,?,?,?)").run(siteId || null, actor || "", action, (detail || "").slice(0, 300), now());
}
export const listLogs = (siteId) => db.prepare("SELECT * FROM audit_logs WHERE site_id=? ORDER BY id DESC LIMIT 200").all(siteId);

/* ============ A/Bテスト集計 ============ */
export function abStats(siteId) {
  // バリアント別の表示数（page_views.variant）とコンバージョン（events.label 末尾 |A/|B）
  const imp = db.prepare("SELECT variant, COUNT(*) c FROM page_views WHERE site_id=? AND variant IN ('A','B') GROUP BY variant").all(siteId);
  const conv = db.prepare("SELECT substr(label, -1) v, COUNT(*) c FROM events WHERE site_id=? AND type='conversion' AND (label LIKE '%|A' OR label LIKE '%|B') GROUP BY v").all(siteId);
  const get = (arr, v) => (arr.find(x => (x.variant || x.v) === v) || {}).c || 0;
  const mk = (v) => { const i = get(imp, v), c = get(conv, v); return { variant: v, impressions: i, conversions: c, rate: i ? +(c / i * 100).toFixed(2) : 0 }; };
  const A = mk("A"), B = mk("B");
  const total = A.impressions + B.impressions;
  let winner = null;
  if (total >= 20 && (A.conversions + B.conversions) > 0) winner = A.rate >= B.rate ? "A" : "B";
  return { A, B, winner, total };
}

/* ============ 使用量（マスター向け） ============ */
export function monthlyPv(siteId) {
  const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
  return db.prepare("SELECT COUNT(*) c FROM page_views WHERE site_id=? AND ts>=?").get(siteId, start.getTime()).c;
}

/* ============ バックアップ（フルエクスポート/復元） ============ */
export function exportSiteData(siteId) {
  const site = getSite(siteId);
  return { site: { title: site.title, slug: site.slug, settings: site.settings, published: site.published },
           pages: listPages(siteId).map(p => ({ name: p.name, position: p.position, blocks: p.blocks, meta: p.meta })),
           posts: db.prepare("SELECT title,slug,cover,excerpt,body,status,published_at FROM posts WHERE site_id=?").all(siteId) };
}
export function restoreSiteData(siteId, data) {
  if (!data || !Array.isArray(data.pages)) throw new Error("バックアップ形式が不正です");
  const site = getSite(siteId); if (!site) throw new Error("サイトがありません");
  if (data.site?.settings) updateSiteSettings(siteId, data.site.settings);
  db.prepare("DELETE FROM pages WHERE site_id=?").run(siteId);
  data.pages.forEach((p, i) => db.prepare("INSERT INTO pages (site_id,name,position,blocks,meta,updated_at) VALUES (?,?,?,?,?,?)")
    .run(siteId, p.name || "ページ", p.position ?? i, JSON.stringify(p.blocks || []), JSON.stringify(p.meta || {}), now()));
  if (Array.isArray(data.posts)) {
    db.prepare("DELETE FROM posts WHERE site_id=?").run(siteId);
    data.posts.forEach(p => db.prepare("INSERT INTO posts (site_id,title,slug,cover,excerpt,body,status,created_at,published_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(siteId, p.title || "記事", p.slug || ("post-" + Math.random().toString(36).slice(2, 7)), p.cover || "", p.excerpt || "", p.body || "", p.status || "draft", now(), p.published_at || null));
  }
}

/* ============ ブログ/コラム記事 ============ */
const num2 = num;
export function createPost({ siteId, title, slug, cover, excerpt, body, status }) {
  const info = db.prepare("INSERT INTO posts (site_id,title,slug,cover,excerpt,body,status,created_at,published_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(siteId, title, slug, cover || "", excerpt || "", body || "", status || "draft", now(), status === "published" ? now() : null);
  return getPost(num2(info.lastInsertRowid));
}
export const getPost = (id) => db.prepare("SELECT * FROM posts WHERE id=?").get(id);
export const getPostBySlug = (siteId, slug) => db.prepare("SELECT * FROM posts WHERE site_id=? AND slug=?").get(siteId, slug);
export const listPosts = (siteId) => db.prepare("SELECT id,title,slug,cover,excerpt,status,created_at,published_at,scheduled_at FROM posts WHERE site_id=? ORDER BY id DESC").all(siteId);
export const listPublishedPosts = (siteId) => db.prepare("SELECT id,title,slug,cover,excerpt,published_at FROM posts WHERE site_id=? AND status='published' ORDER BY published_at DESC").all(siteId);
export function updatePost(id, { title, slug, cover, excerpt, body, status }) {
  const cur = getPost(id); if (!cur) return;
  const pub = status === "published" ? (cur.published_at || now()) : (status === "draft" ? null : cur.published_at);
  db.prepare("UPDATE posts SET title=?,slug=?,cover=?,excerpt=?,body=?,status=?,published_at=? WHERE id=?")
    .run(title ?? cur.title, slug ?? cur.slug, cover ?? cur.cover, excerpt ?? cur.excerpt, body ?? cur.body, status ?? cur.status, pub, id);
  return getPost(id);
}
export const deletePost = (id, siteId) => db.prepare("DELETE FROM posts WHERE id=? AND site_id=?").run(id, siteId);

export default db;
