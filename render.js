// render.js — ブロック → 静的HTML（公開サイト書き出し / プレビュー共用）
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function embedUrl(u) {
  if (!u) return "";
  let m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/); if (m) return "https://www.youtube.com/embed/" + m[1];
  m = u.match(/vimeo\.com\/(\d+)/); if (m) return "https://player.vimeo.com/video/" + m[1];
  if (u.includes("/embed/") || u.includes("player.")) return u;
  return "";
}

export function renderBlock(b, accent, siteSlug) {
  const al = b.align || "left";
  switch (b.type) {
    case "form": {
      const fields = (b.fields && b.fields.length ? b.fields : [
        { label: "お名前", type: "text", required: true },
        { label: "メール", type: "email", required: true },
        { label: "お問い合わせ内容", type: "textarea", required: true },
      ]);
      const inputs = fields.map((f, i) => {
        const name = "f_" + i + "_" + (f.label || "field");
        const req = f.required ? " required" : "";
        const ctrl = f.type === "textarea"
          ? `<textarea name="${esc(name)}"${req} rows="4" style="width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit"></textarea>`
          : `<input type="${f.type === "email" ? "email" : "text"}" name="${esc(name)}"${req} style="width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit">`;
        return `<div style="margin-bottom:12px;text-align:left"><label style="display:block;font-size:13px;margin-bottom:4px">${esc(f.label)}${f.required ? " *" : ""}</label>${ctrl}</div>`;
      }).join("");
      const fid = "form_" + (b.id || Math.random().toString(36).slice(2));
      return `<form id="${fid}" data-slug="${esc(siteSlug || "")}" onsubmit="return cmsSubmitForm(event,'${fid}')" style="max-width:480px;margin:0 auto;text-align:${al}">
        ${inputs}
        <button type="submit" style="background:${accent};color:#fff;border:0;padding:12px 28px;border-radius:8px;font-weight:600;cursor:pointer;font:inherit">${esc(b.submitLabel || "送信する")}</button>
        <p class="form-msg" style="font-size:13px;margin-top:10px"></p>
      </form>`;
    }
    case "heading": return `<${b.level || "h2"} style="text-align:${al};${b.color ? `color:${b.color}` : ""}">${esc(b.text)}</${b.level || "h2"}>`;
    case "text": return `<div style="text-align:${al};font-size:${b.size || 16}px;line-height:1.7;${b.color ? `color:${b.color};` : ""}">${b.html || ""}</div>`;
    case "image": {
      if (!b.src) return "";
      let img = `<img src="${esc(b.src)}" alt="${esc(b.alt || "")}" loading="lazy" decoding="async" style="width:${b.width || 100}%;border-radius:${b.radius || 0}px;display:inline-block">`;
      if (b.link) img = `<a href="${esc(b.link)}">${img}</a>`;
      return `<div style="text-align:${al}">${img}</div>`;
    }
    case "button": return `<div style="text-align:${al};margin:6px 0"><a href="${esc(b.href || "#")}"${b.cv ? ` data-cms-cv="${esc(b.cvLabel || b.text || "button")}"` : ""} style="display:inline-block;padding:11px 24px;border-radius:8px;text-decoration:none;background:${b.bg || accent};color:${b.color || "#fff"};font-weight:600">${esc(b.text)}</a></div>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag} style="text-align:${al};line-height:1.8;padding-left:1.4em">` + (b.items || []).map(i => `<li>${esc(i)}</li>`).join("") + `</${tag}>`;
    }
    case "quote": return `<blockquote style="border-left:4px solid ${accent};margin:0;padding:6px 18px;color:#555;font-style:italic">${esc(b.text)}${b.cite ? `<footer style="font-size:.85em;color:#999;margin-top:6px">— ${esc(b.cite)}</footer>` : ""}</blockquote>`;
    case "divider": return `<hr style="border:0;border-top:1px solid ${b.color || "#e2e2e2"};margin:8px 0">`;
    case "spacer": return `<div style="height:${b.height || 40}px"></div>`;
    case "video": { const e = embedUrl(b.url); return e ? `<div style="position:relative;padding-bottom:56.25%;height:0"><iframe src="${e}" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:8px" allowfullscreen></iframe></div>` : ""; }
    case "html": return b.code || "";
    case "hero": {
      const bg = b.img ? `background:linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.35)),url('${esc(b.img)}') center/cover;` : `background:${b.bg};`;
      const abAttr = (b.ab && b.titleB) ? " data-ab" : "";
      const titleHtml = (b.ab && b.titleB)
        ? `<h1 data-ab-a style="margin:0 0 10px;font-size:34px">${esc(b.title)}</h1><h1 data-ab-b style="margin:0 0 10px;font-size:34px;display:none">${esc(b.titleB)}</h1>`
        : `<h1 style="margin:0 0 10px;font-size:34px">${esc(b.title)}</h1>`;
      const cta = b.btn ? `<a href="${esc(b.href || "#")}"${b.cv ? ` data-cms-cv="${esc(b.btn)}"` : ""} style="display:inline-block;padding:12px 28px;background:#fff;color:#222;border-radius:8px;text-decoration:none;font-weight:600">${esc(b.btn)}</a>` : "";
      return `<div${abAttr} style="${bg}color:${b.color};padding:64px 28px;text-align:center;border-radius:10px">${titleHtml}<p style="margin:0 0 20px;font-size:17px;opacity:.92">${esc(b.sub)}</p>${cta}</div>`;
    }
    case "columns": {
      const inner = (b.cols || []).map(c => `<div style="flex:1">${c.map(x => `<div style="margin:10px 0">${renderBlock(x, accent, siteSlug)}</div>`).join("")}</div>`).join("");
      return `<div style="display:flex;gap:16px;flex-wrap:wrap">${inner}</div>`;
    }
    case "cta": {
      const bg = b.bg || accent;
      return `<div style="background:${bg};color:${b.color || "#fff"};border-radius:14px;padding:40px 28px;text-align:center">
        <h2 style="margin:0 0 8px;font-size:26px">${esc(b.title)}</h2><p style="margin:0 0 18px;opacity:.92">${esc(b.sub)}</p>
        ${b.btn ? `<a href="${esc(b.href || "#")}"${b.cv ? ` data-cms-cv="${esc(b.btn)}"` : ""} style="display:inline-block;padding:13px 32px;background:#fff;color:#222;border-radius:8px;text-decoration:none;font-weight:700">${esc(b.btn)}</a>` : ""}</div>`;
    }
    case "faq":
      return `<div style="max-width:760px;margin:0 auto">${(b.items || []).map(it => `<details style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 16px;margin-bottom:8px"><summary style="font-weight:600;cursor:pointer">${esc(it.q)}</summary><div style="margin-top:8px;color:#555;line-height:1.7">${esc(it.a)}</div></details>`).join("")}</div>`;
    case "pricing":
      return `<div style="display:flex;gap:16px;flex-wrap:wrap;justify-content:center">${(b.plans || []).map(p => `<div style="flex:1;min-width:200px;max-width:300px;border:${p.featured ? `2px solid ${accent}` : "1px solid #e5e7eb"};border-radius:14px;padding:22px;text-align:center">${p.featured ? `<div style="display:inline-block;background:${accent};color:#fff;font-size:12px;padding:3px 12px;border-radius:20px;margin-bottom:8px">おすすめ</div>` : ""}<h3 style="margin:0 0 4px">${esc(p.name)}</h3><div style="font-size:28px;font-weight:800;margin:8px 0">${esc(p.price)}</div><ul style="list-style:none;padding:0;margin:12px 0;color:#555;line-height:1.9;font-size:14px">${(p.features || []).map(f => `<li>${esc(f)}</li>`).join("")}</ul></div>`).join("")}</div>`;
    case "stats":
      return `<div style="display:flex;gap:20px;flex-wrap:wrap;justify-content:center;text-align:center">${(b.items || []).map(it => `<div style="flex:1;min-width:120px"><div style="font-size:34px;font-weight:800;color:${accent}">${esc(it.num)}</div><div style="color:#666;font-size:14px">${esc(it.label)}</div></div>`).join("")}</div>`;
    case "team":
      return `<div style="display:flex;gap:18px;flex-wrap:wrap;justify-content:center">${(b.members || []).map(m => `<div style="width:180px;text-align:center">${m.img ? `<img src="${esc(m.img)}" alt="${esc(m.name)}" loading="lazy" style="width:120px;height:120px;border-radius:50%;object-fit:cover">` : `<div style="width:120px;height:120px;border-radius:50%;background:#eee;margin:0 auto"></div>`}<div style="font-weight:600;margin-top:8px">${esc(m.name)}</div><div style="color:#888;font-size:13px">${esc(m.role)}</div></div>`).join("")}</div>`;
    case "jobs":
      return `<div style="max-width:760px;margin:0 auto">${(b.items || []).map(j => `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px 18px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><div><div style="font-weight:600">${esc(j.title)}</div><div style="color:#666;font-size:13px;margin-top:3px">${esc(j.desc)}</div></div><span style="background:#f3f4f6;border-radius:20px;padding:4px 12px;font-size:12px;white-space:nowrap">${esc(j.type)}</span></div>`).join("")}</div>`;
    case "map": {
      const q = encodeURIComponent(b.query || "東京駅");
      return `<div style="border-radius:12px;overflow:hidden"><iframe loading="lazy" style="width:100%;height:${b.height || 360}px;border:0" src="https://maps.google.com/maps?q=${q}&output=embed"></iframe></div>`;
    }
  }
  return "";
}

const FORM_JS = `<script>
async function cmsSubmitForm(e, id){ e.preventDefault();
  var f=document.getElementById(id), slug=f.getAttribute('data-slug'), msg=f.querySelector('.form-msg');
  var data={}; new FormData(f).forEach(function(v,k){data[k]=v;});
  data.visitor=(window.__cmsVid||''); data.page=location.pathname; data.variant=(window.__cmsVar||'');
  msg.textContent='送信中...'; msg.style.color='#666';
  try{ var r=await fetch('/api/forms/'+slug+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    if(!r.ok) throw 0; f.reset(); msg.textContent='送信しました。ありがとうございました。'; msg.style.color='#16a34a'; }
  catch(_){ msg.textContent='送信に失敗しました。時間をおいて再度お試しください。'; msg.style.color='#e23b4e'; }
  return false; }
</script>`;

const trackJS = (slug) => `<script>(function(){try{
var k='cms_vid',v=localStorage.getItem(k),isNew=0;if(!v){v=(Date.now().toString(36)+Math.random().toString(36).slice(2,8));localStorage.setItem(k,v);isNew=1;}
window.__cmsVid=v;
var w=Math.min(screen.width,window.innerWidth||screen.width);var dev=w<=600?'mobile':(w<=1024?'tablet':'desktop');
// A/Bバリアント決定（ページ内に data-ab があれば）
var ab=document.querySelector('[data-ab]');
if(ab){var pk='cms_ab_'+location.pathname;var vr=localStorage.getItem(pk);if(!vr){vr=Math.random()<0.5?'A':'B';localStorage.setItem(pk,vr);}window.__cmsVar=vr;
  ab.querySelectorAll('[data-ab-a]').forEach(function(el){el.style.display=vr==='A'?'':'none';});
  ab.querySelectorAll('[data-ab-b]').forEach(function(el){el.style.display=vr==='B'?'':'none';});}
function post(u,b){try{navigator.sendBeacon?navigator.sendBeacon(u,new Blob([JSON.stringify(b)],{type:'application/json'})):fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),keepalive:true});}catch(e){}}
post('/api/track',{slug:'${slug}',page:location.pathname,ref:document.referrer,visitor:v,isNew:!!isNew,device:dev,variant:(window.__cmsVar||'')});
var start=Date.now(),maxScroll=0,sent=false;
addEventListener('scroll',function(){var h=document.documentElement.scrollHeight-innerHeight;if(h>0){var p=Math.round(scrollY/h*100);if(p>maxScroll)maxScroll=p;}},{passive:true});
function flush(){if(sent)return;sent=true;var sec=Math.round((Date.now()-start)/1000);post('/api/event',{slug:'${slug}',page:location.pathname,visitor:v,type:'engage',num:sec});if(maxScroll)post('/api/event',{slug:'${slug}',page:location.pathname,visitor:v,type:'scroll',num:maxScroll});}
addEventListener('pagehide',flush);addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush();});
// クリックコンバージョン（data-cms-cv 属性のリンク/ボタン）
document.addEventListener('click',function(e){var t=e.target.closest('[data-cms-cv]');if(t)post('/api/event',{slug:'${slug}',page:location.pathname,visitor:v,type:'conversion',num:1,label:(t.getAttribute('data-cms-cv')||'click')+(window.__cmsVar?('|'+window.__cmsVar):'')});});
}catch(e){}})();</script>`;

// SEO構造化データ（JSON-LD）
function jsonLd(obj) { return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`; }

// ブロック配列からプレーンテキスト抽出（AI SEO提案用）
export function blocksToText(blocks) {
  const out = [];
  const walk = (arr) => arr.forEach(b => {
    if (b.type === "heading" || b.type === "button") out.push(b.text || "");
    if (b.type === "hero") out.push((b.title || "") + " " + (b.sub || ""));
    if (b.type === "text") out.push(String(b.html || "").replace(/<[^>]+>/g, " "));
    if (b.type === "quote") out.push(b.text || "");
    if (b.type === "list") out.push((b.items || []).join("、"));
    if (b.type === "columns") (b.cols || []).forEach(c => walk(c));
  });
  walk(blocks || []);
  return out.join("\n").replace(/\s+/g, " ").trim();
}

function pageShell(s, { title, desc, og, navHtml, body, extra }) {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${desc}${og}
<style>*{box-sizing:border-box}body{margin:0;font-family:${s.font};background:${s.pageBg};color:${s.textColor};line-height:1.6}
.nav{display:flex;gap:18px;padding:16px 24px;border-bottom:1px solid #eee;flex-wrap:wrap}.nav a{color:${s.accent};text-decoration:none;font-weight:600}
.wrap{max-width:${s.fullWidth ? "100%" : s.maxWidth + "px"};margin:0 auto;padding:24px}img{max-width:100%}
.post-card{display:block;border:1px solid #eee;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;margin-bottom:16px}
.post-card img{width:100%;height:180px;object-fit:cover;display:block}
.post-card .pc-body{padding:14px 16px}.post-card h3{margin:0 0 6px}.post-card p{margin:0;color:#666;font-size:14px}
article h2{margin-top:1.6em}article img{border-radius:8px}.post-date{color:#999;font-size:13px}</style></head>
<body><div class="nav">${navHtml}</div><div class="wrap">${body}</div>${extra || ""}</body></html>`;
}

export function renderSiteHTML(site, pages, opts = {}) {
  const s = site.settings, slug = site.slug;
  const hasForm = (pg) => JSON.stringify(pg.blocks).includes('"form"');
  let nav = pages.map((p, i) => `<a href="${i === 0 ? "index" : "page" + i}.html">${esc(p.name)}</a>`).join("");
  if (opts.hasBlog) nav += `<a href="/s/${slug}/blog">ブログ</a>`;
  const files = {};
  pages.forEach((pg, i) => {
    const m = pg.meta || {};
    const title = esc(m.title || `${pg.name} | ${s.siteTitle}`);
    const desc = m.description ? `<meta name="description" content="${esc(m.description)}">` : "";
    const og = `<meta property="og:title" content="${title}">${m.description ? `<meta property="og:description" content="${esc(m.description)}">` : ""}${m.ogImage ? `<meta property="og:image" content="${esc(m.ogImage)}">` : ""}<meta property="og:type" content="website">`;
    const body = pg.blocks.map(b => `<div style="margin:10px 0">${renderBlock(b, s.accent, slug)}</div>`).join("\n");
    const ld = jsonLd({ "@context": "https://schema.org", "@type": "WebPage", name: m.title || pg.name, description: m.description || "", isPartOf: { "@type": "WebSite", name: s.siteTitle } });
    const extra = `${ld}${hasForm(pg) ? FORM_JS : ""}${opts.track ? trackJS(slug) : ""}`;
    files[i === 0 ? "index.html" : "page" + i + ".html"] = pageShell(s, { title, desc, og, navHtml: nav, body, extra });
  });
  return files;
}

export function renderBlogIndex(site, posts) {
  const s = site.settings, slug = site.slug;
  const nav = `<a href="/s/${slug}/">ホーム</a><a href="/s/${slug}/blog">ブログ</a>`;
  const list = posts.length ? posts.map(p => `<a class="post-card" href="/s/${slug}/blog/${esc(p.slug)}">
    ${p.cover ? `<img src="${esc(p.cover)}" alt="">` : ""}
    <div class="pc-body"><h3>${esc(p.title)}</h3><p class="post-date">${new Date(p.published_at).toLocaleDateString("ja-JP")}</p><p>${esc(p.excerpt || "")}</p></div></a>`).join("")
    : `<p style="color:#888">まだ記事がありません。</p>`;
  const body = `<h1>ブログ</h1>${list}`;
  return pageShell(s, { title: esc(`ブログ | ${s.siteTitle}`), desc: "", og: "", navHtml: nav, body, extra: trackJS(slug) });
}

export function renderPostPage(site, post) {
  const s = site.settings, slug = site.slug;
  const nav = `<a href="/s/${slug}/">ホーム</a><a href="/s/${slug}/blog">ブログ</a>`;
  const title = esc(`${post.title} | ${s.siteTitle}`);
  const desc = post.excerpt ? `<meta name="description" content="${esc(post.excerpt)}">` : "";
  const og = `<meta property="og:title" content="${esc(post.title)}"><meta property="og:type" content="article">${post.cover ? `<meta property="og:image" content="${esc(post.cover)}">` : ""}`;
  const body = `<article><h1>${esc(post.title)}</h1>
    <p class="post-date">${post.published_at ? new Date(post.published_at).toLocaleDateString("ja-JP") : ""}</p>
    ${post.cover ? `<img src="${esc(post.cover)}" alt="" style="width:100%;border-radius:10px;margin:12px 0">` : ""}
    ${post.body}
    <p style="margin-top:30px"><a href="/s/${slug}/blog">← ブログ一覧へ</a></p></article>`;
  const ld = jsonLd({ "@context": "https://schema.org", "@type": "Article", headline: post.title, description: post.excerpt || "", image: post.cover || undefined, datePublished: post.published_at ? new Date(post.published_at).toISOString() : undefined, publisher: { "@type": "Organization", name: s.siteTitle } });
  return pageShell(s, { title, desc, og, navHtml: nav, body, extra: ld + trackJS(slug) });
}

// 追加: Node.js 実行時に静的ファイル群をディスクへ書き出すユーティリティ
export async function writeFilesToDir(files, outDir = "dist") {
  // 実行環境が Node.js でない場合はエラー（ブラウザ環境での直接 import を避ける）
  if (typeof process === "undefined" || !process.versions || !process.versions.node) {
    throw new Error("writeFilesToDir can only run in Node.js");
  }
  const fs = (await import('fs')).promises;
  const path = await import('path');
  await fs.mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    // path.join を通常どおり使います（ESM の import でも path.join は関数です）
    const p = path.join(outDir, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
  }
  return outDir;
}
