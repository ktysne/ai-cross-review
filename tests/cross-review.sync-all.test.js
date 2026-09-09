// tools/cross-review.sync-all.js の引数解析・プロジェクト走査・結果分類・集計・一括同期の配線を検証する。
// 実ディレクトリ走査・実 runSync は外部依存なので、findManifests は listDir を注入し、runAll は
// findManifests / syncOne を注入して、書き込みや実 I/O 無しで分類と exit コードまで固定する。

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

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
  planGlobalSkill,
  syncOne,
  runAll,
  DEFAULT_DEPTH,
  GLOBAL_SKILL_TARGETS,
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

// 仮想 FS (絶対パス -> 内容) でグローバル SKILL の配布を検証する。ディレクトリは空文字を値に持つ
// エントリで表す。キーは path.resolve で正規化する (Windows で '/home/u' が 'D:\home\u' になるため)。
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
      if (!store.has(key)) throw new Error(`ENOENT: ${key}`);
      return store.get(key);
    },
    exists: (p) => store.has(path.resolve(p)),
    writeFile: (p, c) => { const key = path.resolve(p); store.set(key, c); writes.push({ path: key, content: c }); },
    mkdir: (d) => { mkdirs.push(path.resolve(d)); store.set(path.resolve(d), ''); },
  };
}

describe('planGlobalSkill', () => {
  const HOME = '/home/u';
  // planGlobalSkill が返す path は path.join(home, ...to) なので、期待値も同じ組み立て方で作る
  // (path.resolve するとドライブレターが付き、Windows で一致しなくなる)。
  const CLAUDE = path.join(HOME, '.claude', 'skills', 'cross-review', 'SKILL.md');
  const CODEX = path.join(HOME, '.codex', 'skills', 'cross-review', 'SKILL.md');

  it('未配置は create、内容が古ければ update、一致すれば unchanged', () => {
    const fsx = makeHomeFs({
      '/home/u/.codex/skills': '',
      '/home/u/.codex/skills/cross-review/SKILL.md': '古い SKILL',
    });
    const plans = planGlobalSkill({ home: HOME, targets: GLOBAL_SKILL_TARGETS, exists: fsx.exists, readFile: fsx.readFile, skillText: '新しい SKILL' });
    expect(plans).toEqual([
      { path: CLAUDE, status: 'create', reason: expect.any(String) },
      { path: CODEX, status: 'update', reason: expect.any(String) },
    ]);

    fsx.store.set(path.resolve(CLAUDE), '新しい SKILL');
    fsx.store.set(path.resolve(CODEX), '新しい SKILL');
    const same = planGlobalSkill({ home: HOME, targets: GLOBAL_SKILL_TARGETS, exists: fsx.exists, readFile: fsx.readFile, skillText: '新しい SKILL' });
    expect(same.map((p) => p.status)).toEqual(['unchanged', 'unchanged']);
  });

  it('.codex/skills が無ければ Codex 側は skip (Claude 側は配る)', () => {
    const fsx = makeHomeFs({});
    const plans = planGlobalSkill({ home: HOME, targets: GLOBAL_SKILL_TARGETS, exists: fsx.exists, readFile: fsx.readFile, skillText: 'S' });
    expect(plans.map((p) => p.status)).toEqual(['create', 'skip']);
    expect(plans[1].reason).toMatch(/配布しない/);
  });

  it('配置済みだが読めない配布先は update (古い写しを残さない)', () => {
    const fsx = makeHomeFs({ '/home/u/.claude/skills/cross-review/SKILL.md': 'x' });
    const plans = planGlobalSkill({
      home: HOME,
      targets: [GLOBAL_SKILL_TARGETS[0]],
      exists: fsx.exists,
      readFile: () => { throw new Error('EACCES'); },
      skillText: 'S',
    });
    expect(plans[0]).toMatchObject({ status: 'update' });
    expect(plans[0].reason).toMatch(/読めない/);
  });
});

describe('runAll の --global-skill', () => {
  // scriptDir=/repo/tools → 配布元は /repo/.claude/skills/cross-review/SKILL.md
  const SKILL = '# SKILL 本文\n';
  function globalDeps(homeFiles = {}, sink = { out: [], err: [] }) {
    const fsx = makeHomeFs({
      '/repo/.claude/skills/cross-review/SKILL.md': SKILL,
      ...homeFiles,
    });
    return {
      fsx,
      sink,
      deps: {
        scriptDir: '/repo/tools',
        home: '/home/u',
        exists: fsx.exists,
        readFile: fsx.readFile,
        writeFile: fsx.writeFile,
        mkdir: fsx.mkdir,
        findManifests: () => { throw new Error('走査してはいけない'); },
        out: (s) => sink.out.push(s),
        err: (s) => sink.err.push(s),
      },
    };
  }

  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it('--global-skill 単独 (--root 無し) は走査せずグローバル配布だけを行う', () => {
    const h = globalDeps({ '/home/u/.codex/skills': '' });
    const r = runAll({ root: null, depth: 4, mode: 'sync', dryRun: false, globalSkill: true }, h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'global', status: 'updated', changed: 2 });
    // 2 つの配布先へ SKILL 本文をそのまま書き、親ディレクトリを作る。
    expect(h.fsx.writes.map((w) => w.content)).toEqual([SKILL, SKILL]);
    expect(h.fsx.mkdirs).toHaveLength(2);
    // 走査していないので「走査ルート」の見出しは出さない。
    expect(h.sink.out.join('')).not.toMatch(/走査ルート/);
    expect(h.sink.out.join('')).toMatch(/\[更新\] \(2 件\) global:/);
  });

  it('.codex/skills が無ければ Codex 側へは配らない (ディレクトリを作らない)', () => {
    const h = globalDeps();
    const r = runAll({ root: null, depth: 4, mode: 'sync', dryRun: false, globalSkill: true }, h.deps);
    expect(r.items[0]).toMatchObject({ status: 'updated', changed: 1 });
    expect(h.fsx.writes).toHaveLength(1);
    expect(h.fsx.writes[0].path).toBe(path.resolve('/home/u/.claude/skills/cross-review/SKILL.md'));
    expect(h.sink.err.join('')).toMatch(/配布しません/);
  });

  it('--check は書き込まず、古ければ drift として exit 1', () => {
    const h = globalDeps({ '/home/u/.claude/skills/cross-review/SKILL.md': '古い' });
    const r = runAll({ root: null, depth: 4, mode: 'check', globalSkill: true }, h.deps);
    expect(r.exitCode).toBe(1);
    expect(r.items[0]).toMatchObject({ status: 'drift' });
    expect(h.fsx.writes).toEqual([]);
  });

  it('--check で最新と一致していれば clean・exit 0', () => {
    const h = globalDeps({ '/home/u/.claude/skills/cross-review/SKILL.md': SKILL });
    const r = runAll({ root: null, depth: 4, mode: 'check', globalSkill: true }, h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.items[0]).toMatchObject({ status: 'clean' });
    expect(h.fsx.writes).toEqual([]);
  });

  it('--dry-run は書き込まず would-update だけを出す', () => {
    const h = globalDeps();
    const r = runAll({ root: null, depth: 4, mode: 'sync', dryRun: true, globalSkill: true }, h.deps);
    expect(r.exitCode).toBe(0);
    expect(r.items[0]).toMatchObject({ status: 'would-update', changed: 1 });
    expect(h.fsx.writes).toEqual([]);
  });

  it('配布元の SKILL が無ければ error・exit 1', () => {
    const sink = { out: [], err: [] };
    const fsx = makeHomeFs({});
    const r = runAll({ root: null, depth: 4, mode: 'sync', dryRun: false, globalSkill: true }, {
      scriptDir: '/repo/tools',
      home: '/home/u',
      exists: fsx.exists,
      readFile: fsx.readFile,
      writeFile: fsx.writeFile,
      mkdir: fsx.mkdir,
      out: (s) => sink.out.push(s),
      err: (s) => sink.err.push(s),
    });
    expect(r.exitCode).toBe(1);
    expect(r.items[0]).toMatchObject({ kind: 'global', status: 'error' });
    expect(r.items[0].message).toMatch(/配布元の SKILL がありません/);
    expect(sink.out.join('')).toMatch(/\[エラー\]/);
  });

  it('--list との併用は配布先を列挙するだけ (書き込まない)', () => {
    const h = globalDeps();
    const r = runAll({ root: null, depth: 4, mode: 'sync', list: true, globalSkill: true }, h.deps);
    expect(r.exitCode).toBe(0);
    expect(h.sink.out.join('')).toMatch(/グローバル SKILL の配布先:/);
    expect(h.sink.out.join('')).toMatch(/\.claude/);
    expect(h.sink.out.join('')).toMatch(/対象外/); // .codex/skills が無い
    expect(h.fsx.writes).toEqual([]);
  });

  it('--root と併用するとプロジェクト走査に global の行が加わる', () => {
    const sink = { out: [], err: [] };
    const fsx = makeHomeFs({ '/repo/.claude/skills/cross-review/SKILL.md': SKILL });
    const manifests = ['/r/a/tools/cross-review.sync.json'];
    const r = runAll({ root: '/r', depth: 4, mode: 'sync', dryRun: false, globalSkill: true }, {
      scriptDir: '/repo/tools',
      home: '/home/u',
      exists: fsx.exists,
      readFile: fsx.readFile,
      writeFile: fsx.writeFile,
      mkdir: fsx.mkdir,
      findManifests: () => manifests,
      readManifest: () => CONFORMING_MANIFEST,
      syncOne: () => ({ result: { results: [{ status: 'update' }], wrote: ['x'], drift: false }, code: 0 }),
      out: (s) => sink.out.push(s),
      err: (s) => sink.err.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(r.items.map((i) => i.status)).toEqual(['updated', 'updated']);
    // 集計の件数は導入プロジェクトだけを数える (global の行は含めない)。
    expect(sink.out.join('')).toMatch(/検出した導入プロジェクト: 1 件/);
    expect(sink.out.join('')).toMatch(/global:/);
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
