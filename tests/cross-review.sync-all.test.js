// tools/cross-review.sync-all.js の引数解析・プロジェクト走査・結果分類・集計・一括同期の配線を検証する。
// 実ディレクトリ走査・実 runSync は外部依存なので、findManifests は listDir を注入し、runAll は
// findManifests / syncOne を注入して、書き込みや実 I/O 無しで分類と exit コードまで固定する。

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const syncModule = require('../tools/cross-review.sync.js');
const {
  main,
  parseArgs,
  projectRootForManifest,
  findManifests,
  classifyManifestRaw,
  isSyncManifestContent,
  classifyResult,
  errorMessageOf,
  collectSyncWarnings,
  formatSummary,
  planGlobalSkill,
  syncOne,
  runAll,
  DEFAULT_DEPTH,
  resolveGlobalTargets,
} = require('../tools/cross-review.sync-all.js');

// 同期対象とみなす準拠マニフェスト (upstream / files を持つ) の最小内容。
const CONFORMING_MANIFEST = JSON.stringify({ upstream: { repo: 'x', ref: 'main' }, files: [{ from: 'a', to: 'b' }] });

// withFileTypes 風のエントリを作るヘルパ。
function file(name) { return { name, isFile: () => true, isDirectory: () => false }; }
function dir(name) { return { name, isFile: () => false, isDirectory: () => true }; }

describe('sync-all parseArgs', () => {
  it('既定は sync モード・root 未指定・depth 既定', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'sync', dryRun: false, root: null, ref: null, depth: DEFAULT_DEPTH, list: false, error: null });
  });

  it('位置引数を root として解釈する', () => {
    expect(parseArgs(['/Develop'])).toMatchObject({ root: '/Develop', error: null });
  });

  it('--root と位置引数は同義 (どちらでも root)', () => {
    expect(parseArgs(['--root', '/Develop'])).toMatchObject({ root: '/Develop', error: null });
    expect(parseArgs(['--root=/Develop'])).toMatchObject({ root: '/Develop', error: null });
  });

  it('--check / --dry-run / --list を解釈する', () => {
    expect(parseArgs(['--check'])).toMatchObject({ mode: 'check' });
    expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true });
    expect(parseArgs(['--list'])).toMatchObject({ list: true });
  });

  it('--global-skill を解釈する (単独指定なら root は未指定のまま)', () => {
    expect(parseArgs(['--global-skill'])).toMatchObject({ globalSkill: true, root: null, error: null });
    expect(parseArgs([]).globalSkill).toBe(false);
  });

  it('--ref を解釈する', () => {
    expect(parseArgs(['--ref', 'feat/x'])).toMatchObject({ ref: 'feat/x', error: null });
    expect(parseArgs(['--ref=v1'])).toMatchObject({ ref: 'v1', error: null });
  });

  it('--depth は 0 以上の整数のみ', () => {
    expect(parseArgs(['--depth', '2'])).toMatchObject({ depth: 2, error: null });
    expect(parseArgs(['--depth=0'])).toMatchObject({ depth: 0, error: null });
    expect(parseArgs(['--depth', 'x']).error).toMatch(/--depth/);
    expect(parseArgs(['--depth=-1']).error).toMatch(/--depth/);
  });

  it('2 つ目の位置引数はエラー', () => {
    expect(parseArgs(['/a', '/b']).error).toMatch(/余計な引数/);
  });

  it('不明なオプションはエラー', () => {
    expect(parseArgs(['--nope']).error).toMatch(/不明なオプション/);
  });

  it('-h / --help でヘルプ', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

describe('projectRootForManifest', () => {
  it('tools/ 配下なら 1 つ上をルートにする', () => {
    expect(projectRootForManifest('/Develop/app/tools/cross-review.sync.json')).toBe('/Develop/app');
  });
  it('ルート直下ならマニフェストの置き場所がルート', () => {
    expect(projectRootForManifest('/Develop/app/cross-review.sync.json')).toBe('/Develop/app');
  });
});

describe('findManifests', () => {
  // 仮想ファイルツリー: dir 名 → エントリ配列。
  // findManifests は root からの子パスを path.join で組み立てるため、Windows では '/r/a' が
  // '\r\a' (root を path.resolve していれば 'D:\r\a') になる。キーを生の POSIX 文字列のままにすると
  // 一致せず全サブツリーがスキップされるので、キー・root・期待値をすべて path.resolve で正規化する
  // (POSIX では恒等変換なので挙動は変わらない)。
  const R = (p) => path.resolve(p);
  const tree = Object.fromEntries(Object.entries({
    '/r': [dir('a'), dir('b'), dir('node_modules'), dir('.hidden')],
    '/r/a': [dir('tools'), file('package.json')],
    '/r/a/tools': [file('cross-review.sync.json'), file('cross-review.js')],
    '/r/b': [file('cross-review.sync.json'), dir('sub')],
    '/r/b/sub': [dir('tools')],
    '/r/b/sub/tools': [file('cross-review.sync.json')],
    '/r/node_modules': [dir('dep')],
    '/r/node_modules/dep': [dir('tools')],
    '/r/node_modules/dep/tools': [file('cross-review.sync.json')],
    '/r/.hidden': [file('cross-review.sync.json')],
  }).map(([k, v]) => [R(k), v]));
  const listDir = (d) => {
    if (!(d in tree)) throw new Error('ENOENT');
    return tree[d];
  };

  it('tools/ とルート直下のマニフェストを検出し、node_modules / 隠しディレクトリは無視する', () => {
    const found = findManifests(R('/r'), DEFAULT_DEPTH, { listDir });
    expect(found).toEqual([
      R('/r/a/tools/cross-review.sync.json'),
      R('/r/b/cross-review.sync.json'),
      R('/r/b/sub/tools/cross-review.sync.json'),
    ]);
  });

  it('depth 制限で深い階層を打ち切る', () => {
    // depth 2 で /r/a/tools (depth 2) は届くが /r/b/sub/tools (depth 3) には届かない。
    const found = findManifests(R('/r'), 2, { listDir });
    expect(found).toContain(R('/r/a/tools/cross-review.sync.json'));
    expect(found).toContain(R('/r/b/cross-review.sync.json'));
    expect(found).not.toContain(R('/r/b/sub/tools/cross-review.sync.json'));
  });

  it('読めないディレクトリはスキップして落ちない', () => {
    expect(() => findManifests('/missing', 2, { listDir: () => { throw new Error('ENOENT'); } })).not.toThrow();
  });
});

describe('classifyManifestRaw', () => {
  it('upstream または files を持てば ok', () => {
    expect(classifyManifestRaw('{"upstream":{"repo":"x","ref":"main"}}')).toBe('ok');
    expect(classifyManifestRaw('{"files":[]}')).toBe('ok');
  });
  it('旧形式 {source,ref,commit} は skip (valid JSON だが新スキーマでない)', () => {
    expect(classifyManifestRaw('{"source":"o/r","ref":"main","commit":"abc"}')).toBe('skip');
  });
  it('valid JSON だが object でない (配列 / プリミティブ / null) は skip', () => {
    expect(classifyManifestRaw('[]')).toBe('skip');
    expect(classifyManifestRaw('42')).toBe('skip');
    expect(classifyManifestRaw('null')).toBe('skip');
  });
  it('読めない (raw=null) / JSON 構文エラー (破損) は invalid', () => {
    expect(classifyManifestRaw(null)).toBe('invalid');
    expect(classifyManifestRaw('{ not json')).toBe('invalid');
  });
});

describe('isSyncManifestContent', () => {
  it('upstream または files を持てば同期対象', () => {
    expect(isSyncManifestContent('{"upstream":{"repo":"x","ref":"main"}}')).toBe(true);
    expect(isSyncManifestContent('{"files":[]}')).toBe(true);
  });
  it('旧形式 {source,ref,commit} は対象外', () => {
    expect(isSyncManifestContent('{"source":"o/r","ref":"main","commit":"abc"}')).toBe(false);
  });
  it('JSON でない / null / 配列 / プリミティブは対象外', () => {
    expect(isSyncManifestContent('{ not json')).toBe(false);
    expect(isSyncManifestContent(null)).toBe(false);
    expect(isSyncManifestContent('[]')).toBe(false);
    expect(isSyncManifestContent('42')).toBe(false);
  });
});

describe('classifyResult', () => {
  const ok = (results, wrote = [], drift = false) => ({ result: { results, wrote, drift }, code: 0, threw: null });

  it('--check 差分ありは drift', () => {
    const r = classifyResult({ mode: 'check' }, { result: { results: [{ status: 'update' }], drift: true }, code: 1 });
    expect(r).toEqual({ status: 'drift', changed: 1 });
  });

  it('--check 差分なしは clean', () => {
    const r = classifyResult({ mode: 'check' }, ok([{ status: 'unchanged' }]));
    expect(r.status).toBe('clean');
  });

  it('同期で書き込みありは updated', () => {
    const r = classifyResult({ mode: 'sync', dryRun: false }, ok([{ status: 'update' }], ['tools/cross-review.js']));
    expect(r).toEqual({ status: 'updated', changed: 1 });
  });

  it('同期で書き込みなしは unchanged', () => {
    const r = classifyResult({ mode: 'sync', dryRun: false }, ok([{ status: 'unchanged' }], []));
    expect(r.status).toBe('unchanged');
  });

  it('--dry-run で変更ありは would-update', () => {
    const r = classifyResult({ mode: 'sync', dryRun: true }, ok([{ status: 'create' }], []));
    expect(r).toEqual({ status: 'would-update', changed: 1 });
  });

  it('result が null / 例外 / code 2 は error', () => {
    expect(classifyResult({ mode: 'sync' }, { result: null, code: 2 }).status).toBe('error');
    expect(classifyResult({ mode: 'sync' }, { result: null, code: 0, threw: new Error('boom') }).status).toBe('error');
    expect(classifyResult({ mode: 'sync', dryRun: false }, { result: { results: [], wrote: [] }, code: 1 }).status).toBe('error');
  });
});

describe('errorMessageOf', () => {
  it('例外なら message を返す', () => {
    expect(errorMessageOf({ threw: new Error('だめ') })).toBe('だめ');
  });
  it('stderr の最終行を返す', () => {
    expect(errorMessageOf({ err: '前置き\n上流の取得に失敗しました\n' })).toBe('上流の取得に失敗しました');
  });
  it('空なら既定メッセージ', () => {
    expect(errorMessageOf({ err: '' })).toMatch(/失敗/);
  });
});

// 捕捉した stderr から 1 行警告だけを拾う。移行ノートの全文ブロックは件数が集計行に出るので除く。
describe('collectSyncWarnings', () => {
  it('[cross-review] で始まる 1 行警告だけを拾う', () => {
    const err = [
      '[cross-review] 上流に配布物の雛形がありません',
      '上流の取得に失敗しました',
      '[cross-review] 移行ノートを読めません: 2026-09.md (ENOENT)',
      '',
    ].join('\n');
    expect(collectSyncWarnings(err)).toEqual([
      '[cross-review] 上流に配布物の雛形がありません',
      '[cross-review] 移行ノートを読めません: 2026-09.md (ENOENT)',
    ]);
  });

  it('未読の移行ノートの全文ブロックは拾わない', () => {
    const err = [
      '[cross-review] 未読の移行ノート (1 件)',
      '取り込み先で必要な作業が書かれています。同期のあとに対応してください。',
      '--- 2026-09.md ---',
      '本文',
      '[cross-review] 未読の移行ノートが 1 件あります (同期時に表示)',
      '[cross-review] マニフェスト検査に失敗しました',
    ].join('\n');
    expect(collectSyncWarnings(err)).toEqual(['[cross-review] マニフェスト検査に失敗しました']);
  });

  it('空 / undefined でも落ちない', () => {
    expect(collectSyncWarnings('')).toEqual([]);
    expect(collectSyncWarnings(undefined)).toEqual([]);
  });
});

describe('formatSummary', () => {
  it('件数とステータス行を含む', () => {
    const s = formatSummary('/Develop', [
      { project: '/Develop/a', status: 'updated', changed: 2 },
      { project: '/Develop/b', status: 'unchanged', changed: 0 },
      { project: '/Develop/c', status: 'error', changed: 0, message: 'gh が見つかりません' },
    ]);
    expect(s).toMatch(/検出した導入プロジェクト: 3 件/);
    expect(s).toMatch(/\[更新\] \(2 件\) \/Develop\/a/);
    expect(s).toMatch(/\[変更なし\] \/Develop\/b/);
    expect(s).toMatch(/\[エラー\] \(gh が見つかりません\) \/Develop\/c/);
  });

  it('未読の移行ノートがあれば件数を添える (無いプロジェクトには出さない)', () => {
    const s = formatSummary('/Develop', [
      { project: '/Develop/a', status: 'updated', changed: 1, migrations: 2 },
      { project: '/Develop/b', status: 'updated', changed: 1 },
    ]);
    expect(s).toMatch(/\[更新\] \(1 件\) \/Develop\/a \(移行ノート 2 件\)/);
    expect(s).toMatch(/\[更新\] \(1 件\) \/Develop\/b\n/);
  });

  it('マニフェスト未登録があれば件数を添える', () => {
    const s = formatSummary('/Develop', [
      { project: '/Develop/a', status: 'clean', changed: 0, missingManifest: 2 },
      { project: '/Develop/b', status: 'clean', changed: 0 },
    ]);
    expect(s).toMatch(/\[一致\] \/Develop\/a \(マニフェスト未登録 2 件\)/);
    expect(s).toMatch(/\[一致\] \/Develop\/b\n/);
  });

  it('マニフェスト検査が回らなかったプロジェクトには検査スキップを添える', () => {
    const s = formatSummary('/Develop', [
      { project: '/Develop/a', status: 'clean', changed: 0, manifestCheckSkipped: true },
      { project: '/Develop/b', status: 'clean', changed: 0 },
    ]);
    expect(s).toMatch(/\[一致\] \/Develop\/a \(マニフェスト検査スキップ\)/);
    expect(s).toMatch(/\[一致\] \/Develop\/b\n/);
  });

  it('警告はそのプロジェクトの行の直後にインデントして並ぶ', () => {
    const s = formatSummary('/Develop', [
      { project: '/Develop/a', status: 'clean', changed: 0, warnings: ['[cross-review] 雛形がありません', '[cross-review] 移行ノートを読めません'] },
      { project: '/Develop/b', status: 'clean', changed: 0 },
    ]);
    expect(s).toMatch(/\[一致\] \/Develop\/a\n {4}\[cross-review\] 雛形がありません\n {4}\[cross-review\] 移行ノートを読めません\n {2}\[一致\] \/Develop\/b/);
  });

  it('rootLabel が null なら走査の見出しを出さず、件数は global の行を数えない', () => {
    const s = formatSummary(null, [{ kind: 'global', project: 'global: ~/.claude/...', status: 'updated', changed: 1 }]);
    expect(s).not.toMatch(/走査ルート/);
    expect(s).toMatch(/\[更新\] \(1 件\) global:/);
  });

  it('プロジェクト行と global 行が並ぶとき、件数はプロジェクトだけを数える', () => {
    const s = formatSummary('/Develop', [
      { project: '/Develop/a', status: 'updated', changed: 1 },
      { kind: 'global', project: 'global: ~/.claude/...', status: 'unchanged', changed: 0 },
    ]);
    expect(s).toMatch(/検出した導入プロジェクト: 1 件/);
  });
});

describe('runAll', () => {
  const mkDeps = (manifests, syncResults, sink, readManifest) => ({
    findManifests: () => manifests,
    syncOne: (mp) => syncResults[mp],
    // 既定では全マニフェストを準拠扱いにし、同期経路 (doSync) を通す。
    readManifest: readManifest || (() => CONFORMING_MANIFEST),
    out: (s) => sink.out.push(s),
    err: (s) => sink.err.push(s),
  });

  it('プロジェクトが無ければ exit 3', () => {
    const sink = { out: [], err: [] };
    const r = runAll({ root: '/empty', depth: 4, mode: 'sync' }, mkDeps([], {}, sink));
    expect(r.exitCode).toBe(3);
    expect(sink.err.join('')).toMatch(/見つかりません/);
  });

  it('--list は同期せず列挙し exit 0', () => {
    const sink = { out: [], err: [] };
    const r = runAll(
      { root: '/r', depth: 4, mode: 'sync', list: true },
      mkDeps(['/r/a/tools/cross-review.sync.json'], {}, sink),
    );
    expect(r.exitCode).toBe(0);
    expect(sink.out.join('')).toMatch(/\/r\/a/);
  });

  it('updated と unchanged が混在しても exit 0', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/a/tools/cross-review.sync.json', '/r/b/tools/cross-review.sync.json'];
    const syncResults = {
      '/r/a/tools/cross-review.sync.json': { result: { results: [{ status: 'update' }], wrote: ['x'], drift: false }, code: 0 },
      '/r/b/tools/cross-review.sync.json': { result: { results: [{ status: 'unchanged' }], wrote: [], drift: false }, code: 0 },
    };
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, mkDeps(manifests, syncResults, sink));
    expect(r.exitCode).toBe(0);
    expect(r.items.map((i) => i.status)).toEqual(['updated', 'unchanged']);
  });

  it('1 件でもエラーがあれば exit 3 (他は続行)', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/a/tools/cross-review.sync.json', '/r/b/tools/cross-review.sync.json'];
    const syncResults = {
      '/r/a/tools/cross-review.sync.json': { result: null, code: 1, err: '上流の取得に失敗しました\n' },
      '/r/b/tools/cross-review.sync.json': { result: { results: [{ status: 'update' }], wrote: ['x'], drift: false }, code: 0 },
    };
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, mkDeps(manifests, syncResults, sink));
    expect(r.exitCode).toBe(3);
    expect(r.items[0]).toMatchObject({ status: 'error' });
    expect(r.items[1]).toMatchObject({ status: 'updated' });
  });

  it('--check でドリフトがあれば exit 1', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/a/tools/cross-review.sync.json'];
    const syncResults = {
      '/r/a/tools/cross-review.sync.json': { result: { results: [{ status: 'update' }], wrote: [], drift: true }, code: 1 },
    };
    const r = runAll({ root: '/r', depth: 4, mode: 'check' }, mkDeps(manifests, syncResults, sink));
    expect(r.exitCode).toBe(1);
    expect(r.items[0].status).toBe('drift');
  });

  it('--check でプロジェクトの error とドリフトが混在したら exit 3', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/a/tools/cross-review.sync.json', '/r/b/tools/cross-review.sync.json'];
    const syncResults = {
      [manifests[0]]: { result: { results: [{ status: 'update' }], wrote: [], drift: true }, code: 1 },
      [manifests[1]]: { result: null, code: 1, err: '上流取得失敗' },
    };
    const r = runAll({ root: '/r', depth: 4, mode: 'check' }, mkDeps(manifests, syncResults, sink));
    expect(r.exitCode).toBe(3);
    expect(r.items.map((i) => i.status)).toEqual(['drift', 'error']);
  });

  it('非準拠マニフェスト (旧形式) は同期せず skipped・exit 0', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/legacy/tools/cross-review.sync.json'];
    // syncOne は呼ばれてはいけない (呼ばれたら throw して検知)。
    const deps = mkDeps(manifests, {}, sink, () => '{"source":"o/r","ref":"main","commit":"abc"}');
    deps.syncOne = () => { throw new Error('skip 対象で syncOne が呼ばれた'); };
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, deps);
    expect(r.exitCode).toBe(0);
    expect(r.items[0].status).toBe('skipped');
  });

  it('準拠と非準拠が混在: 準拠だけ同期し、非準拠は skip・exit 0', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/app/tools/cross-review.sync.json', '/r/legacy/tools/cross-review.sync.json'];
    const syncResults = {
      '/r/app/tools/cross-review.sync.json': { result: { results: [{ status: 'update' }], wrote: ['x'], drift: false }, code: 0 },
    };
    const readManifest = (mp) => (mp.includes('legacy')
      ? '{"source":"o/r","ref":"main","commit":"abc"}'
      : CONFORMING_MANIFEST);
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, mkDeps(manifests, syncResults, sink, readManifest));
    expect(r.exitCode).toBe(0);
    expect(r.items.map((i) => i.status)).toEqual(['updated', 'skipped']);
  });

  it('--check でも非準拠は skip 扱い (ドリフト扱いしない・exit 0)', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/legacy/tools/cross-review.sync.json'];
    const deps = mkDeps(manifests, {}, sink, () => '{"source":"o/r"}');
    deps.syncOne = () => { throw new Error('skip 対象で syncOne が呼ばれた'); };
    const r = runAll({ root: '/r', depth: 4, mode: 'check' }, deps);
    expect(r.exitCode).toBe(0);
    expect(r.items[0].status).toBe('skipped');
  });

  it('破損マニフェスト (JSON 構文エラー) は skip せず error・exit 3', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/broken/tools/cross-review.sync.json'];
    const deps = mkDeps(manifests, {}, sink, () => '{ not json');
    deps.syncOne = () => { throw new Error('破損で syncOne が呼ばれた'); };
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, deps);
    expect(r.exitCode).toBe(3);
    expect(r.items[0].status).toBe('error');
  });

  it('読めないマニフェスト (raw=null) は skip せず error・exit 3', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/unreadable/tools/cross-review.sync.json'];
    const deps = mkDeps(manifests, {}, sink, () => null);
    deps.syncOne = () => { throw new Error('読めないのに syncOne が呼ばれた'); };
    const r = runAll({ root: '/r', depth: 4, mode: 'check' }, deps);
    expect(r.exitCode).toBe(3);
    expect(r.items[0].status).toBe('error');
  });

  it('準拠と破損が混在: 準拠は同期しつつ破損は error・全体 exit 3', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/app/tools/cross-review.sync.json', '/r/broken/tools/cross-review.sync.json'];
    const syncResults = {
      '/r/app/tools/cross-review.sync.json': { result: { results: [{ status: 'update' }], wrote: ['x'], drift: false }, code: 0 },
    };
    const readManifest = (mp) => (mp.includes('broken') ? '{ not json' : CONFORMING_MANIFEST);
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, mkDeps(manifests, syncResults, sink, readManifest));
    expect(r.exitCode).toBe(3);
    expect(r.items.map((i) => i.status)).toEqual(['updated', 'error']);
  });
});

function makeHomeFs(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [path.resolve(k), v]));
  const writes = [];
  const mkdirs = [];
  return {
    store,
    writes,
    mkdirs,
    readFile: (p) => {
      const key = path.resolve(p);
      if (!store.has(key)) throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      const value = store.get(key);
      if (value instanceof Error) throw value;
      return Buffer.from(value);
    },
    exists: (p) => store.has(path.resolve(p)),
    writeFile: (p, c) => { const key = path.resolve(p); store.set(key, c); writes.push({ path: key, content: c }); },
    mkdir: (d) => { mkdirs.push(path.resolve(d)); store.set(path.resolve(d), ''); },
  };
}

const HOME = path.resolve('/home/u');
const SOURCE = path.resolve('/repo/.claude/skills/cross-review/SKILL.md');
const SKILL = Buffer.from('# SKILL 本文\n');
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const skillPath = (dir) => path.join(HOME, dir, 'skills', 'cross-review', 'SKILL.md');
const CLAUDE = skillPath('.claude');
const CODEX = skillPath('.codex');
const CODEX_SUBAGENT = skillPath('.codex-subagent');
const AGENTS = skillPath('.agents');

function globalDeps(homeFiles = {}, overrides = {}) {
  const fsx = makeHomeFs({ [SOURCE]: SKILL, [path.join(HOME, '.claude')]: '', ...homeFiles });
  const sink = { out: [], err: [] };
  return {
    fsx,
    sink,
    deps: {
      scriptDir: path.resolve('/repo/tools'), home: HOME, env: {}, platform: 'linux',
      exists: fsx.exists, readFile: fsx.readFile, writeFile: fsx.writeFile, mkdir: fsx.mkdir,
      gitRun: (args) => args[0] === 'log' ? 'abc\n' : Buffer.from('過去の版\n'),
      realpath: (p) => path.resolve(p),
      unlink: (p) => fsx.store.delete(path.resolve(p)),
      rmdir: (p) => {
        if ([...fsx.store.keys()].some((key) => key.startsWith(path.resolve(p) + path.sep))) throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' });
        fsx.store.delete(path.resolve(p));
      },
      findManifests: () => { throw new Error('走査してはいけない'); },
      out: (s) => sink.out.push(s), err: (s) => sink.err.push(s), ...overrides,
    },
  };
}

function globalOptions(extra = {}) {
  return { root: null, depth: 4, mode: 'check', globalSkill: true, ...extra };
}

describe('resolveGlobalTargets', () => {
  it('既定ホームと固定ホームを識別し、配布先を常に2要素返す', () => {
    const h = globalDeps();
    const targets = resolveGlobalTargets(h.deps);
    expect(targets.map((t) => [t.id, t.homeFrom, t.path])).toEqual([
      ['claude', 'default', CLAUDE], ['agents', 'fixed', AGENTS],
    ]);
    expect(targets.map((t) => t.available)).toEqual([true, false]);
  });

  it('環境変数の相対パスは絶対化し、~ は展開しない', () => {
    const h = globalDeps({}, { env: { CLAUDE_CONFIG_DIR: 'custom/claude', CODEX_HOME: '~/codex' } });
    const targets = resolveGlobalTargets(h.deps);
    expect(targets[0]).toMatchObject({ home: path.resolve('custom/claude'), homeFrom: 'CLAUDE_CONFIG_DIR', path: path.resolve('custom/claude/skills/cross-review/SKILL.md') });
    expect(targets[1]).toMatchObject({ home: path.join(HOME, '.agents'), homeFrom: 'fixed', path: AGENTS });
  });

  it('空文字の環境変数は未設定として既定を使う', () => {
    const h = globalDeps({}, { env: { CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' } });
    expect(resolveGlobalTargets(h.deps).map((t) => t.homeFrom)).toEqual(['default', 'fixed']);
    expect(resolveGlobalTargets(h.deps).map((t) => t.path)).toEqual([CLAUDE, AGENTS]);
  });

  it('Claude のホームが無ければ環境変数名を理由に含めて対象外にする', () => {
    const h = globalDeps({}, { env: { CLAUDE_CONFIG_DIR: '/absent' } });
    expect(resolveGlobalTargets(h.deps)[0]).toMatchObject({ available: false, reason: expect.stringMatching(/CLAUDE_CONFIG_DIR.*無いため配布しない/) });
  });


});

describe('planGlobalSkill', () => {
  it('未配置、古い、一致をバイト比較で区別する', () => {
    const h = globalDeps({ [path.join(HOME, '.codex/skills')]: '', [AGENTS]: '古い' });
    const plans = planGlobalSkill({ ...h.deps, skillBuffer: SKILL, sourcePath: SOURCE, sourceSha256: digest(SKILL) });
    expect(plans.map((p) => p.state)).toEqual(['missing', 'stale']);
    expect(plans.map((p) => p.sha256)).toEqual([null, digest('古い')]);
    expect(plans.every((p) => p.reason === null)).toBe(true);
  });

  it('同じ置換文字にデコードされる異なるバイトも stale にする', () => {
    const h = globalDeps({ [CLAUDE]: Buffer.from([0xff]) });
    const plans = planGlobalSkill({ ...h.deps, skillBuffer: Buffer.from([0xfe]), sourcePath: SOURCE, sourceSha256: digest(Buffer.from([0xfe])) });
    expect(plans[0].state).toBe('stale');
  });

  it('行末だけが違う写し (CRLF の正本と LF の写し) も stale にする', () => {
    const crlf = Buffer.from('# SKILL\r\n本文\r\n');
    const h = globalDeps({ [CLAUDE]: Buffer.from('# SKILL\n本文\n') });
    const plans = planGlobalSkill({ ...h.deps, skillBuffer: crlf, sourcePath: SOURCE, sourceSha256: digest(crlf) });
    expect(plans[0].state).toBe('stale');
  });
});

describe('runAll の --global-skill', () => {
  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it('書き込みモードは missing と unreadable に配る', () => {
    const h = globalDeps({ [path.join(HOME, '.codex/skills')]: '', [AGENTS]: new Error('EACCES') });
    const r = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.items[0]).toMatchObject({ kind: 'global', status: 'updated', changed: 2 });
    expect(r.items[0].plans.map((p) => p.state)).toEqual(['missing', 'unreadable']);
    expect(h.fsx.writes.map((w) => w.path)).toEqual([CLAUDE, AGENTS]);
    expect(h.fsx.writes.every((w) => w.content.equals(SKILL))).toBe(true);
    expect(h.sink.out.join('')).not.toMatch(/走査ルート/);
    expect(h.sink.out.join('')).toMatch(/未配置.*読めない/);
  });

  it('Claude のホームも Codex の skills も無い環境は作らず対象外にする', () => {
    const h = globalDeps();
    h.fsx.store.delete(path.join(HOME, '.claude'));
    const r = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.items[0].plans.map((p) => p.state)).toEqual(['skipped', 'skipped']);
    expect(h.fsx.writes).toEqual([]);
    expect(h.fsx.mkdirs).toEqual([]);
    expect(h.sink.err).toHaveLength(2);
  });

  it('Codex のホームだけあっても skills を作らない', () => {
    const h = globalDeps({ [path.join(HOME, '.codex')]: '' });
    runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(h.fsx.writes.map((w) => w.path)).toEqual([CLAUDE]);
    expect(h.fsx.mkdirs).toEqual([path.dirname(CLAUDE)]);
  });

  it.each([
    ['missing', undefined, 0, 'clean'], ['match', SKILL, 0, 'clean'], ['stale', '古い', 1, 'drift'],
    ['unreadable', new Error('EACCES'), 3, 'error'],
  ])('--check: %s の終了コードと JSON のフィールドが一致する', (state, content, code, result) => {
    for (const json of [false, true]) {
      const h = globalDeps(content === undefined ? {} : { [CLAUDE]: content });
      const r = runAll(globalOptions({ json }), h.deps);
      expect(r.exitCode).toBe(code);
      expect(process.exitCode).toBe(code);
      expect(h.fsx.writes).toEqual([]);
      if (!json) {
        expect(h.sink.out.join('')).toContain({ missing: '未配置', match: '一致', stale: '古い', unreadable: '読めない' }[state]);
        continue;
      }
      const output = h.sink.out.join('');
      const report = JSON.parse(output);
      expect(output).toBe(JSON.stringify(report, null, 2) + '\n');
      expect(report).toEqual({
        schemaVersion: 2, result,
        source: { path: SOURCE, sha256: digest(SKILL), error: null },
        targets: [
          {
            id: 'claude', path: CLAUDE, home: path.join(HOME, '.claude'), homeFrom: 'default', state,
            sha256: ['match', 'stale'].includes(state) ? digest(content) : null,
            sourcePath: SOURCE, sourceSha256: digest(SKILL), reason: state === 'unreadable' ? expect.any(String) : null,
          },
          ...['agents'].map((id) => ({
            id, path: AGENTS, home: path.join(HOME, '.agents'),
            homeFrom: 'fixed', state: 'skipped', sha256: null,
            sourcePath: SOURCE, sourceSha256: digest(SKILL), reason: expect.any(String),
          })),
        ],
      });
      expect(h.sink.err.join('')).toMatch(/配布しません/);
    }
  });

  it('stale と unreadable の混在は exit 3 を優先する', () => {
    for (const json of [false, true]) {
      const h = globalDeps({ [CLAUDE]: '古い', [path.join(HOME, '.codex/skills')]: '', [CODEX]: new Error('EACCES') });
      expect(runAll(globalOptions({ json }), h.deps).exitCode).toBe(3);
      if (json) expect(JSON.parse(h.sink.out.join('')).result).toBe('error');
    }
  });

  it.each(['missing', 'unreadable'])('配布元が %s なら exit 3 と source.error を返す', (state) => {
    for (const json of [false, true]) {
      const h = globalDeps();
      if (state === 'missing') h.fsx.store.delete(SOURCE);
      else h.fsx.store.set(SOURCE, new Error('EACCES'));
      const r = runAll(globalOptions({ json }), h.deps);
      expect(r.exitCode).toBe(3);
      if (json) expect(JSON.parse(h.sink.out.join(''))).toEqual({ schemaVersion: 2, result: 'error', source: { path: SOURCE, sha256: null, error: expect.stringMatching(/配布元の SKILL を読めません/) }, targets: [] });
      else expect(h.sink.out.join('')).toMatch(/エラー/);
      expect(h.fsx.writes).toEqual([]);
    }
  });

  it('--dry-run は配布予定を表示して書き込まない', () => {
    const h = globalDeps();
    const r = runAll(globalOptions({ mode: 'sync', dryRun: true }), h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.items[0]).toMatchObject({ status: 'would-update', changed: 1 });
    expect(h.fsx.writes).toEqual([]);
  });

  it('上書きに失敗したら exit 3 と配布先ごとの状態を表示する', () => {
    const h = globalDeps({ [CLAUDE]: new Error('EACCES') }, { writeFile: () => { throw new Error('EACCES write'); } });
    const r = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(r.exitCode).toBe(3);
    expect(h.sink.out.join('')).toMatch(/配布に失敗.*EACCES write.*読めない/);
  });

  it('--list は環境変数で解決した配布先を表示し、検査も書き込みもしない', () => {
    const h = globalDeps({}, { env: { CLAUDE_CONFIG_DIR: '/custom/claude', CODEX_HOME: '/custom/codex' }, readFile: () => { throw new Error('検査してはいけない'); } });
    const r = runAll(globalOptions({ list: true }), h.deps);
    expect(r.exitCode).toBe(0);
    const output = h.sink.out.join('');
    expect(output).toContain(path.resolve('/custom/claude/skills/cross-review/SKILL.md'));
    expect(output).toContain(`~${path.sep}.agents${path.sep}skills${path.sep}cross-review${path.sep}SKILL.md`);
    expect(output).toContain('対象外');
    expect(h.fsx.writes).toEqual([]);
  });

  it.each([false, true])('環境変数で指定したホームだけを検査または配布する (check=%s)', (check) => {
    const customClaude = path.resolve('/custom/claude');
    const customCodex = path.resolve('/custom/codex');
    const h = globalDeps({ [customClaude]: '', [path.join(customCodex, 'skills')]: '' }, { env: { CLAUDE_CONFIG_DIR: customClaude, CODEX_HOME: customCodex } });
    const r = runAll(globalOptions({ mode: check ? 'check' : 'sync' }), h.deps);
    expect(r.items[0].plans.slice(0, 2).map((p) => [p.home, p.homeFrom, p.state])).toEqual([
      [customClaude, 'CLAUDE_CONFIG_DIR', 'missing'], [path.join(HOME, '.agents'), 'fixed', 'missing'],
    ]);
    expect(h.fsx.writes.map((w) => w.path)).toEqual(check ? [] : [path.join(customClaude, 'skills/cross-review/SKILL.md'), AGENTS]);
  });

  it('--root 併用でもプロジェクトの error はグローバルの stale に優先する', () => {
    const h = globalDeps({ [CLAUDE]: '古い' }, {
      findManifests: () => ['/r/a/tools/cross-review.sync.json'],
      readManifest: () => CONFORMING_MANIFEST,
      syncOne: () => ({ result: null, code: 1, err: '取得失敗' }),
    });
    const r = runAll(globalOptions({ root: '/r' }), h.deps);
    expect(r.exitCode).toBe(3);
    expect(r.items.map((i) => i.status)).toEqual(['error', 'drift']);
    expect(h.sink.out.join('')).toMatch(/検出した導入プロジェクト: 1 件/);
  });
});

describe('agents への配布と旧配置の片付け', () => {
  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it.each(['.codex', '.codex-subagent'])('%s の印があれば agents の skills が無くても作って配る', (dir) => {
    const h = globalDeps({ [path.join(HOME, dir, 'skills')]: '' });
    expect(h.fsx.exists(path.join(HOME, '.agents/skills'))).toBe(false);
    expect(runAll(globalOptions({ mode: 'sync' }), h.deps).exitCode).toBe(0);
    expect(h.fsx.writes.map((w) => w.path)).toEqual([CLAUDE, AGENTS]);
  });

  it('CODEX_HOME を印と旧配置に使い、配布先は agents に固定する', () => {
    const custom = path.resolve('/custom/codex');
    const old = path.join(custom, 'skills/cross-review/SKILL.md');
    const h = globalDeps({ [path.join(custom, 'skills')]: '', [old]: SKILL }, { env: { CODEX_HOME: custom } });
    const result = runAll(globalOptions({ json: true }), h.deps);
    expect(result.exitCode).toBe(1);
    expect(result.items[0].plans[1]).toMatchObject({ id: 'agents', path: AGENTS, state: 'missing', homeFrom: 'fixed' });
    expect(result.items[0].plans[2]).toMatchObject({ id: 'codex-legacy', home: custom, homeFrom: 'CODEX_HOME', path: old, removable: true });
    expect(h.fsx.writes).toEqual([]);
  });

  it.each([
    ['agents', () => path.join(HOME, '.agents'), {}],
    ['claude', () => path.resolve('/custom/shared'), { CLAUDE_CONFIG_DIR: path.resolve('/custom/shared') }],
  ])('CODEX_HOME が %s の配布先と同じパスなら旧配置として扱わず、配った写しを消さない', (_name, codexHome, env) => {
    const home = codexHome();
    const shared = path.join(home, 'skills/cross-review/SKILL.md');
    const h = globalDeps({ [home]: '', [path.join(home, 'skills')]: '', [shared]: SKILL }, { env: { ...env, CODEX_HOME: home } });
    const result = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.items[0].plans.some((p) => p.id === 'codex-legacy')).toBe(false);
    expect(h.fsx.exists(shared)).toBe(true);
  });

  it('旧配置の skills が agents の skills へのリンクなら、実体が同じなので消さない', () => {
    const codexSkills = path.join(HOME, '.codex/skills');
    const agentsSkills = path.join(HOME, '.agents/skills');
    const realpath = (p) => {
      const resolved = path.resolve(p);
      return resolved.startsWith(codexSkills) ? agentsSkills + resolved.slice(codexSkills.length) : resolved;
    };
    const h = globalDeps({ [codexSkills]: '', [agentsSkills]: '', [CODEX]: SKILL, [AGENTS]: SKILL }, { realpath });
    const result = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.items[0].plans.some((p) => p.id === 'codex-legacy')).toBe(false);
    expect(h.fsx.exists(CODEX)).toBe(true);
  });

  it('旧配置の SKILL.md がもう一方の旧配置へのファイルのリンクでも、両方を片付ける', () => {
    const realpath = (p) => (path.resolve(p) === path.resolve(CODEX) ? path.resolve(CODEX_SUBAGENT) : path.resolve(p));
    const h = globalDeps({ [path.join(HOME, '.codex/skills')]: '', [CODEX]: SKILL, [CODEX_SUBAGENT]: SKILL }, { realpath });
    expect(runAll(globalOptions({ mode: 'sync' }), h.deps).exitCode).toBe(0);
    expect(h.fsx.exists(CODEX)).toBe(false);
    expect(h.fsx.exists(CODEX_SUBAGENT)).toBe(false);
    expect(runAll(globalOptions({ json: true }), h.deps).exitCode).toBe(0);
  });

  it('配布先の SKILL.md が旧配置へのファイルのリンクなら、リンク先の旧配置を消さない', () => {
    const realpath = (p) => (path.resolve(p) === path.resolve(AGENTS) ? path.resolve(CODEX) : path.resolve(p));
    const h = globalDeps({ [path.join(HOME, '.codex/skills')]: '', [CODEX]: SKILL, [AGENTS]: SKILL }, { realpath });
    expect(runAll(globalOptions({ mode: 'sync' }), h.deps).exitCode).toBe(0);
    expect(h.fsx.exists(CODEX)).toBe(true);
  });

  it('旧配置の実体を確かめられなければ removable: false にして消さない', () => {
    const realpath = (p) => {
      if (path.resolve(p).startsWith(path.join(HOME, '.codex'))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return path.resolve(p);
    };
    const h = globalDeps({ [path.join(HOME, '.codex/skills')]: '', [CODEX]: SKILL }, { realpath });
    const check = runAll(globalOptions({ json: true }), h.deps);
    expect(check.exitCode).toBe(1);
    expect(check.items[0].plans.find((p) => p.id === 'codex-legacy')).toMatchObject({ state: 'legacy', removable: false, reason: expect.stringContaining('実体のパス') });
    runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(h.fsx.exists(CODEX)).toBe(true);
  });

  it('CODEX_HOME が変われば既定の codex の印は使わない', () => {
    const h = globalDeps({ [path.join(HOME, '.codex/skills')]: '' }, { env: { CODEX_HOME: '/custom/absent' } });
    expect(resolveGlobalTargets(h.deps)[1]).toMatchObject({ available: false, reason: expect.any(String) });
  });

  it.each(['過去の版\n', '過去の版\r\n', SKILL])('配布版と一致する旧配置を削除し、空の cross-review だけ片付ける: %s', (content) => {
    const dir = path.dirname(CODEX);
    const skills = path.dirname(dir);
    const h = globalDeps({ [CODEX]: content, [dir]: '', [skills]: '' });
    const result = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.items[0].plans.at(-1)).toMatchObject({ state: 'legacy', removable: true, reason: null });
    expect(h.fsx.exists(CODEX)).toBe(false);
    expect(h.fsx.exists(dir)).toBe(false);
    expect(h.fsx.exists(skills)).toBe(true);
    expect(h.fsx.exists(AGENTS)).toBe(true);
  });

  it('別ファイルのある cross-review ディレクトリは残す', () => {
    const dir = path.dirname(CODEX);
    const other = path.join(dir, 'custom.md');
    const h = globalDeps({ [CODEX]: SKILL, [dir]: '', [other]: '独自設定' });
    expect(runAll(globalOptions({ mode: 'sync' }), h.deps).exitCode).toBe(0);
    expect(h.fsx.exists(CODEX)).toBe(false);
    expect(h.fsx.exists(dir)).toBe(true);
    expect(h.fsx.exists(other)).toBe(true);
  });

  it('一致しない旧配置を残して stderr に理由を警告する', () => {
    const h = globalDeps({ [CODEX]: '利用者の編集' });
    const result = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.items[0].plans.at(-1)).toMatchObject({ removable: false, reason: expect.stringContaining('一致しません') });
    expect(h.fsx.store.get(CODEX)).toBe('利用者の編集');
    expect(h.sink.err.join('')).toContain('旧配置を残します');
  });

  it.each(['log', 'show'])('git %s が失敗したら現在版と一致しても削除しない', (failure) => {
    const h = globalDeps({ [CODEX]: SKILL }, { gitRun: (args) => {
      if (args[0] === failure) throw new Error('git failed');
      return 'abc';
    } });
    const result = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.items[0].plans.at(-1)).toMatchObject({ removable: false, reason: expect.stringContaining('git failed') });
    expect(h.fsx.exists(CODEX)).toBe(true);
  });

  it('--dry-run は削除予定と残す理由を表示し、どちらも削除しない', () => {
    const h = globalDeps({ [CODEX]: SKILL, [CODEX_SUBAGENT]: '独自版' });
    runAll(globalOptions({ mode: 'sync', dryRun: true }), h.deps);
    expect(h.sink.out.join('')).toContain('旧配置を削除予定');
    expect(h.sink.out.join('')).toMatch(/旧配置を残す: .*一致しません/);
    expect(h.fsx.exists(CODEX)).toBe(true);
    expect(h.fsx.exists(CODEX_SUBAGENT)).toBe(true);
    expect(h.fsx.writes).toEqual([]);
  });

  it.each([false, true])('--check は legacy を drift として返し、削除しない (json=%s)', (json) => {
    const h = globalDeps({ [CLAUDE]: SKILL, [CODEX]: SKILL });
    main(['--global-skill', '--check', ...(json ? ['--json'] : [])], h.deps);
    expect(process.exitCode).toBe(1);
    if (json) {
      const report = JSON.parse(h.sink.out.join(''));
      expect(report).toMatchObject({ schemaVersion: 2, result: 'drift' });
      expect(report.targets.at(-1)).toEqual({ id: 'codex-legacy', path: CODEX, home: path.join(HOME, '.codex'), homeFrom: 'default',
        state: 'legacy', removable: true, sha256: digest(SKILL), reason: null, sourcePath: SOURCE, sourceSha256: digest(SKILL) });
    } else expect(h.sink.out.join('')).toContain('旧配置');
    expect(h.fsx.exists(CODEX)).toBe(true);
    expect(h.fsx.writes).toEqual([]);
  });

  it('旧配置が無ければ JSON は clean で終了コード 0 にする', () => {
    const h = globalDeps({ [CLAUDE]: SKILL });
    main(['--global-skill', '--check', '--json'], h.deps);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(h.sink.out.join(''))).toMatchObject({ schemaVersion: 2, result: 'clean', targets: [{ id: 'claude' }, { id: 'agents' }] });
  });

  it('読めない旧配置は drift に優先して error と終了コード 3 を返す', () => {
    const h = globalDeps({ [CODEX]: SKILL, [CODEX_SUBAGENT]: new Error('EACCES') });
    main(['--global-skill', '--check', '--json'], h.deps);
    expect(process.exitCode).toBe(3);
    const report = JSON.parse(h.sink.out.join(''));
    expect(report.result).toBe('error');
    expect(report.targets.at(-1)).toMatchObject({ id: 'codex-subagent-legacy', state: 'unreadable', removable: false, sha256: null, reason: expect.stringContaining('EACCES') });
  });

  it.each(['linux', 'win32'])('%s: 同じパスに解決した旧配置を 1 件にする', (platform) => {
    const h = globalDeps({ [CODEX_SUBAGENT]: SKILL }, { platform, env: { CODEX_HOME: path.join(HOME, '.codex-subagent') + path.sep } });
    expect(runAll(globalOptions(), h.deps).items[0].plans.filter((p) => p.state === 'legacy')).toHaveLength(1);
  });

  it('win32 の旧配置の重複判定は大文字と小文字を区別しない', () => {
    const upper = skillPath('.CODEX-SUBAGENT');
    const h = globalDeps({ [upper]: SKILL, [CODEX_SUBAGENT]: SKILL }, { platform: 'win32', env: { CODEX_HOME: path.join(HOME, '.CODEX-SUBAGENT') } });
    expect(runAll(globalOptions(), h.deps).items[0].plans.filter((p) => p.state === 'legacy')).toHaveLength(1);
    h.deps.platform = 'linux';
    expect(runAll(globalOptions(), h.deps).items[0].plans.filter((p) => p.state === 'legacy')).toHaveLength(2);
  });

  it('過去版はこの checkout の Git から全件取得し、2 つの旧配置で共有する', () => {
    const calls = [];
    const h = globalDeps({ [CODEX]: '最初の版\r\n', [CODEX_SUBAGENT]: '次の版\n' }, {
      gitRun: undefined,
      execFileSync: (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === 'log') return Buffer.from('first\nsecond\n');
        return Buffer.from(args[1].startsWith('first:') ? '最初の版\n' : '次の版\n');
      },
    });
    const result = runAll(globalOptions(), h.deps);
    expect(result.items[0].plans.slice(-2).every((p) => p.removable)).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([
      ['log', '--format=%H', '--diff-filter=AM', '--', '.claude/skills/cross-review/SKILL.md'],
      ['show', 'first:.claude/skills/cross-review/SKILL.md'],
      ['show', 'second:.claude/skills/cross-review/SKILL.md'],
    ]);
    expect(calls.every((c) => c.command === 'git' && c.options.cwd === path.resolve('/repo'))).toBe(true);
  });

  it('履歴が空なら削除できない理由を記録する', () => {
    const h = globalDeps({ [CODEX]: SKILL }, { gitRun: () => '' });
    const result = runAll(globalOptions(), h.deps);
    expect(result.items[0].plans.at(-1)).toMatchObject({ removable: false, reason: expect.stringContaining('履歴がありません') });
  });

  it('旧配置が無ければ Git を起動しない', () => {
    const h = globalDeps({}, { gitRun: () => { throw new Error('Git を起動してはいけない'); } });
    expect(runAll(globalOptions(), h.deps).exitCode).toBe(0);
  });

  it('旧配置のハッシュは改行を正規化する前のバイト列から計算する', () => {
    const content = Buffer.from('過去の版\r\n');
    const h = globalDeps({ [CODEX]: content });
    const result = runAll(globalOptions(), h.deps);
    expect(result.items[0].plans.at(-1)).toMatchObject({ removable: true, sha256: digest(content) });
  });

  it('異なる不正バイトを同じ文字へ置換して一致させない', () => {
    const h = globalDeps({ [CODEX]: Buffer.from([0xff]) }, { gitRun: (args) => args[0] === 'log' ? 'abc' : Buffer.from([0xfe]) });
    expect(runAll(globalOptions(), h.deps).items[0].plans.at(-1).removable).toBe(false);
  });

  it.each(['unlink', 'rmdir'])('%s の失敗を終了コード 3 で報告する', (operation) => {
    const h = globalDeps({ [CODEX]: SKILL }, { [operation]: () => { throw new Error('EACCES cleanup'); } });
    const result = runAll(globalOptions({ mode: 'sync' }), h.deps);
    expect(result.exitCode).toBe(3);
    expect(result.items[0].message).toContain('EACCES cleanup');
  });

  it('新しい配布先への書き込みが失敗したときは旧配置を削除しない', () => {
    const h = globalDeps({ [CODEX]: SKILL }, { writeFile: () => { throw new Error('write failed'); } });
    expect(runAll(globalOptions({ mode: 'sync' }), h.deps).exitCode).toBe(3);
    expect(h.fsx.exists(CODEX)).toBe(true);
  });

  it('削除だけを予定するときも dry-run を更新予定として数える', () => {
    const h = globalDeps({ [CLAUDE]: SKILL, [CODEX]: SKILL });
    const result = runAll(globalOptions({ mode: 'sync', dryRun: true }), h.deps);
    expect(result.items[0]).toMatchObject({ status: 'would-update', changed: 1 });
    expect(h.fsx.exists(CODEX)).toBe(true);
  });

});

describe('--json の引数', () => {
  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });
  it('グローバル単独の --check のみ受け付ける', () => {
    expect(parseArgs(['--global-skill', '--check', '--json'])).toMatchObject({ json: true, error: null });
  });

  it.each([
    ['--check', '--json'], ['--global-skill', '--json'],
    ['--global-skill', '--check', '--json', '--root', '/r'],
    ['--global-skill', '--check', '--json', '--root=/r'],
    ['--global-skill', '--check', '--json', '/r'],
    ['--global-skill', '--check', '--json', '--list'],
    ['--global-skill', '--check', '--json', '--dry-run'],
  ])('無効な組み合わせ %j は引数エラー exit 2 にする', (...args) => {
    expect(parseArgs(args).error).toMatch(/--json/);
    const h = globalDeps();
    main(args, h.deps);
    expect(process.exitCode).toBe(2);
    expect(h.sink.out.join('')).toBe('');
    expect(h.sink.err.join('')).toMatch(/--json/);
  });

  it('--help は引数エラーより優先してヘルプを出す', () => {
    const h = globalDeps();
    main(['--help', '--json'], h.deps);
    expect(process.exitCode).toBe(0);
    expect(h.sink.out.join('')).toMatch(/使い方/);
  });
});

describe('配布条件のディレクトリを調べられないとき', () => {
  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  const denyingExists = (fsx, denied) => (p) => {
    if (path.resolve(p) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return fsx.exists(p);
  };

  it('--check は対象外ではなく unreadable にし、exit 3 と JSON の error を返す', () => {
    const h = globalDeps();
    h.deps.exists = denyingExists(h.fsx, path.join(HOME, '.codex', 'skills'));
    const r = runAll(globalOptions({ json: true }), h.deps);
    expect(r.exitCode).toBe(3);
    const report = JSON.parse(h.sink.out.join(''));
    expect(report.result).toBe('error');
    expect(report.targets[1]).toMatchObject({ id: 'agents', state: 'unreadable', sha256: null });
    expect(report.targets[1].reason).toMatch(/EACCES/);
  });

  it('--list は読めないことを対象外と分けて表示する', () => {
    const h = globalDeps();
    h.deps.exists = denyingExists(h.fsx, path.join(HOME, '.codex', 'skills'));
    runAll(globalOptions({ mode: 'sync', list: true }), h.deps);
    expect(h.sink.out.join('')).toMatch(/\(読めない: .*EACCES/);
  });
});

describe('runAll の --global-skill --dry-run', () => {
  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it('読めない写しは書き込みのモードと同じく配布予定に数える', () => {
    const h = globalDeps({ [CLAUDE]: new Error('EACCES') });
    const r = runAll(globalOptions({ mode: 'sync', dryRun: true }), h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.items[0]).toMatchObject({ status: 'would-update', changed: 1 });
    expect(h.fsx.writes).toEqual([]);
  });
});

describe('runAll のマニフェスト検査', () => {
  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it('--check では sync に checkManifest を渡し、未登録件数を集計に出す (exit 1 にはしない)', () => {
    const sink = { out: [], err: [] };
    const seen = [];
    const r = runAll({ root: '/r', depth: 4, mode: 'check' }, {
      findManifests: () => ['/r/a/tools/cross-review.sync.json'],
      readManifest: () => CONFORMING_MANIFEST,
      syncOne: (mp, o) => {
        seen.push(o);
        return {
          result: {
            results: [{ status: 'unchanged' }],
            wrote: [],
            drift: false,
            missingManifestEntries: [{ from: 'tools/x.js', to: 'tools/x.js' }, { from: 'docs/y.md', to: 'docs/y.md' }],
          },
          code: 0,
        };
      },
      out: (s) => sink.out.push(s),
      err: (s) => sink.err.push(s),
    });
    expect(seen[0].mode).toBe('check');
    expect(r.exitCode).toBe(0);
    expect(r.items[0]).toMatchObject({ status: 'clean', missingManifest: 2 });
    expect(sink.out.join('')).toMatch(/\(マニフェスト未登録 2 件\)/);
  });

  // 各プロジェクトの stderr は syncOne が捕捉するので、警告は集計へ引き上げないと消える。
  it('runSync の警告を集計行の直後に出し、検査スキップを集計行に付ける', () => {
    const sink = { out: [], err: [] };
    const r = runAll({ root: '/r', depth: 4, mode: 'check' }, {
      findManifests: () => ['/r/a/tools/cross-review.sync.json'],
      readManifest: () => CONFORMING_MANIFEST,
      syncOne: () => ({
        result: {
          results: [{ status: 'unchanged' }],
          wrote: [],
          drift: false,
          missingManifestEntries: [],
          manifestCheckWarning: '上流に配布物の雛形が無いため、マニフェスト検査をスキップします',
        },
        code: 0,
        err: '[cross-review] 上流に配布物の雛形が無いため、マニフェスト検査をスキップします\n',
      }),
      out: (s) => sink.out.push(s),
      err: (s) => sink.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(r.items[0]).toMatchObject({ status: 'clean', manifestCheckSkipped: true });
    expect(r.items[0].warnings).toHaveLength(1);
    expect(sink.out.join('')).toMatch(/\(マニフェスト検査スキップ\)\n {4}\[cross-review\] 上流に配布物の雛形が無いため/);
  });

  it('警告が無いプロジェクトには警告行も検査スキップも付かない', () => {
    const sink = { out: [], err: [] };
    const r = runAll({ root: '/r', depth: 4, mode: 'check' }, {
      findManifests: () => ['/r/a/tools/cross-review.sync.json'],
      readManifest: () => CONFORMING_MANIFEST,
      syncOne: () => ({
        result: { results: [{ status: 'unchanged' }], wrote: [], drift: false, missingManifestEntries: [], manifestCheckWarning: null },
        code: 0,
        err: '',
      }),
      out: (s) => sink.out.push(s),
      err: (s) => sink.err.push(s),
    });
    expect(r.items[0].warnings).toBeUndefined();
    expect(r.items[0].manifestCheckSkipped).toBeUndefined();
    expect(sink.out.join('')).not.toMatch(/マニフェスト検査スキップ/);
  });

  // 同期モードでも警告は消さない (全モード共通)。
  it('同期モードでも runSync の警告を集計へ引き上げる', () => {
    const sink = { out: [], err: [] };
    runAll({ root: '/r', depth: 4, mode: 'sync' }, {
      findManifests: () => ['/r/a/tools/cross-review.sync.json'],
      readManifest: () => CONFORMING_MANIFEST,
      syncOne: () => ({
        result: { results: [{ status: 'update' }], wrote: ['x'], drift: true, migrations: ['2026-09.md'] },
        code: 0,
        err: '[cross-review] 移行ノートを読めません: 2026-09.md (ENOENT)\n[cross-review] 未読の移行ノート (1 件)\n本文\n',
      }),
      out: (s) => sink.out.push(s),
      err: (s) => sink.err.push(s),
    });
    const out = sink.out.join('');
    expect(out).toMatch(/ {4}\[cross-review\] 移行ノートを読めません/);
    expect(out).not.toMatch(/本文/);
  });

  it('syncOne は --check のときだけ runSync に checkManifest を渡す', () => {
    const seen = [];
    const stub = (o) => { seen.push(o); return { results: [], wrote: [], drift: false, migrations: [] }; };
    const mp = '/r/a/tools/cross-review.sync.json';
    syncOne(mp, { mode: 'check', dryRun: false, ref: null }, { runSync: stub });
    syncOne(mp, { mode: 'sync', dryRun: false, ref: null }, { runSync: stub });
    expect(seen[0].checkManifest).toBe(true);
    expect(seen[1].checkManifest).toBe(false);
  });
});

const { inspectRegistration, probeEngine } = require('../tools/cross-review.sync-all.js');
const registrationSha = 'a'.repeat(40);

function registrationHarness({ record = JSON.stringify({ checkout: path.resolve('/registered') }), missing = [], branch = 'main', dirty = '', fail = [], probe = { range: { min: 1, max: 1 }, check: true } } = {}) {
  const checkout = path.resolve('/registered');
  const registry = path.resolve('/home/.cross-review/engine.json');
  const out = [];
  const err = [];
  const writes = [];
  return {
    out, err, writes, checkout, registry,
    deps: {
      home: path.resolve('/home'),
      out: (s) => out.push(s), err: (s) => err.push(s),
      exists: (p) => !missing.includes(p),
      readFile: () => record,
      mkdir: () => {}, writeFile: (p, body) => writes.push({ p, body }),
      execFileSync: () => { if (probe instanceof Error) throw probe; return typeof probe === 'string' ? probe : JSON.stringify(probe); },
      gitRun: (args) => {
        if (fail.includes(args.join(' '))) throw new Error('git failed');
        if (args[0] === 'symbolic-ref') return 'origin/main';
        if (args[1] === '--abbrev-ref') return branch;
        if (args[0] === 'status') return dirty;
        return registrationSha;
      },
    },
  };
}

describe('本体の登録と照会', () => {
  beforeEach(() => { process.exitCode = 0; });

  it('登録がなくても clean とし、checkout を null にする', () => {
    const h = registrationHarness({ missing: [path.resolve('/home/.cross-review/engine.json')] });
    main(['--register', '--check', '--json'], h.deps);
    expect(JSON.parse(h.out.join(''))).toEqual({ schemaVersion: 1, subject: 'register', result: 'clean', registry: { path: h.registry, exists: false, error: null }, checkout: null, issues: [] });
    expect(process.exitCode).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it('正常な登録の JSON は照会の契約と一致する', () => {
    const h = registrationHarness();
    main(['--register', '--check', '--json'], h.deps);
    expect(JSON.parse(h.out.join(''))).toEqual({ schemaVersion: 1, subject: 'register', result: 'clean', registry: { path: h.registry, exists: true, error: null }, checkout: {
      path: h.checkout, exists: true,
      engine: { path: path.join(h.checkout, 'tools/cross-review.js'), state: 'ok', entryProtocol: { min: 1, max: 1 } },
      head: { branch: 'main', sha: registrationSha, defaultBranch: 'main', onDefaultBranch: true }, dirty: false,
    }, issues: [] });
    expect(process.exitCode).toBe(0);
  });

  it.each([
    [{ branch: 'feature' }, 'not-on-default-branch'],
    [{ branch: 'HEAD' }, 'not-on-default-branch'],
    [{ dirty: ' M tracked' }, 'dirty'],
    [{ dirty: '?? untracked' }, 'dirty'],
  ])('開発中の checkout を drift とし、人向け出力でも同じ終了コードにする', (scenario, code) => {
    for (const json of [true, false]) {
      const h = registrationHarness(scenario);
      main(['--register', '--check', ...(json ? ['--json'] : [])], h.deps);
      expect(process.exitCode).toBe(1);
      if (json) {
        const report = JSON.parse(h.out.join(''));
        expect(report.result).toBe('drift');
        expect(report.issues.map((i) => i.code)).toContain(code);
        if (scenario.branch === 'HEAD') expect(report.checkout.head).toMatchObject({ branch: null, onDefaultBranch: false });
      } else expect(h.out.join('')).toContain('drift');
    }
  });

  it.each([
    [{ missing: [path.resolve('/registered')] }, 'checkout-missing'],
    [{ missing: [path.resolve('/registered/tools/cross-review.js')] }, 'engine-missing'],
    [{ probe: { range: null, check: false } }, 'protocol-export-missing'],
    [{ probe: { range: { min: 1, max: 1 }, check: false } }, 'protocol-export-missing'],
    [{ probe: new Error('timeout') }, 'engine-unloadable'],
    [{ probe: 'not json' }, 'engine-unloadable'],
    [{ probe: '{}' }, 'engine-unloadable'],
    [{ record: '{broken' }, 'registry-unreadable'],
    [{ record: '{"checkout":42}' }, 'registry-unreadable'],
    [{ fail: ['rev-parse HEAD'] }, 'git-failed'],
    [{ fail: ['rev-parse --abbrev-ref HEAD'] }, 'git-failed'],
    [{ fail: ['status --porcelain'] }, 'git-failed'],
  ])('使えない登録を error とする: %s', (scenario, code) => {
    for (const json of [true, false]) {
      const h = registrationHarness(scenario);
      main(['--register', '--check', ...(json ? ['--json'] : [])], h.deps);
      expect(process.exitCode).toBe(3);
      if (json) {
        const report = JSON.parse(h.out.join(''));
        expect(report.result).toBe('error');
        expect(report.issues.map((i) => i.code)).toContain(code);
      } else expect(h.out.join('')).toContain('error');
    }
  });

  it('git の各失敗を null として記録し、すべての issue を並べる', () => {
    const report = inspectRegistration(registrationHarness({ fail: ['rev-parse HEAD', 'rev-parse --abbrev-ref HEAD', 'status --porcelain'] }).deps);
    expect(report.checkout).toMatchObject({ head: { sha: null, branch: null, onDefaultBranch: null }, dirty: null });
    expect(report.issues.map((i) => i.code)).toEqual(['git-failed', 'git-failed', 'git-failed']);
  });

  it('既定ブランチの取得に失敗しても main を使い、error にしない', () => {
    const report = inspectRegistration(registrationHarness({ fail: ['symbolic-ref --short refs/remotes/origin/HEAD'] }).deps);
    expect(report.result).toBe('clean');
    expect(report.checkout.head.defaultBranch).toBe('main');
  });

  it('登録ファイルを読めなければ registry.error に理由を返す', () => {
    const h = registrationHarness();
    h.deps.readFile = () => { throw new Error('denied'); };
    expect(inspectRegistration(h.deps)).toMatchObject({ result: 'error', checkout: null, registry: { exists: true, error: expect.stringContaining('denied') } });
  });

  it('checkout が無いとき engine は null にする', () => {
    const h = registrationHarness({ missing: [path.resolve('/registered')] });
    expect(inspectRegistration(h.deps).checkout).toMatchObject({ exists: false, engine: null });
  });

  it('チェックと書き込み先は呼び出した checkout と独立している', () => {
    const h = registrationHarness();
    h.deps.scriptDir = path.resolve('/different/tools');
    const report = inspectRegistration(h.deps);
    expect(report.checkout.path).toBe(h.checkout);
    main(['--register'], h.deps);
    expect(JSON.parse(h.writes[0].body)).toEqual({ checkout: path.resolve('/different') });
    expect(h.writes[0].p).toBe(h.registry);
    expect(process.exitCode).toBe(0);
  });

  it('linked worktree を登録したうえで警告する', () => {
    const h = registrationHarness();
    h.deps.gitRun = (args) => args[1] === '--git-dir' ? '/checkout/.git/worktrees/test' : '/checkout/.git';
    main(['--register'], h.deps);
    expect(h.writes).toHaveLength(1);
    expect(h.err.join('')).toContain('worktree を登録した');
  });

  it('通常の checkout は警告せず登録する', () => {
    const h = registrationHarness();
    h.deps.gitRun = () => '.git';
    main(['--register'], h.deps);
    expect(h.writes).toHaveLength(1);
    expect(h.err).toEqual([]);
  });

  it.each([
    ['--root', '/r'], ['/r'], ['--global-skill'], ['--list'], ['--dry-run'], ['--json'],
    ['--global-skill', '--check', '--json'],
  ])('register の併用不可の引数を終了コード 2 にする: %s', (...args) => {
    const h = registrationHarness();
    main(['--register', ...args], h.deps);
    expect(process.exitCode).toBe(2);
    expect(h.writes).toEqual([]);
    expect(h.out).toEqual([]);
  });

  it('本体の export はタイムアウト付きの子プロセスで確認する', () => {
    const calls = [];
    const enginePath = path.resolve('/registered/tools/cross-review.js');
    expect(probeEngine(enginePath, { execFileSync: (...args) => { calls.push(args); return '{"range":{"min":1,"max":1},"check":true}'; } })).toEqual({ range: { min: 1, max: 1 }, check: true });
    expect(calls[0][0]).toBe(process.execPath);
    expect(calls[0][1]).toEqual(['-e', expect.stringContaining('require(process.argv[1])'), enginePath]);
    expect(calls[0][2].timeout).toBeGreaterThan(0);
  });
});


describe('旧形式の一括検査の案内', () => {
  it('旧形式の移行案内を集計へ残す', () => {
    const output = [];
    const notice = '[cross-review] このマニフェストは旧形式。新形式の配布物は files[] に足さない (足すと to が重なり同期が止まる)。旧形式のまま同期を続けられ、新形式への移行の手順は上流の移行ノートで案内する';
    const result = runAll(parseArgs(['--root', '/projects', '--check']), {
      findManifests: () => ['/projects/a/tools/cross-review.sync.json'],
      readManifest: () => CONFORMING_MANIFEST,
      syncOne: () => ({ code: 0, result: { drift: false, results: [], legacyForm: true }, err: notice + '\n' }),
      out: (value) => output.push(value), err: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.items[0].warnings).toEqual([notice]);
    expect(output.join('')).toContain(notice);
    process.exitCode = 0;
  });
});

describe('sync-all --migrate', () => {
  let temp;
  let upstream;
  let roots;
  let output;
  let errors;
  let prepared;
  let cleaned;
  let range;
  let hasCheck;
  const put = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const read = (file) => fs.readFileSync(file, 'utf8');
  const legacy = () => ({
    upstream: { repo: 'fixture', ref: 'main' }, lastSyncedCommit: 'before', shownMigrations: [], custom: { keep: true },
    files: [
      { from: 'tools/cross-review.js', to: 'tools/cross-review.js' },
      { from: '.claude/skills/cross-review/SKILL.md', to: '.claude/skills/cross-review/SKILL.md' },
      { from: 'docs/cross-review.md', to: 'site/review.md', replace: [{ from: 'original', to: 'adapted' }] },
      { from: '.cross-review.example.md', to: '.cross-review.example.md' },
      ...['tools/cross-review.sync.js', 'tools/cross-review.sync-all.js', 'tests/cross-review.test.js',
        'tests/cross-review.sync.test.js', 'tests/cross-review.sync-all.test.js'].map((from) => ({ from, to: from })),
    ],
  });
  const project = (name, manifest = legacy(), indent = 2, eol = '\n', newline = true) => {
    const root = path.join(roots, name);
    for (const entry of manifest.files || []) if (entry?.to && !entry.to.includes('..')) put(path.join(root, entry.to), `old ${entry.from}`);
    const manifestPath = path.join(root, 'tools/cross-review.sync.json');
    put(manifestPath, JSON.stringify(manifest, null, indent).replace(/\n/g, eol) + (newline ? eol : ''));
    return { root, manifestPath };
  };
  const snapshot = (root) => {
    const files = {};
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) walk(file);
        else files[path.relative(root, file)] = read(file);
      }
    };
    walk(root);
    return files;
  };
  const run = (args = [], extra = {}) => {
    output = '';
    errors = '';
    main(['--migrate', '--root', roots, ...args], {
      out: (s) => { output += s; }, err: (s) => { errors += s; },
      prepareUpstream: () => { prepared++; return { dir: upstream, commit: 'after', cleanup: () => { cleaned++; } }; },
      execFileSync: () => JSON.stringify({ range, check: hasCheck }), ...extra,
    });
    return process.exitCode;
  };
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-review-migrate-'));
    upstream = path.join(temp, 'upstream');
    roots = path.join(temp, 'projects');
    fs.mkdirSync(roots);
    const example = JSON.parse(read(path.resolve('tools/cross-review.sync.example.json')));
    put(path.join(upstream, 'tools/cross-review.sync.example.json'), JSON.stringify(example));
    put(path.join(upstream, 'tools/cross-review.entry.js'), 'const ENTRY_PROTOCOL = 1;\n');
    put(path.join(upstream, 'tools/cross-review.js'), 'exports.ENTRY_PROTOCOL_RANGE = { min: 1, max: 1 }; exports.checkEntryProtocol = () => ({ ok: true });\n');
    put(path.join(upstream, 'templates/cloud-skill/SKILL.md'), 'cloud skill\n');
    put(path.join(upstream, 'templates/docs/cross-review.md'), 'original guide\n');
    put(path.join(upstream, '.cross-review.example.md'), 'checklist\n');
    prepared = 0;
    cleaned = 0;
    range = { min: 1, max: 1 };
    hasCheck = true;
  });
  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it('旧形式を移行し、別配置と置換と独自キーを保ち、不要な写しと scripts を整理する', () => {
    const p = project('legacy');
    put(path.join(p.root, 'package.json'), JSON.stringify({ scripts: { sync: 'node tools/cross-review.sync.js --check' } }));
    expect(run()).toBe(0);
    const manifest = JSON.parse(read(p.manifestPath));
    expect(syncModule.isNewFormManifest(manifest)).toBe(true);
    expect(manifest.custom).toEqual({ keep: true });
    expect(manifest.upstream).toEqual({ repo: 'fixture', ref: 'main' });
    expect(manifest.files.find((f) => f.from === 'templates/docs/cross-review.md')).toEqual({
      from: 'templates/docs/cross-review.md', to: 'site/review.md', replace: [{ from: 'original', to: 'adapted' }],
    });
    expect(manifest.files).toContainEqual({ from: '.cross-review.example.md', to: '.cross-review.example.md' });
    expect(read(path.join(p.root, 'site/review.md'))).toBe('adapted guide\n');
    expect(read(path.join(p.root, 'tools/cross-review.js'))).toContain('ENTRY_PROTOCOL');
    expect(read(path.join(p.root, '.claude/skills/cross-review/SKILL.md'))).toBe('cloud skill\n');
    for (const from of ['tools/cross-review.sync.js', 'tools/cross-review.sync-all.js', 'tests/cross-review.test.js',
      'tests/cross-review.sync.test.js', 'tests/cross-review.sync-all.test.js']) expect(fs.existsSync(path.join(p.root, from))).toBe(false);
    expect(JSON.parse(read(path.join(p.root, 'package.json'))).scripts.sync).toBe('node tools/cross-review.js sync --check');
    expect(output).toContain('削除: tests/cross-review.test.js');
    expect(prepared).toBe(1);
    expect(cleaned).toBe(1);
    const before = snapshot(p.root);
    expect(run()).toBe(0);
    expect(snapshot(p.root)).toEqual(before);
    expect(prepared).toBe(1);
  });

  it('除外を変換して SKILL と手順書を足さず、古いテストの除外を消す', () => {
    const m = legacy();
    m.files = m.files.filter((f) => !['.claude/skills/cross-review/SKILL.md', 'docs/cross-review.md'].includes(f.from));
    m.excludedFiles = ['.claude/skills/cross-review/SKILL.md', 'docs/cross-review.md', 'tests/cross-review.test.js', 'other'];
    const p = project('excluded', m);
    expect(run()).toBe(0);
    const next = JSON.parse(read(p.manifestPath));
    expect(next.excludedFiles).toEqual(['templates/cloud-skill/SKILL.md', 'templates/docs/cross-review.md', 'other']);
    expect(next.files.some((f) => f.from.startsWith('templates/'))).toBe(false);
  });

  it('独自配置の SKILL と置換を残し、クラウド向け SKILL を雛形の配置へ足す', () => {
    const m = legacy();
    const skill = m.files.find((entry) => entry.from === '.claude/skills/cross-review/SKILL.md');
    skill.to = '.agents/skills/cross-review/SKILL.md';
    skill.replace = [{ from: 'local', to: 'custom' }];
    put(path.join(upstream, skill.from), 'local skill\n');
    const p = project('custom-skill', m);
    expect(run()).toBe(0);
    const next = JSON.parse(read(p.manifestPath));
    expect(next.files).toContainEqual(skill);
    expect(next.files).toContainEqual({ from: 'templates/cloud-skill/SKILL.md', to: '.claude/skills/cross-review/SKILL.md' });
    expect(read(path.join(p.root, skill.to))).toBe('custom skill\n');
    expect(read(path.join(p.root, '.claude/skills/cross-review/SKILL.md'))).toBe('cloud skill\n');
    expect(syncModule.isNewFormManifest(next)).toBe(true);
    const before = snapshot(p.root);
    expect(run()).toBe(0);
    expect(snapshot(p.root)).toEqual(before);
  });

  it.each([{ args: [] }, { args: ['--dry-run'] }, { args: ['--check', '--json'] }])('独自配置の本体は custom-body-location として変更しない (%j)', ({ args }) => {
    const m = legacy();
    m.files[0].to = 'lib/cross-review.js';
    const p = project('custom-body', m);
    put(path.join(p.root, 'package.json'), JSON.stringify({ scripts: { sync: 'node tools/cross-review.sync.js' } }));
    const before = snapshot(p.root);
    expect(run(args)).toBe(1);
    expect(snapshot(p.root)).toEqual(before);
    expect(output).toContain('custom-body-location');
    if (args.includes('--json')) expect(JSON.parse(output)).toMatchObject({ result: 'drift', projects: [
      { form: 'legacy', migratable: false, reason: 'custom-body-location' },
    ] });
  });

  it.each([{ args: [] }, { args: ['--dry-run'] }, { args: ['--check', '--json'] }])('ルート直下のマニフェストは custom-manifest-location として変更しない (%j)', ({ args }) => {
    const root = path.join(roots, 'root-manifest');
    for (const entry of legacy().files) put(path.join(root, entry.to), `old ${entry.from}`);
    put(path.join(root, 'cross-review.sync.json'), JSON.stringify(legacy(), null, 2) + '\n');
    const before = snapshot(root);
    expect(run(args)).toBe(1);
    expect(snapshot(root)).toEqual(before);
    expect(output).toContain('custom-manifest-location');
    if (args.includes('--json')) expect(JSON.parse(output)).toMatchObject({ result: 'drift', projects: [
      { form: 'legacy', migratable: false, reason: 'custom-manifest-location' },
    ] });
  });

  it('--root か --manifest を付けた同期の scripts は書き換えず、手で直す項目に出す', () => {
    const p = project('script-options');
    const scripts = { sync: 'node tools/cross-review.sync.js --root . --check', other: 'node tools/cross-review.sync.js --manifest=tools/cross-review.sync.json', plain: 'node tools/cross-review.sync.js --check' };
    put(path.join(p.root, 'package.json'), JSON.stringify({ scripts }, null, 2) + '\n');
    expect(run()).toBe(0);
    const next = JSON.parse(read(path.join(p.root, 'package.json'))).scripts;
    expect(next).toEqual({ ...scripts, plain: 'node tools/cross-review.js sync --check' });
    expect(output).toContain(`手で修正: package.json scripts.sync: ${scripts.sync}`);
    expect(output).toContain(`手で修正: package.json scripts.other: ${scripts.other}`);
  });

  it('独自の場所の同期スクリプトを消し、それを呼ぶ scripts を手で直す項目に出す', () => {
    const m = legacy();
    m.files.find((entry) => entry.from === 'tools/cross-review.sync.js').to = 'tools/review-sync.js';
    const p = project('custom-sync', m);
    put(path.join(p.root, 'package.json'), JSON.stringify({ scripts: { sync: 'node tools/review-sync.js --check' } }, null, 2) + '\n');
    expect(run()).toBe(0);
    expect(fs.existsSync(path.join(p.root, 'tools/review-sync.js'))).toBe(false);
    expect(JSON.parse(read(path.join(p.root, 'package.json'))).scripts.sync).toBe('node tools/review-sync.js --check');
    expect(output).toContain('手で修正: package.json scripts.sync: node tools/review-sync.js --check');
  });

  it.each([
    ['./tools/review-sync.js', 'node tools\\review-sync.js --check'],
    ['tools/review-sync.js', 'node ./tools/review-sync.js --check'],
  ])('同期スクリプトの to が %s で scripts の書き方が違っても手で直す項目に出す', (to, command) => {
    const m = legacy();
    m.files.find((entry) => entry.from === 'tools/cross-review.sync.js').to = to;
    const p = project('custom-sync-notation', m);
    put(path.join(p.root, 'package.json'), JSON.stringify({ scripts: { sync: command } }, null, 2) + '\n');
    expect(run()).toBe(0);
    expect(JSON.parse(read(path.join(p.root, 'package.json'))).scripts.sync).toBe(command);
    expect(output).toContain(`手で修正: package.json scripts.sync: ${command}`);
  });

  it('同期が失敗すると、マニフェストと package.json と古い写しを変えず、旧形式として見つけられる', () => {
    const p = project('sync-fails');
    put(path.join(p.root, 'package.json'), JSON.stringify({ scripts: { sync: 'node tools/cross-review.sync.js' } }, null, 2) + '\n');
    const manifestBefore = read(p.manifestPath);
    const packageBefore = read(path.join(p.root, 'package.json'));
    expect(run([], { runSync: () => { process.exitCode = 1; return null; } })).toBe(3);
    expect(read(p.manifestPath)).toBe(manifestBefore);
    expect(read(path.join(p.root, 'package.json'))).toBe(packageBefore);
    expect(fs.existsSync(path.join(p.root, 'tools/cross-review.sync.js'))).toBe(true);
    expect(run(['--check', '--json'])).toBe(1);
    expect(JSON.parse(output).projects[0]).toMatchObject({ form: 'legacy', migratable: true });
  });

  it('不足する新形式の配布物だけ雛形の配置で足し、未知の配布物を残す', () => {
    const m = legacy();
    m.files = [m.files[0], { from: 'custom.txt', to: 'own.txt' }];
    put(path.join(upstream, 'custom.txt'), 'custom');
    const p = project('missing', m);
    expect(run()).toBe(0);
    expect(read(path.join(p.root, 'docs/cross-review.md'))).toBe('original guide\n');
    expect(read(path.join(p.root, 'own.txt'))).toBe('custom');
  });

  it.each([{ args: [] }, { args: ['--dry-run'] }])('入口の無い固定 ref は何も変えない (%j)', ({ args }) => {
    fs.rmSync(path.join(upstream, 'tools/cross-review.entry.js'));
    const p = project('old');
    const before = snapshot(p.root);
    expect(run(args)).toBe(1);
    expect(snapshot(p.root)).toEqual(before);
    expect(output).toContain('ref-unsupported');
    expect(output).toContain('upstream.ref');
  });

  it.each(['range', 'missing-export', 'unreadable-protocol'])('対応外の入口または本体は移行しない (%s)', (kind) => {
    if (kind === 'range') range = { min: 2, max: 2 };
    if (kind === 'missing-export') hasCheck = false;
    if (kind === 'unreadable-protocol') put(path.join(upstream, 'tools/cross-review.entry.js'), 'const ENTRY_PROTOCOL = unknown;');
    project('unsupported');
    expect(run(['--check', '--json'])).toBe(1);
    expect(JSON.parse(output).projects[0].reason).toBe('ref-unsupported');
  });

  it('dry-run は同期対象と削除と scripts を表示し、全ファイルを変更しない', () => {
    const p = project('dry');
    put(path.join(p.root, 'package.json'), JSON.stringify({ scripts: { sync: 'node tools/cross-review.sync.js' } }));
    const before = snapshot(p.root);
    expect(run(['--dry-run'])).toBe(0);
    expect(snapshot(p.root)).toEqual(before);
    expect(output).toContain('削除予定');
    expect(output).toContain('scripts.sync');
    expect(output).toContain('tools/cross-review.js');
  });

  it('最新の本体の写しでも旧形式を drift として照会し、同じ上流は一度だけ取得する', () => {
    const p = project('z');
    put(path.join(p.root, 'tools/cross-review.js'), read(path.join(upstream, 'tools/cross-review.js')));
    project('a');
    const before = snapshot(roots);
    expect(run(['--check', '--json'])).toBe(1);
    const report = JSON.parse(output);
    expect(Object.keys(report)).toEqual(['schemaVersion', 'subject', 'result', 'root', 'projects']);
    expect(report).toMatchObject({ schemaVersion: 1, subject: 'migrate', result: 'drift', root: roots });
    expect(Object.keys(report.projects[0])).toEqual(['root', 'manifest', 'upstream', 'form', 'migratable', 'reason', 'message']);
    expect(report.projects.map((p) => path.basename(p.root))).toEqual(['a', 'z']);
    expect(report.projects[0]).toMatchObject({ form: 'legacy', migratable: true, reason: null, message: null });
    expect(report.projects.map((p) => p.upstream)).toEqual([{ repo: 'fixture', ref: 'main' }, { repo: 'fixture', ref: 'main' }]);
    expect(prepared).toBe(1);
    expect(cleaned).toBe(1);
    expect(snapshot(roots)).toEqual(before);
  });

  it('新形式と対象外だけなら clean で、取得も書き込みもしない', () => {
    project('new', JSON.parse(read(path.join(upstream, 'tools/cross-review.sync.example.json'))));
    project('skip', { source: 'other' });
    const before = snapshot(roots);
    expect(run(['--check', '--json'])).toBe(0);
    expect(JSON.parse(output).result).toBe('clean');
    expect(JSON.parse(output).projects.map((p) => p.form)).toEqual(['new', 'not-applicable']);
    expect(run()).toBe(0);
    expect(prepared).toBe(0);
    expect(snapshot(roots)).toEqual(before);
  });

  it('導入先が無ければ clean の空配列を返す', () => {
    expect(run(['--check', '--json'])).toBe(0);
    expect(JSON.parse(output).projects).toEqual([]);
    expect(prepared).toBe(0);
  });

  it('壊れたマニフェストがあれば error を優先する', () => {
    const p = project('broken');
    put(p.manifestPath, '{');
    project('legacy');
    expect(run(['--check', '--json'])).toBe(3);
    expect(JSON.parse(output)).toMatchObject({ result: 'error', projects: [
      { upstream: null, form: 'error', migratable: null, reason: 'manifest-unreadable' }, { form: 'legacy' },
    ] });
  });

  it.each([true, false])('不正なマニフェストは files の配列の有無で形式を分ける (%s)', (hasFiles) => {
    project('invalid', { upstream: {}, ...(hasFiles ? { files: [] } : {}) });
    expect(run(['--check', '--json'])).toBe(hasFiles ? 1 : 3);
    expect(JSON.parse(output).projects[0]).toMatchObject({ form: hasFiles ? 'legacy' : 'error',
      migratable: hasFiles ? false : null, reason: 'manifest-invalid' });
  });

  it.each([{ args: [] }, { args: ['--dry-run'] }, { args: ['--check', '--json'] }])('上流取得失敗は error として集計し、変更も同じ失敗の再取得もしない (%j)', ({ args }) => {
    project('a'); project('b');
    const before = snapshot(roots);
    let calls = 0;
    expect(run(args, { prepareUpstream: () => { calls++; throw new Error('offline'); } })).toBe(3);
    if (args.includes('--json')) expect(JSON.parse(output)).toMatchObject({ result: 'error', projects: [
      { upstream: { repo: 'fixture', ref: 'main' }, form: 'legacy', migratable: null, reason: 'upstream-unavailable' },
      { form: 'legacy', migratable: null, reason: 'upstream-unavailable' },
    ] });
    else expect(output).toContain('upstream-unavailable');
    expect(snapshot(roots)).toEqual(before);
    expect(calls).toBe(1);
  });

  it.each([
    { upstream: undefined, expected: null },
    { upstream: 'invalid', expected: null },
    { upstream: [], expected: null },
    { upstream: {}, expected: { repo: null, ref: null } },
    { upstream: { repo: 1, ref: 'pinned' }, expected: { repo: null, ref: 'pinned' } },
    { upstream: { repo: 'fixture', ref: false }, expected: { repo: 'fixture', ref: null } },
  ])('不正な upstream の文字列以外の値は null として照会する (%j)', ({ upstream: value, expected }) => {
    project('invalid', { upstream: value });
    expect(run(['--check', '--json'])).toBe(value === undefined ? 0 : 3);
    expect(JSON.parse(output).projects[0].upstream).toEqual(expected);
  });

  it('追加した入口の配置が衝突すれば duplicate-destination で拒否する', () => {
    const p = project('duplicate', { upstream: { repo: 'fixture', ref: 'main' }, files: [{ from: 'custom', to: 'tools/cross-review.js' }] });
    const before = snapshot(p.root);
    expect(run()).toBe(1);
    expect(output).toContain('duplicate-destination');
    expect(snapshot(p.root)).toEqual(before);
  });

  it('本体を除外している導入先には入口を足さない', () => {
    const m = legacy();
    m.files = m.files.filter((f) => f.from !== 'tools/cross-review.js');
    m.excludedFiles = ['tools/cross-review.js'];
    const p = project('excluded', m);
    const before = snapshot(p.root);
    expect(run()).toBe(1);
    expect(output).toContain('body-excluded');
    expect(snapshot(p.root)).toEqual(before);
  });

  it.each([[4, '\r\n', false], ['\t', '\n', true], [2, '\r\n', true]])('JSON の書式を同期後も保ち、手動修正する scripts はそのまま報告する (%j)', (indent, eol, newline) => {
    const p = project('format', legacy(), indent, eol, newline);
    const pkg = { scripts: { sync: 'node tools/cross-review.sync.js --check && echo ok',
      all: 'node tools/cross-review.sync-all.js', test: 'vitest tests/cross-review.test.js',
      mixed: 'node tools/cross-review.sync.js && vitest tests/cross-review.test.js' } };
    put(path.join(p.root, 'package.json'), JSON.stringify(pkg, null, indent).replace(/\n/g, eol) + (newline ? eol : ''));
    expect(run()).toBe(0);
    for (const file of [p.manifestPath, path.join(p.root, 'package.json')]) {
      const raw = read(file);
      expect(raw.endsWith(eol)).toBe(newline);
      expect(raw).toContain(`${eol}${typeof indent === 'number' ? ' '.repeat(indent) : indent}"`);
      if (eol === '\r\n') expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
    }
    expect(JSON.parse(read(path.join(p.root, 'package.json'))).scripts).toEqual({ ...pkg.scripts,
      sync: 'node tools/cross-review.js sync --check && echo ok' });
    expect(output).toContain('手で修正: package.json scripts.all');
    expect(output).toContain('手で修正: package.json scripts.test');
    expect(output).toContain('手で修正: package.json scripts.mixed');
  });

  it('削除対象がルート外なら書き換える前に拒否し、次の導入先は移行する', () => {
    const m = legacy(); m.files.push({ from: 'tests/cross-review.test.js', to: '../outside.txt' });
    const p = project('a', m); project('b');
    const before = read(p.manifestPath);
    expect(run()).toBe(3);
    expect(read(p.manifestPath)).toBe(before);
    expect(errors).toContain('ルートの外');
    expect(output).toContain('[移行した]');
  });

  it('package.json の読み込み失敗は書き換える前に検出し、次の導入先へ進む', () => {
    const p = project('a'); project('b');
    put(path.join(p.root, 'package.json'), '{');
    const before = snapshot(p.root);
    expect(run()).toBe(3);
    expect(snapshot(p.root)).toEqual(before);
    expect(output).toContain('[移行した]');
  });

  it('同期の失敗を error として集計する', () => {
    project('sync-error');
    expect(run([], { runSync: () => { process.exitCode = 1; return null; } })).toBe(3);
    expect(errors).toContain('同期に失敗');
  });

  it.each([
    ['--migrate'], ['--migrate', '--root', '.', '--json'],
    ['--migrate', '--root', '.', '--dry-run', '--check'],
    ...['--global-skill', '--register', '--list', '--ref=main'].map((flag) => ['--migrate', '--root', '.', flag]),
  ].map((args) => ({ args })))('不正な組み合わせは引数エラーで JSON を出さない (%j)', ({ args }) => {
    let stdout = ''; let stderr = '';
    main(args, { out: (s) => { stdout += s; }, err: (s) => { stderr += s; } });
    expect(process.exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--migrate');
  });

  it('位置引数と depth を移行の照会に使える', () => {
    expect(parseArgs(['--migrate', roots, '--check', '--json', '--depth=2'])).toMatchObject({ migrate: true, root: roots, depth: 2, error: null });
  });
});
