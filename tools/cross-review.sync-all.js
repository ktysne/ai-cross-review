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
//   node tools/cross-review.sync-all.js --global-skill    # 相互レビュー SKILL をホームのグローバル配置へ配る
//   node tools/cross-review.sync-all.js --help
//
// 設計判断:
// - 「導入プロジェクト」の判定は同期マニフェスト cross-review.sync.json の存在で行う。これが同期に必須の
//   単一マーカーで、誤検出しにくい (README の導入手順とも一致)。慣例どおり tools/cross-review.sync.json に
//   置かれる前提だが、ルート直下に置かれていても拾えるようにする。
// - 実際の同期は各プロジェクトに同梱された版ではなく、この checkout の cross-review.sync.js (runSync) を
//   再利用して回す。導入先の sync スクリプトが古くても、最新ロジックで一括反映できる。各プロジェクトの
//   マニフェスト (upstream.repo / ref / files) はそのプロジェクト固有なので尊重する。
// - --check モードでは各プロジェクトのマニフェスト検査 (sync の --check-manifest) も併せて回す。一括検査は
//   「取り込み先が上流に追いつけているか」を見る用途なので、ファイルのドリフトと配布物の取りこぼしを
//   1 回で拾えるようにする。未登録の件数は集計行に出すが、ドリフトではないので終了コードには含めない。
// - 各プロジェクトの stderr はこのツールが捕捉するので、runSync の 1 行警告 ([cross-review] で始まる行)
//   はそのままでは消える。集計行の直後へインデントして出し、どのプロジェクトの警告かを対応付ける。
//   検査が回らなかった (雛形が無い / 読めない / 構造不正) ときは集計行にも「マニフェスト検査スキップ」を
//   出し、未登録 0 件の正常な検査と見分けられるようにする。
// - --global-skill のホーム解決と配布条件は resolveGlobalTargets に集約する。
//   Codex の旧ホームの skills を利用の印にして、共有する .agents へ配る。
//   Claude はホームがあるときだけ配り、未導入の環境にホームを作らない。
// - 1 プロジェクトの失敗 (マニフェスト不正、上流取得失敗等) で全体を止めない。各プロジェクトを独立に回し、
//   最後に集計を出す。検査不能や処理失敗は exit 3、--check のドリフトだけなら exit 1 にする。
// - 副作用 (ディレクトリ走査、runSync 実行) は deps で差し替え可能にし、純粋なロジック (引数解析、
//   プロジェクトルート算出、結果分類、集計) を単体テストで固定する。cross-review.sync.js と同じ方針。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SYNC_MANIFEST_FILENAME = 'cross-review.sync.json';
const DEFAULT_DEPTH = 4;
// 走査時にたどらないディレクトリ (生成物、VCS、隠しディレクトリ)。
const SKIP_DIRS = new Set(['node_modules', '.git']);

// --global-skill の配布元 (この checkout のルートからの相対)。一括同期と同じく、配布するのは
// 各プロジェクトに同梱された版ではなくこの checkout の版とする。
const SKILL_SOURCE = ['.claude', 'skills', 'cross-review', 'SKILL.md'];
const GLOBAL_SKILL_TARGETS = [
  { id: 'claude', env: 'CLAUDE_CONFIG_DIR', dir: '.claude', requireSkills: false },
  { id: 'agents', dir: '.agents', requireSkills: true },
];
const GLOBAL_STATE_LABEL = { match: '一致', stale: '古い', missing: '未配置', unreadable: '読めない', skipped: '対象外', legacy: '旧配置' };

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
  '  --global-skill  Claude のホームと ~/.agents の skills へ配り、配布版と一致する Codex の旧配置を削除する',
  '  --migrate       旧形式を新形式へ移行 (--root 必須。--dry-run / --check [--json] 対応)',
  '  --register      この checkout を ~/.cross-review/engine.json に登録する (--check で照会)',
  '  --json          --global-skill --check または --register --check または --migrate --check の結果を JSON で出す',
  '  -h, --help      このヘルプを表示',
  '',
  '判定: cross-review.sync.json (同期マニフェスト) を持つディレクトリを導入プロジェクトとみなす。',
  '--check では各プロジェクトのマニフェスト検査 (sync --check-manifest) も併せて回す。',
  '--global-skill は単独 (--root 無し) でも動き、そのときはプロジェクト走査をせずグローバル配布だけを行う。',
  'Claude はホーム、Codex は CODEX_HOME (既定 ~/.codex) または ~/.codex-subagent の skills があるときだけ配る。',
  '終了コード: 0 成功、1 --check のドリフト (未配置を除く)、2 引数エラー、3 検査不能 / 処理失敗 / 導入先無し。3 は 1 に優先する。',
  '',
  '例:',
  '  node tools/cross-review.sync-all.js --root /Develop --check   # /Develop 配下のドリフト検査',
  '  node tools/cross-review.sync-all.js --root /Develop           # /Develop 配下を一括同期',
  '  node tools/cross-review.sync-all.js --global-skill            # グローバル SKILL だけを配る',
].join('\n');

// process.argv.slice(2) を受け取り、モードとオプションを解釈する。
function parseArgs(argv) {
  const args = argv.slice();
  const out = { root: null, mode: 'sync', dryRun: false, ref: null, depth: DEFAULT_DEPTH, list: false, globalSkill: false, json: false, help: false, error: null };
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
    } else if (a === '--global-skill') {
      out.globalSkill = true;
    } else if (a === '--migrate') {
      out.migrate = true;
    } else if (a === '--register') {
      out.register = true;
    } else if (a === '--json') {
      out.json = true;
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
  if (out.register && (out.root != null || out.globalSkill || out.list || out.dryRun)) {
    out.error = '--register は --root / --global-skill / --list / --dry-run と併用できません';
  }
  if (out.migrate) {
    if (!out.root) out.error = '--migrate には --root または位置引数の走査ルートが必要です';
    if (out.globalSkill || out.register || out.list || out.ref != null) out.error = '--migrate は --global-skill / --register / --list / --ref と併用できません';
    if (out.dryRun && out.mode === 'check') out.error = '--migrate では --dry-run と --check を併用できません';
    if (out.json && out.mode !== 'check') out.error = '--json は --migrate --check と併用してください';
  }
  if (out.json && !out.migrate && ((!out.globalSkill && !out.register) || (out.globalSkill && out.register) || out.mode !== 'check' || out.root != null || out.list || out.dryRun)) {
    out.error = '--json は --global-skill --check または --register --check 単独で指定してください (--root / --list / --dry-run は併用不可)';
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

// マニフェストの内容が cross-review.sync.js 用 (upstream / files を持つ) かを判定する。
// マニフェスト内容を 3 通りに分類する:
//   'ok'      : upstream / files を持つ同期対象マニフェスト。
//   'skip'    : valid JSON だが新スキーマでない (旧 {source,ref,commit} の独自 sync 来歴や、別用途で
//               たまたま同名のファイル)。一括同期では対象外として skip する (ハードエラーにしない)。
//   'invalid' : 読めない (IO/権限エラー = raw が null) / JSON 構文エラー (破損)。正式導入先の設定破損を
//               skip で握り潰すと CI の sync-all --check で検出できなくなるため、error/exit 1 に分ける。
function classifyManifestRaw(raw) {
  if (raw == null) return 'invalid';                          // 読めない (read error)
  let obj;
  try { obj = JSON.parse(raw); } catch { return 'invalid'; }  // JSON 構文エラー (破損)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'skip'; // valid JSON だが新スキーマでない
  return (obj.upstream !== undefined || obj.files !== undefined) ? 'ok' : 'skip';
}

// 後方互換: 「同期対象 (ok) か」を真偽で返す薄いラッパ。破損 (invalid) と対象外 (skip) は
// どちらも false になる点に注意 (両者の区別が要る runAll では classifyManifestRaw を直接使う)。
function isSyncManifestContent(raw) {
  return classifyManifestRaw(raw) === 'ok';
}

// runSync の戻り値 (result) と捕捉した exit コードから、表示用のステータスを決める。
//   error        : マニフェスト不正、上流取得失敗、例外 (result が null か code===2、または threw)
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
  // --check のときはマニフェスト検査も回す。一括検査は「取り込み先が上流に追いつけているか」を見る
  // 用途なので、ファイルのドリフトと配布物の取りこぼしを 1 回で拾う。
  const subOpts = { mode: opts.mode, dryRun: opts.dryRun, ref: opts.ref, manifestPath, root, checkManifest: opts.mode === 'check' };
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

// fs.existsSync は権限エラーでも false を返し、「無い」と区別できないため stat で調べる。
// 無いときだけ false を返し、ほかの失敗は例外のまま呼び出し側へ渡す。
function pathExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false;
    throw err;
  }
}

// 全モードで同じホーム解決、配布条件、重複判定を使う。
// 配布条件のディレクトリを調べられないときは unreadable を立て、対象外と区別する。
function resolveGlobalTargets(deps = {}) {
  const home = deps.home || os.homedir();
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const exists = deps.exists || pathExists;
  const seen = new Map();
  return GLOBAL_SKILL_TARGETS.map((t) => {
    const override = t.env && env[t.env];
    const targetHome = path.resolve(override || path.join(home, t.dir));
    const dest = path.join(targetHome, 'skills', 'cross-review', 'SKILL.md');
    const homeFrom = override ? t.env : (t.env ? 'default' : 'fixed');
    const requireDirs = t.requireSkills
      ? legacyGlobalTargets({ home, env, platform }).map((legacy) => path.join(legacy.home, 'skills'))
      : [targetHome];
    const keyPath = path.resolve(dest).replace(/[\\/]+$/, '');
    const key = platform === 'win32' ? keyPath.toLowerCase() : keyPath;
    let reason = null;
    let unreadable = false;
    if (seen.has(key)) reason = `${seen.get(key)} と同じパス`;
    else {
      seen.set(key, t.id);
      try {
        if (!requireDirs.map((dir) => exists(dir)).some(Boolean)) {
          reason = `${override ? `${t.env} が指すホームの ` : ''}${requireDirs.join(' または ')} が無いため配布しない`;
        }
      } catch (err) {
        unreadable = true;
        reason = `${requireDirs.join(' または ')} を調べられません: ${(err && err.message) || 'stat error'}`;
      }
    }
    return { id: t.id, path: dest, home: targetHome, homeFrom, available: reason === null, unreadable, reason };
  });
}

function legacyGlobalTargets({ home, env, platform }) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const seen = new Set();
  return [
    { id: 'codex-legacy', home: path.resolve(codexHome), homeFrom: env.CODEX_HOME ? 'CODEX_HOME' : 'default' },
    { id: 'codex-subagent-legacy', home: path.resolve(home, '.codex-subagent'), homeFrom: 'fixed' },
  ].map((target) => ({ ...target, path: path.join(target.home, 'skills/cross-review/SKILL.md') }))
    .filter((target) => {
      const key = platform === 'win32' ? target.path.toLowerCase() : target.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function collectSkillVersions(scriptDir, skillBuffer, deps) {
  const gitRun = deps.gitRun || ((args) => (deps.execFileSync || execFileSync)('git', args, {
    cwd: path.resolve(scriptDir, '..'), encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const skillPath = SKILL_SOURCE.join('/');
  try {
    // 配った版は checkout の HEAD の履歴にある版だけなので、ほかのブランチの版は含めない。
    const commits = String(gitRun(['log', '--format=%H', '--diff-filter=AM', '--', skillPath])).trim().split(/\s+/).filter(Boolean);
    if (!commits.length) throw new Error('SKILL の履歴がありません');
    return { versions: [skillBuffer, ...commits.map((commit) => Buffer.from(gitRun(['show', `${commit}:${skillPath}`])))], reason: null };
  } catch (err) {
    return { versions: [], reason: `過去の配布版を集められません: ${err.message}` };
  }
}

// 親ディレクトリを実体へ解決し、ファイル名を足したパス。共有した置き場を別物とみなすと配った写しを消し、
// ファイル自体のリンクを追うと、unlink がリンクだけを消して古い写しを残すため。
function realPathKey(p, realpath, platform) {
  const rest = [path.basename(p)];
  let dir = path.dirname(path.resolve(p));
  for (;;) {
    try {
      const real = path.join(realpath(dir), ...rest);
      return platform === 'win32' ? real.toLowerCase() : real;
    } catch (err) {
      const parent = path.dirname(dir);
      if (!err || err.code !== 'ENOENT' || parent === dir) throw err;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

// 配布先がファイルのリンクなら、書き込みはリンク先へ届くので、リンク先の旧配置も配布先として守る。
function activePathKeys(p, realpath, platform) {
  const keys = [realPathKey(p, realpath, platform)];
  try {
    const real = realpath(path.resolve(p));
    keys.push(platform === 'win32' ? real.toLowerCase() : real);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return keys;
}

// 配布先と実体が同じ旧配置は旧配置として扱わない。実体を確かめられない旧配置は消さない。
function planLegacySkills(deps, skillBuffer, sourcePath, sourceSha256, activePaths = []) {
  const platform = deps.platform || process.platform;
  const realpath = deps.realpath || fs.realpathSync.native;
  const keyOf = (p) => realPathKey(p, realpath, platform);
  let active;
  let activeError = null;
  try { active = new Set(activePaths.flatMap((p) => activePathKeys(p, realpath, platform))); }
  catch (err) { active = new Set(); activeError = err; }
  const seen = new Set();
  const targets = legacyGlobalTargets({ home: deps.home || os.homedir(), env: deps.env || process.env, platform })
    .map((target) => {
      if (activeError) return { ...target, realError: activeError };
      try { return { ...target, realKey: keyOf(target.path) }; }
      catch (err) { return { ...target, realError: err }; }
    })
    .filter((target) => {
      if (target.realError) return true;
      if (active.has(target.realKey) || seen.has(target.realKey)) return false;
      seen.add(target.realKey);
      return true;
    });
  let history;
  const normalize = (buffer) => buffer.toString('latin1').replace(/\r\n/g, '\n');
  return targets.flatMap(({ realKey, realError, ...target }) => {
    const base = { ...target, sourcePath, sourceSha256, sha256: null, removable: false };
    if (realError) {
      let content;
      try { content = Buffer.from(deps.readFile(target.path)); }
      catch (err) {
        if (err.code === 'ENOENT') return [];
        return [{ ...base, state: 'unreadable', reason: `写しを読めません: ${err.message}` }];
      }
      return [{ ...base, state: 'legacy', sha256: sha256(content), reason: `実体のパスを確かめられません: ${realError.message}` }];
    }
    let current;
    try { current = Buffer.from(deps.readFile(target.path)); }
    catch (err) {
      if (err.code === 'ENOENT') return [];
      return [{ ...base, state: 'unreadable', reason: `写しを読めません: ${err.message}` }];
    }
    history ||= collectSkillVersions(deps.scriptDir || __dirname, skillBuffer, deps);
    const removable = history.versions.some((version) => normalize(version) === normalize(current));
    return [{ ...base, state: 'legacy', removable, sha256: sha256(current),
      reason: removable ? null : (history.reason || '過去の配布版および現在の配布元と一致しません') }];
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// バイト一致で写しを検査する。読めない写しは、書き込みモードで上書きを試せるよう区別する。
function planGlobalSkill({ home, env, platform, exists, readFile, skillBuffer, sourcePath, sourceSha256 }) {
  return resolveGlobalTargets({ home, env, platform, exists }).map(({ available, unreadable, ...target }) => {
    const base = { ...target, sourcePath, sourceSha256, sha256: null };
    if (unreadable) return { ...base, state: 'unreadable' };
    if (!available) return { ...base, state: 'skipped' };
    let current;
    try {
      current = Buffer.from(readFile(target.path));
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ...base, state: 'missing', reason: null };
      return { ...base, state: 'unreadable', reason: `写しを読めません: ${(err && err.message) || 'read error'}` };
    }
    return { ...base, state: current.equals(skillBuffer) ? 'match' : 'stale', sha256: sha256(current), reason: null };
  });
}

// 配布先をホーム基準の短い表記 (~/...) にする。集計行が絶対パスで長くなるのを避けるため。
function formatGlobalPath(home, p) {
  const rel = path.relative(home, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return `~${path.sep}${rel}`;
}

// --check / --dry-run では書き込まない。検査時の各状態と配布元を report に保持する。
function runGlobalSkill(opts, deps = {}) {
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const home = deps.home || os.homedir();
  const exists = deps.exists || pathExists;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p));
  const writeFile = deps.writeFile || ((p, c) => fs.writeFileSync(p, c));
  const mkdir = deps.mkdir || ((d) => fs.mkdirSync(d, { recursive: true }));
  const scriptDir = deps.scriptDir || __dirname;
  const sourcePath = path.join(path.resolve(scriptDir, '..'), ...SKILL_SOURCE);
  const report = { schemaVersion: 2, result: 'error', source: { path: sourcePath, sha256: null, error: null }, targets: [] };
  const errorItem = (message, project = 'global', plans = []) => ({ kind: 'global', project, status: 'error', changed: 0, message, plans, report });

  let skillBuffer;
  try {
    skillBuffer = Buffer.from(readFile(sourcePath));
  } catch (err) {
    report.source.error = `配布元の SKILL を読めません: ${sourcePath} (${(err && err.message) || 'read error'})`;
    return errorItem(report.source.error);
  }
  report.source.sha256 = sha256(skillBuffer);
  const plans = planGlobalSkill({ home, env: deps.env, platform: deps.platform, exists, readFile, skillBuffer, sourcePath, sourceSha256: report.source.sha256 });
  plans.push(...planLegacySkills({ ...deps, home, readFile }, skillBuffer, sourcePath, report.source.sha256, plans.map((p) => p.path)));
  report.targets = plans;
  const unreadable = plans.some((p) => p.state === 'unreadable');
  const stale = plans.filter((p) => ['stale', 'legacy'].includes(p.state));
  report.result = unreadable ? 'error' : (stale.length ? 'drift' : 'clean');
  if (!opts.json) writeOut(`グローバル SKILL の配布元: ${sourcePath}\n`);
  for (const p of plans) {
    if (p.state === 'skipped') writeErr(`[cross-review] グローバル SKILL を配布しません: ${formatGlobalPath(home, p.path)} (${p.reason})\n`);
  }

  const pending = plans.filter((p) => !p.id.endsWith('-legacy') && ['missing', 'stale', 'unreadable'].includes(p.state));
  const legacy = plans.filter((p) => p.id.endsWith('-legacy'));
  for (const p of legacy) {
    if (opts.dryRun) writeOut(`旧配置を${p.removable ? '削除予定' : '残す'}: ${p.path}${p.reason ? ` (${p.reason})` : ''}\n`);
    else if (opts.mode !== 'check' && !p.removable) writeErr(`[cross-review] 旧配置を残します: ${p.path} (${p.reason})\n`);
  }
  const project = `global: ${plans.map((p) => `${formatGlobalPath(home, p.path)} (${GLOBAL_STATE_LABEL[p.state]})`).join(', ')}`;
  if (opts.mode === 'check') {
    return { kind: 'global', project, status: unreadable ? 'error' : (stale.length ? 'drift' : 'clean'), changed: stale.length, plans, report };
  }
  if (opts.dryRun) {
    const changes = pending.length + legacy.filter((p) => p.removable).length;
    return { kind: 'global', project, status: changes ? 'would-update' : 'unchanged', changed: changes, plans, report };
  }
  let wrote = 0;
  try {
    for (const p of pending) {
      mkdir(path.dirname(p.path));
      writeFile(p.path, skillBuffer);
      wrote++;
    }
    for (const p of legacy.filter((target) => target.removable)) {
      (deps.unlink || fs.unlinkSync)(p.path);
      try { (deps.rmdir || fs.rmdirSync)(path.dirname(p.path)); }
      catch (err) { if (!['ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
      wrote++;
    }
  } catch (err) {
    return errorItem(`グローバル SKILL の配布に失敗しました: ${(err && err.message) || 'write error'}`, project, plans);
  }
  return { kind: 'global', project, status: wrote > 0 ? 'updated' : 'unchanged', changed: wrote, plans, report };
}

const STATUS_LABEL = {
  error: 'エラー',
  drift: 'ドリフト',
  clean: '一致',
  updated: '更新',
  'would-update': '更新予定',
  unchanged: '変更なし',
  skipped: '対象外',
};

// 集計結果を人間向けの文字列に整形する (テスト可能な純関数)。
// rootLabel が null のときは走査していない (--global-skill 単独) ので、走査ルートの見出しを出さない。
// 件数はプロジェクト行だけを数える (kind: 'global' の行は導入プロジェクトではないため)。
// item.warnings があれば、そのプロジェクトの行の直後にインデントして並べる (どのプロジェクトの警告かを
// 対応付けられるようにするため)。
function formatSummary(rootLabel, items) {
  const lines = [];
  if (rootLabel != null) {
    lines.push(`走査ルート: ${rootLabel}`);
    lines.push(`検出した導入プロジェクト: ${items.filter((it) => it.kind !== 'global').length} 件`);
    lines.push('');
  }
  for (const it of items) {
    const label = STATUS_LABEL[it.status] || it.status;
    let detail = '';
    if (it.status === 'updated' || it.status === 'would-update' || it.status === 'drift') {
      detail = ` (${it.changed} 件)`;
    } else if (it.status === 'error' || it.status === 'skipped') {
      detail = it.message ? ` (${it.message})` : '';
    }
    // 未読の移行ノート (取り込み先で人がやる作業) があった件数。同期の本文は各プロジェクトの stderr に
    // 出るが、一括同期では流れて見落としやすいので集計にも残す。
    const note = it.migrations > 0 ? ` (移行ノート ${it.migrations} 件)` : '';
    // 上流の雛形にあって files[] に無い配布物の件数 (--check で検査したときだけ入る)。取り込み先が
    // 足すかどうかを判断する材料なので、ドリフトとは別に出す。
    const missing = it.missingManifest > 0 ? ` (マニフェスト未登録 ${it.missingManifest} 件)` : '';
    // マニフェスト検査そのものが回らなかった (雛形が無い / 読めない / 構造不正) ことを明示する。
    // 「未登録 0 件」と「検査できていない」を集計行だけで見分けられるようにするため。理由は直後の
    // 警告行に出る。
    const skipped = it.manifestCheckSkipped ? ' (マニフェスト検査スキップ)' : '';
    lines.push(`  [${label}]${detail} ${it.project}${note}${missing}${skipped}`);
    for (const w of Array.isArray(it.warnings) ? it.warnings : []) lines.push(`    ${w}`);
  }
  return lines.join('\n') + '\n';
}

// runSync が stderr へ出した 1 行警告 ([cross-review] で始まる行) を取り出す純粋関数。
// 一括同期では各プロジェクトの stderr を捕捉してしまうため、そのままでは雛形が無い / 読めない / 構造が
// 不正といった警告が握り潰され、正常な検査と区別できなくなる。集計へ添えるためにここで拾う。
// 未読の移行ノートの全文ブロック (先頭行が「[cross-review] 未読の移行ノート ...」) は、件数が集計行の
// 「(移行ノート N 件)」に出るうえ本文が長いので対象にしない。
function collectSyncWarnings(err) {
  return String(err || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[cross-review] ') && !line.startsWith('[cross-review] 未読の移行ノート'));
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
  // マニフェスト内容の先読み (同期対象判定用)。読めなければ null → 同期対象外 (skip) 扱い。
  const readManifest = deps.readManifest || ((mp) => { try { return fs.readFileSync(mp, 'utf8'); } catch { return null; } });
  const doGlobalSkill = deps.runGlobalSkill || ((o) => runGlobalSkill(o, deps));

  // --global-skill を --root 無しで指定したときは、グローバル配布だけを行う (走査しない)。
  // 走査ルートの既定は cwd なので、明示が無ければ「配布だけしたい」と解釈する。
  const globalOnly = opts.globalSkill && opts.root == null;
  const root = path.resolve(opts.root || '.');
  const manifests = globalOnly ? [] : find(root, opts.depth);

  if (!globalOnly && manifests.length === 0) {
    writeErr(`導入プロジェクト (${SYNC_MANIFEST_FILENAME} を持つディレクトリ) が見つかりません: ${root}\n`);
    process.exitCode = 3;
    return { items: [], exitCode: 3 };
  }

  if (opts.list) {
    const listed = [];
    if (!globalOnly) {
      writeOut(`走査ルート: ${root}\n検出した導入プロジェクト: ${manifests.length} 件\n\n`);
      for (const mp of manifests) {
        writeOut(`  ${projectRootForManifest(mp)}\n`);
        listed.push({ project: projectRootForManifest(mp), status: 'listed', changed: 0 });
      }
    }
    if (opts.globalSkill) {
      const home = deps.home || os.homedir();
      writeOut(`${listed.length ? '\n' : ''}グローバル SKILL の配布先:\n`);
      for (const t of resolveGlobalTargets(deps)) {
        writeOut(`  ${formatGlobalPath(home, t.path)}${t.available ? '' : ` (${t.unreadable ? '読めない' : '対象外'}: ${t.reason})`}\n`);
        listed.push({ kind: 'global', project: formatGlobalPath(home, t.path), status: 'listed', changed: 0 });
      }
    }
    return { items: listed, exitCode: 0 };
  }

  const items = [];
  let anyError = false;
  let anyDrift = false;
  for (const mp of manifests) {
    const project = projectRootForManifest(mp);
    const kind = classifyManifestRaw(readManifest(mp));
    // 設定崩れを CI で検出するため、破損や読み取り不能は error/exit 3 にする。
    if (kind === 'invalid') {
      items.push({ project, status: 'error', changed: 0, message: `${SYNC_MANIFEST_FILENAME} を読み込めない、または JSON として不正です` });
      anyError = true;
      continue;
    }
    // upstream / files を持たないマニフェスト (旧 {source,ref,commit} の独自 sync 来歴や別用途の
    // 同名ファイル) は同期対象外として skip する。1 件の非準拠で全体を失敗させない。
    if (kind === 'skip') {
      items.push({ project, status: 'skipped', changed: 0, message: 'upstream/files を持たないため同期対象外' });
      continue;
    }
    const res = doSync(mp, opts);
    const { status, changed } = classifyResult(opts, res);
    const item = { project, status, changed };
    // runSync が表示した未読移行ノートの件数 (無い / 失敗時は 0)。
    const migrations = res.result && Array.isArray(res.result.migrations) ? res.result.migrations.length : 0;
    if (migrations > 0) item.migrations = migrations;
    // マニフェスト未登録の配布物の件数 (--check のときだけ検査される)。取り込み先の判断待ちであって
    // ドリフトではないので、集計に出すだけで exit コードには含めない。
    const missing = res.result && Array.isArray(res.result.missingManifestEntries) ? res.result.missingManifestEntries.length : 0;
    if (missing > 0) item.missingManifest = missing;
    // マニフェスト検査が回らなかったとき (雛形が無い / 読めない / 構造不正) は、未登録 0 件と混同しない
    // よう集計行に印を付ける。
    if (res.result && res.result.manifestCheckWarning) item.manifestCheckSkipped = true;
    // runSync の 1 行警告は捕捉した stderr に埋もれるので、集計へ引き上げる (全モード共通)。
    const warnings = collectSyncWarnings(res.err);
    if (warnings.length) item.warnings = warnings;
    if (status === 'error') { item.message = errorMessageOf(res); anyError = true; }
    if (status === 'drift') anyDrift = true;
    items.push(item);
  }

  if (opts.globalSkill) {
    // グローバル SKILL が古いのは取り込み先のドリフトと同じ扱いにする (--check なら exit 1)。
    const globalItem = doGlobalSkill(opts);
    items.push(globalItem);
    if (globalItem.status === 'error') anyError = true;
    if (globalItem.status === 'drift') anyDrift = true;
  }

  if (opts.json) writeOut(JSON.stringify(items.find((it) => it.kind === 'global').report, null, 2) + '\n');
  else writeOut(formatSummary(globalOnly ? null : root, items));

  const exitCode = anyError ? 3 : (opts.mode === 'check' && anyDrift ? 1 : 0);
  process.exitCode = exitCode;
  return { items, exitCode };
}

function probeEngine(enginePath, deps = {}) {
  const execute = deps.execFileSync || execFileSync;
  const script = 'const e = require(process.argv[1]); console.log(JSON.stringify({range: e.ENTRY_PROTOCOL_RANGE || null, check: typeof e.checkEntryProtocol === "function"}));';
  const result = JSON.parse(String(execute(process.execPath, ['-e', script, enginePath], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })));
  if (!result || typeof result.check !== 'boolean' || !Object.hasOwn(result, 'range')) throw new Error('本体の照会出力が不正です');
  return result;
}

function inspectRegistration(deps = {}) {
  const home = deps.home || os.homedir();
  const exists = deps.exists || pathExists;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const registryPath = path.resolve(home, '.cross-review/engine.json');
  const report = { schemaVersion: 1, subject: 'register', result: 'clean', registry: { path: registryPath, exists: false, error: null }, checkout: null, issues: [] };
  const issue = (code, message, error = true) => {
    report.issues.push({ code, message });
    if (error) report.result = 'error';
    else if (report.result !== 'error') report.result = 'drift';
  };
  let checkout;
  try {
    report.registry.exists = !!exists(registryPath);
    if (!report.registry.exists) return report;
    checkout = JSON.parse(String(readFile(registryPath))).checkout;
    if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) throw new Error('checkout は絶対パスの文字列が必要です');
  } catch (err) {
    report.registry.error = '登録ファイルを読めません: ' + err.message;
    issue('registry-unreadable', report.registry.error);
    return report;
  }
  const item = { path: checkout, exists: false, engine: null, head: { branch: null, sha: null, defaultBranch: null, onDefaultBranch: null }, dirty: null };
  report.checkout = item;
  try { item.exists = !!exists(checkout); } catch {}
  if (!item.exists) {
    issue('checkout-missing', '登録した checkout がありません: ' + checkout);
    return report;
  }
  const enginePath = path.join(checkout, 'tools/cross-review.js');
  item.engine = { path: enginePath, state: 'missing', entryProtocol: null };
  try {
    if (!exists(enginePath)) issue('engine-missing', '本体がありません: ' + enginePath);
    else {
      item.engine.state = 'unloadable';
      const result = probeEngine(enginePath, deps);
      item.engine.entryProtocol = result.range;
      if (!result.check || !result.range) {
        item.engine.state = 'no-protocol';
        issue('protocol-export-missing', '対応外の古い本体です。登録した checkout を更新してください。');
      } else item.engine.state = 'ok';
    }
  } catch (err) {
    item.engine.state = 'unloadable';
    issue('engine-unloadable', '本体を読み込めません: ' + err.message);
  }
  const gitRun = deps.gitRun || ((args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
  item.head.defaultBranch = 'main';
  try { item.head.defaultBranch = String(gitRun(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '') || 'main'; } catch {}
  try { item.head.sha = String(gitRun(['rev-parse', 'HEAD'])).trim(); }
  catch { issue('git-failed', '登録した checkout の HEAD の SHA を取得できません。'); }
  try {
    const branch = String(gitRun(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    item.head.branch = branch === 'HEAD' ? null : branch;
    item.head.onDefaultBranch = item.head.branch === item.head.defaultBranch;
    if (!item.head.onDefaultBranch) issue('not-on-default-branch', '登録した checkout の HEAD は既定のブランチではありません。', false);
  } catch { issue('git-failed', '登録した checkout の HEAD のブランチを取得できません。'); }
  try {
    item.dirty = !!String(gitRun(['status', '--porcelain'])).trim();
    if (item.dirty) issue('dirty', '登録した checkout に未コミットの変更があります。', false);
  } catch { issue('git-failed', '登録した checkout の未コミット変更を取得できません。'); }
  return report;
}

function runRegister(opts, deps = {}) {
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  if (opts.mode === 'check') {
    const report = inspectRegistration(deps);
    if (opts.json) writeOut(JSON.stringify(report, null, 2) + '\n');
    else {
      writeOut('本体の登録: ' + report.result + ' (' + report.registry.path + ')\n');
      for (const issue of report.issues) writeOut(issue.message + '\n');
    }
    process.exitCode = { clean: 0, drift: 1, error: 3 }[report.result];
    return report;
  }
  const checkout = path.resolve(deps.scriptDir || __dirname, '..');
  const registry = path.resolve(deps.home || os.homedir(), '.cross-review/engine.json');
  try {
    (deps.mkdir || ((p) => fs.mkdirSync(p, { recursive: true })))(path.dirname(registry));
    (deps.writeFile || ((p, body) => fs.writeFileSync(p, body)))(registry, JSON.stringify({ checkout }, null, 2) + '\n');
  } catch (err) {
    writeErr('本体を登録できません: ' + registry + ' (' + err.message + ')\n');
    process.exitCode = 3;
    return;
  }
  const gitRun = deps.gitRun || ((args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    const gitDir = path.resolve(checkout, gitRun(['rev-parse', '--git-dir']).trim());
    const commonDir = path.resolve(checkout, gitRun(['rev-parse', '--git-common-dir']).trim());
    if (gitDir !== commonDir) writeErr('[cross-review] worktree を登録した。開発用の checkout を登録すると、全導入先がその作業中の内容で動きます。\n');
  } catch {}
  writeOut('本体を登録しました: ' + checkout + '\n');
  process.exitCode = 0;
}

const MIGRATION_SOURCES = new Map([
  ['tools/cross-review.js', 'tools/cross-review.entry.js'],
  ['.claude/skills/cross-review/SKILL.md', 'templates/cloud-skill/SKILL.md'],
  ['docs/cross-review.md', 'templates/docs/cross-review.md'],
]);
const MIGRATION_REMOVED = new Set([
  'tools/cross-review.sync.js', 'tools/cross-review.sync-all.js',
  'tests/cross-review.test.js', 'tests/cross-review.sync.test.js', 'tests/cross-review.sync-all.test.js',
]);

function serializeMigrationJson(value, raw) {
  const indent = /(?:^|\n)(\t+| +)"/.exec(raw)?.[1] || '  ';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(value, null, indent).replace(/\n/g, eol) + (/\n$/.test(raw) ? eol : '');
}

function rewriteMigrationManifest(manifest, example) {
  const next = structuredClone(manifest);
  next.files = next.files.filter((entry) => !MIGRATION_REMOVED.has(entry.from))
    .map((entry) => entry.from === '.claude/skills/cross-review/SKILL.md' && entry.to !== entry.from
      ? entry : { ...entry, from: MIGRATION_SOURCES.get(entry.from) || entry.from });
  if (next.excludedFiles) {
    next.excludedFiles = next.excludedFiles.filter((from) => !MIGRATION_REMOVED.has(from))
      .map((from) => MIGRATION_SOURCES.get(from) || from);
  }
  for (const entry of example.files) {
    if (!next.files.some((file) => file.from === entry.from) && !next.excludedFiles?.includes(entry.from)) {
      next.files.push(structuredClone(entry));
    }
  }
  return next;
}

function inspectMigration(manifestPath, acquire, deps) {
  const sync = require('./cross-review.sync.js');
  const project = { root: path.resolve(projectRootForManifest(manifestPath)), manifest: path.resolve(manifestPath),
    upstream: null, form: 'error', migratable: null, reason: null, message: null };
  const fail = (reason, message, migratable = false) => {
    project.reason = reason;
    project.message = message;
    project.migratable = project.form === 'legacy' ? migratable : null;
    return { project };
  };
  let raw;
  let manifest;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    return fail('manifest-unreadable', `マニフェストを読めません: ${err.message}`);
  }
  if (manifest?.upstream && typeof manifest.upstream === 'object' && !Array.isArray(manifest.upstream)) {
    project.upstream = {
      repo: typeof manifest.upstream.repo === 'string' ? manifest.upstream.repo : null,
      ref: typeof manifest.upstream.ref === 'string' ? manifest.upstream.ref : null,
    };
  }
  if (classifyManifestRaw(raw) === 'skip') {
    project.form = 'not-applicable';
    return { project };
  }
  try { sync.validateManifest(manifest, null, deps); } catch (err) {
    if (Array.isArray(manifest.files)) project.form = 'legacy';
    return fail('manifest-invalid', err.message);
  }
  if (sync.isNewFormManifest(manifest)) {
    project.form = 'new';
    return { project };
  }
  project.form = 'legacy';
  let upstream;
  try { upstream = acquire(manifest.upstream); } catch (err) {
    return fail('upstream-unavailable', `上流を取得できません: ${err.message}`, null);
  }
  try {
    const entry = fs.readFileSync(path.join(upstream.dir, 'tools/cross-review.entry.js'), 'utf8');
    const protocol = /^\s*const ENTRY_PROTOCOL = (\d+);\s*$/m.exec(entry);
    if (!protocol) throw new Error('入口の ENTRY_PROTOCOL を読めません');
    const engine = probeEngine(path.resolve(upstream.dir, 'tools/cross-review.js'), deps);
    const range = engine.range;
    if (!engine.check || !Number.isInteger(range?.min) || !Number.isInteger(range?.max)
        || Number(protocol[1]) < range.min || Number(protocol[1]) > range.max) {
      throw new Error('本体が入口の番号を受け付けません');
    }
  } catch (err) {
    return fail('ref-unsupported', `ref ${manifest.upstream.ref} は移行に対応していません。upstream.ref を tools/cross-review.entry.js を含む対応版 (例 main) へ上げてください: ${err.message}`);
  }
  let next;
  if (manifest.files.some((entry) => entry.from === 'tools/cross-review.js' && entry.to !== 'tools/cross-review.js')) {
    return fail('custom-body-location', '本体の配置が tools/cross-review.js 以外のため移行できません。入口が導入先のルートを解決できる配置へ変更するか判断してください');
  }
  // 入口と sync サブコマンドは <導入先のルート>/tools/cross-review.sync.json だけを読む。
  if (path.relative(project.root, project.manifest).split(path.sep).join('/') !== 'tools/cross-review.sync.json') {
    return fail('custom-manifest-location', 'マニフェストが tools/cross-review.sync.json 以外にあるため移行できません。入口はこの場所のマニフェストだけを読みます');
  }
  try {
    const example = JSON.parse(fs.readFileSync(path.join(upstream.dir, sync.UPSTREAM_EXAMPLE_MANIFEST), 'utf8'));
    sync.validateManifest(example, null, deps);
    if (!sync.NEW_FORM_SOURCES.every((from) => example.files.some((entry) => entry.from === from))) {
      throw new Error('上流の雛形に新形式の配布物がありません');
    }
    next = rewriteMigrationManifest(manifest, { files: example.files.filter((entry) => sync.NEW_FORM_SOURCES.includes(entry.from)) });
    sync.validateManifest(next, null, deps);
  } catch (err) {
    return fail(/to が重複/.test(err.message) ? 'duplicate-destination' : 'manifest-invalid', err.message);
  }
  if (manifest.excludedFiles?.includes('tools/cross-review.js')) {
    return fail('body-excluded', '本体が excludedFiles にあるため移行できません。入口の取り込みを許可するか判断してください');
  }
  project.migratable = true;
  return { project, raw, manifest, next, upstream };
}

function planMigration(inspection) {
  const sync = require('./cross-review.sync.js');
  const { project, manifest, next, upstream } = inspection;
  const removed = manifest.files.filter((entry) => MIGRATION_REMOVED.has(entry.from)).map((entry) => {
    const absolute = path.resolve(project.root, entry.to);
    sync.assertWithinRoot(project.root, absolute, `削除対象 (${entry.to})`);
    return { to: entry.to, absolute };
  });
  const plan = sync.computeSyncPlan(next, upstream.dir, project.root);
  const packagePath = path.join(project.root, 'package.json');
  const manual = [];
  const replacements = [];
  let packageRaw = null;
  let packageNext = null;
  if (pathExists(packagePath)) {
    packageRaw = fs.readFileSync(packagePath, 'utf8');
    const value = JSON.parse(packageRaw);
    // 標準の場所の同期スクリプトの呼び出しだけを置き換える。sync サブコマンドは --root と --manifest を受け付けない。
    const normalizeScriptPaths = (text) => text.replace(/\\/g, '/').replace(/(^|[\s"'=])\.\//g, '$1');
    const removedCustomPaths = manifest.files
      .filter((entry) => MIGRATION_REMOVED.has(entry.from) && normalizeScriptPaths(entry.to) !== 'tools/cross-review.sync.js')
      .map((entry) => normalizeScriptPaths(entry.to));
    for (const [name, command] of Object.entries(value.scripts || {})) {
      if (typeof command !== 'string') continue;
      if (command.includes('cross-review.sync-all.js')
          || removedCustomPaths.some((to) => normalizeScriptPaths(command).includes(to))
          || (/\bnode tools\/cross-review\.sync\.js\b/.test(command) && /(?:^|\s)--(?:root|manifest)(?:[=\s]|$)/.test(command))
          || manifest.files.some((entry) => MIGRATION_REMOVED.has(entry.from) && entry.from.startsWith('tests/') && command.includes(entry.to))
          || [...MIGRATION_REMOVED].some((from) => from.startsWith('tests/') && command.includes(from))) {
        manual.push(`package.json scripts.${name}: ${command}`);
        continue;
      }
      const updated = command.replace(/\bnode tools\/cross-review\.sync\.js(?=\s|$|[;&|])/g, 'node tools/cross-review.js sync');
      if (updated !== command) {
        value.scripts[name] = updated;
        replacements.push(`scripts.${name}: ${command} → ${updated}`);
      }
    }
    if (replacements.length) packageNext = serializeMigrationJson(value, packageRaw);
  }
  return { removed, plan, packagePath, packageNext, replacements, manual };
}

function applyMigration(inspection, plan, opts, deps, out, err) {
  const sync = require('./cross-review.sync.js');
  const { project, raw, next, upstream } = inspection;
  const manifestRaw = serializeMigrationJson(next, raw);
  out(`  マニフェスト: files ${inspection.manifest.files.length} → ${next.files.length} 件、from と excludedFiles を新形式へ変換\n`);
  for (const file of plan.removed) out(`  ${opts.dryRun ? '削除予定' : '削除対象'}: ${file.to}\n`);
  for (const replacement of plan.replacements) out(`  package.json ${replacement}\n`);
  for (const item of plan.manual) out(`  手で修正: ${item}\n`);
  // 新形式の配布物を書き終えてから、マニフェストを新形式にする。途中で失敗しても旧形式のまま残り、
  // --migrate --check で見つかり、もう一度 --migrate で続きから移せるようにするため。
  let manifestNext = manifestRaw;
  const previousExit = process.exitCode;
  process.exitCode = 0;
  try {
    const result = (deps.runSync || sync.runSync)({ root: project.root, manifestPath: project.manifest,
      mode: 'sync', dryRun: opts.dryRun }, {
      out: (s) => out(`  ${s}`), err,
      readFile: (file) => path.resolve(file) === project.manifest ? manifestRaw : fs.readFileSync(file, 'utf8'),
      writeFile: (file, content) => {
        if (path.resolve(file) === project.manifest) {
          manifestNext = serializeMigrationJson(JSON.parse(content), raw);
          return;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      },
      prepareUpstream: () => ({ ...upstream, cleanup: () => {} }),
    });
    if (!result || process.exitCode) throw new Error('新形式の配布物の同期に失敗しました');
  } finally {
    process.exitCode = previousExit;
  }
  if (!opts.dryRun) {
    fs.writeFileSync(project.manifest, manifestNext);
    if (plan.packageNext != null) fs.writeFileSync(plan.packagePath, plan.packageNext);
    for (const file of plan.removed) {
      sync.assertWithinRoot(project.root, file.absolute, `削除対象 (${file.to})`);
      if (pathExists(file.absolute)) {
        fs.rmSync(file.absolute, { force: true });
        out(`  削除: ${file.to}\n`);
      }
    }
  }
}

function runMigrate(opts, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s));
  const err = deps.err || ((s) => process.stderr.write(s));
  const sync = require('./cross-review.sync.js');
  const cache = new Map();
  const acquire = (upstream) => {
    const key = JSON.stringify([upstream.repo, upstream.ref]);
    if (!cache.has(key)) {
      try { cache.set(key, { tree: (deps.prepareUpstream || sync.defaultPrepareUpstream)(upstream.repo, upstream.ref, deps) }); }
      catch (error) { cache.set(key, { error }); }
    }
    const value = cache.get(key);
    if (value.error) throw value.error;
    return value.tree;
  };
  const report = { schemaVersion: 1, subject: 'migrate', result: 'clean', root: path.resolve(opts.root), projects: [] };
  let failed = false;
  let pending = false;
  try {
    const manifests = (deps.findManifests || findManifests)(report.root, opts.depth, deps);
    const inspections = manifests.map((file) => inspectMigration(file, acquire, deps))
      .sort((a, b) => a.project.root < b.project.root ? -1 : a.project.root > b.project.root ? 1 : 0);
    for (const inspection of inspections) {
      const project = inspection.project;
      report.projects.push(project);
      let status = { new: '新形式', 'not-applicable': '対象外', error: 'エラー', legacy: '旧形式' }[project.form];
      const details = [];
      if (opts.mode !== 'check' && project.form === 'legacy' && project.migratable === true) {
        try {
          const plan = planMigration(inspection);
          applyMigration(inspection, plan, opts, deps, (s) => details.push(s), err);
          status = opts.dryRun ? '移行予定' : '移行した';
        } catch (error) {
          failed = true;
          status = 'エラー';
          err(`${project.root}: ${error.message}\n`);
        }
      } else if (project.form === 'legacy') {
        pending = true;
        if (project.migratable !== true) status = '移行できない';
      }
      if (project.form === 'error' || (project.form === 'legacy' && project.migratable === null)) failed = true;
      if (!opts.json) {
        out(`[${status}] ${project.root}${project.reason ? ` (${project.reason}: ${project.message})` : ''}\n`);
        for (const detail of details) out(detail);
      }
    }
    report.result = failed ? 'error' : pending ? 'drift' : 'clean';
    if (opts.json) out(JSON.stringify(report) + '\n');
    process.exitCode = failed ? 3 : pending ? 1 : 0;
    return report;
  } finally {
    for (const { tree } of cache.values()) {
      try { tree?.cleanup?.(); } catch (error) { err(`上流の一時ディレクトリを削除できません: ${error.message}\n`); }
    }
  }
}

function main(argv = process.argv.slice(2), deps = {}) {
  const writeOut = deps.out || ((s) => process.stdout.write(s));
  const writeErr = deps.err || ((s) => process.stderr.write(s));
  const opts = parseArgs(argv);
  if (opts.help) { writeOut(USAGE + '\n'); return; }
  if (opts.error) { writeErr(`${opts.error}\n\n${USAGE}\n`); process.exitCode = 2; return; }
  if (opts.register) return runRegister(opts, deps);
  if (opts.migrate) return runMigrate(opts, deps);
  runAll(opts, deps);
}

module.exports = {
  runMigrate,
  runRegister,
  inspectRegistration,
  probeEngine,
  main,
  parseArgs,
  projectRootForManifest,
  findManifests,
  classifyManifestRaw,
  isSyncManifestContent,
  classifyResult,
  syncOne,
  resolveGlobalTargets,
  planGlobalSkill,
  formatGlobalPath,
  runGlobalSkill,
  formatSummary,
  collectSyncWarnings,
  errorMessageOf,
  runAll,
  SYNC_MANIFEST_FILENAME,
  SKILL_SOURCE,
  GLOBAL_SKILL_TARGETS,
  DEFAULT_DEPTH,
  USAGE,
};

if (require.main === module) main();
