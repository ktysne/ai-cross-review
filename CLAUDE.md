## AI 相互レビュー（Claude ↔ Codex）
> 詳細フローの正本は [docs/cross-review.md](docs/cross-review.md)（本ファイルは運用要点の要約）。
> 実行手順（3 択、往復、subagent 経路）は Claude Code スキル [.claude/skills/cross-review/SKILL.md](.claude/skills/cross-review/SKILL.md) にもまとめてある（vendored、取り込み先へコピー可）。
> 導入プロジェクトをまとめて更新するには `tools/cross-review.sync-all.js`（`/Develop` 等を走査して一括同期。詳細は docs）。

基本フローは **実装 → レビュー → 指摘対応 → 妥当性確認** の 4 ステップを Claude / Codex を入れ替えて回す（Claude 実装 → Codex レビュー → Claude 対応 → Codex 妥当性確認 / およびその逆）。  
**指摘、対応、妥当性確認は PR コメントに残す**（揮発させない。PR 未作成なら先に作り、`gh pr comment` で記録）。

### 実装完了後の起点（必須）
**改修（実装、修正）を一区切りしたら、完了扱いにする前に必ず次の 3 択を提示する**（「コミット / PR で勝手に締めない」。反復改修時も区切りごとに確認し、最後の 1 回だけにしない）。Claude 主導なら `AskUserQuestion` で提示する（チャット本文の番号付きリストで代用しない）。Codex 主導では Plan mode 等の選択 UI があればそれを使い、無ければ本文に 3 択を明記して返信を待つ。並び順は固定で、推奨はラベル末尾に「(推奨)」を付けるだけにする。

**用語**：**実装者**：今回の差分を書いたモデルのベンダー（主セッションが自分で書いたならそのベンダー、実装用サブエージェントへ委譲したなら委譲先のベンダー。混在時は主セッションと別のベンダーをレビュアーにする）。主セッションは 3 択を提示する直前に、報告へ「今回の実装者: Claude / Codex」を一言書く。

1. **クロスレビューを依頼する（レビュアー: 実装者と別のベンダー）**
2. **同じベンダーの客観サブエージェントにレビューを依頼する**（別ベンダーの利用上限が近い、または接続できないとき）
3. **クロスレビューを行わない**（下記の軽微な例外に該当するときの既定）

| 実装者 | 選択肢 1（実装者と別のベンダー） | 選択肢 2（同じベンダーの客観サブエージェント） |
|---|---|---|
| Claude | `npm run review:codex`（codex は read-only） | `node tools/cross-review.js subagent` の出力を Claude の客観サブエージェント（Agent ツール、読み取り専用）へ渡す |
| Codex | `node tools/cross-review.js subagent` の出力を Claude の客観サブエージェントへ渡す（Codex が主セッションなら `npm run review:claude`） | `npm run review:codex` |

どの選択肢でも、レビュー結果を読んで修正を適用するのは主セッション。妥当性確認は同じ経路でもう一度回す。

**ブランチ、PR 運用（必須、レビューを回すなら先にここを満たす）**：改修は main へ直接ではなく **feature ブランチ**で行う（main 上にいるなら着手時に切る）。選択肢 1 か 2 でレビューを回す前に **PR を作成**し（未作成なら先に作る）、以降は PR を共有ログにする。**各往復で出た指摘、対応、妥当性確認は、その都度 `gh pr comment` で PR に記録する**（チャットだけに残さない＝揮発させない）。リモートが無い等で PR を作れない場合のみ省略し、その旨を明記する。詳細は [docs/cross-review.md](docs/cross-review.md)。

**リモートコントロール環境（対象レビュアー CLI を spawn できない / ネットワーク、API 接続できない）では、レビュアー CLI を客観レビュー用サブエージェントに切り替える**（3 択の意味は不変）。判定は `codex` / `claude` が PATH で解決できない（`Get-Command <cli>` 等が失敗）か、リモート実行と分かっているとき（`npm run review:codex*` / `npm run review:claude` が CLI 不在、接続不可で失敗したときも切替）。`node tools/cross-review.js subagent`（`--uncommitted` / `--fix` 可）で**外部 CLI を起動せず**レビュープロンプトを stdout に出し、それを `Agent` ツール等の客観レビュー用サブエージェント（実装意図に引きずられない第三者として枠付け）へ渡してレビューさせる。`subagent --fix` は 3 択には現れず、Claude 主導で主セッションがレビュアーに修正まで任せると決めたときだけ使う。対象レビュアー CLI が使える環境では従来どおり CLI を優先。この代替を使った場合は、PR コメントに「対象レビュアー CLI を直接実行できないため（CLI 不在 / 接続不可）subagent 代替で確認した」ことを残す。詳細は [docs/cross-review.md](docs/cross-review.md)。

**省略してよい軽微な例外**（Claude / Codex どちらの起点にも適用。省略時は一言添える）：誤字、コメントのみ、ドキュメント文言調整 / フォーマット、lint 整形のみ / 既にレビュー済みパターンの 1 箇所踏襲（1〜数行）/ 直前のレビュー済み状態への単純 revert。規模、影響で迷ったら省略しない。

**確定した指摘を Codex に直させる**のは 3 択の外の道具で、主セッションがレビュー結果を裏取りし、直す指摘を確定させたうえで適用だけ任せたいときに使う。指摘をファイルに書いて `node tools/cross-review.js codex --fix --uncommitted --instructions <path>`。`--instructions` は観点 `.cross-review.md` を置き換えず重点指摘として追加で添える（この用途で `CROSS_REVIEW_CHECKLIST` を流用しない）。詳細は [docs/cross-review.md](docs/cross-review.md)。

### サーキットブレーカー（無限ループ防止、必須）
レビュー ↔ 指摘対応は **最大 3 往復**まで。**1 往復 = 実装（または前回指摘への対応）→ レビュー → 結果確認 まで**（= レビュー 1 回とその確認で 1 往復。修正が続くかは問わない）。  
カウント対象はブロッカー / 要修正で、`提案` は任意適用でループ継続理由にしない。
- 3 往復到達時、残る指摘に **blocker** が含まれるならループを中断し、サマリ（残存指摘、各往復で試したこと、収束しない理由の推測、選択肢）を `AskUserQuestion` で提示してユーザの判断を仰ぐ。
- 残る指摘が **要修正のみ**で、影響範囲が局所（1 ファイル内に収まり、既存テストで検証できる）なら、主セッションの判断で対応して収束としてよい。判断の根拠を PR コメントに残す。
- 要修正のみの収束処理やユーザの判断で 3 往復を超えて続ける場合は、PR コメントの冒頭に「何往復目まで回したか、なぜ続けたか」を書く。
- 同じ指摘が往復をまたいで揺り戻すと判断したら 3 往復を待たず早期中断してよい。往復回数は会話内で数える（CLI は往復状態を持たない）。

blocker の有無で分けるのは、実害のある指摘の判断をユーザに残し、局所的な要修正の判断は主セッションに委ねるため。

### 実行上の注意
- `npm run review:codex*` / `npm run review:claude` はレビュアー CLI がネットワーク/API 接続を使うため、必要に応じて **Bash をサンドボックス無効、ネットワーク許可で実行**する。
- CLI は `Get-Command <cli>` / `<cli> --version` で見えていても、API 接続だけサンドボックスで止まることがある。`claude -p "Reply with OK only."` 等の最小 API 呼び出しが通常環境で無応答 / `ConnectionRefused`、ネットワーク許可環境で成功するなら、CLI 不在ではなくネットワーク制限として扱う。
- 既定のレビュー対象は **main とのコミット済み差分**（`--base <ref>` で変更）。`--base` 未指定時は **`origin/main` をベストエフォートで fetch、優先解決**し（解決できなければローカル `main`）、stale なローカル main による差分肥大を避ける（`--base` 明示時、`--uncommitted` 時は解決をスキップ）。未コミットの実装を見るなら `-- --uncommitted`（未追跡込み）。差分サイズは常に stderr 表示され、閾値（既定 256KB、`--max-diff-kb` / `CROSS_REVIEW_MAX_DIFF_KB`、`0` で無効）超過時はレビュアーを起動せず中断。`--fix` は codex / subagent 対応（claude CLI 経路は未対応）。`--instructions <path>` でレビュアーの指摘ファイルを観点に加えて添付（置き換えない）。
- トークン節約のため、ロックファイル、生成物（`package-lock.json` / `*.min.js` / `*.map` 等）は**既定で差分から除外**（`.cross-review-ignore` で追加、`CROSS_REVIEW_IGNORE` でパス指定、`--no-exclude` で無効化。除外ファイル名はプロンプトに残す）。巨大なファイル差分は **stat 要約に置換**（`--max-file-diff-kb` / `CROSS_REVIEW_MAX_FILE_DIFF_KB`、既定 64KB、`0` で無効）。妥当性確認は `--base <レビュー時 SHA>` で増分差分だけ送れる。
- レビュー観点は `.cross-review.md` を自動添付（解決順は env `CROSS_REVIEW_CHECKLIST` → `<cwd>/.cross-review.md`
  → `<スクリプト>/../.cross-review.md` → 汎用フォールバック）。

### 日本語で書くもの（コミット、PR、コメント）
コミットメッセージ、PR タイトル / 本文 / コメント、コードコメントは **日本語** で書く。
`feat:` / `fix:` などの prefix（Conventional Commits 風）、コード識別子、ファイルパス、技術用語は
必要に応じて英語で良いが、説明文は日本語にする。

prefix の例：`feat`（新機能）/ `fix`（バグ修正）/ `docs`（ドキュメントのみ）/ `chore`（雑務）/
`refactor`（挙動を変えない整理）/ `test`（テストのみ）/ `style`（整形、lint 系）。
