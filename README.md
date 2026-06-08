# ai-cross-review

**Claude と Codex に、git の差分を使って交互にコードレビューさせる CLI ツールです。**  
追加の依存パッケージは要りません。

「片方の AI で実装し、もう片方の AI でレビューする」という往復を回します。  
チャットの中身を手でコピーする必要はありません。  
git の差分をそのままレビュアー CLI（`codex` / `claude`）へ渡し、1 コマンドで実行します。  
レビューの観点は、プロジェクトごとに `.cross-review.md` へ書くだけで差し替えられます。

## 特徴

- **追加インストール不要**: 本体（`tools/cross-review.js`）は Node 標準 API だけで動きます。  
  テストと lint のときだけ devDependencies を使います。  
- **git の差分でやり取り**: ブランチとベースの差分、または未コミットの差分（未追跡ファイルを含む）を渡します。  
- **既定は安全側**: レビューだけのときは `codex` を read-only で起動し、ファイルを書き換えさせません。  
  `--fix` を付けたときだけ workspace-write で起動し、見つかった問題を直接修正させます。  
- **観点を分離**: プロジェクト固有のレビュー観点は `.cross-review.md` に分けてあります。  
  本体は完全に汎用です。  
  導入するときは、決まったファイル一式をコピーし、`.cross-review.md` だけを自分のプロジェクト向けに編集します。

## 前提

- Node.js 20 以上。  
- `codex` / `claude` の **スタンドアロン CLI** が PATH にあること（VS Code 拡張やデスクトップアプリとは別物です）。  
  実際にレビューを走らせるのに必要です。  
  CLI が無くても、引数の解析や差分の生成は動きます。  
  クラウド実行などで CLI を起動できないときは、後述の `subagent` モードを使えば CLI 無しでレビュー用プロンプトを出力できます。

## 使い方

```bash
npm run review:codex                      # 現在のブランチ (main との差分) を Codex がレビュー (read-only)
npm run review:codex:fix                  # 同上 + 見つかった問題を Codex が直接修正 (workspace-write)
npm run review:claude                     # 現在のブランチを Claude がレビュー
npm run review:codex -- --uncommitted     # 未コミット差分 (tracked + untracked) をレビュー
npm run review:claude -- --base develop   # 比較先ブランチを変更
npm run review:codex:fix -- --instructions review-notes.md  # レビュアーの指摘 (ファイル) を渡して Codex に直させる
```

`npm run` を介さず直接呼ぶこともできます。

```bash
node tools/cross-review.js codex --base origin/main
node tools/cross-review.js subagent --uncommitted   # CLI を起動せずレビュー用プロンプトを stdout に出力 (CLI を使えない環境用)
node tools/cross-review.js --help
```

### CLI を起動できない環境（`subagent` モード）

Claude をクラウドで実行していると、`codex` / `claude` の CLI を起動できないことがあります。  
このときはレビュアーに `subagent` を指定します。  
すると外部プロセスを起動せず、組み立てたレビュー用プロンプト（観点 + 差分 + モード別の指示）を stdout に出力するだけになります（人向けの通知は stderr に分けます）。  
この出力を Claude が `Agent` ツールのサブエージェントへ渡します。  
こうして、Codex の代わりに「Claude の客観的なサブエージェント」がレビュアーになります。  
`--uncommitted` / `--base` / `--fix` / `--instructions` は他のレビュアーと同じように使えます。  
詳しくは [docs/cross-review.md](docs/cross-review.md) を参照してください。

| オプション | 意味 |
|------------|------|
| `--fix` | 修正まで依頼する（`codex` は `-s workspace-write` で直接修正 / `subagent` は FIX 指示付きでプロンプト出力。`claude` CLI 経路は非対応） |
| `--uncommitted` | 未コミットの作業ツリー差分（tracked + untracked）をレビュー |
| `--base <ref>` | 比較先ブランチを指定（既定: `main`） |
| `--instructions <path>` | レビュアーへの申し送り・重点指摘ファイルをプロンプトに追加する（観点 `.cross-review.md` は置き換えず追加。`--fix` と併用すると、その指摘を直接修正させる） |
| `-h`, `--help` | ヘルプを表示 |

## レビュー観点（`.cross-review.md`）

レビュアーへ渡す「観点プロンプト」は、リポジトリ直下の `.cross-review.md` から読み込みます。  
次の順で探し、どれも無ければ組み込みの汎用観点で動きます（そのときは起動時に stderr へ警告します）。

1. 環境変数 `CROSS_REVIEW_CHECKLIST`（ファイルパス）
2. `<cwd>/.cross-review.md`（`npm run review:*` の通常経路）
3. `<スクリプト>/../.cross-review.md`（`tools/cross-review.js` の 1 つ上 = リポジトリ直下。cwd がリポ直下でなくても、絶対パス等で起動すれば見つかります）
4. 組み込みの汎用観点（`GENERIC_CHECKLIST`）

`CROSS_REVIEW_CHECKLIST` を指定したのに読めない（存在しない / 空 / 読めない）ときは、黙って次へ進まず警告を出します。  
誤ったパスや空ファイルで観点が変わってしまう事故を防ぐためです。

## 相互レビューの回し方

実装担当とレビュー担当を入れ替えながら、**実装 → レビュー → 指摘対応 → 妥当性確認** の 4 ステップで回します。  
無限ループを防ぐ仕組み（レビューと修正の往復は最大 3 回まで）など、詳しい手順は [docs/cross-review.md](docs/cross-review.md) を参照してください。

## 他プロジェクトへの導入

このツールは「**汎用の部分はそのままコピーして使い、プロジェクト固有の部分だけを編集する**」という考え方で作っています。  
導入先では、下の表の「**そのままコピーするファイル**」をコピーし、「**自分で編集するファイル**」だけを書き換えます。  
更新するときは、コピーするファイルを上書きでコピーし直すだけです。  
内容を突き合わせる複雑な作業は要りません。

### そのままコピーするファイル（更新時は上書き。コピー先では編集しない）
| ファイル | 役割 | コピー時の調整 |
|----------|------|----------------|
| `tools/cross-review.js` | CLI 本体 | なし（そのまま） |
| `tests/cross-review.test.js`（任意） | 本体のユニットテスト（vitest） | **取り込み先が vitest のときだけ同梱**。require のパスをコピー先のテスト配置に合わせる（engine は upstream のテストが担保） |
| `.cross-review.example.md` | 観点のテンプレート | なし。**コピーして `.cross-review.md` を作り、そちらを編集する** |
| `docs/cross-review.md` | 相互レビューの手順書（汎用） | なし（そのまま）。ファイルは名前で参照していて、置き場所が変わっても壊れない |

### 自分で編集するファイル（コピーで上書きしない）
| ファイル | 役割 |
|----------|------|
| `.cross-review.md` | そのプロジェクトのレビュー観点（`.cross-review.example.md` を雛形に作る） |
| `CLAUDE.md` / `AGENTS.md`（あれば） | そのリポジトリの運用メモ。手順の詳細はコピーした `docs/cross-review.md` へリンクする |
| そのプロジェクト用の doc（任意） | 手順書に書かない、プロジェクト固有のメモ（検証コマンド・CI・例 など） |
| `tools/package.json` | `tools/*.js` を CommonJS にする設定（`"type": "commonjs"`）。そのリポジトリのツール依存もここに足す |
| コピーを自動化するスクリプト（任意） | コピーし直しや require パス調整を自動化する同期スクリプトなど。コピー先が用意して持つ（このリポジトリには入れない。例: コピー先の `tools/sync-*.js`） |

### 手順
1. 上の「そのままコピーするファイル」を全部コピー先へコピーする（`tools/*.js` は CommonJS なので、コピー先のルート `package.json` が `"type": "module"` のときは `tools/package.json` に `"type": "commonjs"` を置く）。  
   テスト `tests/cross-review.test.js` は任意で、取り込み先が vitest のときだけ require パスを合わせて同梱する。  
2. `.cross-review.example.md` を `.cross-review.md` にコピーし、そのプロジェクトで壊れやすい注意点を書く。  
3. ルート `package.json` の `scripts` に `review:codex` / `review:codex:fix` / `review:claude` を足す。  
4. `codex` / `claude` の CLI を PATH に通す（CLI を起動できないときは `subagent` モードを使う）。  
5. 更新するときは、コピーするファイルを上書きでコピーし直すだけ。  
   自分で編集するファイルは触らない。

> **メモ（末尾空白）**: `docs/cross-review.md` などは Markdown のハード改行（行末スペース 2 つ）を使います。
> `git diff --check` や CI で末尾空白を弾く場合は、コピー先の `.gitattributes` に
> `*.md whitespace=-blank-at-eol` を足して許容してください（このリポジトリにも同じ設定があります）。

## 開発

```bash
npm install        # devDependencies (vitest / eslint) を入れる
npm test           # ユニットテスト (引数解析・差分生成・プロンプト生成・観点解決・申し送り注入)
npm run lint       # ESLint
```

このリポジトリ自身のレビュー観点は [.cross-review.md](.cross-review.md) にあります。
