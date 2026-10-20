import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  codexAgentInvocation, reviewerInvocation, resolveReviewerCommandForSpawn,
  runReview, scriptPinsApprovalNever,
} = require('../tools/cross-review.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (version) => path.join(root, 'tests/fixtures/bridge', version, 'codex-agent.sh');
const response = (extra = {}) => ({
  protocol: 1, status: 'ok', sandbox: 'read-only', approval_policy: 'never',
  definition: { user: '/home/test/.claude/gpt-agents/codex-review.md', project: null },
  ...extra,
});
const reply = (data) => ({ status: 0, stdout: JSON.stringify(data), stderr: '' });
const options = { reviewer: 'codex', fix: false };
const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

describe('bridge 公開照会の分類', () => {
  const invoke = (result, opts = options, extra = {}) => codexAgentInvocation('/bridge.sh', opts, {
    platform: 'linux', cwd: root, spawnSync: () => result,
    readFile: () => { throw new Error('新経路では本文を読まない'); }, ...extra,
  });

  it('照会は起動と同じ cwd と bash の解決を使い、stdin を渡さず 15 秒で打ち切る', () => {
    const query = vi.fn(() => reply(response()));
    const inv = invoke(null, options, {
      platform: 'win32', lookup: () => ['C:/Git/bin/bash.exe'], spawnSync: query,
    });
    expect(query).toHaveBeenCalledWith('C:/Git/bin/bash.exe',
      ['/bridge.sh', '--describe', 'codex-review', '-C', root], expect.objectContaining({
        cwd: root, shell: false, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
      }));
    expect(inv.cwd).toBe(root);
    expect(inv.codexDefinitionPresent).toBe(true);
    expect(inv.args).toEqual(['/bridge.sh', 'codex-review', '-C', root]);
  });

  it.each([
    [{ error: { code: 'ETIMEDOUT', message: '時間切れ' } }, 'ETIMEDOUT'],
    [{ error: { code: 'EACCES', message: '拒否' } }, 'EACCES'],
    [{ status: 0, stdout: 'not json', stderr: '' }, 'JSON'],
    [reply(response({ protocol: 2 })), 'protocol=2'],
    [reply(response({ protocol: '1' })), 'protocol=1'],
    [reply(response({ status: 'future', message: '未知の応答', launch_exit: 3 })), 'launch_exit=3'],
    [{ status: 9, stdout: '', stderr: '失敗の先頭行\n詳細' }, '終了コード 9: 失敗の先頭行'],
    [{ status: 2, stdout: '{}', stderr: '不明なオプション: --describe' }, '終了コード 2'],
    [{ status: 2, stdout: '', stderr: '--describe の失敗' }, '終了コード 2'],
    [reply(null), 'protocol=undefined'],
  ])('照会の失敗では起動と互換解析を行わない (%j)', (result, reason) => {
    const inv = invoke(result);
    expect(inv.error).toContain(reason);
    expect(inv.error).toContain('--no-codex-agent');
    expect(inv.exitCode).toBe(1);
    expect(inv.cmd).toBeUndefined();
  });

  it('bash が無ければ直接起動を選ぶ', () => {
    expect(invoke({ error: { code: 'ENOENT' } })).toBeNull();
    expect(invoke(null, options, { spawnSync: () => { throw Object.assign(new Error('不在'), { code: 'ENOENT' }); } })).toBeNull();
  });

  it('Windows で bash が見つからなければ照会せずに直接起動を選ぶ', () => {
    const spawnQuery = vi.fn();
    expect(invoke(null, options, { platform: 'win32', lookup: () => [], spawnSync: spawnQuery })).toBeNull();
    expect(spawnQuery).not.toHaveBeenCalled();
  });

  it.each(['codex-disabled', 'model-unset'])('無効化 %s は代替プロンプトを選ぶ', (reason) => {
    expect(invoke(reply(response({ status: 'disabled', reason, definition: { project: '/project.md' } }))))
      .toEqual({ fallbackCause: 'definition-disabled', definitionPath: '/project.md' });
  });

  it('定義が無ければ Codex 不在の確認より先に直接起動を選ぶ', () => {
    const spawnQuery = vi.fn(() => reply(response({
      status: 'disabled', reason: 'definition-not-found', definition: { user: null, project: null },
    })));
    expect(reviewerInvocation(options, {
      platform: 'linux', cwd: root, env: { PATH: '', CROSS_REVIEW_CODEX_AGENT: '/bridge.sh' },
      exists: (p) => p === '/bridge.sh', spawnSync: spawnQuery,
    }).via).toBe('direct');
    expect(spawnQuery).toHaveBeenCalledTimes(1);
    expect(spawnQuery.mock.calls[0][2].env.PATH).toBe('');
  });

  it.each([
    ['disabled', 'codex-not-found'], ['disabled', 'future'],
    ['invalid', 'project-override-rejected'], ['unreadable', 'front-matter-unreadable-user'],
  ])('%s/%s は理由と message を出して拒否する', (status, reason) => {
    const inv = invoke(reply(response({ status, reason, message: '照会の説明' })));
    expect(inv.error).toContain(reason);
    expect(inv.error).toContain('照会の説明');
  });

  it.each([
    [{ sandbox: 'workspace-write' }, false, 'workspace-write'],
    [{ sandbox: 'read-only' }, true, 'workspace-write'],
    [{ approval_policy: 'on-request' }, false, 'on-request'],
  ])('照会値が必要な権限と異なれば拒否する (%j)', (values, fix, expected) => {
    const inv = invoke(reply(response(values)), { ...options, fix });
    expect(inv.error).toContain(expected);
    expect(inv.exitCode).toBeUndefined();
    expect(inv.error).not.toContain('--no-codex-agent');
  });

  it.each([
    ['invalid', 'project-override-rejected', undefined], ['unreadable', 'front-matter-unreadable-user', undefined],
    ['disabled', 'codex-not-found', 1], ['disabled', 'future', 1],
  ])('%s/%s の終了コードは定義の拒否なら既定の 2、照会や環境の失敗なら 1 にする', (status, reason, exitCode) => {
    const inv = invoke(reply(response({ status, reason, message: '照会の説明' })));
    expect(inv.exitCode).toBe(exitCode);
  });

  it('旧版と同じエラー文でも JSON があれば互換解析しない', () => {
    expect(invoke({ status: 2, stdout: 'null', stderr: '不明なオプション --describe' }).error).toBeDefined();
  });

  it('旧読取側も新版スクリプトの承認 never 固定を認識できる', () => {
    expect(scriptPinsApprovalNever(fs.readFileSync(fixture('new'), 'utf8'))).toBe(true);
  });

  const runWithReply = (data, overrides = {}) => {
    const spawnFn = vi.fn();
    const written = {};
    const errors = [];
    runReview({ ...options, mode: 'base', baseRef: 'main', baseExplicit: true, noState: true, noPrCheck: true }, {
      cwd: root, env: { CROSS_REVIEW_CODEX_AGENT: '/bridge.sh' },
      platform: 'linux', exists: (p) => p === '/bridge.sh',
      readFile: () => { throw new Error('新経路で本文を読んではいけない'); },
      spawnSync: () => data, spawnFn, reviewRoute: () => null, checklist: '観点', ignorePatterns: [],
      gitRun: (args) => args[0] === 'diff' ? '検証用の差分' : '',
      out: () => {}, err: (m) => errors.push(m),
      tmpdir: path.join(root, '.cross-review'),
      writeFile: (file, body) => { written[file] = body; }, ...overrides,
    });
    return { spawnFn, written, errors };
  };

  it('照会した cwd を実際のレビュアー起動にも渡す', () => {
    const { spawnFn } = runWithReply(reply(response()));
    expect(spawnFn).toHaveBeenCalledWith('bash',
      ['/bridge.sh', 'codex-review', '-C', root], expect.any(String), expect.any(Function), process.env, root);
  });

  it('照会失敗は終了コード 1 で止まり、起動も代替プロンプトも行わない', () => {
    const { spawnFn, written, errors } = runWithReply({ error: { code: 'ETIMEDOUT', message: '時間切れ' } });
    expect(process.exitCode).toBe(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(written).toEqual({});
    expect(errors.join('\n')).toContain('--no-codex-agent');
  });

  it('照会後に定義が消えて終了コード 3 になっても直接起動へ迂回しない', () => {
    const spawnFn = vi.fn((cmd, args, prompt, onExit) => onExit({ code: 3 }));
    runWithReply(reply(response()), { spawnFn });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('無効化の照会結果は終了コード 75 と代替プロンプトを返す', () => {
    const { spawnFn, written } = runWithReply(reply(response({ status: 'disabled', reason: 'codex-disabled' })));
    expect(process.exitCode).toBe(75);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(Object.values(written).join('\n')).toContain('検証用の差分');
  });
});

const bash = resolveReviewerCommandForSpawn('bash');
const bashProbe = spawnSync(bash.cmd, ['--version'], { shell: bash.shell, encoding: 'utf8' });
const bashMissing = bashProbe.error?.code === 'ENOENT' || bashProbe.status === 127 || bashProbe.status === 9009
  || (bashProbe.status === 1 && /bash.*(?:not recognized|認識されていません)/i.test(bashProbe.stderr || ''));

describe.skipIf(bashMissing)('実 bridge と偽 Codex の接続', () => {
  beforeEach(() => {
    if (bashProbe.error) throw bashProbe.error;
    expect(bashProbe.status, bashProbe.stderr).toBe(0);
  });

  function setup(version = 'new') {
    fs.mkdirSync(path.join(root, '.cross-review'), { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, '.cross-review/bridge-test-'));
    scratch.push(dir);
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'project');
    const bin = path.join(dir, 'bin');
    const codexHome = path.join(home, 'codex-home');
    const definitions = path.join(home, '.claude/gpt-agents');
    for (const p of [cwd, bin, codexHome, definitions]) fs.mkdirSync(p, { recursive: true });
    const record = path.join(dir, 'codex.json');
    fs.writeFileSync(path.join(bin, 'codex.cjs'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--output-last-message'); process.exit(0); }
const body = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, codexHome: process.env.CODEX_HOME, body }));
const last = args.indexOf('-o');
if (last >= 0) fs.writeFileSync(args[last + 1], 'レビュー本文: 指摘なし\\n');
console.log('レビュー本文: 指摘なし');
`);
    const slash = (p) => p.replace(/\\/g, '/');
    const quote = (p) => `'${slash(p).replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(bin, 'codex.cjs'))} "$@"\n`, { mode: 0o755 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ![
      'PATH', 'CODEX_HOME', 'CODEX_AGENT_RUN', 'GIT_DIR', 'GIT_WORK_TREE',
    ].includes(k.toUpperCase())));
    Object.assign(env, {
      HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_CODEX_RECORD: record, CROSS_REVIEW_CODEX_AGENT: fixture(version),
      GIT_CEILING_DIRECTORIES: slash(dir),
    });
    const define = (name, sandbox, enabled = true) => {
      fs.writeFileSync(path.join(definitions, `${name}.md`),
        `---\ncodex_home: ${slash(codexHome)}\ncodex_model: fake-model\ncodex_sandbox: ${sandbox}\ncodex_enabled: ${enabled}\n---\nレビューしてください。\n`);
    };
    define('codex-review', 'read-only');
    define('codex-subagent', 'workspace-write');
    const deps = { env, homedir: home, cwd };
    return { dir, home, cwd, record, definitions, codexHome, define, deps };
  }

  it.each([
    ['new', false, 'read-only'], ['new', true, 'workspace-write'], ['old', false, 'read-only'],
  ])('%s bridge を起動し fix=%s の権限と本文を渡す', (version, fix, sandbox) => {
    const ctx = setup(version);
    const inv = reviewerInvocation({ ...options, fix }, ctx.deps);
    expect(inv.error).toBeUndefined();
    expect(inv.via).toBe('agent');
    expect(fs.existsSync(ctx.record)).toBe(false);
    const result = spawnSync(bash.cmd, inv.args, {
      shell: bash.shell, cwd: inv.cwd, env: ctx.deps.env,
      input: '変更内容をレビューしてください。', encoding: 'utf8', timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('レビュー本文: 指摘なし');
    const recorded = JSON.parse(fs.readFileSync(ctx.record, 'utf8'));
    expect(recorded.args).toEqual(expect.arrayContaining(['-c', 'approval_policy=never', '--sandbox', sandbox]));
    expect(recorded.args[recorded.args.indexOf('--sandbox') + 1]).toBe(sandbox);
    expect(recorded.codexHome.replace(/\\/g, '/').toLowerCase()).toBe(ctx.codexHome.replace(/\\/g, '/').toLowerCase());
    expect(recorded.body).toContain('変更内容をレビューしてください。');
  }, 40_000);

  it('無効化された定義は Codex を起動せず終了コード 75 の代替プロンプトへ進む', () => {
    const ctx = setup();
    ctx.define('codex-review', 'read-only', false);
    const spawnFn = vi.fn();
    const written = {};
    runReview({ ...options, mode: 'base', baseRef: 'main', baseExplicit: true, noState: true, noPrCheck: true }, {
      ...ctx.deps, reviewRoute: () => null, checklist: '確認観点',
      ignorePatterns: [],
      gitRun: (args) => args[0] === 'diff' ? '変更差分' : '', spawnFn,
      out: () => {}, err: () => {}, tmpdir: ctx.dir,
      writeFile: (file, body) => { written[file] = body; }, mkdir: () => {},
    });
    expect(process.exitCode).toBe(75);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(Object.values(written).join('\n')).toContain('変更差分');
    expect(fs.existsSync(ctx.record)).toBe(false);
  });

  // 実機の PATH に本物の codex があっても、Codex CLI の無い環境を作るため、codex を含む場所を外す。
  const pathWithoutCodex = () => process.env.PATH.split(path.delimiter).filter((dir) => dir
    && !['codex', 'codex.cmd', 'codex.exe', 'codex.ps1'].some((name) => fs.existsSync(path.join(dir, name))))
    .join(path.delimiter);

  it.each([
    ['codex-disabled', 'codex_model: fake-model\ncodex_enabled: false'],
    ['model-unset', 'codex_model:\ncodex_enabled: true'],
  ])('Codex CLI が無くても、定義で止めた %s は終了コード 75 の代替プロンプトへ進む', (reason, keys) => {
    const ctx = setup();
    ctx.deps.env.PATH = pathWithoutCodex();
    fs.writeFileSync(path.join(ctx.definitions, 'codex-review.md'),
      `---\ncodex_home: ${ctx.codexHome.replace(/\\/g, '/')}\n${keys}\ncodex_sandbox: read-only\n---\nレビューしてください。\n`);
    const spawnFn = vi.fn();
    const written = {};
    runReview({ ...options, mode: 'base', baseRef: 'main', baseExplicit: true, noState: true, noPrCheck: true }, {
      ...ctx.deps, reviewRoute: () => null, checklist: '確認観点',
      ignorePatterns: [],
      gitRun: (args) => args[0] === 'diff' ? '変更差分' : '', spawnFn,
      out: () => {}, err: () => {}, tmpdir: ctx.dir,
      writeFile: (file, body) => { written[file] = body; }, mkdir: () => {},
    });
    expect(process.exitCode).toBe(75);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(Object.values(written).join('\n')).toContain('変更差分');
  });

  it('Codex CLI が無く、定義が有効なら codex-not-found として終了コード 1 で止まる', () => {
    const ctx = setup();
    ctx.deps.env.PATH = pathWithoutCodex();
    const inv = reviewerInvocation(options, ctx.deps);
    expect(inv.error).toContain('codex-not-found');
    expect(inv.exitCode).toBe(1);
  });

  it('定義が無いと直接起動を選ぶ', () => {
    const ctx = setup();
    fs.unlinkSync(path.join(ctx.definitions, 'codex-review.md'));
    expect(reviewerInvocation(options, ctx.deps).via).toBe('direct');
    expect(fs.existsSync(ctx.record)).toBe(false);
  });

  it('プロジェクトの定義を照会の cwd で探索して拒否する', () => {
    const ctx = setup();
    const projectDefinitions = path.join(ctx.cwd, '.claude/gpt-agents');
    fs.mkdirSync(projectDefinitions, { recursive: true });
    fs.writeFileSync(path.join(projectDefinitions, 'codex-review.md'), '---\ncodex_sandbox: workspace-write\n---\n');
    const inv = reviewerInvocation(options, ctx.deps);
    expect(inv.error).toContain('project-override-rejected');
    expect(fs.existsSync(ctx.record)).toBe(false);
  });
});
