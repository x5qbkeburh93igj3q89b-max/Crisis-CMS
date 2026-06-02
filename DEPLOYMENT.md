# デプロイ手順（Vercel / Render）

1. GitHub に push
   - git remote add origin <your-repo>
   - git push -u origin main

2. 静的ビルド出力（任意）
   - 例: node scripts/generate.js を用意して render.js の renderSiteHTML/renderBlogIndex 等を呼び出し、writeFilesToDir() で `dist/` に出力する。
   - package.json に "build": "node scripts/generate.js" を追加しておくと便利。

3. Vercel
   - Vercel にログイン → New Project → GitHub リポジトリを選択。
   - Project Name を `mycms` にすると URL は `https://mycms.vercel.app` になる。
   - Build Command: `npm run build`（静的なら不要） / Output Directory: `dist`（静的出力時）
   - 環境変数をセットしてデプロイ。

4. Render
   - Render にログイン → New → Web Service → GitHub リポジトリを選択。
   - Service Name を `mycms` にすると URL は `https://mycms.onrender.com` になる。
   - Build Command / Start Command を指定してデプロイ。

5. カスタムドメインやワイルドカードサブドメイン
   - 独自ドメインを追加して DNS（CNAME/A）を設定。ワイルドカードは DNS 側で `*.example.com` を設定。
   - マルチテナントの動的サブドメインを実現するには自前ドメイン＋ワイルドカード＋アプリ内で Host ヘッダを使ったルーティング実装が必要。

補足
- Vercel/Render はプロジェクト名（サービス名）に応じたプラットフォームドメインを自動発行します。
- render.js に追加した writeFilesToDir() は Node.js 環境で静的ファイルを出力する際に使えます。

# デプロイ手順（自動化）

前提: リポジトリを GitHub に push（main ブランチ）。

1) GitHub Secrets を設定
   - Repository > Settings > Secrets and variables > Actions に `VERCEL_TOKEN` を追加（Vercel の Personal Token を発行して登録）。

2) 動作概要
   - main に push すると .github/workflows/deploy-vercel.yml が動作。
   - scripts/generate.js で静的 HTML を `dist/` に生成し、Vercel CLI が `dist/` を本番（--prod）デプロイします。
   - ワークフロー内で `--name mycms` を指定しているため、可能なら `mycms.vercel.app` が割り当てられます（既存利用中なら別名になります）。

3) ローカル確認
   - node scripts/generate.js を実行して dist/ が生成されることを確認。
   - npx serve dist などでローカル確認が可能。

4) カスタムコンテンツ
   - content/site.json と content/pages.json を用意すると generate.js が読みます（無ければサンプルを使用）。

注意
- Vercel 側のアカウント/トークンが必要です。こちらで代わりに URL を発行することはできません。
