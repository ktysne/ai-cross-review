// --merge-resolution (収束の後に base を取り込んだ merge の競合の解消だけをレビューする) を、
// os.tmpdir() に作った実際の git リポジトリで検証する。レビュアーの起動と状態ファイルは差し替える。

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  parseArgs,
  runReview,
  buildRoundComment,
  gitSupportsRemergeDiff,
  mergeResolutionTarget,
  branchStateOf,
} = require('../tools/cross-review.js');

const roots = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const BRANCH = 'feat/x';

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} に失敗: ${res.stderr}`);
  return res.stdout.trim();
}

function write(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text);
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

// main に a.txt の初期コミットがあり、feat/x に切って a.txt の 1 行目を変えたコミットを積み、
// その時点をレビュー済みの SHA とした状態のリポジトリを作る。
function makeRepo({ withLock = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-review-merge-'));
  roots.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'tester');
  git(dir, 'config', 'user.email', 'tester@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, 'a.txt', 'line1\nline2\nline3\n');
  commitAll(dir, 'initial');
  git(dir, 'checkout', '-q', '-b', BRANCH);
  write(dir, 'a.txt', 'feature1\nline2\nline3\n');
  if (withLock) write(dir, 'gen.lock', 'feature-version\n');
  const reviewed = commitAll(dir, 'feature');
  return { dir, reviewed };
}

// main 側で同じ行を別の内容に変えて競合させ、競合を解いた merge を feat/x に足す。
function mergeMainWithConflict(dir, extraResolved = {}) {
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'a.txt', 'mainside1\nline2\nline3\n');
  write(dir, 'unrelated.txt', 'UNRELATED_MAIN_CONTENT\n');
  for (const name of Object.keys(extraResolved)) write(dir, name, 'main-version\n');
  commitAll(dir, 'main change');
  git(dir, 'checkout', '-q', BRANCH);
  const merged = spawnSync('git', ['merge', 'main'], { cwd: dir, encoding: 'utf8' });
  if (merged.status === 0) throw new Error('競合するはずの merge が成功しました');
  write(dir, 'a.txt', 'resolved1\nline2\nline3\n');
  for (const [name, text] of Object.entries(extraResolved)) write(dir, name, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-edit');
  return git(dir, 'rev-parse', 'HEAD');
}

// 競合の無い merge を feat/x に足す。
function mergeMainWithoutConflict(dir) {
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'unrelated.txt', 'UNRELATED_MAIN_CONTENT\n');
  commitAll(dir, 'main change');
  git(dir, 'checkout', '-q', BRANCH);
  git(dir, 'merge', '-q', '--no-edit', 'main');
  return git(dir, 'rev-parse', 'HEAD');
}

function gitIn(dir) {
  return (args, opts) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const ok = res.status === 0 || (opts && opts.allowDiffExit && res.status === 1);
    if (!ok) {
      if (opts && opts.allowFailure) return null;
      throw new Error(`git ${args.join(' ')} に失敗しました: ${res.stderr}`);
    }
    return res.stdout || '';
  };
}

function memoryState(reviewed, round = 1) {
  const store = {
    state: reviewed
      ? { branches: { [BRANCH]: { round, lastReviewedSha: reviewed, dismissed: [], lastTriage: null } } }
      : { branches: {} },
    writes: [],
    files: {},
  };
  return {
    store,
    readState: () => ({ path: '<test-state>', state: store.state, corrupt: false }),
    writeState: (next) => { store.writes.push(next); store.state = next; return true; },
    ghRun: () => null,
    writeReviewFile: (p, body) => { store.files[p] = body; },
  };
}

// レビュアーの実行を差し替えて runReview を回し、stdin に渡ったプロンプトと通知を集める。
function review(dir, reviewed, argv, extra = {}, round = 1) {
  const mem = memoryState(reviewed, round);
  const seen = { prompt: null, out: '', err: '' };
  process.exitCode = 0;
  runReview(parseArgs(argv), {
    ...mem,
    gitRun: gitIn(dir),
    checklist: 'CL',
    ignorePatterns: [],
    exists: () => false,
    reviewRoute: () => 'default',
    env: { CROSS_REVIEW_NO_FETCH: '1' },
    out: (s) => { seen.out += s; },
    err: (s) => { seen.err += s; },
    now: () => '2026-10-30T00:00:00.000Z',
    spawnFn: (cmd, args, stdin, onExit) => {
      seen.prompt = stdin;
      onExit({ code: 0, output: 'REVIEW_BODY', outputTail: '', error: null });
      return null;
    },
    ...extra,
  });
  const exitCode = process.exitCode;
  process.exitCode = 0;
  return { mem, seen, exitCode };
}

function savedMeta(mem) {
  const key = Object.keys(mem.store.files).find((name) => name.endsWith('.json'));
  return key ? JSON.parse(mem.store.files[key]) : null;
}

describe('--merge-resolution (実リポジトリ)', { timeout: 60000 }, () => {
  it('競合を解いた head では解消の差分だけがレビューに渡り、往復が 1 増えて lastReviewedSha が HEAD になる', () => {
    const { dir, reviewed } = makeRepo();
    const mergeSha = mergeMainWithConflict(dir);
    const { mem, seen, exitCode } = review(dir, reviewed, ['codex', '--merge-resolution']);

    expect(exitCode).toBe(0);
    expect(seen.prompt).toContain('resolved1');
    expect(seen.prompt).toContain(`# merge ${mergeSha}`);
    expect(seen.prompt).not.toContain('UNRELATED_MAIN_CONTENT');
    expect(seen.prompt).toContain('競合の解消の差分');
    expect(seen.err).toContain('対象: 競合の解消の差分 (merge ' + mergeSha.slice(0, 7) + ')');
    expect(seen.err).not.toContain('base として');

    const recorded = branchStateOf(mem.store.state, BRANCH);
    expect(recorded.round).toBe(2);
    expect(recorded.lastReviewedSha).toBe(mergeSha);

    const meta = savedMeta(mem);
    expect(meta.mergeResolution).toEqual({ merges: [mergeSha] });
    expect(meta.base).toEqual({ ref: reviewed, source: 'merge-resolution' });
  });

  it('merge が複数あれば古い順につなぎ、対象の merge の SHA をすべて残す', () => {
    const { dir, reviewed } = makeRepo();
    const first = mergeMainWithConflict(dir);
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'second.txt', 'SECOND_MAIN\n');
    commitAll(dir, 'main second');
    git(dir, 'checkout', '-q', BRANCH);
    git(dir, 'merge', '-q', '--no-edit', 'main');
    const second = git(dir, 'rev-parse', 'HEAD');
    const { mem, seen } = review(dir, reviewed, ['codex', '--merge-resolution']);

    expect(seen.prompt.indexOf(`# merge ${first}`)).toBeGreaterThan(-1);
    expect(savedMeta(mem).mergeResolution.merges).toEqual([first, second]);
    expect(seen.err).toContain(`merge ${first.slice(0, 7)} ほか`);
  });

  it('除外の規則を通り、除外したが変更のあったファイルを申し送る', () => {
    const { dir, reviewed } = makeRepo({ withLock: true });
    mergeMainWithConflict(dir, { 'gen.lock': 'resolved-lock\n' });
    const { seen } = review(dir, reviewed, ['codex', '--merge-resolution'], {
      ignorePatterns: ['*.lock'],
    });

    expect(seen.prompt).not.toContain('resolved-lock');
    expect(seen.prompt).toContain('- gen.lock');
  });

  it('競合の無い取り込みでは、往復を数えず状態も変えずに終了コード 0 で終わる', () => {
    const { dir, reviewed } = makeRepo();
    mergeMainWithoutConflict(dir);
    const { mem, seen, exitCode } = review(dir, reviewed, ['codex', '--merge-resolution']);

    expect(exitCode).toBe(0);
    expect(seen.prompt).toBeNull();
    expect(seen.out).toContain('競合の解消は無いので、レビューは不要');
    expect(mem.store.writes).toEqual([]);
    expect(mem.store.files).toEqual({});
  });

  it('subagent では競合の無い取り込みの通知を stderr に出し、stdout は空のままにする', () => {
    const { dir, reviewed } = makeRepo();
    mergeMainWithoutConflict(dir);
    const { seen } = review(dir, reviewed, ['subagent', '--merge-resolution']);

    expect(seen.out).toBe('');
    expect(seen.err).toContain('競合の解消は無いので、レビューは不要');
  });

  it('merge でないコミットが混じると、通常のレビューを案内して終了コード 1 で止まる', () => {
    const { dir, reviewed } = makeRepo();
    mergeMainWithConflict(dir);
    write(dir, 'extra.txt', 'extra\n');
    commitAll(dir, 'plain commit');
    const { mem, seen, exitCode } = review(dir, reviewed, ['codex', '--merge-resolution']);

    expect(exitCode).toBe(1);
    expect(seen.err).toContain('merge でないコミットが含まれています');
    expect(seen.err).toContain('通常のレビュー (--merge-resolution を外して実行)');
    expect(seen.prompt).toBeNull();
    expect(mem.store.writes).toEqual([]);
  });

  it('base 以外のブランチからの merge があると終了コード 1 で止まる', () => {
    const { dir, reviewed } = makeRepo();
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', '-q', '-b', 'other');
    write(dir, 'other.txt', 'OTHER\n');
    commitAll(dir, 'other work');
    git(dir, 'checkout', '-q', BRANCH);
    git(dir, 'merge', '-q', '--no-edit', 'other');
    const { seen, exitCode } = review(dir, reviewed, ['codex', '--merge-resolution']);

    expect(exitCode).toBe(1);
    expect(seen.err).toContain('base (main) 以外から取り込んでいます');
    expect(seen.err).toContain('通常のレビュー');
    expect(seen.prompt).toBeNull();
  });

  it('前回レビュー時の SHA が第 1 親の鎖に無いと終了コード 1 で止まる', () => {
    const { dir } = makeRepo();
    git(dir, 'checkout', '-q', 'main');
    const mainTip = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', BRANCH);
    const { seen, exitCode } = review(dir, mainTip, ['codex', '--merge-resolution']);

    expect(exitCode).toBe(1);
    expect(seen.err).toMatch(/第 1 親をたどっても前回レビュー時の .* に着きません|merge でない/);
  });

  it('lastReviewedSha の記録が無いと終了コード 1 で止まる', () => {
    const { dir } = makeRepo();
    mergeMainWithConflict(dir);
    const { seen, exitCode } = review(dir, null, ['codex', '--merge-resolution']);

    expect(exitCode).toBe(1);
    expect(seen.err).toContain('前回レビュー時の SHA の記録がありません');
    expect(seen.err).toContain('通常のレビュー');
  });

  it('git が --remerge-diff に対応していない版なら、その旨を示して終了コード 1 で止まる', () => {
    const { dir, reviewed } = makeRepo();
    mergeMainWithConflict(dir);
    const { seen, exitCode } = review(dir, reviewed, ['codex', '--merge-resolution'], { gitVersion: 'git version 2.35.1' });

    expect(exitCode).toBe(1);
    expect(seen.err).toContain('git 2.35 は git show --remerge-diff に対応していません');
    expect(seen.prompt).toBeNull();
  });

  it('claude でも同じ差分でレビューする', () => {
    const { dir, reviewed } = makeRepo();
    const mergeSha = mergeMainWithConflict(dir);
    const { mem, seen } = review(dir, reviewed, ['claude', '--merge-resolution']);

    expect(seen.prompt).toContain('resolved1');
    expect(branchStateOf(mem.store.state, BRANCH).lastReviewedSha).toBe(mergeSha);
  });
});

describe('--merge-resolution なしの既定のレビューでの案内', { timeout: 60000 }, () => {
  it('前回レビュー以降が base を取り込む merge だけなら、--merge-resolution の案内を出して通常のレビューを続ける', () => {
    const { dir, reviewed } = makeRepo();
    mergeMainWithConflict(dir);
    const { seen, exitCode } = review(dir, reviewed, ['codex']);

    expect(exitCode).toBe(0);
    expect(seen.err).toContain('--merge-resolution を付けると競合の解消の差分だけをレビューできます');
    expect(seen.prompt).toContain('UNRELATED_MAIN_CONTENT');
  });

  it('merge でないコミットがあれば案内を出さない', () => {
    const { dir, reviewed } = makeRepo();
    mergeMainWithConflict(dir);
    write(dir, 'extra.txt', 'extra\n');
    commitAll(dir, 'plain commit');
    const { seen } = review(dir, reviewed, ['codex']);

    expect(seen.err).not.toContain('--merge-resolution');
  });

  it('判定が失敗しても黙って通常のレビューを続ける', () => {
    const { dir, reviewed } = makeRepo();
    mergeMainWithConflict(dir);
    const real = gitIn(dir);
    const { seen, exitCode } = review(dir, reviewed, ['codex'], {
      gitRun: (args, opts) => {
        if (args[0] === 'rev-list') throw new Error('rev-list の失敗');
        return real(args, opts);
      },
    });

    expect(exitCode).toBe(0);
    expect(seen.err).not.toContain('--merge-resolution');
    expect(seen.prompt).not.toBeNull();
  });
});

describe('--merge-resolution の引数', () => {
  it('単独で指定できる', () => {
    const opts = parseArgs(['codex', '--merge-resolution']);
    expect(opts.error).toBeNull();
    expect(opts.mergeResolution).toBe(true);
  });

  it.each([
    [['codex', '--merge-resolution', '--uncommitted'], '--uncommitted'],
    [['codex', '--merge-resolution', '--base', 'main'], '--base'],
    [['claude', '--merge-resolution', '--base=main'], '--base'],
    [['subagent', '--merge-resolution', '--no-state'], '--no-state'],
  ])('%j は併用できないとして弾く', (argv, conflicting) => {
    const opts = parseArgs(argv);
    expect(opts.error).toContain(`--merge-resolution は`);
    expect(opts.error).toContain(conflicting);
    expect(opts.error).toContain('併用できません');
  });

  it.each([['state'], ['route'], ['artifacts', '--clean-legacy'], ['dismiss', '要約']])(
    '%j のサブコマンドでは使えない',
    (...argv) => {
      const opts = parseArgs([...argv.flat(), '--merge-resolution']);
      expect(opts.error).toContain('レビュアーのサブコマンドでのみ使えます');
    },
  );

  it('comment でも使えない', () => {
    const opts = parseArgs(['comment', '--round', '1', '--merge-resolution']);
    expect(opts.error).toContain('レビュアーのサブコマンドでのみ使えます');
  });
});

describe('--merge-resolution の PR コメント', () => {
  const meta = {
    reviewer: 'codex',
    via: 'direct',
    base: { ref: 'abcdef0123', source: 'merge-resolution' },
    diffKb: 0.4,
    mergeResolution: { merges: ['1234567890abcdef', 'fedcba0987654321'] },
  };

  it('見出しに競合の解消のレビューと出し、要約行の base の部分を対象の表示にする', () => {
    const body = buildRoundComment({ round: 2, reviewer: 'codex', meta, triage: 'T', verify: '' });
    expect(body).toContain('## クロスレビュー 2 往復目(競合の解消のレビュー): Codex の指摘と対応');
    expect(body).toContain('実行経路: 直接起動 / 対象: 競合の解消の差分 (merge 1234567 ほか) / 差分サイズ: 0.4KB');
    expect(body).not.toContain('base:');
  });

  it('head と結論の表示と末尾の注記は変わらない', () => {
    const body = buildRoundComment({
      round: 2,
      reviewer: 'codex',
      meta,
      triage: 'T',
      triageRecord: { sha: 'aaaaaaa1111111', outcome: 'converged' },
    });
    expect(body).toContain('/ head: aaaaaaa / 結論: 収束 (converged)');
    expect(body).toContain('<!-- cross-review round=2 sha=aaaaaaa1111111 outcome=converged -->');
  });

  it('merge が 1 件なら ほか を付けない', () => {
    expect(mergeResolutionTarget(['1234567890'])).toBe('対象: 競合の解消の差分 (merge 1234567)');
  });

  it('通常のメタ情報の見出しと要約行は変わらない', () => {
    const body = buildRoundComment({
      round: 1,
      reviewer: 'codex',
      meta: { reviewer: 'codex', via: 'direct', base: { ref: 'origin/main', source: 'origin-main' }, diffKb: 1 },
      triage: 'T',
    });
    expect(body).toContain('## クロスレビュー 1 往復目: Codex の指摘と対応');
    expect(body).toContain('base: origin/main (origin/main 優先解決)');
  });
});

describe('gitSupportsRemergeDiff', () => {
  it.each([
    ['git version 2.35.1', false],
    ['git version 2.36.0', true],
    ['git version 2.54.0.windows.1', true],
    ['git version 3.0.0', true],
    ['git version 1.9.0', false],
  ])('%s は対応 = %s', (version, supported) => {
    expect(gitSupportsRemergeDiff(() => null, { gitVersion: version }).supported).toBe(supported);
  });

  it('読み取れないバージョンは対応とみなす', () => {
    expect(gitSupportsRemergeDiff(() => null).supported).toBe(true);
    expect(gitSupportsRemergeDiff(() => 'unknown').supported).toBe(true);
  });

  it('差し替え口が無ければ git --version の出力を使う', () => {
    expect(gitSupportsRemergeDiff(() => 'git version 2.30.0\n').supported).toBe(false);
  });
});
