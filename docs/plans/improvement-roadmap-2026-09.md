# 運用ログに基づく改善の実装計画（2026-09）

> **ステータス**：計画。各項目は GitHub Issue に対応し、完了した項目はこの文書ではなく Issue のクローズで管理する。

## 背景

2026-06 から 2026-09 のセッションログ（853 件）と PR コメントを調べ、相互レビューの運用で人手に残っている作業と、環境の変化で前提が崩れた箇所を洗い出した。
環境の変化とは、グローバル CLAUDE.md の運用開始、claude-codex-bridge の導入（実装の既定が Codex になった）、OpenAI 公式プラグインの併存の 3 つである。
洗い出した結果を 11 件の Issue にし、取り込み先の更新フローの検討で 1 件を足した。
この文書は、それらをどの順に、どの単位で実施するかを定める。

## 対象 Issue

| Issue | 内容 | 変更の種類 |
|---|---|---|
| [#22](https://github.com/ktysne/ai-cross-review/issues/22) | 利用上限時に subagent 経路へ自動フォールバック | CLI |
| [#23](https://github.com/ktysne/ai-cross-review/issues/23) | Codex 起動を codex-agent.sh 経由に統一 | CLI |
| [#24](https://github.com/ktysne/ai-cross-review/issues/24) | 3 択の再構成（B 廃止、別ベンダー既定、並び順固定） | 運用ルール |
| [#25](https://github.com/ktysne/ai-cross-review/issues/25) | 往復回数、直前レビュー SHA、非対応指摘の状態ファイル | CLI |
| [#26](https://github.com/ktysne/ai-cross-review/issues/26) | PR コメント定型本文の生成と PR 未作成の警告 | CLI |
| [#27](https://github.com/ktysne/ai-cross-review/issues/27) | 差分サイズガードの段階的縮退 | CLI |
| [#28](https://github.com/ktysne/ai-cross-review/issues/28) | 既定 base を PR の baseRefName から解決 | CLI |
| [#29](https://github.com/ktysne/ai-cross-review/issues/29) | 汎用観点に過剰指摘の抑制を追加 | 観点プロンプト |
| [#30](https://github.com/ktysne/ai-cross-review/issues/30) | ルールをグローバル SKILL に一本化 | 配布 |
| [#31](https://github.com/ktysne/ai-cross-review/issues/31) | 3 往復到達時の判断を blocker の有無で分ける | 運用ルール |
| [#32](https://github.com/ktysne/ai-cross-review/issues/32) | 同期に移行ノート表示、マニフェストのドリフト検査、グローバル配布を追加 | 配布 |
| [bridge #15](https://github.com/ktysne/claude-codex-bridge/issues/15) | Codex 連携 3 系統の使い分けと再起動要件を docs に明記 | 他リポジトリの docs |

## 依存関係

実施順を決める依存は次の 4 つである。

- #22（上限フォールバック）は #23（bridge 経由の起動）の終了コード契約（75 = 上限）を使う。#23 を先に入れると、#22 の判定が「終了コード 75」で済み、出力文字列の判定は直接起動時のフォールバックだけになる。
- #26（PR コメント生成）は #25（状態ファイル）の往復回数でファイル名を決める。
- #28（base 解決）は #25 の直前レビュー SHA を優先する。
- #30（グローバル SKILL）は #24 と #31 の SKILL 改訂が落ち着いてから配る。先に配ると、改訂のたびに全プロジェクトへ再配布することになる。
- #32（同期の拡張）のうち移行ノートの仕組みは、フェーズ 2 以降の各 PR が移行ノートを書く前提になるため、フェーズ 1 の直後に入れる。マニフェスト検査とグローバル配布は #30 と同じフェーズ 5 で入れる。

#27（差分ガード）と #29（観点プロンプト）は他と独立している。

## フェーズ構成

フェーズは PR の単位でもある。
1 つの PR は 1 つのフェーズに対応し、フェーズ内の Issue はまとめて 1 PR にする。
#32 だけは移行ノートの仕組み（フェーズ 1.5）と残り（フェーズ 5）の 2 つの PR に分かれる。
CLI を変えるフェーズは、レビュー往復を回す前に `npm test` と `npm run lint`、`node --check tools/cross-review.js` を通す。

### フェーズ 1：運用ルールの改訂（#24、#31、#29）

CLI に触れず、SKILL と `docs/cross-review.md`、CLAUDE.md と AGENTS.md の要約、汎用フォールバック観点を改める。
最初に置くのは、後続フェーズの PR をこの改訂後のルール（実装者と別ベンダーがレビューする）で回すためである。

- #24：3 択の選択肢と並び順、既定レビュアーの決め方を SKILL と docs に書く。CLAUDE.md と AGENTS.md の要約も揃える。
- #31：ブレーカー節を blocker の有無で分岐する形に書き換える。
- #29：汎用フォールバック観点（`.cross-review.example.md` と CLI 内の既定文）に分類、到達可能性、件数上限、反例の 4 項目を足す。CLI 内の既定文は文字列定数の変更のみで、`tests/cross-review.test.js` のプロンプト生成テストを更新する。

区分は light（文書と定数の変更）。
bridge #15 はこのフェーズと並行して bridge 側で進める。

### フェーズ 1.5：移行ノートの仕組み（#32 の一部）

`docs/migrations/` の置き場と書式（先頭に `since: <上流 SHA>`、本文に取り込み先の app-owned 作業の一覧）を定め、`cross-review.sync.js` が同期後に `lastSyncedCommit` より新しいノートを stderr に表示する部分だけを先に入れる。
以降のフェーズで app-owned の作業が生じる PR（#25 と #26 の gitignore、新サブコマンドの scripts、#23 の起動経路の変更）は、同じ PR に移行ノートを含める。

区分は standard。
ノートの選別は純粋関数（ノート一覧と `lastSyncedCommit` から表示対象を返す）に分け、テストに書く。

### フェーズ 2：Codex 起動の統一と上限フォールバック（#23、#22）

`reviewerInvocation` の `codex` 分岐を、codex-agent.sh の存在で切り替える形にする。

- #23：起動の解決順（環境変数で指定したスクリプト → 既定パス → 直接起動）を実装する。スクリプトの存在確認は deps で差し替え、テストでは仮想の存在有無で両経路の引数を検証する。`--fix` 時は `codex-subagent` 定義を使う。終了コード 3 は直接起動へ戻す。
- #22：終了コード 75、または直接起動時の出力文字列（`usage limit` 等）を上限と判定し、`subagent` と同じ出力形式でプロンプトを stdout に出して 75 で終了する。`--no-fallback` を足す。

区分は hard。
既存の起動経路を壊さないことの検証が難しく、Windows の `.cmd` シム解決（`where.exe`）との組み合わせも見る必要がある。
`.cross-review.md` のサンドボックス安全性の観点（レビューのみは read-only、`--fix` のみ workspace-write、承認 never 固定）が bridge 経由でも保たれることを、`gpt-agents` の `codex_sandbox` 値と突き合わせてテストに書く。

### フェーズ 3：状態ファイルと差分の解決（#25、#28、#27）

- #25：`.cross-review-state.json` の読み書きを純粋関数（状態の更新）と I/O（ファイル読み書き）に分け、`collectReviewDiff` と `buildReviewPrompt` に「直前 SHA を base に使う」「非対応指摘の節を添える」を配線する。`state` と `dismiss` サブコマンドを足す。
- #28：既定 base の解決に `gh pr view --json baseRefName` を挟み、解決方法を差分サイズと同じ行に出す。`CROSS_REVIEW_NO_FETCH` を足す。
- #27：閾値超過時に per-file 閾値を段階的に下げて再計算する。再計算は `collectReviewDiff` の純粋関数部分で行い、git を再実行しない。

区分は standard。
仕様は Issue に書き切れており、実装の選択肢（状態ファイルのスキーマ、縮退の段階）は実装者が決める。

### フェーズ 4：PR コメント生成（#26）

- レビュー出力を `.cross-review/round-<N>-<reviewer>.md` に保存する。
- `comment --round <N>` で、レビュー出力、判断ファイル、検証出力を定型に整形する。定型は現行の PR コメントの見出し構成に合わせる。
- 実行前の PR 存在確認（`gh pr view --json number`）と警告を足す。

区分は standard。
判断ファイルの書式（指摘ごとの裏取りと対応）は Issue に例を足してから着手する。

### フェーズ 5：配布（#30、#32 の残り）

- `sync --check-manifest` を足し、上流の `sync.example.json` にあって取り込み先のマニフェストに無いエントリを報告する。`sync-all --check` の集計にも含める。
- `sync-all` に `--global-skill` を足し、SKILL を `~/.claude/skills/cross-review/` へ配る。集計に「global」の行を足す。
- 取り込み先の CLAUDE.md と AGENTS.md の相互レビュー節を短い形に縮めるテンプレートを `docs/cross-review.md` に置く。
- `docs/cross-review.md` の「同期スクリプト」節に、取り込み先の更新手順（同期 → 移行ノートの作業 → lint とテスト）を書く。
- bridge を走査対象に含め、フェーズ 1 から 4 の変更を取り込み先 4 プロジェクト（agent-limit-checker、clipy-for-windows、session-score-player、claude-codex-bridge）へ同期し、表示された移行ノートの作業を各プロジェクトで行う。

区分は standard。
グローバル CLAUDE.md の縮小はユーザの判断なので、テンプレートを示すに留める。
session-score-player は独自 sync を使うため、移行ノートは上流の `docs/migrations/` を直接読んで作業する。

## 各フェーズの検証

| フェーズ | 検証 |
|---|---|
| 1 | SKILL と docs の整合を目視。`npm test`（プロンプト既定文のテスト更新） |
| 1.5 | `npm test`。`lastSyncedCommit` を古い SHA にしたマニフェストで `sync --dry-run` を実行し、ノートが表示されることを確認 |
| 2 | `npm test`、`npm run lint`。bridge 導入環境で `npm run review:codex` を実行し、stderr の `codex-agent:` 行でモデルと認証ホームを確認。スクリプトを一時的に外して直接起動へ戻ることを確認 |
| 3 | `npm test`。スタック PR のブランチで `--base` 無しに実行し、表示された base を確認。256KB 強の差分で縮退が働くことを確認 |
| 4 | `npm test`。実際の PR で `comment` の出力を `gh pr comment --body-file` に渡して投稿し、見出し構成を確認 |
| 5 | `npm run sync:all:check` で 4 プロジェクトの差分とマニフェストの漏れが無いこと。各プロジェクトで lint とテスト（session-score-player は `docs:build` も） |

## 各フェーズのレビュー

各フェーズの PR は、フェーズ 1 で改めた 3 択に従ってレビューを回す。
実装者が Claude なら Codex、Codex（impl-standard / impl-light の GPT 側）なら Claude の客観サブエージェントがレビューする。
フェーズ 2 以降は、その時点で入っている改善（上限フォールバック、状態ファイル）を自分のレビューで使い、動作の確認を兼ねる。
app-owned の作業が生じる PR は、移行ノートが含まれているかをレビュー観点に加える。

## 見送った項目

差分ガードの既定閾値の引き上げは、段階的縮退（#27）で足りるかを見てから判断する。
`claude -p` 経路の上限判定と `--fix` 対応は、実績上ほぼ使われていないため対象にしない。
