---
since: b5c75230cb56edeba0568e10448ad8e12cecc799
---
# Codex 向けのグローバル SKILL を agents へまとめる

Codex 向けの配布先を `~/.agents/skills/cross-review/SKILL.md` にまとめます。
`CODEX_HOME` を変えた端末でも、配布先はユーザーホームの `~/.agents/skills` です。
通常の Codex とサブエージェントが同じ写しを読みます。

## 各端末で必要な作業

各端末で、更新した上流の checkout から次を 1 回実行してください。

```bash
node tools/cross-review.sync-all.js --global-skill
```

Codex のホームの `skills`、または `~/.codex-subagent/skills` があれば、新しい配布先が無くても作ります。
旧配置（Codex のホームおよび `~/.codex-subagent` の `skills/cross-review/SKILL.md`）は、Git 履歴の配布版または現在の配布元と一致するときだけ削除します。
照合では CRLF と LF の違いを吸収します。
利用者が書き換えた写しは削除せず、警告して残します。
必要な内容を確認したうえで手で片付けてください。
Git の履歴を集められない場合も削除しません。

## 照会する側の変更

`--global-skill --check --json` の `schemaVersion` は 2 です。
`targets` の配布先は `claude` と `agents` になり、旧配置が残る場合だけ `codex-legacy`、`codex-subagent-legacy` が加わります。
旧配置には `removable` と、削除できない場合の `reason` が入ります。
旧配置が残っていれば `result: drift`、終了コード 1 です。
読めない項目があれば `error`、終了コード 3 を優先します。
契約の詳細は [グローバル SKILL の配布](../cross-review.md#グローバル-skill-の配布--global-skill)を参照してください。
