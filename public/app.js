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
  c.style.setProperty("--site-accent", s.accent);
  const hMap = { small: "500px", medium: "700px", large: "calc(100vh - 80px)", fullscreen: "100vh" };
  c.style.setProperty("--canvas-min-h", hMap[s.canvasHeight] || "700px");
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
    const indent = pg.parent_id ? "margin-left:12px;font-size:12px;" : "";
    const slugLabel = pg.slug ? `<span style="display:block;font-size:10px;color:var(--muted);line-height:1.2">/${pg.slug}</span>` : "";
    const it = document.createElement("div"); it.className = "page-item" + (i === curIdx ? " active" : "");
    it.innerHTML = `<span style="flex:1;${indent}">${esc(pg.name)}${slugLabel}</span><span class="pa ren" title="名前・URLを変更">✎</span><span class="pa del" title="削除">✕</span>`;
    it.onclick = e => { if (e.target.classList.contains("ren") || e.target.classList.contains("del")) return; curIdx = i; selectedId = null; renderPages(); renderCanvas(); joinPage(); };
    it.querySelector(".ren").onclick = async e => {
      e.stopPropagation();
      const n = prompt("ページ名", pg.name); if (!n) return;
      await api("PUT", `/api/pages/${pg.id}/name`, { name: n });
      const newSlug = prompt("URLスラッグ（英数字・ハイフン）", pg.slug || "");
      if (newSlug !== null && newSlug !== pg.slug) {
        const { slug } = await api("PUT", `/api/pages/${pg.id}/slug`, { slug: newSlug });
        pg.slug = slug;
      }
      pg.name = n; renderPages();
    };
    it.querySelector(".del").onclick = async e => { e.stopPropagation(); if (PAGES.length <= 1) return toast("最後のページは削除できません", true); if (confirm(`「${pg.name}」を削除？`)) { await api("DELETE", `/api/pages/${pg.id}`); await refreshPagesKeepIdx(); } };
    pl.appendChild(it);
  });
}
$("btnAddPage").onclick = async () => {
  if (!canEdit()) return toast("権限がありません", true);
  const n = prompt("新しいページ名", "新規ページ"); if (!n) return;
  const topPages = PAGES.filter(p => !p.parent_id);
  let parentId = null;
  if (topPages.length > 0) {
    const opts = ["なし（トップレベル）", ...topPages.map(p => p.name)];
    const idx = opts.indexOf(prompt("親ページ（下層ページにする場合選択）:\n" + opts.map((o, i) => i + ": " + o).join("\n") + "\n\n番号を入力（0でトップレベル）", "0"));
    if (idx > 0) parentId = topPages[idx - 1].id;
  }
  const { page } = await api("POST", "/api/pages", { name: n, parentId });
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
    case "hero": h = `<div class="field"><label>タイトル</label><input type="text" data-f="title" value="${esc(b.title)}"></div><div class="field"><label>サブテキスト</label><input type="text" data-f="sub" value="${esc(b.sub)}"></div><div class="field"><label>ボタン文字</label><input type="text" data-f="btn" value="${esc(b.btn)}"></div><div class="field"><label>ボタンリンク</label><input type="text" data-f="href" value="${esc(b.href)}"></div><div class="field row"><div><label>背景色</label><input type="color" data-f="bg" value="${b.bg||'#5b8cff'}"></div><div><label>文字色</label><input type="color" data-f="color" value="${b.color||'#ffffff'}"></div></div>
        <div class="field row"><div><label>グラデ第2色</label><input type="color" data-f="bg2" value="${b.bg2||'#a855f7'}"></div><div style="flex:2"><label>背景画像URL(任意)</label><input type="url" data-f="img" value="${esc(b.img||"")}"></div></div>
        <div class="field"><label>✨ アニメーションスタイル</label><select data-f="heroStyle"><option value="default" ${(b.heroStyle||'default')==='default'?'selected':''}>デフォルト（固定色）</option><option value="gradient" ${b.heroStyle==='gradient'?'selected':''}>グラデーションアニメ</option><option value="particles" ${b.heroStyle==='particles'?'selected':''}>パーティクル</option></select></div>
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
    const { blocks, note, accent, heroStyle } = await api("POST", "/api/ai/import-url", { url });
    // heroStyle を hero ブロックに自動適用
    if (heroStyle && heroStyle !== "default") blocks.filter(b => b.type === "hero").forEach(b => { b.heroStyle = heroStyle; });
    blocks.forEach(reId);
    const heroTag = heroStyle && heroStyle !== "default" ? ` <span style="font-size:11px;background:var(--accent);color:#fff;border-radius:4px;padding:2px 7px">${heroStyle}</span>` : "";
    openModal(`<h2>🔗 取込結果（${blocks.length}ブロック）${heroTag}</h2><p style="font-size:13px;color:var(--muted)">${esc(note)}</p>
      ${accent ? `<p style="font-size:13px">推奨アクセント色: <span style="display:inline-block;width:14px;height:14px;background:${esc(accent)};border-radius:3px;vertical-align:-2px"></span> ${esc(accent)}</p>` : ""}
      <div class="modal-actions"><button class="tbtn" onclick="closeModal()">キャンセル</button>
      <button class="tbtn" id="iuAppend">末尾に追加</button>
      <button class="tbtn primary" id="iuReplace">置き換え${accent ? "＋配色適用" : ""}</button></div>`);
    const applyAccent = async () => { if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) { SITE.settings.accent = accent; await api("PUT", "/api/site/settings", { settings: SITE.settings }); applySiteVars(); } };
    $("iuAppend").onclick = () => { curPage().blocks.push(...blocks); afterAI(); };
    $("iuReplace").onclick = async () => { curPage().blocks = blocks; await applyAccent(); afterAI(); };
  } catch (e) { $("aiUrlOut").textContent = "エラー: " + e.message; }
  btn.innerHTML = "構成を取り込む"; btn.disabled = false;
};

/* ============ AIカスタムCSS（サイドバー） ============ */
$("aiCssBtn").onclick = async () => {
  const btn = $("aiCssBtn"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span> 生成中…`;
  $("aiCssOut").textContent = "";
  try {
    const mood = $("aiCssMood").value.trim() || "モダン";
    const { css, heroStyle, note } = await api("POST", "/api/ai/custom-css", { mood });
    SITE.settings.customCss = css;
    await api("PUT", "/api/site/settings", { settings: SITE.settings });
    applySiteVars(); renderCanvas();
    $("aiCssOut").textContent = `✓ ${note}${heroStyle !== "default" ? ` / hero推奨: ${heroStyle}` : ""}`;
    toast("カスタムCSSを適用しました");
  } catch (e) { $("aiCssOut").textContent = "エラー: " + e.message; }
  btn.disabled = false; btn.innerHTML = "✨ CSSを生成して適用";
};

/* ============ テンプレート集 ============ */
const TEMPLATES = {
  "コーポレート": [
    { type:"hero", title:"信頼を、かたちに。", sub:"創業以来20年、〇〇分野で社会に貢献し続けています", btn:"会社案内を見る", href:"#about", bg:"#1f2937", color:"#fff", img:"" },
    { type:"stats", items:[{num:"20年",label:"創業"},{num:"300社",label:"取引実績"},{num:"98%",label:"継続率"},{num:"全国",label:"対応エリア"}] },
    { type:"spacer", height:16 },
    { type:"heading", text:"私たちについて", level:"h2", align:"center" },
    { type:"text", html:"私たちは〇〇分野において、お客様の課題を深く理解し、最適なソリューションを提供することを使命としています。<br>業界のプロフェッショナルとして、誠実さと技術力で信頼にお応えします。", align:"center", size:16 },
    { type:"spacer", height:24 },
    { type:"heading", text:"事業内容", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"💡 コンサルティング",level:"h3",align:"center"},{type:"text",html:"課題を整理し最適な解決策をご提案します。豊富な事例と独自のメソッドで、貴社の成長をサポートします。",align:"center",size:14},{type:"button",text:"詳しく見る",href:"#consulting",align:"center"}],
      [{type:"heading",text:"🛠 システム開発",level:"h3",align:"center"},{type:"text",html:"確かな技術力とアジャイル開発で、高品質なシステムを短期間で構築します。保守・運用まで一貫対応。",align:"center",size:14},{type:"button",text:"詳しく見る",href:"#dev",align:"center"}],
      [{type:"heading",text:"🤝 継続サポート",level:"h3",align:"center"},{type:"text",html:"導入後も安心の専任担当制。定期レビューと迅速な対応で、長期的な成果を共に追いかけます。",align:"center",size:14},{type:"button",text:"詳しく見る",href:"#support",align:"center"}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"選ばれる理由", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"実績に裏付けられた提案力",level:"h3",align:"left"},{type:"text",html:"300社以上の支援実績をもとに、業界・規模を問わず最適な打ち手をご提案します。",align:"left",size:14}],
      [{type:"heading",text:"ワンストップ対応",level:"h3",align:"left"},{type:"text",html:"戦略立案から実行・運用まで、外部委託先を増やすことなくすべてお任せいただけます。",align:"left",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"お客様の声", level:"h2", align:"center" },
    { type:"quote", text:"導入から3か月で業務効率が40%改善。担当者の寄り添う姿勢に感謝しています。", cite:"製造業 営業部長" },
    { type:"quote", text:"他社に断られた複雑な要件を見事に実現してくれました。技術力と対応力に驚いています。", cite:"IT企業 CTO" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"初めての相談から契約までどのくらいかかりますか？",a:"ヒアリングから提案書提出まで通常1〜2週間です。お急ぎの場合はご相談ください。"},{q:"小規模な企業でも相談できますか？",a:"はい、規模を問わずご相談いただけます。スモールスタートのプランもご用意しています。"},{q:"費用の目安を教えてください。",a:"プロジェクト規模により異なります。まずは無料相談でご要件をお聞かせください。"},{q:"オンラインでの対応は可能ですか？",a:"全国対応可能です。ビデオ会議を活用したリモート支援も積極的に行っています。"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"お問い合わせ", level:"h2", align:"center" },
    { type:"form", submitLabel:"送信する", fields:[{label:"会社名",type:"text",required:true},{label:"お名前",type:"text",required:true},{label:"メールアドレス",type:"email",required:true},{label:"電話番号",type:"text",required:false},{label:"お問い合わせ内容",type:"textarea",required:true}] },
    { type:"cta", title:"まずは無料相談から", sub:"60分のオンライン相談を無料で承ります", btn:"無料相談を予約する", href:"#contact", bg:"", color:"#fff", cv:true } ],

  "飲食店": [
    { type:"hero", title:"こだわりの一皿を、あなたへ。", sub:"地元農家と直契約。旬の食材を活かした季節のコース料理", btn:"メニューを見る", href:"#menu", bg:"#b45309", color:"#fff", img:"" },
    { type:"stats", items:[{num:"20年",label:"地域に愛されて"},{num:"食材",label:"地元産95%"},{num:"4.8",label:"お客様評価"},{num:"個室",label:"完備"}] },
    { type:"spacer", height:16 },
    { type:"heading", text:"当店のこだわり", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"🌾 産地直送の食材",level:"h3",align:"center"},{type:"text",html:"地元の農家と直接契約し、採れたての野菜・肉・魚を毎朝仕入れています。新鮮さがそのまま味になります。",align:"center",size:14}],
      [{type:"heading",text:"🔥 伝統と革新の料理",level:"h3",align:"center"},{type:"text",html:"20年培った技術に現代のエッセンスを融合。飽きのこない「また来たい」を追求しています。",align:"center",size:14}],
      [{type:"heading",text:"🍷 充実のドリンク",level:"h3",align:"center"},{type:"text",html:"ソムリエ厳選のワインとペアリング提案も好評です。ノンアルコールも充実。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"おすすめメニュー", level:"h2", align:"center" },
    { type:"text", html:"旬の食材を使った料理を毎月ご用意しています。季節ごとに変わるスペシャルコースもお楽しみください。", align:"center", size:16 },
    { type:"columns", cols:[
      [{type:"image",src:"",alt:"季節のコース",width:100,radius:10,align:"center"},{type:"heading",text:"季節のおまかせコース",level:"h3",align:"center"},{type:"text",html:"¥6,600〜 / お一人様<br>前菜・スープ・メイン・デザート付",align:"center",size:13}],
      [{type:"image",src:"",alt:"看板メニュー",width:100,radius:10,align:"center"},{type:"heading",text:"当店名物 〇〇鍋",level:"h3",align:"center"},{type:"text",html:"¥3,300 / 一人前<br>2名様〜ご注文可能",align:"center",size:13}],
      [{type:"image",src:"",alt:"ランチ",width:100,radius:10,align:"center"},{type:"heading",text:"平日ランチセット",level:"h3",align:"center"},{type:"text",html:"¥1,100〜<br>11:30〜14:00（土日祝は休み）",align:"center",size:13}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"お客様の声", level:"h2", align:"center" },
    { type:"quote", text:"記念日に利用しました。料理もサービスも最高で、忘れられない夜になりました。ありがとうございます。", cite:"30代 ご夫婦" },
    { type:"quote", text:"接待で何度も使っています。大切なお客様に自信を持ってご案内できるお店です。", cite:"50代 会社経営者" },
    { type:"spacer", height:24 },
    { type:"heading", text:"営業時間・アクセス", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"営業時間",level:"h3",align:"left"},{type:"list",items:["ランチ　11:30〜14:00（月〜金）","ディナー　17:30〜22:00（L.O. 21:00）","定休日：火曜日"],ordered:false,align:"left"}],
      [{type:"heading",text:"アクセス",level:"h3",align:"left"},{type:"text",html:"〇〇線「〇〇駅」徒歩3分<br>駐車場：近隣コインパーキングをご利用ください",align:"left",size:14}] ]},
    { type:"map", query:"東京都渋谷区", height:300 },
    { type:"spacer", height:24 },
    { type:"heading", text:"ご予約", level:"h2", align:"center" },
    { type:"text", html:"お席の確保のため、ご予約をお勧めしています。当日でもお気軽にお電話ください。", align:"center", size:15 },
    { type:"form", submitLabel:"予約を申し込む", fields:[{label:"お名前",type:"text",required:true},{label:"電話番号",type:"text",required:true},{label:"メールアドレス",type:"email",required:true},{label:"ご希望日時",type:"text",required:true},{label:"人数",type:"text",required:true},{label:"ご要望・アレルギー等",type:"textarea",required:false}] },
    { type:"cta", title:"本日のご予約はお電話でも承ります", sub:"Tel: 0X-XXXX-XXXX（11:00〜21:00）", btn:"予約フォームへ", href:"#reserve", bg:"", color:"#fff", cv:true } ],

  "ポートフォリオ": [
    { type:"hero", title:"あなたのビジョンを、かたちにします。", sub:"UI/UXデザイナー & フロントエンドエンジニア / 〇〇 〇〇", btn:"作品を見る", href:"#works", bg:"#0f766e", color:"#fff", img:"", heroStyle:"gradient" },
    { type:"spacer", height:16 },
    { type:"heading", text:"About Me", level:"h2", align:"left" },
    { type:"columns", cols:[
      [{type:"image",src:"",alt:"プロフィール写真",width:80,radius:50,align:"center"}],
      [{type:"text",html:"東京を拠点に活動するデザイナー／エンジニアです。スタートアップから大手企業まで、100件以上のプロジェクトに携わってきました。<br><br>「使いやすく、美しいものを作る」を信条に、ユーザーの体験を最優先に考えたデザインを提供しています。",align:"left",size:15}] ]},
    { type:"list", items:["UI/UXデザイン（Figma, Adobe XD）","フロントエンド開発（React, Next.js, TypeScript）","ブランドデザイン・ロゴ制作","Webサイト設計・制作"], ordered:false, align:"left" },
    { type:"spacer", height:24 },
    { type:"stats", items:[{num:"100+",label:"制作実績"},{num:"5年",label:"経験"},{num:"4.9",label:"クライアント評価"},{num:"3日",label:"初回提案"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"Works", level:"h2", align:"left" },
    { type:"text", html:"直近の制作実績の一部です。詳細はお気軽にお問い合わせください。", align:"left", size:15 },
    { type:"columns", cols:[
      [{type:"image",src:"",alt:"作品1",width:100,radius:8,align:"center"},{type:"heading",text:"ECサイトリニューアル",level:"h3",align:"center"},{type:"text",html:"UI設計 / フロント実装<br>CVR +35% 達成",align:"center",size:13}],
      [{type:"image",src:"",alt:"作品2",width:100,radius:8,align:"center"},{type:"heading",text:"SaaSダッシュボード",level:"h3",align:"center"},{type:"text",html:"UXリサーチ / プロトタイプ<br>ユーザー離脱率 -28%",align:"center",size:13}],
      [{type:"image",src:"",alt:"作品3",width:100,radius:8,align:"center"},{type:"heading",text:"採用ブランディング",level:"h3",align:"center"},{type:"text",html:"VI設計 / Web制作<br>応募数 3倍増",align:"center",size:13}] ]},
    { type:"columns", cols:[
      [{type:"image",src:"",alt:"作品4",width:100,radius:8,align:"center"},{type:"heading",text:"モバイルアプリUI",level:"h3",align:"center"},{type:"text",html:"iOS/Androidデザイン<br>App Store 評価 4.7",align:"center",size:13}],
      [{type:"image",src:"",alt:"作品5",width:100,radius:8,align:"center"},{type:"heading",text:"コーポレートサイト",level:"h3",align:"center"},{type:"text",html:"ブランド刷新 / 実装<br>問い合わせ数 2倍",align:"center",size:13}],
      [{type:"image",src:"",alt:"作品6",width:100,radius:8,align:"center"},{type:"heading",text:"LP制作",level:"h3",align:"center"},{type:"text",html:"広告LP A/Bテスト<br>CVR 8.2% 達成",align:"center",size:13}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"制作の流れ", level:"h2", align:"center" },
    { type:"list", items:["① ヒアリング（目標・ターゲット・予算の確認）","② 提案・見積もり（3営業日以内）","③ デザイン制作・フィードバック（2回まで無料修正）","④ 実装・納品（データ or コード納品）","⑤ アフターサポート（1ヶ月間無料）"], ordered:false, align:"left" },
    { type:"spacer", height:24 },
    { type:"quote", text:"丁寧なヒアリングと、想像以上のアウトプットに感動しました。またお願いしたいです。", cite:"スタートアップ CEO" },
    { type:"spacer", height:24 },
    { type:"heading", text:"お問い合わせ", level:"h2", align:"center" },
    { type:"text", html:"お仕事のご依頼・ご相談はフォームよりお気軽にどうぞ。通常2営業日以内にご返信します。", align:"center", size:15 },
    { type:"form", submitLabel:"送信する", fields:[{label:"お名前",type:"text",required:true},{label:"メールアドレス",type:"email",required:true},{label:"ご依頼内容・ご予算",type:"textarea",required:true}] },
    { type:"cta", title:"まずはカジュアルにご相談を", sub:"30分の無料相談を随時受け付けています", btn:"相談を予約する", href:"#contact", bg:"", color:"#fff", cv:true } ],

  "LP（ランディングページ）": [
    { type:"hero", title:"その悩み、これで解決。", sub:"導入実績10,000社突破。今なら30日間無料トライアル実施中", btn:"今すぐ無料で試す", href:"#cta", bg:"#f97316", color:"#fff", img:"", ab:true, titleB:"たった3ステップで始められる。" },
    { type:"stats", items:[{num:"10,000+",label:"導入実績"},{num:"98%",label:"継続率"},{num:"3分",label:"導入時間"},{num:"24h",label:"サポート"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"こんなお悩みはありませんか？", level:"h2", align:"center" },
    { type:"list", items:["作業に時間がかかりすぎて本業に集中できない","コストを削減したいがどこから手をつければ良いかわからない","既存のツールでは対応しきれない課題がある","チームの生産性をもっと上げたい"], ordered:false, align:"center" },
    { type:"spacer", height:8 },
    { type:"text", html:"<strong>そのお悩み、〇〇サービスで解決できます。</strong>", align:"center", size:18 },
    { type:"spacer", height:24 },
    { type:"heading", text:"選ばれる3つの理由", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"⚡ 即日スタート",level:"h3",align:"center"},{type:"text",html:"登録から3分で利用開始。複雑な設定は一切不要です。IT知識がなくても安心してお使いいただけます。",align:"center",size:14}],
      [{type:"heading",text:"💰 コスト削減",level:"h3",align:"center"},{type:"text",html:"従来比平均60%のコスト削減を実現した実績あり。無駄なコストを徹底的に排除します。",align:"center",size:14}],
      [{type:"heading",text:"🛡 手厚いサポート",level:"h3",align:"center"},{type:"text",html:"専任の担当者が導入から定着まで伴走します。チャット・電話・メールで24時間対応。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"導入事例", level:"h2", align:"center" },
    { type:"quote", text:"導入後3か月で業務工数を50%削減。スタッフの残業がほぼゼロになりました。コスパも最高です。", cite:"小売業 A社 代表取締役" },
    { type:"quote", text:"他ツールを試しましたがこれが一番使いやすかったです。サポートの対応も丁寧で安心できました。", cite:"製造業 B社 管理部長" },
    { type:"spacer", height:24 },
    { type:"heading", text:"ご利用の流れ", level:"h2", align:"center" },
    { type:"list", items:["① 無料登録（1分・クレジットカード不要）","② 初期設定サポート（担当者がリモートでサポート）","③ チームに展開（招待メール一発）","④ 効果確認（30日後に専任担当がレビュー）"], ordered:false, align:"center" },
    { type:"spacer", height:24 },
    { type:"heading", text:"料金プラン", level:"h2", align:"center" },
    { type:"pricing", plans:[{name:"スターター",price:"無料",features:["1ユーザー","基本機能","メールサポート"],featured:false},{name:"スタンダード",price:"¥4,980/月",features:["10ユーザー","全機能","チャットサポート","API連携"],featured:true},{name:"エンタープライズ",price:"要相談",features:["無制限","専任担当","SLA保証","カスタマイズ対応"],featured:false}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"無料トライアル後に自動課金されますか？",a:"されません。トライアル期間終了後、ご希望のプランをお選びいただく仕組みです。"},{q:"途中でプランを変更できますか？",a:"いつでも変更可能です。アップグレードは即時反映、ダウングレードは翌月から適用されます。"},{q:"データのセキュリティは大丈夫ですか？",a:"ISO27001取得済みのサーバーで管理し、すべての通信を暗号化しています。"},{q:"解約はいつでもできますか？",a:"いつでも可能です。違約金・解約手数料は一切ありません。"},{q:"導入支援は受けられますか？",a:"全プランで導入サポートを提供しています。専任担当が初期設定から定着まで伴走します。"}] },
    { type:"spacer", height:24 },
    { type:"cta", title:"今すぐ30日間無料で試す", sub:"クレジットカード不要・いつでも解約可能", btn:"無料トライアルを始める", href:"#cta", bg:"", color:"#fff", cv:true } ],

  "採用サイト": [
    { type:"hero", title:"一緒に未来をつくる仲間を募集しています。", sub:"挑戦を歓迎する文化で、あなたの可能性を最大限に。", btn:"募集要項を見る", href:"#jobs", bg:"#0f766e", color:"#fff", img:"" },
    { type:"stats", items:[{num:"45名",label:"在籍社員"},{num:"30%",label:"年成長率"},{num:"4.6",label:"社員満足度"},{num:"正社員",label:"転換率90%"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"私たちのミッション", level:"h2", align:"center" },
    { type:"text", html:"〇〇を通じて、人々の生活をより豊かにすること。<br>それが私たちの存在意義であり、日々の仕事の原動力です。", align:"center", size:18 },
    { type:"spacer", height:24 },
    { type:"heading", text:"働く環境・制度", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"🏠 フルリモート可",level:"h3",align:"center"},{type:"text",html:"全職種でリモート勤務に対応。出社は月1〜2回程度のチームMTGのみ。",align:"center",size:14}],
      [{type:"heading",text:"⏰ フレックス制",level:"h3",align:"center"},{type:"text",html:"コアタイムは11〜15時のみ。子育て・介護中の社員も安心して働けます。",align:"center",size:14}],
      [{type:"heading",text:"📈 成長支援",level:"h3",align:"center"},{type:"text",html:"年30万円の学習支援制度。書籍・資格・外部研修すべて会社負担。",align:"center",size:14}],
      [{type:"heading",text:"💰 インセンティブ",level:"h3",align:"center"},{type:"text",html:"成果に応じたインセンティブ制度あり。前職給与保証の相談も可能です。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"数字で見る私たちの職場", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"stats",items:[{num:"20代",label:"社員平均年齢28歳"},{num:"45%",label:"女性比率"}]}],
      [{type:"stats",items:[{num:"0日",label:"有給取得率98%"},{num:"2年",label:"平均在籍年数"}]}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"社員の声", level:"h2", align:"center" },
    { type:"quote", text:"裁量が大きく、入社半年でプロジェクトリーダーを任せてもらえました。成長スピードが段違いです。", cite:"エンジニア 28歳 / 2023年入社" },
    { type:"quote", text:"子育て中ですが、柔軟な働き方のおかげでキャリアを諦めずに済んでいます。チームの理解もあり本当に感謝しています。", cite:"デザイナー 32歳 / 育休復帰後" },
    { type:"spacer", height:24 },
    { type:"heading", text:"募集職種", level:"h2", align:"center" },
    { type:"jobs", items:[{title:"シニアエンジニア",type:"正社員",desc:"バックエンド/フロントエンド。モダンな技術スタックで開発"},{title:"UIUXデザイナー",type:"正社員",desc:"ユーザー体験を一気通貫で設計・実装"},{title:"プロダクトマネージャー",type:"正社員",desc:"新機能の企画から市場投入までリード"},{title:"カスタマーサクセス",type:"正社員/契約",desc:"顧客の成功を伴走支援"},{title:"マーケティング",type:"業務委託",desc:"コンテンツ〜広告運用まで幅広く担当"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"選考の流れ", level:"h2", align:"center" },
    { type:"list", items:["① 書類選考（1週間以内に連絡）","② カジュアル面談（オンライン・30分）","③ 技術課題 or 職種別ワーク","④ 最終面接（代表と直接対話）","⑤ 内定〜入社日調整（最短2週間）"], ordered:false, align:"center" },
    { type:"spacer", height:24 },
    { type:"heading", text:"社員紹介", level:"h2", align:"center" },
    { type:"team", members:[{name:"山田 太郎",role:"エンジニアリードエンジニア",img:""},{name:"佐藤 花子",role:"シニアデザイナー",img:""},{name:"鈴木 一郎",role:"プロダクトマネージャー",img:""},{name:"田中 真由",role:"カスタマーサクセス",img:""}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"カジュアル面談だけでも参加できますか？",a:"もちろんです。転職を迷っている段階でも大歓迎です。"},{q:"副業・兼業は可能ですか？",a:"申請制で可能です。競合他社への就業はご遠慮いただいています。"},{q:"選考中に職場見学はできますか？",a:"ご希望の方には、最終面接前後に職場見学をご案内しています。"},{q:"エンジニア未経験でも応募できますか？",a:"一部ポジションでは未経験者歓迎です。詳細は各募集要項をご確認ください。"}] },
    { type:"cta", title:"あなたの挑戦をお待ちしています", sub:"まずはカジュアル面談からどうぞ。気軽にお話しましょう。", btn:"カジュアル面談に申込む", href:"#apply", bg:"", color:"#fff", cv:true } ],

  "美容室": [
    { type:"hero", title:"なりたいを、かなえる。", sub:"あなたに似合うスタイルを一緒に見つけます。全席半個室で、くつろぎの時間を。", btn:"ご予約はこちら", href:"#reserve", bg:"#9d174d", color:"#fff", img:"" },
    { type:"stats", items:[{num:"15年",label:"地域密着"},{num:"4.9",label:"お客様評価"},{num:"完全",label:"予約制"},{num:"全席",label:"半個室"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"当店のこだわり", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"🌿 髪と頭皮に優しい薬剤",level:"h3",align:"center"},{type:"text",html:"ダメージを最小限に抑えたオーガニック系薬剤を厳選。髪の毛本来の美しさを引き出します。",align:"center",size:14}],
      [{type:"heading",text:"👂 丁寧なカウンセリング",level:"h3",align:"center"},{type:"text",html:"施術前の15分カウンセリングでご要望を徹底確認。「なんか違う」を限りなくゼロにします。",align:"center",size:14}],
      [{type:"heading",text:"✨ 再現しやすいスタイル",level:"h3",align:"center"},{type:"text",html:"ご自宅でも同じスタイリングができるよう、ブローの仕方やスタイリング剤をアドバイスします。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"メニュー・料金", level:"h2", align:"center" },
    { type:"pricing", plans:[{name:"カット",price:"¥4,400",features:["シャンプー・ブロー込","スタイリングアドバイス","所要60〜90分"],featured:false},{name:"カラー＋カット",price:"¥9,900",features:["人気No.1","トリートメント付","根元〜毛先まで対応","所要120〜150分"],featured:true},{name:"パーマ＋カット",price:"¥11,000",features:["デジタルパーマ可","ダメージレス処理","所要150〜180分"],featured:false}] },
    { type:"text", html:"※ロング料金あり。詳細はご予約時にお問い合わせください。初回限定トリートメント無料サービス中。", align:"center", size:12 },
    { type:"spacer", height:24 },
    { type:"heading", text:"スタイリスト紹介", level:"h2", align:"center" },
    { type:"team", members:[{name:"鈴木 美咲",role:"店長 / 15年経験 / カラー得意",img:""},{name:"高橋 健",role:"スタイリスト / 8年経験 / パーマ得意",img:""},{name:"山田 葵",role:"スタイリスト / 5年経験 / カット得意",img:""}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"お客様の声", level:"h2", align:"center" },
    { type:"quote", text:"カウンセリングが丁寧で、なんとなくのイメージを完璧に形にしてくれました。毎回お任せしています！", cite:"20代 女性 / リピーター" },
    { type:"quote", text:"ハイダメージ毛でも断らずに丁寧に対応してくれました。仕上がりも大満足です。", cite:"30代 女性" },
    { type:"quote", text:"男性でも居心地が良く、毎回気持ちよく帰れます。スタイルの提案も的確。", cite:"40代 男性" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"初めてでも予約できますか？",a:"もちろんです。初回の方には事前アンケートをお送りし、スムーズなカウンセリングに活かしています。"},{q:"子連れでも大丈夫ですか？",a:"はい、キッズスペースをご用意しています。事前にご連絡いただけると助かります。"},{q:"当日キャンセルはできますか？",a:"前日までのご連絡をお願いしています。当日キャンセルはキャンセル料をいただく場合があります。"},{q:"駐車場はありますか？",a:"店舗隣に無料駐車場を2台分ご用意しています。満車の場合は近隣のコインパーキングをご利用ください。"}] },
    { type:"heading", text:"アクセス", level:"h2", align:"center" },
    { type:"map", query:"東京都渋谷区", height:300 },
    { type:"spacer", height:16 },
    { type:"cta", title:"ご予約はお気軽に", sub:"24時間オンライン予約受付中 / 当日予約もお電話にて承ります", btn:"今すぐ予約する", href:"#reserve", bg:"", color:"#fff", cv:true } ],

  "クリニック・歯科": [
    { type:"hero", title:"地域のかかりつけ医として、30年。", sub:"安心と信頼の医療をお届けします。WEB予約で待ち時間を短縮。", btn:"WEB予約をする", href:"#reserve", bg:"#0369a1", color:"#fff" },
    { type:"stats", items:[{num:"30年",label:"地域医療の実績"},{num:"5万件",label:"年間診療実績"},{num:"土日",label:"診療対応"},{num:"3分",label:"WEB予約完了"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"院長あいさつ", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"image",src:"",alt:"院長写真",width:80,radius:50,align:"center"}],
      [{type:"text",html:"「患者様の笑顔が私たちの活力です」<br><br>30年間、地域の皆さまの健康を守ることを使命として診療を続けてきました。どんな小さな不安も、気軽に相談いただける「かかりつけ医」でありたいと思っています。",align:"left",size:15},{type:"text",html:"院長 ○○ ○○（医学博士）",align:"left",size:13}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"診療科目・サービス", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"🩺 一般内科",level:"h3",align:"center"},{type:"text",html:"風邪・発熱から生活習慣病まで。幅広く対応します。",align:"center",size:14}],
      [{type:"heading",text:"👶 小児科",level:"h3",align:"center"},{type:"text",html:"0歳からの子どもの体調管理。予防接種・健診も行っています。",align:"center",size:14}],
      [{type:"heading",text:"💉 予防・健診",level:"h3",align:"center"},{type:"text",html:"各種ワクチン接種、特定健診、インフルエンザ対応。",align:"center",size:14}],
      [{type:"heading",text:"💻 オンライン診療",level:"h3",align:"center"},{type:"text",html:"再診・慢性疾患の処方更新はオンラインで。外出困難な方にも対応。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"診療時間", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"list",items:["月〜金：9:00〜12:30 / 14:00〜18:00","土　　：9:00〜13:00","日・祝日：休診","※急患は時間外でもご相談ください"],ordered:false,align:"left"}],
      [{type:"text",html:"<strong>アクセス</strong><br>〇〇線「〇〇駅」徒歩5分<br>駐車場：10台（無料）<br>バリアフリー対応",align:"left",size:14}] ]},
    { type:"map", query:"東京都新宿区", height:300 },
    { type:"spacer", height:24 },
    { type:"heading", text:"患者様の声", level:"h2", align:"center" },
    { type:"quote", text:"子どもが怖がらずに診てもらえます。先生の説明が丁寧で、親も安心して通えています。", cite:"30代 お母様" },
    { type:"quote", text:"WEB予約が便利で、待ち時間が大幅に減りました。慢性疾患の管理もしっかりフォローしてもらえています。", cite:"60代 男性" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"予約なしで受診できますか？",a:"当日受付も承っています。ただしWEB予約の方を優先するため、待ち時間が長くなる場合があります。"},{q:"保険証を忘れた場合は？",a:"その日は自費診療になりますが、後日保険証をお持ちいただければ差額を返金します。"},{q:"薬だけもらいに行ってもいいですか？",a:"再診として診察を行ってから処方する形となります。オンライン診療もご活用ください。"},{q:"紹介状はもらえますか？",a:"専門的な治療が必要な場合、適切な医療機関への紹介状を作成しています。"},{q:"乳幼児健診は受けられますか？",a:"1ヶ月・3〜4ヶ月・6〜7ヶ月・9〜10ヶ月・1歳の乳幼児健診に対応しています。"}] },
    { type:"cta", title:"WEB予約で待ち時間を短縮", sub:"24時間いつでも予約できます", btn:"今すぐWEB予約", href:"#reserve", bg:"", color:"#fff", cv:true } ],

  "不動産": [
    { type:"hero", title:"理想の住まい、ここで見つかる。", sub:"地域密着20年。売買・賃貸・管理まで、あなたの住まいを一生サポート。", btn:"物件を探す", href:"#search", bg:"#166534", color:"#fff" },
    { type:"stats", items:[{num:"20年",label:"地域密着"},{num:"3,500件",label:"取扱物件数"},{num:"98%",label:"成約満足度"},{num:"無料",label:"住宅ローン相談"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"サービス一覧", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"🏠 売買仲介",level:"h3",align:"center"},{type:"text",html:"はじめての売買も安心のフルサポート。資金計画から引き渡しまで専任担当が伴走します。",align:"center",size:14}],
      [{type:"heading",text:"🔑 賃貸仲介",level:"h3",align:"center"},{type:"text",html:"豊富な物件データベースからご希望の条件にぴったりの物件をご提案。内見も即日対応。",align:"center",size:14}],
      [{type:"heading",text:"🏢 賃貸管理",level:"h3",align:"center"},{type:"text",html:"オーナー様の資産価値を最大化。空室対策・入居者管理・修繕対応まですべてお任せ。",align:"center",size:14}],
      [{type:"heading",text:"💰 無料査定",level:"h3",align:"center"},{type:"text",html:"売却をご検討中の方へ。市場に基づいた根拠ある無料査定を実施中。秘密厳守。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"お客様の声", level:"h2", align:"center" },
    { type:"quote", text:"初めての家購入でしたが、担当の方が全ステップを丁寧に説明してくれて不安なく進められました。本当に感謝しています。", cite:"30代 ご夫婦 / 一戸建て購入" },
    { type:"quote", text:"査定から売却完了まで2ヶ月。想定より高く売れて大満足です。プロの提案力に脱帽しました。", cite:"50代 男性 / マンション売却" },
    { type:"spacer", height:24 },
    { type:"heading", text:"物件探しの流れ", level:"h2", align:"center" },
    { type:"list", items:["① ご希望ヒアリング（来店 or オンライン）","② 物件提案（3〜5件厳選してご案内）","③ 内見（日程調整から同行まで対応）","④ 申し込み・ローン審査サポート","⑤ 契約・引き渡し（完全フォロー）","⑥ アフターサポート（引き渡し後も安心）"], ordered:false, align:"center" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"相談だけでも来店できますか？",a:"はい、物件探しから資金計画まで、お気軽にご相談ください。費用は一切かかりません。"},{q:"住宅ローンの相談も対応していますか？",a:"ファイナンシャルプランナーが在籍しており、最適なローン選びをサポートします。"},{q:"遠方でも対応できますか？",a:"オンライン相談・資料郵送に対応しています。全国からのご相談を承ります。"},{q:"売却と購入を同時に進められますか？",a:"売り先行・買い先行それぞれのメリット・リスクをご説明した上で最適な進め方をご提案します。"}] },
    { type:"heading", text:"アクセス", level:"h2", align:"center" },
    { type:"map", query:"東京都渋谷区", height:280 },
    { type:"cta", title:"無料査定・ご相談はこちら", sub:"毎日10:00〜19:00受付。オンライン相談も可能です", btn:"今すぐ無料相談", href:"#contact", bg:"", color:"#fff", cv:true } ],

  "ジム・フィットネス": [
    { type:"hero", title:"なりたい自分に、最短で。", sub:"専属トレーナーがマンツーマンで目標達成まで伴走。入会金0円・今なら初月50%OFF。", btn:"無料体験を予約する", href:"#trial", bg:"#b91c1c", color:"#fff" },
    { type:"stats", items:[{num:"-8kg",label:"平均3ヶ月での減量"},{num:"24h",label:"年中無休営業"},{num:"95%",label:"3ヶ月継続率"},{num:"0円",label:"入会金"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"こんな方におすすめ", level:"h2", align:"center" },
    { type:"list", items:["ダイエットに何度も失敗してきた","一人ではモチベーションが続かない","正しい筋トレフォームを教えてほしい","食事管理も含めてトータルサポートしてほしい","産後・シニアのボディメイクをしたい"], ordered:false, align:"center" },
    { type:"spacer", height:24 },
    { type:"heading", text:"当ジムの特徴", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"🏋 完全個室トレーニング",level:"h3",align:"center"},{type:"text",html:"他のお客様を気にせず集中できる完全個室。初心者の方も安心してスタートできます。",align:"center",size:14}],
      [{type:"heading",text:"🥗 食事指導込み",level:"h3",align:"center"},{type:"text",html:"トレーニングだけでなく、食事の見直しで結果を最大化。専属管理栄養士が監修。",align:"center",size:14}],
      [{type:"heading",text:"📱 アプリで進捗管理",level:"h3",align:"center"},{type:"text",html:"専用アプリで体重・食事・トレーニングを記録。チャットでいつでもトレーナーに相談できます。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"料金プラン", level:"h2", align:"center" },
    { type:"pricing", plans:[{name:"ライト",price:"¥19,800/月",features:["月4回（50分）","食事アドバイス","アプリ利用無料"],featured:false},{name:"スタンダード",price:"¥34,800/月",features:["月8回（50分）","人気No.1","食事+トレーニング指導","体組成測定月1回"],featured:true},{name:"集中プログラム",price:"¥49,800/月",features:["月16回","最短で結果を","管理栄養士サポート","週次振り返りあり"],featured:false}] },
    { type:"text", html:"※入会金0円。初月50%OFF実施中（体験当日入会限定）。", align:"center", size:12 },
    { type:"spacer", height:24 },
    { type:"heading", text:"お客様の変化", level:"h2", align:"center" },
    { type:"quote", text:"3ヶ月で-10kg達成。過去に何度も失敗しましたが、トレーナーさんのサポートで初めて続けられました。", cite:"30代 女性 / 3ヶ月で-10kg" },
    { type:"quote", text:"週2回のトレーニングで体脂肪率が8%も下がりました。筋肉量が増えて毎日が楽になっています。", cite:"40代 男性 / 体脂肪率-8%" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"運動が全くできないのですが大丈夫ですか？",a:"むしろ初心者の方が最初から正しいフォームで覚えられるので、効果が出やすいです。ご安心ください。"},{q:"体験後に入会を強制されますか？",a:"一切ありません。体験当日の勧誘も行いません。じっくりご検討ください。"},{q:"女性専用のトレーナーはいますか？",a:"女性トレーナーが複数在籍しています。ご希望の方はご予約時にお申し付けください。"},{q:"産後やシニアでも大丈夫ですか？",a:"はい、年齢・体力に合わせたプログラムをご用意しています。医師に運動を勧められた方もお気軽に。"}] },
    { type:"cta", title:"まずは無料体験から", sub:"手ぶらでOK / 今すぐ予約できます / 当日入会で初月50%OFF", btn:"無料体験を予約する", href:"#trial", bg:"", color:"#fff", cv:true } ],

  "学習塾・スクール": [
    { type:"hero", title:"「わかる」が「できる」になる塾。", sub:"一人ひとりの個性と目標に合わせたオーダーメイドの指導で、第一志望合格を全力サポート。", btn:"無料体験授業を申込む", href:"#trial", bg:"#7c3aed", color:"#fff" },
    { type:"stats", items:[{num:"92%",label:"第一志望合格率"},{num:"1対2",label:"個別指導"},{num:"全学年",label:"小学〜高校対応"},{num:"10年",label:"指導実績"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"当塾の特徴", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"📝 完全個別カリキュラム",level:"h3",align:"center"},{type:"text",html:"入塾時に詳細なテストと面談を実施。弱点・強みを把握した上で、ゴール逆算型の学習計画を作成します。",align:"center",size:14}],
      [{type:"heading",text:"📊 見える化で保護者も安心",level:"h3",align:"center"},{type:"text",html:"毎回の授業後に報告メールを送信。進捗・理解度・次回の課題を保護者の方にも共有します。",align:"center",size:14}],
      [{type:"heading",text:"💡 分かるまで教える",level:"h3",align:"center"},{type:"text",html:"「わからないまま進む」を徹底排除。理解できるまで何度でも丁寧に説明します。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"コース・対象学年", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"小学生コース",level:"h3",align:"left"},{type:"list",items:["基礎学力強化","中学受験対策","そろばん・英会話との連携も可"],ordered:false,align:"left"}],
      [{type:"heading",text:"中学生コース",level:"h3",align:"left"},{type:"list",items:["定期テスト対策","高校受験対策","英検・数検取得サポート"],ordered:false,align:"left"}],
      [{type:"heading",text:"高校・大学受験",level:"h3",align:"left"},{type:"list",items:["大学受験特化コース","共通テスト対策","推薦・総合型選抜サポート"],ordered:false,align:"left"}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"講師陣のご紹介", level:"h2", align:"center" },
    { type:"team", members:[{name:"田中 一郎",role:"塾長 / 元高校教師 / 数学担当",img:""},{name:"佐藤 友美",role:"英語専門 / TOEIC 990点",img:""},{name:"山本 大輝",role:"理科担当 / 大学院修了",img:""}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"合格実績（一部抜粋）", level:"h2", align:"center" },
    { type:"list", items:["東京大学・京都大学・早慶上智（複数名）","都立・私立難関高校（合格率92%）","医学部・薬学部（2024年度 5名）","中学受験 最難関中学 合格実績あり"], ordered:false, align:"center" },
    { type:"spacer", height:24 },
    { type:"heading", text:"保護者の声", level:"h2", align:"center" },
    { type:"quote", text:"他塾で伸び悩んでいた子どもが、3ヶ月で偏差値10アップ。先生との相性も良く楽しそうに通っています。", cite:"中学3年生の保護者" },
    { type:"quote", text:"毎回の報告メールが丁寧で、子どもの変化が手に取るようにわかります。信頼してお任せできます。", cite:"小学6年生の保護者" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"途中入塾はできますか？",a:"いつでも可能です。現在の学習状況を確認し、無理なく合流できるカリキュラムを作成します。"},{q:"自習室は使えますか？",a:"授業がない日も自習室を無料で利用できます。質問も随時受け付けています。"},{q:"オンライン受講は可能ですか？",a:"はい。遠方の方・部活が忙しい方もオンラインで同じ品質の授業を受けられます。"},{q:"月の授業回数が足りないときは？",a:"追加授業（有料）をいつでも申し込めます。試験前の集中対策も対応しています。"}] },
    { type:"cta", title:"無料体験授業 受付中", sub:"授業料・テキスト代すべて無料でお試しいただけます", btn:"体験授業に申し込む", href:"#trial", bg:"", color:"#fff", cv:true } ],

  "士業（法律・会計）": [
    { type:"hero", title:"あなたの課題に、専門家の力を。", sub:"豊富な実績と深い専門知識で、個人・法人のあらゆる法務・税務をサポートします。初回相談無料・秘密厳守。", btn:"無料相談を予約する", href:"#contact", bg:"#1e3a8a", color:"#fff" },
    { type:"stats", items:[{num:"3,000件",label:"相談実績"},{num:"20年",label:"業界経験"},{num:"初回",label:"相談無料"},{num:"24h",label:"メール対応"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"取扱業務", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"📜 相続・遺言",level:"h3",align:"center"},{type:"text",html:"相続トラブルの予防から遺産分割まで。円満な相続をご家族全員でご支援します。",align:"center",size:14}],
      [{type:"heading",text:"🏢 企業法務",level:"h3",align:"center"},{type:"text",html:"設立・契約書作成・労務対応・M&Aまで。経営者の頼れる顧問として机を並べます。",align:"center",size:14}],
      [{type:"heading",text:"💰 税務・会計",level:"h3",align:"center"},{type:"text",html:"確定申告・税務調査対応・節税対策。中小企業から個人事業主まで幅広く対応。",align:"center",size:14}],
      [{type:"heading",text:"🤝 ADR・調停",level:"h3",align:"center"},{type:"text",html:"裁判に頼らない早期解決。交渉・調停・仲裁で双方にとっての最善を追求します。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"私たちのアプローチ", level:"h2", align:"center" },
    { type:"list", items:["✅ まず「聞く」。依頼者の本当のゴールを理解してから動く","✅ 専門用語を使わず、わかりやすい言葉で説明","✅ 費用は事前に明示。追加請求は原則なし","✅ 複数士業のネットワークで、あらゆる課題にワンストップ対応"], ordered:false, align:"left" },
    { type:"spacer", height:24 },
    { type:"heading", text:"担当者紹介", level:"h2", align:"center" },
    { type:"team", members:[{name:"〇〇 〇〇",role:"代表弁護士 / 東京弁護士会",img:""},{name:"△△ △△",role:"税理士 / 中小企業診断士",img:""},{name:"□□ □□",role:"司法書士 / 相続専門",img:""}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"お客様の声", level:"h2", align:"center" },
    { type:"quote", text:"複雑な相続問題でしたが、丁寧に整理していただき、家族全員が納得できる形で解決できました。", cite:"60代 男性 / 相続案件" },
    { type:"quote", text:"契約書のリーガルチェックを定期的に依頼しています。素早い対応と的確な指摘で、トラブルを未然に防げています。", cite:"IT企業 代表取締役" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"費用の目安を教えてください。",a:"案件の種類・難易度によって異なります。初回面談で概算をお伝えします。着手金不要のプランもあります。"},{q:"相談だけでも来所できますか？",a:"初回60分の相談を無料で承っています。問題が小さいうちに相談いただくことをお勧めします。"},{q:"急ぎの案件でも対応できますか？",a:"緊急性の高い案件は優先的に対応します。まずはお電話でご連絡ください。"},{q:"遠方でも相談できますか？",a:"オンライン相談（Zoom等）に対応しています。全国からのご相談を承っています。"}] },
    { type:"spacer", height:24 },
    { type:"form", submitLabel:"無料相談を申し込む", fields:[{label:"お名前",type:"text",required:true},{label:"メールアドレス",type:"email",required:true},{label:"電話番号",type:"text",required:false},{label:"ご相談内容",type:"textarea",required:true}] },
    { type:"cta", title:"まずは無料相談から", sub:"60分・完全無料・オンライン対応可", btn:"今すぐ無料相談を予約", href:"#contact", bg:"", color:"#fff", cv:true } ],

  "ECショップ": [
    { type:"hero", title:"こだわりを、あなたの暮らしへ。", sub:"職人が手がけた厳選商品だけをお届けします。送料無料・30日間返品保証。", btn:"ショップを見る", href:"#shop", bg:"#9a3412", color:"#fff" },
    { type:"stats", items:[{num:"4.8",label:"平均レビュー評価"},{num:"5,000+",label:"累計注文数"},{num:"即日",label:"当日発送"},{num:"30日",label:"返品保証"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"当店のこだわり", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"🔍 厳選された商品だけ",level:"h3",align:"center"},{type:"text",html:"仕入れる商品は全体の10%以下。バイヤーが実際に使って納得したものだけを販売しています。",align:"center",size:14}],
      [{type:"heading",text:"🌱 環境に配慮した梱包",level:"h3",align:"center"},{type:"text",html:"緩衝材・ダンボールはすべて再生素材を使用。不要な過剰包装は行いません。",align:"center",size:14}],
      [{type:"heading",text:"🤝 アフターサポート充実",level:"h3",align:"center"},{type:"text",html:"購入後のご不明点にもスタッフが丁寧に対応。初心者の方も安心してお買い求めいただけます。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"人気商品", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"image",src:"",alt:"商品1",width:100,radius:10,align:"center"},{type:"heading",text:"〇〇 商品名",level:"h3",align:"center"},{type:"text",html:"¥3,200（税込）<br>⭐ 4.9 (238件のレビュー)",align:"center",size:13},{type:"button",text:"カートに入れる",href:"#",align:"center"}],
      [{type:"image",src:"",alt:"商品2",width:100,radius:10,align:"center"},{type:"heading",text:"△△ 商品名",level:"h3",align:"center"},{type:"text",html:"¥4,800（税込）<br>⭐ 4.8 (192件のレビュー)",align:"center",size:13},{type:"button",text:"カートに入れる",href:"#",align:"center"}],
      [{type:"image",src:"",alt:"商品3",width:100,radius:10,align:"center"},{type:"heading",text:"□□ 商品名",level:"h3",align:"center"},{type:"text",html:"¥2,500（税込）<br>⭐ 4.7 (341件のレビュー)",align:"center",size:13},{type:"button",text:"カートに入れる",href:"#",align:"center"}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"お客様のレビュー", level:"h2", align:"center" },
    { type:"quote", text:"品質が想像以上でした。写真と実物がほぼ同じで安心して購入できます。梱包も丁寧で好印象。", cite:"30代 女性 / リピーター" },
    { type:"quote", text:"プレゼント用に購入。受け取った友人にとても喜ばれました。次回もここで買います。", cite:"20代 男性" },
    { type:"spacer", height:24 },
    { type:"heading", text:"ご購入・配送について", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"配送",level:"h3",align:"left"},{type:"list",items:["全国一律送料無料（5,000円以上）","当日14時までの注文は当日発送","追跡番号をメールでお知らせ"],ordered:false,align:"left"}],
      [{type:"heading",text:"返品・保証",level:"h3",align:"left"},{type:"list",items:["30日間返品・交換保証","初期不良は送料当社負担","お問い合わせ24時間以内対応"],ordered:false,align:"left"}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"支払い方法を教えてください。",a:"クレジットカード（VISA/Mastercard/JCB）・PayPay・コンビニ払い・銀行振込に対応しています。"},{q:"ギフト包装はできますか？",a:"有料（¥330）でギフトラッピングをご用意しています。のしも承ります。"},{q:"領収書の発行はできますか？",a:"注文確定メールが領収書代わりとなります。宛名指定が必要な場合はお問い合わせください。"},{q:"海外への配送はできますか？",a:"現在は日本国内のみ対応しています。"}] },
    { type:"cta", title:"今すぐショップをチェック", sub:"新規会員登録で初回10%OFF。期間限定セール開催中。", btn:"ショップを見る", href:"#shop", bg:"", color:"#fff", cv:true } ],

  "ホテル・宿泊": [
    { type:"hero", title:"非日常の、特別なひととき。", sub:"自然に包まれた隠れ家リゾート。心からのおもてなしでお迎えします。", btn:"空室を確認する", href:"#reserve", bg:"#3f3f46", color:"#fff", heroStyle:"gradient" },
    { type:"stats", items:[{num:"4.9",label:"宿泊満足度"},{num:"全室",label:"絶景オーシャンビュー"},{num:"温泉",label:"天然温泉完備"},{num:"1日",label:"限定6組"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"当宿のこだわり", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"heading",text:"🌊 絶景のロケーション",level:"h3",align:"center"},{type:"text",html:"全室オーシャンビュー。波の音に包まれながら、日常を忘れた時間をお過ごしください。",align:"center",size:14}],
      [{type:"heading",text:"🍱 地元食材の懐石料理",level:"h3",align:"center"},{type:"text",html:"地元漁港直送の魚介と、旬の山の幸を活かした懐石料理。料理長自ら厳選した食材のみ使用。",align:"center",size:14}],
      [{type:"heading",text:"♨ 源泉掛け流し温泉",level:"h3",align:"center"},{type:"text",html:"自家源泉の天然温泉を贅沢に掛け流し。貸切露天風呂も無料でご利用いただけます。",align:"center",size:14}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"客室・宿泊プラン", level:"h2", align:"center" },
    { type:"pricing", plans:[{name:"スタンダード",price:"¥18,000〜",features:["1泊2食付","大浴場利用","チェックイン 15:00"],featured:false},{name:"プレミアム",price:"¥32,000〜",features:["人気No.1","1泊2食付","貸切温泉1回無料","ウェルカムドリンク","アーリーチェックイン可"],featured:true},{name:"特別スイート",price:"¥55,000〜",features:["露天風呂付客室","専任スタッフ","ディナーコース付","送迎サービス"],featured:false}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"施設のご案内", level:"h2", align:"center" },
    { type:"columns", cols:[
      [{type:"list",items:["大浴場（男女別 / 24h利用可）","貸切露天風呂（要予約）","レストラン（朝食 7:00〜9:00）","ラウンジ・バー（16:00〜23:00）"],ordered:false,align:"left"}],
      [{type:"list",items:["マッサージ・エステ（要予約）","フィットネスジム（6:00〜22:00）","ギフトショップ","駐車場（無料・屋根付き）"],ordered:false,align:"left"}] ]},
    { type:"spacer", height:24 },
    { type:"heading", text:"宿泊者の声", level:"h2", align:"center" },
    { type:"quote", text:"記念日に利用しました。スタッフの細やかな気配りに感動。また絶対に来ます。一生の思い出になりました。", cite:"40代 ご夫婦" },
    { type:"quote", text:"料理のレベルが想像以上。地元食材を活かした一皿一皿が芸術的でした。また食べに来たいです。", cite:"30代 女性グループ" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"チェックイン・アウトの時間は？",a:"チェックイン 15:00〜 / チェックアウト 〜11:00です。プレミアム以上はアーリー・レイトに対応可能です。"},{q:"子ども連れでも宿泊できますか？",a:"小学生以上のお子様を歓迎しています。未就学児のご宿泊はご相談ください。"},{q:"ペットは連れて行けますか？",a:"現在はペット同伴の宿泊は承っておりません。ご了承ください。"},{q:"送迎サービスはありますか？",a:"スイートプラン限定で、最寄り駅からの無料送迎を承っています。事前予約制です。"}] },
    { type:"heading", text:"アクセス", level:"h2", align:"center" },
    { type:"map", query:"箱根", height:300 },
    { type:"cta", title:"特別な時間を、このお宿で。", sub:"1日6組限定。ご希望日のお早めのご予約をお勧めします。", btn:"空室を確認して予約する", href:"#reserve", bg:"", color:"#fff", cv:true } ],

  "イベント・セミナー": [
    { type:"hero", title:"その学びが、あなたの未来を変える。", sub:"2026年7月1日（土）東京・渋谷 開催 ／ オンライン同時配信あり", btn:"今すぐ参加を申し込む", href:"#apply", bg:"#be185d", color:"#fff" },
    { type:"stats", items:[{num:"500名",label:"定員（残り僅か）"},{num:"無料",label:"参加費"},{num:"8時間",label:"プログラム"},{num:"10社",label:"登壇企業"}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"このイベントで得られること", level:"h2", align:"center" },
    { type:"list", items:["最前線で活躍するリーダーたちの生の声が聞ける","業界の最新トレンドと未来予測がわかる","志を同じくする仲間・パートナーとつながれる","すぐに実践できる具体的なノウハウが手に入る","著名登壇者との直接交流タイムあり"], ordered:false, align:"center" },
    { type:"spacer", height:24 },
    { type:"heading", text:"タイムテーブル", level:"h2", align:"center" },
    { type:"list", items:["10:00〜10:30　開会式・オープニングセッション","10:30〜12:00　基調講演「〇〇が変えるこれからの〇〇」","12:00〜13:00　ランチ・ネットワーキングタイム","13:00〜15:00　パネルディスカッション「実践者が語るリアル」","15:00〜17:00　ブレイクアウトセッション（4テーマ同時開催）","17:00〜18:00　クロージング・質疑応答","18:00〜19:30　懇親会（任意参加・軽食あり）"], ordered:false, align:"left" },
    { type:"spacer", height:24 },
    { type:"heading", text:"登壇者", level:"h2", align:"center" },
    { type:"team", members:[{name:"〇〇 〇〇",role:"基調講演 / ○○株式会社 代表取締役",img:""},{name:"△△ △△",role:"パネリスト / △△社 Chief Strategy Officer",img:""},{name:"□□ □□",role:"ゲスト登壇 / 著書『〇〇』著者",img:""},{name:"◇◇ ◇◇",role:"モデレーター / ジャーナリスト",img:""}] },
    { type:"spacer", height:24 },
    { type:"heading", text:"参加者の声（前回開催より）", level:"h2", align:"center" },
    { type:"quote", text:"登壇者のリアルな失敗談・成功談が聞けて、会社に戻った翌日から動けました。来年も必ず参加します。", cite:"スタートアップ創業者 / 前回参加者" },
    { type:"quote", text:"ネットワーキングで出会った方と3ヶ月後に事業提携できました。参加して本当に良かった。", cite:"事業会社 マーケティングマネージャー" },
    { type:"spacer", height:24 },
    { type:"heading", text:"協賛・後援企業", level:"h2", align:"center" },
    { type:"text", html:"本イベントは以下の企業・団体のご支援のもと開催されます。（順不同）", align:"center", size:14 },
    { type:"list", items:["○○株式会社（プラチナスポンサー）","△△株式会社（ゴールドスポンサー）","□□株式会社（シルバースポンサー）","◎◎省 後援"], ordered:false, align:"center" },
    { type:"spacer", height:24 },
    { type:"heading", text:"よくある質問", level:"h2", align:"center" },
    { type:"faq", items:[{q:"オンライン参加でも懇親会に参加できますか？",a:"オンライン懇親会をZoomで別途開催予定です。申込時にオンラインを選択いただいた方にURLをご案内します。"},{q:"アーカイブ動画は見られますか？",a:"参加申込者全員に後日アーカイブ動画をお送りします。視聴期限は開催後30日間です。"},{q:"領収書・請求書の発行はできますか？",a:"無料イベントのため対象外ですが、参加証明書の発行には対応しています。"},{q:"当日キャンセルした場合は？",a:"前日18時までにご連絡いただければ、アーカイブ動画をお送りします。"}] },
    { type:"spacer", height:24 },
    { type:"cta", title:"残り〇〇席。今すぐお申し込みを。", sub:"参加無料 / オンライン同時配信 / アーカイブ動画付き", btn:"今すぐ参加を申し込む", href:"#apply", bg:"", color:"#fff", cv:true } ],
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
function renderAnaChart(series, _gran) {
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
    <label>エディタ高さ</label><select id="st_canvas_h"><option value="small" ${(s.canvasHeight||'medium')==='small'?'selected':''}>コンパクト (500px)</option><option value="medium" ${(s.canvasHeight||'medium')==='medium'?'selected':''}>普通 (700px)</option><option value="large" ${(s.canvasHeight||'medium')==='large'?'selected':''}>広め (画面高さ)</option><option value="fullscreen" ${(s.canvasHeight||'medium')==='fullscreen'?'selected':''}>全画面</option></select>
    <label style="grid-column:1/-1;margin-top:8px">▼ カスタムCSS（直接編集 or 右サイドバーのAI CSS生成を使用）</label>
    <textarea id="st_customcss" style="grid-column:1/-1;min-height:80px;font-family:monospace;font-size:12px" placeholder="/* ここにCSSを直接入力 */">${esc(s.customCss || "")}</textarea>
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
    Object.assign(s, { siteTitle: $("st_title").value, font: $("st_font").value, maxWidth: parseInt($("st_maxw").value) || 960, fullWidth: $("st_full").checked, accent: $("st_accent").value, pageBg: $("st_pagebg").value, textColor: $("st_text").value, canvasHeight: $("st_canvas_h").value, customCss: $("st_customcss").value, notifyEmail: $("st_nmail").value, notifyWebhook: $("st_nhook").value });
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
