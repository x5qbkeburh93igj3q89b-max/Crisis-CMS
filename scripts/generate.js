const fs = require('fs').promises;
const path = require('path');
const url = require('url');

async function loadJSON(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { return null; }
}

(async () => {
  try {
    const renderPath = path.join(__dirname, '..', 'render.js');
    const render = await import(url.pathToFileURL(renderPath).href);
    const { renderSiteHTML, writeFilesToDir } = render;

    const site = (await loadJSON(path.join('content','site.json'))) || {
      slug: 'mycms',
      siteTitle: 'My CMS',
      settings: { font: 'system-ui, -apple-system, "Helvetica Neue", Arial', pageBg: '#fff', textColor: '#222', accent: '#06c', maxWidth: 900, fullWidth: false }
    };
    const pages = (await loadJSON(path.join('content','pages.json'))) || [
      { name: 'ホーム', meta: {}, blocks: [ { type: 'heading', level: 'h1', text: 'ようこそ' }, { type: 'text', html: '<p>ここにコンテンツを追加してください。</p>' } ] }
    ];

    const files = renderSiteHTML(site, pages, { track: true, hasBlog: false });
    const outDir = await writeFilesToDir(files, 'dist');
    console.log('静的ファイルを生成しました:', outDir);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
