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
  `review:codex*` / `review:claude` はレビュアー CLI のネットワーク/API 接続も必要です。  
  CLI が見えていても API 接続だけ失敗することがあります。`claude -p "Reply with OK only."` のような最小コマンドが通常サンドボックスで無応答 / `ConnectionRefused` になり、ネットワーク許可・サンドボックス外で成功するなら、原因は CLI ではなく実行環境のネットワーク制限です。  
  CLI が無くても、引数の解析や差分の生成は動きます。  
  クラウド実行などで CLI を起動できないときは、後述の `subagent` モードを使えば CLI 無しでレビュー用プロンプトを出力できます。

> **課金メモ（Claude サブスクプラン）**: Anthropic のサブスク（Pro / Max / Team / Enterprise）では、**2026-06-15 以降** `claude -p`（`review:claude` が内部で使うヘッドレス実行）や Agent SDK 経由の利用が、インタラクティブの利用上限とは**別の月次 Agent SDK クレジット枠**から消費されます（枠超過時は停止、または extra usage 有効なら API 従量課金）。`review:codex*`（OpenAI の Codex CLI）や `subagent`（外部 API を呼ばずプロンプトを出力するだけ）は**この枠の対象外**です。挙動・認証方法に変更はなく、影響は課金・利用枠のみです。詳細は [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) を参照。

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

### Codex 起点で Claude レビューから回す例

Codex が実装し、Claude レビューから往復を始める場合の最短例です。

```bash
npm run review:claude -- --uncommitted    # Claude がレビュー（結果を確認）
# ↑の指摘を ../review-notes.md に書き出す（手作業。リポ外に置き、最後の --uncommitted 差分へ混ぜない）
node tools/cross-review.js codex --fix --uncommitted --instructions ../review-notes.md  # Codex が修正
npm run review:claude -- --uncommitted    # Claude が妥当性確認
```

`../review-notes.md` は自動生成されません。Claude のレビュー結果から今回直す指摘だけを確認して書き出してください。  
リポジトリ外（例: 親ディレクトリ）に置くのは、最後の妥当性確認 `npm run review:claude -- --uncommitted` で、このファイル自体が未追跡差分としてレビューに混ざるのを防ぐためです（`--instructions` 指定時は対象から自動除外されますが、妥当性確認は `--instructions` を付けないため除外されません）。  
この手順を飛ばすと、存在しない / 古い指摘ファイルを `--instructions` に渡して `--fix` が走るおそれがあります。

### CLI を起動できない環境（`subagent` モード）

クラウド実行やリモートコントロール環境では、`codex` / `claude` の CLI を起動できないことがあります。  
CLI は起動できても、ネットワーク/API 接続が許可されずレビュー結果が返らないこともあります。  
切り分けるときは、まず `Get-Command claude` / `claude --version`（または `codex --version`）で CLI 可視性を確認し、次に `claude -p "Reply with OK only."` のような最小 API 呼び出しを通常環境とネットワーク許可環境で比較します。  
このときは対象レビュアー CLI の代わりに `subagent` を指定します。  
すると外部プロセスを起動せず、組み立てたレビュー用プロンプト（観点 + 差分 + モード別の指示）を stdout に出力するだけになります（人向けの通知は stderr に分けます）。  
この出力を呼び出し側が利用できる客観レビュー用エージェントへ渡します。  
`--uncommitted` / `--base` / `--fix` / `--instructions` は他のレビュアーと同じように使えます。  
ただし `subagent --fix`（修正まで任せる）は **Claude 起点 B**（レビュアーが修正）の代替に限ります。**Codex 起点**では `subagent` はレビューのみで、修正は Codex が行います。  
詳しくは [docs/cross-review.md](docs/cross-review.md) を参照してください。

| オプション | 意味 |
|------------|------|
| `--fix` | 修正まで依頼する（`codex` は `-s workspace-write` で直接修正 / `subagent` は FIX 指示付きでプロンプト出力。`claude` CLI 経路は非対応） |
| `--uncommitted` | 未コミットの作業ツリー差分（tracked + untracked）をレビュー |
| `--base <ref>` | 比較先ブランチを指定（既定: 未指定なら `origin/main` を優先解決し、無ければ `main`） |
| `--max-diff-kb <n>` | レビュー差分サイズの上限（KB）。超過時はレビュアーを起動せず中断（既定 256・`0` で無効。環境変数 `CROSS_REVIEW_MAX_DIFF_KB` でも指定可） |
| `--max-file-diff-kb <n>` | ファイル単位の差分がこの KB を超えたら本文を stat 要約に置換（既定 64・`0` で無効。環境変数 `CROSS_REVIEW_MAX_FILE_DIFF_KB` でも指定可） |
| `--no-exclude` | 既定除外も含めすべての除外を無効化（生成物・ロックファイルもまとめてレビューしたいとき） |
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

## 差分の除外（`.cross-review-ignore`）

ロックファイル・生成物（`package-lock.json` / `*.min.js` / `*.map` など）はレビュー価値が低くトークンを浪費するため、**既定で差分本文から除外**します（除外したファイル名はプロンプトに残るので、必要なら個別に読めます）。  
除外を増やしたいときは `.cross-review-ignore` に **1 行 1 パターン**で足します（`#` 始まりはコメント・空行は無視。観点と同じ解決順で `CROSS_REVIEW_IGNORE` / `<cwd>` / スクリプト基準から探す）。

```text
# .cross-review-ignore の例（既定パターンに追加される）
docs/generated/*.md
*.snap
```

`--no-exclude` で既定除外も含めすべて無効化できます。巨大なファイル差分は `--max-file-diff-kb`（既定 64KB・`0` で無効）で stat 要約に置換します。詳しくは [docs/cross-review.md](docs/cross-review.md) を参照してください。

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
| `tools/cross-review.sync.js` | 同期スクリプト本体（上流から取り込む / ドリフト検査） | なし（そのまま）。手動コピーの代わりに使える（後述「同期スクリプトで更新する」） |
| `tools/cross-review.sync-all.js`（任意） | 一括同期ツール（作業ルート配下の導入プロジェクトをまとめて同期） | なし（そのまま）。`/Develop` などをまとめて更新する人だけ入れればよい（後述「複数プロジェクトへ一括で反映する」） |
| `tools/cross-review.sync.example.json` | 同期マニフェストのテンプレート | なし。**コピーして `tools/cross-review.sync.json` を作り、そちらを編集する** |
| `.claude/skills/cross-review/SKILL.md`（任意） | 相互レビューの実行手順（Claude Code スキル・汎用） | なし（そのまま）。Claude Code を使うなら入れる。プロジェクト固有の運用は `.cross-review.md` と自分の doc に分け、スキルには書かない |
| `tests/cross-review.test.js`（任意） | 本体のユニットテスト（vitest） | **取り込み先が vitest のときだけ同梱**。require のパスをコピー先のテスト配置に合わせる（engine は upstream のテストが担保） |
| `tests/cross-review.sync.test.js`（任意） | 同期スクリプトのユニットテスト（vitest） | **取り込み先が vitest のときだけ同梱**。require のパスをコピー先のテスト配置に合わせる |
| `tests/cross-review.sync-all.test.js`（任意） | 一括同期ツールのユニットテスト（vitest） | **`cross-review.sync-all.js` を入れ、かつ vitest のときだけ同梱**。require のパスを合わせる |
| `.cross-review.example.md` | 観点のテンプレート | なし。**コピーして `.cross-review.md` を作り、そちらを編集する** |
| `docs/cross-review.md` | 相互レビューの手順書（汎用） | なし（そのまま）。ファイルは名前で参照していて、置き場所が変わっても壊れない |

### 自分で編集するファイル（コピーで上書きしない）
| ファイル | 役割 |
|----------|------|
| `.cross-review.md` | そのプロジェクトのレビュー観点（`.cross-review.example.md` を雛形に作る） |
| `CLAUDE.md` / `AGENTS.md`（あれば） | そのリポジトリの運用メモ。手順の詳細はコピーした `docs/cross-review.md` へリンクする |
| そのプロジェクト用の doc（任意） | 手順書に書かない、プロジェクト固有のメモ（検証コマンド・CI・例 など） |
| `tools/package.json` | `tools/*.js` を CommonJS にする設定（`"type": "commonjs"`）。そのリポジトリのツール依存もここに足す |
| `tools/cross-review.sync.json` | そのプロジェクトの同期マニフェスト（`tools/cross-review.sync.example.json` を雛形に作る）。取り込むファイルの `from`/`to`・取り込み元 `repo`/`ref` を書く。`lastSyncedCommit` は同期時に自動で更新される（どの版から取り込んだかの記録） |

### 手順
1. 上の「そのままコピーするファイル」を全部コピー先へコピーする（`tools/*.js` は CommonJS なので、コピー先のルート `package.json` が `"type": "module"` のときは `tools/package.json` に `"type": "commonjs"` を置く）。  
   テスト `tests/cross-review.test.js` は任意で、取り込み先が vitest のときだけ require パスを合わせて同梱する。  
2. `.cross-review.example.md` を `.cross-review.md` にコピーし、そのプロジェクトで壊れやすい注意点を書く。  
3. ルート `package.json` の `scripts` に `review:codex` / `review:codex:fix` / `review:claude` を足す。  
   同期スクリプトを使うなら `sync` / `sync:check` も足す（後述「同期スクリプトで更新する」）。  
4. Claude Code を使うなら `.claude/skills/cross-review/SKILL.md` をコピーする（実行手順スキル・汎用）。  
   このスキルは vendored（上書き更新の対象）なので**直接編集せず**、プロジェクト固有の運用（検証コマンド・CI・同期スクリプト名など）は `.cross-review.md` や自分の doc 側に書く。  
5. `codex` / `claude` の CLI を PATH に通す（CLI を起動できないときは `subagent` モードを使う）。  
6. 更新するときは、コピーするファイルを上書きでコピーし直すだけ。  
   自分で編集するファイルは触らない。  
   毎回手でコピーする代わりに、後述の**同期スクリプト**でこの上書きコピーを自動化できる。

### 同期スクリプトで更新する（手動コピーの代わり）

「そのままコピーするファイル」を毎回手で上書きする代わりに、`tools/cross-review.sync.js` でまとめて取り込めます。  
どのファイルをどこへ取り込むかは `tools/cross-review.sync.json`（マニフェスト）に書きます。  
`tools/cross-review.sync.example.json` を雛形にコピーして編集してください。

1. `tools/cross-review.sync.example.json` を `tools/cross-review.sync.json` にコピーする。  
2. `upstream.repo`（このツールの git URL）と `upstream.ref`（取り込む版。既定 `main`）を書く。  
3. `files` に取り込むファイルを `from`（上流相対）/ `to`（自分のプロジェクト相対）で並べる。  
   テストのように require パスを取り込み先へ合わせたいときは `replace`（文字列の全置換）を足す。  
4. ルート `package.json` の `scripts` に登録する（任意。コマンド名は自由）:

   ```json
   "scripts": {
     "sync": "node tools/cross-review.sync.js",
     "sync:check": "node tools/cross-review.sync.js --check"
   }
   ```

5. 取り込み・検査を実行する:

   ```bash
   node tools/cross-review.sync.js            # 上流から取り込む（差分のあるファイルだけ上書き）
   node tools/cross-review.sync.js --check    # ドリフト検査のみ（書き込まない。差分があれば exit 1 → CI 向け）
   node tools/cross-review.sync.js --dry-run  # 何が変わるかだけ表示（書き込まない）
   node tools/cross-review.sync.js --ref v1.2.3   # 取り込む版をマニフェストより優先
   ```

取り込み元の取得は **git のみ**で行います（`upstream.ref` を一時ディレクトリへ shallow fetch）。  
取り込んだ実コミットは `lastSyncedCommit` に記録され、どの版から取り込んだかが残ります。  
詳細・マニフェストの形は [docs/cross-review.md](docs/cross-review.md) の「同期スクリプト」節を参照してください。

> **メモ（末尾空白）**: `docs/cross-review.md` などは Markdown のハード改行（行末スペース 2 つ）を使います。
> `git diff --check` や CI で末尾空白を弾く場合は、コピー先の `.gitattributes` に
> `*.md whitespace=-blank-at-eol` を足して許容してください（このリポジトリにも同じ設定があります）。

### 複数プロジェクトへ一括で反映する（sync-all）

導入プロジェクトが増えると、上流を更新するたびに 1 リポずつ `cross-review.sync.js` を回すのは手間です。  
`tools/cross-review.sync-all.js` は、ローカルの作業ルート（例: `/Develop`）配下を走査して、**同期マニフェスト `cross-review.sync.json` を持つディレクトリ＝導入プロジェクト**を自動判定し、まとめて同期します。

```bash
node tools/cross-review.sync-all.js --root /Develop --list    # 検出したプロジェクトを列挙するだけ
node tools/cross-review.sync-all.js --root /Develop --check   # 各プロジェクトをドリフト検査（書き込まない。差分があれば exit 1）
node tools/cross-review.sync-all.js --root /Develop --dry-run # 各プロジェクトで何が変わるかだけ表示
node tools/cross-review.sync-all.js --root /Develop           # 各プロジェクトを一括同期（上書き更新）
node tools/cross-review.sync-all.js --root /Develop --ref v1.2.3  # 取り込む上流 ref を全プロジェクト共通で上書き
```

- 各プロジェクトの同期は、そのプロジェクトに同梱された版ではなく、**この checkout の `cross-review.sync.js`（最新ロジック）を再利用**して回します。導入先の sync スクリプトが古くても最新の挙動で反映できます。取り込むファイルや上流 ref は各プロジェクトの `cross-review.sync.json` を尊重します（`--ref` で一時的に上書き可）。
- **1 プロジェクトの失敗（マニフェスト不正・上流取得失敗など）で全体は止まりません**。各プロジェクトを独立に回し、最後に「更新 / 変更なし / ドリフト / エラー」の集計を出します。終了コードは「いずれかが失敗」または「`--check` でいずれかにドリフト」のとき 1（CI 向け）。
- 走査の最大深さは `--depth <n>`（既定 4）で調整します。`node_modules` / `.git` / 隠しディレクトリは走査しません。
- このリポジトリの `package.json` には `npm run sync:all` / `npm run sync:all:check` を用意しています（`--root` を付けて使います）。

```bash
npm run sync:all -- --root /Develop          # 一括同期
npm run sync:all:check -- --root /Develop     # 一括ドリフト検査（CI 向け）
```

## 開発

```bash
npm install        # devDependencies (vitest / eslint) を入れる
npm test           # ユニットテスト (引数解析・差分生成・プロンプト生成・観点解決・申し送り注入・同期スクリプト)
npm run lint       # ESLint
```

このリポジトリ自身のレビュー観点は [.cross-review.md](.cross-review.md) にあります。
