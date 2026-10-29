# クロスレビューの状態の記録の改善の計画(2026-10-30)

ai-cross-review の #106、#108、#107 を、この順にスタック式の PR で対応する計画である。
起点のコミットは main の a1965d4 である。
どの Issue も、session-score-player と riff-trainer の並行作業で見つかった、状態ファイルと PR コメントと agent-cockpit の表示の食い違いが元になっている。
agent-cockpit 側の #717 から #720 は別のセッションが並行して対応し、両方の管理は agent-cockpit の管理セッションが行う。
全体の計画の正本は管理セッションの資料(agent-cockpit 側の `2026-10-30-review-state-followups.md`)にあり、この資料は ai-cross-review の担当分(B1 から B3)だけを書く。

## 現在地と次にやること

- B1(#106)は PR #109 で、Codex のクロスレビューが 2 往復目で収束し(c33107a)、2026-10-29T19:06Z に main へマージされた。
- B2(#108)は PR #110 で、Codex のクロスレビューが 1 往復目で収束し(ba52ded)、2026-10-29T19:07Z に main へマージされた。B3 の base は main になる。
- B3(#107)は PR #111 で、Codex のクロスレビューが 1 往復目で収束した。マージ待ちである。
- 3 件とも完了した。残りは開発者による #111 のマージだけである。
- 導入先への同期(`cross-review.sync-all.js` など)は、この計画では行わない。
- PR のマージは開発者が判断する。セッションはマージしない。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| 順序 | #106 → #108 → #107 | #106 は状態ファイルの契約を変え、agent-cockpit#717 がそれを待つ。#108 もコメントの形を契約に書く。#107 の SKILL の手順は agent-cockpit#718 の振る舞いを前提にする |
| 進め方 | 自走。Issue ごとに PR を作り、クロスレビューを回して収束を記録してから次へ進む | 開発者が並行対応を任せたため |
| レビューと記録の場所 | レビューと `comment --outcome` は同じ worktree で実行する | #106 が入るまで、状態ファイルは worktree ごとに分かれるため |
| B1 の共有の状態ファイルの置き場 | checkout のルートで `git rev-parse --path-format=absolute --git-common-dir` を実行し、その下の `cross-review-state.json` に置く。git が使えなければ従来の位置。env `CROSS_REVIEW_STATE_DIR` で差し替えられる | 同じリポジトリの worktree が必ず同じ場所に着き、worktree に未追跡ファイルを増やさない。テストが実リポジトリの `.git` を汚さないよう、置き場を差し替える口が要る |
| B1 のロック | 書き手だけが `.lock` を `wx` で作り、pid などを書いて即 close する。読み直してから一時ファイルへ書き、rename で置き換える。放棄されたロックは自動で回収せず、取得を諦めたときに mtime 30 秒超かつ pid 不在なら、手で消す手順を案内する | fd を開いたままにすると Windows で削除保留になり、他のプロセスが取れなくなる。自動で回収すると、放棄と判定してから移すまでに別の書き手が取り直したロックを奪う(PR #109 の 1 往復目の指摘) |
| B1 の旧ファイルの取り込み | 書く可能性のあるコマンドがロック内で取り込み、旧ファイルは共通ディレクトリの `cross-review-state.imported/` へ移す。`lastTriage` は `round` と独立に `lastTriage.round` の大きいほうを残す | `round` の大きい側の記録をまるごと残すと、Issue の表の例(レビュー側に round、本体側に結論)で結論が消える。純粋な表示で取り込むと読み手ごとの統合が要るので、表示では警告だけにする |
| B1 の同じリポジトリでの新旧の CLI の混在 | 非対応とし、契約に書く | 旧版が旧ファイルを作り直すと、`state --reset` した記録が再取り込みで戻りうる |

## 対応順序、ブランチ、PR

| 順 | Issue | 主な変更先 | ブランチ | PR | base | 状態 |
|---|---|---|---|---|---|---|
| B1 | #106 | `tools/cross-review.js`(状態の置き場、ロック、記録時の検査)、`docs/contracts/cross-review-state.md`、`docs/migrations/` | `feat/shared-review-state` | #109 | main | マージ済み(2026-10-29T19:06Z) |
| B2 | #108 | `tools/cross-review.js`(`buildRoundComment`、`buildMetaSummary`)、契約 | `feat/round-comment-head` | #110 | B1 | マージ済み(2026-10-29T19:07Z) |
| B3 | #107 | `tools/cross-review.js`(`resolveBaseSelection`)、`.claude/skills/cross-review/SKILL.md`、`docs/cross-review.md` | `feat/merge-resolution-review` | #111 | main | 収束、マージ待ち(2026-10-30) |

## 判断待ちと受け渡し

- B1 で決めた共有の状態ファイルの置き場とロックの方式と、PR #109 の番号は、2026-10-30 に管理セッションへ知らせた。agent-cockpit#717 がこれを読む。
- B3 の SKILL の手順の前提の agent-cockpit#718 は、ktysne/agent-cockpit#722 で Issue のとおりにマージされた(2026-10-29T18:36Z、管理セッションから連絡)。手順に書く振る舞いは次のとおりである。
  - 競合の無い base の取り込みは記録が要らない。札は「収束 <C> の後に base を取り込み(競合なし)」で、マージの条件を満たす。
  - 競合を解いた取り込みは、札が「競合の解消の確認待ち」になり、解消の差分だけのレビューか `cockpit_skip_review` を求める。解消のレビューで今の head の収束を記録すれば、通常の収束になる。
  - merge でないコミットや base 以外からの merge があるとき、分類できないときは「収束の後に変更あり」のままである。
  - 「収束後マージ」の予約は収束を記録した head の SHA で照合するので、競合の無い取り込みの後の head では動かない。開発者が手でマージする。手順に一言添える。

## 落とし穴

- Windows の Bash ツールではバックスラッシュが半分になる(anthropics/claude-code#98622)。バックスラッシュを含むスクリプトはファイルに書いてから実行する。
- 元の checkout `E:\Develop\ai-cross-review` は upstream の消えた `feat/comment-outcome-warning` にいる。作業はこの worktree で、`origin/main` から切ったブランチで行う。
