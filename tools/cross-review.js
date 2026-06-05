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
//   node tools/cross-review.js codex --fix      # Codex がレビューに加え検出事項を直接修正 (作業ツリー編集)
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
//   修正させる (相互レビューフローの 3B「レビュー + 修正を依頼」)。claude 側の自動修正は未対応。
// - プロジェクト固有のレビュー観点は、リポジトリ直下の `.cross-review.md` を単一ソースとして
//   読み込み、両レビュアーへ同じチェックリストとして添える (無ければ汎用観点 GENERIC_CHECKLIST へ
//   フォールバック)。この CLI は engine 部分が完全に汎用なので、他リポへ `tools/cross-review.js` を
//   コピーし `.cross-review.md` を置くだけで観点を差し替えて再利用できる。観点を更新したら
//   `.cross-review.md` を直す。
// - claude の --uncommitted は Codex の --uncommitted (staged+unstaged+untracked) と結果を
//   揃えるため、tracked 変更 (git diff HEAD) に加えて未追跡ファイルも new file 差分として含める。
// - 前提: codex / claude の「スタンドアロン CLI」が PATH にあること
//   (VS Code プラグイン / デスクトップアプリとは別物)。Claude Code から実行する場合は
//   codex がネットワークを使うため Bash をサンドボックス無効で起動する (docs/cross-review.md 参照)。

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// レビュー観点はプロジェクト固有なので、リポジトリ直下の `.cross-review.md` を単一ソースとして
// 読み込む。この CLI を他リポへコピーしても `.cross-review.md` を置くだけで観点を差し替えられる。
// 解決順は loadChecklist 参照: 環境変数 CROSS_REVIEW_CHECKLIST(パス) → <cwd>/.cross-review.md →
// <スクリプト>/../.cross-review.md → GENERIC_CHECKLIST。このリポジトリの観点は `.cross-review.md` にある。
const CHECKLIST_FILENAME = '.cross-review.md';

// `.cross-review.md` が無いときの汎用フォールバック観点。特定リポに依存しない一般論のみ。
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

const USAGE = [
  'Claude ↔ Codex 相互レビュー CLI ブリッジ',
  '',
  '使い方: node tools/cross-review.js <codex|claude> [options]',
  '',
  'options:',
  '  --fix             検出事項を作業ツリーへ直接修正させる (codex のみ。-s workspace-write)',
  '  --uncommitted     未コミットの作業ツリー差分 (tracked + untracked) をレビュー',
  '  --base <ref>      比較先ブランチを指定 (既定: main)',
  '  -h, --help        このヘルプを表示',
  '',
  'レビュー観点: リポジトリ直下の .cross-review.md を読み込みます',
  '  (環境変数 CROSS_REVIEW_CHECKLIST でパス指定可。スクリプト位置からも解決。無ければ汎用観点)。',
  '',
  '例:',
  '  npm run review:codex',
  '  npm run review:codex:fix',
  '  npm run review:claude -- --uncommitted',
  '  node tools/cross-review.js codex --base develop',
].join('\n');

// process.argv.slice(2) を受け取り、レビュアーと差分スコープを解釈する。
function parseArgs(argv) {
  const args = argv.slice();
  const out = { reviewer: null, mode: 'base', baseRef: 'main', fix: false, help: false, error: null };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--fix') {
      out.fix = true;
    } else if (a === '--uncommitted') {
      out.mode = 'uncommitted';
    } else if (a === '--base') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) {
        out.error = '--base にはブランチ名が必要です';
      } else {
        out.baseRef = v;
        i++;
      }
    } else if (a.startsWith('--base=')) {
      out.baseRef = a.slice('--base='.length);
    } else if (a.startsWith('-')) {
      out.error = `不明なオプション: ${a}`;
    } else {
      rest.push(a);
    }
  }
  if (!out.help && !out.error) {
    out.reviewer = rest[0] || null;
    if (out.reviewer !== 'codex' && out.reviewer !== 'claude') {
      out.error = `レビュアーは codex か claude を指定してください (指定: ${out.reviewer || 'なし'})`;
    } else if (out.fix && out.reviewer !== 'codex') {
      out.error = '--fix は codex のみ対応です (claude 側の自動修正は未対応)';
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
// git diff --no-index は差分があると exit 1 を返すので allowDiffExit で許容する。
function defaultGitRunner(args, opts) {
  const allowDiffExit = !!(opts && opts.allowDiffExit);
  const res = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ok = res.status === 0 || (allowDiffExit && res.status === 1);
  if (!ok) {
    const detail = res.stderr || `exit ${res.status}`;
    throw new Error(`git ${args.join(' ')} に失敗しました: ${detail}`);
  }
  return res.stdout || '';
}

// claude へ渡す差分本文を組み立てる。gitRun は (args, { allowDiffExit }) => stdout の関数。
// uncommitted では Codex の --uncommitted と揃えるため、tracked 変更に加えて
// 未追跡 (untracked) ファイルも new file 差分として含める。
function collectReviewDiff(opts, gitRun) {
  if (opts.mode !== 'uncommitted') {
    return gitRun(['diff', `${opts.baseRef}...HEAD`], { allowDiffExit: true }).replace(/\n$/, '');
  }
  const parts = [];
  const tracked = gitRun(['diff', 'HEAD'], { allowDiffExit: true });
  if (tracked.trim()) parts.push(tracked.replace(/\n$/, ''));
  const listed = gitRun(['ls-files', '--others', '--exclude-standard', '-z'], {});
  const untracked = listed.split('\0').filter(Boolean);
  for (const file of untracked) {
    // /dev/null は git が全 OS で空ファイルとして解釈する。差分ありで exit 1 になる。
    const added = gitRun(['diff', '--no-index', '--', '/dev/null', file], { allowDiffExit: true });
    if (added.trim()) parts.push(added.replace(/\n$/, ''));
  }
  return parts.join('\n');
}

// レビュアー CLI へ渡すプロンプト (観点 + スコープ + モード別指示 + 差分本文)。
// codex / claude 共通。opts.fix で「修正まで依頼」と「レビューのみ」を切り替える。
// checklist は loadChecklist() の戻り値 (未指定/空なら GENERIC_CHECKLIST を使う)。
function buildReviewPrompt(diffText, opts, checklist) {
  const reviewPoints = (checklist != null && String(checklist).trim())
    ? checklist
    : GENERIC_CHECKLIST;
  const scope = opts.mode === 'uncommitted'
    ? '未コミットの作業ツリー差分 (tracked: git diff HEAD ＋ untracked 新規ファイル)'
    : `現在のブランチと ${opts.baseRef} の差分 (git diff ${opts.baseRef}...HEAD)`;
  return [
    reviewPoints,
    '',
    `レビュー対象: ${scope}`,
    '必要なら作業ディレクトリのファイルを読んで文脈を補ってください。',
    '',
    opts.fix ? FIX_INSTRUCTION : REVIEW_ONLY_INSTRUCTION,
    '',
    '--- DIFF START ---',
    diffText,
    '--- DIFF END ---',
  ].join('\n');
}

// reviewer / fix から「起動コマンド・引数・端末通知」を決める純粋関数。
// 主変更点 (どのレビュアーをどのサンドボックスで呼ぶか) を spawn 抜きで検証できるよう、
// runReview の配線部分を分離する。stdin に渡すプロンプトは prompt をそのまま使う。
function reviewerInvocation(opts) {
  if (opts.reviewer === 'codex') {
    return {
      cmd: 'codex',
      args: codexExecArgs(opts),
      notice: opts.fix
        ? 'Codex にレビュー + 検出事項の修正を依頼します (作業ツリーを編集します)...\n'
        : 'Codex でレビューを実行します...\n',
    };
  }
  return { cmd: 'claude', args: ['-p'], notice: 'Claude でレビューを実行します...\n' };
}

// レビュアー CLI を起動し、stdin にプロンプトを流し込む。出力は端末へそのまま流す。
function spawnReviewer(cmd, args, stdinText) {
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'inherit', 'inherit'],
    // Windows では codex/claude が .cmd シムのことが多く、shell 経由でないと解決できない。
    shell: process.platform === 'win32',
  });
  child.on('error', (err) => {
    if (err && err.code === 'ENOENT') {
      process.stderr.write(`${cmd} CLI が見つかりません。PATH に ${cmd} を通してください。\n`);
    } else {
      process.stderr.write(`${cmd} の起動に失敗しました: ${err && err.message}\n`);
    }
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code == null ? 1 : code;
  });
  if (child.stdin) {
    child.stdin.write(stdinText);
    child.stdin.end();
  }
  return child;
}

// deps で gitRun / spawnFn を差し替え可能にする (テストから stdin 本文まで検証するため)。
// 既定は実 git / 実 spawn。codex 経路でも「観点 + 差分本文 + モード指示」を stdin に渡すのが
// 中核なので、その配線を結合テストで固定できるようにする。
function runReview(opts, deps = {}) {
  const gitRun = deps.gitRun || defaultGitRunner;
  const spawnFn = deps.spawnFn || spawnReviewer;
  // 観点は deps.checklist 指定があれば優先、無ければ .cross-review.md / 汎用観点を解決する。
  const checklist = deps.checklist != null ? deps.checklist : loadChecklist(deps);
  // codex / claude いずれも自前で差分を取り出し、プロンプトへ同梱する (untracked も含める)。
  let diffText;
  try {
    diffText = collectReviewDiff(opts, gitRun).trim();
  } catch (err) {
    process.stderr.write(`${(err && err.message) || 'git の実行に失敗しました'}\n`);
    process.exitCode = 1;
    return null;
  }
  if (!diffText) {
    process.stdout.write('レビュー対象の差分がありません。\n');
    return null;
  }
  const prompt = buildReviewPrompt(diffText, opts, checklist);
  const { cmd, args, notice } = reviewerInvocation(opts);
  process.stdout.write(notice);
  return spawnFn(cmd, args, prompt);
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
  collectReviewDiff,
  buildReviewPrompt,
  runReview,
  loadChecklist,
  CHECKLIST_FILENAME,
  GENERIC_CHECKLIST,
  REVIEW_ONLY_INSTRUCTION,
  FIX_INSTRUCTION,
};

if (require.main === module) main();
