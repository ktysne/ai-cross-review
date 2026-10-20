---
since: 8e35977386f0f0ecc7d1dadd5ff54f3bd9ae41b6
---
# bridge の公開照会で起動可否を判定する

claude-codex-bridge の commit `4a48688`（PR #170）以降では、`--describe` による実効設定の照会を使います。
ai-cross-review は照会結果からサンドボックスと承認方針を確認し、定義ファイルやスクリプト本文を解析せずに起動可否を決めます。

## 取り込み先で必要な確認

次のコマンドが `protocol: 1` の JSON を返すか確認してください。
照会は Codex を起動しません。

```bash
bash ~/.claude/tools/codex-agent.sh --describe codex-review
```

`status: ok`、`sandbox: read-only`、`approval_policy: never` ならレビューを起動できます。
`--fix` 用の `codex-subagent` は `workspace-write` が必要です。
定義が無ければ直接起動し、無効化やモデル未設定なら終了コード 75 の代替プロンプトへ進みます。
ただし、bridge が commit `ac9df4b`（PR #174）より前の版で Codex CLI が入っていない環境では、定義で無効化していても `codex-not-found` として終了コード 1 で止まります。
bridge を `ac9df4b` 以降に更新すると、終了コード 75 へ進みます。

定義の不正や読取失敗、サンドボックスや承認方針の食い違いは、起動せず終了コード 2 で止まります(今までと同じ)。
照会の時間切れ、不正な JSON、protocol の不一致などは、起動せず終了コード 1 で止まります。
照会の失敗で直接起動を選ぶ場合は `--no-codex-agent` を指定してください。
bridge や bash が無い場合の直接起動は従来どおりです。

`--describe` に未対応の旧 bridge は互換処理で判定します。
最低対応版を上記 commit 以降に引き上げたら、旧版の互換処理と本文解析を削除できます。
接続試験と fixture は上流だけに置き、取り込み先へは配布しません。
