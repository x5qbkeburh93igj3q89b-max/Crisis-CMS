"use strict";
/* ============================================================
   Crisis CMS フロントエンド
   - サーバーAPIでデータ永続化（SQLite）
   - WebSocketでリアルタイム共同編集 + プレゼンス
   - Claudeデザイン提案 / 画像生成
   ============================================================ */

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let ME = null;          // ログインユーザー
let SITE = null;        // {id,title,slug,published,settings}
let PAGES = [];         // [{id,name,blocks,...}]
let ACTIVE_SITE = null; // マスターが編集中のサイトID（エンドユーザーはnullで自サイト固定）
let curIdx = 0;
let selectedId = null;
let ws = null;
let applyingRemote = false;   // リモート更新適用中はWS送信を抑制
const isMaster = () => ME && ME.role === "master";
const canEdit = () => ME && ["master", "owner", "editor"].includes(ME.role);

/* ============ API helper ============ */
async function api(method, url, body) {
  // マスターが特定サイトを操作中は siteId を自動付与
  if (isMaster() && ACTIVE_SITE && url.startsWith("/api/") && !url.startsWith("/api/master") && !url.startsWith("/api/account") && url !== "/api/me" && url !== "/api/logout") {
    url += (url.includes("?") ? "&" : "?") + "siteId=" + ACTIVE_SITE;
  }
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  if (res.status === 401) { showLogin(); throw new Error("未ログイン"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

/* ============ Block定義 ============ */
const BLOCKS = {
  hero:   { icon: "★", label: "ヒーロー", make: () => ({ type:"hero", id:uid(), title:"大きなタイトル", sub:"サブテキストを入力", btn:"詳しく見る", href:"#", bg:"#5b8cff", color:"#ffffff", img:"" }) },
  heading:{ icon: "H", label: "見出し",   make: () => ({ type:"heading", id:uid(), text:"見出しテキスト", level:"h2", align:"left", color:"" }) },
  text:   { icon: "¶", label: "テキスト", make: () => ({ type:"text", id:uid(), html:"ここに本文を入力します。クリックして編集できます。", align:"left", color:"", size:16 }) },
  image:  { icon: "🖼", label: "画像",    make: () => ({ type:"image", id:uid(), src:"", alt:"", align:"center", width:100, radius:6, link:"" }) },
  button: { icon: "⬛", label: "ボタン",   make: () => ({ type:"button", id:uid(), text:"クリック", href:"#", align:"center", bg:"", color:"#ffffff" }) },
  list:   { icon: "≣", label: "リスト",   make: () => ({ type:"list", id:uid(), items:["項目1","項目2","項目3"], ordered:false, align:"left" }) },
  quote:  { icon: "❝", label: "引用",     make: () => ({ type:"quote", id:uid(), text:"印象的な一文をここに。", cite:"" }) },
  divider:{ icon: "─", label: "区切り線", make: () => ({ type:"divider", id:uid(), color:"#e2e2e2" }) },
  spacer: { icon: "↕", label: "余白",     make: () => ({ type:"spacer", id:uid(), height:40 }) },
  video:  { icon: "▶", label: "動画",     make: () => ({ type:"video", id:uid(), url:"" }) },
  columns:{ icon: "▥", label: "カラム",   make: () => ({ type:"columns", id:uid(), cols:[[],[]] }) },
  form:   { icon: "✉", label: "フォーム", make: () => ({ type:"form", id:uid(), align:"center", submitLabel:"送信する", fields:[
            { label:"お名前", type:"text", required:true },
            { label:"電話番号", type:"text", required:false },
            { label:"メール", type:"email", required:true },
            { label:"お問い合わせ内容", type:"textarea", required:true } ] }) },
  html:   { icon: "</>", label: "HTML",   make: () => ({ type:"html", id:uid(), code:"<div style='padding:20px;text-align:center'>カスタムHTML</div>" }) },
  cta:    { icon: "🎯", label: "CTA",     make: () => ({ type:"cta", id:uid(), title:"今すぐ始めましょう", sub:"無料でお試しいただけます", btn:"お問い合わせ", href:"#", bg:"", color:"#ffffff", cv:true }) },
  faq:    { icon: "❓", label: "FAQ",     make: () => ({ type:"faq", id:uid(), items:[{q:"質問1",a:"回答1"},{q:"質問2",a:"回答2"}] }) },
  pricing:{ icon: "💴", label: "料金表",  make: () => ({ type:"pricing", id:uid(), plans:[{name:"ライト",price:"¥0",features:["基本機能"],featured:false},{name:"プロ",price:"¥9,800",features:["全機能","サポート"],featured:true}] }) },
  stats:  { icon: "📈", label: "実績",    make: () => ({ type:"stats", id:uid(), items:[{num:"10,000+",label:"導入実績"},{num:"98%",label:"満足度"},{num:"24h",label:"サポート"}] }) },
  team:   { icon: "👤", label: "スタッフ", make: () => ({ type:"team", id:uid(), members:[{name:"山田 太郎",role:"代表",img:""},{name:"佐藤 花子",role:"スタッフ",img:""}] }) },
  jobs:   { icon: "💼", label: "求人募集", make: () => ({ type:"jobs", id:uid(), items:[{title:"Webデザイナー",type:"正社員",desc:"経験者歓迎"},{title:"アルバイト",type:"パート",desc:"未経験OK"}] }) },
  map:    { icon: "📍", label: "地図",    make: () => ({ type:"map", id:uid(), query:"東京駅", height:360 }) },
};

/* ============ 認証フロー ============ */
function hideAll() { ["loginView", "appView", "masterView", "analyticsView"].forEach(id => $(id).classList.add("hidden")); }
function showLogin() { hideAll(); $("loginView").classList.remove("hidden"); }
function showApp() { hideAll(); $("appView").classList.remove("hidden"); }
function showMaster() { hideAll(); $("masterView").classList.remove("hidden"); }

$("loginBtn").onclick = login;
$("loginPass").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
async function login() {
  $("loginErr").textContent = "";
  try {
    const { user } = await api("POST", "/api/login", { email: $("loginEmail").value, password: $("loginPass").value });
    ME = user; await boot();
  } catch (e) { $("loginErr").textContent = e.message; }
}
$("btnLogout").onclick = $("mLogout").onclick = async () => { await api("POST", "/api/logout"); location.reload(); };

async function init() {
  try { const { user } = await api("GET", "/api/me"); ME = user; await boot(); }
  catch { showLogin(); }
}
async function boot() {
  if (isMaster()) { $("masterWho").textContent = `${ME.name}（マスター）`; ACTIVE_SITE = null; await renderMaster(); showMaster(); }
  else { await enterBuilder(); }
}
// エンドユーザー or マスターがサイト編集に入る
async function enterBuilder() {
  showApp();
  $("whoami").textContent = `${ME.name}（${roleLabel(ME.role)}）`;
  $("btnBackMaster").classList.toggle("hidden", !isMaster());
  curIdx = 0; selectedId = null;
  await loadSite();
  renderAll();
  connectWS();
}
const roleLabel = (r) => ({ master: "マスター", owner: "オーナー", editor: "編集者", viewer: "閲覧者" }[r] || r);

/* ============ データ取得 ============ */
async function loadSite() {
  const d = await api("GET", "/api/site");
  SITE = d.site; PAGES = d.pages;
  if (curIdx >= PAGES.length) curIdx = 0;
  $("siteName").textContent = "／ " + SITE.title;
  $("btnPublish").innerHTML = `<span>🌐</span>${SITE.published ? "公開中 ✓" : "公開する"}`;
}
const curPage = () => PAGES[curIdx];

/* ============ WebSocket ============ */
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => joinPage();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.kind === "presence") renderPresence(m.users);
    else if (m.kind === "blocks-update") {
      if (curPage() && m.blocks) { applyingRemote = true; curPage().blocks = m.blocks; renderCanvas(); applyingRemote = false; toast(`${m.by?.name || "他のユーザー"}が編集中`); }
    }
    else if (m.kind === "pages-changed") refreshPagesKeepIdx();
    else if (m.kind === "site-settings") { SITE.settings = m.settings; applySiteVars(); renderCanvas(); }
  };
  ws.onclose = () => { setTimeout(() => { if (ME) connectWS(); }, 2000); }; // 自動再接続
}
function joinPage() { if (ws && ws.readyState === 1 && curPage()) ws.send(JSON.stringify({ kind: "join", pageId: curPage().id })); }
function pushBlocks() {
  if (applyingRemote || !canEdit()) return;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ kind: "blocks-update", pageId: curPage().id, blocks: curPage().blocks }));
  else api("PUT", `/api/pages/${curPage().id}/blocks`, { blocks: curPage().blocks }).catch(() => {});
}
let pushTimer = null;
function scheduleSave() { clearTimeout(pushTimer); pushTimer = setTimeout(pushBlocks, 400); }

async function refreshPagesKeepIdx() {
  const id = curPage()?.id;
  await loadSite();
  const ni = PAGES.findIndex(p => p.id === id);
  curIdx = ni >= 0 ? ni : Math.min(curIdx, PAGES.length - 1);
  renderPages(); renderCanvas();
}

function renderPresence(users) {
  const el = $("presence"); el.innerHTML = "";
  (users || []).forEach(u => {
    const a = document.createElement("div"); a.className = "avatar"; a.title = u.name;
    a.textContent = (u.name || "?").slice(0, 1); el.appendChild(a);
  });
}

/* ============ 見た目 ============ */
function applySiteVars() {
  const s = SITE.settings, c = $("canvas");
  c.style.setProperty("--site-maxw", s.maxWidth + "px");
  c.style.setProperty("--site-font", s.font);
  c.style.background = s.pageBg; c.style.color = s.textColor;
  c.classList.toggle("full", !!s.fullWidth);
  // 編集対象サイトの色はキャンバス内だけで使用（管理画面のオレンジUIは保持）
  c.style.setProperty("--site-accent", s.accent);
  document.title = s.siteTitle + " — Crisis CMS";
}

/* ============ Block探索/操作 ============ */
function findBlock(id, list) {
  list = list || curPage().blocks;
  for (const b of list) {
    if (b.id === id) return { block: b, list };
    if (b.type === "columns") for (const c of b.cols) { const r = findBlock(id, c); if (r) return r; }
  }
  return null;
}
function removeBlock(id) { const r = findBlock(id); if (!r) return; r.list.splice(r.list.indexOf(r.block), 1); if (selectedId === id) selectedId = null; }
function dupBlock(id) { const r = findBlock(id); if (!r) return; const c = JSON.parse(JSON.stringify(r.block)); reId(c); r.list.splice(r.list.indexOf(r.block) + 1, 0, c); }
function reId(b) { b.id = uid(); if (b.type === "columns") b.cols.forEach(c => c.forEach(reId)); }
function moveBlock(id, dir) { const r = findBlock(id); if (!r) return; const i = r.list.indexOf(r.block), j = i + dir; if (j < 0 || j >= r.list.length) return; r.list.splice(j, 0, r.list.splice(i, 1)[0]); }

/* ============ レンダリング（共通HTML） ============ */
function embedUrl(u){ if(!u)return""; let m=u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);if(m)return"https://www.youtube.com/embed/"+m[1]; m=u.match(/vimeo\.com\/(\d+)/);if(m)return"https://player.vimeo.com/video/"+m[1]; if(u.includes("/embed/")||u.includes("player."))return u; return""; }
function blockInnerHTML(b) {
  const s = SITE.settings, al = b.align || "left";
  switch (b.type) {
    case "heading": return `<${b.level} style="text-align:${al};margin:.4em 0;${b.color?`color:${b.color}`:""}">${esc(b.text)}</${b.level}>`;
    case "text": return `<div style="text-align:${al};font-size:${b.size||16}px;line-height:1.7;${b.color?`color:${b.color};`:""}">${b.html}</div>`;
    case "image":
      if (!b.src) return `<div style="padding:30px;text-align:center;background:#f3f3f3;color:#999">画像を設定してください</div>`;
      var img = `<img src="${esc(b.src)}" alt="${esc(b.alt||"")}" style="width:${b.width||100}%;border-radius:${b.radius||0}px;display:inline-block">`;
      if (b.link) img = `<a href="${esc(b.link)}">${img}</a>`;
      return `<div style="text-align:${al}">${img}</div>`;
    case "button": return `<div style="text-align:${al};margin:6px 0"><a href="${esc(b.href||"#")}" style="display:inline-block;padding:11px 24px;border-radius:8px;text-decoration:none;background:${b.bg||s.accent};color:${b.color||"#fff"};font-weight:600">${esc(b.text)}</a></div>`;
    case "list": var tag = b.ordered?"ol":"ul"; return `<${tag} style="text-align:${al};line-height:1.8;padding-left:1.4em">`+b.items.map(i=>`<li>${esc(i)}</li>`).join("")+`</${tag}>`;
    case "quote": return `<blockquote style="border-left:4px solid ${s.accent};margin:0;padding:6px 18px;color:#555;font-style:italic">${esc(b.text)}${b.cite?`<footer style="font-size:.85em;color:#999;margin-top:6px">— ${esc(b.cite)}</footer>`:""}</blockquote>`;
    case "divider": return `<hr style="border:0;border-top:1px solid ${b.color||"#e2e2e2"};margin:8px 0">`;
    case "spacer": return `<div style="height:${b.height||40}px"></div>`;
    case "video": var e=embedUrl(b.url); return e?`<div style="position:relative;padding-bottom:56.25%;height:0"><iframe src="${e}" style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:8px" allowfullscreen></iframe></div>`:`<div style="padding:30px;text-align:center;background:#f3f3f3;color:#999">YouTube/Vimeoの動画URLを設定</div>`;
    case "html": return b.code || "";
    case "cta": { var cbg = b.bg || s.accent; return `<div style="background:${cbg};color:${b.color||"#fff"};border-radius:14px;padding:40px 28px;text-align:center"><h2 style="margin:0 0 8px;font-size:26px">${esc(b.title)}</h2><p style="margin:0 0 18px;opacity:.92">${esc(b.sub)}</p>${b.btn?`<span style="display:inline-block;padding:13px 32px;background:#fff;color:#222;border-radius:8px;font-weight:700">${esc(b.btn)}</span>`:""}</div>`; }
    case "faq": return `<div style="max-width:760px;margin:0 auto">${(b.items||[]).map(it=>`<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:8px"><div style="font-weight:600">${esc(it.q)}</div><div style="margin-top:6px;color:#555;line-height:1.7">${esc(it.a)}</div></div>`).join("")}</div>`;
    case "pricing": return `<div style="display:flex;gap:16px;flex-wrap:wrap;justify-content:center">${(b.plans||[]).map(p=>`<div style="flex:1;min-width:160px;max-width:280px;border:${p.featured?`2px solid ${s.accent}`:"1px solid #e5e7eb"};border-radius:14px;padding:20px;text-align:center">${p.featured?`<div style="display:inline-block;background:${s.accent};color:#fff;font-size:12px;padding:3px 12px;border-radius:20px;margin-bottom:8px">おすすめ</div>`:""}<h3 style="margin:0 0 4px">${esc(p.name)}</h3><div style="font-size:26px;font-weight:800;margin:8px 0">${esc(p.price)}</div><ul style="list-style:none;padding:0;margin:10px 0;color:#555;line-height:1.9;font-size:14px">${(p.features||[]).map(f=>`<li>${esc(f)}</li>`).join("")}</ul></div>`).join("")}</div>`;
    case "stats": return `<div style="display:flex;gap:20px;flex-wrap:wrap;justify-content:center;text-align:center">${(b.items||[]).map(it=>`<div style="flex:1;min-width:110px"><div style="font-size:34px;font-weight:800;color:${s.accent}">${esc(it.num)}</div><div style="color:#666;font-size:14px">${esc(it.label)}</div></div>`).join("")}</div>`;
    case "team": return `<div style="display:flex;gap:18px;flex-wrap:wrap;justify-content:center">${(b.members||[]).map(m=>`<div style="width:160px;text-align:center">${m.img?`<img src="${esc(m.img)}" style="width:110px;height:110px;border-radius:50%;object-fit:cover">`:`<div style="width:110px;height:110px;border-radius:50%;background:#eee;margin:0 auto"></div>`}<div style="font-weight:600;margin-top:8px">${esc(m.name)}</div><div style="color:#888;font-size:13px">${esc(m.role)}</div></div>`).join("")}</div>`;
    case "jobs": return `<div style="max-width:760px;margin:0 auto">${(b.items||[]).map(j=>`<div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><div style="font-weight:600">${esc(j.title)}</div><div style="color:#666;font-size:13px;margin-top:3px">${esc(j.desc)}</div></div><span style="background:#f3f4f6;border-radius:20px;padding:4px 12px;font-size:12px">${esc(j.type)}</span></div>`).join("")}</div>`;
    case "map": { var mq = encodeURIComponent(b.query||"東京駅"); return `<div style="border-radius:12px;overflow:hidden"><iframe style="width:100%;height:${b.height||360}px;border:0" src="https://maps.google.com/maps?q=${mq}&output=embed"></iframe></div>`; }
    case "form": {
      const fs = (b.fields && b.fields.length ? b.fields : []);
      const inputs = fs.map(f => {
        const ctrl = f.type === "textarea" ? `<textarea rows="3" disabled style="width:100%;padding:9px;border:1px solid #ccc;border-radius:8px"></textarea>` : `<input type="${f.type === "email" ? "email" : "text"}" disabled style="width:100%;padding:9px;border:1px solid #ccc;border-radius:8px">`;
        return `<div style="margin-bottom:10px;text-align:left"><label style="display:block;font-size:13px;margin-bottom:4px">${esc(f.label)}${f.required ? " *" : ""}</label>${ctrl}</div>`;
      }).join("");
      return `<div style="max-width:480px;margin:0 auto;text-align:${al}">${inputs}<button disabled style="background:${s.accent};color:#fff;border:0;padding:11px 26px;border-radius:8px;font-weight:600">${esc(b.submitLabel || "送信する")}</button><p style="font-size:11px;color:#999;margin-top:8px">※公開ページで実際に送信できます</p></div>`;
    }
    case "hero":
      var bg = b.img?`background:linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.35)),url('${esc(b.img)}') center/cover;`:`background:${b.bg};`;
      return `<div style="${bg}color:${b.color};padding:64px 28px;text-align:center;border-radius:10px"><h1 style="margin:0 0 10px;font-size:34px">${esc(b.title)}</h1><p style="margin:0 0 20px;font-size:17px;opacity:.92">${esc(b.sub)}</p>${b.btn?`<a href="${esc(b.href||"#")}" style="display:inline-block;padding:12px 28px;background:#fff;color:#222;border-radius:8px;text-decoration:none;font-weight:600">${esc(b.btn)}</a>`:""}</div>`;
  }
  return "";
}

function renderCanvas() {
  applySiteVars();
  const root = $("rootZone"); root.innerHTML = "";
  const blocks = curPage().blocks;
  if (blocks.length === 0) root.innerHTML = `<div class="empty-hint">パレットからドラッグ、クリックで追加、または右の「AIデザイン提案」で自動生成</div>`;
  blocks.forEach(b => root.appendChild(renderBlockEl(b)));
  setupZone(root, blocks);
  renderInspector();
}
function renderBlockEl(b) {
  const el = document.createElement("div");
  el.className = "blk" + (b.id === selectedId ? " selected" : "");
  el.dataset.id = b.id;
  const tools = document.createElement("div"); tools.className = "blk-tools";
  tools.innerHTML = `<button class="drag" draggable="true" title="移動">✥</button><button class="up" title="上へ">▲</button><button class="dn" title="下へ">▼</button><button class="dup" title="複製">⧉</button><button class="del" title="削除">✕</button>`;
  el.appendChild(tools);

  if (b.type === "columns") {
    const wrap = document.createElement("div"); wrap.className = "cols"; wrap.style.padding = "8px";
    b.cols.forEach(colArr => {
      const col = document.createElement("div"); col.className = "col dropzone";
      colArr.forEach(cb => col.appendChild(renderBlockEl(cb)));
      if (colArr.length === 0) { const h = document.createElement("div"); h.className = "empty-hint"; h.style.height = "80px"; h.style.margin = "0"; h.textContent = "ここにドロップ"; col.appendChild(h); }
      setupZone(col, colArr); wrap.appendChild(col);
    });
    el.appendChild(wrap);
  } else {
    const content = document.createElement("div"); content.style.padding = "10px 14px";
    content.innerHTML = blockInnerHTML(b);
    makeInline(content, b); el.appendChild(content);
  }
  el.addEventListener("click", e => { if (document.body.classList.contains("preview")) return; e.stopPropagation(); selectedId = b.id; refreshSelection(); renderInspector(); });
  tools.querySelector(".del").onclick = e => { e.stopPropagation(); removeBlock(b.id); renderCanvas(); scheduleSave(); };
  tools.querySelector(".dup").onclick = e => { e.stopPropagation(); dupBlock(b.id); renderCanvas(); scheduleSave(); };
  tools.querySelector(".up").onclick = e => { e.stopPropagation(); moveBlock(b.id, -1); renderCanvas(); scheduleSave(); };
  tools.querySelector(".dn").onclick = e => { e.stopPropagation(); moveBlock(b.id, 1); renderCanvas(); scheduleSave(); };
  const startMove = e => { dragState = { mode: "move", id: b.id }; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", b.id); };
  const endMove = () => { el.classList.remove("dragging"); clearDropLines(); dragState = null; };
  const dh = tools.querySelector(".drag");
  dh.addEventListener("dragstart", e => { e.stopPropagation(); startMove(e); });
  dh.addEventListener("dragend", endMove);
  // テキスト系以外はブロック本体を直接ドラッグ可能に（インライン編集を壊さない）
  if (!document.body.classList.contains("preview") && b.type !== "heading" && b.type !== "text") {
    el.setAttribute("draggable", "true");
    el.addEventListener("dragstart", e => { if (e.target.closest("[contenteditable=true],input,textarea,select,a,button")) { e.preventDefault(); return; } startMove(e); });
    el.addEventListener("dragend", endMove);
  }
  return el;
}
function makeInline(content, b) {
  if (document.body.classList.contains("preview") || !canEdit()) return;
  if (b.type === "heading") { const h = content.firstChild; h.setAttribute("contenteditable", "true"); h.addEventListener("blur", () => { b.text = h.textContent; scheduleSave(); }); h.addEventListener("click", e => e.stopPropagation()); }
  if (b.type === "text") { const d = content.firstChild; d.setAttribute("contenteditable", "true"); d.addEventListener("blur", () => { b.html = d.innerHTML; scheduleSave(); }); d.addEventListener("click", e => e.stopPropagation()); }
}
function refreshSelection() { document.querySelectorAll(".blk").forEach(el => el.classList.toggle("selected", el.dataset.id === selectedId)); }

/* ============ ドラッグ&ドロップ ============ */
let dragState = null;
function clearDropLines() { document.querySelectorAll(".drop-line").forEach(e => e.remove()); }
function setupZone(zone, list) {
  zone.addEventListener("dragover", e => { if (!dragState) return; e.preventDefault(); e.stopPropagation(); clearDropLines(); const after = getDragAfter(zone, e.clientY); const line = document.createElement("div"); line.className = "drop-line"; if (after == null) zone.appendChild(line); else zone.insertBefore(line, after); });
  zone.addEventListener("drop", e => {
    if (!dragState) return; e.preventDefault(); e.stopPropagation(); clearDropLines();
    const after = getDragAfter(zone, e.clientY);
    let idx = after == null ? list.length : list.indexOf(blockByEl(after)); if (idx < 0) idx = list.length;
    if (dragState.mode === "new") { const nb = BLOCKS[dragState.type].make(); list.splice(idx, 0, nb); selectedId = nb.id; }
    else if (dragState.mode === "move") { const r = findBlock(dragState.id); if (r) { const mv = r.block, same = r.list === list, oi = r.list.indexOf(mv); r.list.splice(oi, 1); if (same && oi < idx) idx--; list.splice(idx, 0, mv); } }
    dragState = null; renderCanvas(); scheduleSave();
  });
}
function blockByEl(el) { const id = el.dataset && el.dataset.id; return id ? findBlock(id).block : null; }
function getDragAfter(zone, y) { const els = [...zone.children].filter(c => c.classList && c.classList.contains("blk") && !c.classList.contains("dragging")); let cl = { off: -Infinity, el: null }; for (const el of els) { const box = el.getBoundingClientRect(); const off = y - box.top - box.height / 2; if (off < 0 && off > cl.off) cl = { off, el }; } return cl.el; }

/* ============ パレット ============ */
function renderPalette() {
  const p = $("palette"); p.innerHTML = "";
  Object.entries(BLOCKS).forEach(([k, def]) => {
    const it = document.createElement("div"); it.className = "pal-item"; it.draggable = true;
    it.innerHTML = `<span class="ic">${def.icon}</span><span>${def.label}</span>`;
    it.addEventListener("dragstart", e => { dragState = { mode: "new", type: k }; e.dataTransfer.effectAllowed = "copy"; });
    it.addEventListener("dragend", () => { clearDropLines(); dragState = null; });
    it.addEventListener("click", () => { const nb = def.make(); curPage().blocks.push(nb); selectedId = nb.id; renderCanvas(); scheduleSave(); });
    p.appendChild(it);
  });
}

/* ============ ページ一覧 ============ */
function renderPages() {
  const pl = $("pageList"); pl.innerHTML = "";
  PAGES.forEach((pg, i) => {
    const it = document.createElement("div"); it.className = "page-item" + (i === curIdx ? " active" : "");
    it.innerHTML = `<span style="flex:1">${esc(pg.name)}</span><span class="pa ren">✎</span><span class="pa del">✕</span>`;
    it.onclick = e => { if (e.target.classList.contains("ren") || e.target.classList.contains("del")) return; curIdx = i; selectedId = null; renderPages(); renderCanvas(); joinPage(); };
    it.querySelector(".ren").onclick = async e => { e.stopPropagation(); const n = prompt("ページ名", pg.name); if (n) { await api("PUT", `/api/pages/${pg.id}/name`, { name: n }); pg.name = n; renderPages(); } };
    it.querySelector(".del").onclick = async e => { e.stopPropagation(); if (PAGES.length <= 1) return toast("最後のページは削除できません", true); if (confirm(`「${pg.name}」を削除？`)) { await api("DELETE", `/api/pages/${pg.id}`); await refreshPagesKeepIdx(); } };
    pl.appendChild(it);
  });
}
$("btnAddPage").onclick = async () => {
  if (!canEdit()) return toast("権限がありません", true);
  const n = prompt("新しいページ名", "新規ページ"); if (!n) return;
  const { page } = await api("POST", "/api/pages", { name: n });
  await loadSite(); curIdx = PAGES.findIndex(p => p.id === page.id); selectedId = null; renderPages(); renderCanvas(); joinPage();
};

/* ============ インスペクター ============ */
function renderInspector() {
  const ins = $("inspector");
  if (!selectedId) { ins.innerHTML = `<div class="insp-empty">ブロックを選択すると<br>ここで詳細設定できます。</div>`; return; }
  const r = findBlock(selectedId); if (!r) { ins.innerHTML = ""; return; }
  const b = r.block; let h = "";
  const alignField = `<div class="field"><label>配置</label><div class="align-seg">${["left","center","right"].map(a => `<button data-f="align" data-v="${a}" class="${b.align===a?"active":""}">${a==="left"?"左":a==="center"?"中":"右"}</button>`).join("")}</div></div>`;
  switch (b.type) {
    case "heading": h = `<div class="field"><label>テキスト</label><input type="text" data-f="text" value="${esc(b.text)}"></div><div class="field"><label>レベル</label><select data-f="level">${["h1","h2","h3","h4"].map(l=>`<option ${b.level===l?"selected":""}>${l}</option>`).join("")}</select></div>${alignField}<div class="field"><label>文字色</label><input type="color" data-f="color" value="${b.color||"#111111"}"></div>`; break;
    case "text": h = `<div class="field"><label>本文（キャンバスで直接編集も可）</label><textarea data-f="html">${esc(b.html)}</textarea></div>${alignField}<div class="field row"><div><label>文字サイズ</label><input type="number" data-f="size" value="${b.size||16}"></div><div><label>色</label><input type="color" data-f="color" value="${b.color||"#111111"}"></div></div>`; break;
    case "image": h = `<div class="field"><label>画像URL</label><input type="url" data-f="src" value="${esc(b.src)}" placeholder="https://..."></div><div class="field"><label>代替テキスト</label><input type="text" data-f="alt" value="${esc(b.alt)}"></div><div class="field"><label>リンク先(任意)</label><input type="url" data-f="link" value="${esc(b.link||"")}"></div>${alignField}<div class="field row"><div><label>幅 %</label><input type="number" data-f="width" value="${b.width}"></div><div><label>角丸 px</label><input type="number" data-f="radius" value="${b.radius}"></div></div><div style="display:flex;gap:6px;margin-bottom:6px"><button class="tbtn" id="pickImg" style="flex:1">PCから選択</button><button class="tbtn" id="fromMedia" style="flex:1">メディアから</button></div><div class="ai-box" style="margin-bottom:0"><label style="font-size:11px;color:var(--muted)">✨ AIで画像生成</label><textarea id="imgPrompt" placeholder="例: 朝のカフェ、木のテーブルにラテ、自然光"></textarea><button class="tbtn ai" id="genImg" style="width:100%;margin-top:6px">この内容で画像を生成</button></div>`; break;
    case "button": h = `<div class="field"><label>ラベル</label><input type="text" data-f="text" value="${esc(b.text)}"></div><div class="field"><label>リンク先</label><input type="text" data-f="href" value="${esc(b.href)}"></div>${alignField}<div class="field row"><div><label>背景色</label><input type="color" data-f="bg" value="${b.bg||SITE.settings.accent}"></div><div><label>文字色</label><input type="color" data-f="color" value="${b.color||"#ffffff"}"></div></div><div class="field" style="background:var(--accent-soft);padding:8px;border-radius:8px"><label style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" data-f="cv" ${b.cv?"checked":""}> 🎯 クリックをコンバージョンとして計測</label></div>`; break;
    case "list": h = `<div class="field"><label>項目（改行区切り）</label><textarea data-f="items_lines">${esc(b.items.join("\n"))}</textarea></div><div class="field"><label>種類</label><select data-f="ordered"><option value="false" ${!b.ordered?"selected":""}>箇条書き</option><option value="true" ${b.ordered?"selected":""}>番号付き</option></select></div>${alignField}`; break;
    case "quote": h = `<div class="field"><label>引用文</label><textarea data-f="text">${esc(b.text)}</textarea></div><div class="field"><label>出典(任意)</label><input type="text" data-f="cite" value="${esc(b.cite||"")}"></div>`; break;
    case "divider": h = `<div class="field"><label>線の色</label><input type="color" data-f="color" value="${b.color}"></div>`; break;
    case "spacer": h = `<div class="field"><label>高さ px</label><input type="number" data-f="height" value="${b.height}"></div>`; break;
    case "video": h = `<div class="field"><label>動画URL（YouTube/Vimeo）</label><input type="url" data-f="url" value="${esc(b.url)}" placeholder="https://youtu.be/..."></div>`; break;
    case "html": h = `<div class="field"><label>HTMLコード</label><textarea data-f="code" style="min-height:160px">${esc(b.code)}</textarea></div>`; break;
    case "hero": h = `<div class="field"><label>タイトル</label><input type="text" data-f="title" value="${esc(b.title)}"></div><div class="field"><label>サブテキスト</label><input type="text" data-f="sub" value="${esc(b.sub)}"></div><div class="field"><label>ボタン文字</label><input type="text" data-f="btn" value="${esc(b.btn)}"></div><div class="field"><label>ボタンリンク</label><input type="text" data-f="href" value="${esc(b.href)}"></div><div class="field row"><div><label>背景色</label><input type="color" data-f="bg" value="${b.bg}"></div><div><label>文字色</label><input type="color" data-f="color" value="${b.color}"></div></div><div class="field"><label>背景画像URL(任意)</label><input type="url" data-f="img" value="${esc(b.img||"")}"></div>
        <div class="field" style="background:var(--accent-soft);padding:8px;border-radius:8px"><label style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><input type="checkbox" data-f="cv" ${b.cv?"checked":""}> 🎯 CTAクリックをコンバージョン計測</label>
        <label style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" data-f="ab" ${b.ab?"checked":""}> 🧪 A/Bテスト（タイトルを2案で出し分け）</label></div>
        <div class="field"><label>タイトル案B（A/B用）</label><input type="text" data-f="titleB" value="${esc(b.titleB||"")}" placeholder="もう一方のタイトル案"></div>`; break;
    case "columns": h = `<div class="field"><label>カラム数</label><select data-f="colcount">${[1,2,3,4].map(n=>`<option ${b.cols.length===n?"selected":""}>${n}</option>`).join("")}</select></div><p style="font-size:12px;color:var(--muted)">各カラムにブロックをドラッグして入れられます。</p>`; break;
    case "form": {
      const rows = b.fields.map((f, i) => `<div style="display:flex;gap:5px;margin-bottom:6px;align-items:center">
        <input type="text" class="ff-label" data-i="${i}" value="${esc(f.label)}" style="flex:1" placeholder="項目名">
        <select class="ff-type" data-i="${i}" style="width:88px"><option value="text" ${f.type==="text"?"selected":""}>テキスト</option><option value="email" ${f.type==="email"?"selected":""}>メール</option><option value="textarea" ${f.type==="textarea"?"selected":""}>複数行</option></select>
        <label style="font-size:11px;display:flex;align-items:center;gap:2px"><input type="checkbox" class="ff-req" data-i="${i}" ${f.required?"checked":""}>必須</label>
        <button class="ff-del" data-i="${i}" style="border:0;background:none;color:var(--danger);cursor:pointer">✕</button></div>`).join("");
      h = `${alignField}<div class="field"><label>入力項目</label>${rows}<button class="tbtn" id="ff-add" style="width:100%;margin-top:4px">＋ 項目を追加</button></div>
        <div class="field"><label>送信ボタンの文字</label><input type="text" data-f="submitLabel" value="${esc(b.submitLabel||"送信する")}"></div>
        <p style="font-size:11px;color:var(--muted)">送信内容は上部「📨 問い合わせ」で確認できます（公開後）。</p>`;
      break;
    }
    case "cta": h = `<div class="field"><label>見出し</label><input type="text" data-f="title" value="${esc(b.title)}"></div>
      <div class="field"><label>サブ</label><input type="text" data-f="sub" value="${esc(b.sub)}"></div>
      <div class="field"><label>ボタン文字</label><input type="text" data-f="btn" value="${esc(b.btn)}"></div>
      <div class="field"><label>リンク先</label><input type="text" data-f="href" value="${esc(b.href)}"></div>
      <div class="field row"><div><label>背景色</label><input type="color" data-f="bg" value="${b.bg||SITE.settings.accent}"></div><div><label>文字色</label><input type="color" data-f="color" value="${b.color||"#ffffff"}"></div></div>
      <div class="field"><label style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" data-f="cv" ${b.cv?"checked":""}> 🎯 クリックをCV計測</label></div>`; break;
    case "faq": h = `<div class="field"><label>FAQ（1行に「質問｜回答」）</label><textarea id="cfg_faq" style="min-height:140px">${esc(b.items.map(i=>`${i.q}｜${i.a}`).join("\n"))}</textarea></div>`; break;
    case "pricing": h = `<div class="field"><label>料金プラン（「名前｜価格｜特徴,特徴｜*(おすすめ)」）</label><textarea id="cfg_pricing" style="min-height:140px">${esc(b.plans.map(p=>`${p.name}｜${p.price}｜${(p.features||[]).join(",")}${p.featured?"｜*":""}`).join("\n"))}</textarea></div>`; break;
    case "stats": h = `<div class="field"><label>実績（1行に「数値｜ラベル」）</label><textarea id="cfg_stats" style="min-height:120px">${esc(b.items.map(i=>`${i.num}｜${i.label}`).join("\n"))}</textarea></div>`; break;
    case "team": h = `<div class="field"><label>スタッフ（「名前｜役職｜画像URL」）</label><textarea id="cfg_team" style="min-height:120px">${esc(b.members.map(m=>`${m.name}｜${m.role}｜${m.img||""}`).join("\n"))}</textarea></div>`; break;
    case "jobs": h = `<div class="field"><label>求人（「職種｜雇用形態｜説明」）</label><textarea id="cfg_jobs" style="min-height:120px">${esc(b.items.map(j=>`${j.title}｜${j.type}｜${j.desc}`).join("\n"))}</textarea></div>`; break;
    case "map": h = `<div class="field"><label>地図の地名・住所</label><input type="text" data-f="query" value="${esc(b.query)}" placeholder="例: 東京都渋谷区..."></div><div class="field"><label>高さ px</label><input type="number" data-f="height" value="${b.height||360}"></div>`; break;
  }
  h += `<div class="hr"></div><button class="tbtn" id="insDel" style="width:100%;border-color:var(--danger);color:var(--danger)">このブロックを削除</button>`;
  ins.innerHTML = h;
  ins.querySelectorAll("[data-f]").forEach(inp => {
    const f = inp.dataset.f;
    if (inp.dataset.v !== undefined) { inp.onclick = () => { b[f] = inp.dataset.v; renderCanvas(); scheduleSave(); }; return; }
    const ev = (inp.tagName === "SELECT" || inp.type === "checkbox") ? "change" : "input";
    inp.addEventListener(ev, () => {
      let v = inp.type === "checkbox" ? inp.checked : inp.value;
      if (f === "items_lines") { b.items = v.split("\n").filter(x => x !== ""); renderCanvas(); scheduleSave(); return; }
      if (f === "ordered") { b.ordered = v === "true"; renderCanvas(); scheduleSave(); return; }
      if (f === "colcount") { adjustCols(b, parseInt(v)); renderCanvas(); scheduleSave(); return; }
      if (["size","width","radius","height"].includes(f)) v = parseInt(v) || 0;
      b[f] = v; renderCanvas(); scheduleSave();
    });
  });
  const del = ins.querySelector("#insDel"); if (del) del.onclick = () => { removeBlock(selectedId); renderCanvas(); scheduleSave(); };
  const pick = ins.querySelector("#pickImg"); if (pick) pick.onclick = () => pickImage(b);
  const gen = ins.querySelector("#genImg"); if (gen) gen.onclick = () => genImageInto(b, ins.querySelector("#imgPrompt").value, gen);
  const fromMedia = ins.querySelector("#fromMedia"); if (fromMedia) fromMedia.onclick = () => openMedia(b);
  // フォーム項目編集
  if (b.type === "form") {
    ins.querySelectorAll(".ff-label").forEach(el => el.oninput = () => { b.fields[+el.dataset.i].label = el.value; renderCanvas(); scheduleSave(); });
    ins.querySelectorAll(".ff-type").forEach(el => el.onchange = () => { b.fields[+el.dataset.i].type = el.value; renderCanvas(); scheduleSave(); });
    ins.querySelectorAll(".ff-req").forEach(el => el.onchange = () => { b.fields[+el.dataset.i].required = el.checked; scheduleSave(); });
    ins.querySelectorAll(".ff-del").forEach(el => el.onclick = () => { b.fields.splice(+el.dataset.i, 1); renderCanvas(); scheduleSave(); });
    const add = ins.querySelector("#ff-add"); if (add) add.onclick = () => { b.fields.push({ label: "新しい項目", type: "text", required: false }); renderCanvas(); scheduleSave(); };
  }
  // 構造化テキストエリア（行＝アイテム、｜区切り）
  const cfgBind = (id, parse) => { const el = ins.querySelector("#" + id); if (el) el.oninput = () => { parse(el.value.split("\n").filter(l => l.trim() !== "").map(l => l.split("｜"))); renderCanvas(); scheduleSave(); }; };
  cfgBind("cfg_faq", rows => b.items = rows.map(c => ({ q: c[0] || "", a: c[1] || "" })));
  cfgBind("cfg_pricing", rows => b.plans = rows.map(c => ({ name: c[0] || "", price: c[1] || "", features: (c[2] || "").split(",").map(x => x.trim()).filter(Boolean), featured: (c[3] || "").includes("*") })));
  cfgBind("cfg_stats", rows => b.items = rows.map(c => ({ num: c[0] || "", label: c[1] || "" })));
  cfgBind("cfg_team", rows => b.members = rows.map(c => ({ name: c[0] || "", role: c[1] || "", img: c[2] || "" })));
  cfgBind("cfg_jobs", rows => b.items = rows.map(c => ({ title: c[0] || "", type: c[1] || "", desc: c[2] || "" })));
}
function adjustCols(b, n) { while (b.cols.length < n) b.cols.push([]); while (b.cols.length > n) { const last = b.cols.pop(); b.cols[0] = b.cols[0].concat(last); } }
function pickImage(b) {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
  inp.onchange = () => { const f = inp.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { b.src = rd.result; renderCanvas(); scheduleSave(); toast("画像を埋め込みました"); }; rd.readAsDataURL(f); };
  inp.click();
}
async function genImageInto(b, prompt, btn) {
  if (!prompt) return toast("生成内容を入力してください", true);
  btn.innerHTML = `<span class="spin"></span> 生成中…`; btn.disabled = true;
  try { const { dataUrl } = await api("POST", "/api/ai/image", { prompt }); b.src = dataUrl; renderCanvas(); scheduleSave(); toast("画像を生成しました"); }
  catch (e) { toast(e.message, true); btn.innerHTML = "この内容で画像を生成"; btn.disabled = false; }
}

/* ============ AIデザイン提案 ============ */
$("aiDesignBtn").onclick = async () => {
  const instruction = $("aiDesignPrompt").value.trim(); if (!instruction) return toast("要望を入力してください", true);
  const btn = $("aiDesignBtn"); btn.innerHTML = `<span class="spin"></span> 生成中…`; btn.disabled = true;
  $("aiDesignOut").textContent = "";
  try {
    const { blocks, note } = await api("POST", "/api/ai/design", { instruction, currentBlocks: curPage().blocks, siteTitle: SITE.settings.siteTitle });
    blocks.forEach(reId);
    openModal(`<h2>✨ AI提案（${blocks.length}ブロック）</h2><p style="font-size:13px;color:var(--muted)">${esc(note)}</p>
      <div class="modal-actions"><button class="tbtn" onclick="closeModal()">キャンセル</button>
      <button class="tbtn" id="aiAppend">末尾に追加</button>
      <button class="tbtn primary" id="aiReplace">現在のページを置き換え</button></div>`);
    $("aiAppend").onclick = () => { curPage().blocks.push(...blocks); afterAI(); };
    $("aiReplace").onclick = () => { curPage().blocks = blocks; afterAI(); };
  } catch (e) { $("aiDesignOut").textContent = "エラー: " + e.message; }
  btn.innerHTML = "構成を生成"; btn.disabled = false;
};
function afterAI() { closeModal(); selectedId = null; renderCanvas(); scheduleSave(); toast("AI提案を反映しました"); }
$("aiAdviceBtn").onclick = async () => {
  const instruction = $("aiDesignPrompt").value.trim() || "このページのデザインを改善する助言をください";
  $("aiDesignOut").innerHTML = `<span class="spin"></span> 考え中…`;
  try { const { text } = await api("POST", "/api/ai/advice", { instruction, context: JSON.stringify(curPage().blocks) }); $("aiDesignOut").textContent = text; }
  catch (e) { $("aiDesignOut").textContent = "エラー: " + e.message; }
};

/* ============ 参考URL取込 ============ */
$("aiUrlBtn").onclick = async () => {
  const url = $("aiUrl").value.trim(); if (!url) return toast("URLを入力してください", true);
  const btn = $("aiUrlBtn"); btn.innerHTML = `<span class="spin"></span> 取込中…`; btn.disabled = true; $("aiUrlOut").textContent = "";
  try {
    const { blocks, note, accent } = await api("POST", "/api/ai/import-url", { url });
    blocks.forEach(reId);
    openModal(`<h2>🔗 取込結果（${blocks.length}ブロック）</h2><p style="font-size:13px;color:var(--muted)">${esc(note)}</p>
      ${accent ? `<p style="font-size:13px">推奨アクセント色: <span style="display:inline-block;width:14px;height:14px;background:${esc(accent)};border-radius:3px;vertical-align:-2px"></span> ${esc(accent)}</p>` : ""}
      <div class="modal-actions"><button class="tbtn" onclick="closeModal()">キャンセル</button>
      <button class="tbtn" id="iuAppend">末尾に追加</button>
      <button class="tbtn primary" id="iuReplace">置き換え${accent ? "＋配色適用" : ""}</button></div>`);
    const applyAccent = async () => { if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) { SITE.settings.accent = accent; await api("PUT", "/api/site/settings", { settings: SITE.settings }); } };
    $("iuAppend").onclick = () => { curPage().blocks.push(...blocks); afterAI(); };
    $("iuReplace").onclick = async () => { curPage().blocks = blocks; await applyAccent(); afterAI(); };
  } catch (e) { $("aiUrlOut").textContent = "エラー: " + e.message; }
  btn.innerHTML = "構成を取り込む"; btn.disabled = false;
};

/* ============ テンプレート集 ============ */
const TEMPLATES = {
  "コーポレート": [
    { type:"hero", title:"信頼を、かたちに。", sub:"私たちは〇〇分野で社会に貢献します", btn:"会社案内", href:"#", bg:"#1f2937", color:"#fff", img:"" },
    { type:"heading", text:"事業内容", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"コンサルティング",level:"h3",align:"center"},{type:"text",html:"課題を整理し最適な解決策をご提案します。",align:"center",size:14}],
      [{type:"heading",text:"開発",level:"h3",align:"center"},{type:"text",html:"確かな技術で形にします。",align:"center",size:14}],
      [{type:"heading",text:"サポート",level:"h3",align:"center"},{type:"text",html:"導入後も継続的に支援します。",align:"center",size:14}] ]},
    { type:"button", text:"お問い合わせ", href:"#contact", align:"center" } ],
  "飲食店": [
    { type:"hero", title:"こだわりの一皿を、あなたへ。", sub:"地元食材を活かした季節のメニュー", btn:"メニューを見る", href:"#", bg:"#b45309", color:"#fff", img:"" },
    { type:"heading", text:"おすすめメニュー", level:"h2", align:"center" },
    { type:"text", html:"旬の食材を使った料理を毎月ご用意しています。", align:"center", size:16 },
    { type:"divider" },
    { type:"heading", text:"ご予約", level:"h2", align:"center" },
    { type:"form", align:"center", submitLabel:"予約を申し込む", fields:[{label:"お名前",type:"text",required:true},{label:"電話番号",type:"text",required:true},{label:"ご希望日時",type:"text",required:true},{label:"備考",type:"textarea",required:false}] } ],
  "ポートフォリオ": [
    { type:"hero", title:"作品集", sub:"デザイナー / 〇〇 〇〇", btn:"お問い合わせ", href:"#contact", bg:"#0f766e", color:"#fff", img:"" },
    { type:"heading", text:"Works", level:"h2", align:"left" },
    { type:"columns", cols:[
      [{type:"image",src:"",alt:"作品1",width:100,radius:8,align:"center"},{type:"text",html:"プロジェクト1の説明",align:"center",size:13}],
      [{type:"image",src:"",alt:"作品2",width:100,radius:8,align:"center"},{type:"text",html:"プロジェクト2の説明",align:"center",size:13}] ]},
    { type:"quote", text:"丁寧なものづくりを大切にしています。", cite:"" } ],
  "LP（ランディングページ）": [
    { type:"hero", title:"その悩み、これで解決。", sub:"今だけ初回無料キャンペーン実施中", btn:"無料で試す", href:"#cta", bg:"#f97316", color:"#fff", img:"", ab:false },
    { type:"stats", items:[{num:"10,000+",label:"導入実績"},{num:"98%",label:"満足度"},{num:"24h",label:"サポート"}] },
    { type:"heading", text:"選ばれる3つの理由", level:"h2", align:"center" },
    { type:"list", items:["かんたん導入で即日スタート","専任スタッフが手厚くサポート","満足度98%の実績"], ordered:false, align:"center" },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"導入にどれくらいかかりますか？",a:"最短即日でご利用いただけます。"},{q:"解約はいつでもできますか？",a:"はい、いつでも可能です。"}] },
    { type:"cta", title:"今すぐ始めましょう", sub:"初回無料でお試しいただけます", btn:"無料で申し込む", href:"#cta", bg:"", color:"#fff", cv:true } ],
  "採用サイト": [
    { type:"hero", title:"一緒に未来をつくる仲間を募集中。", sub:"あなたの挑戦を歓迎します", btn:"募集要項を見る", href:"#jobs", bg:"#0f766e", color:"#fff", img:"" },
    { type:"heading", text:"数字で見る私たち", level:"h2", align:"center" },
    { type:"stats", items:[{num:"45名",label:"在籍社員"},{num:"30%",label:"年成長率"},{num:"4.6",label:"社員満足度"}] },
    { type:"heading", text:"募集職種", level:"h2", align:"center" },
    { type:"jobs", items:[{title:"Webエンジニア",type:"正社員",desc:"モダンな技術スタックで開発"},{title:"デザイナー",type:"正社員",desc:"UI/UXを一気通貫で"},{title:"カスタマーサクセス",type:"契約",desc:"顧客の成功を伴走支援"}] },
    { type:"heading", text:"社員紹介", level:"h2", align:"center" },
    { type:"team", members:[{name:"山田 太郎",role:"エンジニア",img:""},{name:"佐藤 花子",role:"デザイナー",img:""}] },
    { type:"cta", title:"あなたの応募をお待ちしています", sub:"カジュアル面談も歓迎です", btn:"応募する", href:"#apply", bg:"", color:"#fff", cv:true } ],
  "美容室": [
    { type:"hero", title:"なりたいを、かなえる。", sub:"あなたに似合うを一緒に見つけます", btn:"ご予約はこちら", href:"#reserve", bg:"#9d174d", color:"#fff", img:"" },
    { type:"heading", text:"メニュー・料金", level:"h2", align:"center" },
    { type:"pricing", plans:[{name:"カット",price:"¥4,400",features:["シャンプー込","スタイリング"],featured:false},{name:"カラー+カット",price:"¥9,900",features:["人気No.1","トリートメント付"],featured:true},{name:"パーマ+カット",price:"¥11,000",features:["デジタルパーマ可"],featured:false}] },
    { type:"heading", text:"スタイリスト", level:"h2", align:"center" },
    { type:"team", members:[{name:"鈴木 美咲",role:"店長",img:""},{name:"高橋 健",role:"スタイリスト",img:""}] },
    { type:"heading", text:"アクセス", level:"h2", align:"center" },
    { type:"map", query:"東京都渋谷区", height:320 },
    { type:"cta", title:"ご予約はお気軽に", sub:"24時間オンライン受付中", btn:"予約する", href:"#reserve", bg:"", color:"#fff", cv:true } ],
  "クリニック・歯科": [
    { type:"hero", title:"地域のかかりつけ医として。", sub:"安心と信頼の医療をお届けします", btn:"WEB予約", href:"#reserve", bg:"#0369a1", color:"#fff" },
    { type:"stats", items:[{num:"30年",label:"地域医療"},{num:"5万件",label:"診療実績"},{num:"土日",label:"診療対応"}] },
    { type:"heading", text:"診療科目", level:"h2", align:"center" },
    { type:"list", items:["一般内科","小児科","予防接種・健診","オンライン診療"], ordered:false, align:"center" },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"予約は必要ですか？",a:"WEB予約と当日受付の両方に対応しています。"},{q:"駐車場はありますか？",a:"10台分ご用意しています。"}] },
    { type:"heading", text:"アクセス", level:"h2", align:"center" },
    { type:"map", query:"東京都新宿区", height:320 },
    { type:"cta", title:"ご予約・お問い合わせ", sub:"お気軽にご連絡ください", btn:"WEB予約する", href:"#reserve", bg:"", color:"#fff", cv:true } ],
  "不動産": [
    { type:"hero", title:"理想の住まい、見つかる。", sub:"地域密着で最適な物件をご提案", btn:"物件を探す", href:"#", bg:"#166534", color:"#fff" },
    { type:"stats", items:[{num:"2,000件",label:"取扱物件"},{num:"98%",label:"成約満足度"},{num:"無料",label:"住宅ローン相談"}] },
    { type:"heading", text:"サービス", level:"h2", align:"center" },
    { type:"columns", cols:[[{type:"heading",text:"売買",level:"h3",align:"center"},{type:"text",html:"はじめての売買も安心サポート",align:"center",size:14}],[{type:"heading",text:"賃貸",level:"h3",align:"center"},{type:"text",html:"豊富な物件からお探しします",align:"center",size:14}],[{type:"heading",text:"管理",level:"h3",align:"center"},{type:"text",html:"オーナー様の資産を最大化",align:"center",size:14}]] },
    { type:"cta", title:"無料査定・ご相談はこちら", sub:"オンライン相談も可能です", btn:"無料相談", href:"#contact", bg:"", color:"#fff", cv:true } ],
  "ジム・フィットネス": [
    { type:"hero", title:"なりたい自分に、最短で。", sub:"専属トレーナーが目標達成まで伴走", btn:"無料体験を予約", href:"#trial", bg:"#b91c1c", color:"#fff" },
    { type:"stats", items:[{num:"-8kg",label:"平均減量"},{num:"24h",label:"営業時間"},{num:"95%",label:"継続率"}] },
    { type:"heading", text:"料金プラン", level:"h2", align:"center" },
    { type:"pricing", plans:[{name:"月4回",price:"¥19,800",features:["食事サポート"],featured:false},{name:"月8回",price:"¥34,800",features:["人気No.1","食事＋トレーニング"],featured:true},{name:"通い放題",price:"¥49,800",features:["最短で結果を"],featured:false}] },
    { type:"cta", title:"まずは無料体験から", sub:"手ぶらでOK", btn:"体験を予約する", href:"#trial", bg:"", color:"#fff", cv:true } ],
  "学習塾・スクール": [
    { type:"hero", title:"「わかる」を、「できる」に。", sub:"一人ひとりに最適な学びを", btn:"無料体験授業", href:"#trial", bg:"#7c3aed", color:"#fff" },
    { type:"stats", items:[{num:"合格率",label:"第一志望92%"},{num:"1対2",label:"個別指導"},{num:"全学年",label:"対応"}] },
    { type:"heading", text:"コース", level:"h2", align:"center" },
    { type:"list", items:["小学生コース","中学生コース","高校・大学受験コース","オンライン受講"], ordered:false, align:"center" },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"途中入塾は可能ですか？",a:"いつでも可能です。学習状況に合わせて開始します。"}] },
    { type:"cta", title:"無料体験授業 受付中", sub:"まずはお気軽に", btn:"申し込む", href:"#trial", bg:"", color:"#fff", cv:true } ],
  "士業（法律・会計）": [
    { type:"hero", title:"あなたの課題に、専門家の力を。", sub:"初回相談無料・秘密厳守", btn:"無料相談を予約", href:"#contact", bg:"#1e3a8a", color:"#fff" },
    { type:"heading", text:"取扱業務", level:"h2", align:"center" },
    { type:"columns", cols:[[{type:"heading",text:"相続・遺言",level:"h3",align:"center"},{type:"text",html:"円満な相続をサポート",align:"center",size:14}],[{type:"heading",text:"企業法務",level:"h3",align:"center"},{type:"text",html:"契約・労務を総合支援",align:"center",size:14}]] },
    { type:"stats", items:[{num:"3,000件",label:"相談実績"},{num:"20年",label:"経験"},{num:"初回無料",label:"相談"}] },
    { type:"cta", title:"まずは無料相談から", sub:"オンライン対応可", btn:"相談を予約", href:"#contact", bg:"", color:"#fff", cv:true } ],
  "ECショップ": [
    { type:"hero", title:"こだわりを、あなたの暮らしへ。", sub:"厳選した商品をお届けします", btn:"商品を見る", href:"#", bg:"#9a3412", color:"#fff" },
    { type:"heading", text:"人気商品", level:"h2", align:"center" },
    { type:"columns", cols:[[{type:"image",src:"",alt:"商品1",width:100,radius:8,align:"center"},{type:"text",html:"商品名 ¥3,200",align:"center",size:14}],[{type:"image",src:"",alt:"商品2",width:100,radius:8,align:"center"},{type:"text",html:"商品名 ¥4,800",align:"center",size:14}],[{type:"image",src:"",alt:"商品3",width:100,radius:8,align:"center"},{type:"text",html:"商品名 ¥2,500",align:"center",size:14}]] },
    { type:"stats", items:[{num:"送料無料",label:"5,000円以上"},{num:"4.7",label:"レビュー評価"},{num:"即日",label:"発送"}] },
    { type:"cta", title:"今すぐショップへ", sub:"新規会員10%OFF", btn:"買い物をはじめる", href:"#", bg:"", color:"#fff", cv:true } ],
  "ホテル・宿泊": [
    { type:"hero", title:"非日常の、特別なひととき。", sub:"心からのおもてなしをお約束します", btn:"空室を確認", href:"#reserve", bg:"#3f3f46", color:"#fff" },
    { type:"heading", text:"客室・プラン", level:"h2", align:"center" },
    { type:"pricing", plans:[{name:"スタンダード",price:"¥12,000〜",features:["素泊まり"],featured:false},{name:"スイート",price:"¥28,000〜",features:["人気","朝食付・温泉"],featured:true}] },
    { type:"heading", text:"アクセス", level:"h2", align:"center" },
    { type:"map", query:"箱根", height:320 },
    { type:"cta", title:"ご予約はこちら", sub:"24時間オンライン受付", btn:"予約する", href:"#reserve", bg:"", color:"#fff", cv:true } ],
  "イベント・セミナー": [
    { type:"hero", title:"その学びが、未来を変える。", sub:"2026年7月1日（土）開催", btn:"参加を申し込む", href:"#apply", bg:"#be185d", color:"#fff" },
    { type:"stats", items:[{num:"500名",label:"定員"},{num:"無料",label:"参加費"},{num:"オンライン",label:"同時配信"}] },
    { type:"heading", text:"登壇者", level:"h2", align:"center" },
    { type:"team", members:[{name:"登壇者A",role:"基調講演",img:""},{name:"登壇者B",role:"パネリスト",img:""}] },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"アーカイブ配信はありますか？",a:"申込者には後日録画をお送りします。"}] },
    { type:"cta", title:"お席に限りがあります", sub:"今すぐお申し込みを", btn:"参加申込", href:"#apply", bg:"", color:"#fff", cv:true } ],
};
const TEMPLATE_ICONS = { "LP（ランディングページ）": "🚀", "採用サイト": "💼", "美容室": "💇", "コーポレート": "🏢", "飲食店": "🍴", "ポートフォリオ": "🎨", "クリニック・歯科": "🏥", "不動産": "🏠", "ジム・フィットネス": "💪", "学習塾・スクール": "📚", "士業（法律・会計）": "⚖", "ECショップ": "🛒", "ホテル・宿泊": "🏨", "イベント・セミナー": "🎤" };
$("btnTemplates").onclick = () => {
  const cards = Object.keys(TEMPLATES).map(name => `<button class="tpl-card tpl" data-name="${esc(name)}">
    <span class="tpl-ico">${TEMPLATE_ICONS[name] || "📄"}</span><b>${esc(name)}</b>
    <span style="font-size:11px;color:var(--muted)">${TEMPLATES[name].length}ブロック</span></button>`).join("");
  openPage(`<h2>📋 テンプレートから始める</h2><p style="font-size:13px;color:var(--muted)">業種を選ぶと完成済みレイアウトを適用します（現在のページは置き換わります）。</p>
    <div class="tpl-grid">${cards}</div>`);
  $("modalBox").querySelectorAll(".tpl").forEach(b => b.onclick = () => {
    if (!confirm(`「${b.dataset.name}」を適用しますか？現在のページ内容は置き換わります。`)) return;
    const blocks = JSON.parse(JSON.stringify(TEMPLATES[b.dataset.name])); blocks.forEach(reId);
    curPage().blocks = blocks; closeModal(); selectedId = null; renderCanvas(); scheduleSave(); toast("テンプレートを適用しました");
  });
};

/* ============ メディアライブラリ ============ */
async function openMedia(targetBlock) {
  const { assets } = await api("GET", "/api/media");
  const grid = assets.length ? assets.map(a => `<div class="media-item" data-id="${a.id}" style="position:relative">
    <img src="${a.data}" data-src="${a.id}" style="width:100%;height:90px;object-fit:cover;border-radius:8px;cursor:pointer;border:1px solid var(--border)">
    <button class="media-del" data-id="${a.id}" title="削除" style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,.6);color:#fff;border:0;border-radius:6px;width:22px;height:22px;cursor:pointer">✕</button></div>`).join("")
    : `<p style="color:var(--muted);font-size:13px;grid-column:1/-1">まだ画像がありません。AI生成やアップロードで追加できます。</p>`;
  openPage(`<h2>🖼 メディアライブラリ</h2>
    <button class="tbtn" id="mediaUpload" style="margin-bottom:10px">＋ 画像をアップロード</button>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${grid}</div>
    <div class="modal-actions"><button class="tbtn" onclick="closeModal()">閉じる</button></div>`);
  $("mediaUpload").onclick = () => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
    inp.onchange = () => { const f = inp.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = async () => { await api("POST", "/api/media", { data: rd.result, filename: f.name }); openMedia(targetBlock); }; rd.readAsDataURL(f); };
    inp.click();
  };
  $("modalBox").querySelectorAll("img[data-src]").forEach(img => img.onclick = () => {
    if (targetBlock) { targetBlock.src = img.src; renderCanvas(); scheduleSave(); closeModal(); toast("画像を設定しました"); }
  });
  $("modalBox").querySelectorAll(".media-del").forEach(b => b.onclick = async (e) => { e.stopPropagation(); if (confirm("削除しますか？")) { await api("DELETE", `/api/media/${b.dataset.id}`); openMedia(targetBlock); } });
}
$("btnMedia").onclick = () => openMedia(null);

/* ============ SEO設定（ページ単位） ============ */
function computeSeoScore(page) {
  const m = page.meta || {}; const blocks = page.blocks || [];
  const flat = []; const walk = a => a.forEach(b => { flat.push(b); if (b.type === "columns") b.cols.forEach(walk); });
  walk(blocks);
  const text = blocksToTextClient(blocks);
  const imgs = flat.filter(b => b.type === "image");
  const imgsWithAlt = imgs.filter(b => (b.alt || "").trim());
  const hasHeading = flat.some(b => b.type === "heading" || b.type === "hero");
  const hasInternal = flat.some(b => /href/i.test(JSON.stringify(b)) && /["'](#|\/)/.test(JSON.stringify(b)));
  const checks = [
    { ok: !!(m.title || "").trim(), w: 20, label: "ページタイトルを設定" },
    { ok: (m.description || "").trim().length >= 40, w: 20, label: "ディスクリプションを80字程度で設定" },
    { ok: hasHeading, w: 15, label: "見出し（H/ヒーロー）を配置" },
    { ok: imgs.length === 0 || imgsWithAlt.length === imgs.length, w: 15, label: "画像のalt（代替テキスト）を設定" },
    { ok: hasInternal, w: 10, label: "内部リンク（ボタン等）を設置" },
    { ok: text.length >= 120, w: 20, label: "本文を十分な量（120字以上）にする" },
  ];
  const score = checks.filter(c => c.ok).reduce((a, c) => a + c.w, 0);
  return { score, missing: checks.filter(c => !c.ok) };
}
function blocksToTextClient(blocks) {
  const out = []; const walk = a => a.forEach(b => {
    if (b.type === "heading" || b.type === "button") out.push(b.text || "");
    if (b.type === "hero" || b.type === "cta") out.push((b.title || "") + (b.sub || ""));
    if (b.type === "text") out.push(String(b.html || "").replace(/<[^>]+>/g, ""));
    if (b.type === "quote") out.push(b.text || "");
    if (b.type === "list") out.push((b.items || []).join(""));
    if (b.type === "faq") out.push((b.items || []).map(i => i.q + i.a).join(""));
    if (b.type === "columns") b.cols.forEach(walk);
  }); walk(blocks || []); return out.join("");
}
$("btnSEO").onclick = () => {
  const p = curPage(); const m = p.meta || {};
  const sc = computeSeoScore(p);
  const color = sc.score >= 80 ? "var(--ok)" : sc.score >= 50 ? "var(--accent)" : "var(--danger)";
  const scoreHtml = `<div class="seo-score-ring"><div class="seo-num" style="color:${color}">${sc.score}<span style="font-size:16px;color:var(--muted)">点</span></div>
    <div style="flex:1">${sc.missing.length ? `<div style="font-size:12px;color:var(--muted);margin-bottom:4px">改善項目</div>${sc.missing.map(x => `<div style="font-size:13px;color:var(--danger)">・${x.label}</div>`).join("")}` : `<div style="color:var(--ok);font-weight:600">✓ 主要なSEO項目を満たしています</div>`}</div></div>`;
  openPage(`<h2>🔍 SEO診断・設定 — ${esc(p.name)}</h2>${scoreHtml}<div class="hr"></div><div class="settings-grid">
    <label>ページタイトル（検索結果の見出し）</label><input id="seo_title" value="${esc(m.title || "")}" placeholder="${esc(p.name)} | ${esc(SITE.settings.siteTitle)}">
    <label>ディスクリプション（検索結果の説明文・120字程度）</label><input id="seo_desc" value="${esc(m.description || "")}">
    <label>OGP画像URL（SNSシェア時の画像）</label><input id="seo_og" value="${esc(m.ogImage || "")}" placeholder="https://...">
  </div><div class="modal-actions"><button class="tbtn ai" id="seo_ai">✨ AIで提案</button><button class="tbtn" onclick="closeModal()">閉じる</button><button class="tbtn primary" id="seo_save">保存</button></div>`);
  $("seo_ai").onclick = async () => {
    const btn = $("seo_ai"); btn.innerHTML = `<span class="spin"></span>`; btn.disabled = true;
    try { const r = await api("POST", "/api/ai/seo", { pageId: p.id }); if (r.title) $("seo_title").value = r.title; if (r.description) $("seo_desc").value = r.description; toast("AIが提案しました"); }
    catch (e) { toast(e.message, true); }
    btn.innerHTML = "✨ AIで提案"; btn.disabled = false;
  };
  $("seo_save").onclick = async () => {
    p.meta = { title: $("seo_title").value, description: $("seo_desc").value, ogImage: $("seo_og").value };
    await api("PUT", `/api/pages/${p.id}/meta`, { meta: p.meta });
    closeModal(); toast("SEO設定を保存しました");
  };
};

/* ============ 問い合わせ受信一覧 ============ */
// フィールド名から「名前/電話/メール/内容」を推定して一元表示
function pickField(data, keywords) {
  for (const [k, v] of Object.entries(data)) { const key = k.replace(/^f_\d+_/, ""); if (keywords.some(w => key.includes(w))) return v; }
  return "";
}
function otherFields(data, used) {
  return Object.entries(data).filter(([k]) => { const key = k.replace(/^f_\d+_/, ""); return !used.some(w => key.includes(w)); })
    .map(([k, v]) => `${k.replace(/^f_\d+_/, "")}: ${v}`).join(" / ");
}
$("btnForms").onclick = async () => {
  const { submissions } = await api("GET", "/api/forms");
  const STATUSES = ["未対応", "対応中", "完了"];
  const counts = STATUSES.map(st => submissions.filter(s => (s.status || "未対応") === st).length);
  const used = ["名前", "氏名", "お名前", "電話", "TEL", "tel", "メール", "mail", "Mail", "内容", "相談", "本文", "メッセージ", "問い合わせ", "お問い合わせ"];
  const rows = submissions.length ? submissions.map(s => {
    const cur = s.status || "未対応";
    const name = pickField(s.data, ["名前", "氏名"]) || "—";
    const tel = pickField(s.data, ["電話", "TEL", "tel"]) || "";
    const mail = pickField(s.data, ["メール", "mail", "Mail"]) || "";
    const content = pickField(s.data, ["内容", "相談", "本文", "メッセージ", "問い合わせ"]) || "";
    const other = otherFields(s.data, used);
    const contactCell = `${tel ? `📞 ${esc(tel)}<br>` : ""}${mail ? `✉ ${esc(mail)}` : ""}` || "—";
    const sel = `<select class="crm-sel crm-${cur} ssel" data-id="${s.id}">${STATUSES.map(st => `<option ${st === cur ? "selected" : ""}>${st}</option>`).join("")}</select>`;
    return `<tr>
      <td style="white-space:nowrap;color:var(--muted);font-size:11px">${new Date(s.created_at).toLocaleString("ja-JP")}</td>
      <td style="font-weight:600">${esc(name)}</td>
      <td style="font-size:12px">${contactCell}</td>
      <td style="font-size:12px;max-width:280px">${esc(content)}${other ? `<div style="color:var(--muted);margin-top:3px">${esc(other)}</div>` : ""}</td>
      <td>${sel}</td>
      <td><button class="tbtn sdel" data-id="${s.id}" style="padding:2px 8px;border-color:var(--danger);color:var(--danger)">削除</button></td></tr>`;
  }).join("") : `<tr><td colspan="6" style="color:var(--muted)">まだ受信はありません。</td></tr>`;
  openPage(`<h2>📨 問い合わせ管理（${submissions.length}件）</h2>
    <div style="display:flex;gap:10px;margin-bottom:14px">${STATUSES.map((st, i) => `<div style="flex:1;background:var(--panel2);border-radius:8px;padding:10px 14px"><div style="font-size:11px;color:var(--muted)">${st}</div><div style="font-size:22px;font-weight:800">${counts[i]}</div></div>`).join("")}</div>
    <table class="utable"><tr><th>受信日時</th><th>名前</th><th>連絡先（電話/メール）</th><th>問い合わせ内容</th><th>ステータス</th><th></th></tr>${rows}</table>`);
  $("modalBox").querySelectorAll(".ssel").forEach(sel => sel.onchange = async () => { await api("PUT", `/api/forms/${sel.dataset.id}/status`, { status: sel.value }); $("btnForms").click(); });
  $("modalBox").querySelectorAll(".sdel").forEach(b => b.onclick = async () => { if (confirm("削除しますか？")) { await api("DELETE", `/api/forms/${b.dataset.id}`); $("btnForms").click(); } });
};

/* ============ 会話型ビルダー ============ */
$("chatBtn").onclick = async () => {
  const instruction = $("chatInput").value.trim(); if (!instruction) return toast("指示を入力してください", true);
  const btn = $("chatBtn"); btn.innerHTML = `<span class="spin"></span> 編集中…`; btn.disabled = true; $("chatOut").textContent = "";
  try {
    const { blocks, note } = await api("POST", "/api/ai/chat-edit", { instruction, blocks: curPage().blocks });
    blocks.forEach(b => { if (!b.id) b.id = uid(); });
    curPage().blocks = blocks; selectedId = null; renderCanvas(); scheduleSave();
    $("chatOut").textContent = "✓ " + (note || "編集しました"); $("chatInput").value = "";
  } catch (e) { $("chatOut").textContent = "エラー: " + e.message; }
  btn.innerHTML = "このページを編集"; btn.disabled = false;
};
$("chatChips").addEventListener("click", e => { if (!e.target.dataset.p) return; const t = $("chatInput"); t.value = (t.value ? t.value + " " : "") + e.target.dataset.p; t.focus(); });
$("a11yBtn").onclick = async () => {
  $("chatOut").innerHTML = `<span class="spin"></span> 点検中…`;
  try { const { text } = await api("POST", "/api/ai/a11y", { pageId: curPage().id }); $("chatOut").textContent = text; }
  catch (e) { $("chatOut").textContent = "エラー: " + e.message; }
};

/* ============ グロース（AI提案 / A/B / ログ / バックアップ） ============ */
$("btnGrowth").onclick = openGrowth;
async function openGrowth() {
  const [{ suggestions }, { ab }, { logs }] = await Promise.all([
    api("GET", "/api/suggestions"), api("GET", "/api/ab"), api("GET", "/api/logs")
  ]);
  const sg = suggestions.length ? suggestions.map(s => `<div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;${s.status !== "pending" ? "opacity:.55" : ""}">
    <div style="font-weight:600">${esc(s.title)} ${s.status === "done" ? "<span class='badge on'>対応済</span>" : s.status === "dismissed" ? "<span class='badge'>却下</span>" : ""}</div>
    <div style="font-size:13px;color:var(--muted);margin:4px 0 6px">${esc(s.body)}</div>
    ${s.status === "pending" ? `<button class="tbtn sg-done" data-id="${s.id}" style="padding:3px 9px">対応済みにする</button> <button class="tbtn sg-dis" data-id="${s.id}" style="padding:3px 9px">却下</button>` : ""}</div>`).join("")
    : `<p style="color:var(--muted);font-size:13px">まだ提案はありません。「今すぐAIに提案させる」を押してください。</p>`;
  const abHtml = `<table class="utable"><tr><th>バリアント</th><th>表示</th><th>CV</th><th>CV率</th></tr>
    <tr><td>A（現タイトル）</td><td>${ab.A.impressions}</td><td>${ab.A.conversions}</td><td>${ab.A.rate}%</td></tr>
    <tr><td>B（案B）</td><td>${ab.B.impressions}</td><td>${ab.B.conversions}</td><td>${ab.B.rate}%</td></tr></table>
    <p style="font-size:13px;margin:8px 0">${ab.winner ? `現時点の勝者: <b>${ab.winner}</b>` : "勝者判定には合計20表示以上が必要です"}</p>
    ${ab.winner ? `<button class="tbtn primary" id="abApply">現在のページのヒーローに勝者を採用</button>` : ""}`;
  const logHtml = logs.length ? `<table class="utable"><tr><th>日時</th><th>実行者</th><th>操作</th><th>詳細</th></tr>${logs.map(l => `<tr><td style="font-size:11px;color:var(--muted);white-space:nowrap">${new Date(l.ts).toLocaleString("ja-JP")}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td style="font-size:12px">${esc(l.detail || "")}</td></tr>`).join("")}</table>` : `<p style="color:var(--muted);font-size:13px">ログはまだありません。</p>`;
  openPage(`<h2>🚀 グロース</h2>
    <h2 class="card-h">AI改善提案（承認キュー）</h2>
    <button class="tbtn ai" id="agentRun" style="margin-bottom:10px">✨ 今すぐAIに提案させる</button>
    <div id="sgList">${sg}</div>
    <div class="hr"></div><h2 class="card-h">A/Bテスト結果（ヒーロー）</h2>${abHtml}
    <div class="hr"></div><h2 class="card-h">バックアップ</h2>
    <button class="tbtn" id="bkDownload">バックアップを取得</button> <button class="tbtn" id="bkRestore">バックアップから復元</button>
    <div class="hr"></div><h2 class="card-h">操作ログ</h2><div style="max-height:200px;overflow:auto">${logHtml}</div>
    <div class="modal-actions"><button class="tbtn" onclick="closeModal()">閉じる</button></div>`, true);
  $("agentRun").onclick = async () => { const b = $("agentRun"); b.innerHTML = `<span class="spin"></span> 生成中…`; b.disabled = true; try { await api("POST", "/api/agent/run"); openGrowth(); } catch (e) { toast(e.message, true); b.innerHTML = "✨ 今すぐAIに提案させる"; b.disabled = false; } };
  $("modalBox").querySelectorAll(".sg-done").forEach(b => b.onclick = async () => { await api("PUT", `/api/suggestions/${b.dataset.id}`, { status: "done" }); openGrowth(); });
  $("modalBox").querySelectorAll(".sg-dis").forEach(b => b.onclick = async () => { await api("PUT", `/api/suggestions/${b.dataset.id}`, { status: "dismissed" }); openGrowth(); });
  const abApply = $("abApply"); if (abApply) abApply.onclick = async () => { try { const r = await api("POST", "/api/ab/apply-winner", { pageId: curPage().id }); await loadSite(); renderCanvas(); toast(`勝者${r.winner}を採用しました`); closeModal(); } catch (e) { toast(e.message, true); } };
  $("bkDownload").onclick = async () => { const { backup } = await api("GET", "/api/backup"); const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `backup-${SITE.slug}-${Date.now()}.json`; a.click(); toast("バックアップを保存しました"); };
  $("bkRestore").onclick = () => { const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json"; inp.onchange = () => { const f = inp.files[0]; const rd = new FileReader(); rd.onload = async () => { if (!confirm("現在のページ・記事をバックアップ内容で置き換えます。よろしいですか？")) return; try { await api("POST", "/api/backup/restore", { backup: JSON.parse(rd.result) }); await loadSite(); renderAll(); toast("復元しました"); closeModal(); } catch (e) { toast(e.message, true); } }; rd.readAsText(f); }; inp.click(); };
}

/* ============ アクセス解析ダッシュボード ============ */
let anaChart = null;
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
$("btnAnalytics").onclick = () => {
  hideAll(); $("analyticsView").classList.remove("hidden");
  $("anaSiteName").textContent = "／ " + SITE.title;
  $("anaWho").textContent = ME.name;
  // 初期期間: 直近30日
  $("anaTo").value = fmtDate(Date.now());
  $("anaFrom").value = fmtDate(Date.now() - 30 * 86400000);
  loadAnalytics();
};
$("anaBack").onclick = () => { hideAll(); $("appView").classList.remove("hidden"); };
$("anaPage").onchange = loadAnalytics;
$("anaDevice").onchange = loadAnalytics;
$("anaFrom").onchange = loadAnalytics;
$("anaTo").onchange = loadAnalytics;
$("anaGran").addEventListener("click", e => { if (!e.target.dataset.g) return; $("anaGran").querySelectorAll("button").forEach(b => b.classList.toggle("active", b === e.target)); loadAnalytics(); });

async function loadAnalytics() {
  const gran = $("anaGran").querySelector("button.active").dataset.g;
  const from = $("anaFrom").value ? new Date($("anaFrom").value + "T00:00:00").getTime() : Date.now() - 30 * 86400000;
  const to = $("anaTo").value ? new Date($("anaTo").value + "T23:59:59").getTime() : Date.now();
  const page = $("anaPage").value || "";
  const device = $("anaDevice").value || "";
  const q = `from=${from}&to=${to}&granularity=${gran}` + (page ? `&page=${encodeURIComponent(page)}` : "") + (device ? `&device=${device}` : "");
  const { summary, pageKeys } = await api("GET", "/api/analytics?" + q);
  // ページ選択肢（初回のみ構築）
  const sel = $("anaPage");
  if (sel.options.length <= 1 && pageKeys && pageKeys.length) {
    pageKeys.forEach(k => { const o = document.createElement("option"); o.value = k; o.textContent = k; sel.appendChild(o); });
    if (page) sel.value = page;
  }
  renderKpi(summary.kpi);
  renderAnaChart(summary.series, gran);
  renderAnaTables(summary);
}
function secFmt(s) { s = s || 0; const m = Math.floor(s / 60), ss = s % 60; return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`; }
function renderKpi(k) {
  const cards = [
    { label: "コンバージョン数", val: k.conversions, color: "#ec4899", primary: true },
    { label: "コンバージョン率", val: k.conversionRate + "%", color: "#ec4899", raw: true },
    { label: "PV（表示回数）", val: k.pv, color: "var(--accent)" },
    { label: "セッション", val: k.sessions, color: "#8b5cf6" },
    { label: "ユーザー", val: k.users, color: "#3b82f6" },
    { label: "新規ユーザー", val: k.newUsers, color: "#f59e0b" },
    { label: "エンゲージ率", val: k.engagementRate + "%", color: "#14b8a6", raw: true },
    { label: "直帰率", val: k.bounceRate + "%", color: "#ef4444", raw: true },
    { label: "平均滞在時間", val: secFmt(k.avgTime), color: "#0ea5e9", raw: true },
    { label: "PV/セッション", val: k.pvPerSession, color: "#06b6d4", raw: true },
    { label: "参照元数", val: k.refCount, color: "#16a34a" },
  ];
  $("anaKpi").innerHTML = cards.map(c => `<div class="kpi ${c.primary ? "primary" : ""}">
    <div class="k-top"><span class="k-dot" style="background:${c.color}">●</span>${c.label}</div>
    <div class="k-val">${c.raw ? c.val : (c.val || 0).toLocaleString()}</div></div>`).join("");
}
function renderAnaChart(series, gran) {
  const labels = series.map(s => s.d);
  const pv = series.map(s => s.pv);
  const users = series.map(s => s.u);
  const ctx = $("anaChart").getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, 300);
  grad.addColorStop(0, "rgba(249,115,22,0.35)"); grad.addColorStop(1, "rgba(249,115,22,0.02)");
  if (anaChart) anaChart.destroy();
  anaChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [
      { label: "PV", data: pv, borderColor: "#f97316", backgroundColor: grad, fill: true, tension: 0.35, pointRadius: 2, borderWidth: 2 },
      { label: "ユーザー", data: users, borderColor: "#3b82f6", backgroundColor: "transparent", fill: false, tension: 0.35, pointRadius: 2, borderWidth: 2 } ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: "#eee" } }, x: { grid: { display: false }, ticks: { maxRotation: 60, font: { size: 10 }, autoSkip: true, maxTicksLimit: 16 } } } }
  });
}
function renderAnaTables(summary) {
  const devLabel = { desktop: "PC", tablet: "タブレット", mobile: "スマホ", unknown: "不明" };
  const devTotal = summary.byDevice.reduce((a, d) => a + d.c, 0) || 1;
  const devHtml = summary.byDevice.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${summary.byDevice.map(d => `<span class="badge">${devLabel[d.device] || d.device}: ${d.c}（${Math.round(d.c / devTotal * 100)}%）</span>`).join("")}</div>` : "";
  $("anaRefs").innerHTML = devHtml + (summary.byRef.length
    ? `<table class="utable"><tr><th>流入元URL</th><th>訪問</th><th>ユーザー</th></tr>${summary.byRef.map(r => `<tr><td style="word-break:break-all">${esc(r.ref)}</td><td>${r.v}</td><td>${r.u}</td></tr>`).join("")}</table>`
    : `<p style="color:var(--muted);font-size:13px">参照元データがまだありません。</p>`);
  $("anaPages").innerHTML = summary.byPage.length
    ? `<table class="utable"><tr><th>ページ</th><th>表示数</th></tr>${summary.byPage.map(p => `<tr><td style="word-break:break-all">${esc(p.page_key)}</td><td>${p.c}</td></tr>`).join("")}</table>`
    : `<p style="color:var(--muted);font-size:13px">アクセスデータがまだありません。公開後に記録されます。</p>`;
}
$("anaInsight2").onclick = async () => {
  const b = $("anaInsight2"); b.innerHTML = `<span class="spin"></span> 分析中…`; b.disabled = true;
  try { const { text } = await api("POST", "/api/analytics/insight"); $("anaOut2").textContent = text; }
  catch (e) { $("anaOut2").textContent = "エラー: " + e.message; }
  b.innerHTML = "✨ AIにこのデータを分析してもらう"; b.disabled = false;
};

/* ============ ブログ / コラム管理 ============ */
$("btnBlog").onclick = openBlogList;
async function openBlogList() {
  const { posts } = await api("GET", "/api/posts");
  const rows = posts.length ? posts.map(p => `<tr>
    <td>${esc(p.title)}</td>
    <td><span class="badge ${p.status === "published" ? "on" : ""}">${p.status === "published" ? "公開" : p.status === "scheduled" ? "予約" : "下書き"}</span>${p.status === "scheduled" && p.scheduled_at ? `<br><span style="font-size:10px;color:var(--muted)">${new Date(p.scheduled_at).toLocaleString("ja-JP")}</span>` : ""}</td>
    <td style="font-size:12px;color:var(--muted)">${new Date(p.created_at).toLocaleDateString("ja-JP")}</td>
    <td><button class="tbtn pedit" data-id="${p.id}" style="padding:3px 9px">編集</button>
    <button class="tbtn pdel" data-id="${p.id}" style="padding:3px 9px;border-color:var(--danger);color:var(--danger)">削除</button></td></tr>`).join("")
    : `<tr><td colspan="4" style="color:var(--muted)">まだ記事がありません。</td></tr>`;
  openPage(`<h2>📝 ブログ・コラム</h2>
    <div style="display:flex;gap:8px;margin-bottom:12px"><button class="tbtn primary" id="pNew">＋ 新規作成</button><button class="tbtn ai" id="pAI">✨ AIで記事を生成</button></div>
    <table class="utable"><tr><th>タイトル</th><th>状態</th><th>作成日</th><th></th></tr>${rows}</table>
    <div class="modal-actions"><button class="tbtn" onclick="closeModal()">閉じる</button></div>`, true);
  $("pNew").onclick = async () => { const { post } = await api("POST", "/api/posts", { title: "無題の記事", body: "<p>本文をここに書きます。</p>" }); openPostEditor(post); };
  $("pAI").onclick = openBlogAI;
  $("modalBox").querySelectorAll(".pedit").forEach(b => b.onclick = async () => { const { post } = await api("GET", `/api/posts/${b.dataset.id}`); openPostEditor(post); });
  $("modalBox").querySelectorAll(".pdel").forEach(b => b.onclick = async () => { if (confirm("削除しますか？")) { await api("DELETE", `/api/posts/${b.dataset.id}`); openBlogList(); } });
}
function openBlogAI() {
  openPage(`<h2>✨ AIで記事を生成（ロングテールSEO対応）</h2>
    <div class="ai-box" style="max-width:none">
      <label style="font-size:12px;font-weight:600;color:var(--muted)">① キーワード調査（主軸KWからロングテール候補を提案）</label>
      <div style="display:flex;gap:6px;margin-top:6px"><input id="kw_topic" placeholder="例: コーヒー豆" style="flex:1;background:#fff;border:1px solid var(--border2);border-radius:8px;padding:9px"><button class="tbtn ai" id="kw_go">候補を出す</button></div>
      <div id="kw_list" style="margin-top:10px"></div>
    </div>
    <div class="settings-grid">
    <label>② テーマ／狙うキーワード（候補から選ぶか直接入力）</label><input id="ba_topic" placeholder="例: コーヒー豆 選び方 初心者">
    <label>トーン</label><select id="ba_tone"><option>親しみやすい</option><option>専門的</option><option>カジュアル</option><option>丁寧・フォーマル</option></select>
    <label>分量の目安(文字)</label><select id="ba_len"><option>600</option><option selected>1000</option><option>1600</option></select>
  </div><div class="modal-actions"><button class="tbtn" onclick="closeModal()">キャンセル</button><button class="tbtn ai" id="ba_go">③ この内容で記事を生成</button></div>`);
  $("kw_go").onclick = async () => {
    const t = $("kw_topic").value.trim(); if (!t) return toast("主軸キーワードを入力", true);
    const btn = $("kw_go"); btn.innerHTML = `<span class="spin"></span>`; btn.disabled = true; $("kw_list").innerHTML = "";
    try {
      const { keywords } = await api("POST", "/api/ai/keywords", { topic: t });
      const diffColor = d => d === "低" ? "var(--ok)" : d === "高" ? "var(--danger)" : "var(--accent)";
      $("kw_list").innerHTML = `<div style="font-size:11px;color:var(--muted);margin-bottom:6px">クリックでテーマに設定（難易度はAIによる目安）</div>` +
        keywords.map(k => `<button class="tbtn kwc" data-kw="${esc(k.kw)}" style="display:block;width:100%;text-align:left;margin-bottom:5px;padding:8px 10px"><b>${esc(k.kw)}</b> <span style="color:${diffColor(k.difficulty)};font-size:11px">[難易度${esc(k.difficulty || "中")}]</span><br><span style="font-size:11px;color:var(--muted)">${esc(k.intent || "")}</span></button>`).join("");
      $("kw_list").querySelectorAll(".kwc").forEach(b => b.onclick = () => { $("ba_topic").value = b.dataset.kw; toast("テーマに設定しました"); });
    } catch (e) { $("kw_list").innerHTML = `<span style="color:var(--danger);font-size:12px">エラー: ${esc(e.message)}</span>`; }
    btn.innerHTML = "候補を出す"; btn.disabled = false;
  };
  $("ba_go").onclick = async () => {
    if (!$("ba_topic").value.trim()) return toast("テーマ／キーワードを入力", true);
    const btn = $("ba_go"); btn.innerHTML = `<span class="spin"></span> 生成中…`; btn.disabled = true;
    try {
      const r = await api("POST", "/api/ai/blog", { topic: $("ba_topic").value, tone: $("ba_tone").value, length: $("ba_len").value });
      const { post } = await api("POST", "/api/posts", { title: r.title, excerpt: r.excerpt, body: r.body });
      toast("記事を生成しました"); openPostEditor(post);
    } catch (e) { toast(e.message, true); btn.innerHTML = "③ この内容で記事を生成"; btn.disabled = false; }
  };
}
function openPostEditor(post) {
  openPage(`<h2>記事の編集</h2><div class="settings-grid">
    <label>タイトル</label><input id="pe_title" value="${esc(post.title)}">
    <label>URLスラッグ</label><input id="pe_slug" value="${esc(post.slug)}">
    <label>抜粋（一覧・SNS用）</label><input id="pe_excerpt" value="${esc(post.excerpt || "")}">
    <label>カバー画像URL（任意）</label><input id="pe_cover" value="${esc(post.cover || "")}">
    <label>本文（HTML可・h2/p/ul など）</label><textarea id="pe_body" style="min-height:220px">${esc(post.body || "")}</textarea>
    <label>状態</label><select id="pe_status"><option value="draft" ${post.status === "draft" ? "selected" : ""}>下書き</option><option value="published" ${post.status === "published" ? "selected" : ""}>公開</option><option value="scheduled" ${post.status === "scheduled" ? "selected" : ""}>予約投稿</option></select>
    <label id="pe_sched_l" style="${post.status === "scheduled" ? "" : "display:none"}">公開予約日時</label>
    <input type="datetime-local" id="pe_sched" style="${post.status === "scheduled" ? "" : "display:none"}" value="${post.scheduled_at ? new Date(post.scheduled_at - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}">
  </div><div class="modal-actions">
    <button class="tbtn" id="pe_back">← 一覧へ</button>
    <button class="tbtn" id="pe_view">プレビュー</button>
    <button class="tbtn primary" id="pe_save">保存</button></div>`, true);
  $("pe_status").onchange = () => { const sc = $("pe_status").value === "scheduled"; $("pe_sched").style.display = sc ? "" : "none"; $("pe_sched_l").style.display = sc ? "" : "none"; };
  const save = async () => {
    const status = $("pe_status").value;
    const { post: up } = await api("PUT", `/api/posts/${post.id}`, {
      title: $("pe_title").value, slug: $("pe_slug").value, excerpt: $("pe_excerpt").value,
      cover: $("pe_cover").value, body: $("pe_body").value, status: status === "scheduled" ? "draft" : status });
    if (status === "scheduled") {
      const at = $("pe_sched").value ? new Date($("pe_sched").value).getTime() : 0;
      if (!at || at < Date.now()) { toast("未来の日時を指定してください", true); }
      else { await api("PUT", `/api/posts/${post.id}/schedule`, { scheduledAt: at }); toast("予約しました"); Object.assign(post, up, { status: "scheduled", scheduled_at: at }); return post; }
    }
    Object.assign(post, up); toast("保存しました"); return up;
  };
  $("pe_save").onclick = async () => { await save(); };
  $("pe_back").onclick = async () => { await save(); openBlogList(); };
  $("pe_view").onclick = async () => { const up = await save(); if (up.status === "published" && SITE.published) window.open(`/s/${SITE.slug}/blog/${up.slug}`, "_blank"); else toast("公開状態かつサイト公開中のみプレビューできます", true); };
}

/* ============ モーダル ============ */
function openModal(html, wide) { $("modalBg").classList.remove("as-page"); $("modalBox").innerHTML = html; $("modalBox").classList.toggle("wide", !!wide); $("modalBg").classList.add("show"); }
// 全画面サブページ（左ナビの各機能をモーダルではなく独立ページとして表示）
function openPage(html) {
  $("modalBox").classList.remove("wide");
  $("modalBox").innerHTML = `<div class="page-head"><button class="tbtn" id="pgBack">← 戻る</button></div><div class="page-body">${html}</div>`;
  $("modalBg").classList.add("show", "as-page");
  $("pgBack").onclick = closeModal;
}
function closeModal() { $("modalBg").classList.remove("show", "as-page"); }
window.closeModal = closeModal;
$("modalBg").addEventListener("click", e => { if (e.target.id === "modalBg" && !$("modalBg").classList.contains("as-page")) closeModal(); });

/* ============ デザイン設定 ============ */
const DESIGN_PRESETS = {
  "高級路線": { accent: "#b08d57", pageBg: "#0e0e0f", textColor: "#f3f1ec", font: "'Times New Roman',serif" },
  "ポップ": { accent: "#ff5ca8", pageBg: "#fffdf7", textColor: "#222222", font: "system-ui, sans-serif" },
  "採用特化": { accent: "#0f766e", pageBg: "#ffffff", textColor: "#1f2937", font: "'Hiragino Sans','Noto Sans JP',sans-serif" },
  "信頼感重視": { accent: "#1d4ed8", pageBg: "#ffffff", textColor: "#111827", font: "'Hiragino Sans','Noto Sans JP',sans-serif" },
  "韓国風": { accent: "#111111", pageBg: "#fafafa", textColor: "#2b2b2b", font: "system-ui, sans-serif" },
  "ミニマル": { accent: "#111827", pageBg: "#ffffff", textColor: "#374151", font: "system-ui, sans-serif" },
};
$("btnSettings").onclick = () => {
  const s = SITE.settings;
  const presetCards = Object.entries(DESIGN_PRESETS).map(([name, p]) => `<button class="preset-card" data-name="${name}">
    <span class="pc-swatch" style="background:${p.pageBg}"><span style="background:${p.accent}"></span></span>${name}</button>`).join("");
  openPage(`<h2>デザイン設定</h2>
    <label style="font-size:12px;color:var(--muted);font-weight:600">デザインプリセット（クリックで一括適用）</label>
    <div class="preset-grid">${presetCards}</div>
    <div class="hr"></div>
    <div class="settings-grid">
    <label>サイトタイトル</label><input id="st_title" value="${esc(s.siteTitle)}">
    <label>本文フォント</label><select id="st_font">${["system-ui, sans-serif","'Hiragino Sans','Noto Sans JP',sans-serif","'Times New Roman',serif","Georgia,serif","'Courier New',monospace"].map(f=>`<option ${s.font===f?"selected":""}>${f}</option>`).join("")}</select>
    <label>最大幅 (px)</label><input id="st_maxw" type="number" value="${s.maxWidth}">
    <label><input type="checkbox" id="st_full" ${s.fullWidth?"checked":""}> 全幅レイアウト</label>
    <label>アクセントカラー</label><input id="st_accent" type="color" value="${s.accent}">
    <label>ページ背景色</label><input id="st_pagebg" type="color" value="${s.pageBg}">
    <label>基本文字色</label><input id="st_text" type="color" value="${s.textColor}">
    <label style="grid-column:1/-1;margin-top:8px">▼ 問い合わせ通知（任意）</label>
    <label>通知先メール（要SMTP設定）</label><input id="st_nmail" value="${esc(s.notifyEmail || "")}" placeholder="owner@example.com">
    <label>通知Webhook URL（Slack等）</label><input id="st_nhook" value="${esc(s.notifyWebhook || "")}" placeholder="https://hooks.slack.com/...">
  </div><div class="modal-actions"><button class="tbtn" onclick="closeModal()">閉じる</button><button class="tbtn primary" id="st_apply">適用</button></div>`);
  $("modalBox").querySelectorAll(".preset-card").forEach(c => c.onclick = () => {
    const p = DESIGN_PRESETS[c.dataset.name];
    $("st_accent").value = p.accent; $("st_pagebg").value = p.pageBg; $("st_text").value = p.textColor;
    $("st_font").value = p.font;
    $("modalBox").querySelectorAll(".preset-card").forEach(x => x.classList.toggle("active", x === c));
  });
  $("st_apply").onclick = async () => {
    Object.assign(s, { siteTitle: $("st_title").value, font: $("st_font").value, maxWidth: parseInt($("st_maxw").value) || 960, fullWidth: $("st_full").checked, accent: $("st_accent").value, pageBg: $("st_pagebg").value, textColor: $("st_text").value, notifyEmail: $("st_nmail").value, notifyWebhook: $("st_nhook").value });
    await api("PUT", "/api/site/settings", { settings: s });
    closeModal(); applySiteVars(); renderCanvas(); toast("デザインを更新しました");
  };
};

/* ============ マスター管理画面 ============ */
async function renderMaster() {
  const { sites } = await api("GET", "/api/master/sites");
  const wrap = $("siteCards");
  if (sites.length === 0) { wrap.innerHTML = `<div class="insp-empty">まだサイトがありません。「＋ 新しいサイトを作成」から始めましょう。</div>`; return; }
  wrap.innerHTML = sites.map(s => {
    const users = s.users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${roleLabel(u.role)}</td>
      <td><button class="tbtn upw" data-uid="${u.id}" style="padding:2px 7px">PW再発行</button>
      <button class="tbtn udel" data-uid="${u.id}" style="padding:2px 7px;border-color:var(--danger);color:var(--danger)">削除</button></td></tr>`).join("")
      || `<tr><td colspan="4" style="color:var(--muted)">アカウント未発行</td></tr>`;
    return `<div class="site-card" data-sid="${s.id}">
      <div class="site-head">
        <div><div class="site-title">${esc(s.title)} <span class="badge ${s.published?"on":""}">${s.published?"公開中":"非公開"}</span></div>
          <div class="site-sub">/s/${esc(s.slug)} ・ ${s.page_count}ページ ・ ${s.user_count}アカウント</div></div>
        <div style="display:flex;gap:6px">
          <button class="tbtn primary enter" data-sid="${s.id}">編集に入る →</button>
          <button class="tbtn issue" data-sid="${s.id}">アカウント発行</button>
          <button class="tbtn delsite" data-sid="${s.id}" style="border-color:var(--danger);color:var(--danger)">削除</button>
        </div>
      </div>
      <table class="utable" style="margin-top:10px"><tr><th>名前</th><th>メール（ID）</th><th>権限</th><th></th></tr>${users}</table>
    </div>`;
  }).join("");

  wrap.querySelectorAll(".enter").forEach(b => b.onclick = async () => { ACTIVE_SITE = +b.dataset.sid; await enterBuilder(); });
  wrap.querySelectorAll(".delsite").forEach(b => b.onclick = async () => { if (confirm("このサイトと全データ・アカウントを削除しますか？")) { await api("DELETE", `/api/master/sites/${b.dataset.sid}`); renderMaster(); } });
  wrap.querySelectorAll(".issue").forEach(b => b.onclick = () => issueAccount(+b.dataset.sid));
  wrap.querySelectorAll(".upw").forEach(b => b.onclick = async () => { const pw = prompt("新しいパスワード（4文字以上）"); if (pw) { try { await api("PUT", `/api/master/users/${b.dataset.uid}/password`, { password: pw }); toast("パスワードを再発行しました"); } catch (e) { toast(e.message, true); } } });
  wrap.querySelectorAll(".udel").forEach(b => b.onclick = async () => { if (confirm("このアカウントを削除？")) { await api("DELETE", `/api/master/users/${b.dataset.uid}`); renderMaster(); } });
}
$("mNewSite").onclick = () => {
  openModal(`<h2>新しいサイトを作成</h2><div class="settings-grid">
    <label>サイト名</label><input id="ns_title" placeholder="〇〇カフェ">
    <label>公開スラッグ（URL: /s/●●●）</label><input id="ns_slug" placeholder="my-cafe（英小文字・数字・ハイフン）">
    <div class="hr" style="grid-column:1/-1"></div>
    <label style="grid-column:1/-1">▼ オーナーのログインアカウント（任意・後から発行も可）</label>
    <label>オーナー名</label><input id="ns_oname">
    <label>メール（ログインID）</label><input id="ns_oemail">
    <label>初期パスワード</label><input id="ns_opass">
  </div><div class="modal-actions"><button class="tbtn" onclick="closeModal()">キャンセル</button><button class="tbtn primary" id="ns_create">作成</button></div>`);
  $("ns_create").onclick = async () => {
    try {
      await api("POST", "/api/master/sites", { title: $("ns_title").value, slug: $("ns_slug").value, ownerName: $("ns_oname").value, ownerEmail: $("ns_oemail").value, ownerPassword: $("ns_opass").value });
      closeModal(); toast("サイトを作成しました"); renderMaster();
    } catch (e) { toast(e.message, true); }
  };
};
function issueAccount(siteId) {
  openModal(`<h2>アカウント発行</h2><p style="font-size:13px;color:var(--muted)">このサイト専用のログインアカウントを発行します。</p>
    <div class="settings-grid"><label>名前</label><input id="ia_name"><label>メール（ID）</label><input id="ia_email"><label>初期パスワード</label><input id="ia_pass">
    <label>権限</label><select id="ia_role"><option value="owner">オーナー（全権）</option><option value="editor" selected>編集者</option><option value="viewer">閲覧のみ</option></select></div>
    <div class="modal-actions"><button class="tbtn" onclick="closeModal()">キャンセル</button><button class="tbtn primary" id="ia_add">発行</button></div>`);
  $("ia_add").onclick = async () => {
    try { await api("POST", `/api/master/sites/${siteId}/users`, { name: $("ia_name").value, email: $("ia_email").value, password: $("ia_pass").value, role: $("ia_role").value }); closeModal(); toast("アカウントを発行しました"); renderMaster(); }
    catch (e) { toast(e.message, true); }
  };
}
$("mUsage").onclick = async () => {
  const { usage } = await api("GET", "/api/master/usage");
  const rows = usage.map(u => {
    const pct = u.limit ? Math.min(100, Math.round(u.monthlyPv / u.limit * 100)) : 0;
    const bar = u.limit ? `<div style="background:var(--panel2);border-radius:6px;height:8px;overflow:hidden;margin-top:4px"><div style="height:100%;width:${pct}%;background:${pct >= 90 ? "var(--danger)" : "var(--accent)"}"></div></div>` : "";
    return `<tr><td>${esc(u.title)}</td><td><select class="uplan" data-id="${u.id}" style="padding:3px;border:1px solid var(--border2);border-radius:6px"><option ${u.plan === "free" ? "selected" : ""}>free</option><option ${u.plan === "pro" ? "selected" : ""}>pro</option><option ${u.plan === "business" ? "selected" : ""}>business</option></select></td>
      <td>${u.monthlyPv.toLocaleString()} PV ${u.limit ? `/ ${u.limit.toLocaleString()}` : "（無制限）"}${bar}</td>
      <td><input class="ulim" data-id="${u.id}" type="number" value="${u.limit || 0}" style="width:90px;padding:3px;border:1px solid var(--border2);border-radius:6px" placeholder="0=無制限"></td></tr>`;
  }).join("");
  openModal(`<h2>📊 使用量・プラン（今月のPV）</h2>
    <table class="utable"><tr><th>サイト</th><th>プラン</th><th>今月のPV</th><th>PV上限</th></tr>${rows}</table>
    <div class="modal-actions"><button class="tbtn" onclick="closeModal()">閉じる</button><button class="tbtn primary" id="usSave">保存</button></div>`, true);
  $("usSave").onclick = async () => {
    for (const sel of $("modalBox").querySelectorAll(".uplan")) {
      const id = sel.dataset.id; const lim = $("modalBox").querySelector(`.ulim[data-id="${id}"]`).value;
      await api("PUT", `/api/master/sites/${id}/plan`, { plan: sel.value, pvLimit: +lim || 0 });
    }
    toast("保存しました"); closeModal();
  };
};
$("btnBackMaster").onclick = async () => { if (ws) { ws.onclose = null; ws.close(); } ACTIVE_SITE = null; await renderMaster(); showMaster(); };

/* ============ アカウント設定（全ユーザー共通） ============ */
$("btnAccount").onclick = $("mAccount").onclick = () => {
  openPage(`<h2>アカウント設定</h2><div class="settings-grid">
    <label>表示名</label><input id="ac_name" value="${esc(ME.name)}">
    <div class="hr" style="grid-column:1/-1"></div>
    <label style="grid-column:1/-1">▼ パスワード変更（変更しない場合は空欄）</label>
    <label>現在のパスワード</label><input id="ac_cur" type="password">
    <label>新しいパスワード</label><input id="ac_new" type="password">
  </div><div class="modal-actions"><button class="tbtn" onclick="closeModal()">閉じる</button><button class="tbtn primary" id="ac_save">保存</button></div>`);
  $("ac_save").onclick = async () => {
    try {
      if ($("ac_name").value && $("ac_name").value !== ME.name) { await api("PUT", "/api/account/name", { name: $("ac_name").value }); ME.name = $("ac_name").value; }
      if ($("ac_new").value) { await api("PUT", "/api/account/password", { current: $("ac_cur").value, next: $("ac_new").value }); }
      closeModal(); toast("アカウント情報を更新しました");
      if (!isMaster()) $("whoami").textContent = `${ME.name}（${roleLabel(ME.role)}）`; else $("masterWho").textContent = `${ME.name}（マスター）`;
    } catch (e) { toast(e.message, true); }
  };
};

/* ============ 公開 / プレビュー ============ */
async function setPublished(next) {
  await api("PUT", "/api/site/publish", { published: next }); SITE.published = next;
  $("btnPublish").innerHTML = `<span>🌐</span>${next ? "公開中 ✓" : "公開する"}`;
  toast(next ? `公開しました（/s/${SITE.slug}）` : "非公開にしました");
}
$("btnPublish").onclick = () => {
  if (SITE.published) { // 公開中 → 取り下げ
    if (confirm("サイトを非公開にしますか？")) setPublished(false).catch(e => toast(e.message, true));
    return;
  }
  // 未公開 → 3ステップ（プレビュー→確認→公開）
  const lastEdited = new Date(Math.max(...PAGES.map(p => p.updated_at || 0)) || Date.now()).toLocaleString("ja-JP");
  openPage(`<h2>サイトを公開する</h2>
    <div style="display:flex;align-items:center;gap:10px;margin:6px 0 14px;font-size:13px;color:var(--muted)">
      <span style="background:var(--accent);color:#fff;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center">1</span> プレビュー
      <span>→</span><span style="background:var(--accent);color:#fff;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center">2</span> 内容を確認
      <span>→</span><span style="background:var(--accent);color:#fff;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center">3</span> 公開</div>
    <p style="font-size:13px">公開後は <b>/s/${esc(SITE.slug)}/</b> で誰でも閲覧できるようになります。</p>
    <ul style="font-size:13px;color:var(--muted);line-height:1.9">
      <li>ページ数: ${PAGES.length}</li><li>最終更新: ${lastEdited}</li>
      <li><a href="/preview/${SITE.slug}/" target="_blank">公開前プレビューを別タブで開く ↗</a></li></ul>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:8px"><input type="checkbox" id="pubConfirm"> 内容を確認しました</label>
    <div class="modal-actions"><button class="tbtn" onclick="closeModal()">キャンセル</button><button class="tbtn primary" id="pubGo" disabled>この内容で公開する</button></div>`);
  $("pubConfirm").onchange = () => { $("pubGo").disabled = !$("pubConfirm").checked; };
  $("pubGo").onclick = async () => { try { await setPublished(true); closeModal(); } catch (e) { toast(e.message, true); } };
};
$("btnPreviewWin").onclick = () => {
  const url = SITE.published ? `/s/${SITE.slug}/` : `/preview/${SITE.slug}/`;
  openPage(`<h2>🔗 公開ページ表示</h2>
    <p style="font-size:13px;color:var(--muted)">${SITE.published ? `公開URL: <b>/s/${esc(SITE.slug)}/</b>` : "未公開のためプレビュー表示中（あなただけが見られます）"}　<a href="${url}" target="_blank">別タブで開く ↗</a></p>
    <div style="border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-top:8px"><iframe src="${url}" style="width:100%;height:70vh;border:0;background:#fff"></iframe></div>`);
};

/* ============ 書き出し ============ */
$("btnExport").onclick = async () => {
  const { files } = await api("GET", "/api/export");
  const names = Object.keys(files);
  openPage(`<h2>⬇ サイトの書き出し</h2>
    <p style="font-size:13px;color:var(--muted)">公開用の静的HTMLをダウンロードできます。サーバー不要でどこにでも設置可能です。</p>
    <button class="tbtn primary" id="exAll" style="margin:8px 0">すべてダウンロード（${names.length}ファイル）</button>
    <table class="utable"><tr><th>ファイル名</th><th></th></tr>${names.map(n => `<tr><td>${esc(n)}</td><td><button class="tbtn exone" data-n="${esc(n)}" style="padding:3px 10px">保存</button></td></tr>`).join("")}</table>`);
  const dl = (name) => { const blob = new Blob([files[name]], { type: "text/html;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  $("exAll").onclick = () => { names.forEach(dl); toast(`${names.length}ファイルを書き出しました`); };
  $("modalBox").querySelectorAll(".exone").forEach(b => b.onclick = () => dl(b.dataset.n));
};

/* ============ モード切替 ============ */
$("modeSeg").addEventListener("click", e => { if (!e.target.dataset.mode) return; const mode = e.target.dataset.mode; document.body.classList.toggle("preview", mode === "preview"); document.body.classList.toggle("editing", mode === "edit"); document.querySelectorAll("#modeSeg button").forEach(b => b.classList.toggle("active", b.dataset.mode === mode)); if (mode === "preview") selectedId = null; renderCanvas(); });
$("canvas").addEventListener("click", () => { if (!document.body.classList.contains("preview")) { selectedId = null; refreshSelection(); renderInspector(); } });

/* 端末プレビュー切替 */
const DEVICE_W = { desktop: "", tablet: "820px", mobile: "390px" };
$("deviceSeg").addEventListener("click", e => {
  if (!e.target.dataset.dev) return;
  $("deviceSeg").querySelectorAll("button").forEach(b => b.classList.toggle("active", b === e.target));
  const w = DEVICE_W[e.target.dataset.dev];
  const c = $("canvas");
  if (w) { c.style.maxWidth = w; c.dataset.dev = e.target.dataset.dev; } else { c.style.maxWidth = ""; delete c.dataset.dev; applySiteVars(); }
});

/* 編集履歴・復元 */
$("btnHistory").onclick = async () => {
  const { revisions } = await api("GET", `/api/pages/${curPage().id}/revisions`);
  const rows = revisions.length ? revisions.map((r, i) => `<tr>
    <td>${i === 0 ? "<b>最新</b>" : "版 " + (revisions.length - i)}</td>
    <td style="font-size:12px;color:var(--muted)">${new Date(r.created_at).toLocaleString("ja-JP")}</td>
    <td>${esc(r.author || "")}</td>
    <td>${i === 0 ? "" : `<button class="tbtn rrestore" data-id="${r.id}" style="padding:3px 10px">この版に戻す</button>`}</td></tr>`).join("")
    : `<tr><td colspan="4" style="color:var(--muted)">履歴がありません。</td></tr>`;
  openModal(`<h2>🕘 編集履歴（このページ）</h2><p style="font-size:12px;color:var(--muted)">保存のたびに自動記録されます（直近20件）。</p>
    <table class="utable"><tr><th></th><th>日時</th><th>編集者</th><th></th></tr>${rows}</table>
    <div class="modal-actions"><button class="tbtn" onclick="closeModal()">閉じる</button></div>`, true);
  $("modalBox").querySelectorAll(".rrestore").forEach(b => b.onclick = async () => {
    if (!confirm("この版に戻しますか？現在の内容は新しい履歴として残ります。")) return;
    const { blocks } = await api("POST", `/api/pages/${curPage().id}/revisions/${b.dataset.id}/restore`);
    curPage().blocks = blocks; selectedId = null; renderCanvas(); closeModal(); toast("復元しました");
  });
};

/* ============ Toast ============ */
function toast(msg, err) { const t = $("toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : ""); clearTimeout(t._t); t._t = setTimeout(() => t.className = "toast", 2000); }

/* ============ 全体描画 ============ */
function renderAll() { renderPages(); renderPalette(); renderCanvas(); }

init();
