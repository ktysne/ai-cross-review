import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const entry = require('../tools/cross-review.entry.js');
const engine = require('../tools/cross-review.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
let temp;
let oldExit;

function put(relative, body = '') {
  const target = path.join(temp, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  return target;
}
function deps(extra = {}) {
  return { env: {}, homedir: () => path.join(temp, 'home'), scriptDir: path.join(temp, 'project/tools'), err: vi.fn(), ...extra };
}
function manifest(ref = 'main') {
  put('project/tools/cross-review.sync.json', JSON.stringify({ upstream: { repo: 'https://example.test/upstream.git', ref } }));
}
function cacheEngine(commit = sha) {
  return put('cache/ai-cross-review/engines/' + commit + '/tools/cross-review.js', '');
}
function cacheDeps(extra = {}) {
  return deps({ env: { XDG_CACHE_HOME: path.join(temp, 'cache') }, ...extra });
}

beforeEach(() => {
  fs.mkdirSync(path.join(repoRoot, '.cross-review'), { recursive: true });
  temp = fs.mkdtempSync(path.join(repoRoot, '.cross-review/entry-test-'));
  oldExit = process.exitCode;
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = oldExit;
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('入口の本体探索', () => {
  it('環境変数を登録より優先して本体に引数と導入先を渡す', () => {
    put('home/.cross-review/engine.json', '{broken');
    const main = vi.fn();
    const load = vi.fn(() => ({ main, checkEntryProtocol: () => ({ ok: true }), ENTRY_PROTOCOL_RANGE: { min: 1, max: 1 } }));
    entry.main(deps({ env: { CROSS_REVIEW_ENGINE: temp }, argv: ['state'], require: load }));
    expect(load).toHaveBeenCalledWith(path.join(temp, 'tools/cross-review.js'));
    expect(main).toHaveBeenCalledWith({ argv: ['state'], projectRoot: path.join(temp, 'project'), entryProtocol: 1, engineSource: 'env' });
  });
  it('環境変数の本体が読めなくても登録やキャッシュに進まない', () => {
    const h = deps({ env: { CROSS_REVIEW_ENGINE: temp }, require: () => { throw new Error('missing'); }, gitRun: vi.fn() });
    entry.main(h);
    expect(process.exitCode).toBe(2);
    expect(h.gitRun).not.toHaveBeenCalled();
    expect(h.err.mock.calls.join('')).toContain('CROSS_REVIEW_ENGINE');
  });
  it.each(['{broken', '{"checkout":123}', '{"checkout":"relative"}'])('不正な登録からキャッシュに進まない: %s', (record) => {
    put('home/.cross-review/engine.json', record);
    const h = deps({ gitRun: vi.fn() });
    entry.main(h);
    expect(process.exitCode).toBe(2);
    expect(h.gitRun).not.toHaveBeenCalled();
    expect(h.err.mock.calls.join('')).toContain('--register');
  });
  it('登録先が使えなくてもキャッシュに進まない', () => {
    put('home/.cross-review/engine.json', JSON.stringify({ checkout: path.join(temp, 'gone') }));
    const h = deps({ gitRun: vi.fn() });
    entry.main(h);
    expect(process.exitCode).toBe(2);
    expect(h.gitRun).not.toHaveBeenCalled();
  });
  it.each([{}, { checkEntryProtocol() {} }, { ENTRY_PROTOCOL_RANGE: { min: 1, max: 1 } }])('照合用 export が欠ける本体を拒否する', (exports) => {
    const h = deps({ env: { CROSS_REVIEW_ENGINE: temp }, require: () => exports });
    entry.main(h);
    expect(process.exitCode).toBe(2);
    expect(h.err.mock.calls.join('')).toContain('対応外の古い本体');
  });
  it('登録した checkout を選ぶ', () => {
    put('home/.cross-review/engine.json', JSON.stringify({ checkout: temp }));
    expect(entry.resolveEngine(temp, deps())).toEqual({ engineSource: 'registry', enginePath: path.join(temp, 'tools/cross-review.js') });
  });
});

describe('キャッシュの取得と再利用', () => {
  it('登録がないときブランチを毎回照会して SHA の本体を使う', () => {
    manifest();
    cacheEngine();
    const gitRun = vi.fn(() => sha + '\trefs/heads/main\n');
    const h = cacheDeps({ gitRun });
    const selected = entry.resolveEngine(path.join(temp, 'project'), h);
    expect(selected).toMatchObject({ engineSource: 'cache', engineSha: sha });
    entry.resolveEngine(path.join(temp, 'project'), h);
    expect(gitRun).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(path.join(temp, 'cache/ai-cross-review/refs.json')))).toEqual({ 'https://example.test/upstream.git#main': sha });
  });
  it('heads をタグより優先し、タグだけなら peeled のコミットを選ぶ', () => {
    const tags = sha + '\trefs/tags/v1\n' + otherSha + '\trefs/tags/v1^{}\n';
    expect(entry.resolveRemoteSha(tags, 'v1')).toBe(otherSha);
    expect(entry.resolveRemoteSha(tags + sha + '\trefs/heads/v1\n', 'v1')).toBe(sha);
    expect(entry.resolveRemoteSha(sha + '\trefs/tags/v1\n', 'v1')).toBe(sha);
    expect(entry.resolveRemoteSha(sha + '\trefs/heads/other\n', 'v1')).toBeNull();
  });
  it('完全な名前の ref は、その名前とだけ照合する', () => {
    const tags = sha + '\trefs/tags/v1\n' + otherSha + '\trefs/tags/v1^{}\n';
    expect(entry.resolveRemoteSha(sha + '\trefs/heads/main\n', 'refs/heads/main')).toBe(sha);
    expect(entry.resolveRemoteSha(tags, 'refs/tags/v1')).toBe(otherSha);
    expect(entry.resolveRemoteSha(sha + '\trefs/tags/v1\n', 'refs/tags/v1')).toBe(sha);
    expect(entry.resolveRemoteSha(sha + '\trefs/heads/v1\n', 'refs/tags/v1')).toBeNull();
  });
  it.each(['1', 'true', ' yes '])('NO_FETCH=%s なら最後の SHA を使い git を呼ばない', (value) => {
    manifest();
    cacheEngine();
    put('cache/ai-cross-review/refs.json', JSON.stringify({ 'https://example.test/upstream.git#main': sha }));
    const h = cacheDeps({ env: { XDG_CACHE_HOME: path.join(temp, 'cache'), CROSS_REVIEW_NO_FETCH: value }, gitRun: vi.fn() });
    expect(entry.resolveEngine(path.join(temp, 'project'), h).engineSha).toBe(sha);
    expect(h.gitRun).not.toHaveBeenCalled();
  });
  it.each(['', '0', 'false', ' FALSE '])('NO_FETCH=%s は fetch を止めない', (value) => {
    expect(entry.isNoFetch({ CROSS_REVIEW_NO_FETCH: value })).toBe(false);
  });
  it('ls-remote 失敗時に最後の SHA のキャッシュを使う', () => {
    manifest();
    cacheEngine();
    put('cache/ai-cross-review/refs.json', JSON.stringify({ 'https://example.test/upstream.git#main': sha }));
    expect(entry.resolveEngine(path.join(temp, 'project'), cacheDeps({ gitRun: () => { throw new Error('offline'); } })).engineSha).toBe(sha);
  });
  it.each(['{}', '{broken', JSON.stringify({ 'https://example.test/upstream.git#main': sha })])('オフラインで利用可能な本体がなければエラー: %s', (record) => {
    manifest();
    put('cache/ai-cross-review/refs.json', record);
    expect(() => entry.resolveEngine(path.join(temp, 'project'), cacheDeps({ gitRun: () => { throw new Error('offline'); } }))).toThrow(/ネットワーク/);
  });
  it('壊れた refs.json を無視して取得した SHA を記録する', () => {
    manifest(); cacheEngine();
    put('cache/ai-cross-review/refs.json', '{broken');
    expect(entry.resolveEngine(path.join(temp, 'project'), cacheDeps({ gitRun: () => sha + '\trefs/heads/main' })).engineSha).toBe(sha);
  });
  it.each([false, true])('木全体を一時名に fetch して配置する (rename の競合: %s)', (race) => {
    manifest(sha);
    const calls = [];
    const gitRun = (args) => {
      calls.push(args);
      if (args.includes('FETCH_HEAD')) {
        const staging = args[1];
        fs.mkdirSync(path.join(staging, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(staging, 'tools/cross-review.js'), 'engine');
        fs.writeFileSync(path.join(staging, 'tools/package.json'), '{"type":"commonjs"}');
      }
      return '';
    };
    const io = { ...fs, renameSync: (from, to) => {
      if (race) { fs.cpSync(from, to, { recursive: true }); throw new Error('EEXIST'); }
      fs.renameSync(from, to);
    } };
    const h = cacheDeps({ gitRun, fs: io });
    const selected = entry.resolveEngine(path.join(temp, 'project'), h);
    expect(selected.engineSha).toBe(sha);
    expect(fs.existsSync(path.join(path.dirname(selected.enginePath), 'package.json'))).toBe(true);
    expect(calls.some((args) => args.includes('--depth') && args.includes(sha))).toBe(true);
    expect(fs.readdirSync(path.dirname(path.dirname(selected.enginePath)) + '/..')).toEqual([sha]);
    expect(h.err.mock.calls.join('')).toContain(sha);
  });
  it('目的の本体もない rename 失敗は一時ディレクトリを消してエラーにする', () => {
    manifest(sha);
    const gitRun = (args) => {
      if (args.includes('FETCH_HEAD')) {
        fs.mkdirSync(path.join(args[1], 'tools'));
        fs.writeFileSync(path.join(args[1], 'tools/cross-review.js'), '');
      }
      return '';
    };
    expect(() => entry.resolveEngine(path.join(temp, 'project'), cacheDeps({ gitRun, fs: { ...fs, renameSync() { throw new Error('denied'); } } }))).toThrow(/取得できません/);
    expect(fs.readdirSync(path.join(temp, 'cache/ai-cross-review/engines'))).toEqual([]);
  });
  it.each([null, {}, { repo: 'x' }, { ref: 'main' }])('マニフェストの upstream 不備を終了コード 2 にする', (upstream) => {
    if (upstream !== null) put('project/tools/cross-review.sync.json', JSON.stringify({ upstream }));
    entry.main(cacheDeps());
    expect(process.exitCode).toBe(2);
  });
  it('キャッシュの置き場所を OS と環境変数で選ぶ', () => {
    expect(entry.resolveCacheRoot(deps({ env: { XDG_CACHE_HOME: temp, LOCALAPPDATA: 'ignored' }, platform: 'win32' }))).toBe(path.join(temp, 'ai-cross-review'));
    expect(entry.resolveCacheRoot(deps({ env: { LOCALAPPDATA: temp }, platform: 'win32' }))).toBe(path.join(temp, 'ai-cross-review'));
    expect(entry.resolveCacheRoot(deps({ platform: 'linux' }))).toBe(path.join(temp, 'home/.cache/ai-cross-review'));
    expect(entry.resolveCacheRoot(deps({ homedir: () => '', tmpdir: () => temp, platform: 'linux' }))).toBe(path.join(temp, 'ai-cross-review'));
  });
  it('refs.json の rename を Windows では再試行し、失敗しても止めない', () => {
    const rename = vi.fn(() => { throw new Error('busy'); });
    entry.writeRefs(temp, {}, { ...fs, renameSync: rename }, 'win32');
    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(temp)).toEqual([]);
  });
});

describe('本体の入口対応', () => {
  it.each([null, undefined, '1', 1.5, NaN])('整数でない版を拒否する: %s', (protocol) => {
    expect(engine.checkEntryProtocol(protocol, 'registry').ok).toBe(false);
  });
  it.each([['registry', 'git pull'], ['env', 'CROSS_REVIEW_ENGINE'], ['cache', 'upstream.ref']])('古い本体の案内を %s に合わせる', (source, advice) => {
    expect(engine.checkEntryProtocol(2, source)).toMatchObject({ ok: false, message: expect.stringContaining(advice) });
    const err = vi.fn();
    engine.main({ argv: ['state'], entryProtocol: 2, engineSource: source, err });
    expect(process.exitCode).toBe(2);
    expect(err.mock.calls.join('')).toContain(advice);
  });
  it('古い入口を sync に案内し、対応する版は受け付ける', () => {
    expect(engine.checkEntryProtocol(0, 'registry').message).toContain('node tools/cross-review.js sync');
    expect(engine.checkEntryProtocol(1, 'registry')).toEqual({ ok: true });
  });
  it('導入先のルートを状態とレビュー出力の基準にする', () => {
    const projectRoot = path.join(temp, 'project');
    expect(engine.resolveStatePath({ projectRoot, scriptDir: '/upstream/tools', stateDir: path.join(temp, 'state') })).toBe(path.join(temp, 'state/cross-review-state.json'));
    expect(engine.resolveReviewDir({ projectRoot })).toBe(path.join(projectRoot, '.cross-review'));
    const writeStateFile = vi.fn();
    engine.writeState({}, { projectRoot, stateDir: path.join(temp, 'state'), writeStateFile });
    expect(writeStateFile.mock.calls[0][0]).toBe(path.join(temp, 'state/cross-review-state.json'));
  });
  it('観点と除外の候補に上流のルートを入れない', () => {
    const candidates = [];
    const projectRoot = path.join(temp, 'project');
    put('project/.cross-review.md', 'project checklist');
    put('project/.cross-review-ignore', 'project-only');
    const h = { projectRoot, cwd: path.join(temp, 'nested'), scriptDir: path.join(temp, 'upstream/tools'), env: {}, exists: (p) => { candidates.push(p); return fs.existsSync(p); } };
    expect(engine.loadChecklist(h)).toBe('project checklist');
    expect(engine.loadIgnorePatterns(h)).toContain('project-only');
    expect(candidates.some((p) => p.includes('upstream'))).toBe(false);
  });
  it.each([0, 1, 2])('sync を版照合と CODEX_AGENT_RUN の前に実行し、終了コード %s を保つ', (exitCode) => {
    const runSync = vi.fn(() => { process.exitCode = exitCode; });
    const sync = require('../tools/cross-review.sync.js');
    engine.main({ argv: ['sync', '--check', '--ref', 'v1'], env: { CODEX_AGENT_RUN: '1' }, entryProtocol: 0, projectRoot: temp, syncModule: { ...sync, runSync } });
    expect(runSync.mock.calls[0][0]).toMatchObject({ root: temp, manifestPath: path.join(temp, 'tools/cross-review.sync.json'), mode: 'check', ref: 'v1' });
    expect(process.exitCode).toBe(exitCode);
  });
  it.each([['--root', '/other'], ['--manifest', '/other.json']])('sync は %s の上書きを拒否する', (...args) => {
    const runSync = vi.fn();
    engine.main({ argv: ['sync', ...args], projectRoot: temp, err: vi.fn(), syncModule: { ...require('../tools/cross-review.sync.js'), runSync } });
    expect(process.exitCode).toBe(2);
    expect(runSync).not.toHaveBeenCalled();
  });
  it.each(['fetch', 'plan'])('sync の %s 失敗は 3、runSync の直接実行は 1 にする', (failure) => {
    const sync = require('../tools/cross-review.sync.js');
    const manifestPath = put('project/tools/cross-review.sync.json', JSON.stringify({
      upstream: { repo: 'https://example.test/upstream.git', ref: 'main' },
      files: [{ from: 'missing.js', to: 'tools/missing.js' }],
    }));
    const projectRoot = path.join(temp, 'project');
    const h = { projectRoot, out: vi.fn(), err: vi.fn(), prepareUpstream: () => {
      if (failure === 'fetch') throw new Error('offline');
      return { dir: path.join(temp, 'upstream'), commit: sha, cleanup: vi.fn() };
    } };
    expect(sync.runSync({ ...sync.parseArgs(['--check']), root: projectRoot, manifestPath }, h)).toBeNull();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(engine.main({ ...h, argv: ['sync', '--check'], entryProtocol: 0 })).toBeNull();
    expect(process.exitCode).toBe(3);
    expect(h.err.mock.calls.join('')).toContain(failure === 'fetch' ? '上流の取得に失敗' : 'missing.js');
  });
  it('sync のマニフェスト不備は終了コード 2 を保つ', () => {
    put('project/tools/cross-review.sync.json', '{}');
    expect(engine.main({ argv: ['sync', '--check'], projectRoot: path.join(temp, 'project'), err: vi.fn() })).toBeNull();
    expect(process.exitCode).toBe(2);
  });
  it('旧形式からの sync と engine を拒否する', () => {
    for (const command of ['sync', 'engine']) {
      const err = vi.fn();
      engine.main({ argv: [command], err });
      expect(process.exitCode).toBe(2);
      expect(err).toHaveBeenCalled();
    }
  });
  it('engine は版照合と CODEX_AGENT_RUN の前に契約の JSON を出す', () => {
    const out = vi.fn();
    engine.main({ argv: ['engine'], env: { CODEX_AGENT_RUN: '1' }, entryProtocol: 99, engineSource: 'env', projectRoot: temp, out });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(out.mock.calls[0][0])).toEqual({ schemaVersion: 1, subject: 'engine', engineSource: 'env', enginePath: path.join(repoRoot, 'tools/cross-review.js'), checkout: repoRoot, entryProtocol: 99, acceptedEntryProtocol: { min: 1, max: 1 }, projectRoot: temp });
  });
  it('登録した開発中の checkout と ref の無効化を警告する', () => {
    const err = vi.fn();
    const engineGitRun = (args) => args[0] === 'symbolic-ref' ? 'origin/main' : args[0] === 'status' ? '?? untracked' : 'feature';
    engine.main({ argv: ['--help'], projectRoot: temp, entryProtocol: 1, engineSource: 'registry', engineGitRun, readFile: () => '{"upstream":{"ref":"v1"}}', err, out: vi.fn() });
    expect(err.mock.calls.join('')).toContain('既定のブランチ');
    expect(err.mock.calls.join('')).toContain('未コミット');
    expect(err.mock.calls.join('')).toContain('upstream.ref');
  });
  it.each(['main', 'refs/heads/main'])('upstream.ref が %s なら ref の無効化を警告しない', (ref) => {
    const err = vi.fn();
    engine.main({ argv: ['--help'], projectRoot: temp, entryProtocol: 1, engineSource: 'env', readFile: () => JSON.stringify({ upstream: { ref } }), err, out: vi.fn() });
    expect(err.mock.calls.join('')).not.toContain('upstream.ref');
  });
  it.each(['env', 'cache'])('%s では checkout の git 状態を調べない', (engineSource) => {
    const engineGitRun = vi.fn();
    const err = vi.fn();
    engine.main({ argv: ['--help'], projectRoot: temp, entryProtocol: 1, engineSource, engineGitRun, readFile: () => '{"upstream":{"ref":"v1"}}', err, out: vi.fn() });
    expect(engineGitRun).not.toHaveBeenCalled();
    expect(err.mock.calls.join('')).toBe(engineSource === 'env' ? '[cross-review] checkout の経路では upstream.ref は効かず、checkout の版で動きます。\n' : '');
  });
  it('git とマニフェストを読めなくても警告せず進む', () => {
    const err = vi.fn();
    engine.main({ argv: ['--help'], projectRoot: temp, entryProtocol: 1, engineSource: 'registry', engineGitRun: () => { throw new Error('git'); }, err, out: vi.fn() });
    expect(err).not.toHaveBeenCalled();
  });
  it('キャッシュ掃除は保護した SHA と非 SHA の名前を残して合計 3 個にする', () => {
    const root = path.join(temp, 'cache/ai-cross-review');
    cacheEngine(); cacheEngine(otherSha);
    put('cache/ai-cross-review/refs.json', JSON.stringify({ upstream: otherSha }));
    for (const [index, name] of ['c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40), 'fetch-staging'].entries()) {
      const dir = path.join(root, 'engines', name);
      fs.mkdirSync(dir);
      fs.utimesSync(dir, 100 + index, 100 + index);
    }
    engine.cleanEngineCache(root, sha);
    expect(fs.readdirSync(path.join(root, 'engines')).sort()).toEqual([sha, otherSha, 'e'.repeat(40), 'fetch-staging'].sort());
  });
});

describe('入口と実際の本体の結合', () => {
  it('入口が実際の本体を require して engine の JSON を返す', () => {
    const output = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { output.push(s); return true; });
    try {
      entry.main(deps({ env: { CROSS_REVIEW_ENGINE: repoRoot }, argv: ['engine'] }));
    } finally { stdout.mockRestore(); }
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(output.join(''))).toMatchObject({ engineSource: 'env', projectRoot: path.join(temp, 'project'), enginePath: path.join(repoRoot, 'tools/cross-review.js') });
  });
  it('ESM の導入先から state と engine を呼び、状態を導入先に保存する', () => {
    const project = path.join(temp, 'project');
    put('project/package.json', '{"type":"module"}');
    put('project/tools/package.json', '{"type":"commonjs"}');
    put('project/tools/cross-review.js', fs.readFileSync(path.join(repoRoot, 'tools/cross-review.entry.js')));
    const executable = path.join(project, 'tools/cross-review.js');
    const options = { cwd: project, env: { ...process.env, CODEX_AGENT_RUN: '', CROSS_REVIEW_ENGINE: repoRoot, CROSS_REVIEW_STATE_DIR: path.join(temp, 'state') }, encoding: 'utf8' };
    execFileSync('git', ['init', '--quiet', '-b', 'main', project]);
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', '検証用'], { cwd: project });
    execFileSync(process.execPath, [executable, 'state', '--reset'], options);
    expect(fs.existsSync(path.join(temp, 'state/cross-review-state.json'))).toBe(false);
    const state = JSON.parse(execFileSync(process.execPath, [executable, 'state'], options));
    expect(state.statePath).toBe(path.join(temp, 'state/cross-review-state.json'));
    const info = JSON.parse(execFileSync(process.execPath, [executable, 'engine'], options));
    expect(info).toMatchObject({ engineSource: 'env', projectRoot: project, enginePath: path.join(repoRoot, 'tools/cross-review.js') });
  });
});
