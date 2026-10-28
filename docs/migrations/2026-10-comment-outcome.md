---
since: cf9982c4cb2b3104c1f12e3adc8864e7d7c22c94
---
# comment の結論の記録 (--outcome) と、古い手順の文面の検査

`comment --round <N>` を `--outcome` なしで実行すると、状態ファイル `.cross-review-state.json` の `lastTriage` に往復の結論が残りません。
`lastTriage` を読む側(Agent Cockpit など)は、結論の無い往復を対応中として扱い続けます。
2026-09 の移行ノート(`2026-09-phase4-pr-comment.md`)で取り込み先の `CLAUDE.md` / `AGENTS.md` に入れた文面には `--outcome` が無く、判断ファイルのパスも旧平置きのままです。
この文面に従うと、収束した PR が対応中のまま残ります。

`tools/cross-review.js` と同期スクリプトに次の 2 点を足しました。

- `comment` を `--outcome` なしで実行して本文を生成できたとき、結論を記録していない旨を stderr に警告します。本文の生成と終了コードは変わりません。
- 同期(`sync`、`--check`、`--dry-run`)は、取り込み先の `CLAUDE.md` / `AGENTS.md` に古い手順の行があれば、ファイル名と行番号を stderr に出します。対象は、`cross-review.js comment --round` を含みながら `--outcome` の無い行と、旧平置きの判断ファイル `.cross-review/round-<N>-triage.md` のパスを含む行です(コマンドと別の行でも拾います)。書き換えはせず、終了コードにも影響しません。

## 取り込み先で必要な作業

- `CLAUDE.md` / `AGENTS.md` の「指摘、対応、妥当性確認は PR コメントに残す」の箇所にある、次の文面を探す。

  > コメント本文は手で組み立てず、裏取りと対応を `.cross-review/round-<N>-triage.md` に書いて `node tools/cross-review.js comment --round <N>` で生成し、`--body-file` で投稿する。

- 見つけたら、判断ファイルのパスをブランチ別のディレクトリに直し、`--outcome` の説明を足す。上流の書き方は次のとおり。

  > コメント本文は手で組み立てず、開始時のブランチ名から決まる `.cross-review/branch-<slug>-<hash>/round-<N>-triage.md` に裏取りと対応を書いて `node tools/cross-review.js comment --round <N>` で生成し、`--body-file` で投稿する。`--post <PR番号>` を付けると生成本文を標準入力で投稿できる。判断を終えた往復は `--outcome <fixing|converged|halted>` を付けて、結論を状態ファイルに記録する（値の意味は docs の「状態ファイル」の節）。

- 同期の後に stderr へ「comment の手順が古い文面です」が出なくなったことを確かめる。
- 結論を記録しないまま収束した PR が残っていれば、その PR のブランチで `node tools/cross-review.js comment --round <最後の往復> --outcome converged` を実行して記録し直す(`--post` を付けなければ投稿し直さない)。

vendored ファイル(`.claude/skills/cross-review/SKILL.md`、`docs/cross-review.md`、`tools/cross-review.js`、`tools/cross-review.sync.js`)は同期で更新されるので、取り込み先での手作業は不要です。
