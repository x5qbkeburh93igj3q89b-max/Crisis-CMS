// server.js — マルチテナントCMS。Express REST API + WebSocket（リアルタイム共同編集）
import 'dotenv/config';
import express from "express";
import cookieParser from "cookie-parser";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

import * as DB from "./db.js";
import { suggestDesign, askDesignAdvice, generateImage, importFromUrl, analyzeAnalytics, generateBlog, suggestSeo, chatEditBlocks, growthSuggestions, a11yCheck, suggestKeywords, generateCustomCss } from "./ai.js";
import { renderSiteHTML, renderBlogIndex, renderPostPage, blocksToText } from "./render.js";

const slugify = (s) => (String(s || "").toLowerCase().trim().replace(/[^\w぀-ヿ一-鿿-]+/g, "-").replace(/^-+|-+$/g, "") || "post") + "";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());

// ---- 初回マスターアカウントの作成 ----
(function seedMaster() {
  if (DB.countMasters() > 0) return;
  const email = process.env.MASTER_EMAIL || "master@example.com";
  const password = process.env.MASTER_PASSWORD || "master123";
  const name = process.env.MASTER_NAME || "マスター管理者";
  DB.createUser({ email, name, password, role: "master", siteId: null });
  console.log(`[seed] マスターアカウントを作成: ${email} / パスワード: ${password}`);
})();

const pub = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, site_id: u.site_id });
const isMaster = (u) => u.role === "master";
const canEditRole = (r) => r === "owner" || r === "editor" || r === "master";

// ---- 認証ミドルウェア ----
function auth(req, res, next) {
  const user = DB.getSessionUser(req.cookies.session);
  if (!user) return res.status(401).json({ error: "未ログイン" });
  req.user = user;
  next();
}
function masterOnly(req, res, next) { isMaster(req.user) ? next() : res.status(403).json({ error: "マスター権限が必要です" }); }

// req.user が操作対象サイトを触れるか判定し、対象 siteId を返す
function resolveSiteId(req) {
  if (isMaster(req.user)) return Number(req.query.siteId || req.body?.siteId);   // マスターは指定サイト
  return req.user.site_id;                                                       // エンドユーザーは自サイト固定
}
function assertSiteAccess(req, res) {
  const sid = resolveSiteId(req);
  if (!sid) { res.status(400).json({ error: "サイトが指定されていません" }); return null; }
  if (!isMaster(req.user) && req.user.site_id !== sid) { res.status(403).json({ error: "他サイトへのアクセスは禁止です" }); return null; }
  return sid;
}
// ページが対象サイトに属するか
function assertPageInSite(pageId, siteId, res) {
  const p = DB.getPage(pageId);
  if (!p || p.site_id !== siteId) { res.status(404).json({ error: "ページが見つかりません" }); return null; }
  return p;
}

// ================= 認証 =================
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = DB.getUserByEmail(email);
  if (!DB.verifyPassword(user, password)) return res.status(401).json({ error: "メールまたはパスワードが違います" });
  const token = DB.createSession(user.id);
  res.cookie("session", token, { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 30 });
  res.json({ user: pub(user) });
});
app.post("/api/logout", auth, (req, res) => { DB.destroySession(req.cookies.session); res.clearCookie("session"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json({ user: pub(req.user) }));

// 自分のアカウント設定（エンドユーザー/マスター共通）
app.put("/api/account/name", auth, (req, res) => { DB.setUserName(req.user.id, req.body.name); res.json({ ok: true }); });
app.put("/api/account/password", auth, (req, res) => {
  if (!DB.verifyPassword(req.user, req.body.current || "")) return res.status(400).json({ error: "現在のパスワードが違います" });
  if (!req.body.next || req.body.next.length < 4) return res.status(400).json({ error: "新パスワードは4文字以上にしてください" });
  DB.setPassword(req.user.id, req.body.next); res.json({ ok: true });
});

// ================= マスターAPI =================
app.get("/api/master/sites", auth, masterOnly, (req, res) => {
  const sites = DB.listSites().map(s => ({ ...s, users: DB.listUsersBySite(s.id) }));
  res.json({ sites });
});
app.post("/api/master/sites", auth, masterOnly, (req, res) => {
  const { title, slug, ownerName, ownerEmail, ownerPassword } = req.body || {};
  if (!title || !slug) return res.status(400).json({ error: "サイト名とスラッグは必須です" });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: "スラッグは英小文字・数字・ハイフンのみ" });
  if (DB.slugExists(slug)) return res.status(409).json({ error: "そのスラッグは使用済みです" });
  const site = DB.createSite({ title, slug });
  let owner = null;
  if (ownerEmail && ownerPassword && ownerName) {
    if (DB.getUserByEmail(ownerEmail)) { DB.deleteSite(site.id); return res.status(409).json({ error: "そのメールは登録済みです" }); }
    owner = DB.createUser({ email: ownerEmail, name: ownerName, password: ownerPassword, role: "owner", siteId: site.id });
  }
  res.json({ site, owner: owner ? pub(owner) : null });
});
app.delete("/api/master/sites/:id", auth, masterOnly, (req, res) => { DB.deleteSite(+req.params.id); res.json({ ok: true }); });

// サイトにエンドユーザーアカウントを発行
app.post("/api/master/sites/:id/users", auth, masterOnly, (req, res) => {
  const site = DB.getSite(+req.params.id);
  if (!site) return res.status(404).json({ error: "サイトがありません" });
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "名前・メール・パスワードは必須" });
  if (DB.getUserByEmail(email)) return res.status(409).json({ error: "そのメールは登録済みです" });
  const u = DB.createUser({ name, email, password, role: ["owner", "editor", "viewer"].includes(role) ? role : "editor", siteId: site.id });
  res.json({ user: pub(u) });
});
app.put("/api/master/users/:id/password", auth, masterOnly, (req, res) => {
  if (!req.body.password || req.body.password.length < 4) return res.status(400).json({ error: "4文字以上" });
  DB.setPassword(+req.params.id, req.body.password); res.json({ ok: true });
});
app.put("/api/master/users/:id/role", auth, masterOnly, (req, res) => { DB.setUserRole(+req.params.id, req.body.role); res.json({ ok: true }); });
app.delete("/api/master/users/:id", auth, masterOnly, (req, res) => {
  const target = DB.getUser(+req.params.id);
  if (target && target.role === "master") return res.status(400).json({ error: "マスターは削除できません" });
  DB.deleteUser(+req.params.id); res.json({ ok: true });
});

// ================= サイト/ページ（テナントスコープ） =================
app.get("/api/site", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  const site = DB.getSite(sid); if (!site) return res.status(404).json({ error: "サイトがありません" });
  res.json({ site: { id: site.id, title: site.title, slug: site.slug, published: site.published, settings: site.settings }, pages: DB.listPages(sid) });
});
app.put("/api/site/settings", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "編集権限がありません" });
  DB.updateSiteSettings(sid, req.body.settings);
  broadcastSite(sid, { kind: "site-settings", settings: req.body.settings, by: req.user.name });
  res.json({ ok: true });
});
app.put("/api/site/publish", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  DB.setPublished(sid, !!req.body.published);
  DB.addLog({ siteId: sid, actor: req.user.name, action: req.body.published ? "publish" : "unpublish", detail: "サイト" });
  res.json({ ok: true });
});
app.post("/api/pages", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  const page = DB.createPage(sid, req.body.name || "新規ページ", req.body.parentId || null);
  broadcastSite(sid, { kind: "pages-changed" });
  res.json({ page });
});
app.put("/api/pages/:id/name", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!assertPageInSite(+req.params.id, sid, res)) return;
  DB.renamePage(+req.params.id, req.body.name); broadcastSite(sid, { kind: "pages-changed" }); res.json({ ok: true });
});
app.put("/api/pages/:id/slug", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!assertPageInSite(+req.params.id, sid, res)) return;
  const safe = String(req.body.slug || "").toLowerCase().replace(/[^\w-]/g, "-").replace(/^-+|-+$/g, "") || null;
  if (!safe) return res.status(400).json({ error: "slugが無効です" });
  const result = DB.setPageSlug(+req.params.id, safe);
  broadcastSite(sid, { kind: "pages-changed" }); res.json({ slug: result });
});
app.put("/api/pages/:id/parent", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!assertPageInSite(+req.params.id, sid, res)) return;
  DB.setPageParent(+req.params.id, req.body.parentId || null);
  broadcastSite(sid, { kind: "pages-changed" }); res.json({ ok: true });
});
app.delete("/api/pages/:id", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!assertPageInSite(+req.params.id, sid, res)) return;
  DB.deletePage(+req.params.id); broadcastSite(sid, { kind: "pages-changed" }); res.json({ ok: true });
});
app.put("/api/pages/:id/blocks", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "閲覧専用です" });
  if (!assertPageInSite(+req.params.id, sid, res)) return;
  DB.savePageBlocks(+req.params.id, req.body.blocks, req.user.name); res.json({ ok: true });
});

// ================= AI =================
app.post("/api/ai/design", auth, async (req, res) => {
  console.log("[ai/design] hit - user:", req.user?.email, "role:", req.user?.role, "siteId:", req.query.siteId || req.body?.siteId);
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try { res.json(await suggestDesign({ instruction: req.body.instruction || "魅力的なページを作って", currentBlocks: req.body.currentBlocks || [], siteTitle: req.body.siteTitle || "" })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/ai/advice", auth, async (req, res) => {
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try { res.json({ text: await askDesignAdvice({ instruction: req.body.instruction, context: req.body.context }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/ai/image", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try {
    const { dataUrl } = await generateImage({ prompt: req.body.prompt, size: req.body.size || "1024x1024" });
    const id = DB.saveAsset({ siteId: sid, filename: "ai-" + Date.now() + ".png", prompt: req.body.prompt, data: dataUrl, createdBy: req.user.id });
    res.json({ id, dataUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 参考URL取込 → ブロック変換
app.post("/api/ai/import-url", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try { res.json(await importFromUrl({ url: req.body.url })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= メディアライブラリ =================
app.get("/api/media", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  res.json({ assets: DB.listAssets(sid) });
});
app.post("/api/media", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  if (!req.body.data) return res.status(400).json({ error: "画像データがありません" });
  const id = DB.saveAsset({ siteId: sid, filename: req.body.filename || "upload.png", prompt: "", data: req.body.data, createdBy: req.user.id });
  res.json({ id });
});
app.delete("/api/media/:id", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  DB.deleteAsset(+req.params.id, sid); res.json({ ok: true });
});

// ================= ページSEO/メタ =================
app.put("/api/pages/:id/meta", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  if (!assertPageInSite(+req.params.id, sid, res)) return;
  DB.savePageMeta(+req.params.id, req.body.meta); res.json({ ok: true });
});
// AIによるSEOメタ提案
app.post("/api/ai/seo", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  const page = assertPageInSite(+req.body.pageId, sid, res); if (!page) return;
  try { const site = DB.getSite(sid); res.json(await suggestSeo({ pageName: page.name, siteTitle: site.title, contentText: blocksToText(page.blocks) })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= 会話型ビルダー =================
app.post("/api/ai/chat-edit", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try { res.json(await chatEditBlocks({ instruction: req.body.instruction, blocks: req.body.blocks || [] })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= AIアクセシビリティ/表記チェック =================
app.post("/api/ai/a11y", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  const page = assertPageInSite(+req.body.pageId, sid, res); if (!page) return;
  try { res.json({ text: await a11yCheck({ pageName: page.name, contentText: blocksToText(page.blocks) }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/ai/custom-css", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try {
    const site = DB.getSite(sid);
    const s = site.settings;
    const result = await generateCustomCss({ siteTitle: s.siteTitle, mood: req.body.mood || "モダン", accent: s.accent, pageBg: s.pageBg });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= AIグロースエージェント =================
function buildPagesText(siteId) { return DB.listPages(siteId).map(p => `# ${p.name}\n${blocksToText(p.blocks)}`).join("\n\n").slice(0, 4000); }
async function runAgentForSite(siteId) {
  const site = DB.getSite(siteId); if (!site) return 0;
  const { suggestions } = await growthSuggestions({ summary: DB.analyticsSummary(siteId), siteTitle: site.title, pagesText: buildPagesText(siteId) });
  suggestions.forEach(s => DB.addSuggestion({ siteId, kind: "growth", title: s.title || "改善案", body: s.body || "" }));
  if (suggestions.length) DB.addLog({ siteId, actor: "AIエージェント", action: "growth-run", detail: `${suggestions.length}件の提案を生成` });
  return suggestions.length;
}
app.post("/api/agent/run", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try { res.json({ created: await runAgentForSite(sid) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/suggestions", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  res.json({ suggestions: DB.listSuggestions(sid, req.query.status) });
});
app.put("/api/suggestions/:id", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  DB.setSuggestionStatus(+req.params.id, sid, ["done", "dismissed", "pending"].includes(req.body.status) ? req.body.status : "done");
  res.json({ ok: true });
});

// ================= A/Bテスト =================
app.get("/api/ab", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  res.json({ ab: DB.abStats(sid) });
});
app.post("/api/ab/apply-winner", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  const stats = DB.abStats(sid);
  if (!stats.winner) return res.status(400).json({ error: "勝者判定にはもう少しデータが必要です（合計20表示以上）" });
  const page = assertPageInSite(+req.body.pageId, sid, res); if (!page) return;
  let changed = false;
  const apply = (arr) => arr.forEach(b => { if (b.type === "hero" && b.ab && b.titleB) { if (stats.winner === "B") b.title = b.titleB; b.ab = false; b.titleB = ""; changed = true; } if (b.type === "columns") b.cols.forEach(apply); });
  apply(page.blocks);
  if (!changed) return res.status(400).json({ error: "A/B対象のヒーローがこのページにありません" });
  DB.savePageBlocks(page.id, page.blocks, req.user.name + "(AB勝者採用)");
  DB.addLog({ siteId: sid, actor: req.user.name, action: "ab-winner", detail: `${page.name}: 勝者=${stats.winner}` });
  broadcastPage(page.id, { kind: "blocks-update", blocks: page.blocks, by: { name: req.user.name } });
  res.json({ ok: true, winner: stats.winner });
});

// ================= 監査ログ =================
app.get("/api/logs", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  res.json({ logs: DB.listLogs(sid) });
});

// ================= バックアップ =================
app.get("/api/backup", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  res.json({ backup: DB.exportSiteData(sid) });
});
app.post("/api/backup/restore", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (req.user.role !== "master" && req.user.role !== "owner") return res.status(403).json({ error: "オーナー以上の権限が必要です" });
  try { DB.restoreSiteData(sid, req.body.backup); DB.addLog({ siteId: sid, actor: req.user.name, action: "restore", detail: "バックアップから復元" }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= マスター: 使用量 =================
app.get("/api/master/usage", auth, masterOnly, (req, res) => {
  const usage = DB.listSites().map(s => ({ id: s.id, title: s.title, slug: s.slug, published: s.published, monthlyPv: DB.monthlyPv(s.id), limit: s.settings.pvLimit || 0, plan: s.settings.plan || "free" }));
  res.json({ usage });
});
app.put("/api/master/sites/:id/plan", auth, masterOnly, (req, res) => {
  const site = DB.getSite(+req.params.id); if (!site) return res.status(404).json({ error: "サイトがありません" });
  const s = site.settings; s.plan = req.body.plan || "free"; s.pvLimit = +req.body.pvLimit || 0;
  DB.updateSiteSettings(site.id, s); res.json({ ok: true });
});

// ================= リビジョン（版管理・復元） =================
app.get("/api/pages/:id/revisions", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!assertPageInSite(+req.params.id, sid, res)) return;
  res.json({ revisions: DB.listRevisions(+req.params.id) });
});
app.post("/api/pages/:id/revisions/:rid/restore", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  if (!assertPageInSite(+req.params.id, sid, res)) return;
  const rev = DB.getRevision(+req.params.rid);
  if (!rev || rev.page_id !== +req.params.id) return res.status(404).json({ error: "リビジョンがありません" });
  const blocks = JSON.parse(rev.blocks);
  DB.savePageBlocks(+req.params.id, blocks, req.user.name + "(復元)");
  broadcastPage(+req.params.id, { kind: "blocks-update", blocks, by: { name: req.user.name } });
  res.json({ ok: true, blocks });
});

// ================= 問い合わせフォーム =================
// 送信（公開サイト用・認証不要。published のサイトのみ受付）
app.post("/api/forms/:slug/submit", (req, res) => {
  const site = DB.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).json({ error: "受付できません" });
  const data = req.body && typeof req.body === "object" ? req.body : {};
  // 軽いバリデーション/サニタイズ
  const clean = {};
  for (const [k, v] of Object.entries(data)) { if (["pageId", "visitor", "page", "variant"].includes(k)) continue; clean[String(k).slice(0, 60)] = String(v == null ? "" : v).slice(0, 5000); }
  DB.addSubmission({ siteId: site.id, pageId: data.pageId || null, data: clean });
  // フォーム送信をコンバージョンとして計測
  DB.addEvent({ siteId: site.id, pageKey: data.page || "", visitor: data.visitor || "", type: "conversion", num: 1, label: "form" });
  notifySubmission(site, clean);
  res.json({ ok: true });
});
// フォーム通知（Webメール/Webhook。site.settings.notifyWebhook / notifyEmail）
async function notifySubmission(site, data) {
  const s = site.settings || {};
  const lines = Object.entries(data).map(([k, v]) => `${k.replace(/^f_\d+_/, "")}: ${v}`).join("\n");
  if (s.notifyWebhook && /^https?:\/\//.test(s.notifyWebhook)) {
    fetch(s.notifyWebhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ site: site.title, slug: site.slug, submission: data, text: lines }) }).catch(() => {});
  }
  if (s.notifyEmail && process.env.SMTP_URL) { sendMail(s.notifyEmail, `【${site.title}】新規お問い合わせ`, lines).catch(() => {}); }
}
// SMTP（任意。SMTP_URL=smtp://user:pass@host:port が設定されていればnodemailerで送信。未導入なら静かにスキップ）
async function sendMail(to, subject, text) {
  try {
    const nm = await import("nodemailer");
    const t = nm.createTransport(process.env.SMTP_URL);
    await t.sendMail({ from: process.env.SMTP_FROM || "no-reply@crisis-cms", to, subject, text });
  } catch (e) { console.warn("[mail] 送信スキップ:", e.message); }
}
// 一覧（編集者以上）
app.get("/api/forms", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  res.json({ submissions: DB.listSubmissions(sid) });
});
app.put("/api/forms/:id/status", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  DB.setSubmissionStatus(+req.params.id, sid, ["未対応", "対応中", "完了"].includes(req.body.status) ? req.body.status : "未対応");
  res.json({ ok: true });
});
app.delete("/api/forms/:id", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  DB.deleteSubmission(+req.params.id, sid); res.json({ ok: true });
});

// ================= アクセス解析 =================
// 計測ビーコン（公開ページから・認証不要）
app.post("/api/track", (req, res) => {
  const site = DB.getSiteBySlug(req.body.slug);
  if (site && site.published) DB.addView({ siteId: site.id, pageKey: req.body.page || "/", ref: req.body.ref || "", visitor: req.body.visitor || "", isNew: !!req.body.isNew, device: req.body.device || "", variant: req.body.variant || "" });
  res.json({ ok: true });
});
// エンゲージメント/コンバージョン等のイベント（公開・認証不要）
app.post("/api/event", (req, res) => {
  const site = DB.getSiteBySlug(req.body.slug);
  if (site && site.published && ["engage", "scroll", "conversion"].includes(req.body.type)) {
    DB.addEvent({ siteId: site.id, pageKey: req.body.page || "", visitor: req.body.visitor || "", type: req.body.type, num: req.body.num, label: req.body.label || "" });
  }
  res.json({ ok: true });
});
app.get("/api/analytics", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  const opts = {};
  if (req.query.from) opts.from = +req.query.from;
  if (req.query.to) opts.to = +req.query.to;
  if (["day", "week", "month"].includes(req.query.granularity)) opts.granularity = req.query.granularity;
  if (req.query.page) opts.pageKey = req.query.page;
  res.json({ summary: DB.analyticsSummary(sid, opts), pageKeys: DB.listViewPageKeys(sid) });
});
app.post("/api/analytics/insight", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try { const site = DB.getSite(sid); res.json({ text: await analyzeAnalytics({ summary: DB.analyticsSummary(sid), siteTitle: site.title }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= ブログ / コラム =================
app.get("/api/posts", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  res.json({ posts: DB.listPosts(sid) });
});
app.get("/api/posts/:id", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  const p = DB.getPost(+req.params.id); if (!p || p.site_id !== sid) return res.status(404).json({ error: "記事がありません" });
  res.json({ post: p });
});
function uniqueSlug(sid, base, excludeId) {
  let slug = slugify(base), n = 1;
  while (true) { const ex = DB.getPostBySlug(sid, slug); if (!ex || ex.id === excludeId) return slug; slug = slugify(base) + "-" + (++n); }
}
app.post("/api/posts", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  const { title, body, excerpt, cover, status } = req.body || {};
  const slug = uniqueSlug(sid, req.body.slug || title || "post");
  res.json({ post: DB.createPost({ siteId: sid, title: title || "無題の記事", slug, body: body || "", excerpt, cover, status: status || "draft" }) });
});
app.put("/api/posts/:id", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  const p = DB.getPost(+req.params.id); if (!p || p.site_id !== sid) return res.status(404).json({ error: "記事がありません" });
  const patch = { ...req.body };
  if (req.body.slug !== undefined) patch.slug = uniqueSlug(sid, req.body.slug, p.id);
  res.json({ post: DB.updatePost(p.id, patch) });
});
app.delete("/api/posts/:id", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  DB.deletePost(+req.params.id, sid); res.json({ ok: true });
});
// 予約投稿（指定日時に自動公開）
app.put("/api/posts/:id/schedule", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  const p = DB.getPost(+req.params.id); if (!p || p.site_id !== sid) return res.status(404).json({ error: "記事がありません" });
  const at = +req.body.scheduledAt;
  if (!at || at < Date.now()) return res.status(400).json({ error: "未来の日時を指定してください" });
  DB.schedulePost(p.id, at); res.json({ ok: true });
});
app.post("/api/ai/blog", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try { res.json(await generateBlog({ topic: req.body.topic, tone: req.body.tone, length: req.body.length })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/ai/keywords", auth, async (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  if (!canEditRole(req.user.role)) return res.status(403).json({ error: "権限がありません" });
  try { res.json(await suggestKeywords({ topic: req.body.topic })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== SEO自動化: sitemap / rss / robots =====
app.get("/s/:slug/sitemap.xml", (req, res) => {
  const site = DB.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send("not found");
  const base = `${req.protocol}://${req.get("host")}/s/${site.slug}`;
  const pages = DB.listPages(site.id);
  const posts = DB.listPublishedPosts(site.id);
  const urls = [`${base}/`, ...pages.slice(1).map((p, i) => `${base}/page${i + 1}.html`), `${base}/blog`, ...posts.map(p => `${base}/blog/${encodeURIComponent(p.slug)}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${u}</loc></url>`).join("\n")}\n</urlset>`;
  res.type("application/xml").send(xml);
});
app.get("/s/:slug/rss.xml", (req, res) => {
  const site = DB.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send("not found");
  const base = `${req.protocol}://${req.get("host")}/s/${site.slug}`;
  const esc = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = DB.listPublishedPosts(site.id).map(p => `<item><title>${esc(p.title)}</title><link>${base}/blog/${encodeURIComponent(p.slug)}</link><description>${esc(p.excerpt)}</description><pubDate>${new Date(p.published_at).toUTCString()}</pubDate></item>`).join("\n");
  res.type("application/rss+xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(site.title)}</title><link>${base}/blog</link><description>${esc(site.settings.siteTitle)}</description>\n${items}\n</channel></rss>`);
});
app.get("/s/:slug/robots.txt", (req, res) => {
  const site = DB.getSiteBySlug(req.params.slug);
  const base = `${req.protocol}://${req.get("host")}/s/${req.params.slug}`;
  res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
});

// 公開ブログ（誰でも・published サイトのみ）
app.get("/s/:slug/blog", (req, res) => {
  const site = DB.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send("見つかりません");
  res.type("html").send(renderBlogIndex(site, DB.listPublishedPosts(site.id)));
});
app.get("/s/:slug/blog/:postSlug", (req, res) => {
  const site = DB.getSiteBySlug(req.params.slug);
  if (!site || !site.published) return res.status(404).send("見つかりません");
  const post = DB.getPostBySlug(site.id, req.params.postSlug);
  if (!post || post.status !== "published") return res.status(404).send("記事が見つかりません");
  res.type("html").send(renderPostPage(site, post));
});

// ================= 書き出し =================
app.get("/api/export", auth, (req, res) => {
  const sid = assertSiteAccess(req, res); if (!sid) return;
  const site = DB.getSite(sid);
  res.json({ files: renderSiteHTML(site, DB.listPages(sid)) });
});

// ================= 公開サイト & プレビュー（slug） =================
// プレビュー: ログイン中の編集者向け（公開フラグに関わらず閲覧可）
app.get("/preview/:slug/:page?", auth, (req, res) => servePublic(req, res, true));
// 公開: published=1 のサイトのみ、誰でも閲覧可
app.get("/s/:slug/:page?", (req, res) => servePublic(req, res, false));
function servePublic(req, res, isPreview) {
  const site = DB.getSiteBySlug(req.params.slug);
  if (!site) return res.status(404).send("サイトが見つかりません");
  if (!isPreview && !site.published) return res.status(404).send("このサイトは未公開です");
  if (isPreview) {
    const u = DB.getSessionUser(req.cookies.session);
    if (!u || (!isMaster(u) && u.site_id !== site.id)) return res.status(403).send("権限がありません");
  }
  const pages = DB.listPages(site.id);
  const hasBlog = DB.listPublishedPosts(site.id).length > 0;
  const files = renderSiteHTML(site, pages, { track: !isPreview, hasBlog });
  const pageParam = req.params.page || "";
  // slug.html → slug → index.html の順でマッチ
  const key = files[pageParam + ".html"] ? pageParam + ".html"
    : files[pageParam] ? pageParam
    : "index.html";
  const html = files[key];
  if (!html) return res.status(404).send("ページが見つかりません");
  res.type("html").send(html);
}

// 静的フロント（最後に置く）
app.use(express.static(path.join(__dirname, "public")));

// ================= WebSocket =================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const rooms = new Map(); // pageId -> Set<ws>
const roomOf = (id) => { if (!rooms.has(id)) rooms.set(id, new Set()); return rooms.get(id); };
function broadcastPage(pageId, msg, exceptWs) {
  const data = JSON.stringify(msg);
  for (const c of roomOf(pageId)) if (c !== exceptWs && c.readyState === 1) c.send(data);
}
// サイト内の全ページ部屋へ（設定変更/ページ追加通知用）
function broadcastSite(siteId, msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c._siteId === siteId && c.readyState === 1) c.send(data);
}
const presence = (pageId) => [...roomOf(pageId)].map(c => c._user).filter(Boolean).map(u => ({ id: u.id, name: u.name }));

wss.on("connection", (ws, req) => {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map(s => s.trim().split("=")));
  const user = DB.getSessionUser(cookies.session);
  if (!user) { ws.close(4001, "unauthorized"); return; }
  ws._user = pub(user); ws._pageId = null; ws._siteId = null;

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.kind === "join") {
      const page = DB.getPage(m.pageId);
      if (!page) return;
      // テナント検証: マスター以外は自サイトのページのみ
      if (user.role !== "master" && user.site_id !== page.site_id) return;
      if (ws._pageId != null) { roomOf(ws._pageId).delete(ws); broadcastPage(ws._pageId, { kind: "presence", users: presence(ws._pageId) }); }
      ws._pageId = m.pageId; ws._siteId = page.site_id;
      roomOf(m.pageId).add(ws);
      broadcastPage(m.pageId, { kind: "presence", users: presence(m.pageId) });
    }
    else if (m.kind === "blocks-update" && ws._pageId != null) {
      if (!canEditRole(user.role)) return;
      DB.savePageBlocks(ws._pageId, m.blocks, user.name);
      broadcastPage(ws._pageId, { kind: "blocks-update", blocks: m.blocks, by: ws._user }, ws);
    }
  });
  ws.on("close", () => { if (ws._pageId != null) { roomOf(ws._pageId).delete(ws); broadcastPage(ws._pageId, { kind: "presence", users: presence(ws._pageId) }); } });
});

// 予約投稿の自動公開（1分ごと）
setInterval(() => { try { const n = DB.publishDuePosts(); if (n) console.log(`[schedule] ${n}件の予約記事を公開`); } catch {} }, 60000);

// AIグロースエージェント: 週1回、全サイトを解析して改善提案を承認キューへ
let lastAgentRun = 0;
setInterval(async () => {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith("sk-ant-xxx")) return;
  if (Date.now() - lastAgentRun < 7 * 86400000) return;
  lastAgentRun = Date.now();
  for (const s of DB.listSites()) { try { const n = await runAgentForSite(s.id); if (n) console.log(`[agent] ${s.title}: ${n}件の改善提案`); } catch {} }
}, 3600000); // 1時間ごとにチェック（実行は週1回）

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Crisis CMS (multi-tenant) → http://localhost:${PORT}`));
