# 状態ファイルの契約

## 正本と保存形式

`.cross-review-state.json` の形式の正本は ai-cross-review です。
書き手は ai-cross-review の CLI だけです。
ファイルはリポジトリのルートの `.cross-review-state.json` に置きます。
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
| `lastTriage.sha` | 40 桁または 64 桁の 16 進文字列だけ受け付け、小文字にします。前後の空白は除きません。 |
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
`writer/*.json` は CLI の状態遷移と書き込みを通したファイル本文です。
再生成の手順は `tests/cross-review.state-contract.test.js` にあり、テストは期待値を自動更新せず、書き手の出力とバイト単位で比較します。
`npx vitest run tests/cross-review.state-contract.test.js` で両方を検証できます。

ほかの読み手は上流の revision を固定して文書と検証データを取り込み、自分のパーサーの解釈を確かめます。
この文書、検証データ、契約テストは雛形マニフェストには含めず、導入先へ自動配布しません。
形式を変えるときは、旧読取側との互換表と導入順を先に `docs/migrations/` の移行ノートに書きます。
