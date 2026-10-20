# ai-cross-review の導入手順

この文書は、ai-cross-review を導入する AI（Claude Code、Codex など）が読む手順書です。人が読んで手で進めることもできます。

## 進め方の決まり

- ai-cross-review は、レビューを回したいリポジトリ（以下、導入先）ごとに入れるツールです。導入先のルートで作業します。
- 導入先で既にあるファイル（`package.json`、`.gitignore`、`.gitattributes`、`CLAUDE.md`、`AGENTS.md`）を変える前に、追加する内容（差分）を開発者に示し、確認を得てから書き込んでください。既存の内容は消さずに足します。
- `~/.claude/skills/` など、リポジトリの外のファイルは、開発者のすべてのセッションに効きます。変える前に同じく確認を得てください。ai-cross-review の導入手順でリポジトリの外を変えるのは、任意の「グローバル SKILL を配る」だけです。
- 連携ツール（GitHub CLI、claude-codex-bridge、agent-cockpit）そのものの導入手順は、この文書では扱いません。導入されていなければ、各ツールのドキュメントへ案内してください。この文書は、連携ツールが導入済みのときに ai-cross-review 側で必要な設定と確認だけを書いています。
- 手順の中の `<ai-cross-review の checkout>` は、ai-cross-review を clone した場所の絶対パスに置き換えます。導入先とは別の場所に置きます。
- 導入で足したファイルは、導入先のリポジトリにコミットします。`.cross-review-state.json` と `.cross-review/` はコミットしません（手順 5）。

## パターンの選び方

まず「パターン A: ai-cross-review だけ」を行います。そのうえで、導入済みの連携ツールに合わせて B〜D を足します。B〜D は互いに独立していて、いくつでも組み合わせられます。

| パターン | 対象 | 導入済みかの確かめ方 |
|---|---|---|
| A | ai-cross-review だけ | — |
| B | + GitHub CLI | `gh --version` が通る |
| C | + claude-codex-bridge | `~/.claude/tools/codex-agent.sh` がある |
| D | + agent-cockpit | `http://127.0.0.1:47821/health` が `"app":"agent-cockpit"` を返す。または `~/.agent-cockpit/` がある |

### 3 つのツールをまとめて導入するとき

ai-cross-review、[claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge)、[agent-cockpit](https://github.com/ktysne/agent-cockpit) をまとめて入れるときは、次の順に進めます。
どのツールも、ほかのツールの有無を実行時に調べるので、順番を変えても動きます。この順にすると、各ツールの連携の確認を、導入した時点でそのまま行えます。
agent-cockpit の導入手順は、最初に claude-codex-bridge と ai-cross-review の導入状況を確かめ、未導入なら導入するかと claude-codex-bridge のパターンを尋ねてから、この順で進めます。3 つをまとめて入れるときは、agent-cockpit の依頼文から始めてもかまいません。

1. claude-codex-bridge を、そのドキュメントに従って導入します。ai-cross-review と連携するなら、`codex-review` と `codex-subagent` を配置するパターン（パターン 2 か 3）を選びます。
2. agent-cockpit を、そのドキュメントに従って導入します（パターン A、B、C）。
3. レビューを回すリポジトリごとに、この文書のパターン A〜D を行います。
4. agent-cockpit の導入手順のパターン D を行い、ダッシュボードの側から連携を確かめます。

## パターン A: ai-cross-review だけ

### 前提

- Node.js 20 以上（`node --version`）
- git（`git --version`）。導入先が git のリポジトリであること。同期スクリプトは上流を git で取得するので、GitHub へのネットワーク接続も要ります。
- レビュアーの CLI（`codex --version`、`claude --version`）。どちらも VS Code 拡張やデスクトップアプリとは別の、スタンドアロンの CLI です。CLI が無い環境では、後述の `subagent` モードでレビューできるので、導入そのものは進めて構いません。
- 本体は外部パッケージを使わないので、導入先で `npm install` は要りません。

### 1. checkout を登録して入口を置く

上流の checkout を clone し、ローカルの本体として登録します。
登録する checkout は main に保ち、上流の開発には別の worktree を使います。

```bash
git clone https://github.com/ktysne/ai-cross-review.git <ai-cross-review の checkout>
node <ai-cross-review の checkout>/tools/cross-review.sync-all.js --register
mkdir -p tools
cp <ai-cross-review の checkout>/tools/cross-review.entry.js tools/cross-review.js
cp <ai-cross-review の checkout>/tools/cross-review.sync.example.json tools/cross-review.sync.json
```

導入先で上のコピー操作を行います。
マニフェストの3件は、入口、クラウド向けの SKILL、手順書の案内版です。
本体、同期スクリプト、テストはコピーしません。
`.cross-review.md` など導入先が編集するファイルを `files[]` に入れると、同期で上書きされるので入れません。
登録の無い端末では、入口がマニフェストの上流からキャッシュへ本体を取得します。

導入先のルートの `package.json` が `"type": "module"` の場合は、実行前に `tools/package.json` を次の内容で作ります。

```json
{ "type": "commonjs" }
```

### 2. 上流から取り込む

```bash
node tools/cross-review.js sync
```

入口以外の2件が新規に取り込まれ、`lastSyncedCommit` に上流のコミットが記録されます。
初回は過去の移行ノートを既読として記録します。

### 3. レビュー観点を書く

観点のテンプレートをコピーし、導入先で壊れやすい点を書き足します。

```bash
cp <ai-cross-review の checkout>/.cross-review.example.md .cross-review.md
```

`.cross-review.md` はレビュアーへ渡すプロンプトの先頭に付きます。プロジェクトの説明、守るべき不変条件、重点的に見る観点を書きます。テンプレートにある「指摘の出し方」の項は残します。

### 4. `package.json` に scripts を足す

導入先に `package.json` があるときは、`scripts` に次を足します。名前が既存の scripts と重なるときは、別の名前にして構いません。

```json
{
  "scripts": {
    "review:codex": "node tools/cross-review.js codex",
    "review:codex:fix": "node tools/cross-review.js codex --fix",
    "review:claude": "node tools/cross-review.js claude",
    "sync:cross-review": "node tools/cross-review.js sync",
    "sync:cross-review:check": "node tools/cross-review.js sync --check"
  }
}
```

`package.json` が無いリポジトリでは作らずに、`node tools/cross-review.js codex` のように直接実行します。

### 5. `.gitignore` と `.gitattributes` に足す

`.gitignore` に次の 2 行を足します。どちらもローカルの状態と生成物で、共有は PR コメントで行います。

```gitignore
.cross-review-state.json
.cross-review/
```

取り込んだ `docs/cross-review.md` は、行末のスペース 2 つで改行します。`git diff --check` や CI で行末の空白を弾いているときは、`.gitattributes` に次を足します。

```gitattributes
*.md whitespace=-blank-at-eol
```

### 6. `CLAUDE.md` / `AGENTS.md` に節を足す

AI が実装を一区切りしたときにレビューを回すよう、導入先の `CLAUDE.md`（Claude Code 向け）と `AGENTS.md`（Codex 向け）に相互レビューの節を足します。
節の雛形は、`docs/cross-review.md` の「取り込み先の CLAUDE.md / AGENTS.md に書くこと（テンプレート）」からリンクした上流の正本にあります。
検証コマンドと、同期の scripts の名前（手順 4）を導入先に合わせて書き換えます。
雛形はグローバル SKILL（手順 7）を前提にしています。グローバル SKILL を配らないときは、正本の行の SKILL のパスを、取り込んだ `.claude/skills/cross-review/SKILL.md` に書き換えます。

Claude Code は、導入先の `.claude/skills/cross-review/SKILL.md` をスキルとして読みます。この SKILL は同期で上書きされるので、直接編集しません。プロジェクト固有の運用は `.cross-review.md` と `CLAUDE.md` に書きます。

### 7. グローバル SKILL を配る（任意）

複数のリポジトリで ai-cross-review を使うときは、相互レビューの SKILL をホームの共通の置き場へ配れます。各リポジトリの `CLAUDE.md` に汎用の規則を写さずに済みます。

```bash
cd <ai-cross-review の checkout>
node tools/cross-review.sync-all.js --global-skill --dry-run
node tools/cross-review.sync-all.js --global-skill
node tools/cross-review.sync-all.js --global-skill --check
cd <導入先のルート>
```

Claude のホームは `CLAUDE_CONFIG_DIR`、未設定なら `~/.claude` です。
ホーム自体があるときだけ、その下の `skills/cross-review/SKILL.md` に配ります。
Codex のホームは `CODEX_HOME`、未設定なら `~/.codex` です。
そのホームの `skills/` が既にあるときだけ、同じ相対パスへ配ります。
サブエージェント用は `~/.codex-subagent` 固定で、`skills/` があるときだけ配ります。
空文字の環境変数は未設定扱いで、相対パスは作業ディレクトリから絶対化します（`~` は展開しません）。
bridge で独自の `codex_home` を使う場合や、`CODEX_HOME` を変えた環境で bridge が既定の `~/.codex` を使う場合、その写しは別途管理します。

配布後の `--check` は、0 なら一致または未配置、1 なら古い写しあり、2 なら引数エラー、3 なら配布元や写しを読めないことを示します。
未配置はドリフトに数えないため、配布済みかどうかは表示された各配布先の状態も確かめます。
`--json` を追加すると、配布先ごとの状態と SHA-256 を JSON で取得できます（`--root`、`--list`、`--dry-run` は併用不可）。
続く確認は、導入先のルートに戻ってから行います。
クラウド実行など、ホームに置けない環境では行いません。導入先の `.claude/skills/cross-review/SKILL.md` がそのまま使われます。

### 確認

agent-cockpit を導入していて、レビュアーの経路を選んでいるときは、経路設定に反する起動が拒否されます（終了コード 2）。経路が `codex` なら確認 2 が、`claude` なら確認 5 とパターン C の確認 1 が当たります。先に `node tools/cross-review.js route` を実行し、`default` 以外が返るときは、これらのコマンドに `--override-route "導入の確認"` を付けます（食い違いが無いときに付けても害はありません）。

1. 取り込んだファイルが上流と一致していることを確かめます。

   ```bash
   node tools/cross-review.js sync --check
   ```

   「ドリフトはありません (上流と一致)。」と出て、終了コードが 0 なら成功です。

2. 導入の差分をコミットする前に、レビュー用のプロンプトを組み立てられることを確かめます。レビュアーの CLI は起動しません。`--no-state` を付けるので、往復回数は増えません。

   ```bash
   node tools/cross-review.js subagent --uncommitted --no-state > /dev/null
   ```

   PowerShell では `> $null` にします。stderr に「対象: 未コミットの作業ツリー差分 / レビュー差分サイズ: ...」と「CLI を起動できない環境用: レビュープロンプトを stdout に出力します」が出れば成功です。差分が無いときは「レビュー対象の差分がありません。」と出ます。
   観点のファイルが見つからないという警告が出るときは、手順 3 の `.cross-review.md` の置き場を確かめます。

3. 状態ファイルと生成物が git の追跡から外れていることを確かめます。

   ```bash
   git check-ignore -v .cross-review-state.json .cross-review/
   ```

   2 行が返り、終了コードが 0 なら成功です。何も返らないときは手順 5 を確かめます。
4. Claude Code を使うときは、導入先で新しいセッションを開き、利用できるスキルに `cross-review` があることを確かめます。
5. レビュアーの CLI でも確かめるときは、次を実行します。実際にモデルを呼ぶので、利用枠を消費します。

   ```bash
   npm run review:codex -- --uncommitted --no-state
   ```

   Codex のレビュー結果が出れば成功です。CLI が見つからない、または API に接続できないときは、[usage.md](usage.md) の「CLI を起動できない環境」を確かめます。

## パターン B: + GitHub CLI

### 前提

GitHub CLI を導入し、`gh auth login` でログインしておきます。導入とログインは [GitHub CLI のドキュメント](https://cli.github.com/manual/) に従ってください。

### ai-cross-review 側の設定

ai-cross-review 側で追加する設定はありません。ai-cross-review は `gh` を次の 3 つに使います。

- 比較先（base）を決めるとき、`gh pr view --json number,baseRefName` で PR の base ブランチを読みます。前回レビューした SHA の記録が無いときに使います。
- 同じ呼び出しで PR が無いと分かったときは、stderr に警告を出します。レビューは止めません。
- `comment --post <PR 番号>` で、生成した PR コメントを投稿します。

`gh` が無い、ログインしていない、ネットワークにつながらないときは、レビューを止めずに `origin/main`（取得できなければローカルの `main`）を比較先にし、stderr にその旨を出します。オフラインで作業するときは、環境変数 `CROSS_REVIEW_NO_FETCH=1` で fetch と `gh` の呼び出しを省けます。

### 確認

1. PR を作ったブランチで、`gh pr view --json number,baseRefName` が PR 番号と base ブランチを返すことを確かめます。
2. 同じブランチで次を実行します。

   ```bash
   node tools/cross-review.js subagent --no-state > /dev/null
   ```

   stderr に `base: origin/<base ブランチ> (PR の base)` の行が出れば成功です。`(origin/main 優先解決)` や `(ローカル main)` と出るときは、PR の base を使えていません。1 のログイン状態、ローカルのブランチ名が PR の head のブランチ名と同じか（`gh pr view` は現在のブランチ名で PR を探します）、`CROSS_REVIEW_NO_FETCH` が設定されていないか、`origin/<base ブランチ>` を fetch できるかを確かめます。経路設定で拒否されるときは、パターン A の確認の前置きに従います。

## パターン C: + claude-codex-bridge

### 前提

[claude-codex-bridge](https://github.com/ktysne/claude-codex-bridge) を、そのドキュメントに従って導入しておきます。
ai-cross-review は bridge の定義のうち、レビューに `codex-review`、`--fix` に `codex-subagent` を使います。この 2 定義を配置するパターン（bridge のパターン 2 か 3）で導入してください。実装の委譲だけのパターン 1 では、2 定義が無いので、ai-cross-review は `codex` を直接起動します。

### ai-cross-review 側の設定

ai-cross-review 側で追加する設定はありません。`codex` を起動するときに、次の順で bridge の起動スクリプトを探します。

1. 環境変数 `CROSS_REVIEW_CODEX_AGENT`（スクリプトのパス）
2. `~/.claude/tools/codex-agent.sh`

見つかれば、`bash <スクリプト> codex-review` のように bridge 経由で起動し、モデル、effort、認証ホーム（`CODEX_HOME`）、サンドボックスは bridge の定義ファイルで決まります。
bridge の起動スクリプト探索では `CLAUDE_CONFIG_DIR` は見ません。
bridge の定義も `~/.claude/tools/` を固定で呼ぶので、bridge は `~/.claude` に置きます。
グローバル SKILL の配布（`--global-skill`）は `CLAUDE_CONFIG_DIR` を見て配布先を決めます。

起動の前に `bash <スクリプト> --describe <定義名> -C <cwd>` で実効設定を照会します。
子プロセスの cwd も起動時と同じにし、プロジェクト側の定義を同じ場所から探します。
終了コード 0 と `protocol: 1` の JSON を確認し、`status: ok` の `sandbox` がレビューのみなら `read-only`、`--fix` なら `workspace-write`、`approval_policy` が `never` の場合だけ起動します。
新版では ai-cross-review が定義ファイルやスクリプト本文を解析しません。

定義が無ければ直接起動します。
定義で Codex が無効、またはモデルが未設定なら、終了コード 75 の代替プロンプトへ進みます。
定義の不正や読取失敗、サンドボックスや承認方針の食い違いは、定義の拒否として終了コード 2 で止まります。
Codex 不在、照会の時間切れ（15 秒）、JSON や protocol の不一致などは終了コード 1 で止まります。
照会失敗から自動で直接起動には切り替えません。
bridge を経由せずに起動したいときは、`--no-codex-agent` を付けます。
bridge または bash が無い環境では、従来どおり直接起動します。

旧 bridge と判定するのは、終了コード 2 で stdout が JSON でなく、stderr に「不明なオプション」と `--describe` がある場合だけです。
その場合は互換処理で、従来の定義ファイルとスクリプト本文の検査を行います。
最低対応版を claude-codex-bridge の commit `4a48688`（PR #170、`--describe` が `protocol: 1` の JSON を返す版）以降に引き上げたら、この互換処理を削除できます。

### 確認

1. まず `bash ~/.claude/tools/codex-agent.sh --describe codex-review` を実行し、`protocol: 1`、`status: ok`、`sandbox: read-only`、`approval_policy: never` を確認します。
   この照会はモデルを呼びません。
   続いて次を実行します。実際にモデルを呼ぶので、利用枠を消費します。

   ```bash
   npm run review:codex -- --uncommitted --no-state
   ```

   経路設定で拒否されるときは、パターン A の確認の前置きに従います。

2. 出力（stdout）に「Codex でレビューを実行します: codex-agent.sh 経由 (定義: codex-review)」と出て、続く `codex-agent: agent=codex-review` の監査行に `sandbox=read-only` が出れば成功です。監査行の `codex_home=` で、bridge の定義どおりの認証ホームを使っていることも確かめます。
3. 直接起動が選ばれるときは、bridge、bash、または利用者側の定義が配置されているか確認します。Codex 不在の照会結果はエラーになるので、PATH を確認します。
4. 「approval_policy=never を明示していないため直接起動へ切り替えます」と出るときは、bridge を更新して `codex-agent.sh` を配置し直します。

## パターン D: + agent-cockpit

### 前提

[agent-cockpit](https://github.com/ktysne/agent-cockpit) を、そのドキュメントに従って導入しておきます。agent-cockpit は Claude Code と Codex のセッションの状態を 1 画面にまとめるローカルのダッシュボードで、紹介は https://ktysne.info/agent-cockpit/ 、画面の使い方は https://ktysne.info/agent-cockpit/manual/ にあります。導入されていなければ、開発者にこの概要を伝え、導入するなら agent-cockpit の依頼文（`agent-cockpit を導入して。手順は https://raw.githubusercontent.com/ktysne/agent-cockpit/main/docs/setup.md にある。`）で導入します。PR のカードにクロスレビューの状態を出すには、agent-cockpit 側で GitHub CLI との連携（agent-cockpit のパターン B）も要ります。

### ai-cross-review 側の設定

ai-cross-review 側で追加する設定はありません。次の点だけ合わせます。

- `node tools/cross-review.js route` は、agent-cockpit の `routing.json` からレビュアーの設定を読み、`codex`、`claude`、`default` のどれかを出します。`AGENT_COCKPIT_HOME` が設定されていればそのディレクトリの、無ければ `~/.agent-cockpit/` の `routing.json` を読みます。agent-cockpit の保存先を変えたときは、ai-cross-review を実行する環境にも同じ `AGENT_COCKPIT_HOME` を設定します。
- 経路の設定が `codex` か `claude` のとき、レビュアーのサブコマンドは設定に反する起動を拒否して、終了コード 2 で止まります。会話で別のレビュアーを指定したときは、`--override-route <理由>` を付けて実行します。
- agent-cockpit は、導入先の worktree のルートに `tools/cross-review.js` があるかで、ai-cross-review の導入を判断します。手順 1 の置き場（`tools/`）を変えないでください。
- PR のカードの往復と結論は、導入先のルートの `.cross-review-state.json` から読まれます。判断を終えた往復は、`comment --outcome <fixing|converged|halted>` で結論を記録します（[usage.md](usage.md) の「PR コメントを生成する」）。agent-cockpit の「レビュー収束後マージ」は、`converged` を記録した head の SHA でマージします。

### 確認

1. 導入先でセッションを開き、ダッシュボードを再読み込みします。上部の「経路の設定」にクロスレビューの段が出ることを確かめます。
2. クロスレビューの段で「Codex」を選び、導入先で次を実行します。

   ```bash
   node tools/cross-review.js route
   ```

   `codex` が返れば成功です。「既定」に戻すと `default` が返ります。確かめ終わったら、元の値に戻します。
3. agent-cockpit が GitHub CLI と連携しているときは、導入先の PR のカードに「クロスレビュー」の段が出ることを確かめます。レビューを回す前は「レビュー未実施」と出ます。

## 更新するとき

新形式では、登録した checkout を `git pull` すると本体が更新されます。
入口と案内の写しは、次の同期手順で更新します。
旧形式は引き続き `node tools/cross-review.sync.js` を使えます。
旧形式からの移行は、[新形式への移行ノート](migrations/2026-10-engine-entry.md)を参照してください。

上流の更新を取り込むときは、導入先のルートで次の順に進めます。

1. `node tools/cross-review.js sync` で同期します。差分のあるファイルだけを上書きします。
2. stderr に移行ノートが出たら、その「取り込み先で必要な作業」を行います。同期では直せない、導入先で持つファイル（`.gitignore`、`package.json` の scripts、`CLAUDE.md` / `AGENTS.md` の節、`.cross-review.md`）の作業です。
3. `node tools/cross-review.js sync --check-manifest` で、上流が配り始めたファイルの取りこぼしを確かめます。新形式で未登録のものは、要るものだけ `files` に足して、もう一度同期します。旧形式には入口を足さず、まとめて移行します。
4. 導入先の検証コマンド（lint、テスト）を流します。

移行ノートを表示する機能より前のバージョンから更新するときは、1 回目の同期では古いスクリプトが動くのでノートが出ません。同期をもう一度実行してください。

複数の導入先をまとめて更新するとき、グローバル SKILL を配り直すときは、上流の checkout で一括同期ツールを使います。

```bash
cd <ai-cross-review の checkout>
git pull
node tools/cross-review.sync-all.js --root <導入先をまとめて置いた場所> --dry-run
node tools/cross-review.sync-all.js --root <導入先をまとめて置いた場所>
node tools/cross-review.sync-all.js --global-skill
```

詳しくは [cross-review.md](cross-review.md) の「同期スクリプト」「複数プロジェクトへ一括反映」の節にあります。

## うまくいかないとき

- `codex` / `claude` が見つからない、または API に接続できない：レビュアーの CLI の代わりに `subagent` を使います（[usage.md](usage.md) の「CLI を起動できない環境」）。CLI が見えていても、サンドボックスでネットワークが止まっていることがあります。`claude -p "Reply with OK only."` のような最小の呼び出しを、通常の環境とネットワークを許可した環境で比べて切り分けます。
- 終了コード 75 で止まる：Codex が利用上限などで使えませんでした。stderr の案内に従い、書き出されたプロンプトを Claude の客観サブエージェントへ渡します。代替に切り替えずに失敗させたいときは `--no-fallback` を付けます。
- 「経路設定 ... に反する ... の起動を拒否します」と出る：agent-cockpit の経路の設定に従ったレビュアーで回すか、`--override-route <理由>` を付けます（パターン D）。
- 「レビュー差分サイズ」が閾値を超えて止まる：`--base <ref>` で比較先を近づけるか、`.cross-review-ignore` で生成物を除きます（[usage.md](usage.md) の「差分の除外」）。
- `require is not defined` で止まる：導入先が ES modules です。手順 1 の `tools/package.json` を置きます。
- 同期で「ドリフト」が出る：取り込んだファイルを導入先で編集しています。変更は上流に入れ、導入先では同期し直します。
- 同期で上流の取得に失敗する：GitHub への git のネットワーク接続を確かめます。サンドボックスで fetch が止まることがあります。
