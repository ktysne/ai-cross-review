# ai-cross-review

**Claude と Codex に、git の差分を使って交互にコードレビューさせる CLI ツールです。**  
本体は Node.js 20 以上の標準 API だけで動き、追加の依存パッケージは要りません。

## 概要

「片方の AI で実装し、もう片方の AI でレビューする」往復を、チャットの中身を手でコピーせずに回します。  
レビューを回したいリポジトリへ導入して使う、リポジトリ単位のツールです。

- **差分をそのまま渡す**：ブランチと base の差分、または未コミットの差分（未追跡ファイルを含む）を、レビュアー CLI（`codex` / `claude`）へ 1 コマンドで渡します。
- **既定は安全側**：レビューだけのときは `codex` を read-only で起動します。`--fix` を付けたときだけ workspace-write で起動します。
- **CLI を起動できない環境にも対応**：クラウド実行などでは `subagent` モードがレビュー用プロンプトを stdout に出し、Claude の客観サブエージェントへ渡して同じ観点でレビューできます。
- **往復を記録する**：往復回数、直前にレビューした SHA、非対応と判断した指摘、結論をブランチ単位で記録し、PR コメントの本文を生成します。往復が 3 回目に達すると警告し、扱いは運用の規則（往復の上限）で決めます。
- **観点を分ける**：プロジェクト固有のレビュー観点は `.cross-review.md` に書きます。本体は汎用で、上書き更新できます。
- **配布と更新**：同期スクリプトで、上流の更新を導入先へ反映します。複数の導入先をまとめて更新するツールもあります。

画面やコマンドの使い方は [docs/usage.md](docs/usage.md)、往復の回し方（3 択、往復の上限、PR への記録）は [docs/cross-review.md](docs/cross-review.md) にあります。

## 連携できるツール

ai-cross-review は単独で使えます。次のツールを導入済みなら、使える機能が増えます。導入していなくても、レビューは止まりません。

| ツール | 概要 | 連携するとできること |
|---|---|---|
| [GitHub CLI（`gh`）](https://cli.github.com/) | GitHub の公式 CLI | 比較先（base）を PR の base ブランチから決めます。PR が無いときに警告します。生成した PR コメントを `--post` でそのまま投稿します。 |
| [claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge) | Claude Code から Codex CLI を、用途別のサブエージェントとして呼び出す定義一式 | `codex` を bridge の起動スクリプト経由で起動し、モデル、effort、認証ホーム（`CODEX_HOME`）を bridge の定義ファイルにそろえます。 |
| [agent-cockpit](https://github.com/ktysne/agent-cockpit) | Claude Code のセッションの状態を表示するローカルのダッシュボード | ダッシュボードの「経路の設定」で選んだレビュアーを、`node tools/cross-review.js route` で読みます。往復と結論が PR のカードに表示され、レビューの収束を待ってマージする予約に使われます。 |

## 導入

導入は AI（Claude Code、Codex など）に任せる前提で、手順を [docs/setup.md](docs/setup.md) にまとめています。
レビューを回したいリポジトリを開いたセッションで、AI に次のように依頼してください。

> このリポジトリに ai-cross-review を導入して。手順は https://raw.githubusercontent.com/ktysne/ai-cross-review/main/docs/setup.md にある。

手順書は、ai-cross-review だけを導入する手順と、連携ツールごとに必要な設定の手順に分かれています。
連携ツールそのものの導入は、それぞれのドキュメントに従ってください。
`package.json`、`.gitignore`、`CLAUDE.md` / `AGENTS.md` など、導入先のリポジトリで既にあるファイルを変えるときは、AI が変更内容を示して確認を求めます。

## 導入できたかの確認

パターンごとに、次の点を確かめます。具体的なコマンドと期待する結果は、[docs/setup.md](docs/setup.md) の各パターンの「確認」にあります。

| パターン | 確かめること |
|---|---|
| ai-cross-review だけ | `node tools/cross-review.sync.js --check` がドリフト無しで終わる。`node tools/cross-review.js subagent --uncommitted --no-state` がレビュー用プロンプトを出す。`git check-ignore` で `.cross-review-state.json` と `.cross-review/` が無視の対象になっている。 |
| + GitHub CLI | PR のあるブランチで `node tools/cross-review.js subagent --no-state` を実行すると、stderr の `base:` の行に `(PR の base)` と出る。 |
| + claude-codex-bridge | `npm run review:codex` の出力に「codex-agent.sh 経由 (定義: codex-review)」と出る。 |
| + agent-cockpit | ダッシュボードの「経路の設定」で選んだレビュアーを、`node tools/cross-review.js route` が返す。 |

## 開発者向けドキュメント

ai-cross-review 自体を開発するときは、[docs/development.md](docs/development.md) から読み始めてください。テストと lint、配布物の一覧、移行ノートの書き方をまとめています。
