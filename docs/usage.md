# ai-cross-review の使い方

導入の手順は [setup.md](setup.md) にあります。この文書は、導入した後のコマンドと機能を説明します。
実装を一区切りしたときの 3 択、往復の上限、PR への記録といった運用の手順は [cross-review.md](cross-review.md) にあります。

## レビューを回す

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
node tools/cross-review.js route                    # agent-cockpit の経路設定からレビュアーを読む (codex / claude / default)
node tools/cross-review.js state                    # この枝の往復回数・直前レビュー SHA・非対応指摘・最後の結論を表示 (--reset で消去)
node tools/cross-review.js state --mark             # 往復を 1 回分記録する (CLI がレビューの成立を観測できない経路の後で使う)
node tools/cross-review.js dismiss "<要約>"          # 非対応と判断した指摘を記録し、以降のレビューで再指摘させない
node tools/cross-review.js comment --round 1 --outcome fixing  # 本文を生成し、対応中の結論を記録 (投稿はしない)
node tools/cross-review.js comment --round 1 --post 42  # 生成本文を PR #42 へ標準入力経由で投稿
node tools/cross-review.js artifacts --clean-legacy     # 旧形式の平置き出力を削除
node tools/cross-review.js --help
```

レビュアーの CLI（`review:codex*`、`review:claude`）は、ネットワークと API への接続を使います。サンドボックスで実行するときは、ネットワークを許可してください。

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

実装を一区切りしたときに示す 3 択と、どちらのベンダーがレビュアーになるかの決め方は [cross-review.md](cross-review.md) の「実装完了後の起点」節を参照してください。

## オプション

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
| `--no-codex-agent` | claude-codex-bridge の起動スクリプトを経由せず、`codex` を直接起動する |
| `--codex-agent <name>` | bridge で使う定義名を明示する（既定：レビューのみ `codex-review`、`--fix` は `codex-subagent`） |
| `--no-fallback` | GPT 側が使えないときに subagent 代替へ切り替えず、失敗で終わる |
| `--fallback-prompt <path>` | GPT 側が使えないときに書き出す代替プロンプトの置き場（既定は OS の一時ディレクトリの `cross-review-fallback-<pid>.md`） |
| `--override-route <理由>` | agent-cockpit の経路設定に反するレビュアーで実行する。理由は往復のメタ情報と PR コメントに残る |
| `--round <N>` | `comment` 専用。対象の往復番号（必須） |
| `--reviewer <name>` | `comment` 専用。対象のレビュアー（省略時はブランチ別ディレクトリのメタ情報から自動選択。複数あればエラー） |
| `--verify <path>` | `comment` 専用。検証コマンドの出力ファイルを「確認内容」節に入れる（長い出力は末尾 200 行） |
| `--out <path>` | `comment` 専用。生成した本文の書き出し先（既定はブランチ別ディレクトリの `round-<N>-comment.md`） |
| `--post <N>` | `comment` 専用。生成本文を PR #N へ `gh pr comment N --body-file -` の標準入力で投稿（1 以上の整数） |
| `--outcome <fixing\|converged\|halted>` | `comment` 専用。往復の結論を状態ファイルに記録する（値の意味は [cross-review.md](cross-review.md) の「状態ファイル」） |
| `--clean-legacy` | `artifacts` 専用。`.cross-review` 直下に残る旧形式の `round-<正整数>-*.md/json` だけを削除 |
| `-h`, `--help` | ヘルプを表示 |

## CLI を起動できない環境（`subagent` モード）

クラウド実行環境などでは、`codex` / `claude` の CLI を起動できないことがあります。  
CLI は起動できても、ネットワーク/API 接続が許可されずレビュー結果が返らないこともあります。  
切り分けるときは、まず `Get-Command claude` / `claude --version`（または `codex --version`）で CLI 可視性を確認し、次に `claude -p "Reply with OK only."` のような最小 API 呼び出しを通常環境とネットワーク許可環境で比較します。  
このときは対象レビュアー CLI の代わりに `subagent` を指定します。  
すると外部プロセスを起動せず、組み立てたレビュー用プロンプト（観点 + 差分 + モード別の指示）を stdout に出力するだけになります（人向けの通知は stderr に分けます）。  
この出力を呼び出し側が利用できる客観レビュー用エージェントへ渡します。  
`--uncommitted` / `--base` / `--fix` / `--instructions` は他のレビュアーと同じように使えます。  
ただし `subagent --fix`（修正まで任せる）は、主セッションがレビュアーに修正まで任せると決めたときだけ使います。実装完了後に示す 3 択には、レビュアーが修正する選択肢はありません。  
`codex` が利用上限などで使えないときは、CLI が同じプロンプトをファイルへ書き出し、終了コード 75 で客観サブエージェントへ渡すよう案内します（`--no-fallback` で無効化）。  
詳しくは [cross-review.md](cross-review.md) の「CLI を起動できない環境での代替（subagent）」を参照してください。

## PR コメントを生成する（`comment`）

往復を記録できたとき、レビュアーの出力とメタ情報は、開始時のブランチ名を安全化した `.cross-review/branch-<slug>-<hash>/round-<N>-*` に保存されます。  
旧形式の平置き出力は自動で読みません。必要なら `artifacts --clean-legacy` で `.cross-review` 直下の対象ファイルだけを削除できます。  
ブランチ別ディレクトリの `round-<N>-triage.md` に裏取りと対応を書いてから `comment` を実行すると、`gh pr comment --body-file` へ渡す本文ができます。既定では投稿せず、`--post <PR番号>` を付けたときだけ本文を先に保存して同じメモリ本文を標準入力で投稿します。投稿に失敗した場合は保存本文を削除します。

```bash
npm run review:codex                                        # レビュー (出力が .cross-review/ に保存される)
# .cross-review/branch-<slug>-<hash>/round-1-triage.md に裏取りと対応を書く (無ければ雛形が出ます)
npm test > verify.log 2>&1
# 収束した場合は、指摘対応をコミットしてから --outcome converged を付ける
node tools/cross-review.js comment --round 1 --verify verify.log --outcome converged
gh pr comment <番号> --body-file .cross-review/branch-<slug>-<hash>/round-1-comment.md
# 投稿まで自動化する場合
node tools/cross-review.js comment --round 1 --verify verify.log --post <番号> --outcome converged
```

`--outcome` で記録した結論は、agent-cockpit と連携しているとき、PR のカードのクロスレビューの段に表示されます。  
詳しくは [cross-review.md](cross-review.md) の「PR を共有ログにする」節を参照してください。

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

`--no-exclude` で既定除外も含めすべて無効化できます。巨大なファイル差分は `--max-file-diff-kb`（既定 64KB、`0` で無効）で stat 要約に置換します。  
比較先は「前回レビュー SHA → PR の base → `origin/main` → ローカル `main`」の順に解決し、差分サイズが閾値を超えたらファイル要約で縮退を試みたうえで、収まらなければレビュアーを起動せず中断します。詳しくは [cross-review.md](cross-review.md) の「既定 base の解決と差分サイズのガード」を参照してください。

## 連携したときの動き

### claude-codex-bridge

`~/.claude/tools/codex-agent.sh`（または環境変数 `CROSS_REVIEW_CODEX_AGENT`）があれば、`codex` をその起動スクリプト経由で起動します。レビューだけなら定義 `codex-review`（read-only）、`--fix` なら `codex-subagent`（workspace-write）を使い、モデル、effort、認証ホームは bridge の定義ファイルで決まります。  
実際にどちらで起動したかは、実行時の stderr と、`.cross-review/` に残るメタ情報の `via` で分かります。詳しくは [cross-review.md](cross-review.md) の「codex の起動は bridge（codex-agent.sh）を経由する」を参照してください。

### agent-cockpit

レビューを回す直前に `node tools/cross-review.js route` を実行し、agent-cockpit の「経路の設定」で選んだレビュアーを読みます。`codex` か `claude` が返るときは、会話でのレビュアーの指定と同じに扱います。  
経路の設定に反するレビュアーのサブコマンドは起動を拒否します。会話での指定を優先するときは `--override-route <理由>` を付けます。詳しくは [cross-review.md](cross-review.md) の「agent-cockpit の経路設定（`route`）」を参照してください。

## 課金メモ（Claude サブスクプラン）

Anthropic は **2026-06-15 に施行予定だった「Agent SDK 経由の利用を別建ての月次クレジット枠へ移す」課金変更を、施行当日に保留**しました。現在は `claude -p`（`review:claude` が内部で使うヘッドレス実行）や Agent SDK 経由の利用も、**従来どおりサブスク（Pro / Max / Team / Enterprise）の利用上限から消費**されます（別建ての Agent SDK クレジット枠は無し）。`review:codex*`（OpenAI の Codex CLI）や `subagent`（外部 API を呼ばずプロンプトを出力するだけ）はそもそも Claude サブスクの対象外です。Anthropic は今後の課金見直しを予告しており、変更時は事前告知するとしています。詳細は [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) を参照。
