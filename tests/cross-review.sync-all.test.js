// tools/cross-review.sync-all.js の引数解析・プロジェクト走査・結果分類・集計・一括同期の配線を検証する。
// 実ディレクトリ走査・実 runSync は外部依存なので、findManifests は listDir を注入し、runAll は
// findManifests / syncOne を注入して、書き込みや実 I/O 無しで分類と exit コードまで固定する。

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseArgs,
  projectRootForManifest,
  findManifests,
  classifyManifestRaw,
  isSyncManifestContent,
  classifyResult,
  errorMessageOf,
  formatSummary,
  runAll,
  DEFAULT_DEPTH,
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
  const tree = {
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
  };
  const listDir = (d) => {
    if (!(d in tree)) throw new Error('ENOENT');
    return tree[d];
  };

  it('tools/ とルート直下のマニフェストを検出し、node_modules / 隠しディレクトリは無視する', () => {
    const found = findManifests('/r', DEFAULT_DEPTH, { listDir });
    expect(found).toEqual([
      '/r/a/tools/cross-review.sync.json',
      '/r/b/cross-review.sync.json',
      '/r/b/sub/tools/cross-review.sync.json',
    ]);
  });

  it('depth 制限で深い階層を打ち切る', () => {
    // depth 2 で /r/a/tools (depth 2) は届くが /r/b/sub/tools (depth 3) には届かない。
    const found = findManifests('/r', 2, { listDir });
    expect(found).toContain('/r/a/tools/cross-review.sync.json');
    expect(found).toContain('/r/b/cross-review.sync.json');
    expect(found).not.toContain('/r/b/sub/tools/cross-review.sync.json');
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

  it('プロジェクトが無ければ exit 1', () => {
    const sink = { out: [], err: [] };
    const r = runAll({ root: '/empty', depth: 4, mode: 'sync' }, mkDeps([], {}, sink));
    expect(r.exitCode).toBe(1);
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

  it('1 件でもエラーがあれば exit 1 (他は続行)', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/a/tools/cross-review.sync.json', '/r/b/tools/cross-review.sync.json'];
    const syncResults = {
      '/r/a/tools/cross-review.sync.json': { result: null, code: 1, err: '上流の取得に失敗しました\n' },
      '/r/b/tools/cross-review.sync.json': { result: { results: [{ status: 'update' }], wrote: ['x'], drift: false }, code: 0 },
    };
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, mkDeps(manifests, syncResults, sink));
    expect(r.exitCode).toBe(1);
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

  it('破損マニフェスト (JSON 構文エラー) は skip せず error・exit 1', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/broken/tools/cross-review.sync.json'];
    const deps = mkDeps(manifests, {}, sink, () => '{ not json');
    deps.syncOne = () => { throw new Error('破損で syncOne が呼ばれた'); };
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.items[0].status).toBe('error');
  });

  it('読めないマニフェスト (raw=null) は skip せず error・exit 1', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/unreadable/tools/cross-review.sync.json'];
    const deps = mkDeps(manifests, {}, sink, () => null);
    deps.syncOne = () => { throw new Error('読めないのに syncOne が呼ばれた'); };
    const r = runAll({ root: '/r', depth: 4, mode: 'check' }, deps);
    expect(r.exitCode).toBe(1);
    expect(r.items[0].status).toBe('error');
  });

  it('準拠と破損が混在: 準拠は同期しつつ破損は error・全体 exit 1', () => {
    const sink = { out: [], err: [] };
    const manifests = ['/r/app/tools/cross-review.sync.json', '/r/broken/tools/cross-review.sync.json'];
    const syncResults = {
      '/r/app/tools/cross-review.sync.json': { result: { results: [{ status: 'update' }], wrote: ['x'], drift: false }, code: 0 },
    };
    const readManifest = (mp) => (mp.includes('broken') ? '{ not json' : CONFORMING_MANIFEST);
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false }, mkDeps(manifests, syncResults, sink, readManifest));
    expect(r.exitCode).toBe(1);
    expect(r.items.map((i) => i.status)).toEqual(['updated', 'error']);
  });
});
