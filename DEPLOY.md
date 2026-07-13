# Render デプロイ手順

## 1. Git リポジトリ作成とコミット (このフォルダで)

```
git init
git add .
git commit -m "Add proxy server and Render config"
```

## 2. GitHub へ push

GitHub で空リポジトリ (例: `chronodrift`) を作成後:

```
git remote add origin https://github.com/<ユーザー名>/chronodrift.git
git branch -M main
git push -u origin main
```

## 3. Render に接続

1. [Render ダッシュボード](https://dashboard.render.com/) → **New** → **Blueprint**
2. GitHub リポジトリ `chronodrift` を選択
3. `render.yaml` が自動検出される → **Apply** (無料プラン・`node server/server.js` 起動が設定済み)
4. デプロイ完了後、`https://chronodrift.onrender.com` のようなURLでアクセス可能

## 改名時の注意 (既存サービスがある場合)

既存の `isehara-game` という名前でリポジトリ/Renderサービスを作成済みの場合、
`render.yaml` の `name` を書き換えて `git push` するだけではURLは変わりません。
- **GitHubリポジトリ名**: GitHub の Settings → Repository name で `chronodrift` に変更 (旧URLは自動リダイレクトされる)
- **Renderサービス名**: Render ダッシュボード → 対象サービス → Settings → Name で変更するとURLも切り替わる
- ローカルの `git remote -v` が旧URLのままなら `git remote set-url origin https://github.com/<ユーザー名>/chronodrift.git` で更新する

以後は `git push` するだけで自動再デプロイされます。

## 注意点

- **無料プランのスリープ**: 約15分アクセスがないとスリープし、次のアクセス時の起動に
  1分程度かかります。
- **キャッシュの揮発**: Render のディスクは永続化されないため、`server/cache/` は
  再デプロイ・再起動のたびに消えます。消えた後の初回読み込みだけ従来どおり時間がかかり、
  以降は再び高速になります。
- ローカル利用は従来どおり `node server/server.js` (8080番) で変わりません。
