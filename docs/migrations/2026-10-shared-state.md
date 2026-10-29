---
since: a1965d463f55c51db04c90171bc524dd6c1a6f1e
---
# worktree 間の状態共有と結論の記録時の検査

状態ファイルの保存先を各 checkout の `.cross-review-state.json` から Git の共通ディレクトリの `cross-review-state.json` へ変更しました。
同じリポジトリの全 worktree が、ブランチごとの往復、直前レビュー SHA、非対応指摘、結論を共有します。
JSON の形は変わりません。
書き込みはロック内で読み直し、一時ファイルからの rename で置換します。
保存先と統合規則の正本は [状態ファイルの契約](../contracts/cross-review-state.md) です。

旧ファイルは次の書き込み可能なコマンドで自動統合し、共有ディレクトリの `cross-review-state.imported/` へ移します。
表示だけでは取り込まず、未取り込みの旧ファイルがあることを警告します。
`comment --outcome` はレビュー記録の往復が不足していれば本文の生成と投稿の前に停止します。
意図した記録なら `--allow-round-mismatch` を付けられます。
直前レビュー SHA と HEAD が異なるときは警告します。

## 取り込み先で必要な作業

基本的に手作業は不要です。
次の点だけ確認してください。

- `.gitignore` の `.cross-review-state.json` は、旧版と取り込み前のファイルのために残します。
- agent-cockpit を使う場合は、共有ディレクトリから状態を読む版(ktysne/agent-cockpit#717 の対応版)へ更新します。
- 同じリポジトリの全 worktree を新しい版へそろえます。新旧の CLI の混在は非対応です。旧版が旧ファイルを作り直すと、reset した記録が再取り込みで戻る可能性があります。

Git が使えない環境では旧位置へ保存します。
テストなど保存先の隔離が必要な場合は、環境変数 `CROSS_REVIEW_STATE_DIR` にディレクトリを指定できます。
