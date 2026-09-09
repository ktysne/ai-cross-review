#!/usr/bin/env node
// tools/cross-review.js
//
// Claude ↔ Codex の相互レビューを 1 コマンドで回す CLI ブリッジ。
// 「片方の AI で実装 → もう片方の AI でレビュー」を、チャットログを手でコピーせず、
// git の差分を直接レビュアー CLI へ渡して実行する。
//
// 使い方:
//   node tools/cross-review.js codex            # 現在のブランチ (main との差分) を Codex がレビュー
//   node tools/cross-review.js claude           # 同上を Claude がレビュー
//   node tools/cross-review.js subagent         # 外部 CLI を起動せずレビュープロンプトを stdout に出す (リモートコントロール用)
//   node tools/cross-review.js codex --fix      # Codex がレビューに加え検出事項を直接修正 (作業ツリー編集)
//   node tools/cross-review.js codex --fix --instructions notes.md  # レビュアーの指摘 (notes.md) を渡して Codex に修正させる
//   node tools/cross-review.js codex --uncommitted    # 未コミットの作業ツリー差分をレビュー
//   node tools/cross-review.js claude --base develop  # 比較先ブランチを変更
//   npm run review:codex                        # = node tools/cross-review.js codex
//   npm run review:codex:fix                    # = node tools/cross-review.js codex --fix
//   npm run review:claude -- --uncommitted      # npm 経由で追加引数を渡す (-- が必要)
//
// 設計判断:
// - 依存パッケージを追加しない (Node 標準 API のみ)。
// - codex / claude いずれも「観点 + スコープ + 差分本文 + モード別指示」を stdin で渡し、
//   汎用 `codex exec` / `claude -p` を使う。codex の専用サブコマンド `codex exec review` は
//   v0.137.0 で `--uncommitted` / `--base` が `[PROMPT]` と排他になり、プロジェクト固有の
//   チェックリスト (.cross-review.md) を同時に渡せなくなったため、汎用 exec + 自前の差分埋め込みに統一した。
// - レビューのみ (既定) は codex を `-s read-only` で起動し、ファイルを書き換えさせない。
//   `--fix` 指定時のみ codex を `-s workspace-write` で起動し、検出事項を作業ツリーへ直接
//   修正させる (相互レビューフローの 3B「レビュー + 修正を依頼」)。claude CLI 経路 (claude -p) の
//   自動修正は未対応 (--fix は codex / subagent のみ)。
// - codex の起動は、claude-codex-bridge の起動スクリプト (codex-agent.sh) があればそれを経由する。
//   モデル、推論 effort、認証ホーム (CODEX_HOME) を定義ファイル `~/.claude/gpt-agents/<name>.md` 側で
//   一元管理し、Claude Code のサブエージェント経由の起動と条件を揃えるため。サンドボックスも定義側の
//   `codex_sandbox` で決まるので、read-only の `codex-review` と workspace-write の `codex-subagent` を
//   --fix の有無で選び分けたうえ、起動前に定義ファイルの `codex_sandbox` を読んで --fix の有無と
//   一致するかを検査し (食い違えばエラー終了)、「レビューのみは read-only」の不変条件を保つ。
//   bridge は codex への追加引数を受け付けないため、承認方針はスクリプト本文の指定がすべてになる。
//   スクリプトが `approval_policy=never` を明示していない場合は bridge を使わず直接起動へ戻し、
//   「Codex の承認は never 固定」を保つ。スクリプトが無い環境でも従来どおり直接起動する
//   (`--no-codex-agent` で明示的に直接起動へ戻せる)。
// - Codex が利用上限に達したときは、レビューを失敗で終わらせず subagent 経路と同じプロンプトを
//   ファイルへ書き出し、終了コード 75 で「客観サブエージェントへ渡してください」と促す
//   (`--no-fallback` で従来どおりの失敗終了に戻せる)。
// - リモートコントロール環境では codex/claude スタンドアロン CLI を spawn できない。その場合は
//   reviewer に `subagent` を指定すると、外部プロセスを起動せず、組み立てたレビュープロンプト
//   (観点 + スコープ + 差分本文 + モード別指示) を stdout に出すだけにする。呼び出し側 (Claude) が
//   その出力を Agent ツールの客観レビュー用サブエージェントへ渡してレビューさせる
//   (Codex の代わりに「Claude の客観的な観点を持つサブエージェント」がレビュアーになる)。
//   プロンプト組み立て、観点解決、差分収集は codex/claude 経路と同一なので観点が揺れない。
// - プロジェクト固有のレビュー観点は、リポジトリ直下の `.cross-review.md` を単一ソースとして
//   読み込み、各レビュアー (codex / claude / subagent) へ同じチェックリストとして添える (無ければ汎用観点 GENERIC_CHECKLIST へ
//   フォールバック)。この CLI は engine 部分が完全に汎用なので、他リポへ `tools/cross-review.js` を
//   コピーし `.cross-review.md` を置くだけで観点を差し替えて再利用できる。観点を更新したら
//   `.cross-review.md` を直す。
// - レビュアー個別の「申し送り、重点指摘」は `--instructions <path>` で渡す。これは観点
//   (.cross-review.md) を置き換えず、それに加えてプロンプトへ添える別系統。一方のレビュアーが
//   出した指摘をファイルに書き、`codex --fix --instructions <path>` で他方に直接修正させる用途を
//   一級でサポートする (この目的で CROSS_REVIEW_CHECKLIST を流用すると観点が消えるため非推奨)。
// - claude の --uncommitted は Codex の --uncommitted (staged+unstaged+untracked) と結果を
//   揃えるため、tracked 変更 (git diff HEAD) に加えて未追跡ファイルも new file 差分として含める。
// - 前提: codex / claude レビュアーは「スタンドアロン CLI」が PATH にあること
//   (VS Code プラグイン / デスクトップアプリとは別物)。CLI レビューはレビュアー CLI が
//   ネットワーク/API 接続を使うため、必要に応じてサンドボックス無効、ネットワーク許可で起動する
//   (cross-review フロー ドキュメント参照)。
//   subagent レビュアーは外部 CLI を起動しない (プロンプトを stdout に出すだけ) ので CLI 不要。

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// レビュー観点はプロジェクト固有なので、リポジトリ直下の `.cross-review.md` を単一ソースとして
// 読み込む。この CLI を他リポへコピーしても `.cross-review.md` を置くだけで観点を差し替えられる。
// 解決順は loadChecklist 参照: 環境変数 CROSS_REVIEW_CHECKLIST(パス) → <cwd>/.cross-review.md →
// <スクリプト>/../.cross-review.md → GENERIC_CHECKLIST。このリポジトリの観点は `.cross-review.md` にある。
const CHECKLIST_FILENAME = '.cross-review.md';

// 除外パターンファイル名。観点 (.cross-review.md) と同じ解決順で探す。
const IGNORE_FILENAME = '.cross-review-ignore';

// claude-codex-bridge の Codex 起動スクリプト。ホームディレクトリからの相対パスで探す
// (環境変数 CROSS_REVIEW_CODEX_AGENT で明示指定も可能)。
const CODEX_AGENT_SCRIPT_SUBPATH = ['.claude', 'tools', 'codex-agent.sh'];

// bridge 経由で使う定義名。サンドボックスは定義ファイル側の codex_sandbox で決まるため、
// 「レビューのみは read-only、--fix のときだけ workspace-write」の不変条件は、定義名の選択と
// 起動前の codex_sandbox 検査 (checkCodexAgentSandbox) の両方で守る。
// codex-review = read-only / codex-subagent = workspace-write。
const CODEX_AGENT_REVIEW_NAME = 'codex-review';
const CODEX_AGENT_FIX_NAME = 'codex-subagent';

// bridge の定義ファイル置き場。codex-agent.sh と同じく <cwd> → <ホーム> の順で探す
// (プロジェクト定義がユーザ定義を上書きする)。
const CODEX_AGENT_DEF_SUBDIR = ['.claude', 'gpt-agents'];

// 定義ファイルの codex_sandbox が取り得る値。既定は安全側の read-only (bridge 側の既定と揃える)。
const CODEX_SANDBOX_READ_ONLY = 'read-only';
const CODEX_SANDBOX_WORKSPACE_WRITE = 'workspace-write';

// bridge 経由を許す条件。codex-agent.sh は codex への追加引数を受け付けないため、承認方針は
// スクリプト本文の指定がすべてになる。この文字列を明示していないスクリプトは
// 「Codex の承認は never 固定」を保証できないので bridge 経由に使わない。
const APPROVAL_NEVER_MARKER = 'approval_policy=never';

// codex-agent.sh の終了コード。3 = bridge が未導入 (codex コマンドや定義が無い、codex_enabled: false)、
// 75 = Codex が利用上限で実行できなかった。
const CODEX_AGENT_EXIT_MISSING = 3;
const USAGE_LIMIT_EXIT_CODE = 75;

// 直接起動時に利用上限を見分けるための出力パターン。codex-agent.sh 側の判定と同じ語を使う。
// 429 は単語境界で照合し、ID や桁数の一致で誤検出しないようにする。
const USAGE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b/i;

// 利用上限の判定に使う出力の保持量 (末尾のみ)。ログ全体を溜め込まないための上限。
const OUTPUT_TAIL_LIMIT = 64 * 1024;

// 既定で差分本文から除外するファイル群 (ロックファイル、生成物、ソースマップ)。
// レビュー価値が低くトークンを浪費しがちなので、明示的に除外する。
// パターンはファイル名のみ (どの階層でも一致させたい) で、git パススペックでは
// glob + top マジックワード + `**/` 接頭で再帰一致させる (toExcludePathspecs 参照)。
const DEFAULT_EXCLUDE_PATTERNS = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'go.sum',
  '*.min.js',
  '*.min.css',
  '*.map',
];

// `.cross-review.md` が無いときの汎用フォールバック観点。特定リポに依存しない一般論のみ。
// 「指摘の出し方」を含めるのは、レビュアーが実害の無い細部や運用上到達しない値への指摘に寄りやすく、
// 呼び出し側の裏取りが指摘の選別で埋まるため。裏取りで使う基準を先に渡して出力側で絞る。
const GENERIC_CHECKLIST = [
  'あなたはこのリポジトリのコードレビュアーです。',
  '以下の差分を日本語でレビューし、各指摘に重大度 (blocker / 要修正 / 提案) を付けてください。',
  '問題が無ければその旨も明記してください。',
  '',
  '一般的な観点:',
  '- 正当性: ロジック誤り・境界条件・null/undefined・例外処理やエラーハンドリングの漏れ。',
  '- 回帰: 差分に現れていない既存挙動を壊していないか。',
  '- 後方互換: 永続化フォーマット / 公開 API / 設定スキーマの互換性を壊していないか。',
  '- テスト・lint: 変更に見合うテストがあるか、lint / 型チェック / ビルドを通る変更か。',
  '- スコープ: 無関係なリファクタや不要な変更が混ざっていないか。',
  '',
  '指摘の出し方:',
  '- 指摘は「実害がある (不具合、データ破損、セキュリティ、仕様違反)」「守るべき不変条件の違反」「改善提案」に分類し、重大度順 (blocker、要修正、提案) に並べてください。',
  '- 実際に到達しない入力や、運用上使わない値を前提にした指摘は出さないでください。出す場合は到達経路を示してください。',
  '- blocker と要修正は重大度順に上位 10 件まで詳述し、それを超える分は重大度を保ったまま一覧にまとめてください（「提案」へ格下げしない）。',
  '- 各指摘に、その指摘が当たらない条件 (反例) を一行添えてください。',
  '',
  '(プロジェクト固有の観点は、リポジトリ直下に .cross-review.md を置くと自動で添付されます。)',
].join('\n');

// レビュー観点を解決する。解決順は:
//   1. 環境変数 CROSS_REVIEW_CHECKLIST (パス)
//   2. <cwd>/.cross-review.md            (npm run review:* の通常経路。cwd はパッケージ直下)
//   3. <スクリプト>/../.cross-review.md   (tools/cross-review.js の 1 つ上 = リポジトリ直下。
//                                          cwd がリポ直下でなくても絶対パス等で起動すれば観点を拾える)
//   4. GENERIC_CHECKLIST                  (どれも無ければ汎用観点。起動時に stderr へ警告)
// deps で env / cwd / scriptDir / fs / 警告出力を差し替え可能にする (テストで再現するため)。
function loadChecklist(deps = {}) {
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const scriptDir = deps.scriptDir || __dirname;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  const envPath = env.CROSS_REVIEW_CHECKLIST || '';
  const candidates = [];
  if (envPath) candidates.push(envPath);
  candidates.push(path.join(cwd, CHECKLIST_FILENAME));
  candidates.push(path.join(scriptDir, '..', CHECKLIST_FILENAME));
  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue; // cwd == リポ直下のときに同一パスを二重判定しない。
    seen.add(p);
    try {
      if (exists(p)) {
        const body = readFile(p).replace(/\s+$/, '');
        if (body.trim()) return body;
      }
    } catch {
      // 読めなければ次の候補 / フォールバックへ進む。
    }
    // 明示指定した CROSS_REVIEW_CHECKLIST が解決できなかったら、黙ってフォールバックせず警告する
    // (誤ったパス / 空ファイルで意図しない観点になる運用事故を検知しやすくするため)。
    if (envPath && p === envPath) {
      warn(`[cross-review] CROSS_REVIEW_CHECKLIST=${envPath} を読めません (存在しない/空/読取不可)。他の候補にフォールバックします。\n`);
    }
  }
  warn(`[cross-review] ${CHECKLIST_FILENAME} が見つかりません。汎用観点でレビューします。\n`);
  return GENERIC_CHECKLIST;
}

// `--instructions <path>` のファイル本文を読む。観点 (.cross-review.md) とは別系統で、
// 「レビュアーからの申し送り、重点指摘」をプロンプトへ追加で添えるためのもの。
// 読めなければ例外を投げ、呼び出し側 (runReview) がエラー終了させる。
// deps.readFile でテストから差し替え可能。
function loadInstructions(instructionsPath, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  return String(readFile(instructionsPath)).replace(/\s+$/, '');
}

// 除外パターン (.cross-review-ignore) を解決して読む。解決順は観点 (loadChecklist) と同じ流儀:
//   1. 環境変数 CROSS_REVIEW_IGNORE (パス)
//   2. <cwd>/.cross-review-ignore
//   3. <スクリプト>/../.cross-review-ignore
// 形式は 1 行 1 パターン、`#` 始まりはコメント、空行無視。見つかった最初の 1 つだけを読む。
// 戻り値は「既定パターン (DEFAULT_EXCLUDE_PATTERNS) + ファイルのパターン」の配列
// (ファイルが無ければ既定のみ)。env 明示指定が読めない場合は警告して次の候補へ (loadChecklist と同じ流儀)。
// deps で env / cwd / scriptDir / fs / 警告出力を差し替え可能にする (テスト用)。
function loadIgnorePatterns(deps = {}) {
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const scriptDir = deps.scriptDir || __dirname;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  const envPath = env.CROSS_REVIEW_IGNORE || '';
  const candidates = [];
  if (envPath) candidates.push(envPath);
  candidates.push(path.join(cwd, IGNORE_FILENAME));
  candidates.push(path.join(scriptDir, '..', IGNORE_FILENAME));
  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue; // cwd == リポ直下のときに同一パスを二重判定しない。
    seen.add(p);
    let body = null;
    try {
      if (exists(p)) body = readFile(p);
    } catch {
      body = null; // 読めなければ次の候補へ進む。
    }
    if (body != null) {
      const extra = String(body)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
      return DEFAULT_EXCLUDE_PATTERNS.concat(extra);
    }
    // 明示指定した CROSS_REVIEW_IGNORE が解決できなかったら、黙って次へ進まず警告する
    // (誤ったパスで意図しない除外設定になる運用事故を検知しやすくするため)。
    if (envPath && p === envPath) {
      warn(`[cross-review] CROSS_REVIEW_IGNORE=${envPath} を読めません (存在しない/読取不可)。他の候補にフォールバックします。\n`);
    }
  }
  return DEFAULT_EXCLUDE_PATTERNS.slice();
}

// 除外パターン配列を git パススペック群に変換する。ファイル名のみのパターンを
// どの階層でも一致させるため、glob マジックワード + `**/` 接頭で再帰一致させる。
// `top` マジックワードで repo ルート相対に固定する: これが無いとパススペックが cwd 相対になり、
// リポジトリのサブディレクトリから実行したとき除外範囲 (ひいては差分スコープ) がそのサブツリーに
// 狭まってしまう (include 側を `:/` にしているのと対になる)。
// (例: `package-lock.json` → `:(exclude,glob,top)**/package-lock.json`、
//  `*.min.js` → `:(exclude,glob,top)**/*.min.js`)。実挙動はテストと git で確認済み。
function toExcludePathspecs(patterns) {
  return patterns.map((p) => `:(exclude,glob,top)**/${p}`);
}

// レビューのみ (既定) の追加指示。ファイルを変更させない。
const REVIEW_ONLY_INSTRUCTION = [
  '【モード: レビューのみ】',
  'ファイルは変更しないでください。指摘のみを重大度 (blocker / 要修正 / 提案) 付きで列挙し、',
  '問題が無ければその旨を明記してください。',
].join('\n');

// --fix の追加指示。検出事項を作業ツリーへ直接修正させる (相互レビューフロー 3B)。
const FIX_INSTRUCTION = [
  '【モード: レビュー + 修正】',
  '検出した問題は、作業ツリーのファイルを直接編集して修正してください。',
  '- 修正は差分に現れた変更へのフィードバックに限定し、無関係なリファクタはしない。',
  '- レビュー観点 (.cross-review.md) に挙げた禁則・不変条件を壊さない。',
  '- 仕様判断・設計選択などユーザの確認が要る事項は修正せず、指摘として残す。',
  '- 最後に「修正したファイルと内容・理由」「未修正で残した指摘」を日本語で要約する。',
  '構文チェック / lint / テスト / プロジェクト固有の整合性チェックは呼び出し側が後で実行する。',
].join('\n');

// `--instructions <path>` で渡された「レビュアーからの申し送り、重点指摘」をプロンプトへ
// 添えるときの見出し。観点 (.cross-review.md) を置き換えず、それに加える位置づけ。
// 主用途: 一方のレビュアーが出した指摘を他方に渡して `--fix` で直接修正させる。
const REVIEWER_NOTES_HEADER = [
  '【レビュアーからの申し送り・重点指摘】',
  '以下は、もう一方のレビュアー (Claude 等) が既に検出した重点事項です。',
  'レビュー時は最優先で検証し、--fix 時はこれらの修正を最優先で行ってください。',
  '（仕様判断・設計選択が要る事項は修正せず指摘として残すルールは従来どおり）',
].join('\n');

const USAGE = [
  'Claude ↔ Codex 相互レビュー CLI ブリッジ',
  '',
  '使い方: node tools/cross-review.js <codex|claude|subagent> [options]',
  '',
  'レビュアー:',
  '  codex      codex スタンドアロン CLI でレビュー (既定 read-only、--fix で workspace-write)',
  '  claude     claude スタンドアロン CLI でレビュー (claude -p)',
  '  subagent   外部 CLI を起動せず、レビュープロンプトを stdout に出力 (リモートコントロール用)。',
  '             codex/claude CLI を spawn できない環境向け。出力を Agent ツールの客観レビュー用',
  '             サブエージェントへ渡してレビューさせる。--fix も可 (FIX 指示付きで出力)。',
  '',
  'options:',
  '  --fix                 修正まで依頼 (codex: workspace-write で直接編集 / subagent: FIX 指示付きで出力。claude CLI 経路は非対応)',
  '  --uncommitted         未コミットの作業ツリー差分 (tracked + untracked) をレビュー',
  '  --base <ref>          比較先ブランチを指定 (既定: 未指定なら origin/main を優先解決→無ければ main)',
  '  --max-diff-kb <n>     レビュー差分サイズの上限 (KB)。超過時はレビュアーを起動せず中断',
  '                        (既定 256。0 でガード無効。環境変数 CROSS_REVIEW_MAX_DIFF_KB でも指定可)',
  '  --max-file-diff-kb <n> ファイル単位の差分がこの KB を超えたら本文を stat 要約に置換',
  '                        (既定 64。0 で無効。環境変数 CROSS_REVIEW_MAX_FILE_DIFF_KB でも指定可)',
  '  --no-exclude          既定除外も含めすべての除外を無効化 (緊急時の逃げ道)',
  '  --instructions <path> レビュアーからの申し送り・重点指摘ファイルをプロンプトへ添付',
  '                        (観点 .cross-review.md は置き換えず追加。--fix と併用で指摘を直接修正させる)',
  '  --codex-agent <name>  bridge (codex-agent.sh) で使う定義名を明示 (既定: レビューのみ codex-review /',
  '                        --fix は codex-subagent。--fix と食い違う定義名はエラー)',
  '  --no-codex-agent      bridge を使わず codex を直接起動する (従来の起動方法)',
  '  --no-fallback         Codex が利用上限でも subagent 代替へ切り替えず、そのまま失敗終了する',
  '  --fallback-prompt <path> 利用上限時に出力する代替プロンプトの書き出し先',
  '                        (既定: OS の一時ディレクトリ/cross-review-fallback-<pid>.md)',
  '  -h, --help            このヘルプを表示',
  '',
  'codex の起動: claude-codex-bridge の codex-agent.sh があれば経由します',
  '  (解決順は 環境変数 CROSS_REVIEW_CODEX_AGENT → ~/.claude/tools/codex-agent.sh。無ければ codex を直接起動)。',
  '  モデル・推論 effort・認証ホーム・サンドボックスは定義 ~/.claude/gpt-agents/<name>.md に従います。',
  '  bridge 経由はスクリプトが approval_policy=never を明示している場合に限ります (無ければ直接起動)。',
  '  定義の codex_sandbox が --fix の有無と食い違う場合は起動せずエラー終了します。',
  '利用上限時: Codex が利用上限に達したら subagent 代替のプロンプトをファイルへ書き出し、終了コード 75 で終わります',
  '  (--no-fallback で無効化)。',
  'レビュー観点: リポジトリ直下の .cross-review.md を読み込みます',
  '  (環境変数 CROSS_REVIEW_CHECKLIST でパス指定可。スクリプト位置からも解決。無ければ汎用観点)。',
  '差分の除外: ロックファイル・生成物 (package-lock.json / *.min.js / *.map 等) を既定で除外します',
  '  (.cross-review-ignore で追加可。環境変数 CROSS_REVIEW_IGNORE でパス指定可。--no-exclude で無効化)。',
  '',
  '例:',
  '  npm run review:codex',
  '  npm run review:codex:fix',
  '  npm run review:claude -- --uncommitted',
  '  node tools/cross-review.js codex --base develop',
  '  node tools/cross-review.js codex --fix --uncommitted --instructions notes.md',
  '      (レビュー指摘 notes.md を渡し、未コミット差分を Codex に修正させる)',
  '  node tools/cross-review.js subagent --uncommitted',
  '      (リモートコントロール用: 未コミット差分のレビュープロンプトを stdout に出力し、',
  '       Agent ツールの客観サブエージェントへ渡す)',
  '  node tools/cross-review.js codex --no-codex-agent',
  '      (bridge を使わず codex を直接起動する)',
  '  node tools/cross-review.js codex --no-fallback',
  '      (利用上限でも subagent 代替へ切り替えない)',
].join('\n');

// 非負整数として解釈できれば数値を、できなければ null を返す。
// 受理するのは数字だけからなる文字列 (前後空白は許容)。負号、小数点、指数表記、空文字は不可。
// --max-diff-kb のフラグ値と CROSS_REVIEW_MAX_DIFF_KB の解釈に共通で使う。
function parseNonNegativeInt(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

// process.argv.slice(2) を受け取り、レビュアーと差分スコープを解釈する。
function parseArgs(argv) {
  const args = argv.slice();
  const out = {
    reviewer: null,
    mode: 'base',
    baseRef: 'main',
    baseExplicit: false, // --base / --base= が指定されたか (既定 base 解決をスキップする判定に使う)
    fix: false,
    instructionsPath: null,
    maxDiffKb: null, // --max-diff-kb の値 (未指定は null。閾値の最終解決は resolveMaxDiffKb)
    maxFileDiffKb: null, // --max-file-diff-kb の値 (未指定は null。最終解決は resolveMaxFileDiffKb)
    noExclude: false, // --no-exclude で既定除外も含めすべての除外を無効化する (緊急時の逃げ道)
    // codex-agent.sh (bridge) 経由の起動設定。3 状態を 1 フィールドで表す:
    //   null   = 既定 (スクリプトがあれば bridge、無ければ直接起動)
    //   false  = --no-codex-agent (常に直接起動)
    //   文字列 = --codex-agent <name> (使う定義名を明示)
    // --codex-agent と --no-codex-agent を併記した場合は後に書いたほうが勝つ。
    codexAgent: null,
    noFallback: false, // --no-fallback で利用上限時の subagent 代替への切り替えを無効化する
    fallbackPromptPath: null, // --fallback-prompt の書き出し先 (未指定なら一時ディレクトリ)
    help: false,
    error: null,
  };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--fix') {
      out.fix = true;
    } else if (a === '--no-exclude') {
      out.noExclude = true;
    } else if (a === '--no-codex-agent') {
      out.codexAgent = false;
    } else if (a === '--no-fallback') {
      out.noFallback = true;
    } else if (a === '--codex-agent') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--codex-agent には定義名が必要です';
      } else {
        out.codexAgent = v;
        i++;
      }
    } else if (a.startsWith('--codex-agent=')) {
      const v = a.slice('--codex-agent='.length);
      if (!v) {
        out.error = '--codex-agent には定義名が必要です'; // `--codex-agent=` 空値は黙って素通りさせない。
      } else {
        out.codexAgent = v;
      }
    } else if (a === '--fallback-prompt') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--fallback-prompt にはファイルパスが必要です';
      } else {
        out.fallbackPromptPath = v;
        i++;
      }
    } else if (a.startsWith('--fallback-prompt=')) {
      const v = a.slice('--fallback-prompt='.length);
      if (!v) {
        out.error = '--fallback-prompt にはファイルパスが必要です';
      } else {
        out.fallbackPromptPath = v;
      }
    } else if (a === '--uncommitted') {
      out.mode = 'uncommitted';
    } else if (a === '--instructions') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--instructions にはファイルパスが必要です';
      } else {
        out.instructionsPath = v;
        i++;
      }
    } else if (a.startsWith('--instructions=')) {
      const v = a.slice('--instructions='.length);
      if (!v) {
        out.error = '--instructions にはファイルパスが必要です'; // `--instructions=` 空値は黙って素通りさせない。
      } else {
        out.instructionsPath = v;
      }
    } else if (a === '--base') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--base にはブランチ名が必要です';
      } else {
        out.baseRef = v;
        out.baseExplicit = true;
        i++;
      }
    } else if (a.startsWith('--base=')) {
      out.baseRef = a.slice('--base='.length);
      out.baseExplicit = true;
    } else if (a === '--max-diff-kb') {
      const v = args[i + 1];
      const n = parseNonNegativeInt(v);
      if (n == null) {
        out.error = '--max-diff-kb には 0 以上の整数を指定してください';
        // 値トークン (例: -1) が次ループで「不明なオプション」と誤判定されないよう、
        // 別フラグでない (= 値として与えられた) ものはここで消費する。
        if (v != null && !v.startsWith('--')) i++;
      } else {
        out.maxDiffKb = n;
        i++;
      }
    } else if (a.startsWith('--max-diff-kb=')) {
      const n = parseNonNegativeInt(a.slice('--max-diff-kb='.length));
      if (n == null) {
        out.error = '--max-diff-kb には 0 以上の整数を指定してください';
      } else {
        out.maxDiffKb = n;
      }
    } else if (a === '--max-file-diff-kb') {
      const v = args[i + 1];
      const n = parseNonNegativeInt(v);
      if (n == null) {
        out.error = '--max-file-diff-kb には 0 以上の整数を指定してください';
        // 値トークン (例: -1) が次ループで「不明なオプション」と誤判定されないよう消費する。
        if (v != null && !v.startsWith('--')) i++;
      } else {
        out.maxFileDiffKb = n;
        i++;
      }
    } else if (a.startsWith('--max-file-diff-kb=')) {
      const n = parseNonNegativeInt(a.slice('--max-file-diff-kb='.length));
      if (n == null) {
        out.error = '--max-file-diff-kb には 0 以上の整数を指定してください';
      } else {
        out.maxFileDiffKb = n;
      }
    } else if (a.startsWith('-')) {
      out.error = `不明なオプション: ${a}`;
    } else {
      rest.push(a);
    }
  }
  if (!out.help && !out.error) {
    out.reviewer = rest[0] || null;
    // reviewer: codex / claude は外部スタンドアロン CLI を起動する。subagent は外部 CLI を起動せず、
    // 組み立てたレビュープロンプトを stdout に出すだけ (リモートコントロール環境で codex/claude CLI を
    // spawn できないとき、その出力を Claude が Agent ツールの客観レビュー用サブエージェントへ渡す)。
    if (out.reviewer !== 'codex' && out.reviewer !== 'claude' && out.reviewer !== 'subagent') {
      out.error = `レビュアーは codex / claude / subagent を指定してください (指定: ${out.reviewer || 'なし'})`;
    } else if (out.fix && out.reviewer === 'claude') {
      // --fix は作業ツリーを書き換える。codex は workspace-write、subagent は FIX 指示付きプロンプトを出して
      // 書込権限付きサブエージェントに直させる、で対応する。claude CLI 経路 (claude -p) のみ自動修正を未配線。
      out.error = '--fix は codex か subagent のみ対応です (claude CLI 経路の自動修正は未対応)';
    } else if (typeof out.codexAgent === 'string') {
      // bridge 経由のサンドボックスは定義ファイル側の codex_sandbox で決まるので、--fix の有無と
      // 定義名が食い違うと「レビューのみなのに書き込める」「--fix なのに書けない」状態になる。
      // 既知の 2 定義に限って食い違いを弾く (それ以外の名前は利用者が用意した定義として通す)。
      if (out.codexAgent === CODEX_AGENT_REVIEW_NAME && out.fix) {
        out.error = `--codex-agent ${CODEX_AGENT_REVIEW_NAME} は読み取り専用の定義です (--fix とは併用できません)`;
      } else if (out.codexAgent === CODEX_AGENT_FIX_NAME && !out.fix) {
        out.error = `--codex-agent ${CODEX_AGENT_FIX_NAME} は書き込み可能な定義です (--fix 無しでは使えません)`;
      }
    }
  }
  return out;
}

// codex exec に渡す引数。プロンプト (観点 + 差分 + モード別指示) は末尾 '-' で stdin から読ませる。
// レビューのみは read-only でファイルを保護し、--fix のときだけ workspace-write で
// 検出事項を作業ツリーへ直接修正させる。専用サブコマンド `review` は v0.137.0 で
// `--uncommitted`/`--base` が [PROMPT] と排他になり観点チェックリストを渡せないため使わない。
// `-c approval_policy=never`: codex exec は元々非対話 (既定 approval=never) だが、ユーザの
// config.toml が on-request 等でも Claude からの自走が承認待ちで止まらないよう明示的に固定する。
function codexExecArgs(opts) {
  return [
    'exec',
    '-s', opts.fix ? 'workspace-write' : 'read-only',
    '-c', 'approval_policy=never',
    '-',
  ];
}

// git を実行し stdout を返す。テストから差し替えられるよう実体を分離する。
// opts:
//   - allowDiffExit: git diff --no-index は差分があると exit 1 を返すので許容する。
//   - allowFailure:  非ゼロ終了 (やタイムアウト) でも throw せず null を返す。fetch / rev-parse の
//                    ベストエフォート実行に使う (成功判定は戻り値が null かどうか)。
//   - timeoutMs:     spawnSync の timeout (ミリ秒)。タイムアウトすると非ゼロ終了になる。
function defaultGitRunner(args, opts) {
  const allowDiffExit = !!(opts && opts.allowDiffExit);
  const allowFailure = !!(opts && opts.allowFailure);
  const timeoutMs = opts && opts.timeoutMs;
  const spawnOpts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  if (timeoutMs) spawnOpts.timeout = timeoutMs;
  const res = spawnSync('git', args, spawnOpts);
  const ok = res.status === 0 || (allowDiffExit && res.status === 1);
  if (!ok) {
    // allowFailure 経路では、リモート無し、オフライン、タイムアウト、参照不在などを
    // 例外ではなく null で表現し、呼び出し側がベストエフォートで続行できるようにする。
    if (allowFailure) return null;
    const detail = res.stderr || (res.error && res.error.message) || `exit ${res.status}`;
    throw new Error(`git ${args.join(' ')} に失敗しました: ${detail}`);
  }
  return res.stdout || '';
}

// 差分本文と「除外したが変更のあったファイル一覧」を組み立てる。
// gitRun は (args, { allowDiffExit }) => stdout の関数。
// uncommitted では Codex の --uncommitted と揃えるため、tracked 変更に加えて
// 未追跡 (untracked) ファイルも new file 差分として含める。
// 戻り値: { diffText, excludedFiles }
//   - diffText: 除外パススペック適用後の差分本文。
//   - excludedFiles: 除外したが変更のあったファイル名一覧 (除外なし/除外ありの name-only 差集合)。
// opts.excludePathspecs があれば差分収集に渡し、加えて差集合を name-only でベストエフォート取得する
// (一覧取得は軽量な name-only。失敗時は除外一覧なしで続行)。
function collectReviewDiff(opts, gitRun) {
  // include 側は repo ルート (`:/`) を指す。これと除外側の `top` マジックワードにより、
  // cwd がリポジトリ直下でなくても差分スコープがリポ全体のまま変わらない (cwd 相対の `.` だと退行)。
  const excludeSpecs = opts.excludePathspecs || [];
  const hasExclude = excludeSpecs.length > 0;
  // name-only 一覧から「除外で落ちたファイル」を差集合で求める (ベストエフォート)。
  const diffNames = (args) => {
    try {
      const out = gitRun(args, { allowDiffExit: true });
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return null; // name-only 取得失敗時は差集合を諦める (本体の差分収集は続行)。
    }
  };
  const subtract = (full, kept) => {
    if (full == null || kept == null) return [];
    const keptSet = new Set(kept);
    return full.filter((f) => !keptSet.has(f));
  };

  if (opts.mode !== 'uncommitted') {
    const range = `${opts.baseRef}...HEAD`;
    const diffArgs = ['diff', range];
    if (hasExclude) diffArgs.push('--', ':/', ...excludeSpecs);
    const diffText = gitRun(diffArgs, { allowDiffExit: true }).replace(/\n$/, '');
    let excludedFiles = [];
    if (hasExclude) {
      const full = diffNames(['diff', '--name-only', range]);
      const kept = diffNames(['diff', '--name-only', range, '--', ':/', ...excludeSpecs]);
      excludedFiles = subtract(full, kept);
    }
    return { diffText, excludedFiles };
  }
  // --instructions の申し送りファイルが untracked のままリポジトリ内に置かれていても、
  // レビュー対象 (実コード差分) に紛れ込まないよう除外する。絶対パスで突き合わせる。
  // Windows はパスが大文字小文字を区別しないため、比較時のみ lowercase 正規化して取りこぼさない。
  const normCmp = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const excludeAbs = opts.instructionsPath ? normCmp(opts.instructionsPath) : null;
  const parts = [];
  const trackedArgs = ['diff', 'HEAD'];
  if (hasExclude) trackedArgs.push('--', ':/', ...excludeSpecs);
  const tracked = gitRun(trackedArgs, { allowDiffExit: true });
  if (tracked.trim()) parts.push(tracked.replace(/\n$/, ''));
  const lsArgs = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (hasExclude) lsArgs.push('--', ':/', ...excludeSpecs);
  const listed = gitRun(lsArgs, {});
  const untracked = listed.split('\0').filter(Boolean);
  for (const file of untracked) {
    if (excludeAbs && normCmp(file) === excludeAbs) continue; // 申し送りファイル自体は対象外。
    // /dev/null は git が全 OS で空ファイルとして解釈する。差分ありで exit 1 になる。
    const added = gitRun(['diff', '--no-index', '--', '/dev/null', file], { allowDiffExit: true });
    if (added.trim()) parts.push(added.replace(/\n$/, ''));
  }
  let excludedFiles = [];
  if (hasExclude) {
    // tracked: name-only の差集合。untracked: ls-files の差集合 (申し送りファイルは除く)。
    const trackedFull = diffNames(['diff', '--name-only', 'HEAD']);
    const trackedKept = diffNames(['diff', '--name-only', 'HEAD', '--', ':/', ...excludeSpecs]);
    const trackedExcluded = subtract(trackedFull, trackedKept);
    const fullLs = gitRun(['ls-files', '--others', '--exclude-standard', '-z'], {});
    const fullUntracked = fullLs.split('\0').filter(Boolean)
      .filter((f) => !(excludeAbs && normCmp(f) === excludeAbs));
    const keptUntracked = new Set(untracked);
    const untrackedExcluded = fullUntracked.filter((f) => !keptUntracked.has(f));
    excludedFiles = trackedExcluded.concat(untrackedExcluded);
  }
  return { diffText: parts.join('\n'), excludedFiles };
}

// 既定 base (--base 未指定、コミット済み差分モード) のとき、ローカル main が stale だと
// merge-base が古くなり HEAD 取り込み済みの main 側コミットまで差分に混入する。これを避けるため、
// origin/main をベストエフォートで取得し、解決できれば base を origin/main に切り替える。
// 解決順: fetch (ベストエフォート) → origin/main が verify できれば 'origin/main' → だめなら 'main'。
//   - opts.mode === 'uncommitted' または opts.baseExplicit のときは何もせず opts.baseRef を返す
//     (ユーザが明示した base / 未コミット差分には介入しない。fetch もしない)。
//   - 人向け通知 (fetch 失敗、origin/main 採用) は deps.err (無ければ process.stderr.write) へ。
// gitRun は (args, opts) => stdout | null の関数 (allowFailure 経路で失敗時 null)。
function resolveBaseRef(opts, gitRun, deps = {}) {
  if (opts.mode === 'uncommitted' || opts.baseExplicit) return opts.baseRef;
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  // a. origin/main をベストエフォートで取得 (10 秒タイムアウト)。失敗は警告 1 行で続行。
  // 成否は allowFailure 経路の契約「null = 失敗 / null 以外 (空文字含む) = 成功」で判定する
  // (--quiet 付き fetch は成功時 stdout が空。gitRun を差し替えるときもこの契約を守ること)。
  const fetched = gitRun(
    ['fetch', 'origin', 'main', '--quiet'],
    { allowFailure: true, timeoutMs: 10000 },
  );
  if (fetched == null) {
    writeErr('[cross-review] origin の取得に失敗しました (オフライン等)。ローカルの参照で続行します。\n');
  }
  // b. origin/main が verify できれば base に採用。
  const verified = gitRun(
    ['rev-parse', '--verify', '--quiet', 'origin/main'],
    { allowFailure: true },
  );
  if (verified != null) {
    writeErr('[cross-review] base として origin/main を使用します (--base で変更可)。\n');
    return 'origin/main';
  }
  // c. 解決できなければ従来どおりローカル main。
  return 'main';
}

// レビュー差分サイズのガード閾値 (KB) を解決する。優先順:
//   1. CLI フラグ --max-diff-kb (opts.maxDiffKb が数値なら採用)
//   2. 環境変数 CROSS_REVIEW_MAX_DIFF_KB (非負整数として解釈できれば採用。できなければ無視して次へ)
//   3. 既定 256
// 戻り値 0 は「ガード無効」を表す。
function resolveMaxDiffKb(opts, env) {
  if (opts && typeof opts.maxDiffKb === 'number') return opts.maxDiffKb;
  const e = env || process.env;
  const fromEnv = parseNonNegativeInt(e.CROSS_REVIEW_MAX_DIFF_KB);
  if (fromEnv != null) return fromEnv;
  return 256;
}

// 巨大なファイル差分を stat 要約に置換する純関数。
// diffText を `diff --git ` 行でファイル単位チャンクに分割し、チャンクのバイトサイズ (utf8) が
// maxFileDiffKb KB を超えたら、本文を「diff --git 行 + 1 行の省略注記」に置き換える。
// maxFileDiffKb が 0 なら無置換でそのまま返す。
// 戻り値: { text, replacedCount } (置換が起きたチャンク数)。
function summarizeLargeFileDiffs(diffText, maxFileDiffKb) {
  if (!maxFileDiffKb || maxFileDiffKb <= 0) return { text: diffText, replacedCount: 0 };
  if (!diffText) return { text: diffText, replacedCount: 0 };
  const limitBytes = maxFileDiffKb * 1024;
  // `diff --git ` 行の直前で分割する。先頭に `diff --git ` 以外の前置きがあれば
  // それは独立した先頭チャンク (置換対象外) として保持する。
  const lines = diffText.split('\n');
  const chunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current != null) chunks.push(current);
      current = [line];
    } else if (current == null) {
      // `diff --git ` より前の前置き行 (通常は無いが堅牢化のため)。
      current = [line];
      // この先頭チャンクは diff ヘッダを持たないので置換対象にしない印を付ける。
      current.__preamble = true;
    } else {
      current.push(line);
    }
  }
  if (current != null) chunks.push(current);

  let replacedCount = 0;
  const outChunks = chunks.map((chunkLines) => {
    const chunkText = chunkLines.join('\n');
    if (chunkLines.__preamble) return chunkText; // 前置きは置換しない。
    const header = chunkLines[0];
    if (!header || !header.startsWith('diff --git ')) return chunkText;
    const bytes = Buffer.byteLength(chunkText, 'utf8');
    if (bytes <= limitBytes) return chunkText;
    // 追加/削除行数を数える (+++ / --- のヘッダ行は除く)。
    let added = 0;
    let removed = 0;
    for (const l of chunkLines) {
      if (l.startsWith('+') && !l.startsWith('+++')) added++;
      else if (l.startsWith('-') && !l.startsWith('---')) removed++;
    }
    replacedCount++;
    const kb = (bytes / 1024).toFixed(1);
    return `${header}\n(この差分は ${kb}KB・追加 ${added} 行 / 削除 ${removed} 行のため本文を省略。レビューに必要なら作業ツリーのファイルを個別に読むこと)`;
  });
  return { text: outChunks.join('\n'), replacedCount };
}

// ファイル単位の差分置換しきい値 (KB) を解決する。優先順:
//   1. CLI フラグ --max-file-diff-kb (opts.maxFileDiffKb が数値なら採用)
//   2. 環境変数 CROSS_REVIEW_MAX_FILE_DIFF_KB (非負整数として解釈できれば採用)
//   3. 既定 64
// 戻り値 0 は「置換無効」を表す。
function resolveMaxFileDiffKb(opts, env) {
  if (opts && typeof opts.maxFileDiffKb === 'number') return opts.maxFileDiffKb;
  const e = env || process.env;
  const fromEnv = parseNonNegativeInt(e.CROSS_REVIEW_MAX_FILE_DIFF_KB);
  if (fromEnv != null) return fromEnv;
  return 64;
}

// レビュアーへ渡すプロンプト (観点 + スコープ + モード別指示 + 申し送り + 差分本文)。
// codex / claude / subagent 共通 (codex/claude は stdin、subagent は stdout へ出す)。
// opts.fix で「修正まで依頼」と「レビューのみ」を切り替える。
// checklist は loadChecklist() の戻り値 (未指定/空なら GENERIC_CHECKLIST を使う)。
// instructions は --instructions の本文 (任意)。観点とは別に「重点指摘」として添える。
// excludedFiles は「除外したが変更のあったファイル名一覧」(任意)。1 件以上あればプロンプトに枠を足す。
function buildReviewPrompt(diffText, opts, checklist, instructions, excludedFiles) {
  const reviewPoints = (checklist != null && String(checklist).trim())
    ? checklist
    : GENERIC_CHECKLIST;
  const scope = opts.mode === 'uncommitted'
    ? '未コミットの作業ツリー差分 (tracked: git diff HEAD ＋ untracked 新規ファイル)'
    : `現在のブランチと ${opts.baseRef} の差分 (git diff ${opts.baseRef}...HEAD)`;
  const parts = [
    reviewPoints,
    '',
    `レビュー対象: ${scope}`,
    // 同一内容に二重にトークンを使わせないため、差分の再取得を抑止する枠付け。
    '差分本文はこのプロンプトに全文含まれている。git diff やファイル全文の再取得はしないこと（同じ内容に二重にトークンを使わない）。',
    '文脈の補完は、差分の周辺コード・呼び出し元・関連定義の確認など必要最小限に限定すること。',
    '（除外・省略されたファイルを読む必要があると判断した場合はこの限りではない）',
    '',
    opts.fix ? FIX_INSTRUCTION : REVIEW_ONLY_INSTRUCTION,
  ];
  if (instructions != null && String(instructions).trim()) {
    parts.push('', REVIEWER_NOTES_HEADER, String(instructions).trim());
  }
  if (Array.isArray(excludedFiles) && excludedFiles.length > 0) {
    parts.push(
      '',
      '【レビュー対象外（除外済み）の変更ファイル】',
      '以下は生成物・ロックファイル等として差分本文から除外した。必要と判断した場合のみ個別に読むこと:',
      excludedFiles.map((f) => `- ${f}`).join('\n'),
    );
  }
  parts.push('', '--- DIFF START ---', diffText, '--- DIFF END ---');
  return parts.join('\n');
}

// claude-codex-bridge の起動スクリプト (codex-agent.sh) のパスを解決する。解決順は:
//   1. 環境変数 CROSS_REVIEW_CODEX_AGENT (パス)
//   2. <ホーム>/.claude/tools/codex-agent.sh
// どちらも無ければ null (呼び出し側は codex を直接起動する)。
// 明示指定 (env) が解決できないときは、黙って既定パスへ落ちず警告する
// (観点ファイルの解決と同じ流儀。誤ったパスで意図しない起動経路になる運用事故を検知するため)。
// deps で env / homedir / 存在確認 / 警告出力を差し替え可能にする (テスト用)。
function resolveCodexAgentScript(deps = {}) {
  const env = deps.env || process.env;
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  const home = deps.homedir || os.homedir();
  const envPath = env.CROSS_REVIEW_CODEX_AGENT || '';
  const candidates = [];
  if (envPath) candidates.push(envPath);
  candidates.push(path.join(home, ...CODEX_AGENT_SCRIPT_SUBPATH));
  for (const p of candidates) {
    let found = false;
    try {
      found = !!exists(p);
    } catch {
      found = false; // 存在確認が失敗したら次の候補 / 直接起動へ進む。
    }
    if (found) return p;
    if (envPath && p === envPath) {
      warn(`[cross-review] CROSS_REVIEW_CODEX_AGENT=${envPath} が見つかりません。既定パスへフォールバックします。\n`);
    }
  }
  return null;
}

// bridge 経由で使う定義名を決める。--codex-agent で明示されていればそれ、無ければ
// --fix の有無で read-only (codex-review) と workspace-write (codex-subagent) を選び分ける。
function codexAgentNameFor(opts) {
  if (typeof opts.codexAgent === 'string') return opts.codexAgent;
  return opts.fix ? CODEX_AGENT_FIX_NAME : CODEX_AGENT_REVIEW_NAME;
}

// 定義ファイルのフロントマター (先頭行の `---` から次の `---` まで) から 1 キーの値を取り出す。
// 解釈は codex-agent.sh の fm_get と揃える:
//   - 前方一致した最初の行だけを使う (`<key>:` は行頭から)
//   - `key:` 直後の空白を落とし、そのあとに続く「空白 + #」以降を行末コメントとして落とす
//     (値の内部の # は残す)
//   - 前後の空白と、値全体を囲む引用符を除く
// 先頭行が `---` でなければフロントマター無しとみなして null を返す。キーが無いときも null。
function frontMatterValue(text, key) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const prefix = `${key}:`;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') break;
    if (!line.startsWith(prefix)) continue;
    let raw = line.slice(prefix.length).replace(/^[ \t]*/, '');
    raw = raw.replace(/[ \t][ \t]*#.*$/, '').trim();
    if (raw.length >= 2
      && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      raw = raw.slice(1, -1);
    }
    return raw;
  }
  return null;
}

// 定義ファイル本文から codex_sandbox を読む。キーが無い、値が空、フロントマターが無い場合は
// bridge 側と同じ既定 (read-only) を返す。
function codexAgentSandboxOf(text) {
  const value = frontMatterValue(text, 'codex_sandbox');
  return value ? value : CODEX_SANDBOX_READ_ONLY;
}

// 定義ファイル (.claude/gpt-agents/<name>.md) を bridge と同じ順で探して本文を返す。
// どこにも無い / 読めない場合は null (呼び出し側は検査せず bridge に委ねる)。
// deps で cwd / homedir / 存在確認 / 読み込みを差し替え可能にする (テスト用)。
function readCodexAgentDefinition(name, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const home = deps.homedir || os.homedir();
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  for (const dir of [cwd, home]) {
    const defPath = path.join(dir, ...CODEX_AGENT_DEF_SUBDIR, `${name}.md`);
    let present = false;
    try {
      present = !!exists(defPath);
    } catch {
      present = false; // 存在確認そのものの失敗は「無い」と同じ扱い (bridge 側の検査に委ねる)。
    }
    if (!present) continue;
    // 存在するのに読めない定義は「無い」と同じにしない。bridge はその定義で起動するため、
    // 検証できないまま起動したり、別候補 (ホーム側) を検証して安全と見なしたりできない。
    try {
      return { path: defPath, text: readFile(defPath) };
    } catch (err) {
      return { path: defPath, error: (err && err.message) || 'read error' };
    }
  }
  return null;
}

// 定義ファイルの codex_sandbox が --fix の有無と一致するかを判定する純粋関数。
// レビューのみ (--fix 無し) は read-only、--fix は workspace-write でなければならない。
// bridge 経由ではサンドボックスを決めるのが定義ファイルなので、定義名が既定か明示かに関わらず
// 起動前にここで突き合わせる (利用者が定義ファイルの中身を変えている可能性があるため)。
function checkCodexAgentSandbox({ fix, sandbox } = {}) {
  const expected = fix ? CODEX_SANDBOX_WORKSPACE_WRITE : CODEX_SANDBOX_READ_ONLY;
  return { ok: sandbox === expected, expected, actual: sandbox };
}

// codex-agent.sh が承認方針を never に固定しているかを判定する純粋関数。
// スクリプトが codex への追加引数を受け付けない以上、この明示が無ければ承認方針は
// codex の config.toml 次第になり、「Codex の承認は never 固定」を保証できない。
// 文字列の存在ではなく「コメント行を除いた本文に、-c の引数として approval_policy=never が
// 書かれている」ことを要求する (コメントや TODO に書かれているだけでは起動引数に乗らないため)。
// 引用符の有無 (-c approval_policy=never / -c "approval_policy=never" / -c 'approval_policy=never')
// は問わない。
const APPROVAL_NEVER_ARG_PATTERN = /(^|\s)-c\s+["']?approval_policy=never["']?(\s|$)/m;
function scriptPinsApprovalNever(text) {
  const withoutComments = String(text == null ? '' : text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  return APPROVAL_NEVER_ARG_PATTERN.test(withoutComments);
}

// bridge (codex-agent.sh) 経由の起動を組み立てる。起動前に 2 つの不変条件を確かめる:
//   - 承認は never 固定: スクリプトが approval_policy=never を明示していること。
//     明示が無い、またはスクリプトを読めない場合は null を返し、呼び出し側は直接起動へ戻す
//     (直接起動なら -c approval_policy=never を自分で渡せる)。
//   - サンドボックス: 定義ファイルの codex_sandbox が --fix の有無と一致すること。
//     食い違う場合は { error } を返し、レビュアーを起動させない。
// 定義ファイルが見つからないときは検査せず bridge に委ねる (bridge が終了コード 3 で未導入を
// 知らせ、呼び出し側が直接起動へ戻る)。
function codexAgentInvocation(script, opts, deps = {}) {
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const warn = deps.warn || ((m) => process.stderr.write(m));
  let scriptText;
  try {
    scriptText = readFile(script);
  } catch (err) {
    warn(`[cross-review] codex-agent.sh を読めないため直接起動へ切り替えます: ${script} (${(err && err.message) || 'read error'})\n`);
    return null;
  }
  if (!scriptPinsApprovalNever(scriptText)) {
    warn(`[cross-review] codex-agent.sh が ${APPROVAL_NEVER_MARKER} を明示していないため直接起動へ切り替えます (claude-codex-bridge #16 を参照)\n`);
    return null;
  }
  const agentName = codexAgentNameFor(opts);
  const def = readCodexAgentDefinition(agentName, deps);
  if (def && def.error) {
    return { error: `定義 ${agentName} を読めないため起動しません (${def.error}): ${def.path}` };
  }
  if (def) {
    const check = checkCodexAgentSandbox({ fix: opts.fix, sandbox: codexAgentSandboxOf(def.text) });
    if (!check.ok) {
      return {
        error: `定義 ${agentName} の codex_sandbox が ${check.actual} です`
          + ` (${opts.fix ? '--fix では' : 'レビューのみでは'} ${check.expected} が必要): ${def.path}`,
      };
    }
  }
  const cwd = deps.cwd || process.cwd();
  // codex-agent.sh は依頼文を stdin から読み、定義ファイルのフロントマターに従って
  // CODEX_HOME / モデル / effort / サンドボックスを決めて codex exec を起動する。
  return {
    cmd: 'bash',
    args: [script, agentName, '-C', cwd],
    via: 'agent',
    agentName,
    scriptPath: script,
    notice: opts.fix
      ? `Codex にレビュー + 検出事項の修正を依頼します (作業ツリーを編集します): codex-agent.sh 経由 (定義: ${agentName})\n`
      : `Codex でレビューを実行します: codex-agent.sh 経由 (定義: ${agentName})\n`,
  };
}

// reviewer / fix から「起動コマンド、引数、端末通知」を決める純粋関数。
// 主変更点 (どのレビュアーをどのサンドボックスで呼ぶか) を spawn 抜きで検証できるよう、
// runReview の配線部分を分離する。stdin に渡すプロンプトは prompt をそのまま使う。
// codex は codex-agent.sh (bridge) があればそれを経由し (via: 'agent')、無ければ
// codex を直接起動する (via: 'direct')。via は利用上限の判定 (isUsageLimitExit) と
// bridge 未導入時の再起動判断に使う。deps は resolveCodexAgentScript / codexAgentInvocation へ
// 渡す (env / homedir / exists / readFile / warn) ほか、bridge へ渡す作業ディレクトリ
// (deps.cwd) を差し替える。
// 戻り値に error があるときは起動してはいけない (呼び出し側がエラー終了する)。
function reviewerInvocation(opts, deps = {}) {
  if (opts.reviewer === 'codex') {
    // --no-codex-agent (codexAgent === false) は解決自体を行わず、常に直接起動する。
    const script = opts.codexAgent === false ? null : resolveCodexAgentScript(deps);
    // bridge 経由が不変条件 (承認 never 固定) を満たせないときは null が返るので直接起動へ落ちる。
    const agentInv = script ? codexAgentInvocation(script, opts, deps) : null;
    if (agentInv) return agentInv;
    return {
      cmd: 'codex',
      args: codexExecArgs(opts),
      via: 'direct',
      notice: opts.fix
        ? 'Codex にレビュー + 検出事項の修正を依頼します (作業ツリーを編集します)...\n'
        : 'Codex でレビューを実行します...\n',
    };
  }
  if (opts.reviewer === 'subagent') {
    // 外部 CLI を起動しない (emit:true)。組み立てたレビュープロンプトを stdout に出すだけで、
    // 実際のレビューは呼び出し側 (Claude) が Agent ツールで起動する客観サブエージェントが行う。
    // リモートコントロール環境 (codex/claude CLI を spawn できない) のフォールバック。
    return {
      emit: true,
      notice: opts.fix
        ? 'リモートコントロール用: レビュー + 修正プロンプトを stdout に出力します (書込権限付きの客観サブエージェントへ渡してください)。\n'
        : 'リモートコントロール用: レビュープロンプトを stdout に出力します (客観サブエージェントへ渡してください)。\n',
    };
  }
  return { cmd: 'claude', args: ['-p'], notice: 'Claude でレビューを実行します...\n' };
}

function isPathLikeCommand(cmd) {
  return path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\');
}

function isDirectWindowsExecutable(cmd) {
  return ['.exe', '.com'].includes(path.extname(cmd).toLowerCase());
}

function isWindowsShellWrapper(cmd) {
  return ['.cmd', '.bat'].includes(path.extname(cmd).toLowerCase());
}

function defaultWindowsCommandLookup(cmd) {
  const res = spawnSync('where.exe', [cmd], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// Windows では PowerShell の Get-Command が .ps1 shim を返すことがある一方、
// where.exe では実行可能な .exe も見えることがある。直接起動できる .exe/.com を優先し、
// 見つからない場合だけ shell 経由にフォールバックする。これにより claude.exe 環境では
// shell:true と args の組み合わせに対する Node の警告を避けられる。
function resolveReviewerCommandForSpawn(cmd, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return { cmd, shell: false };
  if (isPathLikeCommand(cmd)) {
    return { cmd, shell: !isDirectWindowsExecutable(cmd) };
  }

  const lookup = deps.lookup || defaultWindowsCommandLookup;
  const candidates = lookup(cmd);
  const direct = candidates.find(isDirectWindowsExecutable);
  if (direct) return { cmd: direct, shell: false };

  const shellWrapper = candidates.find(isWindowsShellWrapper);
  if (shellWrapper) return { cmd: shellWrapper, shell: true };

  // .ps1 は cmd.exe では直接実行できないため、このフォールバックは環境依存。
  // npm グローバルインストールは通常 .cmd shim も作るので、実運用ではまずそこを使う。
  return { cmd: candidates[0] || cmd, shell: true };
}

// レビュアー CLI を起動し、stdin にプロンプトを流し込む。出力は端末へそのまま流す。
// Windows では起動直前に where.exe で実体を解決し、可能なら shell を使わずに起動する。
// stdio を pipe にするのは、端末へ転送しつつ末尾を保持して利用上限の判定に使うため
// (受け取った塊をそのまま書き出すので、見た目は stdio:'inherit' と変わらない)。
// onExit は終了時に 1 回だけ { code, outputTail, error } で呼ぶ (runReview が上限判定に使う)。
function spawnReviewer(cmd, args, stdinText, onExit) {
  const resolved = resolveReviewerCommandForSpawn(cmd);
  const child = spawn(resolved.cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Windows では .cmd/.bat shim のことがあるため、その場合だけ shell 経由にする。
    shell: resolved.shell,
  });
  // 末尾のみ保持する。判定に使う語 (usage limit 等) は ASCII なので、塊の境界で
  // マルチバイト文字が割れても判定には影響しない。転送側は Buffer のまま書いてバイト列を保つ。
  let outputTail = '';
  const forward = (stream, sink) => {
    if (!stream) return;
    stream.on('data', (chunk) => {
      sink.write(chunk);
      outputTail += chunk.toString('utf8');
      if (outputTail.length > OUTPUT_TAIL_LIMIT) outputTail = outputTail.slice(-OUTPUT_TAIL_LIMIT);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  let settled = false;
  const finish = (code, error) => {
    if (settled) return; // error → close の順で両方発火することがあるため 1 回に絞る。
    settled = true;
    process.exitCode = code == null ? 1 : code;
    if (typeof onExit === 'function') onExit({ code, outputTail, error: error || null });
  };
  child.on('error', (err) => {
    if (err && err.code === 'ENOENT') {
      process.stderr.write(`${cmd} CLI が見つかりません。PATH に ${cmd} を通してください。\n`);
    } else {
      process.stderr.write(`${cmd} の起動に失敗しました: ${err && err.message}\n`);
    }
    finish(1, err);
  });
  // 'exit' ではなく 'close' を待つ。pipe した stdout/stderr を読み切ってから判定するため。
  child.on('close', (code) => {
    finish(code, null);
  });
  if (child.stdin) {
    // 相手がプロンプトを読み切らずに終了することがある (bridge が定義不備で早期終了する等)。
    // その場合 stdin が EPIPE で error を出すので、握りつぶして終了コード側で判断する
    // (未処理の error イベントにすると、フォールバックの前にこのプロセスごと落ちる)。
    child.stdin.on('error', () => {});
    child.stdin.write(stdinText);
    child.stdin.end();
  }
  return child;
}

// レビュアーの終了が「Codex の利用上限」かどうかを判定する純粋関数。
//   - bridge 経由 (via: 'agent') は codex-agent.sh が上限を終了コード 75 に写像するのでそれだけを見る。
//   - 直接起動 (via: 'direct') は終了コードに上限専用の値が無いため、非ゼロ終了かつ
//     出力の末尾に上限を示す語があるときに限って上限と判定する。
// 正常終了 (0) とシグナル終了 (code == null) は上限として扱わない。
function isUsageLimitExit(result) {
  const { via, code, outputTail } = result || {};
  if (via === 'agent') return code === USAGE_LIMIT_EXIT_CODE;
  if (code === 0 || code == null) return false;
  return USAGE_LIMIT_PATTERN.test(String(outputTail || ''));
}

// 利用上限時に出す代替プロンプトの書き出し先を決める。--fallback-prompt があればそれ、
// 無ければ一時ディレクトリに pid 付きのファイル名を作る (同時実行でぶつからないように)。
function resolveFallbackPromptPath(opts, deps = {}) {
  if (opts && opts.fallbackPromptPath) return opts.fallbackPromptPath;
  const tmp = deps.tmpdir || os.tmpdir();
  const pid = deps.pid || process.pid;
  return path.join(tmp, `cross-review-fallback-${pid}.md`);
}

// 利用上限時のフォールバック。subagent 経路と同じプロンプト本文をファイルへ書き出し、
// 次に何をすればよいかを stderr に出して終了コードを 75 にする。
// stdout はレビュアーの出力で使われているので、プロンプト本文を stdout に混ぜない。
// 戻り値は書き出したパス (書けなければ null)。
function emitFallbackPrompt(prompt, opts, deps = {}) {
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const writeFile = deps.writeFile || ((p, body) => fs.writeFileSync(p, body, 'utf8'));
  const promptPath = resolveFallbackPromptPath(opts, deps);
  try {
    writeFile(promptPath, `${prompt}\n`);
  } catch (err) {
    writeErr(`[cross-review] 代替プロンプトを書き出せません: ${promptPath} (${(err && err.message) || 'write error'})\n`);
    process.exitCode = 1;
    return null;
  }
  writeErr(
    `[cross-review] Codex の利用上限のため subagent 代替に切り替えます。プロンプト: ${promptPath}\n`
    + '  その内容を Claude の客観サブエージェント (読み取り専用。--fix 時は書込権限付き) へ渡してください。\n'
    + '  PR コメントには「Codex を直接実行できないため (利用上限) subagent 代替で確認した」と残してください。\n',
  );
  process.exitCode = USAGE_LIMIT_EXIT_CODE;
  return promptPath;
}

// deps で gitRun / spawnFn を差し替え可能にする (テストから stdin 本文まで検証するため)。
// 既定は実 git / 実 spawn。codex 経路でも「観点 + 差分本文 + モード指示」を stdin に渡すのが
// 中核なので、その配線を結合テストで固定できるようにする。
function runReview(opts, deps = {}) {
  const gitRun = deps.gitRun || defaultGitRunner;
  const spawnFn = deps.spawnFn || spawnReviewer;
  // 人向け通知は writeErr、機械が拾う本文 (subagent のプロンプト) は writeOut に分離する。
  // deps.out / deps.err で差し替え可能にし、subagent 経路の stdout 本文をテストから検証する。
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  // 観点は deps.checklist 指定があれば優先、無ければ .cross-review.md / 汎用観点を解決する。
  const checklist = deps.checklist != null ? deps.checklist : loadChecklist(deps);
  // 申し送り (--instructions) は観点とは別系統。deps.instructions 指定があれば優先、
  // 無ければ opts.instructionsPath からファイルを読む (読めなければエラー終了)。
  let instructions = deps.instructions != null ? deps.instructions : null;
  if (instructions == null && opts.instructionsPath) {
    try {
      instructions = loadInstructions(opts.instructionsPath, deps);
    } catch (err) {
      writeErr(`--instructions のファイルを読めません: ${opts.instructionsPath} (${(err && err.message) || 'read error'})\n`);
      process.exitCode = 1;
      return null;
    }
  }
  // 既定 base (--base 未指定、コミット済み差分) のときは origin/main を優先解決する
  // (ローカル main が stale だと無関係な差分が混入するため)。opts を直接書き換えず、
  // 解決後の base を以降のスコープ表記、差分収集で使う。
  const resolvedBaseRef = resolveBaseRef(opts, gitRun, deps);
  // 除外パススペックを解決する (--no-exclude 指定時は無効化)。観点と同じ流儀で .cross-review-ignore を読む。
  const excludePatterns = opts.noExclude
    ? []
    : (deps.ignorePatterns != null ? deps.ignorePatterns : loadIgnorePatterns(deps));
  const excludePathspecs = toExcludePathspecs(excludePatterns);
  const baseChanged = resolvedBaseRef !== opts.baseRef;
  const resolvedOpts = (baseChanged || excludePathspecs.length > 0)
    ? { ...opts, baseRef: resolvedBaseRef, excludePathspecs }
    : opts;
  // どのレビュアー (codex / claude / subagent) も自前で差分を取り出し、プロンプトへ同梱する (untracked も含める)。
  let diffText;
  let excludedFiles = [];
  try {
    const collected = collectReviewDiff(resolvedOpts, gitRun);
    diffText = collected.diffText.trim();
    excludedFiles = collected.excludedFiles || [];
  } catch (err) {
    writeErr(`${(err && err.message) || 'git の実行に失敗しました'}\n`);
    process.exitCode = 1;
    return null;
  }
  if (!diffText) {
    // subagent は stdout を「サブエージェントへ渡すプロンプト」専用にするため、差分なしの通知も
    // stderr 側へ出す (stdout は空のまま保ち、空通知をプロンプトと誤認させない)。codex/claude は従来どおり stdout。
    (opts.reviewer === 'subagent' ? writeErr : writeOut)('レビュー対象の差分がありません。\n');
    return null;
  }
  // 巨大なファイル差分を stat 要約へ置換する (全体ガードの前に行う = 置換で縮んだ分はガードに掛からない)。
  const maxFileDiffKb = resolveMaxFileDiffKb(opts, deps.env);
  const summarized = summarizeLargeFileDiffs(diffText, maxFileDiffKb);
  diffText = summarized.text;
  if (summarized.replacedCount > 0) {
    writeErr(`[cross-review] 大きなファイル差分 ${summarized.replacedCount} 件を要約に置換しました (--max-file-diff-kb で調整可)\n`);
  }
  // 差分サイズを常に表示し、閾値超過ならレビュアーを起動せず中断する (トークン浪費、stale base 検知)。
  const diffBytes = Buffer.byteLength(diffText, 'utf8');
  const diffKb = diffBytes / 1024;
  writeErr(`[cross-review] レビュー差分サイズ: ${diffKb.toFixed(1)}KB\n`);
  const maxDiffKb = resolveMaxDiffKb(opts, deps.env);
  if (maxDiffKb > 0 && diffKb > maxDiffKb) {
    writeErr(
      `[cross-review] レビュー差分が閾値 ${maxDiffKb}KB を超えました (${diffKb.toFixed(1)}KB)。レビュアーを起動せず中断します。\n`
      + '  考えられる原因: ローカル main が stale (git fetch origin main 後に再実行 / --base origin/main を明示)、生成物・lock ファイルの混入。\n'
      + '  意図的に大きい差分なら --max-diff-kb <n> を引き上げるか --max-diff-kb 0 でガードを無効化してください。\n',
    );
    process.exitCode = 1;
    return null;
  }
  const prompt = buildReviewPrompt(diffText, resolvedOpts, checklist, instructions, excludedFiles);
  // reviewerInvocation も解決後の opts で揃える (現状 baseRef は参照しないが、プロンプトの
  // スコープ表記と起動引数が将来食い違わないよう、解決後の値だけを下流に渡す)。
  // bridge の解決で出る警告は、他の通知と同じ stderr の出口 (writeErr) へ流す。
  const invDeps = deps.warn ? deps : { ...deps, warn: writeErr };
  const inv = reviewerInvocation(resolvedOpts, invDeps);
  if (inv.error) {
    // 定義ファイルの codex_sandbox が --fix の有無と食い違う。レビューのみで書き込み可能な
    // 定義を使わせないため、レビュアーを起動せずエラー終了する (引数エラーと同じ終了コード 2)。
    writeErr(`[cross-review] ${inv.error}\n`
      + '  定義ファイルの codex_sandbox を直すか、--codex-agent で適切な定義を指定してください。\n');
    process.exitCode = 2;
    return null;
  }
  if (inv.emit) {
    // subagent: 外部プロセスを起動せず、組み立てたプロンプト本文だけを stdout に出す。
    // 通知は stderr に分けて、stdout を「そのまま客観サブエージェントへ渡せるプロンプト」に保つ。
    writeErr(inv.notice);
    writeOut(prompt + '\n');
    return null;
  }
  // レビュアーを起動し、終了コードで「bridge 未導入」「利用上限」を切り分ける。
  // 起動を関数にするのは、bridge 未導入のときに同じプロンプトで直接起動をやり直すため。
  const start = (invocation) => {
    writeOut(invocation.notice);
    return spawnFn(invocation.cmd, invocation.args, prompt, (result) => {
      const exit = result || {};
      // 上限フォールバックと bridge の切り替えは codex 経路だけの仕組み
      // (claude CLI 経路は対象外。subagent はここに来ない)。
      if (resolvedOpts.reviewer !== 'codex') return;
      // bridge が未導入 (codex コマンドや定義が無い)、または bash 自体が無い場合は直接起動へ戻す。
      const bridgeUnavailable = exit.code === CODEX_AGENT_EXIT_MISSING
        || (exit.error && exit.error.code === 'ENOENT');
      if (invocation.via === 'agent' && bridgeUnavailable) {
        writeErr('[cross-review] bridge が未導入のため直接起動へ切り替えます。\n');
        start(reviewerInvocation({ ...resolvedOpts, codexAgent: false }, invDeps));
        return;
      }
      if (opts.noFallback) return; // --no-fallback は従来どおり失敗終了 (終了コードはそのまま)。
      if (!isUsageLimitExit({ via: invocation.via, code: exit.code, outputTail: exit.outputTail })) return;
      emitFallbackPrompt(prompt, opts, {
        err: writeErr,
        writeFile: deps.writeFile,
        tmpdir: deps.tmpdir,
        pid: deps.pid,
      });
    });
  };
  return start(inv);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (opts.error) {
    process.stderr.write(`${opts.error}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  runReview(opts);
}

module.exports = {
  parseArgs,
  codexExecArgs,
  reviewerInvocation,
  resolveCodexAgentScript,
  codexAgentNameFor,
  codexAgentInvocation,
  frontMatterValue,
  codexAgentSandboxOf,
  readCodexAgentDefinition,
  checkCodexAgentSandbox,
  scriptPinsApprovalNever,
  isUsageLimitExit,
  resolveFallbackPromptPath,
  emitFallbackPrompt,
  collectReviewDiff,
  resolveBaseRef,
  resolveMaxDiffKb,
  resolveMaxFileDiffKb,
  summarizeLargeFileDiffs,
  buildReviewPrompt,
  runReview,
  loadChecklist,
  loadInstructions,
  loadIgnorePatterns,
  toExcludePathspecs,
  resolveReviewerCommandForSpawn,
  CHECKLIST_FILENAME,
  IGNORE_FILENAME,
  CODEX_AGENT_REVIEW_NAME,
  CODEX_AGENT_FIX_NAME,
  CODEX_AGENT_EXIT_MISSING,
  CODEX_SANDBOX_READ_ONLY,
  CODEX_SANDBOX_WORKSPACE_WRITE,
  USAGE_LIMIT_EXIT_CODE,
  DEFAULT_EXCLUDE_PATTERNS,
  GENERIC_CHECKLIST,
  REVIEW_ONLY_INSTRUCTION,
  FIX_INSTRUCTION,
  REVIEWER_NOTES_HEADER,
};

if (require.main === module) main();
