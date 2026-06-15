#!/usr/bin/env node
// tools/cross-review.sync-all.js
//
// ローカルの作業ルート (例: /Develop) 配下から「ai-cross-review を導入したプロジェクト」を自動判定し、
// それぞれを cross-review.sync.js で一括同期 (上書き更新 / ドリフト検査) する外部ツール。
// 1 リポずつ手で sync を回す代わりに、上流の更新を導入先全体へまとめて反映するための maintainer 向け infra。
//
// 使い方:
//   node tools/cross-review.sync-all.js [root]            # root 配下を走査して一括同期 (既定 root: cwd)
//   node tools/cross-review.sync-all.js --root /Develop   # 走査ルートを指定
//   node tools/cross-review.sync-all.js --check           # 各プロジェクトをドリフト検査のみ (書き込まない)
//   node tools/cross-review.sync-all.js --dry-run         # 各プロジェクトで何が変わるかだけ表示 (書き込まない)
//   node tools/cross-review.sync-all.js --ref <ref>       # 取り込む上流 ref を全プロジェクト共通で上書き
//   node tools/cross-review.sync-all.js --depth <n>       # 走査の最大深さ (既定 4)
//   node tools/cross-review.sync-all.js --list            # 検出したプロジェクトを列挙するだけ (同期しない)
//   node tools/cross-review.sync-all.js --help
//
// 設計判断:
// - 「導入プロジェクト」の判定は同期マニフェスト cross-review.sync.json の存在で行う。これが同期に必須の
//   単一マーカーで、誤検出しにくい (README の導入手順とも一致)。慣例どおり tools/cross-review.sync.json に
//   置かれる前提だが、ルート直下に置かれていても拾えるようにする。
// - 実際の同期は各プロジェクトに同梱された版ではなく、この checkout の cross-review.sync.js (runSync) を
//   再利用して回す。導入先の sync スクリプトが古くても、最新ロジックで一括反映できる。各プロジェクトの
//   マニフェスト (upstream.repo / ref / files) はそのプロジェクト固有なので尊重する。
// - 1 プロジェクトの失敗 (マニフェスト不正・上流取得失敗等) で全体を止めない。各プロジェクトを独立に回し、
//   最後に集計を出す。終了コードは「いずれかが失敗」または「--check でいずれかにドリフト」で 1。
// - 副作用 (ディレクトリ走査・runSync 実行) は deps で差し替え可能にし、純粋なロジック (引数解析・
//   プロジェクトルート算出・結果分類・集計) を単体テストで固定する。cross-review.sync.js と同じ方針。

'use strict';

const fs = require('fs');
const path = require('path');

const SYNC_MANIFEST_FILENAME = 'cross-review.sync.json';
const DEFAULT_DEPTH = 4;
// 走査時にたどらないディレクトリ (生成物・VCS・隠しディレクトリ)。
const SKIP_DIRS = new Set(['node_modules', '.git']);

const USAGE = [
  'ai-cross-review 一括同期ツール (作業ルート配下の導入プロジェクトをまとめて同期する)',
  '',
  '使い方: node tools/cross-review.sync-all.js [root] [options]',
  '',
  'options:',
  '  --root <path>   走査するルート (位置引数 root と同義。既定: cwd)',
  '  --check         各プロジェクトをドリフト検査のみ。書き込まず、差分があれば exit 1',
  '  --dry-run       各プロジェクトで何が変わるかだけ表示する (書き込まない)',
  '  --ref <ref>     取り込む上流 ref を全プロジェクト共通で上書き (ブランチ / タグ / コミット)',
  '  --depth <n>     走査の最大深さ (既定 4)',
  '  --list          検出したプロジェクトを列挙するだけ (同期しない)',
  '  -h, --help      このヘルプを表示',
  '',
  '判定: cross-review.sync.json (同期マニフェスト) を持つディレクトリを導入プロジェクトとみなす。',
  '',
  '例:',
  '  node tools/cross-review.sync-all.js --root /Develop --check   # /Develop 配下のドリフト検査',
  '  node tools/cross-review.sync-all.js --root /Develop           # /Develop 配下を一括同期',
].join('\n');

// process.argv.slice(2) を受け取り、モードとオプションを解釈する。
function parseArgs(argv) {
  const args = argv.slice();
  const out = { root: null, mode: 'sync', dryRun: false, ref: null, depth: DEFAULT_DEPTH, list: false, help: false, error: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
    } else if (a === '--check') {
      out.mode = 'check';
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--list') {
      out.list = true;
    } else if (a === '--root') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) out.error = '--root にはディレクトリパスが必要です';
      else { out.root = v; i++; }
    } else if (a.startsWith('--root=')) {
      const v = a.slice('--root='.length);
      if (!v) out.error = '--root にはディレクトリパスが必要です';
      else out.root = v;
    } else if (a === '--ref') {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) out.error = '--ref には ref (ブランチ / タグ / コミット) が必要です';
      else { out.ref = v; i++; }
    } else if (a.startsWith('--ref=')) {
      const v = a.slice('--ref='.length);
      if (!v) out.error = '--ref には ref が必要です';
      else out.ref = v;
    } else if (a === '--depth') {
      const v = args[i + 1];
      const n = Number(v);
      if (!v || v.startsWith('-') || !Number.isInteger(n) || n < 0) out.error = '--depth には 0 以上の整数が必要です';
      else { out.depth = n; i++; }
    } else if (a.startsWith('--depth=')) {
      const v = a.slice('--depth='.length);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) out.error = '--depth には 0 以上の整数が必要です';
      else out.depth = n;
    } else if (a.startsWith('-')) {
      out.error = `不明なオプション: ${a}`;
    } else if (out.root == null) {
      // 位置引数: 走査ルート。--root と同義 (片方だけ指定する想定)。
      out.root = a;
    } else {
      out.error = `余計な引数: ${a}`;
    }
  }
  return out;
}

// マニフェストのパスから、そのプロジェクトのルート (to パスの基準) を求める。
// 慣例どおり tools/cross-review.sync.json なら tools の 1 つ上、そうでなければマニフェストの置き場所。
function projectRootForManifest(manifestPath) {
  const dir = path.dirname(manifestPath);
  if (path.basename(dir) === 'tools') return path.dirname(dir);
  return dir;
}

// root 配下を深さ制限付きで走査し、cross-review.sync.json を持つディレクトリ (= 導入プロジェクト) の
// マニフェストパス一覧を返す。deps.listDir(dir) は { name, isDirectory(), isFile() } の配列を返す
// (既定は fs.readdirSync withFileTypes)。読めないディレクトリはスキップする。
function findManifests(root, maxDepth, deps = {}) {
  const listDir = deps.listDir || ((d) => fs.readdirSync(d, { withFileTypes: true }));
  const found = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = listDir(dir);
    } catch {
      return; // 読めないディレクトリは黙ってスキップ
    }
    let manifestHere = null;
    const subdirs = [];
    for (const ent of entries) {
      if (ent.isFile && ent.isFile() && ent.name === SYNC_MANIFEST_FILENAME) {
        manifestHere = path.join(dir, ent.name);
      } else if (ent.isDirectory && ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        subdirs.push(ent.name);
      }
    }
    if (manifestHere) {
      const key = path.resolve(projectRootForManifest(manifestHere));
      // 同一プロジェクトで tools/ 直下とルート直下の両方に置かれていても 1 回だけ。
      if (!seen.has(key)) { seen.add(key); found.push(manifestHere); }
    }
    // depth は root を 0 とした探索深さ。maxDepth に達したらサブディレクトリはたどらない
    // (--depth 0 は root 直下のみ。tools/cross-review.sync.json を拾うには最低 depth 2 が要る)。
    if (depth >= maxDepth) return;
    for (const name of subdirs) walk(path.join(dir, name), depth + 1);
  };
  walk(root, 0);
  return found.sort();
}

// runSync の戻り値 (result) と捕捉した exit コードから、表示用のステータスを決める。
//   error        : マニフェスト不正・上流取得失敗・例外 (result が null か code===2、または threw)
//   drift        : --check で上流と差分あり
//   clean        : --check で差分なし
//   updated      : 同期で 1 件以上書き込んだ
//   would-update : --dry-run で 1 件以上変わる
//   unchanged    : 変更なし
function classifyResult({ mode, dryRun }, { result, code, threw }) {
  if (threw || result == null) return { status: 'error', changed: 0 };
  const changed = Array.isArray(result.results)
    ? result.results.filter((r) => r.status !== 'unchanged').length
    : 0;
  if (mode === 'check') {
    if (code === 1 || result.drift) return { status: 'drift', changed };
    if (code && code !== 0) return { status: 'error', changed };
    return { status: 'clean', changed };
  }
  if (code && code !== 0) return { status: 'error', changed };
  if (dryRun) return { status: changed > 0 ? 'would-update' : 'unchanged', changed };
  const wrote = Array.isArray(result.wrote) ? result.wrote.length : changed;
  return { status: wrote > 0 ? 'updated' : 'unchanged', changed };
}

// 1 プロジェクトを同期する (実体)。cross-review.sync.js の runSync を再利用し、その出力と
// process.exitCode を捕捉する (runSync は失敗時に process.exitCode を立てる仕様のため)。
// deps.runSync を渡すとテストから差し替えられる。
function syncOne(manifestPath, opts, deps = {}) {
  const runSync = deps.runSync || require('./cross-review.sync.js').runSync;
  const root = projectRootForManifest(manifestPath);
  const out = [];
  const err = [];
  const subOpts = { mode: opts.mode, dryRun: opts.dryRun, ref: opts.ref, manifestPath, root };
  // runSync は process.exitCode を破壊的に設定するので、退避→0 リセット→実行→読み出し→復元する。
  const prevExit = process.exitCode;
  process.exitCode = 0;
  let result = null;
  let threw = null;
  try {
    result = runSync(subOpts, { out: (s) => out.push(s), err: (s) => err.push(s) });
  } catch (e) {
    threw = e;
  }
  const code = process.exitCode || 0;
  process.exitCode = prevExit;
  return { manifestPath, root, result, code, threw, out: out.join(''), err: err.join('') };
}

const STATUS_LABEL = {
  error: 'エラー',
  drift: 'ドリフト',
  clean: '一致',
  updated: '更新',
  'would-update': '更新予定',
  unchanged: '変更なし',
};

// 集計結果を人間向けの文字列に整形する (テスト可能な純関数)。
function formatSummary(rootLabel, items) {
  const lines = [];
  lines.push(`走査ルート: ${rootLabel}`);
  lines.push(`検出した導入プロジェクト: ${items.length} 件`);
  lines.push('');
  for (const it of items) {
    const label = STATUS_LABEL[it.status] || it.status;
    let detail = '';
    if (it.status === 'updated' || it.status === 'would-update' || it.status === 'drift') {
      detail = ` (${it.changed} 件)`;
    } else if (it.status === 'error') {
      detail = it.message ? ` (${it.message})` : '';
    }
    lines.push(`  [${label}]${detail} ${it.project}`);
  }
  return lines.join('\n') + '\n';
}

// 1 件分のエラーメッセージを取り出す (runSync は stderr に出して null を返す。例外時は message)。
function errorMessageOf({ threw, err }) {
  if (threw) return (threw && threw.message) || String(threw);
  const trimmed = (err || '').trim();
  if (!trimmed) return '同期に失敗しました';
  // 複数行のときは最終行 (最も具体的な理由) を採る。
  const parts = trimmed.split('\n').filter(Boolean);
  return parts[parts.length - 1];
}

// 一括同期の本体。副作用は deps で差し替え可能。
// 戻り値: { items, exitCode }。process.exitCode も設定する。
function runAll(opts, deps = {}) {
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const find = deps.findManifests || ((root, depth) => findManifests(root, depth, deps));
  const doSync = deps.syncOne || ((mp, o) => syncOne(mp, o, deps));

  const root = path.resolve(opts.root || '.');
  const manifests = find(root, opts.depth);

  if (manifests.length === 0) {
    writeErr(`導入プロジェクト (${SYNC_MANIFEST_FILENAME} を持つディレクトリ) が見つかりません: ${root}\n`);
    process.exitCode = 1;
    return { items: [], exitCode: 1 };
  }

  if (opts.list) {
    writeOut(`走査ルート: ${root}\n検出した導入プロジェクト: ${manifests.length} 件\n\n`);
    for (const mp of manifests) writeOut(`  ${projectRootForManifest(mp)}\n`);
    return { items: manifests.map((mp) => ({ project: projectRootForManifest(mp), status: 'listed', changed: 0 })), exitCode: 0 };
  }

  const items = [];
  let anyError = false;
  let anyDrift = false;
  for (const mp of manifests) {
    const project = projectRootForManifest(mp);
    const res = doSync(mp, opts);
    const { status, changed } = classifyResult(opts, res);
    const item = { project, status, changed };
    if (status === 'error') { item.message = errorMessageOf(res); anyError = true; }
    if (status === 'drift') anyDrift = true;
    items.push(item);
  }

  writeOut(formatSummary(root, items));

  const exitCode = anyError || (opts.mode === 'check' && anyDrift) ? 1 : 0;
  process.exitCode = exitCode;
  return { items, exitCode };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE + '\n'); return; }
  if (opts.error) { process.stderr.write(`${opts.error}\n\n${USAGE}\n`); process.exitCode = 2; return; }
  runAll(opts);
}

module.exports = {
  parseArgs,
  projectRootForManifest,
  findManifests,
  classifyResult,
  syncOne,
  formatSummary,
  errorMessageOf,
  runAll,
  SYNC_MANIFEST_FILENAME,
  DEFAULT_DEPTH,
  USAGE,
};

if (require.main === module) main();
