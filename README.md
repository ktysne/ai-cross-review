# ai-cross-review

**Claude ↔ Codex を git の差分で交互にレビューさせる、依存ゼロの CLI ブリッジ。**

「片方の AI で実装 → もう片方の AI でレビュー」という往復を、チャットログを手でコピーせず、git の差分を直接レビュアー CLI（`codex` / `claude`）へ渡して 1 コマンドで回します。  
レビュー観点はプロジェクトごとに `.cross-review.md` へ書くだけで差し替えられます。

## 特徴

- **依存ゼロ**: CLI 本体（`tools/cross-review.js`）は Node 標準 API のみ。`npm install` 不要で動く
  （テスト・lint だけ devDependencies を使う）。
- **git 差分が受け渡しメディア**: ブランチ vs ベース、または未コミット差分（未追跡ファイル含む）を渡す。
- **既定は安全側**: レビューのみは `codex` を read-only で起動しファイルを書き換えさせない。
  `--fix` のときだけ workspace-write で検出事項を作業ツリーへ直接修正させる。
- **観点を外部化**: プロジェクト固有のレビュー観点は `.cross-review.md` に分離。エンジンは完全に汎用で、
  他プロジェクトへは `tools/cross-review.js` をコピーして `.cross-review.md` を置くだけ。

## 前提

- Node.js >= 20
- `codex` / `claude` の **スタンドアロン CLI** が PATH にあること（VS Code 拡張やデスクトップアプリとは別物）。  
  レビューを実際に走らせるのに必要。CLI が無くても引数解析や差分生成は動く。  
  リモートコントロール環境など外部 CLI を spawn できない場合は `subagent` モード（後述）を使えば外部 CLI 無しでレビュープロンプトを出力できる。

## 使い方

```bash
npm run review:codex                      # 現在のブランチ (main との差分) を Codex がレビュー (read-only)
npm run review:codex:fix                  # 同上 + 検出事項を Codex が作業ツリーへ直接修正 (workspace-write)
npm run review:claude                     # 現在のブランチを Claude がレビュー
npm run review:codex -- --uncommitted     # 未コミット差分 (tracked + untracked) をレビュー
npm run review:claude -- --base develop   # 比較先ブランチを変更
npm run review:codex:fix -- --instructions review-notes.md  # レビュアーの指摘 (ファイル) を渡して Codex に直させる
```

`npm run` を介さず直接呼ぶこともできます。

```bash
node tools/cross-review.js codex --base origin/main
node tools/cross-review.js subagent --uncommitted   # 外部 CLI を起動せずレビュープロンプトを stdout に出力 (リモートコントロール用)
node tools/cross-review.js --help
```

### リモートコントロール環境（`subagent` モード）

Claude をリモートコントロール（クラウド実行）で動かすと `codex` / `claude` スタンドアロン CLI を
spawn できないことがあります。その場合はレビュアーに `subagent` を指定すると、**外部プロセスを
起動せず**、組み立てたレビュープロンプト（観点 + 差分本文 + モード別指示）を **stdout に出すだけ**に
なります（通知は stderr に分離）。この出力を Claude が `Agent` ツールの客観レビュー用サブエージェント
へ渡すことで、Codex の代わりに「Claude の客観的な観点を持つサブエージェント」がレビュアーになります。
`--uncommitted` / `--base` / `--fix` / `--instructions` は他レビュアーと同じく使えます。詳細は
[docs/cross-review.md](docs/cross-review.md) を参照してください。

| オプション | 意味 |
|------------|------|
| `--fix` | 修正まで依頼（`codex` は `-s workspace-write` で直接編集 / `subagent` は FIX 指示付きでプロンプト出力。`claude` CLI 経路は非対応） |
| `--uncommitted` | 未コミットの作業ツリー差分（tracked + untracked）をレビュー |
| `--base <ref>` | 比較先ブランチを指定（既定: `main`） |
| `--instructions <path>` | レビュアーからの申し送り・重点指摘ファイルをプロンプトへ添付（観点 `.cross-review.md` は置き換えず追加。`--fix` と併用で指摘を直接修正させる） |
| `-h`, `--help` | ヘルプを表示 |

## レビュー観点（`.cross-review.md`）

レビュアーへ渡す「観点プロンプト」は、リポジトリ直下の `.cross-review.md` を単一ソースとして読み込みます。  
解決順は次のとおりで、どれも無くても汎用観点で動きます（その際は起動時に stderr へ警告）。

1. 環境変数 `CROSS_REVIEW_CHECKLIST`（ファイルパス）
2. `<cwd>/.cross-review.md`（`npm run review:*` の通常経路）
3. `<スクリプト>/../.cross-review.md`（`tools/cross-review.js` の 1 つ上 = リポジトリ直下。  
   cwd がリポ直下でなくても絶対パス等で起動すれば拾える）
4. 組み込みの汎用観点（`GENERIC_CHECKLIST`）

`CROSS_REVIEW_CHECKLIST` を明示指定したのに読めない（存在しない / 空 / 読取不可）場合は、
黙ってフォールバックせず警告を出します（誤ったパスや空ファイルで意図しない観点になる事故を検知するため）。

## 相互レビューの回し方

実装担当とレビュー担当を入れ替えながら **実装 → レビュー → 指摘対応 → 妥当性確認** の 4 ステップで回します。
無限ループを防ぐサーキットブレーカー（最大 3 往復）など、運用フローの詳細は
[docs/cross-review.md](docs/cross-review.md) を参照してください。

## 他プロジェクトへの導入

1. `tools/cross-review.js` をコピーする（`tools/*.js` は CommonJS。コピー先のルート `package.json` が
   `"type": "module"` の場合は `tools/package.json` に `"type": "commonjs"` を置く）。
2. リポジトリ直下に `.cross-review.md` を作り、そのプロジェクトで壊れやすい不変条件を書く。
   雛形は [.cross-review.example.md](.cross-review.example.md)。
3. ルート `package.json` の `scripts` に `review:codex` / `review:codex:fix` / `review:claude` を追加する。
4. `codex` / `claude` のスタンドアロン CLI を PATH に通す。

## 開発

```bash
npm install        # devDependencies (vitest / eslint) を入れる
npm test           # ユニットテスト (引数解析・差分生成・プロンプト生成・観点解決・申し送り注入)
npm run lint       # ESLint
```

このリポジトリ自身のレビュー観点は [.cross-review.md](.cross-review.md) にあります。
