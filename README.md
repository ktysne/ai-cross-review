# ai-cross-review

**Claude と Codex に、git の差分を使って交互にコードレビューさせる CLI ツールです。**  
追加の依存パッケージは要りません。

「片方の AI で実装し、もう片方の AI でレビューする」という往復を回します。  
チャットの中身を手でコピーする必要はありません。  
git の差分をそのままレビュアー CLI（`codex` / `claude`）へ渡し、1 コマンドで実行します。  
レビューの観点は、プロジェクトごとに `.cross-review.md` へ書くだけで差し替えられます。

## 特徴

- **追加インストール不要**：本体（`tools/cross-review.js`）は Node 標準 API だけで動きます。  
  テストと lint のときだけ devDependencies を使います。  
- **git の差分でやり取り**：ブランチとベースの差分、または未コミットの差分（未追跡ファイルを含む）を渡します。  
  チャットの中身を手でコピーする必要はありません。  
- **既定は安全側**：レビューだけのときは `codex` を read-only で起動し、ファイルを書き換えさせません。  
  `--fix` を付けたときだけ workspace-write で起動し、見つかった問題を直接修正させます。  
- **CLI を起動できない環境にも対応**：クラウド / リモート実行で `codex` / `claude` CLI を起動できない（または API 接続が通らない）ときは、`subagent` モードがレビュー用プロンプトを stdout に出力します。  
  それを Claude の客観サブエージェントへ渡せば、外部 CLI 無しで同じ観点のレビューを回せます（後述「CLI を起動できない環境（`subagent` モード）」）。  
- **トークンを節約**：ロックファイル、生成物（`package-lock.json` / `*.min.js` / `*.map` など）を既定で差分から除外し、巨大なファイル差分は stat 要約に置換します。  
  既定の比較先は「前回レビュー SHA → PR の base → `origin/main` → ローカル `main`」の順に解決し、差分サイズが閾値を超えたらファイル要約で縮退を試みたうえで、収まらなければレビュアーを起動せず中断します（stale なローカル `main` による差分の肥大を防ぎます）。  
- **観点を分離**：プロジェクト固有のレビュー観点は `.cross-review.md` に分けてあります。  
  本体は完全に汎用です。  
  導入するときは、決まったファイル一式をコピーし、`.cross-review.md` だけを自分のプロジェクト向けに編集します。  
- **配布と更新を仕組み化**：同期スクリプト（`tools/cross-review.sync.js`）と一括同期ツール（`tools/cross-review.sync-all.js`）で、上流の更新を導入先へまとめて反映できます。  
  Claude Code 用の実行手順スキル（`.claude/skills/cross-review/SKILL.md`）も同梱します。

## 前提

- Node.js 20 以上。  
- `codex` / `claude` の **スタンドアロン CLI** が PATH にあること（VS Code 拡張やデスクトップアプリとは別物です）。  
  実際にレビューを走らせるのに必要です。  
  `review:codex*` / `review:claude` はレビュアー CLI のネットワーク/API 接続も必要です。  
  CLI が見えていても API 接続だけ失敗することがあります。`claude -p "Reply with OK only."` のような最小コマンドが通常サンドボックスで無応答 / `ConnectionRefused` になり、ネットワーク許可、サンドボックス外で成功するなら、原因は CLI ではなく実行環境のネットワーク制限です。  
  CLI が無くても、引数の解析や差分の生成は動きます。  
  クラウド実行などで CLI を起動できないときは、後述の `subagent` モードを使えば CLI 無しでレビュー用プロンプトを出力できます。

> **課金メモ（Claude サブスクプラン）**：Anthropic は **2026-06-15 に施行予定だった「Agent SDK 経由の利用を別建ての月次クレジット枠へ移す」課金変更を、施行当日に保留**しました。現在は `claude -p`（`review:claude` が内部で使うヘッドレス実行）や Agent SDK 経由の利用も、**従来どおりサブスク（Pro / Max / Team / Enterprise）の利用上限から消費**されます（別建ての Agent SDK クレジット枠は無し）。`review:codex*`（OpenAI の Codex CLI）や `subagent`（外部 API を呼ばずプロンプトを出力するだけ）はそもそも Claude サブスクの対象外です。Anthropic は今後の課金見直しを予告しており、変更時は事前告知するとしています。詳細は [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) を参照。

## 使い方

```bash
npm run review:codex                      # 現在のブランチ (既定 base との差分) を Codex がレビュー (read-only)
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
node tools/cross-review.js codex --no-codex-agent   # claude-codex-bridge (codex-agent.sh) を経由せず codex を直接起動
node tools/cross-review.js codex --no-fallback      # GPT 側が使えなくても subagent 代替へ切り替えず失敗終了する
node tools/cross-review.js state                    # この枝の往復回数・直前レビュー SHA・非対応指摘を表示 (--reset で消去)
node tools/cross-review.js state --mark             # 往復を 1 回分記録する (CLI がレビューの成立を観測できない経路の後で使う)
node tools/cross-review.js dismiss "<要約>"          # 非対応と判断した指摘を記録し、以降のレビューで再指摘させない
node tools/cross-review.js comment --round 1        # 判断ファイルと検証出力から PR コメント本文を生成 (投稿はしない)
node tools/cross-review.js comment --round 1 --post 42  # 生成本文を PR #42 へ標準入力経由で投稿
node tools/cross-review.js artifacts --clean-legacy     # 旧形式の平置き出力を削除
node tools/cross-review.js --help
```

### Codex が実装した差分を Claude がレビューする例

レビュアーを実装者と別のベンダーにする最短例です（Codex が実装したので、レビュアーは Claude になります）。

```bash
npm run review:claude -- --uncommitted    # Claude がレビュー（結果を確認）
# 主セッションが指摘を裏取りし、直すと決めたものを適用する
npm run review:claude -- --uncommitted    # Claude が妥当性確認
```

確定した指摘の適用だけを Codex に任せたいときは、指摘をファイルへ書き出して `--fix --instructions` を使います。

```bash
node tools/cross-review.js codex --fix --uncommitted --instructions ../review-notes.md
```

`../review-notes.md` は自動生成されません。レビュー結果から今回直す指摘だけを確認して書き出してください。  
リポジトリ外（例：親ディレクトリ）に置くのは、妥当性確認 `npm run review:claude -- --uncommitted` で、このファイル自体が未追跡差分としてレビューに混ざるのを防ぐためです（`--instructions` 指定時は対象から自動除外されますが、妥当性確認は `--instructions` を付けないため除外されません）。  
この手順を飛ばすと、存在しない / 古い指摘ファイルを `--instructions` に渡して `--fix` が走るおそれがあります。

実装を一区切りしたときに示す 3 択と、どちらのベンダーがレビュアーになるかの決め方は [docs/cross-review.md](docs/cross-review.md) の「実装完了後の起点」節を参照してください。

### CLI を起動できない環境（`subagent` モード）

クラウド実行やリモートコントロール環境では、`codex` / `claude` の CLI を起動できないことがあります。  
CLI は起動できても、ネットワーク/API 接続が許可されずレビュー結果が返らないこともあります。  
切り分けるときは、まず `Get-Command claude` / `claude --version`（または `codex --version`）で CLI 可視性を確認し、次に `claude -p "Reply with OK only."` のような最小 API 呼び出しを通常環境とネットワーク許可環境で比較します。  
このときは対象レビュアー CLI の代わりに `subagent` を指定します。  
すると外部プロセスを起動せず、組み立てたレビュー用プロンプト（観点 + 差分 + モード別の指示）を stdout に出力するだけになります（人向けの通知は stderr に分けます）。  
この出力を呼び出し側が利用できる客観レビュー用エージェントへ渡します。  
`--uncommitted` / `--base` / `--fix` / `--instructions` は他のレビュアーと同じように使えます。  
ただし `subagent --fix`（修正まで任せる）は、主セッションがレビュアーに修正まで任せると決めたときだけ使います。実装完了後に示す 3 択には、レビュアーが修正する選択肢はありません。  
詳しくは [docs/cross-review.md](docs/cross-review.md) を参照してください。

| オプション | 意味 |
|------------|------|
| `--fix` | 修正まで依頼する（`codex` は `-s workspace-write` で直接修正 / `subagent` は FIX 指示付きでプロンプト出力。`claude` CLI 経路は非対応） |
| `--uncommitted` | 未コミットの作業ツリー差分（tracked + untracked）をレビュー |
| `--base <ref>` | 比較先のブランチまたはコミットを指定（既定：未指定なら 前回レビュー SHA → PR の base → `origin/main` → ローカル `main` の順に解決） |
| `--max-diff-kb <n>` | レビュー差分サイズの上限（KB）。超過時はファイル要約の閾値を段階的に下げて縮退を試み、収まらなければ起動せず中断（既定 256、`0` で無効。環境変数 `CROSS_REVIEW_MAX_DIFF_KB` でも指定可） |
| `--max-file-diff-kb <n>` | ファイル単位の差分がこの KB を超えたら本文を stat 要約に置換（既定 64、`0` で無効。環境変数 `CROSS_REVIEW_MAX_FILE_DIFF_KB` でも指定可） |
| `--strict-diff-guard` | 差分サイズ超過時に段階的縮退を試さず、従来どおり即中断する |
| `--no-state` | 状態ファイル（`.cross-review-state.json`）の読み書きを行わない（CI 等） |
| `--no-exclude` | 既定除外も含めすべての除外を無効化（生成物、ロックファイルもまとめてレビューしたいとき） |
| `--instructions <path>` | レビュアーへの申し送り、重点指摘ファイルをプロンプトに追加する（観点 `.cross-review.md` は置き換えず追加。`--fix` と併用すると、その指摘を直接修正させる） |
| `--no-pr-check` | レビュー実行前の PR 存在確認（`gh pr view`）を省く（既定では PR が無いと分かったときだけ警告し、実行は止めません） |
| `--round <N>` | `comment` 専用。対象の往復番号（必須） |
| `--reviewer <name>` | `comment` 専用。対象のレビュアー（省略時はブランチ別ディレクトリのメタ情報から自動選択。複数あればエラー） |
| `--verify <path>` | `comment` 専用。検証コマンドの出力ファイルを「確認内容」節に入れる（長い出力は末尾 200 行） |
| `--out <path>` | `comment` 専用。生成した本文の書き出し先（既定はブランチ別ディレクトリの `round-<N>-comment.md`） |
| `--post <N>` | `comment` 専用。生成本文を PR #N へ `gh pr comment N --body-file -` の標準入力で投稿（1 以上の整数） |
| `--clean-legacy` | `artifacts` 専用。`.cross-review` 直下に残る旧形式の `round-<正整数>-*.md/json` だけを削除 |
| `-h`, `--help` | ヘルプを表示 |

### PR コメントを生成する（`comment`）

往復を記録できたとき、レビュアーの出力とメタ情報は、開始時のブランチ名を安全化した `.cross-review/branch-<slug>-<hash>/round-<N>-*` に保存されます。  
旧形式の平置き出力は自動で読みません。必要なら `artifacts --clean-legacy` で `.cross-review` 直下の対象ファイルだけを削除できます。  
ブランチ別ディレクトリの `round-<N>-triage.md` に裏取りと対応を書いてから `comment` を実行すると、`gh pr comment --body-file` へ渡す本文ができます。既定では投稿せず、`--post <PR番号>` を付けたときだけ本文を先に保存して同じメモリ本文を標準入力で投稿します。投稿に失敗した場合は保存本文を削除します。

```bash
npm run review:codex                                        # レビュー (出力が .cross-review/ に保存される)
# .cross-review/branch-<slug>-<hash>/round-1-triage.md に裏取りと対応を書く (無ければ雛形が出ます)
npm test > verify.log 2>&1
node tools/cross-review.js comment --round 1 --verify verify.log
gh pr comment <番号> --body-file .cross-review/branch-<slug>-<hash>/round-1-comment.md
# 投稿まで自動化する場合
node tools/cross-review.js comment --round 1 --verify verify.log --post <番号>
```

`.cross-review/` は生成物なので `.gitignore` に追加します。  
詳しくは [docs/cross-review.md](docs/cross-review.md) の「PR を共有ログにする」節を参照してください。

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

ロックファイル、生成物（`package-lock.json` / `*.min.js` / `*.map` など）はレビュー価値が低くトークンを浪費するため、**既定で差分本文から除外**します（除外したファイル名はプロンプトに残るので、必要なら個別に読めます）。  
除外を増やしたいときは `.cross-review-ignore` に **1 行 1 パターン**で足します（`#` 始まりはコメント、空行は無視。観点と同じ解決順で `CROSS_REVIEW_IGNORE` / `<cwd>` / スクリプト基準から探す）。

```text
# .cross-review-ignore の例（既定パターンに追加される）
docs/generated/*.md
*.snap
```

`--no-exclude` で既定除外も含めすべて無効化できます。巨大なファイル差分は `--max-file-diff-kb`（既定 64KB、`0` で無効）で stat 要約に置換します。詳しくは [docs/cross-review.md](docs/cross-review.md) を参照してください。

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
| `.claude/skills/cross-review/SKILL.md`（任意） | 相互レビューの実行手順（Claude Code スキル、汎用） | なし（そのまま）。Claude Code を使うなら入れる。プロジェクト固有の運用は `.cross-review.md` と自分の doc に分け、スキルには書かない |
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
| そのプロジェクト用の doc（任意） | 手順書に書かない、プロジェクト固有のメモ（検証コマンド、CI、例 など） |
| `tools/package.json` | `tools/*.js` を CommonJS にする設定（`"type": "commonjs"`）。そのリポジトリのツール依存もここに足す |
| `tools/cross-review.sync.json` | そのプロジェクトの同期マニフェスト（`tools/cross-review.sync.example.json` を雛形に作る）。取り込むファイルの `from`/`to`、取り込み元 `repo`/`ref` を書く。`lastSyncedCommit`（どの版から取り込んだかの記録）と `shownMigrations`（表示済みの移行ノート）は同期時に自動で更新される |

### 手順
1. 上の「そのままコピーするファイル」を全部コピー先へコピーする（`tools/*.js` は CommonJS なので、コピー先のルート `package.json` が `"type": "module"` のときは `tools/package.json` に `"type": "commonjs"` を置く）。  
   テスト `tests/cross-review.test.js` は任意で、取り込み先が vitest のときだけ require パスを合わせて同梱する。  
2. `.cross-review.example.md` を `.cross-review.md` にコピーし、そのプロジェクトで壊れやすい注意点を書く。  
3. ルート `package.json` の `scripts` に `review:codex` / `review:codex:fix` / `review:claude` を足す。  
   同期スクリプトを使うなら `sync` / `sync:check` も足す（後述「同期スクリプトで更新する」）。  
4. Claude Code を使うなら `.claude/skills/cross-review/SKILL.md` をコピーする（実行手順スキル、汎用）。  
   このスキルは vendored（上書き更新の対象）なので**直接編集せず**、プロジェクト固有の運用（検証コマンド、CI、同期スクリプト名など）は `.cross-review.md` や自分の doc 側に書く。  
5. `.gitignore` に `.cross-review-state.json`（往復回数、直前レビュー SHA、非対応と判断した指摘を持つローカル状態）と `.cross-review/`（往復ごとのレビュー出力、判断ファイル、生成した PR コメント本文）を足す。どちらも共有せず、共有は PR コメントで行う。  
6. `codex` / `claude` の CLI を PATH に通す（CLI を起動できないときは `subagent` モードを使う）。  
7. 更新するときは、コピーするファイルを上書きでコピーし直すだけ。  
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
4. ルート `package.json` の `scripts` に登録する（任意。コマンド名は自由）：

   ```json
   "scripts": {
     "sync": "node tools/cross-review.sync.js",
     "sync:check": "node tools/cross-review.sync.js --check"
   }
   ```

5. 取り込み、検査を実行する：

   ```bash
   node tools/cross-review.sync.js            # 上流から取り込む（差分のあるファイルだけ上書き）
   node tools/cross-review.sync.js --check    # ドリフト検査のみ（書き込まない。差分があれば exit 1 → CI 向け）
   node tools/cross-review.sync.js --dry-run  # 何が変わるかだけ表示（書き込まない）
   node tools/cross-review.sync.js --ref v1.2.3   # 取り込む版をマニフェストより優先
   node tools/cross-review.sync.js --check-manifest  # 上流の雛形にあって files[] に無い配布物を列挙（--check を含意。書き込まない）
   ```

取り込み元の取得は **git のみ**で行います（`upstream.ref` を一時ディレクトリへ shallow fetch）。  
取り込んだ実コミットは `lastSyncedCommit` に記録され、どの版から取り込んだかが残ります。  
同期では直せない取り込み先側の作業（`.gitignore`、`package.json` の `scripts`、`CLAUDE.md` の節）があるときは、上流の**移行ノート**（`docs/migrations/`）のうち未読のものが stderr に表示されるので、同期のあとに対応してください（表示済みのノートは `shownMigrations` に記録され、二度は出ません）。  
詳細、マニフェストの形は [docs/cross-review.md](docs/cross-review.md) の「同期スクリプト」節を参照してください。

> **メモ（末尾空白）**：`docs/cross-review.md` などは Markdown のハード改行（行末スペース 2 つ）を使います。
> `git diff --check` や CI で末尾空白を弾く場合は、コピー先の `.gitattributes` に
> `*.md whitespace=-blank-at-eol` を足して許容してください（このリポジトリにも同じ設定があります）。

> **メモ（doc を生成する / エントリ doc を分けるプロジェクト）**：取り込み先が Markdown を HTML へ生成する（docs パイプラインを持つ）場合や、相互レビューの「入口 doc」を別に置きたい場合は、次のようにマニフェストで吸収できます。
> - `docs/cross-review.md`（汎用フロー）を、自分のプロジェクトのパスへ `to` で map する（例：`documents/developer/md/cross-review-flow.md`）。これは **vendored（再同期で上書き）** のまま扱う。
> - **プロジェクト固有の運用**（検証コマンド、CI、配置、例）は、vendored doc に書かず、別の **overlay doc**（取り込み先が所有、編集する）と `.cross-review.md` に分ける。overlay からは vendored フロー doc へリンクする。
> - 同期はファイル内容を上書きするだけで、`docs:build` のような **生成 / ビルドは取り込み先の責務**です。再同期後に各自の docs ビルドを回してください（drift 検査があれば CI で取りこぼしを検出できます）。

### 複数プロジェクトへ一括で反映する（sync-all）

導入プロジェクトが増えると、上流を更新するたびに 1 リポずつ `cross-review.sync.js` を回すのは手間です。  
`tools/cross-review.sync-all.js` は、ローカルの作業ルート（例：`/Develop`）配下を走査して、**同期マニフェスト `cross-review.sync.json` を持つディレクトリ＝導入プロジェクト**を自動判定し、まとめて同期します。

```bash
node tools/cross-review.sync-all.js --root /Develop --list    # 検出したプロジェクトを列挙するだけ
node tools/cross-review.sync-all.js --root /Develop --check   # 各プロジェクトをドリフト検査（書き込まない。差分があれば exit 1）
node tools/cross-review.sync-all.js --root /Develop --dry-run # 各プロジェクトで何が変わるかだけ表示
node tools/cross-review.sync-all.js --root /Develop           # 各プロジェクトを一括同期（上書き更新）
node tools/cross-review.sync-all.js --root /Develop --ref v1.2.3  # 取り込む上流 ref を全プロジェクト共通で上書き
node tools/cross-review.sync-all.js --global-skill            # 相互レビュー SKILL をホームの共通配置へ配る（走査しない）
```

- 各プロジェクトの同期は、そのプロジェクトに同梱された版ではなく、**この checkout の `cross-review.sync.js`（最新ロジック）を再利用**して回します。導入先の sync スクリプトが古くても最新の挙動で反映できます。取り込むファイルや上流 ref は各プロジェクトの `cross-review.sync.json` を尊重します（`--ref` で一時的に上書き可）。
- **1 プロジェクトの失敗（マニフェスト不正、上流取得失敗など）で全体は止まりません**。各プロジェクトを独立に回し、最後に「更新 / 変更なし / ドリフト / エラー」の集計を出します。終了コードは「いずれかが失敗」または「`--check` でいずれかにドリフト」のとき 1（CI 向け）。
- 走査の最大深さは `--depth <n>`（既定 4）で調整します。`node_modules` / `.git` / 隠しディレクトリは走査しません。
- `--check` では各プロジェクトのマニフェスト検査（`sync --check-manifest`）も回し、未登録があれば集計行に「（マニフェスト未登録 N 件）」が付きます（ドリフトではないので終了コードには含めません）。検査が回らなかったとき（上流に雛形が無い / 読めない / 構造が不正）は「（マニフェスト検査スキップ）」が付き、理由が集計行の直後に出ます。
- `--global-skill` は相互レビュー SKILL を `~/.claude/skills/cross-review/` へ配ります（`~/.codex/skills/` は既にあるときだけ）。汎用ルールの写しを各リポジトリに持たせないための配布口です。詳細は [docs/cross-review.md](docs/cross-review.md) の「グローバル SKILL の配布」節を参照してください。
- このリポジトリの `package.json` には `npm run sync:all` / `npm run sync:all:check` / `npm run sync:global` を用意しています（前 2 つは `--root` を付けて使います）。

```bash
npm run sync:all -- --root /Develop          # 一括同期
npm run sync:all:check -- --root /Develop     # 一括ドリフト検査（CI 向け）
npm run sync:global                           # グローバル SKILL の配布
```

## 開発

```bash
npm install        # devDependencies (vitest / eslint) を入れる
npm test           # ユニットテスト (引数解析、差分生成、プロンプト生成、観点解決、申し送り注入、除外/要約、同期スクリプト、一括同期)
npm run lint       # ESLint
```

このリポジトリ自身のレビュー観点は [.cross-review.md](.cross-review.md) にあります。
