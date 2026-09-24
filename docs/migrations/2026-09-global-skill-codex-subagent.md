---
since: fc7152c04421e25d597dba66fae24a56b4e7a550
---
# Codex サブエージェントへのグローバル SKILL 配布

`--global-skill` の配布先に `~/.codex-subagent/skills/cross-review/SKILL.md` を追加しました。`~/.codex-subagent/skills/` が既にある環境にだけ配布します。

## 取り込み先で必要な作業
- `~/.codex-subagent/skills/` がある環境では、`node tools/cross-review.sync-all.js --global-skill`(このリポジトリなら `npm run sync:global`)を一度実行し、サブエージェント側にも SKILL を配る。無い環境では何もしなくてよい。

vendored ファイルは同期で更新されます。
