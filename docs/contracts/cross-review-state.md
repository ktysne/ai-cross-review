# 状態ファイルの契約

## 正本と保存形式

`.cross-review-state.json` の形式の正本は ai-cross-review です。
書き手は ai-cross-review の CLI だけです。
ファイルは Git の共通ディレクトリの `cross-review-state.json` に置き、同じリポジトリの全 worktree で共有します。
文字コードは UTF-8、BOM なしとし、書き手は 2 空白のインデントと末尾改行（LF）を付けます。
現在は `version` フィールドを持ちません。

```json
{
  "branches": {
    "feature/example": {
      "round": 1,
      "lastReviewedSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "dismissed": ["対応不要と確認した指摘の要約"],
      "lastTriage": {
        "round": 1,
        "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "outcome": "converged"
      }
    }
  }
}
```

`branches` はブランチ名をキーにしたオブジェクトです。
ブランチ名に `/` や `.` を含められます。
未知のキーは、トップレベルと各フィールドのオブジェクトのいずれでも無視します。

## 保存先の解決

読み手も書き手も checkout のルートを cwd にして `git rev-parse --path-format=absolute --git-common-dir` を実行し、その下の `cross-review-state.json` を使います。
古い Git が `--path-format` を受け付けない場合は `git rev-parse --git-common-dir` に落とし、出力を checkout のルートから絶対パスへ変換します。
CLI は解決結果をプロセス内で checkout のルートごとにキャッシュします。

共通ディレクトリは通常の checkout と worktree では本体の `.git`、bare リポジトリでは `repo.git`、サブモジュールでは `.git/modules/<name>` です。
`GIT_DIR` などの環境変数が別のリポジトリを指していれば、Git が返すそちらの共通ディレクトリを使います。
Git が使えない場合やリポジトリでない場合は、従来の `<checkout のルート>/.cross-review-state.json` を使います。

`deps.stateDir` または環境変数 `CROSS_REVIEW_STATE_DIR` があれば、そのディレクトリの `cross-review-state.json` を使い、Git は実行しません。
両方あれば `deps.stateDir` を優先します。

## 排他と書き込み

書き手だけが `cross-review-state.json.lock` を `wx` で作り、pid、時刻、hostname を書いて直ちに close します。
取得できなければ待って再試行し、5 秒で失敗します。
mtime が 30 秒より古く、本文を読めないか、同じ hostname の pid が `process.kill(pid, 0)` の `ESRCH` で不在と分かったロックだけを放棄済みと扱います。
放棄したロックは直接 unlink せず、一意な `.lock.stale-<pid>-<time>` 名へ rename してから消します。
別ホストの pid や権限不足で生存を確かめられない pid のロックは奪いません。

ロック内で旧ファイルを取り込み、共有ファイルを読み直してから状態遷移を適用します。
壊れた共有ファイルには書き戻しません。
変更があれば同じディレクトリの一意な一時ファイルへ書き、fsync してから rename で置換します。
rename の `EPERM`、`EBUSY`、`EACCES` は合計約 1 秒まで再試行し、失敗した一時ファイルを消します。
読み手は rename 前後の本文を読むため、ロックを取る必要がありません。

## 旧ファイルの取り込み

共有側を正とし、各 checkout の `.cross-review-state.json` は未取り込みの記録としてだけ扱います。
表示だけの `state` と `--outcome` のない `comment` は取り込まず、旧ファイルがあれば stderr に 1 行警告します。
書く可能性のあるコマンドは状態を使う前にロック内で取り込みます。
レビューの base 解決にも取り込み後の `lastReviewedSha` を使います。

ブランチごとの統合規則は次のとおりです。

- `round` は大きいほうを使います。
- `lastReviewedSha` は `round` の大きい側を使います。同じなら共有側を使いますが、共有側が `null` で旧側が非 `null` なら旧側を使います。
- `dismissed` は共有側の順序を保ち、旧側にしかない要約を後ろへ追加します。
- `lastTriage` は `round` と独立に `lastTriage.round` の大きい側を使います。同じなら共有側を使い、片方だけにあればそれを使います。

取り込みは冪等です。
取り込んだ旧ファイルは削除せず、共有ディレクトリの `cross-review-state.imported/<checkout の絶対パスの sha256 先頭 16 桁>.json` へ移します。
同名があれば置き換えてかまいません。
移動に失敗したら警告します。
壊れた旧ファイルは取り込まず警告し、その場所に残してコマンドを続けます。

同じリポジトリで新旧の CLI を混在させる運用は非対応です。
旧版が旧ファイルを作り直すと、`state --reset` した記録が再取り込みで戻る可能性があります。
全 worktree を同じ新しい版へそろえてください。

## 結論の記録時の検査

`comment --outcome` は本文の生成や投稿の前に、ブランチの `round` が `--round` 以上であることを検査します。
足りなければ終了コード 1 で止め、レビューを実行した worktree または `node tools/cross-review.js state` で記録を確認する手順を示します。
意図した記録なら `--allow-round-mismatch` でこの検査を許可できます。
ロック内の記録直前にも同じ検査を行います。
`lastReviewedSha` が HEAD と異なれば両方の短縮 SHA を警告し、この警告は `--allow-round-mismatch` でも残します。

## 書き手が書く値の保証

| フィールド | 書き手の値と意味 |
|---|---|
| `round` | 0 以上の安全な整数。レビューを 1 回実行するごとに 1 増えます。 |
| `lastReviewedSha` | 最後にレビューしたコミットの完全な SHA。記録がなければ `null` です。コミットを記録しないレビューでは前の値を保持します。 |
| `dismissed` | 対応不要と判断した要約の文字列配列。要約の前後の空白を除き、空文字列を追加せず、同じ要約を重複追加しません。 |
| `lastTriage` | 最後の判断の記録。記録がなければ `null` です。 |
| `lastTriage.round` | 1 以上の安全な整数。判断の対象となった往復です。 |
| `lastTriage.sha` | 判断対象の完全な SHA。40 桁または 64 桁の小文字の 16 進文字列です。 |
| `lastTriage.outcome` | `fixing`（対応中）、`converged`（収束）、`halted`（打ち切り）のいずれかです。 |

CLI が新しく取得する `lastReviewedSha` は完全な SHA です。
既存の記録を読み込んで書き戻す場合は、次節の正規化結果を保持するため、短縮 SHA や重複した要約も残ることがあります。
`lastTriage` は古い往復の判断で新しい往復の判断を置き換えず、同じ往復の再記録は受け付けます。
読み込み時には `round`、`lastReviewedSha`、`lastTriage` 相互の整合性まで検証しません。

## 読み込み時の正規化

`tools/cross-review.js` の `parseStateText(text)` は `{ kind, state, issues }` を返します。
JSON の構文解析に失敗した場合だけ `kind: 'invalid'`、`state: null`、`issues: []` になります。
BOM 付きの本文も構文解析の失敗として扱います。
構文解析に成功した場合は、内容の型が違っていても `kind: 'ok'` とし、正規化した `{ branches: {...} }` を返します。
既存の `normalizeState` も同じ正規化処理を使います。

| 対象 | 正規化 |
|---|---|
| トップレベル | 配列、`null`、数値など、オブジェクトでない値は空の記録にします。 |
| `branches` | 配列、`null`、その他オブジェクトでない値は空の記録にします。 |
| ブランチ名 | 空文字列のキーは捨てます。 |
| ブランチの値 | オブジェクトでなければ、そのブランチを初期値で残します。配列も初期値になります。 |
| `round` | 0 以上の安全な整数だけ残し、それ以外は `0` にします。 |
| `lastReviewedSha` | 空白だけでない文字列は前後の空白を除いて残し、それ以外は `null` にします。完全な SHA であることは要求しません。 |
| `dismissed` | 配列でなければ `[]` にします。配列では文字列以外と空白だけの要素を捨て、残した要素の前後の空白を除きます。順序と重複は保持します。 |
| `lastTriage` | オブジェクトであり、`round`、`sha`、`outcome` がすべて妥当な場合だけ残します。1 項目でも不正なら全体を `null` にします。 |
| `lastTriage.round` | 1 以上の安全な整数だけ受け付けます。 |
| `lastTriage.sha` | 40 桁または 64 桁の 16 進文字列だけ受け付け、小文字にします。前後の空白は除きません。読み手は PR の head の SHA と完全一致で比べるため、短縮 SHA は受け付けません。 |
| `lastTriage.outcome` | `fixing`、`converged`、`halted` だけ受け付けます。 |

省略されたキー（`undefined`）は issue にしません。
旧記録に `dismissed` や `lastTriage` がなければ、それぞれ `[]` と `null` にします。
`lastReviewedSha: null` と `lastTriage: null` も正常値として扱います。
`lastTriage` の必須項目が省略されていれば全体を `null` にしますが、省略自体は issue にしません。

## 診断情報

`issues` は、値を捨てたり既定値に置き換えたりした箇所を `{ path, code }` の配列で示します。
前後の空白の除去と SHA の小文字化は issue にしません。
`path` はキーの配列です。
たとえば `['branches', 'feature/x.y', 'round']` のようにブランチ名を 1 要素とし、`dismissed` の要素には数値の添字を使います。
トップレベルの問題は `[]`、`branches` の問題は `['branches']` で示します。

| `code` | 意味 |
|---|---|
| `invalid-type` | 数値でない `round`、配列でない `dismissed`、文字列でない要約など、型が違います。 |
| `out-of-range` | `round` が負数、小数、安全な整数の範囲外、または `lastTriage.round` が 1 未満です。 |
| `invalid-format` | 空白だけの `lastReviewedSha` や要約、不正な桁数や文字の `lastTriage.sha`、空のブランチ名です。 |
| `invalid-value` | `lastTriage.outcome` が許可された値ではありません。 |

`lastTriage` の問題は、オブジェクトの型、`round`、`sha`、`outcome` の順に調べ、最初の原因 1 件だけを報告します。
項目の問題は `[..., 'lastTriage', 'round']` など、その項目のパスで示します。
`lastTriage` 自体がオブジェクトでなければ `[..., 'lastTriage']` で示します。
読み手は issues のあるブランチを取得不能として扱ってかまいません。
agent-cockpit のように、CLI の正規化より厳しい読み取り方針を取れます。

## ファイルの読み取り結果と呼び出し元の方針

`readState` は `{ path, state, corrupt, kind, issues }` を返します。

| `kind` | 意味 | CLI の入口での扱い |
|---|---|---|
| `ok` | 本文を JSON として解析できました。 | 正規化した記録を使います。issues があっても `corrupt: false` です。 |
| `missing` | ファイルがないか、存在確認に失敗しました。 | 空の記録を使い、`corrupt: false` にします。 |
| `invalid` | 本文の JSON 構文が不正です。 | 空の記録を返し、`corrupt: true` にします。呼び出し元は警告して書き戻しません。 |
| `unreadable` | ファイルの読み取りに失敗しました。 | 空の記録を返し、`corrupt: true` にします。呼び出し元は警告して書き戻しません。 |

`ok` ではパーサーの issues を引き継ぎ、それ以外では `issues: []` を返します。
一般の読み手が既定値へ変換するか、処理を続けるかは呼び出し元が決めます。
`lastReviewedSha` が PR の head と異なる記録や、すでに base に入った古い記録かどうかの判定も読み手の責任です。
書き手の正規化は head や base を参照せず、`lastReviewedSha` の前後の空白を除く以外に SHA の値を変えません。

## 検証データと互換性

検証データは上流の `contracts/cross-review-state/` に置きます。
`parse/*.json` は説明、入力本文、手書きの期待結果を持ち、BOM は入力文字列中の `\ufeff` で表します。
`merge/*.json` は説明、共有側、旧側、統合結果を持ち、`mergeStates` の統合規則と冪等性を確かめます。
`writer/*.json` は CLI の状態遷移と書き込みを通したファイル本文です。
再生成の手順は `tests/cross-review.state-contract.test.js` にあり、テストは期待値を自動更新せず、書き手の出力とバイト単位で比較します。
`npx vitest run tests/cross-review.state-contract.test.js` ですべてを検証できます。

ほかの読み手は上流の revision を固定して文書と検証データを取り込み、自分のパーサーの解釈を確かめます。
この文書、検証データ、契約テストは雛形マニフェストには含めず、導入先へ自動配布しません。
形式を変えるときは、旧読取側との互換表と導入順を先に `docs/migrations/` の移行ノートに書きます。
