// ai.js — AI連携：Claude（デザイン/文章提案）と 画像生成（OpenAI）
// キーは .env から読み込む。未設定なら分かりやすいエラーを返す。

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";

// 生成してよいブロックの仕様（フロントの BLOCKS と一致させる）
const BLOCK_SPEC = `
利用できるブロック種別とJSON形式（idは出力しないでよい。サーバー側で付与する）:
- {"type":"hero","title":"...","sub":"...","btn":"...","href":"#","bg":"#5b8cff","color":"#ffffff"}
- {"type":"heading","text":"...","level":"h2","align":"left"}
- {"type":"text","html":"段落テキスト。<strong>等のHTML可","align":"left","size":16}
- {"type":"image","src":"","alt":"説明","align":"center","width":100,"radius":6}   // srcは空でよい（後で差し替え）
- {"type":"button","text":"...","href":"#","align":"center"}
- {"type":"list","items":["項目1","項目2"],"ordered":false,"align":"left"}
- {"type":"quote","text":"...","cite":""}
- {"type":"columns","cols":[[ ...ブロック配列... ],[ ...ブロック配列... ]]}
- {"type":"divider"} / {"type":"spacer","height":40}
`;

/**
 * Claudeにページのデザイン/構成を提案させ、ブロック配列(JSON)を返す。
 * @returns {Promise<{blocks:Array, note:string}>}
 */
export async function suggestDesign({ instruction, currentBlocks = [], siteTitle = "" }) {
  const key = process.env.ANTHROPIC_API_KEY;
  console.log("ANTHROPIC_API_KEY exists:", !!key);
  console.log("ANTHROPIC_API_KEY prefix:", key?.slice(0, 15));
  console.log("ANTHROPIC_MODEL:", process.env.ANTHROPIC_MODEL);
  if (!key || key.startsWith("sk-ant-xxx")) {
    throw new Error("ANTHROPIC_API_KEY が未設定です（.env を設定してください）");
  }
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  const sys = `あなたはプロのWebデザイナー兼コピーライターです。日本語サイトのページ構成を、指定のブロックJSONで提案します。
${BLOCK_SPEC}
必ず次のJSONのみを出力してください（前後に説明文やコードフェンスを付けない）:
{"blocks":[ ... ], "note":"提案の意図を1〜2文で"}`;

  const userMsg = `サイト名: ${siteTitle || "(未設定)"}
ユーザーの要望: ${instruction}

現在のページのブロック数: ${currentBlocks.length}
${currentBlocks.length ? "現在の構成(参考):\n" + JSON.stringify(currentBlocks).slice(0, 4000) : "（現在は空ページ）"}

要望に沿って、魅力的で実用的なページ構成のブロック配列を作ってください。`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: sys,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Claude APIエラー(${res.status}): ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || "").join("").trim();
  const json = extractJSON(text);
  if (!json || !Array.isArray(json.blocks)) {
    throw new Error("Claudeの応答を解釈できませんでした");
  }
  return { blocks: json.blocks, note: json.note || "" };
}

/**
 * Claudeに自由な相談（文章改善・配色案など）。プレーンテキストを返す。
 */
export async function askDesignAdvice({ instruction, context = "" }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 1500,
      system: "あなたはWebデザインとコピーライティングの専門家です。簡潔で実践的な日本語の助言をします。",
      messages: [{ role: "user", content: `${instruction}\n\n${context ? "参考情報:\n" + context.slice(0, 4000) : ""}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).map(c => c.text || "").join("").trim();
}

/**
 * 参考URLを取得し、構成・配色を分析してブロック配列に変換する。
 * ※ピクセル単位の複製ではなく「構成の再現案」。文章は自分用に作り替える前提。
 */
export async function importFromUrl({ url }) {
  if (!/^https?:\/\//.test(url || "")) throw new Error("http(s) のURLを指定してください");
  let html;
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 CrisisCMS-Importer" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    html = await r.text();
  } catch (e) { throw new Error("URLの取得に失敗しました: " + e.message); }

  // 主要色を抽出（hex / rgb）
  const colors = {};
  for (const m of html.matchAll(/#([0-9a-fA-F]{6})\b/g)) { const c = "#" + m[1].toLowerCase(); colors[c] = (colors[c] || 0) + 1; }
  const topColors = Object.entries(colors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(c => c[0]);

  // テキスト構造を抽出（タグを残しつつ本文を圧縮）
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const struct = html
    .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(h[1-3]|p|li|button|a)\b[^>]*>/gi, "\n[$1] ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ")
    .split("\n").map(s => s.trim()).filter(s => s.length > 1).slice(0, 120).join("\n").slice(0, 6000);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const sys = `あなたはWebデザイナーです。参考ページの「構成・セクションの並び・配色の雰囲気」を分析し、似た構成のページをブロックJSONで再現します。文章はそのままコピーせず、汎用的な日本語の仮テキストに置き換えてください（後でユーザーが書き換えます）。
${BLOCK_SPEC}
出力は次のJSONのみ:
{"blocks":[ ... ], "note":"参考にした構成と配色の要点を1〜2文", "accent":"#推奨アクセント色"}`;
  const userMsg = `参考ページのタイトル: ${title}
抽出した主要カラー候補: ${topColors.join(", ") || "不明"}
抽出した構造（タグ付き本文の要約）:
${struct}

この構成に近いページを作ってください。heroやcolumns等を活用し、セクションの並びを再現。文章は仮テキストに置換。`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 4000, system: sys, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const json = extractJSON((data.content || []).map(c => c.text || "").join("").trim());
  if (!json || !Array.isArray(json.blocks)) throw new Error("解析結果を解釈できませんでした");
  return { blocks: json.blocks, note: json.note || "", accent: json.accent || topColors[0] || "" };
}

/**
 * 画像生成（OpenAI）。data URL(base64) を返すのでそのまま<img src>に使える。
 */
export async function generateImage({ prompt, size = "1024x1024" }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.startsWith("sk-xxx")) throw new Error("OPENAI_API_KEY が未設定です（.env を設定してください）");
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const res = await fetch(OPENAI_IMAGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, prompt, size, n: 1 }),
  });
  if (!res.ok) throw new Error(`画像生成APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const item = data.data && data.data[0];
  if (!item) throw new Error("画像が返りませんでした");
  // gpt-image-1 は b64_json、DALL·E は url の場合がある
  const dataUrl = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
  return { dataUrl };
}

/**
 * アクセス解析データをClaudeに分析させ、示唆と改善案を返す（テキスト）。
 */
export async function analyzeAnalytics({ summary, siteTitle }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 1200,
      system: "あなたはWebアクセス解析の専門家です。与えられた数値から、傾向・気づき・具体的な改善アクションを、日本語で簡潔な箇条書き中心に示します。データが少ない場合はその旨を述べ、まず何を計測・改善すべきか助言します。",
      messages: [{ role: "user", content: `サイト「${siteTitle}」のアクセス解析データ:\n${JSON.stringify(summary)}\n\nこのデータから読み取れる傾向と、アクセスを伸ばすための具体的な改善案を提案してください。` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).map(c => c.text || "").join("").trim();
}

/**
 * AIブログ記事を生成。{title, excerpt, body(HTML)} を返す。
 */
export async function generateBlog({ topic, tone = "親しみやすい", length = "1000" }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  if (!topic) throw new Error("記事のテーマを入力してください");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const sys = `あなたはプロのブログライターです。日本語で読みやすいコラム記事を書きます。
出力は次のJSONのみ（コードフェンスや前後の説明なし）:
{"title":"記事タイトル","excerpt":"40〜80字の要約","body":"本文のHTML"}
bodyのルール: <h2><h3><p><ul><li><blockquote><strong> のみ使用。画像やscriptは入れない。見出しで段落を区切り、約${length}字程度。トーンは「${tone}」。`;
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 4000, system: sys, messages: [{ role: "user", content: `テーマ: ${topic}` }] }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const json = extractJSON((data.content || []).map(c => c.text || "").join("").trim());
  if (!json || !json.body) throw new Error("記事の生成に失敗しました");
  return { title: json.title || topic, excerpt: json.excerpt || "", body: json.body };
}

/**
 * ページ内容からSEO用のタイトル・ディスクリプションを提案。
 */
export async function suggestSeo({ pageName, siteTitle, contentText }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: 600,
      system: `あなたはSEOの専門家です。日本語のページのSEOタイトルとメタディスクリプションを提案します。出力はJSONのみ: {"title":"32字前後の魅力的なタイトル","description":"100〜120字の説明文"}`,
      messages: [{ role: "user", content: `サイト名: ${siteTitle}\nページ名: ${pageName}\nページ本文(抜粋):\n${(contentText || "").slice(0, 3000)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = extractJSON((await res.json()).content.map(c => c.text || "").join("").trim());
  if (!json) throw new Error("SEO提案の生成に失敗しました");
  return { title: json.title || "", description: json.description || "" };
}

/**
 * 会話型ビルダー: 指示と現在のブロック配列から、編集後のブロック配列を返す。
 */
export async function chatEditBlocks({ instruction, blocks }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const sys = `あなたはWebページ編集アシスタントです。ユーザーの指示に従い、現在のブロック配列を編集して返します。
${BLOCK_SPEC}
ルール: 既存ブロックはできるだけ保持し、指示された変更のみ反映。idは保持（新規ブロックはidなしでよい）。
出力は次のJSONのみ: {"blocks":[...], "note":"何をしたか1文"}`;
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 4000, system: sys, messages: [{ role: "user", content: `指示: ${instruction}\n\n現在のブロック:\n${JSON.stringify(blocks).slice(0, 8000)}` }] }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = extractJSON((await res.json()).content.map(c => c.text || "").join("").trim());
  if (!json || !Array.isArray(json.blocks)) throw new Error("編集結果を解釈できませんでした");
  return { blocks: json.blocks, note: json.note || "" };
}

/**
 * AIグロースエージェント: 解析データとページ内容から改善提案を複数生成。
 */
export async function growthSuggestions({ summary, siteTitle, pagesText }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const sys = `あなたはグロースハッカーです。アクセス解析とページ内容から、コンバージョンと滞在を改善する具体的な施策を提案します。
出力は次のJSONのみ: {"suggestions":[{"title":"施策の要点(20字以内)","body":"具体的な変更内容と根拠(2〜4文)"}]}（3〜5件）`;
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 2000, system: sys, messages: [{ role: "user", content: `サイト: ${siteTitle}\n解析: ${JSON.stringify(summary)}\nページ内容(抜粋):\n${(pagesText || "").slice(0, 3000)}` }] }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = extractJSON((await res.json()).content.map(c => c.text || "").join("").trim());
  return { suggestions: (json && json.suggestions) || [] };
}

/**
 * アクセシビリティ/表記チェック。指摘テキストを返す。
 */
export async function a11yCheck({ pageName, contentText }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1200,
      system: "あなたはアクセシビリティと日本語校正の専門家です。与えられたページ本文から、アクセシビリティ上の懸念（代替テキスト不足の可能性・見出し構造・コントラスト配慮・リンク文言など）と、誤字脱字・表記ゆれの指摘を、簡潔な箇条書きで日本語で返します。問題がなければその旨を述べます。",
      messages: [{ role: "user", content: `ページ「${pageName}」の本文:\n${(contentText || "").slice(0, 4000)}` }] }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).content.map(c => c.text || "").join("").trim();
}

/**
 * ロングテールKW候補の提案。検索ボリュームは概算（AI推定の目安）。
 */
export async function suggestKeywords({ topic }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith("sk-ant-xxx")) throw new Error("ANTHROPIC_API_KEY が未設定です");
  if (!topic) throw new Error("キーワードを入力してください");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1200,
      system: `あなたはSEOのキーワードプランナーです。入力された主軸キーワードから、検索意図の異なるロングテールKW（複合語・お悩み系・比較系・地域/季節系など）を提案します。
出力はJSONのみ: {"keywords":[{"kw":"ロングテールKW","intent":"検索意図を一言","difficulty":"低|中|高"}]}（8〜12件、競合が比較的少なく記事化しやすいものを優先）`,
      messages: [{ role: "user", content: `主軸キーワード: ${topic}` }] }),
  });
  if (!res.ok) throw new Error(`Claude APIエラー(${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = extractJSON((await res.json()).content.map(c => c.text || "").join("").trim());
  return { keywords: (json && json.keywords) || [] };
}

// テキストからJSONオブジェクトを安全に抽出
function extractJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
