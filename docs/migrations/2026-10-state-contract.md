---
since: 8c5b447024c0761b34d931d3565c85a7cdd261b6
---
# 状態ファイルの契約と検証データ

`.cross-review-state.json` の契約を `docs/contracts/cross-review-state.md` に、検証データを `contracts/cross-review-state/` に置きました。
どちらも上流にだけ置き、取り込み先へは写しません。
外部の読み手は、上流の revision を固定して文書と検証データを取り込めます。
内部 API の `readState` の戻り値に `kind` と `issues` が増えました。
`branches` が配列の状態ファイルは、空の記録として扱います。

## 取り込み先で必要な作業

ありません。
