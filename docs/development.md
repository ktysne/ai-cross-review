# ai-cross-review の開発

ai-cross-review 自体を開発するときの入口です。利用者向けの導入は [setup.md](setup.md)、コマンドと機能は [usage.md](usage.md) にあります。

## 最初に読むもの

| 文書 | 内容 |
|---|---|
| [CLAUDE.md](../CLAUDE.md) / [AGENTS.md](../AGENTS.md) | このリポジトリで相互レビューを回すときの運用の要点 |
| [docs/cross-review.md](cross-review.md) | 相互レビューの手順書。導入先へそのまま配る汎用の文書で、運用の正本 |
| [.claude/skills/cross-review/SKILL.md](../.claude/skills/cross-review/SKILL.md) | 相互レビューの実行手順のスキル。導入先へそのまま配る |
| [.cross-review.md](../.cross-review.md) | このリポジトリ自身のレビュー観点 |
| [docs/migrations/](migrations/) | 導入先が同期の後に行う作業の記録（移行ノート） |
| [docs/plans/](plans/) | 改修の計画書 |

## 配布物

導入先へは、同期スクリプトがファイル単位で配ります。配布物の一覧の正本は `tools/cross-review.sync.example.json` です。配布物を増やしたり減らしたりしたら、この雛形を直します。導入先は `sync --check-manifest` で取りこぼしに気づけます。

### そのまま配るファイル（導入先では編集しない）

| ファイル | 役割 | 導入先での扱い |
|----------|------|----------------|
| `tools/cross-review.js` | CLI 本体 | そのまま |
| `tools/cross-review.sync.js` | 同期スクリプト（上流から取り込む / ドリフト検査） | そのまま |
| `tools/cross-review.sync-all.js`（任意） | 一括同期ツール（作業ルート配下の導入先をまとめて同期、グローバル SKILL の配布） | 複数の導入先をまとめて更新する人だけ入れる |
| `tools/cross-review.sync.example.json` | 同期マニフェストの雛形。配布物一覧の正本 | コピーして `tools/cross-review.sync.json` を作り、そちらを編集する |
| `.claude/skills/cross-review/SKILL.md`（任意） | 相互レビューの実行手順（Claude Code スキル、汎用） | そのまま。プロジェクト固有の運用は書かない |
| `tests/cross-review.test.js`（任意） | 本体のユニットテスト（vitest） | 導入先が vitest のときだけ。require のパスを導入先の配置に合わせる |
| `tests/cross-review.sync.test.js`（任意） | 同期スクリプトのユニットテスト（vitest） | 同上 |
| `tests/cross-review.sync-all.test.js`（任意） | 一括同期ツールのユニットテスト（vitest） | 一括同期ツールを入れ、かつ vitest のときだけ |
| `.cross-review.example.md` | 観点のテンプレート | コピーして `.cross-review.md` を作り、そちらを編集する |
| `docs/cross-review.md` | 相互レビューの手順書（汎用） | そのまま。ファイルは名前で参照していて、置き場所が変わっても壊れない |

### 導入先が編集するファイル（配らない）

| ファイル | 役割 |
|----------|------|
| `.cross-review.md` | そのプロジェクトのレビュー観点 |
| `CLAUDE.md` / `AGENTS.md` | そのリポジトリの運用メモ。手順の詳細は `docs/cross-review.md` へリンクする |
| `tools/package.json` | ルートが ES modules のときに `tools/*.js` を CommonJS にする設定（`"type": "commonjs"`） |
| `tools/cross-review.sync.json` | 同期マニフェスト。`lastSyncedCommit` と `shownMigrations` は同期のたびに自動で更新される |
| そのプロジェクト用の doc（任意） | 手順書に書かない、プロジェクト固有のメモ（検証コマンド、CI、例など） |

`README.md`、`docs/setup.md`、`docs/usage.md`、`docs/development.md` はこのリポジトリの利用者と開発者向けの文書で、配りません。

## テストと lint

```bash
npm install        # devDependencies (vitest / eslint) を入れる
npm test           # ユニットテスト (引数解析、差分生成、プロンプト生成、観点解決、申し送り注入、除外/要約、同期スクリプト、一括同期)
npm run lint       # ESLint
```

- 本体は Node 標準 API だけで動かします。依存を足すのは devDependencies（テスト、lint）だけです。
- git の実行、子プロセスの起動、ファイルの読み込みは `deps` 引数で差し替えられるようにします。テストはこの差し替えで外部に触れずに流れます。

## 一括同期と SKILL の配布

このリポジトリの scripts で、作業ルートの配下の導入先をまとめて同期し、グローバル SKILL を配れます。

```bash
npm run sync:all -- --root /Develop          # 一括同期
npm run sync:all:check -- --root /Develop    # 一括のドリフト検査（CI 向け）
npm run sync:global                          # グローバル SKILL の配布
```

## 移行ノートを書くとき

導入先が自分で持つファイル（`.gitignore`、`package.json` の scripts、`CLAUDE.md` / `AGENTS.md` の節、`.cross-review.md`）に作業が要る変更を入れたら、`docs/migrations/<日付>-<内容>.md` に移行ノートを 1 件 1 ファイルで置きます。
書き方は [cross-review.md](cross-review.md) の「移行ノート（docs/migrations/）」にあります。導入先が同期すると、未読のノートが stderr に表示されます。

## 連携先との約束

連携先のツールが読む値や置き場を変えるときは、連携先の文書とコードも合わせて確かめます。

| 連携先 | ai-cross-review 側の約束 |
|---|---|
| [claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge) | `~/.claude/tools/codex-agent.sh` を探し、定義 `codex-review`（read-only）と `codex-subagent`（workspace-write）で起動する。終了コード 3 は bridge が未導入、75 は GPT 側の事情で使えないことを表す |
| [agent-cockpit](https://github.com/ktysne/agent-cockpit) | `AGENT_COCKPIT_HOME`（無ければ `~/.agent-cockpit`）の `routing.json` の `review` を読む。agent-cockpit は導入先の worktree のルートの `tools/cross-review.js` で導入を判断し、`.cross-review-state.json` の往復と結論を PR のカードに出す |

## 文書を直すとき

- 導入の手順（取り込むファイル、導入先で足す設定、連携ツールごとの設定と確認）を変えたら [setup.md](setup.md) を直します。
- コマンド、オプション、出力を変えたら [usage.md](usage.md) と、配布する [cross-review.md](cross-review.md) を直します。
- 3 択や往復の上限など、運用の規則を変えたら [cross-review.md](cross-review.md)、SKILL、[CLAUDE.md](../CLAUDE.md) / [AGENTS.md](../AGENTS.md) をそろえて直し、導入先の作業が要るなら移行ノートを書きます。
- 連携ツールや概要が変わったら [README.md](../README.md) を直します。
