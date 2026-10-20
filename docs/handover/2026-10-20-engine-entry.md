# 本体を checkout に置き、導入先には入口だけを置く計画(2026-10-20)

ai-cross-review の #89(上流を変えるたびに、導入先のすべてのリポジトリで写しを更新する PR が要る)を対応する計画である。
起点のコミットは main の 2ff4c1c である。
この計画は設計だけを定める。
実装は #85 と #86 がマージされてから着手する。
上流の配布物の中身の見直しと、agent-cockpit と claude-codex-bridge の変更は対象から外す。
#89 の本文で対象外としているためと、ai-cross-review をほかのツールに依存させないためである。

## 現在地と次にやること

- 3 段(#95、#96、#97)はすべてマージ済みである。
- 「移行を全リポジトリへ反映する手順」の 1 から 4 を、開発者の承認を得て 2026-10-20 に行った。手元の 22 の導入先は、すべて移行できる判定で、導入先ごとの PR を出した(「移行の PR」)。
- 22 件の PR はすべてマージ済みである。手順の 5 の `--migrate --check` は、2026-10-20 に終了コード 0(22 件とも新形式)を返した。#89 はこの確認をもって閉じる。
- 作業ルートの外の導入先と、別の端末の導入先は、手順の 6 のとおり移行ノートに沿って移行する。
- 開発者の判断を待っている事項は「判断待ち」にある。

## 決定済みの判断

| 項目 | 決定 | 理由 |
|---|---|---|
| 入口と本体の分け方(2026-10-20 開発者決定) | 上流では本体を `tools/cross-review.js` のまま置き、入口を別のファイル `tools/cross-review.entry.js` として持つ。導入先のマニフェストは `{ "from": "tools/cross-review.entry.js", "to": "tools/cross-review.js" }` で入口を写す | 導入先の `tools/cross-review.js` の置き場所と名前が変わらない。agent-cockpit の判定、`package.json` の `review:*`、SKILL の手順を書き換えずに済む。本体の場所が変わらないので、上流の checkout をそのまま本体として使える。古い `cross-review.sync.js` でも、`from` と `to` が違う写しは扱える |
| 本体の探し方(2026-10-20 開発者決定) | 入口は、1. 環境変数 `CROSS_REVIEW_ENGINE`(checkout のパス)、2. ホームの登録ファイル `~/.cross-review/engine.json`(`{ "checkout": "<パス>" }`)、3. git の shallow fetch で取ったキャッシュ、4. 明示のエラー、の順に探す。1 を指定して解決できないときは、警告で次へ進まずにエラーにする | 登録ファイルは checkout を指すだけなので、checkout の `git pull` や agent-cockpit の `apply.js --update-checkouts` だけで全リポジトリの CLI が新しくなる。本体の写しをホームに配ると、配り直しの手順が増える。明示の指定が外れたときに黙って別の本体で動くと、どの版で動いたかが分からなくなる |
| 登録の手段 | 上流の checkout の `tools/cross-review.sync-all.js` に `--register` を足し、その checkout のパスを登録ファイルへ書く | 既存の `--global-skill` と同じく、上流の checkout からホームへ配る流儀にそろえる |
| 登録先が使えないとき | 登録ファイルはあるが、指す checkout が無い、本体を読めない、または読めない登録ファイルのときは、キャッシュへ進まずにエラーにする。登録ファイルが無いときだけキャッシュへ進む | 環境変数の明示の指定と同じく、登録した本体の代わりに黙って別の版で動くと、どの版で動いたかが分からなくなる |
| 登録の照会(agent-cockpit の #673 を受けて追加) | `--register --check` を足し、`--json` で次を返す。登録の有無、登録した checkout のパス、そのパスがあるか、HEAD が既定のブランチか、未コミットの変更があるか、本体が受け付ける `ENTRY_PROTOCOL` の範囲。どの ai-cross-review の checkout から実行しても、登録ファイルの内容を調べる。JSON の形と終了コードは `--global-skill --check --json` にそろえる(`schemaVersion`、`result` が `clean` / `drift` / `error`、終了コード 0 / 1 / 3、引数エラーは 2)。登録が無いのと、登録先が正常なのは `clean`、HEAD が既定のブランチでないのと未コミットの変更があるのは `drift`、登録先が使えないのは `error` にする | agent-cockpit の update-tools と診断は、連携ツールの状態を、各ツールの照会の結果を写して表示する方針である。照会が無いと、agent-cockpit が `~/.cross-review/engine.json` を自分で読んで解釈することになる。登録が無い端末もキャッシュの経路で動くので、未登録はドリフトに数えない(`--global-skill` の `missing` と同じ扱い) |
| 手元に本体が無い環境(2026-10-20 開発者決定) | 入口が、マニフェストの `upstream.repo` と `upstream.ref` を git の shallow fetch で取り、解決したコミットの SHA ごとのキャッシュに置いて使う。取得したことと SHA を stderr に 1 行出す。#89 の本文の推奨だった `npx github:` は採らない | クラウド、別の端末、登録していない端末を 1 つの経路で扱える。git だけを使うので、npm のレジストリとインストール処理に依存しない。取得の方式は `cross-review.sync.js` と同じで、リポジトリは公開なので認証が要らない |
| キャッシュの置き場と鮮度 | 置き場は `XDG_CACHE_HOME`、Windows では `LOCALAPPDATA`、`~/.cache`、`os.tmpdir()` の順で、その下の `ai-cross-review/engines/<sha>/` に置く。TTL は持たず、ref がブランチなら毎回 `git ls-remote` で SHA を解決する。`ls-remote` が失敗したときと `CROSS_REVIEW_NO_FETCH` が有効なときは、最後に解決した SHA(`refs.json`)のキャッシュで動き、それも無ければエラーにする。取得は一時名のディレクトリへ展開してから rename し、rename が失敗しても目的のディレクトリがあれば成功とする。取得に成功したら、直近 3 個より古い SHA のディレクトリを消す(失敗は無視する) | クラウドは毎回空から始まるので TTL に意味が無い。TTL を持つと、どれだけ古い本体で動いたかを利用者が推定することになる。`CROSS_REVIEW_NO_FETCH` は既存の「オフラインで作業する」という意味を保ち、既にあるキャッシュの利用までは止めない。同じ SHA を 2 つのプロセスが同時に取ると、Windows では rename が失敗するためである |
| 取得する範囲 | 本体の 1 ファイルではなく、shallow fetch した木の全体をキャッシュに置く | 本体は上流の `tools/package.json`(`type: commonjs`)と一緒に置かないと、ESM の場所で CJS として読めない。`sync` サブコマンドは `tools/cross-review.sync.js` も使う |
| 入口から本体の呼び方 | 入口は本体を `require` し、既存の `main(deps)` に `argv`、`projectRoot`、`entryProtocol` を渡す。新しい公開関数は足さない。`projectRoot` は入口の `__dirname` の 1 つ上とする | `main` は既に `deps.argv` を受け、本体の末尾は `require.main === module` のときだけ `main()` を呼ぶので、require しても勝手に動かない。本体は `process.exit` を呼ばず `process.exitCode` だけを設定しているので、同じプロセスで呼んでも入口の後処理が飛ばない(2026-10-20 に main で確認) |
| プロジェクトのルートの解決 | `resolveStatePath`、`resolveReviewDir`、`loadChecklist`、`loadIgnorePatterns` の 4 か所を、1 つのヘルパー(`deps.projectRoot`、無ければ `deps.scriptDir || __dirname` の 1 つ上)に寄せる。`projectRoot` が渡されたときは、`loadChecklist` と `loadIgnorePatterns` の候補から「スクリプトの 1 つ上」を外す | 本体が上流の checkout にあると、「スクリプトの 1 つ上」は上流のリポジトリ自身の `.cross-review.md` を指す。候補に残すと、導入先に観点が無いときに上流の観点が黙って使われる。`projectRoot` が無いときの解決を今のままにすれば、旧形式の写しはそのまま動く |
| 版の固定(2026-10-20 開発者決定) | 入口には整数の `ENTRY_PROTOCOL` だけを埋める。照合は本体の側に置き、本体が受け付ける範囲の外なら、checkout と入口のどちらを更新すべきかを示して終了コード 2 で止まる。照合用の export を持たない本体(#89 より前の本体)は、対応外の古い本体として同じく止める。リリースのタグは必須にしない。壊す変更を入れるときは `ENTRY_PROTOCOL` を上げる | 入口の写しを変えると全リポジトリで PR が要るので、入口に置く論理は探し方、取得、番号の受け渡しに絞る。照合の方針を本体に置けば、入口を配り直さずに方針を変えられる。`undefined` と比べて素通りさせると、古い本体が黙って違う動きをする |
| `upstream.ref` の扱い | checkout の経路では `upstream.ref` は効かず、全リポジトリが checkout の版で動く。マニフェストの `ref` が `main` 以外の導入先には、その旨を stderr に警告する。`ref` はキャッシュの経路でだけ使う | 版を固定していた導入先が、黙って別の版で動くのを防ぐ |
| 開発中の checkout の検知 | 登録した checkout の HEAD が既定のブランチでないとき、または作業ツリーに未コミットの変更があるときは、stderr に 1 行警告する。止めはしない | 登録先は上流の開発用の checkout(手元では `D:\Desktop\Develop\ai-cross-review`)になる。そこで feature ブランチを開くと、全導入先が未マージの本体で動く。worktree で開発していれば警告は事故のときだけ出る |
| SKILL の写し(2026-10-20 開発者決定) | リポジトリの `.claude/skills/cross-review/SKILL.md` を、クラウドのセッション向けの写しにする。クラウドでは別ベンダーの CLI が無いので、レビューは常に同じベンダーのサブエージェントで回すことを前提に書く。正本は上流の別のファイル(例 `templates/cloud-skill/SKILL.md`)に置き、マニフェストの `from` で写す。`name` と `description` は今のものを据え置く | 公式ドキュメントでは、同名のスキルは `~/.claude/skills` が project より優先される(https://code.claude.com/docs/en/skills.md 「Resolve skills that share a name」)。ローカルではホームの SKILL が使われるので、リポジトリの写しが効くのはクラウドだけである。クラウドの手順はローカルより単純で変わりにくいので、写しを更新する PR の頻度が下がる。Claude のクラウドには Codex CLI が無く、Codex のクラウドには Claude CLI が無いことを開発者から聞いている |
| 写す物を絞る | 新形式のマニフェストの `files[]` は、入口、クラウド向けの SKILL、`docs/cross-review.md` の案内版の 3 つにする。`.cross-review.example.md` は導入先が持っていれば残す。`cross-review.sync.js`、`cross-review.sync-all.js`、上流のテストは写さない | 導入先の CLAUDE.md の記載と、`docs/cross-review.md` を自前のパスへ写して HTML を生成している導入先があるので、`docs/cross-review.md` はパスを保った案内版にする。同期は入口の `sync` サブコマンドから本体の側の同期処理を呼ぶ |
| `sync` サブコマンド | 入口の `node tools/cross-review.js sync [--check|--dry-run|--check-manifest]` は、本体の側の `tools/cross-review.sync.js` の `runSync` を、導入先のルートとマニフェストを指定して呼ぶ | 導入先から同期スクリプトの写しを無くしても、同期の入口が残る。同期の処理は常に本体の版で動くので、古い同期スクリプトがファイルを消せない問題が新形式では起きない |
| 移行の方式(2026-10-20 開発者決定) | 上流の checkout の `tools/cross-review.sync-all.js` に `--migrate` を足す。`--dry-run` と `--check` を持たせる。1 プロジェクトについて、マニフェストの `files[]` の新形式への書き換え(既存の `to` は保つ)、要らなくなったファイルの削除、`package.json` の `scripts` の `node tools/cross-review.sync.js` を `node tools/cross-review.js sync` へ置き換える。ブランチ、コミット、PR は作らない。書き換えの前に、マニフェストの `upstream.ref` が `tools/cross-review.entry.js` を含み、入口の `ENTRY_PROTOCOL` を受け付ける版かを確かめ、対応していなければ何も変えずに止めて、`ref` を対応版へ上げるよう案内する(`--dry-run` でも同じく止める)。`--migrate --check` は書き込まず、旧形式の導入先が 1 件でもあれば終了コード 1 にする | 導入先の古い `cross-review.sync.js` は写しを上書きするだけで、ファイルを消せず、移行ノートも出ないことがある。上流の checkout の同期処理で回せば、導入先の版に左右されない。手元の 21 の導入先は、すべて `package.json` から `node tools/cross-review.sync.js` を呼んでいる(2026-10-20 に確認)。#89 より前のコミットに `ref` を固定した導入先を移行すると、キャッシュの経路と `sync` が、そのコミットに無い入口を取りに行って失敗する。固定を黙って外さず、利用者に上げてもらう。既存の `--check` は未登録の配布物を終了コードに含めないので、旧形式のまま最新に同期した導入先を移行漏れとして拾えない |
| 新形式の判定 | `files[]` に `tools/cross-review.sync.js` が無く、`tools/cross-review.js` の `from` が `tools/cross-review.entry.js` であることで判定する。マニフェストに版のフィールドは足さない | 判定に必要な情報は `files[]` で足りる。`--migrate` を同じリポジトリへ 2 回回しても、この判定で何もしない |
| 移行の照会(agent-cockpit の #673 を受けて追加) | `--migrate --check` に `--json` を足し、導入先ごとの形式(旧形式、新形式、対象外、エラー)の一覧を返す。JSON の形と終了コードは `--global-skill --check --json` にそろえ、旧形式が 1 件でもあれば `drift`(終了コード 1)、検査できない導入先があれば `error`(終了コード 3)にする。導入先ごとの項目には、少なくともリポジトリのルートの絶対パス、今の形式、移行できるか(できないならその理由のコード)を入れる。終了コードが 0、1、3 のどれでも stdout に JSON を出す | 登録の照会と同じく、agent-cockpit が導入先のマニフェストを自分で解釈しなくて済むようにする |
| 同じ `to` への重複 | 上流の `tools/cross-review.sync.js` のマニフェストの検証で、`files[]` に同じ `to` が 2 つ以上あればエラーにして、何も書かない。`to` はパスを正規化してから比べ、Windows では大文字と小文字を区別しない | 旧形式のマニフェストに新形式の入口を足すと、本体の写しと入口の写しが同じ `tools/cross-review.js` を指す。今の検証には重複の検査が無く、後のものが上書きするので、同期スクリプトの写しが残ったまま入口だけが入る(2026-10-20 に main で確認)。導入先にある古い同期スクリプトは直せないので、上流の checkout から回す `sync-all` と、新形式の `sync` サブコマンドで効けば足りる |
| 旧形式でのマニフェスト検査 | `--check-manifest` は、旧形式の導入先では新形式だけの配布物(入口、クラウド向けの SKILL、`docs/cross-review.md` の案内版)を未登録として列挙しない。代わりに、`--migrate` で移行するよう 1 行案内する。新形式で雛形から外れた配布物(`cross-review.sync.js` など)を `excludedFiles` に持つ旧形式の導入先にも、古い除外の警告は出さない | 3 つとも `from` が新しく、`to` は旧形式の写しと同じである。今の検査は `from` だけで照合するので、未登録と報告し、文書は「必要なものだけ `files[]` に足す」と案内している。案内どおりに足すと同じ `to` への写しが 2 つになる。移行は `files[]` の一部だけを足しても成り立たず、`--migrate` でまとめて行う必要がある |
| 旧形式との共存 | 旧形式の導入先は、本体の写しで今までどおり動く。本体は `projectRoot` が渡されないときの動きを変えない。旧形式の導入先が古い同期スクリプトで新しい本体を取り込んでも動くことを、テストで固定する | 移行していないリポジトリと、移行済みのリポジトリが混在する期間がある。旧形式は本体の写しの中で完結し、checkout の本体を参照しないので、互いに干渉しない |
| #85 との重なり:状態ファイルの場所(2026-10-20 開発者決定) | #85 では `resolveStatePath` の場所の決め方を変えない。#89 で、上の「プロジェクトのルートの解決」のヘルパーに寄せる | #85 のパーサーはテキストを受けて解釈し、ファイルの読み書きは入口側で行う分担である。場所の決め方と解釈が分かれているので、#85 と #89 の変更が重ならない |
| #85 との重なり:検証データの置き場(2026-10-20 開発者決定) | #85 の契約の文書と検証データは、導入先へ写さず、上流のリポジトリにだけ置く。agent-cockpit は、上流の revision を固定して取り込む。#85 の項目 6(雛形のマニフェストへの追加)は外すよう、#85 の Issue にコメントで伝える | 導入先は検証データを使わないので、写すと #89 で減らす写しが増える。#86 で bridge を revision を固定して確かめるのと同じ考え方である。#85 の項目 6 の後段(実行用のモジュールを別ファイルへ分けるときの配布手順)は、#89 の新形式で解決する |
| Codex のクラウドの手順(2026-10-20 開発者決定) | 2 段目では、導入先の AGENTS.md に Codex のクラウドでレビューを回す手順を書かない。Codex のクラウドで実際に回す手段を確かめてから、別の Issue にする。手段の確認と起票は 2 段目の後に行う | Codex は `.claude/skills/` を読まないので、クラウド向けの SKILL は Claude のクラウドにだけ効く。手段を確かめないまま手順を書くと、動かない手順が全導入先に写される |

## 対応順序、ブランチ、PR

3 段をスタック式で積む。
どの段も #85 と #86 のマージ後に着手する。

| 順 | 対象 | 主な変更先 | 委譲の区分 | PR | base | 状態 |
|---|---|---|---|---|---|---|
| 0 | この計画 | `docs/handover/2026-10-20-engine-entry.md` | なし | #90 | main | マージ済み(2026-10-20) |
| 0 | この計画の改訂(agent-cockpit の指摘の反映) | `docs/handover/2026-10-20-engine-entry.md` | なし | #91 | main | マージ済み(2026-10-20) |
| 1 | 本体の `projectRoot` 対応と版の照合、入口、探し方、キャッシュ、`--register` と `--register --check --json`、`sync` サブコマンド | `tools/cross-review.js`、`tools/cross-review.entry.js`(新規)、`tools/cross-review.sync-all.js`、`tests/` | hard | #95 | main | マージ済み(2026-10-20) |
| 2 | 同じ `to` への重複の検査、旧形式でのマニフェスト検査、クラウド向けの SKILL、`docs/cross-review.md` の案内版、新形式の雛形のマニフェスト、文書 | `tools/cross-review.sync.js`、`templates/`(新規)、`tools/cross-review.sync.example.json`、`docs/cross-review.md`、`docs/setup.md`、`.claude/skills/cross-review/SKILL.md`、`tests/` | hard | #96 | main(1 段目のマージ後) | マージ済み(2026-10-20) |
| 3 | `sync-all --migrate`、`--migrate --check --json`、移行ノート | `tools/cross-review.sync-all.js`、`docs/migrations/`(新規ノート)、`tests/` | hard | #97 | main(2 段目のマージ後) | マージ済み(2026-10-20) |

- 1 段目は、入口が無いと本体の `projectRoot` 対応を確かめられないので、本体と入口を 1 つの PR にする。
- 1 段目のテストには、登録が無い、登録先が正常、HEAD が既定のブランチでない、未コミットの変更がある、登録先が無い、本体が照合用の export を持たない、の各場合の `--register --check --json` の `result` と終了コードを入れる。
- 2 段目は、1 段目の入口と `sync` サブコマンドを前提に、写す物と文書を新形式にする。重複の検査と旧形式でのマニフェスト検査は、雛形に新形式の配布物を入れるのと同じ段に入れる。雛形を先に変えると、その間に旧形式の導入先が `--check-manifest` の案内どおりに入口を足せてしまうためである。区分は、検査の変更が加わり誤りに気づきにくいので hard にする。
- 2 段目のテストには、同じ `to` が 2 つあるマニフェストで同期と検査がエラーになり何も書かないこと(大文字と小文字だけが違う場合を含む)と、旧形式の導入先の `--check-manifest` が新形式だけの配布物を列挙せずに `--migrate` を案内することを入れる。
- 3 段目は、2 段目の雛形のマニフェストを移行の行き先として使う。
- 3 段がすべてマージされるまでは、導入先を移行しない。

## 移行の PR

2026-10-20 に、上流の main(3cbb4f2)で 22 の導入先を移行した。
どの PR もブランチは `chore/cross-review-engine-entry`、base は各リポジトリの既定のブランチである。
マージは各リポジトリの開発者が行う。

| 導入先 | PR | 状態 |
|---|---|---|
| agent-cockpit | ktysne/agent-cockpit#685 | マージ済み(2026-10-20) |
| agent-gc | ktysne/agent-gc#161 | マージ済み(2026-10-20) |
| agent-limit-checker | ktysne/agent-limit-checker#73 | マージ済み(2026-10-20) |
| ai-comment-tidy | ktysne/ai-comment-tidy#69 | マージ済み(2026-10-20) |
| blade-preset-maker | ktysne/blade-preset-maker#28 | マージ済み(2026-10-20) |
| claude-codex-bridge | ktysne/claude-codex-bridge#175 | マージ済み(2026-10-20) |
| cli-updater | ktysne/cli-updater#7 | マージ済み(2026-10-20) |
| clipy-for-windows | ktysne/clipy-for-windows#49 | マージ済み(2026-10-20) |
| ktysne-top | ktysne/ktysne-top#30 | マージ済み(2026-10-20) |
| log-converter | ktysne/log-converter#21 | マージ済み(2026-10-20) |
| rec-studio | ktysne/rec-studio#852 | マージ済み(2026-10-20) |
| riff-trainer | ktysne/riff-trainer#210 | マージ済み(2026-10-20) |
| screen-recorder | ktysne/screen-recorder#124 | マージ済み(2026-10-20) |
| session-score-player | ktysne/session-score-player#421 | マージ済み(2026-10-20) |
| tab-forge | ktysne/tab-forge#23 | マージ済み(2026-10-20) |
| tab-image-maker | ktysne/tab-image-maker#48 | マージ済み(2026-10-20) |
| ux-load-review | ktysne/ux-load-review#15 | マージ済み(2026-10-20) |
| ux-readability-review | ktysne/ux-readability-review#15 | マージ済み(2026-10-20) |
| ux-state-review | ktysne/ux-state-review#22 | マージ済み(2026-10-20) |
| ux-structure-review | ktysne/ux-structure-review#15 | マージ済み(2026-10-20) |
| VOICEVOX Coding | ktysne/voicevox-coding#80 | マージ済み(2026-10-20) |
| YouTubeChatExtension | ktysne/YouTubeChatExtension#17 | マージ済み(2026-10-20) |

- `--migrate` の自動の書き換えのほかに、CLAUDE.md、AGENTS.md、手順書にある `node tools/cross-review.sync.js` を `node tools/cross-review.js sync` に直し、配布物の列挙から消した同期スクリプトを外した。
- claude-codex-bridge のテストは `tools/cross-review.js` を require して本体の関数を呼んでいたので、`engine` の照会で本体のパスを得てから読む形に直した。導入先のコードが本体の関数を直接呼ぶ箇所は、ほかに無かった。
- agent-cockpit の `skills/update-tools/SKILL.md` にある `node tools/cross-review.sync.js --check` は、ktysne/agent-cockpit#684 で直すので、この移行では触っていない。

## 着手前の点検

#85 と #86 のマージ後に、実装の前に次を確かめ、結果を開発者へ報告する。

1. マージ後の main で `tools/cross-review.js` を読み直し、次が今も成り立つかを確かめる。
   - スクリプトの位置からルートを決めているのが `resolveStatePath`、`resolveReviewDir`、`loadChecklist`、`loadIgnorePatterns` の 4 か所だけで、どれも `deps.scriptDir` を受けている。
   - `resolveStatePath` の呼び出し元(`readState`、`writeState`、`state` サブコマンドなど)が、状態ファイルの場所を受け取る引数をどう組み立てているか。`projectRoot` がそこまで届く経路があるか。
   - `main(deps)` が `deps.argv` を受け、末尾が `require.main === module` のときだけ `main()` を呼ぶ。
   - 本体が `process.exit` を呼ばず、`process.exitCode` だけを設定している。
   - 本体が実行時に、上流のリポジトリの中のほかのファイル(#85 の契約の文書、検証データ、#86 で足したモジュール)を読むか。読むなら、キャッシュに木の全体を置く方針で足りるかを確かめる。
2. #85 で足したファイルが、雛形のマニフェスト `tools/cross-review.sync.example.json` に入っていないかを確かめる。入っていれば、2 段目の雛形と 3 段目の `--migrate` の削除の対象に加える。
3. #85 で状態ファイルの読み書きの入口が変わっていれば、「プロジェクトのルートの解決」の決定がそのまま当てはまるかを確かめる。
4. #86 で bridge の照会に cwd を渡すようになっていれば、入口から呼ぶときの cwd が今と同じ(利用者が起動した場所)になることを確かめる。
5. 手元の導入先の数と構成を数え直す。`docs/cross-review.md` を別のパスへ写している導入先(2026-10-20 には session-score-player)の `to` を、`--migrate` が保つことを 3 段目のテストに入れる。3 段目のテストには、ほかに次の 2 つを入れる。
   - `upstream.ref` が #89 より前のコミットを指す導入先で、`--migrate` と `--migrate --dry-run` が何も変えずに止まる。
   - 中身は最新だが旧形式の導入先で、`--migrate --check` が終了コード 1 を返し、`--json` の一覧にその導入先が旧形式として出る。

## 移行を全リポジトリへ反映する手順

3 段がすべてマージされた後に行う。
マージは各リポジトリの開発者が行う。

1. 上流の checkout(手元では `D:\Desktop\Develop\ai-cross-review`)を main に合わせ、`node tools/cross-review.sync-all.js --register` で登録する。
2. `node tools/cross-review.sync-all.js --global-skill` で、ホームの SKILL を最新にする。
3. `node tools/cross-review.sync-all.js --root D:\Desktop\Develop --migrate --dry-run` で、各導入先で変わるファイルを確かめる。
4. 導入先ごとに、一時 worktree を作って新しいブランチで `--migrate --root <worktree>` を回し、次を確かめてからコミットして PR を作る。
   - `node tools/cross-review.js route` と `node tools/cross-review.js state` が、登録した checkout の本体で動く。
   - `node tools/cross-review.js sync --check` がドリフト無しを返す。
   - 導入先の lint とテストが通る。
5. 全導入先の PR がマージされたら、`node tools/cross-review.sync-all.js --root D:\Desktop\Develop --migrate --check` が終了コード 0 を返すことで、旧形式が残っていないことを確かめる。既存の `--check` は旧形式のまま最新に同期した導入先を拾えないので、この確認には使わない。
6. 作業ルートの外の導入先と、別の端末の導入先は、移行ノートの手順で移行する。上流を clone し、`node <checkout>/tools/cross-review.sync-all.js --register` と `--migrate --root <導入先>` を回す手順である。移行ノートは、旧形式の導入先が同期したときに表示される。

## 判断待ち

- SKILL を `.agents/skills/cross-review/SKILL.md` へ写している導入先(2026-10-20 には blade-preset-maker と ktysne-top)の扱い。`--migrate` はこの項目を書き換えずに残し(ローカル向けの全手順の SKILL を写し続ける)、クラウド向けの SKILL を `.claude/skills/` に別に足す。Codex のクラウドの手順を決めるときに、あわせて決める。
- Codex のクラウドでレビューを回す手段の確認と、その Issue の起票は、まだ行っていない(「決定済みの判断」の「Codex のクラウドの手順」の行)。
- ホームの SKILL を配っていないローカルの端末では、クラウド向けの SKILL の写しが使われる。写しの冒頭に「ローカルで読まれたら `--global-skill` で配る」案内を書いた。不足があれば開発者が判断する。

## 落とし穴

- #85 と #86 は別のセッションで並行して進んでいる。どちらも `tools/cross-review.js` を変えるので、この計画の実装は両方のマージ後にする。
- Windows の Bash ツールでは、続けて書いた `\` の数が bash に届く時点で半分になる(anthropics/claude-code#98622)。Windows のパスを含むスクリプトは、ファイルに書いてから実行する。
- 登録する checkout は上流の開発用の checkout でもある。そこで feature ブランチを開いたままにすると、全導入先がその内容で動く。開発は worktree で行う。

## 次のセッションの開始用プロンプト

```text
docs/handover/2026-10-20-engine-entry.md の計画に沿って、ktysne/ai-cross-review#89 の実装を始めてください。
最初に ktysne/ai-cross-review#85 と #86 がマージ済みかを gh で確かめ、どちらかが開いていれば何もせずに状態を報告して止まってください。
両方がマージ済みなら、計画の「着手前の点検」を行って結果を報告し、前提が崩れていなければ「対応順序、ブランチ、PR」の 1 段目から進めてください。
main で作業しないこと。main への push、force push、PR のマージの前に止まること。導入先のリポジトリは、3 段がすべてマージされるまで変更しないこと。
```
