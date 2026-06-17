# Codex 起点 Claude レビューフロー実装プラン

> **ステータス**：実装済み。以後は、設計意図と受け入れ条件の記録として参照する。運用手順の正本は [docs/cross-review.md](../cross-review.md)。

## 背景

このプロジェクトの主運用は、Claude が実装し、Codex にレビューを依頼し、Claude が指摘対応し、Codex が妥当性確認する流れとして整備されている。
一方で実運用では、Codex が最初に実装し、Claude レビューから往復を始めるケースもある。

この plan は、現状でどこまで可能か、何が未整備かを整理したうえで、Codex 起点フローを第一級の運用として扱うための実装方針を定める。

## 現状でできること

### CLI エンジンは Claude レビューに対応済み

`tools/cross-review.js` はレビュアーとして `codex` / `claude` / `subagent` を受け付ける。
`claude` を指定すると `claude -p` が起動され、Codex と同じく「レビュー観点 + レビュー対象 + 差分 + モード指示」を stdin で渡す。

そのため、Codex が実装したブランチを Claude にレビューさせる最小フローはすでに動く。

```bash
npm run review:claude
npm run review:claude -- --uncommitted
npm run review:claude -- --base develop
```

既定の対象は `main...HEAD` のコミット済み差分で、`--uncommitted` を付けると tracked 差分に加えて untracked 新規ファイルもレビュー対象になる。

### Claude の指摘を Codex に直させる経路もある

Claude のレビュー結果をファイルに保存し、Codex に修正させる用途は `--instructions` と `codex --fix` でサポート済み。

```bash
node tools/cross-review.js codex --fix --uncommitted --instructions review-notes.md
```

このとき `.cross-review.md` のレビュー観点は置き換えられず、「レビュアーからの申し送り、重点指摘」として追加される。
したがって、Codex 起点でも「Codex 実装 → Claude レビュー → Codex 指摘対応 → Claude 妥当性確認」の各部品は揃っている。
ただし、これは Codex 実行中にさらに `codex` スタンドアロン CLI を起動する経路なので、CLI を spawn できるローカル環境が前提になる。

### `subagent` による CLI 不在時のプロンプト出力はある

`subagent` は外部 CLI を起動せず、レビュー用プロンプトを stdout に出すだけの経路として実装されている。
これは主に Claude 主導時に Codex CLI を起動できない環境の代替として文書化されているが、エンジンとしては差分収集とプロンプト生成にレビュアー固有の外部 CLI を必要としない。

## 現状でできないこと、弱いこと

### Codex 起点の起点ルールが文書化されていない

`docs/cross-review.md` には 4 ステップの向きとして Codex 実装 → Claude レビューも書かれている。
しかし、実装完了後の必須起点は「Claude 主導」として書かれており、3 択も Codex レビュー依頼に寄っている。

`AGENTS.md` / `CLAUDE.md` の運用要約も Claude が実装した後の手順を中心にしているため、Codex が最初に実装した場合に「いつ、誰が、何を確認し、どのコマンドで Claude レビューを回すか」が明示されていない。

### Codex は常に Claude の AskUserQuestion 相当を出せるわけではない

Claude の `AskUserQuestion` は 3 択を構造化 UI として提示できる前提で運用されている。
一方、Codex では実行面によって使える UI が異なる。

- Codex app の Plan mode など、構造化質問ツールが使える環境では、その選択 UI を優先して出せる。
- Codex が通常チャットの途中で自発的に Plan mode へ切り替えることはできない。
- 通常チャットや CLI / `codex exec` の非対話実行では、常設の `AskUserQuestion` 相当として扱える選択 UI はない。
- 自動レビュー用の `npm run review:*` の中では、三択 UI を出さず、単発レビュー実行に徹する。

そのため、Codex 起点の確認手順は「すでに Plan mode など構造化質問を使える環境なら選択 UI、無理なら本文で A / B / C を明記してユーザ返信を待つ」という運用にする必要がある。

### Claude CLI 経路の自動修正は未対応

`--fix` は `codex` と `subagent` のみ対応で、`claude --fix` は明示的にエラーになる。
したがって、Claude に「レビューと修正を一括で直接適用」させる CLI フローは現状では存在しない。

Codex 起点で B 相当を作るなら、現実的には次のどちらかになる。

- Claude はレビューのみを行い、Codex が指摘ファイルを受けて `codex --fix --instructions` で修正する。
- 将来、Claude CLI に安全な書き込み実行経路を追加できることを確認してから、`claude --fix` を別途設計する。

現時点で後者をできる前提にしてはいけない。
Codex 起点の B は、Claude が作業ツリーを直接編集する選択肢ではなく、「Claude のレビュー指摘を確定させ、それを Codex に修正させる」選択肢として扱う必要がある。

### `review:claude` にも CLI とネットワークの前提がある

`npm run review:claude` は `claude` スタンドアロン CLI を spawn し、Claude CLI は API 接続を使う。
したがって、Codex 起点でも Claude 起点の `review:codex*` と同様に、レビュアー CLI が PATH で解決でき、ネットワーク/API 接続が許可されている必要がある。

接続できない場合はレビュー結果が返らないため、CLI 不在、ネットワーク不可、API 接続不可の扱いを Codex 起点の手順にも明記する必要がある。

### PR 作成、PR コメント記録は自動化されていない

運用ルールとして、レビューを回す前に PR を作り、指摘、対応、妥当性確認を `gh pr comment` で残すことになっている。
ただし CLI ブリッジはレビュー実行に集中しており、PR 作成、PR 番号検出、コメント投稿、往復ログ整形は行わない。

そのため、Codex 起点フローでも PR 共有ログ化は人間または呼び出し側エージェントの責務になる。

### 往復回数の状態管理は持っていない

サーキットブレーカーは「最大 3 往復」と定義されているが、CLI は単発レビューを実行するだけで、往復回数や未解決 blocker / 要修正の状態を保持しない。
Codex 起点でも、回数管理は会話内または PR コメント上で行う必要がある。

### CLI 不在時の代替が Codex 起点向けに整理されていない

現ドキュメントの `subagent` 代替は、主に「Claude から Codex CLI を起動できない」ケースとして書かれている。
Codex 起点で「Claude CLI を起動できない」場合に、何を代替レビュアーにするのか、同じ `subagent` でよいのか、どの役割付けにするのかは未整理。
また、B で `codex --fix` を使う場合も、Codex 実行環境から `codex` スタンドアロン CLI をさらに起動できる前提が必要になる。

## 目標

Codex 起点でも、次の流れを迷わず実行できる状態にする。

1. Codex が feature ブランチで実装し、A / B でレビューを回す前に PR を作る。
2. Codex が完了扱いにする前に、Claude レビューを回すかどうかを確認する。
3. Claude レビューの結果を PR コメントに残す。
4. Codex が指摘に対応する。
5. Claude が更新後差分で妥当性確認する。
6. 3 往復ルールと PR 共有ログを Claude 起点と同じく守る。

確認の出し方は実行環境に合わせる。
Codex app の Plan mode などで構造化選択 UI が使える場合はそれを優先する。
ただし Codex が自発的に Plan mode へ切り替えることはできないため、通常チャットや CLI / 非対話実行では本文に A / B / C を明記して返信を待つ。

## 実装方針

### 1. docs/cross-review.md に Codex 主導の起点を追加する

既存の「実装完了後の起点（Claude 主導、必須）」と並列に、「実装完了後の起点（Codex 主導）」を追加する。

Codex 起点の 3 択は、現機能に合わせて次の形にする。

| 選択肢 | 動き |
|--------|------|
| A. Claude にレビューを依頼 | `npm run review:claude`。Claude はレビューのみ。Codex が結果を読み修正し、完了後に再度 `npm run review:claude` で妥当性確認する。 |
| B. Claude の指摘を Codex が修正まで反映 | まず `npm run review:claude` でレビューし、指摘をファイル化して `node tools/cross-review.js codex --fix --uncommitted --instructions <path>` で Codex に修正させる。Claude が直接修正する選択肢ではない。 |
| C. 何もしない | レビューを回さず終了。 |

重要点として、B は「Claude が直接修正する」ではなく「Claude のレビュー結果を Codex が修正する」ことを明記する。
これは現 CLI が `claude --fix` をサポートしていないため。
B は、確定した指摘をクリーンな文脈で機械的に適用したい場合や、対話駆動で Codex に自動修正させたい場合に選ぶ（ループ内の Codex が直接編集できるなら A で足りる）。
A / B いずれも、レビューを回す前に feature ブランチと PR を用意し、以降の指摘、対応、妥当性確認を PR コメントに残す。

### 2. Codex 側の三択表示ルールを明文化する

Codex 起点の 3 択は、Claude の `AskUserQuestion` と同じ UI が常に出せるものとして書かない。
代わりに、次の優先順を `docs/cross-review.md` に明記する。

1. Codex app の Plan mode など、構造化質問ツールが使える状態で実行されている場合は、その選択 UI で A / B / C を提示する。
2. 通常チャットでは、本文で A / B / C を箇条書きし、ユーザの返信を待つ。
3. CLI / `codex exec` / `npm run review:*` の非対話実行では三択 UI を出さない。呼び出し側のエージェントまたはユーザが事前に A / B / C を選び、選んだコマンドだけを実行する。

Codex が通常チャット中に自発的に Plan mode へ切り替えることはできないため、Plan mode の選択 UI は「利用可能なら使う」扱いに留める。
このルールにより、Codex 起点でも「勝手にレビューへ進む」「PR で勝手に締める」を避けつつ、CLI の単発実行性も保つ。

### 3. Codex 起点の CLI 可用性と subagent 代替を追加する

Codex 起点の A / B は、次の CLI を spawn できる環境が前提になる。

- A: `claude` スタンドアロン CLI (`npm run review:claude`)。
- B: `claude` スタンドアロン CLI に加え、指摘対応用の `codex` スタンドアロン CLI (`node tools/cross-review.js codex --fix ...`)。

`review:claude` は API 接続を使うため、ネットワーク/API 接続不可の場合はレビューが返らない。
`codex --fix` も、Codex が実装者として動いている環境からさらに `codex` CLI を起動できる必要がある。

CLI を起動できない場合は、`node tools/cross-review.js subagent` で同じ差分、観点、モード指示を含むプロンプトを stdout に出し、呼び出し側が利用できる客観レビュー用エージェントへ渡す。
Codex 起点では、これは「Claude そのものへの依頼」ではなく、Claude レビューを直接実行できない場合の代替レビューとして扱う。
代替を使った場合も、PR コメントには「Claude CLI 不可のため subagent 代替で確認した」ことを明記する。

### 4. AGENTS.md / CLAUDE.md の要約を更新する

運用要約に Codex 起点の章を追加する。

追加する内容は最小限にし、詳細は `docs/cross-review.md` へリンクする。
この repo の方針どおり、正本を二重化しすぎない。

あわせて「実行上の注意」のサンドボックス無効実行、ネットワーク許可の注記が現状 `review:codex*` のみにスコープされているため、`review:claude` にも同じ前提が要ることを両方向へ広げる。

### 5. README の「使い方」に Codex 起点の最短例を追加する

README にはすでに `npm run review:claude` のコマンド例がある。
ただし「Codex 起点でどう往復に組み込むか」は薄いので、短い例を追加する。

例（指摘ファイルの作成は手作業で挟まる点を、コメントで明示する）：

```bash
npm run review:claude -- --uncommitted    # Claude がレビュー（結果を確認）
# ↑の指摘を review-notes.md に書き出す（手作業。リポ外か .gitignore 済みのパスに置く）
node tools/cross-review.js codex --fix --uncommitted --instructions review-notes.md  # Codex が修正
npm run review:claude -- --uncommitted    # Claude が妥当性確認
```

例はコマンドを並べるだけにせず、`review-notes.md` への書き出しが手作業で挟まることをコメントで示す（そのまま流すと、存在しない / 古い指摘ファイルで `--fix` が走るため）。
合わせて、`review:claude` は `claude` CLI と API 接続が必要であり、起動できない場合は `subagent` 代替へ回すことも注記する。

### 6. CLI の機能追加は最小限にする

現時点では、Codex 起点フローに必要な CLI 部品は揃っている。
したがって第一段階では CLI の挙動は変えない。

もし実装後に操作性が悪いと分かった場合だけ、別 PR で次の拡張を検討する。

- `review:claude:uncommitted` のような npm script alias を追加する。
- レビュー結果ファイルの雛形を出す補助コマンドを追加する。
- PR コメント用の Markdown 要約を出す補助モードを追加する。

ただし、PR 作成や `gh pr comment` 投稿まで CLI に含めるかは別設計にする。
この CLI は現状「差分をレビュアーへ渡す橋渡し」に責務を絞っているため。

### 7. テストはドキュメントのみなら不要、CLI 変更時だけ追加する

第一段階がドキュメント更新のみなら、既存テストの変更は不要。
CLI オプションや npm scripts を増やす場合は、次を更新する。

- `tests/cross-review.test.js`
- `README.md`
- `docs/cross-review.md`
- `tools/cross-review.js` の `USAGE`

## 受け入れ条件

- `docs/cross-review.md` を読めば、Claude 起点と Codex 起点の両方を迷わず回せる。
- Codex 起点の三択は、構造化 UI が使える場合と使えない場合の両方が明記されている。
- Codex が自発的に Plan mode へ切り替えられる前提になっていない。
- CLI / `codex exec` / `npm run review:*` が三択 UI を出す前提になっていない。
- Codex 起点の説明で、`claude --fix` が使えるような誤解を生まない。
- Codex 起点 B は、Claude の指摘を Codex が修正する選択肢として説明され、A との使い分け（B を選ぶ理由）まで明確になっている。
- A には、Codex の指摘対応後に `npm run review:claude` で妥当性確認することが明記されている。
- README の Codex 起点例は、指摘ファイル作成の手作業ステップをコメントで明示している。
- `review:claude` / `codex --fix` の CLI spawn、ネットワーク/API 接続前提と、不可時の `subagent` 代替が明記されている。
- PR 共有ログ、feature ブランチ、最大 3 往復、日本語コメントのルールが両方向に適用される。
- `AGENTS.md` / `CLAUDE.md` は正本へのリンクを保ちつつ、Codex 起点の要点を含む。
- ドキュメントのみの変更であれば `git diff --check` を通す。
- CLI を変更した場合は `node --check tools/cross-review.js`、`npm run lint`、`npm test` を通す。

## 推奨実装順

1. `docs/cross-review.md` に Codex 主導の起点と A / B / C を追加する。
2. Codex では、構造化選択 UI が使える環境と使えない環境があること、自発的に Plan mode へ切り替えられないことを明記する。
3. Codex 起点の CLI 可用性、`review:claude` のネットワーク/API 接続前提、`subagent` 代替を追加する。
4. `AGENTS.md` と `CLAUDE.md` の要約を更新する。
5. `README.md` に Codex 起点の最短コマンド例を追加する（指摘ファイル作成の手作業ステップをコメントで明示する）。
6. 変更が docs のみなら `git diff --check` を実行する。
7. CLI や npm scripts を触った場合だけ、`node --check tools/cross-review.js`、`npm run lint`、`npm test` を追加で実行する。
