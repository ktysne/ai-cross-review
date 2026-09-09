---
since: 61b818b6dbbaf593c6c51b0cb27e355927ed6a0e
---
# グローバル SKILL の配布とマニフェストのドリフト検査

配布まわりに 2 点を足しました。

- **`sync --check-manifest`**。上流の雛形 `tools/cross-review.sync.example.json`（配布物一式の正本）にあって、取り込み先のマニフェストの `files[]` に無いエントリを `from` で突き合わせて列挙します。上流が配り始めたファイルの取りこぼしを知らせるだけで、マニフェストは書き換えません（何を取り込むかは取り込み先の判断であるため）。同じ理由で、未登録があっても exit 1 にはしません。列挙するだけの検査なので `--check` を含意し、単独指定でも書き込みは起きません（ドリフトがあれば `--check` と同じく exit 1）。上流に雛形が無い、読めない、または構造が不正（`files[]` が配列でない、`from` を持つエントリが 1 つも無い）ときは警告して検査だけスキップします。
  - `sync-all --check` でも各プロジェクトで同じ検査を回し、未登録があったプロジェクトの集計行に「（マニフェスト未登録 N 件）」が付きます。検査が回らなかったプロジェクトには「（マニフェスト検査スキップ）」が付き、`sync` が出した `[cross-review]` の警告行が集計行の直後に並びます。
- **`sync-all --global-skill`**。相互レビュー SKILL を `~/.claude/skills/cross-review/SKILL.md` へ配ります。`~/.codex/skills/` が既にある環境では Codex 側の写しも同時に更新します（Codex はレビュー時にこの写しを読むので、古いままだと旧ルールで動くため。未導入の環境にディレクトリは作りません）。`--check` は書き込まずドリフト扱いで exit 1、`--dry-run` は書き込まずプレビュー、`--root` を付けなければプロジェクト走査をせずグローバル配布だけを行います。

## 取り込み先で必要な作業
- `node tools/cross-review.sync.js --check-manifest`（書き込まない）を一度実行し、未登録の配布物を確認する。必要なものだけ `tools/cross-review.sync.json` の `files[]` に足す（このリポジトリでは同期スクリプト本体、一括同期ツール、SKILL、各テストが配布物です）。足さない判断もそのままで構いません。
- グローバル SKILL（`~/.claude/skills/cross-review/`）を配った環境では、`CLAUDE.md` / `AGENTS.md` の相互レビュー節をテンプレートの形に縮めてよい。汎用ルール（3 択、サーキットブレーカー、PR 運用）の写しを各リポジトリに持たず、正本の在り処、検証コマンド、同期スクリプト名だけを残す形です。テンプレートは `docs/cross-review.md` の「取り込み先の CLAUDE.md / AGENTS.md に書くこと（テンプレート）」節にあります。
- グローバル SKILL を置けない環境（クラウド実行など）では、これまでどおり `.claude/skills/cross-review/SKILL.md` を `files[]` に入れて vendored のまま同期を続けて構いません。この場合は `CLAUDE.md` の縮小も不要です。

vendored ファイル（`tools/cross-review.sync.js`、`tools/cross-review.sync-all.js`、`docs/cross-review.md`、`.claude/skills/cross-review/SKILL.md`、各テスト）の更新は同期で済むので、手作業は要りません。
