---
since: d6e618a39c9d57545de2e335862988334d29e00d
---
# グローバル SKILL のホーム解決と検査結果

`sync-all --global-skill` は `CLAUDE_CONFIG_DIR` と `CODEX_HOME` を見て、実際に使うホームの写しを検査、配布します。
未設定なら `~/.claude` と `~/.codex` を使い、`~/.codex-subagent` は固定です。
Claude のホームが無い環境では、配布先を作らず対象外にします。
Codex は引き続きホームの `skills/` があるときだけ配ります。
bridge の独自ホームは解決しません。`CODEX_HOME` を変えた場合、bridge の既定ホーム `~/.codex` の写しも対象外です。

`--check` は未配置をドリフトに数えず、古い写し（バイト不一致）があるときだけ exit 1 にします。
読めない写しや配布元、配布失敗は exit 3 です。
プロジェクトの error（マニフェスト破損、上流取得失敗など）と導入プロジェクト無しの終了コードも 1 から 3 に変わります。
非 0 であることは変わりません。
ドリフトとエラーが混在したときは 3 を優先します。

`--global-skill --check --json` で配布先ごとの状態と SHA-256 を機械で読める JSON として取得できます。
`--root`（位置引数を含む）、`--list`、`--dry-run` は併用できません。
引数エラー（exit 2）以外では、正本を読めない場合も JSON を返します。
フィールドの契約は `docs/cross-review.md` の「グローバル SKILL の配布」を参照してください。

上流の checkout では、`.gitattributes` で `.claude/skills/cross-review/SKILL.md` を LF に固定しました。
`core.autocrlf=true` の端末で CRLF の正本から配った写しは、`--check` で「古い」になります。

## 取り込み先で必要な作業

- グローバル SKILL を配っている上流の checkout では、取り込んだ後に `--global-skill` を 1 回実行して配り直す。checkout の中の SKILL が CRLF のまま残っていれば、そのファイルを削除してから `git checkout -- .claude/skills/cross-review/SKILL.md` で取り出し直す。

- 一括同期の終了コード 1 をエラー全般とみなす CI やスクリプトがあれば、検査不能と処理失敗を示す 3 も扱うよう見直す。
- ホームを変更した環境では、`--global-skill --check --json` で配布先と状態を確認する。未配置は終了コード 0 なので、配置が必要なら `--global-skill` で配る。

vendored ファイルは同期で更新できます。
グローバルの写しは必要に応じて別途配り直してください。
