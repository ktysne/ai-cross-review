import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  resolveStatePath, readState, updateState, mergeStates, nextState, withTriage,
  runCommentCommand, runStateCommand, runDismissCommand, runReview, roundFileNames, resolveBranchReviewDir, parseArgs,
} = require('../tools/cross-review.js');
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
let root;
let deps;
let oldExit;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-review-shared-'));
  deps = { projectRoot: root, stateDir: path.join(root, 'shared'), warn: vi.fn(), err: vi.fn(), out: vi.fn() };
  oldExit = process.exitCode;
  process.exitCode = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = oldExit;
  fs.rmSync(root, { recursive: true, force: true });
});

function record(options = deps, branch = 'feature/test') {
  return updateState((state) => ({ state: nextState(state, { branch, sha }), changed: true }), options);
}

function prepareComment(round = 1) {
  deps.gitRun = (args) => args.includes('--abbrev-ref') ? 'feature/test' : args[0] === 'rev-parse' ? sha : '';
  const directory = resolveBranchReviewDir('feature/test', deps);
  fs.mkdirSync(directory, { recursive: true });
  const names = roundFileNames(round, 'codex');
  fs.writeFileSync(path.join(directory, names.meta), JSON.stringify({ reviewer: 'codex', via: 'direct' }));
  fs.writeFileSync(path.join(directory, names.triage), '指摘なし。確認済み。');
  return path.join(directory, names.comment);
}

describe('共有の状態ファイルの置き場', () => {
  it('stateDir と環境変数は git を呼ばずディレクトリとして使う', () => {
    const stateGitRun = vi.fn();
    expect(resolveStatePath({ ...deps, stateGitRun, env: { CROSS_REVIEW_STATE_DIR: 'ignored' } })).toBe(path.join(deps.stateDir, 'cross-review-state.json'));
    expect(resolveStatePath({ projectRoot: root, stateGitRun, env: { CROSS_REVIEW_STATE_DIR: root } })).toBe(path.join(root, 'cross-review-state.json'));
    expect(stateGitRun).not.toHaveBeenCalled();
  });

  it('古い git の相対 common dir を projectRoot で絶対化しルートごとにキャッシュする', () => {
    const stateGitRun = vi.fn((args) => args.includes('--path-format=absolute') ? null : '../common');
    const options = { projectRoot: root, env: {}, stateGitRun };
    const expected = path.resolve(root, '../common/cross-review-state.json');
    expect(resolveStatePath(options)).toBe(expected);
    expect(resolveStatePath(options)).toBe(expected);
    expect(stateGitRun).toHaveBeenCalledTimes(2);
    expect(stateGitRun.mock.calls.every((call) => call[1].cwd === root)).toBe(true);
  });

  it('git が使えなければ checkout の旧位置を使う', () => {
    expect(resolveStatePath({ projectRoot: root, env: {}, stateGitRun: () => { throw new Error('git missing'); } })).toBe(path.join(root, '.cross-review-state.json'));
  });

  it('一時リポジトリの二つの worktree が同じファイルへ記録する', () => {
    for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
      vi.stubEnv(name, undefined);
    }
    const checkout = path.join(root, 'checkout');
    const worktree = path.join(root, 'worktree');
    const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet', '-b', 'main', checkout]);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', '検証用'], checkout);
    git(['worktree', 'add', '--quiet', '-b', 'feature/test', worktree], checkout);
    const first = { projectRoot: checkout, env: {} };
    const second = { projectRoot: worktree, env: {} };
    expect(resolveStatePath(first)).toBe(path.join(checkout, '.git/cross-review-state.json'));
    expect(resolveStatePath(first)).toBe(resolveStatePath(second));
    expect(record(first)).not.toBe(false);
    expect(record(second)).not.toBe(false);
    expect(readState(first).state.branches['feature/test'].round).toBe(2);
  });
});

describe('共有状態の更新と取り込み', () => {
  it('既存ロックがあれば待って失敗しファイルを書かない', () => {
    fs.mkdirSync(deps.stateDir);
    fs.writeFileSync(`${resolveStatePath(deps)}.lock`, JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
    const start = Date.now();
    expect(record({ ...deps, lockTimeoutMs: 80 })).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
    expect(fs.existsSync(resolveStatePath(deps))).toBe(false);
  });

  it.each(['読めない本文', '生存していない pid'])('30 秒より古い放棄ロックは自動で消さず、案内付きで失敗する: %s', (kind) => {
    fs.mkdirSync(deps.stateDir);
    const lock = `${resolveStatePath(deps)}.lock`;
    fs.writeFileSync(lock, kind === '読めない本文' ? '{' : JSON.stringify({ pid: 123456, hostname: os.hostname() }));
    if (kind !== '読めない本文') vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
    const old = new Date(Date.now() - 31000);
    fs.utimesSync(lock, old, old);
    expect(record({ ...deps, lockTimeoutMs: 0 })).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(resolveStatePath(deps))).toBe(false);
    const message = deps.warn.mock.calls.flat().join('');
    expect(message).toContain('放棄されたロックの可能性');
    expect(message).toContain(lock);
    expect(fs.readdirSync(deps.stateDir)).toEqual(['cross-review-state.json.lock']);
  });

  it.each(['生存中', '別ホスト', '確認権限なし'])('古くても生存を否定できないロックは奪わない: %s', (kind) => {
    fs.mkdirSync(deps.stateDir);
    const lock = `${resolveStatePath(deps)}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: kind === '別ホスト' ? 'other-host' : os.hostname() }));
    const old = new Date(Date.now() - 31000);
    fs.utimesSync(lock, old, old);
    if (kind === '確認権限なし') vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(record({ ...deps, lockTimeoutMs: 0 })).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(deps.warn.mock.calls.flat().join('')).not.toContain('放棄されたロックの可能性');
  });

  it('壊れた共有ファイルは旧ファイルがあっても変更しない', () => {
    fs.mkdirSync(deps.stateDir);
    fs.writeFileSync(resolveStatePath(deps), '{broken');
    const legacy = path.join(root, '.cross-review-state.json');
    fs.writeFileSync(legacy, JSON.stringify(nextState(null, { branch: 'feature/test', sha })));
    expect(record()).toBe(false);
    expect(fs.readFileSync(resolveStatePath(deps), 'utf8')).toBe('{broken');
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(`${resolveStatePath(deps)}.lock`)).toBe(false);
  });

  it('変更がなければ共有ファイルを作らない', () => {
    expect(updateState((state) => ({ state, result: 42, changed: false }), deps).result).toBe(42);
    expect(fs.existsSync(resolveStatePath(deps))).toBe(false);
  });

  it('状態遷移の適用中は他の書き手がロックを取れない', () => {
    expect(updateState((state) => {
      expect(record({ ...deps, lockTimeoutMs: 0 })).toBe(false);
      const owner = JSON.parse(fs.readFileSync(`${resolveStatePath(deps)}.lock`, 'utf8'));
      expect(owner.pid).toBe(process.pid);
      expect(owner.hostname).toBe(os.hostname());
      return { state, changed: false };
    }, deps)).not.toBe(false);
    expect(fs.existsSync(`${resolveStatePath(deps)}.lock`)).toBe(false);
  });

  it('旧ファイルを統合し絶対パスのハッシュ名で imported へ移す', () => {
    const legacy = path.join(root, '.cross-review-state.json');
    const state = nextState(null, { branch: 'legacy', sha });
    fs.writeFileSync(legacy, JSON.stringify(state));
    expect(record()).not.toBe(false);
    expect(readState(deps).state.branches.legacy.round).toBe(1);
    expect(fs.existsSync(legacy)).toBe(false);
    const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
    expect(JSON.parse(fs.readFileSync(path.join(deps.stateDir, 'cross-review-state.imported', `${hash}.json`)))).toEqual(state);
  });

  it('EXDEV では旧ファイルを複製してから消す', () => {
    const legacy = path.join(root, '.cross-review-state.json');
    const state = nextState(null, { branch: 'legacy', sha });
    fs.writeFileSync(legacy, JSON.stringify(state));
    deps.renameFile = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
    expect(record()).not.toBe(false);
    expect(readState(deps).state.branches.legacy.round).toBe(1);
    expect(fs.existsSync(legacy)).toBe(false);
    const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
    expect(JSON.parse(fs.readFileSync(path.join(deps.stateDir, 'cross-review-state.imported', `${hash}.json`)))).toEqual(state);
  });

  it.each([['複製', 'copyFile'], ['削除', 'removeFile']])('EXDEV で旧ファイルの%s に失敗したら reset を適用せず、後の reset で記録が戻らない', (_label, failing) => {
    deps.gitRun = (args) => args.includes('--abbrev-ref') ? 'feature/test' : sha;
    record();
    record();
    const legacy = path.join(root, '.cross-review-state.json');
    fs.writeFileSync(legacy, JSON.stringify(nextState(null, { branch: 'feature/test', sha })));
    deps.renameFile = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
    deps[failing] = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    runStateCommand({ reset: true }, deps);
    expect(process.exitCode).toBe(1);
    expect(deps.warn.mock.calls.flat().join('')).toContain('旧ファイルを移せません');
    expect(readState(deps).state.branches['feature/test'].round).toBe(2);
    expect(fs.existsSync(legacy)).toBe(true);
    delete deps.renameFile;
    delete deps[failing];
    process.exitCode = 0;
    runStateCommand({ reset: true }, deps);
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(readState(deps).state.branches['feature/test']).toBeUndefined();
    expect(record()).not.toBe(false);
    expect(readState(deps).state.branches['feature/test'].round).toBe(1);
  });

  it('壊れた旧ファイルは残して警告し共有状態へ記録する', () => {
    fs.writeFileSync(path.join(root, '.cross-review-state.json'), '{');
    expect(record()).not.toBe(false);
    expect(deps.warn.mock.calls.flat().join('')).toContain('旧ファイルを読めない');
    expect(fs.existsSync(path.join(root, '.cross-review-state.json'))).toBe(true);
  });

  it('表示は旧ファイルを取り込まず警告しロックも作らない', () => {
    deps.gitRun = () => 'feature/test';
    fs.writeFileSync(path.join(root, '.cross-review-state.json'), '{}');
    runStateCommand({}, deps);
    expect(deps.warn.mock.calls.flat().join('')).toContain('未取り込みの旧ファイル');
    expect(fs.existsSync(deps.stateDir)).toBe(false);
  });

  it.each([
    ['state --mark', (options) => runStateCommand({ mark: true }, options)],
    ['state --reset', (options) => runStateCommand({ reset: true }, options)],
    ['dismiss', (options) => runDismissCommand({ dismissText: '要約' }, options)],
  ])('書く可能性のあるコマンドは状態を使う前に旧ファイルを取り込む: %s', (_name, run) => {
    deps.gitRun = (args) => args.includes('--abbrev-ref') ? 'feature/test' : sha;
    const legacy = path.join(root, '.cross-review-state.json');
    fs.writeFileSync(legacy, JSON.stringify(nextState(null, { branch: 'other', sha })));
    run(deps);
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(readState(deps).state.branches.other.round).toBe(1);
  });

  it('comment は --outcome が無ければ旧ファイルを取り込まず警告する', () => {
    prepareComment();
    fs.writeFileSync(path.join(root, '.cross-review-state.json'), '{}');
    runCommentCommand({ round: 1 }, deps);
    expect(deps.warn.mock.calls.flat().join('')).toContain('未取り込みの旧ファイル');
    expect(fs.existsSync(path.join(root, '.cross-review-state.json'))).toBe(true);
    expect(fs.existsSync(deps.stateDir)).toBe(false);
  });

  it('rename の一時的な EBUSY は再試行して一時ファイルを残さない', () => {
    const original = fs.renameSync;
    let attempts = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (from.includes('.tmp-') && attempts++ < 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return original(from, to);
    });
    expect(record()).not.toBe(false);
    expect(attempts).toBe(3);
    expect(fs.readdirSync(deps.stateDir)).toEqual(['cross-review-state.json']);
  });

  it('rename が失敗し続けても元の状態を残し一時ファイルとロックを消す', () => {
    record();
    const originalBody = fs.readFileSync(resolveStatePath(deps), 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(record()).toBe(false);
    expect(fs.readFileSync(resolveStatePath(deps), 'utf8')).toBe(originalBody);
    expect(fs.readdirSync(deps.stateDir)).toEqual(['cross-review-state.json']);
  });

  it('レビューは base 解決前に旧ファイルの lastReviewedSha を取り込む', () => {
    fs.writeFileSync(path.join(root, '.cross-review-state.json'), JSON.stringify(nextState(null, { branch: 'feature/test', sha })));
    const gitRun = vi.fn((args) => {
      if (args.includes('--abbrev-ref')) return 'feature/test';
      if (args[0] === 'rev-parse') return otherSha;
      if (args[0] === 'cat-file') return '';
      return args[0] === 'diff' ? '差分' : '';
    });
    runReview(parseArgs(['subagent']), { ...deps, gitRun, env: { CROSS_REVIEW_NO_FETCH: '1' }, checklist: '観点', reviewRoute: () => 'default', noPrCheck: true });
    expect(gitRun.mock.calls.some(([args]) => args.includes(`${sha}...HEAD`))).toBe(true);
    expect(readState(deps).state.branches['feature/test'].round).toBe(2);
  });
});

describe('結論の往復と SHA の検査', () => {
  it('往復不足では本文生成と投稿を行わず終了コード 1 にする', () => {
    const output = prepareComment(2);
    deps.ghRun = vi.fn();
    runCommentCommand({ round: 2, postNumber: 42, outcome: 'fixing' }, deps);
    expect(process.exitCode).toBe(1);
    expect(readState(deps).state.branches).toEqual({});
    expect(fs.existsSync(output)).toBe(false);
    expect(deps.ghRun).not.toHaveBeenCalled();
    const message = deps.err.mock.calls.flat().join('');
    expect(message).toContain('--allow-round-mismatch');
    expect(message).toContain('2 往復目のレビューの記録が状態ファイル');
    expect(message).toContain(resolveStatePath(deps));
    expect(message).toContain('node tools/cross-review.js state');
  });

  it('--allow-round-mismatch なら往復不足でも結論を記録する', () => {
    prepareComment(2);
    runCommentCommand({ round: 2, outcome: 'fixing', allowRoundMismatch: true }, deps);
    expect(process.exitCode).toBe(0);
    expect(readState(deps).state.branches['feature/test'].lastTriage).toEqual({ round: 2, sha, outcome: 'fixing' });
  });

  it.each([false, true])('HEAD とレビュー SHA の相違は短縮 SHA で警告する (allow=%s)', (allowRoundMismatch) => {
    prepareComment();
    updateState(() => ({ state: nextState(null, { branch: 'feature/test', sha: otherSha }) }), deps);
    runCommentCommand({ round: 1, outcome: 'fixing', allowRoundMismatch }, deps);
    expect(process.exitCode).toBe(0);
    expect(deps.err.mock.calls.flat().join('')).toContain(`直前レビュー SHA bbbbbbb と HEAD aaaaaaa`);
  });

  it('投稿中に reset された往復はロック内の再検査で記録しない', () => {
    prepareComment();
    record();
    deps.ghRun = () => {
      updateState(() => ({ state: { branches: {} } }), deps);
      return { status: 0, stdout: '', stderr: '' };
    };
    runCommentCommand({ round: 1, outcome: 'fixing', postNumber: 42 }, deps);
    expect(process.exitCode).toBe(1);
    expect(readState(deps).state.branches).toEqual({});
    expect(deps.err.mock.calls.flat().join('')).toContain('PR #42 へ投稿しましたが結論は記録していません');
  });

  it('解析したフラグを comment で受け付け、他のコマンドでは拒否する', () => {
    expect(parseArgs(['comment', '--round', '1', '--allow-round-mismatch']).allowRoundMismatch).toBe(true);
    expect(parseArgs(['codex', '--allow-round-mismatch']).error).toContain('--allow-round-mismatch');
  });
});

describe('状態の統合', () => {
  it('レビュー回数と結論を別々に選び何度統合しても同じ結果になる', () => {
    let shared = null;
    for (let i = 0; i < 3; i++) shared = nextState(shared, { branch: 'feature/test', sha });
    const legacy = withTriage(null, 'feature/test', { round: 3, sha, outcome: 'converged' });
    const merged = mergeStates(shared, legacy);
    expect(merged.branches['feature/test'].round).toBe(3);
    expect(merged.branches['feature/test'].lastTriage.outcome).toBe('converged');
    expect(mergeStates(merged, legacy)).toEqual(merged);
  });
});

it('旧ファイルを一時的に読めなければ書かずに失敗し、読めるようになった後の取り込みで reset した記録が戻らない', () => {
  const legacy = path.join(root, '.cross-review-state.json');
  fs.writeFileSync(legacy, `${JSON.stringify({ branches: { 'feature/test': { round: 2, lastReviewedSha: sha } } })}\n`);
  const original = fs.readFileSync;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
    if (path.resolve(String(file)) === legacy) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return original(file, ...rest);
  });
  expect(record()).toBe(false);
  expect(fs.existsSync(path.join(deps.stateDir, 'cross-review-state.json'))).toBe(false);
  expect(fs.existsSync(legacy)).toBe(true);
  spy.mockRestore();
  expect(record()).not.toBe(false);
  expect(readState(deps).state.branches['feature/test'].round).toBe(3);
  expect(fs.existsSync(legacy)).toBe(false);
});
