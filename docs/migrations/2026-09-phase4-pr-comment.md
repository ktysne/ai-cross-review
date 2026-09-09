---
since: b2190b58baceef1399f9324d86b521b1198142a2
---
# PR コメントの生成と、PR 未作成の警告

`tools/cross-review.js` に 3 点を足しました。

- **レビュー出力の保存**。往復を記録できたとき（レビュアー CLI が終了コード 0 で終わったとき、`subagent` がプロンプトを出力したとき）、リポジトリ直下の `.cross-review/` へ材料を保存します。`N` は状態ファイルの往復回数です。
  - `round-<N>-<reviewer>.md`：レビュアーの出力全文（`codex` / `claude`）。`subagent` 経路では CLI が `round-<N>-<reviewer>-prompt.md`（渡したプロンプト）だけを書くので、サブエージェントの出力は主セッションが `round-<N>-subagent.md` へ貼ります。
  - `round-<N>-<reviewer>.json`：実行経路（bridge 経由 / 直接起動 / subagent）、base とその解決方法、差分サイズ、`HEAD`、記録時刻。
  - `--no-state` の実行では往復番号が決まらないので保存しません。利用上限フォールバックや失敗終了でも保存しません（代替プロンプトは従来どおり `--fallback-prompt` の仕組みで書き出します）。保存に失敗してもレビューは失敗にせず、警告だけ出ます。
- **`comment` サブコマンド**。保存したレビュー出力、主セッションが書いた判断ファイル、検証コマンドの出力を定型に整形し、`gh pr comment --body-file` へ渡すファイルを書き出します。投稿はしません（判断内容を書くのは主セッションであり、CLI が PR へ直接書くと誤投稿の取り消しが難しいため）。コマンド例は stderr に出ます。
  - `node tools/cross-review.js comment --round <N> [--reviewer <name>] [--verify <path>] [--out <path>]`
  - 判断ファイル `round-<N>-triage.md` が無いときはエラーにせず、指摘の節を空にしたコメントを作り、同じパスへ雛形を書き出します。
  - 見出しは運用で使ってきた `## クロスレビュー <N> 往復目: <レビュアー> の指摘と対応` に合わせ、メタ情報の要約 1 行、判断ファイルの本文、`### 確認内容`（`--verify` 指定時のみ。長い出力は末尾 200 行）、`<details>` で折りたたんだレビュー出力の順に並べます。
- **PR 未作成の警告**。`codex` / `claude` / `subagent` の実行前に `gh pr view --json number,baseRefName` で PR の有無を調べ、「PR が無い」と判定できたときだけ stderr に警告します（実行は止めません）。`gh` 不在、未認証、ネットワーク断は「分からない」に倒して黙って続行するので、`gh` を入れていない取り込み先の挙動は変わりません。`--no-pr-check` と `CROSS_REVIEW_NO_FETCH=1` で省けます。
  - この呼び出しは既定 base の解決（PR の base ブランチ）と 1 回にまとめました。取得した PR 番号は `comment` が出すコマンド例にも使います。

## 取り込み先で必要な作業
- `.gitignore` に `.cross-review/` を足す。往復ごとのレビュー出力、判断ファイル、生成した PR コメント本文が入る生成物であり、共有は PR コメントで行うため。
- `CLAUDE.md` / `AGENTS.md` の「指摘、対応、妥当性確認は PR コメントに残す」の箇所に、コメント本文を `comment` で生成する旨を 1 行添える。上流の書き方は次のとおり。

  > コメント本文は手で組み立てず、裏取りと対応を `.cross-review/round-<N>-triage.md` に書いて `node tools/cross-review.js comment --round <N>` で生成し、`--body-file` で投稿する。

- `gh` を入れていない環境でも作業は不要（PR の確認は黙ってスキップされる）。

vendored ファイル（`.claude/skills/cross-review/SKILL.md`、`docs/cross-review.md`、`tools/cross-review.js`）は同期で更新されるので、取り込み先での手作業は不要です。
