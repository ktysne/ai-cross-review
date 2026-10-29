# AI 相互レビューフロー（Claude ↔ Codex）

Claude と Codex を交互に使う相互レビューの運用ドキュメントです。  
「片方の AI で実装し、もう片方の AI でレビューする」往復を、チャットの中身を手でコピーせずに回します。

> **このドキュメントは汎用の相互レビュー「手順書」です。**  
> 他のリポジトリへはそのままコピーして使えます。  
> コピー先では編集しません（更新は上書きコピーでやり直します）。  
> プロジェクト固有の運用や観点は、コピー先の別ファイルに書きます（レビュー観点は `.cross-review.md`、プロジェクト固有のメモはコピー先の専用 doc）。  
> リポジトリ内のファイルは、置き場所が変わっても壊れないよう、リンクではなくコード表記で示し、節は本文中の名前で参照します。

## 前提と登場ツール

| ツール | 役割 |
|------|------|
| Claude（CLI / アプリ） | Claude 側の実装 / レビュー |
| Codex（CLI / 拡張） | Codex 側の実装 / レビュー |
| `codex` / `claude` スタンドアロン CLI | `npm run review:*` から呼ぶ 1 回限りのレビュー（拡張 / アプリとは別物） |
| Agent ツールの客観サブエージェント | 実装者と同じベンダーの別文脈でレビューする（3 択の選択肢 2）。CLI を起動できない環境では、対象レビュアー CLI の代わりも務める（後述「CLI を起動できない環境での代替」節） |
| git ブランチ、コミット、PR | 受け渡しに使う |

CLI 経由（`npm run review:*`）で回すには `codex` / `claude` が PATH にあること。  
拡張 / アプリ内で完結するなら不要です。

> **課金メモ（Claude サブスクプラン）**：Anthropic は **2026-06-15 に施行予定だった「Agent SDK 経由の利用を別建ての月次クレジット枠へ移す」課金変更を、施行当日に保留**しました。現在は `claude -p`（`npm run review:claude` が内部で使うヘッドレス実行）や Agent SDK 経由の利用も、**従来どおりサブスク（Pro / Max / Team / Enterprise）の利用上限から消費**されます（別建ての Agent SDK クレジット枠は無し）。`npm run review:codex*`（OpenAI の Codex CLI）や `subagent`（外部 API を呼ばずプロンプトを出力するだけ）はそもそも対象外です。Anthropic は今後の見直しを予告しており、変更時は事前告知するとしています。CI / 非対話で使う場合の長寿命トークンは `claude setup-token`（→ `CLAUDE_CODE_OAUTH_TOKEN`）。詳細は [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) を参照。

## 基本フロー（4 ステップのループ）

実装担当とレビュー担当を入れ替えながら、次の 4 ステップで回します。

1. **実装**：一方（例：Claude）が作業ブランチで実装し、何を、なぜ変えたかをコミットメッセージに残す。  
   これがレビュアーへの引き継ぎメモになる。  
2. **レビュー**：もう一方（例：Codex）が差分をレビューし、指摘を出す。  
3. **指摘対応**：実装側（Claude）が指摘に対応し、差分とコミットへ反映する。  
4. **妥当性確認**：レビュー側（Codex）が「指摘が解消されたか」「新しい不具合が出ていないか」を、**更新後の差分**で確認する。

向きは対称で、次の 2 通りを使い分けます。

- Claude 実装 → Codex レビュー → Claude 指摘対応 → Codex 妥当性確認
- Codex 実装 → Claude レビュー → Codex 指摘対応 → Claude 妥当性確認

各ステップで渡すのは **差分（と前のステップの指摘）** で、チャットの中身ではありません。

## 実装完了後の起点（必須）

**実装や修正を一区切りしたら、作業を完了にする前に、必ず次の 3 択を示します。**  
「コミットして終わり」「PR を作って終わり」と勝手に締めません。  
何回かに分けて直すときも、区切りごとに確認します（最後の 1 回だけにしない）。

### 用語

- **実装者**：今回の差分を書いたモデルのベンダー。主セッションが自分で書いたならそのベンダー（Claude 主導なら Claude）。実装用サブエージェントへ委譲して GPT 側（Codex）が書いたなら Codex。混在するときは、主セッション（設計と監査を担う側）と別のベンダーをレビュアーに選ぶ。
- **レビュアー**：差分だけを見て指摘を出す側。実装の意図を知らない立場で読むほど、実装時の思い込みに引きずられない。

主セッションは 3 択を示す直前に、報告へ「今回の実装者：Claude」または「今回の実装者：Codex」を一言書きます。  
どのベンダーがレビュアーになるかが、これで決まります。

### 3 択（並び順は固定）

| 選択肢 | 何が起きるか |
|--------|--------------|
| **1. 別ベンダーでレビュー（レビュアー: 実装者と別のベンダー）** | 実装者と別のベンダーが**レビューだけ**を行う（ファイルは変えない）。主セッションが結果を読み、修正を適用する。 |
| **2. 同ベンダーでレビュー（レビュアー: 実装者と同じベンダーの客観サブエージェント）** | 実装者と同じベンダーの、別文脈のレビュアーがレビューする。別ベンダーの利用上限が近い、接続できない、または難易度などの事情で同じベンダーに任せたいときに選ぶ。 |
| **3. レビューしない** | レビューを回さず終了。後述「確認を省略してよい『軽微で明らかにレビュー不要』な例外」に該当するときの既定。 |

並び順は固定です。
主セッションは毎回どれを推奨するかを決め、その選択肢のラベル末尾に必ず「(推奨)」を付けます（付けるのはラベル末尾だけで、並び順は変えません）。
推奨の既定は選択肢 1 です。
軽微な例外に該当するなら 3、別ベンダーの利用上限が近い、接続できない、または難易度などの事情で同じベンダーに任せたいなら 2 を推奨します。

開発者は会話や依頼文でレビュアーを指定できます（例：「同ベンダーでレビュー」）。
指定は選択肢 1 と 2 のどちらを使うかにだけ効き、軽微な例外（選択肢 3）の判断には影響しません。
指定は同じセッションの同じブランチのあいだ有効です。
指定があるときは対話中でも 3 択の提示を省いて指定の経路で実行し、報告に「指定により別ベンダー（または同ベンダー）で実行」と一言書きます。
3 択を提示する前（レビューを回す直前に毎回）に `node tools/cross-review.js route` を実行します。
`default` なら従来どおりに進め、`codex` または `claude` なら会話での指定と同じに扱い、3 択を省いてそのベンダーでレビューします（実装者が Claude で値が `claude` の場合も省きます）。
値はレビュアーのベンダー名です。実装者が Claude のときは `codex` が選択肢 1、`claude` が選択肢 2 に対応し、実装者が Codex のときは `codex` が選択肢 2、`claude` が選択肢 1 に対応します。
値は実装者のベンダーに関係なくレビュアーを決め、実装者と同じベンダーになっても値に従います。
「実装者と別のベンダー」をレビュアーに選ぶ原則は、経路設定も会話での指定も無いときの既定です。
レビュアーのサブコマンドは経路設定に反する起動を拒否します（値が `codex` なら `claude` と `subagent`、`claude` なら `codex`）。
会話での指定を優先して経路設定と違うレビュアーで回すときは、`--override-route <理由>` を付けます。
経路設定で選んだ場合は、報告に「agent-cockpit の経路設定により Codex（または Claude）でレビュー」と一言書きます。
会話や依頼文での指定は、そのセッションの事情をより細かく反映しているため、経路設定より優先します。
軽微な例外（選択肢 3）の判断と codex 経路の終了コード 75 によるフォールバックは変わりません。
自走中は経路設定も指定として扱い、設定の変更は次に回すレビューから有効にします（実行中のレビューは止めません）。
指定した経路が codex 経路で、利用上限などにより使えないときは、CLI のフォールバック（終了コード 75）に従って subagent（Claude の客観サブエージェント）で回し、切り替えたことを報告に書きます。
Claude 側の経路にはこのフォールバックが無いので、使えなければ報告に書いて判断を仰ぎます（自走中は判断待ちの事項として載せます）。

選択肢 1 の実行方法は、実装者がどちらかで決まります。

| 実装者 | レビュアー | 実行 |
|--------|-----------|------|
| Claude | Codex | `npm run review:codex`（codex は read-only） |
| Codex | Claude | `node tools/cross-review.js subagent` の出力を Claude の客観サブエージェント（Agent ツール、読み取り専用）へ渡す。Codex が主セッションのときは `npm run review:claude` |

選択肢 2 も同じく実装者で決まります。  
実装者が Claude なら `node tools/cross-review.js subagent` の出力を Claude の客観サブエージェントへ渡し、実装者が Codex なら `npm run review:codex` を実行します。

どの選択肢でも、レビュー結果を読んで修正を適用するのは主セッションです。  
修正が終わったら、同じ経路でもう一度レビューを回して妥当性確認します。

> **CLI を起動できない環境（クラウド実行など）**では、対象レビュアー CLI の代わりに `subagent` の出力を客観サブエージェントへ渡します（3 択の意味は変わりません）。  
> 詳細は後述「CLI を起動できない環境での代替」節。

### ブランチ、PR の運用（必須）

改修は `main` へ直接ではなく **feature ブランチ**で行います（`main` にいるなら着手時に切る）。  
選択肢 1 か 2 でレビューを回す前に **PR を作ります**（無ければ先に作る）。  
以降は PR を共有ログにし、**各往復の指摘、対応、妥当性確認を、その都度 `gh pr comment` で PR に記録します**（チャットだけに残さない。詳細は後述「PR を共有ログにする」節）。  
リモートが無い等で PR を作れないときだけ省略し、その旨を一言添えます。

### 起点ごとの差

**Claude 主導**：3 択は `AskUserQuestion` で示します（チャット本文の番号付きリストで代用しない）。  
手で Codex へ切り替えず、Claude が端末からレビューを実行し、出力を読んで先まで自分で進めます。

**Codex 主導**：Codex desktop では利用可能なツール一覧を確認し、`request_user_input_async` や `request_user_input` など、クリック可能な選択 UI を表示するユーザ入力ツールが利用可能なら必ず優先します。  
ユーザ入力ツールが利用可能な場合、チャット本文の番号付きリストでは代用しません。  
現在の実行モードでユーザ入力ツールを利用できない場合でも、対話可能なら上の表の 3 択を同じ順序・意味で本文に示し、推奨選択肢のラベル末尾に「(推奨)」を付けて返信を待ちます。  
CLI、`codex exec`、非対話実行などユーザの返信を受け取れない環境では、選択 UI や本文でユーザの回答を待たず、起動元が指定したレビュー経路をそのまま実行します。  
自走中（開発者が作業を任せると明示したとき、計画に沿った複数 Issue の連続対応、スケジュール実行）は、ユーザ入力ツールが使える環境でも 3 択で止まらず、指定があれば指定の経路、無ければ推奨の選択肢を実行します。  
選んだ経路と理由は最後の報告に書きます。  
Codex が自発的に Plan mode へ切り替えることはできないため、選択 UI 自体の表示は、そのターンでユーザ入力ツールが提供されている場合に限られます。  
実装者が Codex なので、選択肢 1 のレビュアーは Claude です。

### 選択肢 1 と 2 に共通の手順

1. 上の表に従ってレビューを実行する。  
2. 主セッションがレビュー結果を読み、修正を適用する。**ユーザ判断が要る内容は、推奨の対応方法を添えて確認してから着手する。自走中は推奨を適用して進め、最後の報告に判断待ちの事項として載せる。**  
3. 修正が終わったら、同じ経路でもう一度レビューを回して妥当性確認する（指摘の解消、新たな不具合が出ていないかの確認）。  
4. **各往復の指摘、対応、妥当性確認を `gh pr comment` で PR に記録する。**

> `npm run review:codex*` / `npm run review:claude` はレビュアー CLI がネットワーク/API 接続を使うため、サンドボックス内では接続に失敗することがあります。  
> ネットワークを許可し、必要に応じてサンドボックスを無効にして実行してください。
> CLI が PATH で見えていても、API 接続だけがサンドボックスで止まることがあります。  
> 例：`claude --version` は成功するが `claude -p "Reply with OK only."` が無応答 / `ConnectionRefused` になり、ネットワーク許可、サンドボックス外では成功する場合、原因は CLI 不在ではなく実行環境のネットワーク制限です。

### レビュアーに修正まで任せる道具（3 択の外）

`--fix`（`npm run review:codex:fix` / `node tools/cross-review.js codex --fix`）は 3 択に入りません。  
主セッションがレビュー結果を裏取りし、直す指摘を確定させたうえで、その適用だけを Codex に任せたいときに使う道具です。  
手順は後述「レビュアーの指摘を渡して直させる（`--instructions`）」節にあります。

### 確認を省略してよい「軽微で明らかにレビュー不要」な例外

次のような変更は、確認を省略してそのまま進めてよいです（ただし省略した旨を一言添える）。

- 誤字脱字 / コメントだけ / ドキュメントの文言調整
- フォーマット、lint 整形だけ（動きを変えない）
- **すでにレビュー済みのパターンを 1 箇所そのまま真似ただけ**の 1〜数行
- 直前のレビュー済みの状態への単純な取り消し（revert）

規模や影響に迷うなら**省略せず確認します**（省略してよいか自体に迷ったら、確認する側に倒す）。

PR があるときに省略した場合、agent-cockpit の `cockpit_skip_review` ツールが使えるなら、PR の owner、repo、番号、現在の head SHA、省略した理由を渡して記録します。
記録が無いと、ダッシュボードの PR カードは「レビュー未実施」のままになり、意図した省略と区別できず、レビューを条件にしたマージの対象にもなりません。
ツールが無い環境では記録は要りません。

今はレビューを回せず後で回す（実機が無い、利用上限の解除待ちなど）ときは、レビュー不要の記録で代用しません。
agent-cockpit の `cockpit_defer_review` ツールが使えるなら、PR の owner、repo、番号、現在の head SHA、保留の理由、次の作業（next）を渡して保留を記録します。
保留は PR カードに理由と次の作業とともに出ますが、レビューを条件にしたマージの条件は満たしません。
どちらのツールも、成功を返したことを確かめてから完了報告します。
成功しなければツールの応答に従い、未記録か、記録できたかを確かめられなかったかを、理由とともに完了報告に書きます。

## CLI を起動できない環境での代替（subagent）

クラウド実行環境などでは、手元の `codex` / `claude` CLI を起動できないことがあります（PATH に無い、起動できない）。  
また、CLI は起動できても、ネットワーク/API 接続が許可されずレビュー結果が返らないことがあります。  
このときは、対象レビュアー CLI を直接呼ぶ代わりに `subagent` でレビュープロンプトを出力し、呼び出し側が利用できる客観レビュー用エージェントへ渡します。

**見分け方**：対象レビュアー CLI（`codex` または `claude`）が PATH で見つからない（`Get-Command <cli>` / `which <cli>` が失敗する）か、クラウド実行だと分かっているとき。  
`npm run review:codex*` / `npm run review:claude` が CLI 不在、ネットワーク不可、API 接続不可で失敗したときも、この代替に切り替えます。
CLI と API 接続を切り分ける場合は、まず `Get-Command claude` / `claude --version`（または `codex --version`）で CLI 可視性を確認し、次に `claude -p "Reply with OK only."` のような最小 API 呼び出しを通常環境とネットワーク許可環境で比較します。

**仕組み**：プロンプトを組み立てる部分（観点の解決、差分の収集、モード別の指示付け）は **node と git だけ**で動くので、クラウド環境でもそのまま使えます。  
外部 CLI を起動する部分だけを「Agent ツール等の客観レビュー用エージェント」に置き換えます。  
レビュアー `subagent` は外部プロセスを起動せず、組み立てたレビュー用プロンプトを **stdout に出すだけ**です（人向けの通知は stderr に分けるので、stdout はそのままサブエージェントへ渡せます）。

1. レビュー用プロンプトを stdout に出す（外部 CLI は起動しない）：

   ```bash
   node tools/cross-review.js subagent                 # 既定 base との差分 (レビューのみ)
   node tools/cross-review.js subagent --uncommitted   # 未コミット差分 (tracked + untracked)
   node tools/cross-review.js subagent --fix           # 修正指示付きプロンプト (3 択の外。後述)
   ```

2. その stdout を **Agent ツールで起動する客観レビュー用サブエージェント**への指示として渡す。  
   サブエージェントには「実装者から独立した第三者レビュアーとして、実装の意図に引きずられず差分そのものを批判的に確かめる」よう役割を与える。  
   レビューだけなら読み取り系（`Explore` など）で十分。`--fix` で修正まで任せるなら**書き込み権限のあるサブエージェント**を使う。  
   依頼を別ベンダーへ転送するエージェント定義は使わない。claude-codex-bridge の実装用の `impl-*` は依頼を Codex へ転送するため、実装者が Codex のときに同じベンダーのレビューになる。  
   claude-codex-bridge を導入している環境では、レビューだけを頼むときは Codex へ転送しない読み取り専用のレビュー用定義 `review-claude` を使う。`--fix` で修正まで任せるときは、Codex へ転送しない、書き込み権限のある Claude のサブエージェントを使う。  
   `review-claude` のように道具がファイルの読み取りだけの定義には、stdout をファイルに書き出してそのパスを渡し、前の往復の指摘と対応も判断ファイル（`round-<N>-triage.md`）のパスで渡す。git や `gh` を実行できないためである。  
3. サブエージェントのレビュー結果（または修正差分）を呼び出し側が読み、CLI 経路と同じく先（修正の適用、妥当性確認）へ進める。  
   妥当性確認も同じく `subagent` のプロンプトとサブエージェントで回す。  
   往復は最大 3 回までの数え方も変わらない。

**起点 3 択との対応**：クラウドでも 3 択の意味は変わらず、直接起動できないレビュアー CLI だけを客観レビュー用エージェントに置き換えます。  
選択肢 1（実装者と別のベンダー）も選択肢 2（同じベンダーの客観サブエージェント）も、`subagent`（レビューのみ）の出力を読み取り系のサブエージェントへ渡し、修正は主セッションが適用します。選択肢 3 はそのままです。  
経路設定が `codex` だと `subagent` は拒否されるので、この経路では `--override-route "codex CLI 不在"` のように理由を付けて実行します。  
`subagent --fix` は 3 択の中には現れません。Claude 主導で、主セッションがレビュアーに修正まで任せると決めたときだけ使う道具です。  
この代替を使った場合は、「対象レビュアー CLI を直接実行できないため（CLI 不在 / 接続不可）subagent 代替で確認した」ことを PR コメントに残します。

> 同じ種類の AI が実装とレビューを兼ねる場合でも、サブエージェントは**別の文脈**で差分だけを見るので、「客観的な第三者レビュー」の利点（実装時の思い込みに引きずられない）は保てます。  
> `codex` / `claude` CLI が使える環境では、これまでどおり対象レビュアー CLI を優先します。この代替は、CLI を起動できない、接続できないときの代わりです。

### GPT 側が使えないときは自動でこの代替へ切り替える

`npm run review:codex*` の実行中に GPT 側が使えない場合、レビューを失敗で終わらせず、この subagent 代替へ自動で切り替えます。  
利用上限やモデルの混雑は往復の途中で発生するため、そのたびに手で `node tools/cross-review.js subagent` を打ち直さずに済ませるためです。

- **判定**：bridge 経由なら**終了コード 75**です（`codex-agent.sh` が利用上限やモデルの混雑など GPT 側の事情で実行できないときにこのコードを返し、理由を最後の `codex-agent: result=` 行に出します）。定義の `codex_enabled: false` または空の `codex_model` も起動前に判定し、同じフォールバックへ進みます。  
  最後の行の値が `rate-limited` なら利用上限、`unavailable` なら一時的な使用不能、その他の値または行が無ければ理由不明として扱います。  
  直接起動なら**非ゼロ終了かつ出力に `usage limit` / `rate limit` / `too many requests` / `429` のいずれか**があるときに利用上限として扱います。
- **切り替え時の動作**：`subagent` と同じプロンプト本文（`--fix` なら FIX 指示付き）を**ファイルへ書き出し**、次に何をすればよいかを stderr に出して、**終了コード 75** で終わります。  
  書き出し先の既定は OS の一時ディレクトリの `cross-review-fallback-<pid>.md` で、`--fallback-prompt <path>` で変えられます。  
  プロンプトを stdout に混ぜないのは、stdout がレビュアーの出力で埋まっているためです。
- `--fix` で起動前後の作業ツリーに差があれば、代替プロンプトは書き出さず、変更ファイルと元に戻して再実行する手順を案内して終了コード 75 で止まります。変更を残す場合は、依頼文にその扱いを明記して再実行します。
- **その後**：書き出されたファイルの内容を、`Agent` ツール等の客観レビュー用サブエージェント（読み取り専用。`--fix` 時は書込権限付き）へ渡してレビューさせます。以降の手順は上の subagent 経路と同じです。
- **往復の記録**：フォールバックした実行では `round` を増やしません（CLI はサブエージェントがレビューを終えたかを観測できないため。書き出した時点で数えると、プロンプトを渡さずに再実行したとき未レビューの差分が「差分なし」になります）。状態を使える場合は次の往復の subagent メタ情報を保存します。レビューを終えたら `node tools/cross-review.js state --mark` で往復を記録し、`node tools/cross-review.js comment --round <N> --outcome <fixing|converged|halted>` で結論を残せます。  
  PR コメントに残す案内は原因ごとに異なり、`rate-limited` は「Codex を直接実行できないため (利用上限) subagent 代替で確認した」、`unavailable` は「Codex を直接実行できないため (GPT 側の一時的な使用不能) subagent 代替で確認した」、理由不明は「Codex を直接実行できないため (理由不明の GPT 側使用不能) subagent 代替で確認した」、定義による停止は「Codex を直接実行できないため (定義で GPT 側を止めている) subagent 代替で確認した」とします。
- **切り替えたくないとき**：`--no-fallback` を付けると、従来どおり失敗終了します（終了コードはレビュアーのまま）。
- `claude` CLI 経路（`npm run review:claude`）はこの自動切り替えの対象外です。

### レビュアーの指摘を渡して直させる（`--instructions`）

**「片方のレビュアー（または直前のレビュー結果）で、すでに具体的な指摘が出ていて、それを Codex に直接修正させたい」** ときの基本フローです。  
Codex に一から再レビューさせるのではなく、確定した指摘を渡して `--fix` で直させます。

1. 指摘をファイル（例：`review-notes.md`）に Markdown で書く。  
   各項目に「修正する / 判断を保留する」と優先度を付け、対象ファイル、行、期待する直し方を具体的に書く。  
2. 次を実行する（`--fix` と `--instructions` を併用）：

   ```bash
   # 未コミットの作業ツリーを対象に、指摘を渡して Codex に直接修正させる
   node tools/cross-review.js codex --fix --uncommitted --instructions review-notes.md
   # コミット済みの差分が対象なら --uncommitted を外す（既定 = 既定 base との差分）
   ```

3. `--instructions` の中身は **観点 `.cross-review.md` を置き換えず**、「レビュアーからの申し送り、重点指摘」としてプロンプトに追加されます（観点はこれまでどおり自動で付きます）。  
   **この用途で `CROSS_REVIEW_CHECKLIST` を使い回さない**でください（観点が消えます。手で連結したり env を差し替えたりする必要はありません）。  
4. 修正後は `git diff` で内容をレビューし、`npm run lint` / `npm test` などを実行して整合を確認する。

補足：
- 申し送りファイルは**リポジトリの外か `.gitignore` 済みのパス**に置くのが無難です（`--uncommitted` の未追跡ファイル収集に紛れ込まないため）。  
  もしリポジトリ内の未追跡の場所に置いても、`--instructions` のファイル自体はレビュー差分から自動で除外されます（`tools/cross-review.js` の `collectReviewDiff`）。  
- 「Codex に自分でもレビューさせたうえで、さらに重点指摘も渡したい」場合も、同じく `--instructions` を足すだけです。

## レビューと修正の往復は最大 3 回まで（無限ループ防止、必須）

レビュー ↔ 指摘対応のループは **最大 3 往復**までです。  
**1 往復 = 実装（または前回の指摘への対応）→ レビュー → 結果確認 まで**です（= レビュー 1 回とその結果確認で 1 往復。修正が続くかは問わない）。

- 数えるのは **blocker / 要修正** です。  
  `提案` は任意で、見送ってもループを続ける理由にはしません。  
- **3 往復に達したとき、残る指摘に blocker が含まれるならループを止め、まとめを示してユーザの判断を仰ぎます。**  
  まとめには「残っている指摘（重大度付き）と未解決の理由」「各往復で試したことと結果」「収束しない理由の推測」「選択肢（方針変更 / 直接対応 / 別 Issue へ見送り / 中止 など）」を含めます。  
- **残る指摘が要修正だけで、影響範囲が局所（1 ファイル内に収まり、既存テストで検証できる）なら、主セッションの判断で対応して収束として構いません。**  
  そう判断した根拠を PR コメントに残します。  
- 局所の条件を満たさない要修正が残る場合は、blocker と同じくループを止めてユーザの判断を仰ぎます。  
- 自走中は止まらず、そのブランチのレビューを打ち切り、同じサマリを最後の報告に判断待ちの事項として書いて、独立した残りの作業へ進みます。局所の条件を満たさない要修正が残る場合も同じです。  
- 要修正のみの収束処理やユーザの判断で 3 往復を超えて続けるときは、PR コメントの冒頭に「何往復目まで回したか、なぜ続けたか」を書きます。  
- 同じ指摘が往復のたびに**揺り戻す**（直すと別の指摘が出て元に戻る等）と判断したら、3 往復を待たずに止めてユーザに相談してよいです。  
- **往復の回数は CLI が数えます**。ブランチ単位で状態ファイル（Git 共通ディレクトリの `cross-review-state.json`）の `round` に記録し、3 回目の実行では起動前に stderr へ警告を出します（実行は止めません。止めるかどうかの判断は上のルールに従って運用側が行います）。  
  現在値は `node tools/cross-review.js state` で確認でき、`state --reset` で数え直せます。`--no-state` を付けた実行と、状態ファイルを読めない実行は数えられないので、そのときは会話の中で数えます。

blocker の有無で分けるのは、実害のある指摘の判断をユーザに残し、局所的な要修正の判断は主セッションに委ねるためです。  
どちらもレビュアーの指摘をそのまま受け入れるのではなく、主セッションが裏取りしたうえで扱いを決めます。

## 各ステップの実際の操作

### 実装

ふだんどおり実装し、ブランチへコミットします。  
意図をコミットメッセージ本文に書きます。  
これが引き継ぎメモになります。

### レビュー、妥当性確認

対象はどちらも**更新後の差分**なので、同じ手段で実行できます。  
やり方は 2 通りです。

- **拡張 / アプリ内で完結**：レビュアー側のツールに「現在のブランチ（main との差分）をレビューして」と頼む。  
  会話しながら回すならこちら。  
  妥当性確認も同じセッションで頼める（前回の指摘が文脈に残るのが利点）。  
- **1 回限りの CLI**：端末から 1 コマンドで回す。

```bash
npm run review:codex                     # 現在のブランチ (既定 base との差分) を Codex がレビュー (read-only)
npm run review:codex:fix                 # 同上 + 見つかった問題を Codex が作業ツリーへ直接修正 (workspace-write)
npm run review:claude                    # 現在のブランチを Claude がレビュー (read-only)
npm run review:codex -- --uncommitted    # 未コミット差分 (tracked + untracked) をレビュー
npm run review:claude -- --base develop  # 比較先ブランチを変更
npm run review:codex:fix -- --instructions review-notes.md  # レビュアーの指摘 (ファイル) を渡して直させる
node tools/cross-review.js subagent      # CLI を起動せずレビュー用プロンプトを stdout に出力 (CLI を使えない環境用)
```

`--uncommitted` は **未追跡（git に未 add）の新規ファイルも含めます**（コミット前のチェックでも取りこぼさない）。  
`--fix` は **codex / subagent で使えます**。  
レビューに加えて問題の修正まで依頼します（codex は workspace-write で直接修正、subagent は FIX 指示付きでプロンプト出力。`claude` CLI 経路の自動修正は未対応）。  
`--instructions <path>` は**レビュアーからの申し送り、重点指摘**をプロンプトに足します（観点 `.cross-review.md` は置き換えず追加。指摘を渡して直させる用途。詳細は前述「レビュアーの指摘を渡して直させる」）。

Claude と Codex の単発レビューでは、子プロセスに `AGENT_COCKPIT_NONINTERACTIVE=1` を渡します。
対応する Agent Cockpit の Stop フックは、到着済みの通知を確認して終了し、対話セッション向けの長時間待機に入りません。
親プロセスの環境と通常の対話セッションの設定は変更しません。
未対応の Agent Cockpit では印が無視され、従来どおり Stop フックで待機します。
待機を解消するには Cockpit 側も更新してください。

### 指摘対応

実装側のツールに戻り、指摘（PR コメントか端末出力）を渡して修正し、再コミットします。

## CLI ブリッジ（tools/cross-review.js）

`git` の差分をレビュアー CLI へ渡す橋渡しです。  
依存の追加はありません（Node 標準 API のみ、CommonJS）。

- `codex` / `claude` のどちらも、**自分で差分を取り出し**、「観点 + 対象範囲 + 差分本文 + モード別の指示」を stdin で渡して、汎用の `codex exec`（末尾 `-` で stdin をプロンプトにする）/ `claude -p` を起動します。  
- レビュアー `subagent` は**外部 CLI を起動しません**。  
  同じプロンプトを組み立てて **stdout に出すだけ**で、実際のレビューは呼び出し側（Claude）が Agent ツールで起動する客観サブエージェントが行います（CLI を起動できない環境での代替）。  
  通知は stderr、プロンプト本文は stdout に分けます。  
  `--fix` を付けたときは FIX 指示付きで出力します。  
- codex のサンドボックスでモードを切り替えます：
  - レビューだけ（既定）→ `codex exec -s read-only`（ファイルを変えさせない）
  - `--fix` → `codex exec -s workspace-write`（見つかった問題を作業ツリーへ直接修正させる）
- codex は **承認を never に固定**します（非対話の自走が承認待ちで止まらないように）。直接起動では `-c approval_policy=never` を渡し、bridge 経由では公開照会の応答で同じ承認方針を起動前に確かめます（後述「codex の起動は bridge を経由する」）。  
- **専用サブコマンド `codex exec review` は使いません**。  
  codex v0.137.0 で `--uncommitted` / `--base` が `[PROMPT]` と併用できなくなり、観点チェックリストを同時に渡せなくなったため、汎用の `exec` と差分の埋め込みに統一しました。  
- 差分の対象範囲：
  - 既定：`git diff <base>...HEAD`（ブランチ vs base）。**既定の base は「前回レビュー SHA → PR の base → `origin/main` → ローカル `main`」の順に解決**します（後述「既定 base の解決と差分サイズのガード」）。
  - `--merge-resolution`：前回レビュー以降が base を取り込む merge だけのとき、各 merge の `git show --remerge-diff` をつないだ競合の解消の差分（後述「収束の後に base を取り込んだとき」）。
  - `--uncommitted`：tracked（`git diff HEAD`）＋ untracked
    （`git ls-files --others --exclude-standard -z` の各ファイルを `git diff --no-index` で新規ファイル差分にする。`-z`（NUL 区切り）で空白入りパスでも壊れない）
- 申し送り（`--instructions <path>`）：レビュアー個別の重点指摘を**観点とは別系統**で足します（`REVIEWER_NOTES_HEADER` の見出し付きでプロンプトに追加。`.cross-review.md` は置き換えない）。  
  `--uncommitted` の未追跡収集からは、申し送りファイル自体を**絶対パスの突き合わせで除外**します。  
- 差分の間引き：ロックファイル、生成物（`package-lock.json` / `*.min.js` / `*.map` ほか）を**既定で除外**し、巨大なファイル差分は **stat 要約に置換**してトークンを節約します（`.cross-review-ignore` で除外を追加、`--no-exclude` で無効化、`--max-file-diff-kb` で置換しきい値。詳細は後述「差分の除外と要約」）。  
- `route` は agent-cockpit の `routing.json` からレビュー経路を読み、`codex` / `claude` / `default` のいずれかを stdout に出します。  
- 状態（往復回数、直前レビュー SHA、非対応と判断した指摘）：ブランチ単位で Git 共通ディレクトリの `cross-review-state.json` に持ち、全 worktree で共有します。  
  `state` / `state --reset` / `dismiss "<要約>"` サブコマンドで参照、初期化、追加します（`--no-state` で読み書きを無効化）。詳細は後述「状態ファイル」。  
- 差分サイズが閾値を超えたときは、ファイル要約のしきい値を段階的に下げて**縮退**を試し、それでも収まらないときだけ中断します（`--strict-diff-guard` で従来の即中断に戻せます）。  
- PR の確認：レビュアーを起動する前に `gh pr view --json number,baseRefName` で PR の有無を調べ、**無いと分かったときだけ** stderr に警告します（実行は止めません）。  
  `gh` が無い、認証していない、ネットワークに繋がらないといった「分からない」場合は黙って続行します（リモートを持たない取り込み先を止めないため）。  
  `--no-pr-check` と `CROSS_REVIEW_NO_FETCH=1` で省けます。  
  この呼び出しは既定 base の解決（PR の base ブランチ）と**同じ 1 回**で、PR 番号は `comment` が出すコマンド例にも使われます。  
- レビュー出力の保存：往復を記録できたとき、レビュアーの出力とメタ情報を開始時のブランチ名から決めた `.cross-review/branch-<slug>-<hash>/round-<N>-*` へ保存します（後述「PR を共有ログにする」節）。旧形式の平置き出力は自動で読みません。  
- 既定 base の解決で使う fetch と `gh` の呼び出しは、環境変数 `CROSS_REVIEW_NO_FETCH=1` で省けます（オフライン作業向け）。  
- 引数解析、差分生成、プロンプト生成、観点解決、申し送り注入は `tests/cross-review.test.js`（vitest）が担保します。  
  このテストは**取り込み先では任意**で、vitest を使うときだけ同梱します（同梱しなくても engine の振る舞いは upstream のテストが担保）。

### agent-cockpit の経路設定（`route`）

`node tools/cross-review.js route` は agent-cockpit の `routing.json` から `review` の値を読み、`codex`、`claude`、`default` のいずれかを改行付きで stdout に出します。
`AGENT_COCKPIT_HOME` が空でなければそのディレクトリの `routing.json` を読み、空ならホームディレクトリの `.agent-cockpit/routing.json` を読みます。
`agents` と `review` の 2 キーがあり、両方が `default`、`codex`、`claude` のいずれかである場合だけ設定を有効とします。それ以外（BOM 付き JSON を含む）は何も通知せず `default` を出して終了コード 0 で終わります。
経路設定の正本は agent-cockpit の [経路設定の契約](https://github.com/ktysne/agent-cockpit/blob/main/docs/contracts/routing.md) です。
この読み取りが契約と一致することは、agent-cockpit の検証データを `tests/fixtures/agent-cockpit-routing/` に写して確かめています。
経路設定の読み取りに失敗した場合も `default` を出力します。
agent-cockpit が無い環境では設定ファイルが無いため `default` になり、従来のレビュー手順から変わりません。
このコマンドは状態ファイルやネットワークを使わず、ファイルも書きません。
レビュー実行のサブコマンドは、経路設定が `codex` のとき `claude` と `subagent` を、`claude` のとき `codex` をレビュアーにする起動を拒否します。
経路設定が `default` の場合と設定を読めない場合は、この拒否を行いません。
codex の起動後に終了コード 75 で出す代替プロンプトは、この判定の対象外です。
会話で別の指定があるときは `--override-route <理由>` または `--override-route=<理由>` を付けて実行でき、上書きした経路と理由は往復メタ情報と PR コメント本文に記録します。

### codex の起動は bridge（codex-agent.sh）を経由する

claude-codex-bridge を入れている環境では、codex を直接起動する代わりに bridge の起動スクリプトを経由します。  
モデル、推論 effort、認証ホーム（`CODEX_HOME`）を定義ファイル側で一元管理し、Claude Code のサブエージェント経由の Codex 起動と条件を揃えるためです。

bridge が `CODEX_AGENT_RUN` を空でない値で設定した Codex 実装担当からは、`route`、`state` の表示（`--mark` と `--reset` なし）、ヘルプ、引数エラーによる使い方表示だけを許可します。
レビュー実行（`codex` / `claude` / `subagent`。`--fix` を含む）、`state --mark`、`state --reset`、`dismiss`、`comment`、`artifacts` は終了コード 2 で拒否し、レビューは報告を受けたメインセッションが行います。

起動経路は次の順で決まります。

1. `--no-codex-agent` が付いていれば、解決せずに **codex を直接起動**します（従来の起動方法）。
2. スクリプトを **環境変数 `CROSS_REVIEW_CODEX_AGENT`（パス）→ `~/.claude/tools/codex-agent.sh`** の順に探します。  
   環境変数で指定したパスが見つからないときは、黙って既定パスへ落ちず stderr に警告を出します。
3. スクリプトが見つかったら、`bash <script> --describe <定義名> -C <cwd>` で実効設定を照会します。
   照会と起動の両方で、子プロセスの cwd にも同じ作業ディレクトリを指定します。
   bridge はプロジェクト側の定義を cwd で探すためです。
4. 終了コード 0、JSON、整数の `protocol: 1` を確認してから、応答の状態で起動可否を決めます。
5. 起動できるときは `bash <script> <定義名> -C <cwd>` で起動し、プロンプトを stdin で渡します。
   スクリプトが無ければ従来どおり codex を直接起動します。

定義名はレビューのみなら `codex-review`、`--fix` なら `codex-subagent` です。
`--codex-agent <name>` で明示した定義にも同じ検査を適用します。
`--fix` と `--codex-agent codex-review` の併用、および `--fix` 無しの `--codex-agent codex-subagent` は引数エラー（終了コード 2）です。

**公開照会の判定**：新経路では定義ファイルとスクリプト本文を解析しません。
`status: ok` なら、照会の `sandbox` がレビューのみでは `read-only`、`--fix` では `workspace-write` で、`approval_policy` が `never` のときだけ起動します。
食い違うときは照会値を表示し、定義の拒否として終了コード 2 で止まります。

- `status: disabled` で `reason: definition-not-found` なら、直接起動を選びます。
- `codex-disabled` または `model-unset` なら、bridge を起動せず終了コード 75 の代替プロンプトへ進みます。
- `invalid` と `unreadable`(リポジトリ側の定義が変えてはいけないキーを変えている場合を含む)は、定義の拒否として終了コード 2 で止まります。
- `codex-not-found` は終了コード 1 で止まります。
- 未知の reason と未知の status は、照会の失敗と同じく終了コード 1 で止まります。
  未知の status では `launch_exit` も表示します。
- どの場合も、応答の理由とメッセージを表示します。
  定義の拒否では、直接起動での迂回を案内しません。
- 照会成功後に定義が消えることがあります。
  利用者側の定義が照会時に存在したのに、起動した bridge が終了コード 3 を返した場合は、直接起動へ切り替えず終了コード 1 で止めます。

**照会の失敗**：照会は stdin を渡さず、stdout と stderr を分けて受け、15 秒で打ち切ります。
時間切れ、JSON でない応答、protocol の不一致、未知の終了コード、起動失敗では終了コード 1 で止めます。
無効化や拒否を迂回しないため、自動では直接起動しません。
直接起動を選ぶときは `--no-codex-agent` を指定します。
`bash` 自体が見つからない場合は、従来どおり直接起動します(Windows では `where.exe` で見つからない場合を含みます)。

**旧 bridge の互換処理**：終了コード 2、stdout が JSON でなく、stderr に「不明なオプション」と `--describe` の両方がある場合に限り、`legacyCodexAgentInvocation` で既存の判定を行います。
定義の無効化、モデル未設定、読取失敗、プロジェクト側の上書き制限、サンドボックス、スクリプト内の承認方針の検査は従来どおりです。
スクリプトに承認 never の指定が無い場合や本文を読めない場合は警告して直接起動し、サンドボックスの不一致などは終了コード 2 で止めます。
利用者側の定義が無くプロジェクト側だけがある場合は直接起動し、両方無ければ bridge に委ね、終了コード 3 なら直接起動へ切り替えます。

互換処理と本文解析は、最低対応版を claude-codex-bridge の commit `4a48688`（PR #170）以降に引き上げたら削除できます。
対応版では `bash codex-agent.sh --describe <名前>` が `protocol: 1` の JSON を返します。
接続試験の fixture とテストは上流だけに置き、雛形マニフェストには追加しません。

## 既定 base の解決と差分サイズのガード

レビュー差分のトークン消費を抑えるための仕組みです。

### 状態ファイル（`.cross-review-state.json`）

往復回数、直前レビュー時の `HEAD`、非対応と判断した指摘、最後に判断した結論は、**ブランチごとに決まる値**です。  
会話の中だけで持つと、妥当性確認のたびに人が SHA を控え直し、往復回数を数え直すことになるので、Git 共通ディレクトリの `cross-review-state.json` に記録し、全 worktree で共有します。
見出しの `.cross-review-state.json` は旧版の保存先の名前で、リンクの宛先を変えないために残しています。

```json
{
  "branches": {
    "feat/example": {
      "round": 2,
      "lastReviewedSha": "abc123...",
      "dismissed": ["運用上到達しない入力への指摘"],
      "lastTriage": {
        "round": 2,
        "sha": "0123456789abcdef0123456789abcdef01234567",
        "outcome": "converged"
      }
    }
  }
}
```

- 置き場は checkout のルートを cwd にした `git rev-parse --path-format=absolute --git-common-dir` の下の `cross-review-state.json` です。Git が使えなければ旧位置を使い、`CROSS_REVIEW_STATE_DIR` で保存ディレクトリを指定できます。旧ファイルは書き込み可能なコマンドで統合します。詳細は [状態ファイルの契約](contracts/cross-review-state.md) を参照してください。
- `comment --outcome` は往復のレビュー記録が足りなければ停止します。記録を確認してから再実行し、意図した記録なら `--allow-round-mismatch` を付けます。
- **リポジトリの作業ツリーには作りません**（Git の共通ディレクトリの中なので追跡されません）。ローカルの作業状態であり、取り込み先のマニフェスト同期と衝突させないためです。`.gitignore` の `.cross-review-state.json` は、旧版と取り込み前の旧ファイルのために残します。
- ブランチ名は `git rev-parse --abbrev-ref HEAD`（detached HEAD では `HEAD`）。ブランチ名を取れない場合は読み書きしません。
- `round` は **レビューの成立を確かめられたときだけ** 1 増えます。増えるのは次の 3 つです。
  1. `subagent` がプロンプトを stdout に出力したとき（明示的に選んだ経路なので、その場でサブエージェントへ渡す前提で数えます）。
  2. レビュアー CLI が終了コード 0 で終わったとき（bridge 未導入で直接起動へやり直した場合は、やり直した後の結果で 1 回だけ数えます）。
  3. `node tools/cross-review.js state --mark` を実行したとき（下記）。
  差分なし、ガードによる中断、引数エラーに加え、**CLI の起動失敗（`ENOENT` 等）や非ゼロ終了でも増えません**（失敗時の `HEAD` を `lastReviewedSha` に残すと、次回の既定 base がそこになり「差分なし」で再試行できなくなるため）。
  **GPT 側使用不能のフォールバック（代替プロンプトの書き出し）でも増えません。** CLI はサブエージェントがレビューを終えたかを観測できないので、書き出した時点で数えると、プロンプトを渡さずに再実行したとき未レビューの差分が「差分なし」になって再試行できなくなります。状態を使える場合は次の往復の subagent メタ情報を保存し、レビュー後に `state --mark` で記録してから `comment --round <N> --outcome <値>` で結論を残せます。
- 書き込みは必ず**書く直前に読み直した状態**を基にします（read-modify-write）。レビュアーの実行中に別プロセスが `dismiss` や別ブランチのレビュー完了を書いていることがあり、起動前に読んだスナップショットで上書きするとその更新が消えるためです。読み直しで JSON が壊れていたときは、警告して記録しません。
- `lastReviewedSha` はその実行時点の `HEAD` です。`--uncommitted` では**更新しません**（作業ツリー差分は「この SHA 以降の増分」の意味を持たないため）。`round` は増えます。
- `lastTriage` は最後に判断した結論で、未記録なら `null` です。
  `round` は結論を判断した往復番号、`sha` は記録時の `HEAD`(40 桁か 64 桁の完全な SHA を小文字で持つ)、`outcome` は `fixing` / `converged` / `halted` のいずれかです。
  旧形式で項目が無い状態も読み込めます。
  記録済みより古い往復の結論は記録しません(同じ往復の記録し直しはできます)。
- 結論は `comment --round <N> --outcome <値>` で記録します。
  本文を書けた後に記録し、`--post` 付きなら投稿成功後に記録します。
  本文を作れない経路では状態を変更せず、`--outcome` を省略したときも状態ファイルを読み書きしません。
  `--outcome` を省略して本文を生成できたときは、結論を記録していない旨を stderr に警告します。終了コードは変えません(下書きの作り直しなど、結論を記録しない使い方もあるため)。
- `converged` は、追跡ファイルに未コミット変更があるか `git status` を取得できないと本文生成前に終了コード 1 で止まり、状態も投稿も変更しません。投稿する場合も記録直前に再確認します。
  意図して記録する場合は `--allow-dirty` を付けます。この場合は記録後に SHA に含まれない変更を警告します。
- 読み手は `lastTriage` が無い、または `round > lastTriage.round` なら、その往復の結論待ち(レビュー中か、結果の判断待ち)と判断します。
  `codex` と `claude` の経路はレビュアーが終わってから `round` を進めるので、レビューの実行中は `round == lastTriage.round` のまま前の往復の結論が見えます。
  `outcome: "fixing"` は修正対応中、`outcome: "halted"` は開発者の判断待ちです。
  `outcome: "converged"` かつ `sha` が現在の `HEAD` と一致するときだけ、その head で収束した状態です。
- JSON が壊れているときは、**警告して無視し、書き戻しもしません**（既存の記録を上書きで消さないため）。
- `--no-state` で読み書きを丸ごと無効化できます（CI など、状態を持たせたくない実行向け）。

```bash
node tools/cross-review.js state             # 現在の枝の round / lastReviewedSha / dismissed / lastTriage を JSON で表示
node tools/cross-review.js state --reset     # 現在の枝の記録を消す（他の枝は残る）
node tools/cross-review.js state --mark      # 往復を 1 回分記録する（round を 1 増やし、lastReviewedSha を現在の HEAD にする）
node tools/cross-review.js state --mark --uncommitted   # 同上だが lastReviewedSha は据え置く（--uncommitted のレビュー後に使う）
node tools/cross-review.js dismiss "運用上到達しない入力への指摘"   # 非対応と判断した指摘を記録
```

`state --mark` は、**CLI がレビューの成立を観測できない経路**（GPT 側使用不能のフォールバックプロンプトを客観サブエージェントへ渡した場合など）で、レビューを終えた後に往復を進めるための入口です。  
`--reset` とは併用できません（記録を消すのと往復を進めるのは相反するため）。`--no-state` とも併用できません。

`dismissed` が 1 件以上あると、レビュープロンプトの**観点と申し送りの後ろ**に「前回までに非対応と判断した指摘（再指摘しない）」の節が自動で添えられます。  
往復のたびに同じ指摘を差し戻す手間を無くすためです（新しい根拠があるときは根拠を示して指摘してよい、と枠付けしてあります）。

### 既定 base の解決順

既定（`--base` 未指定、コミット済み差分モード）では、base を次の順で解決します。前の段ほど差分が小さく、かつ人の指定なしで決まります。

1. **状態ファイルの `lastReviewedSha`**。`git cat-file -e <sha>^{commit}` で現存を確かめ、使えれば base にします（stderr に「前回レビュー時の `<短縮 SHA>` を使用します（往復 N 回目）」と出ます）。  
   rebase や amend で SHA が消えていれば次へ進みます。これで**妥当性確認が自動的に増分差分**になります。
2. **PR の base ブランチ**。`gh pr view --json baseRefName -q .baseRefName` が名前を返し、`origin/<name>` が `git rev-parse --verify` できればそれを使います（fetch は `origin/main` と同じくベストエフォート）。  
   スタック PR（親 PR のブランチから切った枝）で親 PR の差分まで混ざるのを防ぎます。`gh` が無い、PR が無い、失敗したときは黙って次へ進みます。
3. **`origin/main`**。`git fetch origin main --quiet` をベストエフォートで実行（10 秒タイムアウト）し、`git rev-parse --verify origin/main` が通れば採用します。  
   fetch に失敗したときは、**使う参照とその最終コミット日時**（`git log -1 --format=%ci`）を添えて警告します（stale な比較に気づけるように）。
4. 解決できなければ従来どおりローカル `main` を使います。

決めた base と**どの方法で決めたか**は、差分サイズと同じ 1 行に必ず出ます。

```
[cross-review] base: origin/develop (PR の base) / レビュー差分サイズ: 12.3KB
```

`--base` を明示したとき、および `--uncommitted` のときは、この解決を**スキップ**します（fetch も `gh` も呼びません）。指定した base / 未コミット差分には介入しません。  
環境変数 **`CROSS_REVIEW_NO_FETCH=1`** で fetch と `gh` の呼び出しを省けます（オフライン作業でタイムアウトを待たされないため）。

**stale なローカル `main` の落とし穴**：ローカル `main` が古いと merge-base が過去にずれ、HEAD が既に取り込んだ `main` 側のコミットまで `git diff main...HEAD` に混入します（実例：89 コミット、792KB に肥大。`git fetch origin main` + `--base origin/main` で 65KB に正常化）。上の優先解決はこれを自動で避けるための既定挙動です。

### 収束の後に base を取り込んだとき（`--merge-resolution`）

収束を記録した後に base（PR の base ブランチ）を取り込む merge を足すと、既定 base の解決（`lastReviewedSha`）では、取り込んだ base 側の変更がすべて次の往復の差分に入ります。  
取り込みで新しく入る判断は、競合を解いた部分だけです。base 側の変更は、それぞれの PR でレビューを経ています。  
`--merge-resolution` は、その解消の差分だけをレビューに送ります。

```bash
npm run review:codex -- --merge-resolution
node tools/cross-review.js subagent --merge-resolution
```

**使える条件**

- 状態ファイルのそのブランチに `lastReviewedSha` があること。
- HEAD から第 1 親をたどって `lastReviewedSha` にちょうど着き、その間のコミットがすべて merge であること。
- 各 merge の第 2 親以降が、PR の base から到達できること（`git merge-base --is-ancestor <第 2 親> <base>`）。base は既定 base の解決の「PR の base → `origin/main` → ローカル `main`」と同じ順で決めます（`lastReviewedSha` の段は使いません）。
- git が `git show --remerge-diff` に対応していること（git 2.36 以上）。

条件に合わないときは、理由と「通常のレビュー（`--merge-resolution` を外して実行）」の案内を stderr に出し、終了コード 1 で止まります。  
`--uncommitted`、`--base`、`--no-state` とは併用できません。

**差分と記録**

- 鎖の各 merge について `git show --remerge-diff` を古い順に取り、つなげて 1 つの差分にします。差分ガード、除外の規則、差分サイズの表示は通常のレビューと同じです。
- どの merge にも競合の解消が無いときは、「競合の解消は無いので、レビューは不要」と出し、往復を数えず、状態ファイルも変えずに終了コード 0 で終わります。
- 解消の差分のレビューは通常と同じく 1 往復として数え、`lastReviewedSha` を HEAD にします。これで `comment --outcome converged` を今の HEAD の結論として記録できます。
- メタ情報（`round-<N>-<reviewer>.json`）に `mergeResolution.merges`（対象の merge の SHA、古い順）を残し、`base.source` は `merge-resolution` になります。
- PR コメントの見出しは「クロスレビュー N 往復目(競合の解消のレビュー): …」、要約行の base の部分は「対象: 競合の解消の差分 (merge <短縮 SHA> ほか)」になります。
- `--merge-resolution` なしで、既定 base が前回レビュー SHA になった実行が上の条件に合う head だったときは、stderr に `--merge-resolution` を使える旨を 1 行出します（通常のレビューはそのまま続きます。判定に失敗したときは黙って無視します）。

**収束の後の扱い**

| 状況 | 扱い |
|---|---|
| 競合が無い取り込み | 何も記録しなくてよい。agent-cockpit は取り込みだけの head を収束の引き継ぎとして扱い、札は「収束 `<C>` の後に base を取り込み(競合なし)」でマージの条件を満たす（agent-cockpit#718）。ただし「収束後マージ」の予約は収束を記録した head の SHA で照合するので、取り込みの後の head では予約マージは動かず、開発者が手でマージする。agent-cockpit を使わないときは、PR のコメントに取り込みを記録する |
| 競合を解いた取り込み | `--merge-resolution` で解消の差分をレビューし、`comment --outcome` で結論を記録する。agent-cockpit の札は「競合の解消の確認待ち」になり、今の head の収束を記録すれば通常の収束になる。レビューを省くなら `cockpit_skip_review` を記録する |
| merge でないコミットを足した / base 以外から取り込んだ | `--merge-resolution` を付けず、通常のレビューを回す |

`--base` に取り込んだ main の SHA を渡す回避策は使いません。merge の解き方が差分に正しく現れないためです。

### 差分サイズの表示とガード（超過時は段階的に縮退する）

- レビュー差分の収集後、サイズを**常に stderr に 1 行表示**します（base とその解決方法を同じ行に出します）。
- 閾値の解決順は **`--max-diff-kb <n>`（CLI フラグ）→ 環境変数 `CROSS_REVIEW_MAX_DIFF_KB` → 既定 256KB** です。  
  値 `0` で**ガードを無効化**します（意図的に大きい差分をレビューしたいとき）。
- 閾値を超えたら、**即中断せずに段階的縮退**を試します。ファイル単位の要約しきい値（`--max-file-diff-kb`、既定 64KB）を **32KB → 16KB → 8KB** の順に下げて要約を掛け直し、閾値以下に収まった段階で続行します。  
  再計算は収集済みの差分本文に対して行うので、**git は再実行しません**。どの閾値で何件を要約に置き換えたかは stderr に出ます。
- それでも収まらないときだけ、**レビュアーを起動せず中断**します（`subagent` でもプロンプトを出しません。`process.exitCode = 1`）。  
  エラーメッセージには、試した閾値と、原因の候補（stale な `main`、生成物 / lock ファイルの混入）、回避策を出します。
- **`--strict-diff-guard`** で縮退を試さず従来どおり即中断に戻せます。`--max-file-diff-kb 0`（要約無効）のときも縮退は行いません。

閾値をわずかに超えただけで中断すると、`--max-diff-kb 512` を付けて再実行することになり、差分収集を二重に行います。巨大なファイル差分はレビュー価値が低く、要約に置き換えても指摘の質は下がりにくいので、先に縮退を試します。

```bash
node tools/cross-review.js codex --max-diff-kb 512      # 上限を 512KB に引き上げる
node tools/cross-review.js codex --max-diff-kb 0        # ガードを無効化
node tools/cross-review.js codex --strict-diff-guard    # 縮退せず従来どおり即中断
CROSS_REVIEW_MAX_DIFF_KB=512 npm run review:codex       # 環境変数で指定
```

### 差分の除外と要約（レビュー価値の低い差分でトークンを浪費しない）

レビュー価値が低い差分（ロックファイル、生成物）や、巨大すぎて読まないファイル差分を、レビュアーへ渡す前に間引きます。

**既定除外（ロックファイル、生成物）**：次のファイルは、差分本文から既定で除外します（ファイル名のみのパターンで、どの階層でも一致します）。

```
package-lock.json / npm-shrinkwrap.json / yarn.lock / pnpm-lock.yaml /
bun.lock / bun.lockb / Cargo.lock / Gemfile.lock / poetry.lock / uv.lock /
composer.lock / go.sum / *.min.js / *.min.css / *.map
```

除外は `git diff` のパススペック（`:(exclude,glob,top)**/<pattern>`、include 側は repo ルート `:/`）で適用するので、サブディレクトリの同名ファイルにも効き、cwd がリポ直下でなくても差分スコープは変わりません。  
**除外したが変更のあったファイルは、ファイル名だけプロンプトに残します**（`【レビュー対象外（除外済み）の変更ファイル】` の枠）。レビュアーが必要と判断すれば個別に読めます（差分本文は載りません）。

**追加の除外（`.cross-review-ignore`）**：既定除外に足したいパターンは `.cross-review-ignore` に書きます。  
形式は **1 行 1 パターン、`#` 始まりはコメント、空行は無視**。観点（`.cross-review.md`）と同じ流儀で、`環境変数 CROSS_REVIEW_IGNORE（パス）→ <cwd>/.cross-review-ignore → <スクリプト>/../.cross-review-ignore` の順に探し、見つかった最初の 1 つを読みます（既定パターンと併合）。  
`CROSS_REVIEW_IGNORE` を指定したのに読めないときは、黙って次へ進まず警告を出します。

```text
# .cross-review-ignore の例（既定パターンに追加される）
docs/generated/*.md
*.snap
schema.sql
```

**すべての除外を無効化（`--no-exclude`）**：既定除外も含めてすべての除外を切ります（緊急時の逃げ道。生成物もまとめてレビューしたいとき）。

**巨大ファイル差分の stat 置換（`--max-file-diff-kb`）**：ファイル単位の差分がしきい値（KB）を超えたら、本文を **1 行の stat 要約**（`diff --git` 行＋「<X.X>KB・追加 n 行 / 削除 m 行のため本文を省略」）に置き換えます。  
置換は全体サイズガードの**前**に行うので、置換で縮んだ分は全体ガードに掛かりません（巨大 1 ファイルが置換で縮めばガードを通ります）。置換が起きたら stderr に 1 行通知します。  
しきい値の解決順は **`--max-file-diff-kb <n>`（CLI フラグ）→ 環境変数 `CROSS_REVIEW_MAX_FILE_DIFF_KB` → 既定 64KB**。値 `0` で置換を無効化します。

```bash
node tools/cross-review.js codex --max-file-diff-kb 128  # ファイル単位の置換しきい値を 128KB に
node tools/cross-review.js codex --max-file-diff-kb 0    # stat 置換を無効化
node tools/cross-review.js codex --no-exclude            # 既定除外も含めすべての除外を無効化
```

### 妥当性確認を軽くする（往復のトークンを線形に増やさない）

指摘対応後の妥当性確認で、毎回**全差分**を再送するとトークンが往復ごとに膨らみます。  
レビュー時点の HEAD を base にして、**前回レビュー以降の増分差分だけ**を送ると線形増加を避けられます。

これは**状態ファイルで自動化されています**。1 回目のレビューで `lastReviewedSha` が記録されるので、2 回目以降は `--base` を付けずにそのまま実行すれば増分差分になります。

```bash
node tools/cross-review.js codex --instructions <指摘ファイル>   # 2 回目以降は自動で増分差分
```

手で base を指定したいとき（状態ファイルを使わない、別の起点から見たい）は従来どおり `--base` が効きます。  
`--base` はブランチ名に限らず**任意のコミット**を受けます。

```bash
git rev-parse HEAD                                                  # レビュー前に SHA を控える
node tools/cross-review.js <reviewer> --base <そのSHA> --instructions <指摘ファイル>
```

## 入口と本体

新形式の導入先には、本体を呼ぶ入口だけを `tools/cross-review.js` として置きます。
上流の配布元は `tools/cross-review.entry.js` です。
同期の雛形は、この入口、`templates/cloud-skill/SKILL.md`、`templates/docs/cross-review.md` の3件を配ります。
クラウド向けの SKILL は導入先の `.claude/skills/cross-review/SKILL.md`、手順書の案内版は `docs/cross-review.md` に置きます。
ローカル向けの全手順は上流の `.claude/skills/cross-review/SKILL.md` を `--global-skill` でホームへ配ります。

入口は次の順で本体を探します。

1. 環境変数 `CROSS_REVIEW_ENGINE` の指す checkout。
2. `~/.cross-review/engine.json` の `{ "checkout": "<絶対パス>" }` が指す checkout。
3. マニフェストの `upstream.repo` と `upstream.ref` を shallow fetch したキャッシュ。

環境変数が外れている場合や、登録ファイルを読めない、登録先を使えない場合はエラーで止まります。
登録ファイルが無い場合だけキャッシュへ進みます。
checkout の経路ではマニフェストの `upstream.ref` は本体の選択に使わず、main 以外ならその旨を警告します。
登録した checkout が既定のブランチ以外、または未コミットの変更を含む場合も警告して続行します。
開発には別の worktree を使い、登録した checkout は main に保ちます。

### 本体の登録と照会

上流の checkout で次を実行します。

```bash
node tools/cross-review.sync-all.js --register
node tools/cross-review.sync-all.js --register --check
node tools/cross-review.sync-all.js --register --check --json
```

`--register` は実行した checkout の絶対パスをホームの登録ファイルに書きます。
linked worktree の登録は警告します。
照会は実行した checkout ではなく、登録ファイルが指す checkout を調べます。
`--register --check --json` の形は次のとおりです。

```json
{
  "schemaVersion": 1,
  "subject": "register",
  "result": "clean",
  "registry": { "path": "<登録ファイルの絶対パス>", "exists": true, "error": null },
  "checkout": {
    "path": "<登録した checkout のパス>",
    "exists": true,
    "engine": { "path": "<checkout>/tools/cross-review.js", "state": "ok", "entryProtocol": { "min": 1, "max": 1 } },
    "head": { "branch": "main", "sha": "<40桁>", "defaultBranch": "main", "onDefaultBranch": true },
    "dirty": false
  },
  "issues": []
}
```

登録が無いときは `registry.exists: false`、`checkout: null`、`result: clean`、`issues: []` です。
登録ファイルが読めない、不正な JSON、checkout が絶対パスの文字列でない場合は `registry.error` に理由を入れ、`checkout: null`、`result: error` です。
checkout が無い場合は `exists: false`、`engine: null` とし、読めた項目だけ埋め、分からない項目は null にします。
`engine.state` は ok / missing（本体無し）/ unloadable（require の失敗、時間切れ、不正な出力）/ no-protocol（照合用 export 無し）です。
export が無ければ `entryProtocol` は null です。
既定のブランチは `origin/HEAD` から読み、取れなければ main とします。
detached HEAD は `branch: null`、`onDefaultBranch: false` です。
未追跡を含む `git status --porcelain` の出力が空でなければ dirty です。
HEAD の SHA、ブランチ、status の取得に失敗した場合、該当項目（ブランチの場合は onDefaultBranch も）は null とし、git-failed を報告します。

| issues の code | 条件 |
|---|---|
| registry-unreadable | 登録ファイルを解釈できない |
| checkout-missing | 登録先が無い |
| engine-missing | 本体が無い |
| engine-unloadable | 本体を読み込めない |
| protocol-export-missing | 照合用 export が無い |
| git-failed | SHA、ブランチ、status の取得失敗 |
| not-on-default-branch | 既定のブランチ以外または detached |
| dirty | 未コミットの変更あり |

issues は該当する `{ "code": "...", "message": "日本語の理由" }` をすべて並べます。
登録無しと正常な登録先は clean（終了コード0）、既定のブランチ以外や dirty は drift（1）、登録先が使えない場合は error（3）です。
error は drift より優先します。
引数エラーは2で、`--json` は `--register --check` 単独（または既存の `--global-skill --check` 単独）でだけ受け付けます。
0、1、3のいずれでも stdout は JSON 1個だけで、案内や警告は stderr に出ます。
引数エラーでは JSON を出しません。
JSON を指定しない照会は、人向けの表示で同じ終了コードを返します。

### キャッシュと版の照合

キャッシュのルートは `XDG_CACHE_HOME/ai-cross-review`、Windows の `LOCALAPPDATA/ai-cross-review`、`~/.cache/ai-cross-review`、一時ディレクトリの `ai-cross-review` の順で選びます。
解決したコミットごとに `engines/<SHA>` へ取得し、取得時は SHA を stderr に1行出します。
ブランチやタグは通常毎回問い合わせ、`refs.json` に repo と ref ごとの最後の SHA を記録します。
`CROSS_REVIEW_NO_FETCH=1` またはネットワークの失敗時は、最後の SHA のキャッシュだけを使い、無ければ明示のエラーで止まります。
40桁の SHA を指定した場合は問い合わせを省き、その SHA を使います。
使用中の本体と記録された最新 SHA のキャッシュを残し、不要なキャッシュは本体の起動時に整理します。

入口は整数の `ENTRY_PROTOCOL` を本体に渡し、本体が `ENTRY_PROTOCOL_RANGE` の範囲と照合します。
対応外なら、古い側の checkout または入口を更新する案内を出し、終了コード2で止まります。
照合用 export が無い古い本体も終了コード2です。

### 導入先での sync と engine

`node tools/cross-review.js sync` は本体側の同期処理を、導入先のルートと `tools/cross-review.sync.json` を指定して呼びます。
`--check`、`--dry-run`、`--check-manifest`、`--ref` を使えますが、`--root` と `--manifest` は指定できません。
成功は0、ドリフトは1、引数やマニフェストの誤りは2、上流の取得や同期プランの算出に失敗して確かめられなかった場合は3です。
`node tools/cross-review.js engine` は使用中の本体を JSON で表示し、成功時は0です。
JSON は schemaVersion、subject（engine）、engineSource（env / registry / cache）、enginePath、checkout、entryProtocol、acceptedEntryProtocol、projectRoot を持ちます。
どちらも入口専用のサブコマンドで、旧形式の本体の写しから呼ぶと終了コード2です。

### 旧形式との共存とマニフェスト検査

旧形式は本体と同期スクリプトの写しで動き、新形式が使う checkout とは独立しています。
新しい本体を旧形式の同期スクリプトで取り込んでも、従来の projectRoot を渡さない使い方を維持します。
`files[]` に from が `tools/cross-review.sync.js` の項目が無く、to が `tools/cross-review.js` の項目の from が `tools/cross-review.entry.js` の場合を新形式と判定します。
マニフェストに版のフィールドはありません。

同じ to が複数ある場合は、同期、check、dry-run、check-manifest のすべてで、何も書かず終了コード2で止まります。
比較はバックスラッシュをスラッシュへそろえ、POSIX のパス正規化を行い、先頭の ./ と末尾の / を除き、Windows では大文字と小文字を区別しません。
エラーには重なる to と files の添字を表示します。
旧形式の files に入口だけを足すとこの重複になるため、エラーではその項目を files から外すよう案内します。新形式へは `node <checkout>/tools/cross-review.sync-all.js --migrate --root <導入先>` でまとめて移行します。

旧形式の check-manifest は新形式専用の3配布物を未登録に数えず、files に足さずまとめて移行するよう案内します。
戻り値の legacyForm でも区別でき、一括検査の集計にも案内を残します。
旧形式の古い除外の警告を抑える from は次の一覧だけです。

- `tools/cross-review.js`
- `tools/cross-review.sync.js`
- `tools/cross-review.sync-all.js`
- `docs/cross-review.md`
- `.cross-review.example.md`
- `.claude/skills/cross-review/SKILL.md`
- `tests/cross-review.test.js`
- `tests/cross-review.sync.test.js`
- `tests/cross-review.sync-all.test.js`

一覧に無い除外（例 removed/file.js）は、旧形式でも今までどおり警告します。
新形式では通常の未登録と古い除外の検査を使います。

## 同期スクリプト（tools/cross-review.sync.js）

以下は旧形式の同期スクリプトの写しを使う場合の説明です。
新形式では同じオプションを `node tools/cross-review.js sync` に渡します。

「そのままコピーするファイル」（CLI 本体、この手順書、観点テンプレート、テスト等）を、上流リポジトリから取り込み先プロジェクトへ取り込むスクリプトです。  
手で 1 ファイルずつ上書きコピーする代わりに、マニフェストに従って機械的に同期します（手動コピー運用の置き換え）。  
依存の追加はありません（Node 標準 API のみ、CommonJS）。git だけで取り込み元を取得します。

- **取り込み元の取得**：`upstream.repo` の `upstream.ref`（ブランチ / タグ / コミット）を一時ディレクトリへ **shallow fetch**（`git init` → `git fetch --depth 1 origin <ref>` → `checkout FETCH_HEAD`）し、そこからファイルをコピーします。SHA 直接指定も拾えるよう `clone --branch` ではなく `fetch <ref>` を使います。一時ディレクトリは実行後に削除します。
- **取り込むファイルの対応付け**：`files[]` の `from`（上流相対）→ `to`（取り込み先相対）で対応付けます。取り込み先の配置が上流と違っても対応できます（例：テストを `tests/tools/` 配下に置く）。**ファイル単位のみ**で、`from` にディレクトリを指定した一括コピーは非対応です。
- **require パス等の機械置換**：`files[].replace`（`{ from, to }` の配列）で**文字列リテラルの全置換**を行います（正規表現ではない）。コピーしたテストの require パスを取り込み先の配置へ合わせる用途です。上流側は書き換えません。
- **取り込み元の記録**：取り込んだ実コミットを `lastSyncedCommit`（と `lastSyncedRef`）へ書き戻します（記録値が変わるときだけ。同一コミットの再同期では書き換えません）。どのコミットから取り込んだかが履歴に残り、検査の基準にもなります。
- **行末の扱い**：上流は利用者の `core.autocrlf` に左右されずに取り出し、行末をそろえてから比べます（行末だけの違いはドリフトにしません）。取り込むファイルと書き戻すマニフェストは、取り込み先の既存のファイルが CRLF を含めば CRLF、それ以外（新規を含む）は LF で書きます。
- **移行ノートの表示**：上流の `docs/migrations/*.md` のうち、まだ見せていないものを stderr へ全文表示します（後述「移行ノート」）。同期では直せない取り込み先側の作業を人が取りこぼさないようにするためです。
- **古い `comment` の手順の検査**：取り込み先の `CLAUDE.md` / `AGENTS.md` に、`cross-review.js comment --round` を含みながら `--outcome` の無い行、または旧平置きの判断ファイル `.cross-review/round-<N>-triage.md` のパスを含む行があれば、ファイル名と行番号を stderr に出します（同期、`--check`、`--dry-run` のどれでも）。書き換えはせず、終了コードにも影響しません。直し方は移行ノート `2026-10-comment-outcome.md` にあります。
- **モード**：
  - 既定（同期）：差分のあるファイルだけ上書きし、取り込み元コミットが変わったときだけマニフェストの `lastSyncedCommit` を更新する。
  - `--check`：書き込まず、上流（ref）との差分（ドリフト）だけを報告する。差分があれば **exit 1**（CI のドリフト検知向け）。
  - `--dry-run`：書き込まず、同期で何が変わるかだけ表示する。
- **マニフェスト検査**：`--check-manifest` は、上流の雛形 `tools/cross-review.sync.example.json`（配布物一式の正本）と取り込み先の `files[]` / `excludedFiles[]` を `from` で照合し、未登録の配布物を列挙します。`excludedFiles` は任意の配列で、値には `files[].from` と同じ上流相対パスを指定します。上流の雛形に存在する除外は未登録に数えず、未登録 0 件の出力には除外件数を添えます。上流の雛形にない除外は `[cross-review]` で始まる警告を stderr に出します。未登録と古い除外はドリフトではないため **exit 1 にしません**。検査はマニフェストを書き換えず、列挙するだけなので **`--check` を含意**し、単独指定でも書き込みは起きません（`sync --check-manifest` と `sync --check --check-manifest` は同じ挙動。ドリフトがあれば `--check` と同じく exit 1）。上流に雛形が無い、読めない、または**構造が不正**（`files[]` が配列でない、`from` を持つエントリが 1 つも無い）ときは警告して検査だけスキップします（突き合わせる相手が無いまま「未登録なし」と誤報しないため）。
- **そのほかのオプション**：`--ref <ref>`（マニフェストの ref を上書き）/ `--manifest <path>`（マニフェストの場所。既定はスクリプト隣の `cross-review.sync.json`）/ `--root <path>`（取り込み先ルート。既定は `tools/` の 1 つ上 = プロジェクトルート。cwd に依存せず解決）。
- **安全策**：`from` / `to` が取り込み元 / 取り込み先ルートの外を指す場合はエラーにします（マニフェスト由来のパスでルート外へ読み書きする事故を防ぐ）。

マニフェスト（`tools/cross-review.sync.json`）の形：

```json
{
  "upstream": { "repo": "https://github.com/ktysne/ai-cross-review.git", "ref": "main" },
  "lastSyncedCommit": null,
  "shownMigrations": [],
  "excludedFiles": ["tests/cross-review.sync.test.js", "tests/cross-review.sync-all.test.js"],
  "files": [
    { "from": "tools/cross-review.js", "to": "tools/cross-review.js" },
    { "from": "tools/cross-review.sync.js", "to": "tools/cross-review.sync.js" },
    { "from": "tools/cross-review.sync-all.js", "to": "tools/cross-review.sync-all.js" },
    { "from": "docs/cross-review.md", "to": "docs/cross-review.md" },
    { "from": ".cross-review.example.md", "to": ".cross-review.example.md" },
    { "from": ".claude/skills/cross-review/SKILL.md", "to": ".claude/skills/cross-review/SKILL.md" },
    {
      "from": "tests/cross-review.test.js",
      "to": "tests/tools/cross-review.test.js",
      "replace": [{ "from": "../tools/cross-review.js", "to": "../../tools/cross-review.js" }]
    }
  ]
}
```

`excludedFiles` には、取り込み先の判断で意図して取り込まない配布物を指定します（例：テストの基盤が無いので vendored テストを取り込まない）。指定したパスが上流の雛形から無くなると、`--check-manifest` は古い除外として警告します。

上の `files` は旧形式の例です。
現在の `tools/cross-review.sync.example.json` は入口、クラウド向けの SKILL、手順書の案内版だけを配る新形式の正本です。  
このマニフェスト自体は**取り込み先で編集するファイル**です（上書きコピーの対象に含めない）。  
`.cross-review.md`（観点）や `CLAUDE.md` / `AGENTS.md` などプロジェクト固有のファイルは `files` に入れません（上書きで消えます）。

`.claude/skills/cross-review/SKILL.md`（相互レビューの実行手順スキル）も vendored（上書き更新の対象）です。  
スキルにはプロジェクト固有の運用（検証コマンド、CI、同期スクリプト名など）を書かず、それらは `.cross-review.md` や各リポの doc 側へ分離します。こうすると、上流のスキル更新が取り込み先のカスタマイズと干渉しません。

doc を HTML へ生成する（docs パイプラインを持つ）プロジェクトや、相互レビューの「入口 doc」を別に置きたいプロジェクトでは、`docs/cross-review.md` を `to` で自分のパスへ map し（例：`documents/developer/md/cross-review-flow.md`。これも vendored）、プロジェクト固有の運用は別の **overlay doc**（取り込み先が所有、編集）＋ `.cross-review.md` に分けます。overlay から vendored フロー doc へリンクすれば、汎用フローの再同期と固有運用の編集が干渉しません。同期はファイル内容を上書きするだけなので、`docs:build` 等の**生成は取り込み先の責務**です（再同期後に各自で実行）。

### 移行ノート（docs/migrations/）

同期はファイルを上書きするだけなので、取り込み先が自分で持つファイル（`.gitignore`、`package.json` の `scripts`、`CLAUDE.md` / `AGENTS.md` の節、`.cross-review.md`）は更新できません。  
上流の変更にこうした手作業が伴うときは、**移行ノート**を `docs/migrations/` に置きます。  
取り込み先が同期したときに、未読のノートだけが stderr へ全文表示されます。

**上流側の書き方**：`docs/migrations/<日付>-<内容>.md` に 1 件 1 ファイルで置きます。  
先頭に YAML 風のフロントマターで `since: <上流 SHA>`（そのノートを生んだ変更のコミット）を 1 行だけ書き、続けて本文を書きます。  
本文には「取り込み先で必要な作業」を箇条書きで並べ、vendored なファイル（CLI 本体、この手順書、SKILL、テスト）の更新は同期で済むので手作業は要らない旨も添えます。  
`since` は人がバージョンを追うための情報で、未読の判定には使いません（上流の取得は shallow fetch なので、SHA の祖先関係を判定できないため）。

```markdown
---
since: 035a746efba75fb4f2cbbff7f0d3576fef6575ab
---
# 実装完了時の 3 択とサーキットブレーカーの改訂

（何が変わったかの説明）

## 取り込み先で必要な作業
- CLAUDE.md / AGENTS.md の相互レビュー要約を新しい 3 択に合わせて書き換える。
- `.cross-review.md` に「指摘の出し方」4 項目を足す。
```

**取り込み先の更新手順**：`node tools/cross-review.js sync`（旧形式は `node tools/cross-review.sync.js`） で同期する → 表示された移行ノートの作業を行う → lint とテストを回す、の順です。  
ノートの作業は同期スクリプトが代行しないので、表示されたら必ず人が対応してください。  
移行ノートの表示は同期スクリプト自身の機能なので、この機能より前のバージョンから更新する初回だけは、取り込み先に残っている古いバージョンのスクリプトが動いてノートが出ません。  
そのときは同期をもう一度実行する（1 回目で新しいバージョンに置き換わり、2 回目で未読のノートが出ます）か、上流の checkout から `tools/cross-review.sync-all.js` を使ってください（この checkout の同期ロジックで回るため、初回からノートが出ます）。  
上流が新しい配布物を増やしていないかは `node tools/cross-review.sync.js --check-manifest` で確認できます（未登録のエントリを列挙し、古い除外を警告します。新形式では必要なものだけ `files[]` に足します。旧形式では新形式の配布物を足さず、まとめて移行してください）。

**未読の判定（`shownMigrations`）**：マニフェストの `shownMigrations` に、表示済みノートのファイル名を配列で記録します。  
記録に無いノートが未読です。記録は既存の値を保ったまま未読分を足すので、上流から消えたノートも再表示されません。  
初期化の規則は次の 3 つです。

- 初回同期（`lastSyncedCommit` が `null`）で記録が空：表示せず全件を記録する。新規導入先は雛形を最新から取るので、過去の移行作業は不要なためです。
- 同期実績があり（`lastSyncedCommit` が非 `null`）記録が無い：全件を未読として表示する。この機能より前から使っている取り込み先が、溜まっている作業を一度で受け取れるようにするためです。
- それ以外：記録に無いノートを表示し、記録に足す。

**モード別の挙動**：既定（同期）は表示して記録します。  
`--dry-run` は表示しますが記録しないので、同じノートが次の同期でもう一度出ます。  
`--check` は本文を出さず「未読の移行ノートが N 件あります（同期時に表示）」の 1 行だけを出します。未読ノートは上流とのドリフトではないので、**exit 1 にはしません**。

**そのほか**：上流に `docs/migrations/` が無い場合（移行ノートより前の ref）は何もしません。  
上流の置き場を変えているときは、マニフェストの `migrationsDir`（上流相対、既定 `docs/migrations`）で上書きできます。  
フロントマターを解釈できないノートは警告を出してそのノートだけスキップし、同期そのものは続けます。

## 複数プロジェクトへ一括反映（tools/cross-review.sync-all.js）

導入プロジェクトが増えると、上流を更新するたびに 1 リポずつ同期するのは手間です。  
`tools/cross-review.sync-all.js` は、ローカルの作業ルート（例：`/Develop`）配下を走査し、**同期マニフェスト `cross-review.sync.json` を持つディレクトリ＝導入プロジェクト**を自動判定して、まとめて同期します。

- **判定**：`cross-review.sync.json` の存在を単一マーカーにします（同期に必須のファイルなので誤検出しにくい）。慣例どおり `tools/cross-review.sync.json` に置かれている前提ですが、ルート直下に置かれていても拾います。
- **同期ロジック**：各プロジェクトに同梱された版ではなく、**この checkout の `cross-review.sync.js`（`runSync`）を再利用**して回します。導入先の sync スクリプトが古くても最新ロジックで一括反映できます。取り込むファイル、上流 ref は各プロジェクトのマニフェストを尊重します（`--ref` で一時上書き可）。
- **独立実行**：1 プロジェクトの失敗（マニフェスト不正、上流取得失敗など）で全体を止めません。各プロジェクトを独立に回し、最後に「更新 / 変更なし / ドリフト / エラー / 対象外」を集計します。終了コードは処理失敗や検査不能があれば **3**、`--check` でドリフトだけなら **1** です。
- **対象外（skip）**：`cross-review.sync.json` という名前でも、**valid JSON だが** 内容が `upstream` / `files` を持たないもの（旧 `{source, ref, commit}` 形式の独自 sync 来歴や、別用途でたまたま同名のファイル）は **同期対象外（対象外）** として skip し、エラーにはしません。`/Develop` に新旧の流儀が混在していても全体を失敗させないためです。
- **破損は skip せず error（exit 3）**：ファイルが **読めない（IO/権限エラー）/ JSON 構文エラー（破損）** の場合は、正式導入先の設定崩れなので対象外で握り潰さず **error** にし、終了コードを **3** にします（CI の `sync-all --check` で検出できるようにするため）。1 件の error でも他プロジェクトの同期は止めず、最後に集計します。
- **走査**：`--depth <n>`（既定 4）で最大深さを調整。`node_modules` / `.git` / 隠しディレクトリはたどりません。
- **移行ノート**：未読のノートがあったプロジェクトは、集計行の末尾に「（移行ノート N 件）」が付きます。本文は各プロジェクトの同期時に stderr へ出ますが、一括同期では流れて見落としやすいためです。
- **マニフェスト検査**：`--check` では各プロジェクトで `sync --check-manifest` も回し、未登録があったプロジェクトの集計行に「（マニフェスト未登録 N 件）」を付けます。一括検査は「取り込み先が上流に追いつけているか」を見る用途なので、ファイルのドリフトと配布物の取りこぼしを 1 回で拾います。未登録はドリフトではないので終了コードには含めません。検査が回らなかった（雛形が無い / 読めない / 構造が不正）プロジェクトには「（マニフェスト検査スキップ）」を付け、未登録 0 件の正常な検査と見分けられるようにします。
- **警告の引き上げ**：各プロジェクトの stderr はこのツールが捕捉するため、そのままでは `sync` の 1 行警告（雛形が無い、移行ノートを読めない等）が消えます。`[cross-review]` で始まる警告行は、そのプロジェクトの集計行の直後にインデントして出します（全モード共通）。未読の移行ノートの全文は長いので集計には出さず、件数だけを集計行に付けます。
- **グローバル SKILL の配布**：`--global-skill` は、この checkout の `.claude/skills/cross-review/SKILL.md` をホームの共通配置へ配ります（後述）。

```bash
node tools/cross-review.sync-all.js --root /Develop --list    # 検出したプロジェクトを列挙するだけ
node tools/cross-review.sync-all.js --root /Develop --check   # 各プロジェクトをドリフト検査 (書き込まない)
node tools/cross-review.sync-all.js --root /Develop --dry-run # 各プロジェクトで何が変わるかだけ表示
node tools/cross-review.sync-all.js --root /Develop           # 各プロジェクトを一括同期 (上書き更新)
node tools/cross-review.sync-all.js --root /Develop --ref v1.2.3  # 取り込む ref を全プロジェクト共通で上書き
node tools/cross-review.sync-all.js --global-skill             # グローバル SKILL だけを配る (走査しない)
```

### グローバル SKILL の配布（`--global-skill`）

相互レビューの汎用ルール（3 択、サーキットブレーカー、PR 運用）を各リポジトリの `CLAUDE.md` へ写して回ると、改訂のたびに全プロジェクトを書き換えることになります。  
`--global-skill` は、この checkout の `.claude/skills/cross-review/SKILL.md` をホームの共通配置へ配り、各リポジトリにはそのプロジェクト固有の事情だけを残せるようにします（残す内容は次節のテンプレート）。

配布先は次の 2 つです。
表中の `<home>` は OS のユーザーホームです。
各ホームの下の `skills/cross-review/SKILL.md` に配ります。

| id | ホームの解決規則 | 配布条件 | homeFrom |
|---|---|---|---|
| `claude` | `CLAUDE_CONFIG_DIR`、未設定なら `<home>/.claude` | ホーム自体が既にある | `CLAUDE_CONFIG_DIR` / `default` |
| `agents` | `<home>/.agents` 固定 | Codex のホームの `skills`、`<home>/.codex-subagent/skills`、配った写し（`<home>/.agents/skills/cross-review/SKILL.md`）のどれかがある | `fixed` |

Codex のホームは `CODEX_HOME`、未設定なら `<home>/.codex` です。
空文字の環境変数は未設定として扱い、相対パスは実行時の作業ディレクトリから絶対化します。
`~` は展開しません。
解決後の配布先パスが重複したときは、表の順で先の配布先だけを扱い、後の要素を「対象外」にします（Windows では大文字と小文字を区別しません）。
配布条件を調べられなければ `unreadable`、条件を満たさなければ `skipped` とし、対象外の理由を stderr に出します。
Codex を使う印があれば、`<home>/.agents/skills` が無くても作って配ります。

Codex 向けの写しは `CODEX_HOME` に関係なく `<home>/.agents/skills/cross-review/SKILL.md` にまとめます。
通常の Codex とサブエージェントが同じ写しを読みます。
[Codex の公式資料](https://developers.openai.com/codex/skills)で利用者の置き場は `$HOME/.agents/skills` です。
[Codex の host_roots.rs](https://github.com/openai/codex/blob/e1b9c9457ceca75a99b034a5df39ac48c3998d15/codex-rs/ext/skills/src/host_roots.rs#L95-L114)（2026-10-20 の main）は `$CODEX_HOME/skills` を「Deprecated user skills location, kept for backward compatibility」とし、`$HOME/.agents/skills` は `CODEX_HOME` と独立して追加します。
同じ name のスキルは統合されず両方が選択肢に出るため、旧配置の写しを片付けます。
bridge の定義ファイルは読みません。

旧配置（legacy）は次の 2 つです。
解決したパスが同じなら 1 件にまとめ、Windows では大文字と小文字を区別しません。
配布先（`claude` か `agents`）と実体が同じ旧配置は、旧配置として扱いません（`CODEX_HOME` を `<home>/.agents` にした場合や、`skills` をシンボリックリンクやジャンクションで共有した場合など）。削除すると、配ったばかりの写しを消すためです。
実体は、`SKILL.md` の親から見て存在する最も近いディレクトリを実体のパスへ解決し、ファイル名を足して比べます。
`SKILL.md` 自体のリンクは追いません（削除で消えるのはリンクだけなので、リンク先の旧配置も別に片付けます）。
ただし配布先の `SKILL.md` がリンクのときは、書き込みがリンク先へ届くので、リンク先の旧配置は消しません。実体を確かめられない旧配置は `removable: false` とし、`reason` に理由を入れます。

| id | ホーム | homeFrom |
|---|---|---|
| `codex-legacy` | `CODEX_HOME`、未設定なら `<home>/.codex` | `CODEX_HOME` / `default` |
| `codex-subagent-legacy` | `<home>/.codex-subagent` 固定 | `fixed` |

旧配置の `skills/cross-review/SKILL.md` は、存在するときだけ照会の `targets` に加わります。
読める旧配置は `state: legacy` とし、その内容がこの checkout の HEAD の Git 履歴にある正本のいずれかの版（ほかのブランチの版は含めません）、または現在の配布元と一致するときだけ `removable: true` にします。
この照合では CRLF を LF にそろえますが、`sha256` は観測したバイト列のハッシュです。
Git が使えない、履歴を集められない、内容が一致しない場合は `removable: false` とし、`reason` に理由を入れます。
読めない旧配置は `unreadable` です。

書き込みの実行では、正本を配った後に `removable: true` の旧配置の SKILL.md を削除し、空になった `cross-review` ディレクトリも削除します。
`skills` 自体や、別のファイルがある `cross-review` ディレクトリは残します。
`removable: false` の旧配置は削除せず、stderr に理由を警告します。
旧配置を残したことだけでは、書き込みの実行を失敗にしません。
利用者が編集した旧配置は、必要な内容を確認して手で片付けてください。

配布先と旧配置の状態は次の 6 種類です。
「古い」は更新時刻ではなく、正本と写しのバイト列が一致しないことを表します。
行末だけが違う写しも「古い」になります。
正本が端末の `core.autocrlf` で変わらないよう、`.gitattributes` で正本の SKILL を LF に固定しています。

| state | 表示名 | 判定 |
|---|---|---|
| `match` | 一致 | 正本とバイト一致 |
| `stale` | 古い | 読めるが正本とバイト不一致 |
| `missing` | 未配置 | 配布条件を満たすが写しが無い |
| `unreadable` | 読めない | 写し、または配布条件のディレクトリを権限などで調べられず比較できない |
| `skipped` | 対象外 | 配布条件を満たさない、または先の要素と同じパス |
| `legacy` | 旧配置 | 旧配置に読める SKILL.md が残っている |

- `--check` は書き込まず検査します。`stale` と `legacy` はドリフト、`unreadable` は検査不能です。`missing` はドリフトに数えません。
- `--dry-run` は書き込みも削除もせず、配布前の状態、配布予定、削除する旧配置、残す旧配置と理由を表示します。
- 書き込みモードは配布先の `missing`、`stale`、`unreadable` に正本を配ります。`unreadable` でも上書きに成功すればエラーにしません。
- `--root`（位置引数を含む）を付けなければ、プロジェクト走査をせずグローバル配布だけを行います。
- `--list` は同じホーム解決規則で配布先と対象外の理由を列挙します。
- 人向けの集計には `global:` の行が加わり、配布先ごとの検査時の状態が並びます。

一括同期の終了コードは、JSON の有無や `--root` の併用によらず次の意味です。

| 終了コード | 意味 |
|---|---|
| 0 | 差分なし、または処理成功。グローバル SKILL が未配置だけの場合も含む |
| 1 | `--check` でプロジェクトのドリフト、またはグローバル SKILL の `stale` または `legacy` がある |
| 2 | 引数エラー |
| 3 | 検査不能または処理失敗。配布元を読めない、`--check` の `unreadable`、配布先への書き込みや旧配置の削除の失敗、プロジェクトの error（マニフェスト破損、上流取得失敗など）、導入プロジェクトが見つからない場合 |

検査不能とドリフトが混在するときは、3 が 1 に優先します。

```bash
node tools/cross-review.sync-all.js --global-skill --list     # 配布先を列挙するだけ
node tools/cross-review.sync-all.js --global-skill --dry-run  # 配布予定を表示
node tools/cross-review.sync-all.js --global-skill --check    # 検査するだけ
node tools/cross-review.sync-all.js --global-skill --check --json
node tools/cross-review.sync-all.js --global-skill            # 配る
npm run sync:global                                           # = 上と同じ（このリポジトリの scripts）
```

グローバル SKILL の照会では、`--json` は `--global-skill --check` かつ `--root`（位置引数を含む）無しで受け付けます。
本体の登録の照会では、前述の `--register --check --json` を使います。
グローバル SKILL の `--json` は、`--check` 無し、`--root`、`--list`、`--dry-run` との併用では引数エラー（exit 2）です。
引数エラー以外では、配布元を読めない場合も必ず stdout に JSON だけを出し、末尾に改行を 1 つ付けます。
配布元の案内行や人向けの集計は出しませんが、対象外の警告は stderr に出ます。

JSON は次の形です（パスとハッシュは例示用の値です）。

```json
{
  "schemaVersion": 2,
  "result": "drift",
  "source": {
    "path": "/repo/.claude/skills/cross-review/SKILL.md",
    "sha256": "<正本のSHA-256 hex>",
    "error": null
  },
  "targets": [
    {
      "id": "claude",
      "path": "/home/u/.claude/skills/cross-review/SKILL.md",
      "home": "/home/u/.claude",
      "homeFrom": "default",
      "state": "match",
      "sha256": "<観測した写しのSHA-256 hex>",
      "sourcePath": "/repo/.claude/skills/cross-review/SKILL.md",
      "sourceSha256": "<正本のSHA-256 hex>",
      "reason": null
    },
    {
      "id": "agents",
      "path": "/home/u/.agents/skills/cross-review/SKILL.md",
      "home": "/home/u/.agents",
      "homeFrom": "fixed",
      "state": "match",
      "sha256": "<観測した写しのSHA-256 hex>",
      "sourcePath": "/repo/.claude/skills/cross-review/SKILL.md",
      "sourceSha256": "<正本のSHA-256 hex>",
      "reason": null
    },
    {
      "id": "codex-legacy",
      "path": "/home/u/.codex/skills/cross-review/SKILL.md",
      "home": "/home/u/.codex",
      "homeFrom": "default",
      "state": "legacy",
      "removable": true,
      "sha256": "<旧配置の写しのSHA-256 hex>",
      "sourcePath": "/repo/.claude/skills/cross-review/SKILL.md",
      "sourceSha256": "<正本のSHA-256 hex>",
      "reason": null
    }
  ]
}
```

- `source.path`、各 `path`、`home`、`sourcePath` は絶対パスです。
- `targets` は `claude`、`agents` の順で、存在する旧配置の項目がその後に表の順で加わります。各 `id` と `homeFrom` は表の値です。ただし配布元を読めない場合は空配列です。
- `source.sha256` は正本のバイト列の SHA-256 です。正本を読めない場合だけ null になり、`source.error` に理由が入ります。読めた場合の `source.error` は null です。
- 各 `sourcePath` と `sourceSha256` は常にトップの `source.path` と `source.sha256` と同値です。
- 各 `sha256` は `match` / `stale` / `legacy` なら観測した写しのハッシュ、`missing` / `unreadable` / `skipped` なら null です。
- `reason` は `skipped` / `unreadable`、または `legacy` で `removable: false` なら必ず文字列、それ以外は null です。重複の場合は「`<先の id> と同じパス`」です。
- `result` は正本を読めないか `unreadable` があれば `error`、それ以外で `stale` または `legacy` があれば `drift`、それ以外は `clean` です。終了コードはそれぞれ 3 / 1 / 0 です。
- `removable` は旧配置の項目だけにあり、削除できるときだけ true です。`unreadable` の旧配置では false です。

> 引数解析、プロジェクト走査、結果分類、集計、一括同期の配線は `tests/cross-review.sync-all.test.js`（vitest）が担保します（上流で検証し、新形式の導入先へは配りません）。

```bash
node tools/cross-review.js sync            # 上流から取り込む（差分のあるファイルだけ上書き）
node tools/cross-review.js sync --check    # ドリフト検査のみ（書き込まない。差分があれば exit 1）
node tools/cross-review.js sync --dry-run  # 何が変わるかだけ表示（書き込まない）
node tools/cross-review.js sync --ref v1.2.3   # 取り込むバージョンをマニフェストより優先
node tools/cross-review.js sync --check-manifest  # 未登録配布物と古い除外の確認（--check を含意。書き込まない）
```

> 取り込み元の取得は git のネットワークアクセスを使います。  
> サンドボックス内では fetch に失敗することがあるため、必要に応じてネットワークを許可して実行してください。  
> 引数解析、マニフェスト検証、置換、同期プラン算出、同期/検査の配線は `tests/cross-review.sync.test.js`（vitest）が担保します（上流で検証し、新形式の導入先へは配りません）。

### 旧形式からの一括移行

上流の checkout で次を実行します。
移行の前に差分を確認し、移行後は導入先の lint とテストを実行してください。
個別の手順は [移行ノート](migrations/2026-10-engine-entry.md) にあります。

```bash
node tools/cross-review.sync-all.js --migrate --dry-run --root /Develop
node tools/cross-review.sync-all.js --migrate --root /Develop
node tools/cross-review.sync-all.js --migrate --check --root /Develop
node tools/cross-review.sync-all.js --migrate --check --json --root /Develop
```

`--migrate` は走査ルートを必須とし、`--depth`、`--dry-run`、`--check`、`--json` と併用できます。
`--json` は `--check` と組み合わせる場合だけ指定できます。
`--dry-run` と `--check` の併用、および `--global-skill`、`--register`、`--list`、`--ref` との併用は引数エラーです。
ブランチ、コミット、PR は作りません。
新形式と対象外の導入先には何もせず、同じ導入先への 2 回目の実行も何もしません。

旧形式の本体、SKILL、手順書の `from` を、それぞれ入口、クラウド向けの SKILL、案内版へ変更します。
既存の `to` と `replace` は保ち、`.cross-review.example.md` と独自の項目も残します。
本体の `to` が `tools/cross-review.js` 以外の場合は、`custom-body-location` として移行しません。
マニフェストが `tools/cross-review.sync.json` 以外(導入先のルート直下など)にある場合は、`custom-manifest-location` として移行しません。
入口と `sync` サブコマンドは、この場所のマニフェストだけを読むためです。
SKILL の `to` が `.claude/skills/cross-review/SKILL.md` 以外の場合は項目をそのまま残し、クラウド向けの SKILL を雛形の配置へ足します。
同期スクリプトと上流テストの項目およびその写しを削除し、除外項目も同じ対応で変換します。
不足する新形式の配布物は雛形の配置で足しますが、SKILL と手順書を除外していた場合は足しません。
本体を除外している場合は移行できません。
`upstream.ref` を変更せず、その ref の入口と本体が互換であることを確認してから書き換えます。
`package.json` の scripts にある `node tools/cross-review.sync.js` は、引数を保って `node tools/cross-review.js sync` に置き換えます。
一括同期や削除するテストを呼ぶ scripts、独自の場所へ写した同期スクリプトを呼ぶ scripts、`--root` か `--manifest` を付けた同期の scripts は変更せず、「手で修正」として出力します。
`sync` サブコマンドは `--root` と `--manifest` を受け付けないためです。
マニフェストと `package.json` のインデント、行末、末尾の改行の有無を保ちます。
先に同期で入口、SKILL、案内版を書き、それが成功してからマニフェストと `package.json` を書き換えて、古い写しを消します。
同期が途中で失敗しても、マニフェストは旧形式のまま残るので、`--migrate --check` で見つかり、もう一度 `--migrate` を回せば続きから移行できます。
途中で書き込みが失敗した導入先はエラーとして報告し、次へ進みます。
途中の変更は自動では戻さないため、必要なら導入先の git の差分を確認して復旧してください。

`--migrate --check` は書き込まず、導入先ごとに形式と移行可否を照会します。
通常の `--check` は同期内容のドリフトを調べるため、旧形式のまま最新に同期した導入先を拾えません。
移行漏れの確認には `--migrate --check` を使います。
`--json` の stdout は、終了コード 0、1、3 のいずれでも次の形の JSON 1 個です。
引数エラー (終了コード 2) では JSON を出しません。
警告と案内は stderr に出します。

```json
{
  "schemaVersion": 1,
  "subject": "migrate",
  "result": "drift",
  "root": "/Develop",
  "projects": [
    {
      "root": "/Develop/app",
      "manifest": "/Develop/app/tools/cross-review.sync.json",
      "upstream": { "repo": "https://github.com/ktysne/ai-cross-review.git", "ref": "main" },
      "form": "legacy",
      "migratable": true,
      "reason": null,
      "message": null
    }
  ]
}
```

`root` と `manifest` は絶対パスで、`projects` は導入先の `root` の昇順です。
`upstream` はマニフェストの `repo` と `ref` をそのまま返し、文字列でない値はキーごとに `null` とします。
マニフェストを読めない場合や `upstream` がオブジェクトでない場合は、`upstream` 全体が `null` です。
`form` は `legacy`、`new`、`not-applicable`、`error` のいずれかです。
`migratable` は旧形式の場合に `true` (移行可能)、`false` (移行不可)、`null` (上流を取得できず不明) を取り、それ以外の形式では `null` です。
`reason` は理由が無ければ `null`、あれば次のコードです。
`message` は理由があるときの日本語の説明で、それ以外は `null` です。

| reason | 意味 |
|---|---|
| `manifest-unreadable` | マニフェストの読み込みまたは JSON 解析に失敗 |
| `manifest-invalid` | マニフェストまたは書き換え結果の検証に失敗 |
| `upstream-unavailable` | 上流を取得できない (旧形式として扱う) |
| `ref-unsupported` | 指定 ref の入口と本体が移行に対応しない |
| `duplicate-destination` | 書き換え後の `to` が重複する |
| `body-excluded` | 本体を除外しており、入口を自動では足せない |
| `custom-body-location` | 本体の配置が `tools/cross-review.js` 以外で、入口が導入先のルートを解決できない |
| `custom-manifest-location` | マニフェストが `tools/cross-review.sync.json` 以外にあり、入口が読めない |

照会の `result` は、`form: error` または `migratable: null` の旧形式があれば `error`、そうでなく旧形式があれば `drift`、それ以外は `clean` です。
導入先が 0 件の場合は `clean`、`projects: []` になります。
files が配列として読める不正マニフェストは、修正してから移行する必要があるため `legacy`、`migratable: false` として報告します。

| 終了コード | 照会 (`--check`) | 移行または dry-run |
|---|---|---|
| 0 | `clean` | 全導入先が移行済み、移行可能、または対象外 |
| 1 | `drift` | 移行可否が false の旧形式がある |
| 2 | 引数エラー | 引数エラー |
| 3 | `error` | 検査または処理のエラー、または移行可否が null の旧形式がある |

終了コード 3 は 1 に優先します。
JSON を付けない照会でも同じ判定と終了コードを使い、導入先ごとに 1 行で出力します。


## 取り込み先の CLAUDE.md / AGENTS.md に書くこと（テンプレート）

グローバル SKILL（`~/.claude/skills/cross-review/`）を配った環境では、3 択、サーキットブレーカー、PR 運用といった**汎用ルールの写しを各リポジトリに持たせません**。  
写しがあると、上流でルールを改訂するたびに全プロジェクトの `CLAUDE.md` を書き換えることになり、書き換え漏れたリポジトリが古いルールで動きます。  
各リポジトリに残すのは、SKILL に書けない**そのプロジェクト固有の事情**（正本の在り処、検証コマンド、同期スクリプト名）だけです。

```markdown
## AI 相互レビュー（Claude ↔ Codex）

相互レビューの手順書は [docs/cross-review.md](docs/cross-review.md) の案内から参照できます。
ローカルの全手順は
グローバル SKILL `~/.claude/skills/cross-review/SKILL.md` です。
このリポジトリ固有のレビュー観点は `.cross-review.md` にあります。

### 検証コマンド
- lint: `npm run lint`
- test: `npm test`
- build: `npm run build`

### 基盤の更新
`npm run sync`（検査は `npm run sync:check`）で上流から取り込みます。
更新手順は「同期 → 表示された移行ノートの作業 → 上の検証コマンド」の順です。

### レビューの起点
既定のレビュアーは実装者と別のベンダーです。実装を一区切りしたら 3 択を `AskUserQuestion` で提示します（詳細は SKILL）。
```

新形式の導入先には `templates/cloud-skill/SKILL.md` を `.claude/skills/cross-review/SKILL.md` に写します。
ローカルではホームの同名 SKILL が優先され、クラウドではプロジェクトの写しを使います。

> **提案（ユーザ側の設定）**：グローバル `CLAUDE.md` の相互レビュー節も、同じ理由で「SKILL への参照」と「Codex の性質と取り扱い」の注記だけに縮められます（ユーザ自身の設定ファイルなので、この文書では提案に留めます）。

## 観点チェックリスト（.cross-review.md）

レビュアーへ渡す観点は、リポジトリ直下の `.cross-review.md` から読み込みます。  
入口から呼ぶ場合は `環境変数 CROSS_REVIEW_CHECKLIST（パス）→ <cwd>/.cross-review.md → <導入先>/.cross-review.md → 組み込みの汎用観点（GENERIC_CHECKLIST）` の順です。
旧形式では導入先の代わりに `<スクリプト>/../.cross-review.md` を探します。  
どれも無くても汎用観点で動きます（起動時に stderr へ警告）。  
`CROSS_REVIEW_CHECKLIST` を指定したのに読めないときは、黙って次へ進まず警告を出します。

観点を増やしたり減らしたりしたら `.cross-review.md` を更新します。  
新しいプロジェクトへ導入するときは `.cross-review.example.md` を雛形にします。

### 既定の「指摘の出し方」

汎用観点（`GENERIC_CHECKLIST`）と `.cross-review.example.md` には、観点そのものに加えて「指摘の出し方」を 4 項目入れてあります（分類と重大度順、到達しない値を前提にした指摘を出さない、blocker と要修正は上位 10 件まで詳述し残りは重大度を保って一覧化、各指摘に反例を一行）。  
レビュアーは実害の無い細部や、運用上到達しない値への指摘に寄りやすく、そのまま受け取ると主セッションの裏取りが指摘の選別だけで埋まります。  
裏取りで使う基準を先にレビュアーへ渡し、出力の側で絞るための既定文です。

各指摘に添える推奨の対応方法は、観点ではなく CLI 本体のモード別の指示で求めます。  
観点ファイルは取り込み先ごとに書かれているので、そこに置くと、書き足していない取り込み先では対応方法が出てきません。  
モード別の指示なら、同期するだけで codex、claude、subagent のどの経路にも同じ出力形式を求められます。

- **レビューのみ**：直す箇所と直し方を、呼び出し側がそのまま着手できる粒度で書かせます。対応は指摘の解消に必要な範囲に留めさせ、仕様判断や設計選択が要る場合は推奨案とその理由、他に取り得る案を書かせます。一覧にまとめた指摘には一行で添えさせます。
- **`--fix`**：修正せずに残した指摘に、推奨の対応方法を添えさせます。

対応方法を指摘の解消に必要な範囲へ絞らせるのは、レビュアーが指摘に便乗して大きな作り込みを勧めやすいためです。  
推奨の対応方法も指摘と同じく主セッションが裏取りし、採るかどうかを決めます（後述の判断ファイルでは `**推奨対応**` の行に書きます）。

## PR を共有ログにする

- 実装がまとまったら PR を作ります。  
  以降は **PR が共有ログ**になります。  
- **指摘、対応、妥当性確認は PR コメントに記録します**（チャットだけに残さない）。  
- CI（テストなど）が機械チェックを回すので、AI レビューは設計、回帰、互換性などの観点に集中できます。
- PR が無いままレビューを始めないよう、CLI は実行前に `gh pr view` で PR の有無を調べ、無いと分かったときだけ警告します（実行は止めません。前述「CLI ブリッジ」節の `--no-pr-check`）。

### 往復ごとに保存されるファイル（`.cross-review/`）

往復を記録できたとき（レビュアー CLI が終了コード 0 で終わったとき、`subagent` がプロンプトを出力したとき）、CLI は開始時のブランチ名から決めた `.cross-review/branch-<slug>-<hash>/` へ材料を保存します。  
`slug` はブランチ名を ASCII へ置換した値を 64 文字まで残したもので、`hash` は元のブランチ名の UTF-8 SHA-256 先頭 16 桁です。置換後や大文字小文字が同じ名前でも、元名のハッシュで保存先を分けます。  
`N` は状態ファイルの往復回数です（`--no-state` の実行では往復番号が決まらないので保存しません）。  
レビュー開始時に取得したブランチ名を、非同期のレビュアー終了後も同じ保存先に使います。  
保存に失敗してもレビューは失敗にせず、警告だけ出ます。

| ファイル | 誰が書くか | 中身 |
|---|---|---|
| `round-<N>-<reviewer>.md` | CLI（`codex` / `claude`）<br>主セッション（`subagent`） | レビュアーの出力全文。`subagent` 経路はサブエージェントの出力を**任意で貼っておくと記録として残せます（`comment` は読みません）** |
| `round-<N>-<reviewer>-prompt.md` | CLI（`subagent` のみ） | サブエージェントへ渡したプロンプト |
| `round-<N>-<reviewer>.json` | CLI | 実行経路（bridge 経由 / 直接起動 / subagent）、base とその解決方法、差分サイズ、`HEAD`。競合の解消のレビューなら対象の merge の SHA（`mergeResolution.merges`） |
| `round-<N>-triage.md` | 主セッション | 指摘ごとの裏取りと対応（判断ファイル。後述） |
| `round-<N>-comment.md` | CLI（`comment`） | 生成した PR コメント本文 |

旧形式の `.cross-review/round-<N>-*.md/json` は自動で読みません。移行後に不要な平置きファイルを削除するときは、`node tools/cross-review.js artifacts --clean-legacy` を実行します。これは `.cross-review` 直下だけを走査し、旧形式のレビュー出力、メタ情報、プロンプト、判断ファイル、コメント本文を削除します。ブランチ別サブディレクトリと無関係なファイルは残します。削除前に対象パスを列挙し、一件でも削除に失敗した場合は終了コード 1 になります。  
`.cross-review/` は生成物なので **`.gitignore` に追加**します（共有は PR コメントで行います）。

### 判断ファイル（`round-<N>-triage.md`）の書き方

レビュー結果の裏取りと対応は主セッションが書きます。  
指摘 1 件につき次の形の節を並べます（`comment` は本文をそのままコメントへ差し込みます）。

```markdown
### 指摘 1（要修正）: 状態ファイルが壊れているときに書き戻してしまう
> 引用: readState が corrupt を返した後も writeState を呼んでいる

**推奨対応**: corrupt を受け取ったら writeState を呼ばず、stderr へ警告を出して終える。
**裏取り**: 妥当。corrupt のまま書くと他の枝の記録が消える。
**対応**: 記録せず警告に留めるよう修正（abc1234）。
```

`**推奨対応**` にはレビュアーが示した対応方法を書きます。  
`**対応**` で推奨と違う直し方を採ったときは、その理由を添えます。  
推奨対応と実際の対応を別の行に分けるのは、レビュアーが勧めた直し方と採った直し方の違いを PR コメント上で追えるようにするためです。

判断ファイルが無いまま `comment` を実行すると、雛形だけを書き出して終了コード 1 で終わります。  
本文は生成しないので、裏取りを書いてから実行し直します。

### PR コメント本文を生成する（`comment`）

```bash
# 1. レビューを回す (レビュー出力とメタ情報が .cross-review/ に保存される)
npm run review:codex

# 2. 裏取りと対応を .cross-review/branch-<slug>-<hash>/round-<N>-triage.md に書く

# 3. 検証コマンドの出力をファイルに残す
npm test > verify.log 2>&1

# 4. 定型に整形する (投稿はしない)
node tools/cross-review.js comment --round 1 --verify verify.log --outcome converged

# 5. 生成された本文を投稿する (コマンド例は 4 の stderr に出る)
gh pr comment <番号> --body-file .cross-review/branch-<slug>-<hash>/round-1-comment.md

# 投稿まで自動化する場合は、生成本文を標準入力で渡す
node tools/cross-review.js comment --round 1 --verify verify.log --post <番号> --outcome converged
```

生成される本文の構成は次のとおりです。

- 見出し `## クロスレビュー <N> 往復目: <レビュアー> の指摘と対応`
- メタ情報の要約 1 行（実行経路、base とその解決方法、差分サイズ）。`--outcome` を付けたときは、記録した head（7 桁）と結論も続けます。
  例: `実行経路: bridge 経由 / base: origin/main (PR の base) / 差分サイズ: 6.7KB / head: 109513c / 結論: 収束 (converged)`
- 判断ファイルの本文
- `### 確認内容`（`--verify` を渡したときだけ。長い出力は末尾 200 行に切り、その旨を書きます）
- `--outcome` を付けたときは、本文の末尾に機械読み用の注記を 1 行置きます（形と読み方は [contracts/cross-review-state.md](contracts/cross-review-state.md) の「PR コメントの結論の注記」）。
- レビュアーの出力はコメントに載せず、ブランチ別ディレクトリの `round-<N>-<reviewer>.md` へローカル保存するだけです。
  指摘の内容は判断ファイルに引用として書くため、レビュアー出力の全文をコメントへ載せると、読む側とトークンのコストがかさみます。
レビュアーの出力そのものが 4,194,304 文字（UTF-16 コード単位。バイト数ではない）を超えた場合は保存時に先頭を捨てて末尾だけを残し、保存ファイルの先頭にその注記を入れます。  
生成した本文が 65,000 文字を超えたときは stderr で警告します（書き出しは行うので、判断ファイルや `--verify` の出力を削ってから投稿します）。

オプションは次のとおりです。

| オプション | 意味 |
|---|---|
| `--round <N>` | 対象の往復番号（必須） |
| `--reviewer <name>` | 対象のレビュアー。省略時はブランチ別ディレクトリのメタ情報から自動で決め、複数あればエラーで列挙します |
| `--verify <path>` | 検証コマンドの出力ファイル |
| `--out <path>` | 書き出し先（既定はブランチ別ディレクトリの `round-<N>-comment.md`） |
| `--post <N>` | PR #N へ生成本文を `gh pr comment N --body-file -` の標準入力で投稿（1 以上の整数） |
| `--outcome <値>` | 本文生成後に結論を記録する。`fixing` / `converged` / `halted` を指定 |
| `--allow-dirty` | `converged` の記録時に未コミット変更を許可し、記録後に警告する |
| `--allow-round-mismatch` | 状態ファイルに対象往復のレビュー記録が無くても、結論を記録する |

`comment` は入力検査の前に既定出力先の古い本文を削除します。
`--out` で明示した出力先は、入力検査に成功して新しい本文の書き出しを開始するまで変更しません。
`--outcome converged` は追跡ファイルに未コミット変更があると本文生成前に終了し、`--allow-dirty` を付けると記録後に警告して続行します。
メタ情報が無い、複数ある、検証出力を読めない、判断ファイルが無い、本文を書けない、投稿に失敗するといった場合は終了コード 1 で終わり、今回生成した本文を残しません。
`--post` を付けた場合は、本文を出力先へ保存してから同じメモリ本文を投稿し、投稿に失敗すると保存した本文を削除します。
`--outcome` を付けた場合、状態ファイルの破損、`HEAD` の取得失敗、実行中のブランチか `HEAD` の変化、記録済みより古い往復の指定、書き込み失敗では終了コード 1 になりますが、生成済み本文や成功済みの投稿は残ります。
投稿ではネットワーク遅延を考慮して gh のタイムアウトを 60 秒に延長し、タイムアウト、シグナル終了、起動エラーの理由を表示します。

投稿しない既定動作では、stderr に手動投稿用のコマンド例を出します。`--post` は PR 番号を明示した実行でだけ使います。

## メンテナンス

- レビュー観点を増やしたり減らしたりしたら `.cross-review.md` を更新します。  
- CLI の対象範囲（`--staged` など）を増やすときは、（テストを同梱しているなら）`tests/cross-review.test.js` も更新します。  
- 同期スクリプトの仕様（マニフェストの形、モード）を変えたら、（同梱しているなら）`tests/cross-review.sync.test.js` も更新します。  
- 運用ルールの要約はコピー先の `CLAUDE.md` / `AGENTS.md`（あれば）に置きます。  
  このドキュメントが正本なので、内容を二重に書きません（要約からはここへリンクします）。
