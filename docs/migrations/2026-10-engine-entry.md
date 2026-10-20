---
since: bf843657259a58b16846117cd226c23db83aa4c5
---
# 本体の写しから入口へ移行する

新形式では、導入先に本体をコピーする代わりに、小さな入口を置きます。
入口は登録した上流の checkout、またはキャッシュから本体を読みます。
クラウド向けの SKILL と手順書の案内版も導入先へ配ります。
旧形式のまま同期を続けても動くため、すぐに移行する必要はありません。

## 取り込み先で必要な作業

上流の checkout が無ければ、最初に clone します。
既にあれば、その checkout を移行に対応した版へ更新して使います。
`<checkout>` は上流の checkout、`<導入先>` は変更する導入先の絶対パスへ置き換えます。
`upstream.ref` を固定している場合は、`tools/cross-review.entry.js` を含み、本体が入口の番号を受け付ける版 (例 `main`) へ上げてください。
対応しない ref の場合、移行と dry-run は何も書き換えずに止まります。

```bash
git clone https://github.com/ktysne/ai-cross-review.git <checkout>
node <checkout>/tools/cross-review.sync-all.js --register
node <checkout>/tools/cross-review.sync-all.js --migrate --dry-run --root <導入先>
node <checkout>/tools/cross-review.sync-all.js --migrate --root <導入先>
```

移行はマニフェストの既存の配置と置換規則を保ち、同期スクリプトと上流テストの写しを削除します。
本体を `tools/cross-review.js` 以外へ写している場合は、`custom-body-location` として移行せず、何も変更しません。
マニフェストを `tools/cross-review.sync.json` 以外に置いている場合も、`custom-manifest-location` として移行せず、何も変更しません。
SKILL を `.claude/skills/cross-review/SKILL.md` 以外へ写す項目はそのまま残し、クラウド向けの SKILL を `.claude/skills/cross-review/SKILL.md` に足します。
`package.json` の `node tools/cross-review.sync.js` は `node tools/cross-review.js sync` へ置き換えます。
一括同期や削除したテストを呼ぶ scripts は自動では直せないため、出力の「手で修正」を確認してください。
導入先の `CLAUDE.md` にある `node tools/cross-review.sync.js` も、`node tools/cross-review.js sync` へ直してください。

導入先へ移動し、次のコマンドで本体の参照先と同期の結果を確かめます。
続けて導入先の lint とテストを実行し、差分を確認してコミットします。
移行コマンドはブランチ、コミット、PR を作りません。

```bash
node tools/cross-review.js engine
node tools/cross-review.js sync --check
```

## 古い同期スクリプトから更新するとき

この変更の後に旧形式で最初に同期する 1 回だけは、手元の古い同期スクリプトが新しい雛形を読みます。
そのため `--check-manifest` が、新形式の入口、SKILL、案内版を未登録として列挙することがあります。
これらを `files[]` に足さないでください。
旧形式の配布物と `to` が重なり、同期が止まります。
新形式への変更は、上記の `--migrate` でまとめて行います。

移行漏れは、上流の checkout から次の照会で確かめます。
既存の `--check` は、旧形式のまま最新に同期した導入先を検出できません。

```bash
node <checkout>/tools/cross-review.sync-all.js --migrate --check --root <作業ルート>
```
