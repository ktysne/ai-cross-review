---
since: b7e868759df24d3cd8d4cba367a2330a31d822f9
---
# Codex 起動の bridge 経由化と利用上限時の自動フォールバック

`tools/cross-review.js` の codex 経路を 2 点変えました。

- claude-codex-bridge の起動スクリプト（`~/.claude/tools/codex-agent.sh`、`CROSS_REVIEW_CODEX_AGENT` で変更可）がある環境では、`npm run review:codex*` がそれを経由して Codex を起動します。モデル、推論 effort、認証ホーム（`CODEX_HOME`）、サンドボックスは定義ファイル `~/.claude/gpt-agents/<定義名>.md` に従います。定義名はレビューのみが `codex-review`（read-only）、`--fix` が `codex-subagent`（workspace-write）です。スクリプトが無い環境の挙動は従来どおりです。
- bridge 経由には 2 つの前提があり、起動前に検証します。スクリプトがコメント行を除く本文で `-c` の引数として `approval_policy=never` を明示していなければ警告を出して直接起動へ戻し（承認 never 固定を保つため）、定義ファイルの `codex_sandbox` が `--fix` の有無と食い違えば起動せずエラー（終了コード 2）で止めます。
- Codex が利用上限に達したときは、レビューを失敗で終わらせず、subagent 代替のプロンプトをファイルへ書き出して終了コード 75 で終わります。書き出し先は stderr に出ます。

## 取り込み先で必要な作業
- bridge を使う環境では、`~/.claude/gpt-agents/codex-review.md` と `~/.claude/gpt-agents/codex-subagent.md` があることを確認する。無い場合、スクリプトは終了コード 3 を返し、CLI は直接起動へ自動で戻る。
- bridge を使う環境では、`codex-agent.sh` が `codex exec` へ `-c approval_policy=never` を明示していることを確認する（claude-codex-bridge #16）。明示が無いスクリプトは bridge 経由に使わず、CLI が直接起動へ戻す（レビューは実行できるが、bridge 経由の利点である定義ファイルでの一元管理は効かない）。
- bridge を使わない環境では作業は不要。`--no-codex-agent` を付ければ、bridge がある環境でも従来の直接起動に戻せる。

vendored ファイル（`.claude/skills/cross-review/SKILL.md`、`docs/cross-review.md`、`tools/cross-review.js`）は同期で更新されるので、取り込み先での手作業は不要です。
