## AI 相互レビュー（Claude ↔ Codex）
> 詳細フローの正本は [docs/cross-review.md](docs/cross-review.md)（本ファイルは運用要点の要約）。

基本フローは **実装 → レビュー → 指摘対応 → 妥当性確認** の 4 ステップを Claude / Codex を入れ替えて回す（Claude 実装 → Codex レビュー → Claude 対応 → Codex 妥当性確認 / およびその逆）。  
**指摘・対応・妥当性確認は PR コメントに残す**（揮発させない。PR 未作成なら先に作り、`gh pr comment` で記録）。

### 実装完了後の起点（Claude 主導・必須）
Claude が実装を完了したら、Codex へ手で切り替えず、Claude が端末から `npm run review:codex*` を実行して自走する。`AskUserQuestion` で次の 3 択を提示する。
- **A. Codex にレビューを依頼** → `npm run review:codex`（codex は read-only）。結果を読み修正を適用（ユーザ判断が要る内容は確認してから）。  
完了後に再度 `npm run review:codex` で妥当性確認。
- **B. Codex にレビューと検出事項の修正を依頼** → `npm run review:codex:fix`（codex は workspace-write）。  
  Codex の検出内容・修正差分（`git diff`）・要約を Claude がレビューし、必要なら再修正。
- **C. 何もしない** → レビューを回さず終了。

### サーキットブレーカー（無限ループ防止・必須）
レビュー ↔ 指摘対応は **最大 3 往復**まで。**1 往復 = 実装（または前回指摘への対応）→ レビュー → 結果確認 まで**（= レビュー 1 回とその確認で 1 往復。修正が続くかは問わない）。  
カウント対象はブロッカー / 要修正で、`提案` は任意適用でループ継続理由にしない。3 往復しても未解決のブロッカー / 要修正 が残る場合はループを中断し、サマリ（残存指摘・各往復で試したこと・収束しない理由の推測・選択肢）を
`AskUserQuestion` で提示してユーザの判断を仰ぐ。同じ指摘が往復をまたいで揺り戻すと判断したら 3 往復を待たず早期中断してよい。往復回数は会話内で数える（CLI は往復状態を持たない）。

### 実行上の注意
- `npm run review:codex*` は codex がネットワークを使うため **Bash をサンドボックス無効で実行**する。
- 既定のレビュー対象は **main とのコミット済み差分**（`--base <ref>` で変更）。未コミットの実装を見るなら `-- --uncommitted`（未追跡込み）。`--fix` は codex 専用（claude 側の自動修正は未対応）。
- レビュー観点は `.cross-review.md` を自動添付（解決順は env `CROSS_REVIEW_CHECKLIST` → `<cwd>/.cross-review.md`
  → `<スクリプト>/../.cross-review.md` → 汎用フォールバック）。

### 日本語で書くもの（コミット・PR・コメント）
コミットメッセージ・PR タイトル / 本文 / コメント・コードコメントは **日本語** で書く。
`feat:` / `fix:` などの prefix（Conventional Commits 風）、コード識別子、ファイルパス、技術用語は
必要に応じて英語で良いが、説明文は日本語にする。

prefix の例: `feat`（新機能）/ `fix`（バグ修正）/ `docs`（ドキュメントのみ）/ `chore`（雑務）/
`refactor`（挙動を変えない整理）/ `test`（テストのみ）/ `style`（整形・lint 系）。
