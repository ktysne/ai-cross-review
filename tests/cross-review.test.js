// tools/cross-review.js の引数解析・差分コマンド組み立て・プロンプト生成を検証する。
// 実 CLI 起動 (codex/claude) と実 git は外部依存なので、runReview は gitRun / spawnFn を
// 注入して stdin 本文まで検証する。純粋関数と注入可能な配線のみを対象とする。

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  parseArgs,
  codexExecArgs,
  reviewerInvocation,
  resolveCodexAgentScript,
  codexAgentNameFor,
  frontMatterValue,
  codexAgentSandboxOf,
  checkCodexAgentSandbox,
  scriptPinsApprovalNever,
  isUsageLimitExit,
  resolveFallbackPromptPath,
  collectReviewDiff,
  resolveBaseRef,
  resolveMaxDiffKb,
  resolveMaxFileDiffKb,
  summarizeLargeFileDiffs,
  buildReviewPrompt,
  runReview,
  loadChecklist,
  loadInstructions,
  loadIgnorePatterns,
  toExcludePathspecs,
  resolveReviewerCommandForSpawn,
  CHECKLIST_FILENAME,
  IGNORE_FILENAME,
  CODEX_AGENT_REVIEW_NAME,
  CODEX_AGENT_FIX_NAME,
  CODEX_AGENT_EXIT_MISSING,
  CODEX_SANDBOX_READ_ONLY,
  CODEX_SANDBOX_WORKSPACE_WRITE,
  USAGE_LIMIT_EXIT_CODE,
  DEFAULT_EXCLUDE_PATTERNS,
  GENERIC_CHECKLIST,
  REVIEW_ONLY_INSTRUCTION,
  FIX_INSTRUCTION,
  REVIEWER_NOTES_HEADER,
  DISMISSED_HEADER,
  resolveBaseSelection,
  shrinkDiffToFit,
  normalizeState,
  branchStateOf,
  nextState,
  withDismissed,
  withoutBranch,
  readState,
  writeState,
  currentBranchName,
  currentHeadSha,
  isNoFetch,
  buildDismissedSection,
  joinReviewerNotes,
  runStateCommand,
  runDismissCommand,
  STATE_FILENAME,
} = require('../tools/cross-review.js');

// 実行環境の状態ファイル (.cross-review-state.json) と gh CLI に依存しないためのスタブ。
// runReview の deps へ展開して使う。状態は「空・壊れていない」、gh は「PR 無し」を返す。
const isolated = (overrides = {}) => ({
  readState: () => ({ path: '<test-state>', state: { branches: {} }, corrupt: false }),
  writeState: () => true,
  ghRun: () => null,
  ...overrides,
});

// 状態ファイルの読み書きをメモリ上で行うスタブ。書かれた内容を後から検証できる。
const memoryState = (initial = { branches: {} }, opts = {}) => {
  const store = { state: initial, writes: [], corrupt: !!opts.corrupt };
  return {
    store,
    readState: () => ({ path: '<test-state>', state: store.state, corrupt: store.corrupt }),
    writeState: (next) => { store.writes.push(next); store.state = next; return true; },
    ghRun: () => null,
  };
};

describe('cross-review parseArgs', () => {
  it('codex を既定スコープ (base=main) で解釈する', () => {
    expect(parseArgs(['codex'])).toMatchObject({
      reviewer: 'codex',
      mode: 'base',
      baseRef: 'main',
      fix: false,
      error: null,
    });
  });

  it('--uncommitted で mode が切り替わる', () => {
    expect(parseArgs(['claude', '--uncommitted'])).toMatchObject({
      reviewer: 'claude',
      mode: 'uncommitted',
    });
  });

  it('--fix は codex のとき fix:true になる', () => {
    expect(parseArgs(['codex', '--fix'])).toMatchObject({
      reviewer: 'codex',
      fix: true,
      error: null,
    });
  });

  it('--fix を claude に付けるとエラー (claude CLI 経路の自動修正は未対応)', () => {
    expect(parseArgs(['claude', '--fix']).error).toMatch(/--fix/);
  });

  it('subagent を受け付ける (リモートコントロール用のプロンプト出力経路)', () => {
    expect(parseArgs(['subagent'])).toMatchObject({
      reviewer: 'subagent',
      mode: 'base',
      baseRef: 'main',
      fix: false,
      error: null,
    });
  });

  it('subagent --fix は許可される (--fix は codex か subagent のみ)', () => {
    expect(parseArgs(['subagent', '--fix'])).toMatchObject({
      reviewer: 'subagent',
      fix: true,
      error: null,
    });
  });

  it('--base / --base= でベースブランチを上書きする', () => {
    expect(parseArgs(['codex', '--base', 'develop'])).toMatchObject({ baseRef: 'develop' });
    expect(parseArgs(['codex', '--base=release'])).toMatchObject({ baseRef: 'release' });
  });

  it('--base に値が無ければエラー', () => {
    expect(parseArgs(['codex', '--base']).error).toMatch(/--base/);
  });

  it('--base 指定で baseExplicit=true、未指定で false', () => {
    expect(parseArgs(['codex']).baseExplicit).toBe(false);
    expect(parseArgs(['codex', '--base', 'develop']).baseExplicit).toBe(true);
    expect(parseArgs(['codex', '--base=release']).baseExplicit).toBe(true);
  });

  it('--max-diff-kb / --max-diff-kb= で閾値を取り込む (0 も有効)', () => {
    expect(parseArgs(['codex', '--max-diff-kb', '512']).maxDiffKb).toBe(512);
    expect(parseArgs(['codex', '--max-diff-kb=0']).maxDiffKb).toBe(0);
    expect(parseArgs(['codex']).maxDiffKb).toBeNull();
  });

  it('--max-diff-kb の不正値 (負数・非数値・空) はエラー', () => {
    expect(parseArgs(['codex', '--max-diff-kb', '-1']).error).toMatch(/--max-diff-kb/);
    expect(parseArgs(['codex', '--max-diff-kb', 'abc']).error).toMatch(/--max-diff-kb/);
    expect(parseArgs(['codex', '--max-diff-kb=1.5']).error).toMatch(/--max-diff-kb/);
    expect(parseArgs(['codex', '--max-diff-kb=']).error).toMatch(/--max-diff-kb/);
    expect(parseArgs(['codex', '--max-diff-kb']).error).toMatch(/--max-diff-kb/);
  });

  it('--no-exclude で noExclude:true になる (既定は false)', () => {
    expect(parseArgs(['codex']).noExclude).toBe(false);
    expect(parseArgs(['codex', '--no-exclude']).noExclude).toBe(true);
  });

  it('--max-file-diff-kb / --max-file-diff-kb= で閾値を取り込む (0 も有効)', () => {
    expect(parseArgs(['codex', '--max-file-diff-kb', '128']).maxFileDiffKb).toBe(128);
    expect(parseArgs(['codex', '--max-file-diff-kb=0']).maxFileDiffKb).toBe(0);
    expect(parseArgs(['codex']).maxFileDiffKb).toBeNull();
  });

  it('--max-file-diff-kb の不正値 (負数・非数値・空) はエラー', () => {
    expect(parseArgs(['codex', '--max-file-diff-kb', '-1']).error).toMatch(/--max-file-diff-kb/);
    expect(parseArgs(['codex', '--max-file-diff-kb', 'abc']).error).toMatch(/--max-file-diff-kb/);
    expect(parseArgs(['codex', '--max-file-diff-kb=2.5']).error).toMatch(/--max-file-diff-kb/);
    expect(parseArgs(['codex', '--max-file-diff-kb=']).error).toMatch(/--max-file-diff-kb/);
    expect(parseArgs(['codex', '--max-file-diff-kb']).error).toMatch(/--max-file-diff-kb/);
  });

  it('--instructions <path> / --instructions=path で申し送りファイルを取り込む', () => {
    expect(parseArgs(['codex', '--fix', '--instructions', 'notes.md'])).toMatchObject({
      reviewer: 'codex',
      fix: true,
      instructionsPath: 'notes.md',
      error: null,
    });
    expect(parseArgs(['codex', '--instructions=../notes.md'])).toMatchObject({
      instructionsPath: '../notes.md',
    });
  });

  it('--instructions に値が無ければエラー (--instructions= 空値も含む)', () => {
    expect(parseArgs(['codex', '--instructions']).error).toMatch(/--instructions/);
    expect(parseArgs(['codex', '--instructions', '--fix']).error).toMatch(/--instructions/);
    expect(parseArgs(['codex', '--instructions=']).error).toMatch(/--instructions/);
    expect(parseArgs(['codex', '--instructions=']).instructionsPath).toBeNull();
  });

  it('既定では instructionsPath は null', () => {
    expect(parseArgs(['codex']).instructionsPath).toBeNull();
  });

  it('--no-codex-agent / --no-fallback を取り込む (既定は bridge 有効・フォールバック有効)', () => {
    const def = parseArgs(['codex']);
    expect(def.codexAgent).toBeNull();
    expect(def.noFallback).toBe(false);
    expect(def.fallbackPromptPath).toBeNull();
    const off = parseArgs(['codex', '--no-codex-agent', '--no-fallback']);
    expect(off.codexAgent).toBe(false);
    expect(off.noFallback).toBe(true);
  });

  it('--codex-agent <name> / --codex-agent=name で定義名を取り込む', () => {
    expect(parseArgs(['codex', '--codex-agent', 'my-agent']).codexAgent).toBe('my-agent');
    expect(parseArgs(['codex', '--codex-agent=my-agent']).codexAgent).toBe('my-agent');
  });

  it('--codex-agent に値が無ければエラー (--codex-agent= 空値も含む)', () => {
    expect(parseArgs(['codex', '--codex-agent']).error).toMatch(/--codex-agent/);
    expect(parseArgs(['codex', '--codex-agent', '--fix']).error).toMatch(/--codex-agent/);
    expect(parseArgs(['codex', '--codex-agent=']).error).toMatch(/--codex-agent/);
  });

  // bridge 経由のサンドボックスは定義側で決まるので、--fix と定義名の食い違いは起動前に弾く。
  it('--codex-agent codex-review と --fix の併用はエラー (read-only 定義では修正できない)', () => {
    const opts = parseArgs(['codex', '--fix', '--codex-agent', CODEX_AGENT_REVIEW_NAME]);
    expect(opts.error).toMatch(/codex-review/);
  });

  it('--codex-agent codex-subagent を --fix 無しで使うとエラー (書込権限が過剰)', () => {
    const opts = parseArgs(['codex', '--codex-agent', CODEX_AGENT_FIX_NAME]);
    expect(opts.error).toMatch(/codex-subagent/);
  });

  it('既知の 2 定義以外の名前は --fix の有無で弾かない', () => {
    expect(parseArgs(['codex', '--codex-agent', 'my-agent']).error).toBeNull();
    expect(parseArgs(['codex', '--fix', '--codex-agent', 'my-agent']).error).toBeNull();
  });

  it('--fallback-prompt <path> / --fallback-prompt=path を取り込む', () => {
    expect(parseArgs(['codex', '--fallback-prompt', 'out.md']).fallbackPromptPath).toBe('out.md');
    expect(parseArgs(['codex', '--fallback-prompt=out.md']).fallbackPromptPath).toBe('out.md');
    expect(parseArgs(['codex', '--fallback-prompt']).error).toMatch(/--fallback-prompt/);
    expect(parseArgs(['codex', '--fallback-prompt=']).error).toMatch(/--fallback-prompt/);
  });

  it('未知のレビュアーはエラー', () => {
    expect(parseArgs(['gemini']).error).toMatch(/codex/);
    expect(parseArgs([]).error).toMatch(/codex/);
  });

  it('不明なオプションはエラー', () => {
    expect(parseArgs(['codex', '--bogus']).error).toMatch(/不明なオプション/);
  });

  it('--no-state / --strict-diff-guard を取り込む (既定はどちらも false)', () => {
    const d = parseArgs(['codex']);
    expect(d.noState).toBe(false);
    expect(d.strictDiffGuard).toBe(false);
    const o = parseArgs(['codex', '--no-state', '--strict-diff-guard']);
    expect(o.noState).toBe(true);
    expect(o.strictDiffGuard).toBe(true);
    expect(o.error).toBeNull();
  });

  it('state / dismiss サブコマンドを受け付ける (レビュアーは決めない)', () => {
    const s = parseArgs(['state']);
    expect(s.command).toBe('state');
    expect(s.reviewer).toBeNull();
    expect(s.error).toBeNull();
    const r = parseArgs(['state', '--reset']);
    expect(r.reset).toBe(true);
    expect(r.error).toBeNull();
    const d = parseArgs(['dismiss', '運用上到達しない入力への指摘']);
    expect(d.command).toBe('dismiss');
    expect(d.dismissText).toBe('運用上到達しない入力への指摘');
    expect(d.error).toBeNull();
  });

  it('dismiss は引用符を付け忘れた複数語も 1 件の要約として受ける', () => {
    expect(parseArgs(['dismiss', 'A', 'の', '指摘']).dismissText).toBe('A の 指摘');
  });

  it('dismiss に要約が無ければエラー', () => {
    expect(parseArgs(['dismiss']).error).toMatch(/要約が必要/);
  });

  it('--reset は state サブコマンドでのみ使える', () => {
    expect(parseArgs(['codex', '--reset']).error).toMatch(/--reset は state/);
    expect(parseArgs(['dismiss', 'A', '--reset']).error).toMatch(/--reset は state/);
  });

  it('state --mark を受け付け、他のサブコマンドでは使えない', () => {
    const m = parseArgs(['state', '--mark']);
    expect(m.command).toBe('state');
    expect(m.mark).toBe(true);
    expect(m.error).toBeNull();
    expect(parseArgs(['codex', '--mark']).error).toMatch(/--mark は state/);
    expect(parseArgs(['dismiss', 'A', '--mark']).error).toMatch(/--mark は state/);
  });

  it('--reset と --mark は併用できない (記録の消去と往復の記録は相反する)', () => {
    expect(parseArgs(['state', '--reset', '--mark']).error).toMatch(/--reset と --mark/);
  });

  it('--no-state と state / dismiss サブコマンドは併用できない', () => {
    expect(parseArgs(['state', '--no-state']).error).toMatch(/--no-state/);
    expect(parseArgs(['state', '--mark', '--no-state']).error).toMatch(/--no-state/);
    expect(parseArgs(['dismiss', 'A', '--no-state']).error).toMatch(/--no-state/);
  });

  it('レビュアー実行の既定 command は review', () => {
    expect(parseArgs(['codex']).command).toBe('review');
  });

  it('--help はヘルプ要求として扱う (エラーにしない)', () => {
    const out = parseArgs(['--help']);
    expect(out.help).toBe(true);
    expect(out.error).toBeNull();
  });
});

describe('cross-review codexExecArgs', () => {
  it('レビューのみは read-only + 承認 never + stdin(-) で起動する', () => {
    expect(codexExecArgs({ fix: false }))
      .toEqual(['exec', '-s', 'read-only', '-c', 'approval_policy=never', '-']);
  });

  it('--fix は workspace-write で起動し作業ツリーを編集可能にする', () => {
    expect(codexExecArgs({ fix: true }))
      .toEqual(['exec', '-s', 'workspace-write', '-c', 'approval_policy=never', '-']);
  });

  it('承認は never に固定する (非対話自走が承認待ちで止まらない)', () => {
    expect(codexExecArgs({ fix: false })).toContain('approval_policy=never');
    expect(codexExecArgs({ fix: true })).toContain('approval_policy=never');
  });
});

describe('cross-review reviewerInvocation', () => {
  // codex 経路は codex-agent.sh (bridge) の有無で分岐するので、直接起動を見るテストでは
  // 実行環境に左右されないよう exists:false を注入して bridge 不在を固定する。
  const noBridge = { exists: () => false, env: {}, homedir: '/home/u' };

  it('codex レビューのみは codex を read-only で起動する', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, noBridge);
    expect(inv.cmd).toBe('codex');
    expect(inv.args).toEqual(['exec', '-s', 'read-only', '-c', 'approval_policy=never', '-']);
    expect(inv.via).toBe('direct');
  });

  it('codex --fix は workspace-write で起動し、編集する旨を通知する', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: true }, noBridge);
    expect(inv.cmd).toBe('codex');
    expect(inv.args).toEqual(['exec', '-s', 'workspace-write', '-c', 'approval_policy=never', '-']);
    expect(inv.notice).toMatch(/修正/);
    expect(inv.via).toBe('direct');
  });

  it('claude は claude -p で起動する', () => {
    const inv = reviewerInvocation({ reviewer: 'claude', fix: false });
    expect(inv.cmd).toBe('claude');
    expect(inv.args).toEqual(['-p']);
  });

  it('subagent は外部 CLI を起動せず emit:true を返す (プロンプトを stdout に出すだけ)', () => {
    const inv = reviewerInvocation({ reviewer: 'subagent', fix: false });
    expect(inv.emit).toBe(true);
    expect(inv.cmd).toBeUndefined();
    expect(inv.notice).toMatch(/サブエージェント/);
  });

  it('subagent --fix も emit:true (修正プロンプトを出す旨を通知)', () => {
    const inv = reviewerInvocation({ reviewer: 'subagent', fix: true });
    expect(inv.emit).toBe(true);
    expect(inv.notice).toMatch(/修正/);
  });
});

describe('cross-review resolveCodexAgentScript (bridge の解決順)', () => {
  const defaultPath = path.join('/home/u', '.claude', 'tools', 'codex-agent.sh');

  it('環境変数 CROSS_REVIEW_CODEX_AGENT のパスを最優先する', () => {
    const script = resolveCodexAgentScript({
      env: { CROSS_REVIEW_CODEX_AGENT: '/opt/bridge/codex-agent.sh' },
      homedir: '/home/u',
      exists: () => true,
      warn: () => {},
    });
    expect(script).toBe('/opt/bridge/codex-agent.sh');
  });

  it('環境変数が無ければ ~/.claude/tools/codex-agent.sh を使う', () => {
    const script = resolveCodexAgentScript({
      env: {},
      homedir: '/home/u',
      exists: (p) => p === defaultPath,
      warn: () => {},
    });
    expect(script).toBe(defaultPath);
  });

  it('どこにも無ければ null (呼び出し側は直接起動へ)', () => {
    const script = resolveCodexAgentScript({
      env: {},
      homedir: '/home/u',
      exists: () => false,
      warn: () => {},
    });
    expect(script).toBeNull();
  });

  it('環境変数の指定先が無ければ警告して既定パスへフォールバックする', () => {
    let warned = '';
    const script = resolveCodexAgentScript({
      env: { CROSS_REVIEW_CODEX_AGENT: '/nope/codex-agent.sh' },
      homedir: '/home/u',
      exists: (p) => p === defaultPath,
      warn: (m) => { warned += m; },
    });
    expect(script).toBe(defaultPath);
    expect(warned).toMatch(/CROSS_REVIEW_CODEX_AGENT/);
  });
});

describe('cross-review reviewerInvocation (bridge 経由の codex 起動)', () => {
  const scriptPath = path.join('/home/u', '.claude', 'tools', 'codex-agent.sh');
  // bridge 経由はスクリプトが approval_policy=never を明示している場合に限るので、
  // 既定の擬似スクリプトには明示済みの本文を入れる。
  const scriptText = 'codex exec --sandbox "$codex_sandbox" -c approval_policy=never -\n';
  const defPath = (name) => path.join('/home/u', '.claude', 'gpt-agents', `${name}.md`);
  const defText = (sandbox) => `---\ncodex_home: ~/.codex\ncodex_model: gpt-5.6-sol\ncodex_sandbox: ${sandbox}\n---\n\n役割\n`;
  // 擬似ファイル系を注入する。ここに無いパスは「存在しない」扱いにする。
  const bridge = (extra = {}) => {
    const files = { [scriptPath]: scriptText, ...(extra.files || {}) };
    const rest = { ...extra };
    delete rest.files;
    return {
      env: {},
      homedir: '/home/u',
      cwd: '/repo',
      warn: () => {},
      exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
      readFile: (p) => {
        if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      ...rest,
    };
  };

  it('スクリプトがあれば bash 経由で起動し、レビューのみは read-only 定義を選ぶ', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, bridge());
    expect(inv.cmd).toBe('bash');
    expect(inv.args).toEqual([scriptPath, 'codex-review', '-C', '/repo']);
    expect(inv.via).toBe('agent');
    expect(inv.notice).toContain('codex-agent.sh 経由 (定義: codex-review)');
  });

  it('--fix は workspace-write 定義 (codex-subagent) を選ぶ', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: true }, bridge());
    expect(inv.args).toEqual([scriptPath, 'codex-subagent', '-C', '/repo']);
    expect(inv.notice).toContain('定義: codex-subagent');
  });

  // サンドボックス安全性の不変条件: bridge 経由では定義名がサンドボックスを決めるため、
  // レビューのみで workspace-write の定義を、--fix で read-only の定義を選ばない。
  it('レビューのみは workspace-write の定義を選ばない', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, bridge());
    expect(inv.args).not.toContain(CODEX_AGENT_FIX_NAME);
    expect(inv.args).toContain(CODEX_AGENT_REVIEW_NAME);
  });

  it('--fix は read-only の定義を選ばない', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: true }, bridge());
    expect(inv.args).not.toContain(CODEX_AGENT_REVIEW_NAME);
    expect(inv.args).toContain(CODEX_AGENT_FIX_NAME);
  });

  it('--codex-agent <name> で定義名を明示できる', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false, codexAgent: 'my-reviewer' }, bridge());
    expect(inv.args).toEqual([scriptPath, 'my-reviewer', '-C', '/repo']);
  });

  it('--no-codex-agent (codexAgent:false) はスクリプトがあっても直接起動する', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false, codexAgent: false }, bridge());
    expect(inv.cmd).toBe('codex');
    expect(inv.via).toBe('direct');
    expect(inv.args).toEqual(['exec', '-s', 'read-only', '-c', 'approval_policy=never', '-']);
  });

  it('スクリプトが無ければ従来どおり codex を直接起動する', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: true }, bridge({ exists: () => false }));
    expect(inv.cmd).toBe('codex');
    expect(inv.via).toBe('direct');
    expect(inv.args).toContain('workspace-write');
  });

  // 承認は never 固定という不変条件。bridge は codex への追加引数を受け付けないので、
  // スクリプトが明示していなければ bridge を使わない。
  it('スクリプトが approval_policy=never を明示していなければ直接起動へ戻す', () => {
    let warned = '';
    const inv = reviewerInvocation(
      { reviewer: 'codex', fix: false },
      bridge({ files: { [scriptPath]: 'codex exec --sandbox "$codex_sandbox" -\n' }, warn: (m) => { warned += m; } }),
    );
    expect(inv.cmd).toBe('codex');
    expect(inv.via).toBe('direct');
    expect(inv.args).toEqual(['exec', '-s', 'read-only', '-c', 'approval_policy=never', '-']);
    expect(warned).toMatch(/approval_policy=never/);
  });

  it('--codex-agent で明示していても approval_policy=never が無ければ直接起動へ戻す', () => {
    const inv = reviewerInvocation(
      { reviewer: 'codex', fix: false, codexAgent: 'my-reviewer' },
      bridge({ files: { [scriptPath]: 'codex exec -\n' } }),
    );
    expect(inv.via).toBe('direct');
  });

  it('スクリプトを読めない場合も直接起動へ戻す', () => {
    let warned = '';
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, bridge({
      exists: () => true,
      readFile: () => { throw new Error('EACCES'); },
      warn: (m) => { warned += m; },
    }));
    expect(inv.via).toBe('direct');
    expect(warned).toMatch(/読めない/);
  });

  // サンドボックス安全性の不変条件。定義ファイルの中身は利用者が変えられるので、
  // 定義名が既定でも明示でも起動前に codex_sandbox を突き合わせる。
  it('レビューのみで workspace-write の定義ならエラーを返す (起動しない)', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, bridge({
      files: { [defPath(CODEX_AGENT_REVIEW_NAME)]: defText('workspace-write') },
    }));
    expect(inv.error).toMatch(/codex_sandbox/);
    expect(inv.cmd).toBeUndefined();
  });

  it('--fix で read-only の定義ならエラーを返す (起動しない)', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: true }, bridge({
      files: { [defPath(CODEX_AGENT_FIX_NAME)]: defText('read-only') },
    }));
    expect(inv.error).toMatch(/codex_sandbox/);
  });

  it('--codex-agent で指定した未知の定義にも codex_sandbox の検査が効く', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false, codexAgent: 'my-writer' }, bridge({
      files: { [defPath('my-writer')]: defText('workspace-write') },
    }));
    expect(inv.error).toMatch(/my-writer/);
  });

  it('定義が --fix の有無と一致していれば bridge 経由で起動する', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, bridge({
      files: { [defPath(CODEX_AGENT_REVIEW_NAME)]: defText('read-only') },
    }));
    expect(inv.error).toBeUndefined();
    expect(inv.args).toEqual([scriptPath, CODEX_AGENT_REVIEW_NAME, '-C', '/repo']);
  });

  it('定義ファイルが見つからなければ検査せず bridge に委ねる', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, bridge());
    expect(inv.error).toBeUndefined();
    expect(inv.via).toBe('agent');
  });

  it('定義が存在するのに読めなければエラーを返し、ホーム側の検証にも起動にも進まない', () => {
    const projectDef = path.join('/repo', '.claude', 'gpt-agents', `${CODEX_AGENT_REVIEW_NAME}.md`);
    const deps = bridge({
      files: {
        [projectDef]: defText('read-only'),
        [defPath(CODEX_AGENT_REVIEW_NAME)]: defText('read-only'),
      },
    });
    const readFile = deps.readFile;
    deps.readFile = (p) => {
      if (p === projectDef) throw new Error('EACCES');
      return readFile(p);
    };
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, deps);
    expect(inv.error).toMatch(/読めない/);
    expect(inv.error).toMatch(/EACCES/);
    expect(inv.cmd).toBeUndefined();
  });

  it('定義はプロジェクト側 (cwd) をユーザ側 (home) より優先する', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false }, bridge({
      files: {
        [path.join('/repo', '.claude', 'gpt-agents', `${CODEX_AGENT_REVIEW_NAME}.md`)]: defText('workspace-write'),
        [defPath(CODEX_AGENT_REVIEW_NAME)]: defText('read-only'),
      },
    }));
    expect(inv.error).toMatch(/codex_sandbox/);
  });
});

describe('cross-review checkCodexAgentSandbox', () => {
  it('レビューのみ (--fix 無し) は read-only だけを許す', () => {
    expect(checkCodexAgentSandbox({ fix: false, sandbox: CODEX_SANDBOX_READ_ONLY }).ok).toBe(true);
    const ng = checkCodexAgentSandbox({ fix: false, sandbox: CODEX_SANDBOX_WORKSPACE_WRITE });
    expect(ng.ok).toBe(false);
    expect(ng.expected).toBe(CODEX_SANDBOX_READ_ONLY);
    expect(ng.actual).toBe(CODEX_SANDBOX_WORKSPACE_WRITE);
  });

  it('--fix は workspace-write だけを許す', () => {
    expect(checkCodexAgentSandbox({ fix: true, sandbox: CODEX_SANDBOX_WORKSPACE_WRITE }).ok).toBe(true);
    const ng = checkCodexAgentSandbox({ fix: true, sandbox: CODEX_SANDBOX_READ_ONLY });
    expect(ng.ok).toBe(false);
    expect(ng.expected).toBe(CODEX_SANDBOX_WORKSPACE_WRITE);
  });
});

// フロントマターの解釈は codex-agent.sh の fm_get と揃える (ずれると検査が実態と食い違う)。
describe('cross-review codexAgentSandboxOf / frontMatterValue', () => {
  const withFm = (body) => `---\n${body}\n---\n\n役割\n`;

  it('行末の YAML コメントを落とす', () => {
    expect(codexAgentSandboxOf(withFm('codex_sandbox: workspace-write  # 書き込み可'))).toBe('workspace-write');
  });

  it('値を囲む引用符を外す', () => {
    expect(codexAgentSandboxOf(withFm('codex_sandbox: "read-only"'))).toBe('read-only');
  });

  it('値の内部の # は残す (コメントは「空白 + #」以降だけ)', () => {
    expect(frontMatterValue(withFm('codex_model: gpt#5'), 'codex_model')).toBe('gpt#5');
  });

  it('キーが無ければ既定の read-only', () => {
    expect(codexAgentSandboxOf(withFm('codex_model: gpt-5.6-sol'))).toBe('read-only');
    expect(frontMatterValue(withFm('codex_model: gpt-5.6-sol'), 'codex_sandbox')).toBeNull();
  });

  it('フロントマターが無ければ既定の read-only', () => {
    expect(codexAgentSandboxOf('codex_sandbox: workspace-write\n')).toBe('read-only');
    expect(frontMatterValue('codex_sandbox: workspace-write\n', 'codex_sandbox')).toBeNull();
  });

  it('終端の --- より後ろの行は読まない', () => {
    expect(codexAgentSandboxOf(withFm('codex_model: gpt-5.6-sol') + 'codex_sandbox: workspace-write\n')).toBe('read-only');
  });
});

describe('cross-review scriptPinsApprovalNever', () => {
  it('approval_policy=never を含めば true', () => {
    expect(scriptPinsApprovalNever('codex exec -c approval_policy=never -\n')).toBe(true);
  });

  it('含まなければ false (空・未定義も false)', () => {
    expect(scriptPinsApprovalNever('codex exec -\n')).toBe(false);
    expect(scriptPinsApprovalNever('')).toBe(false);
    expect(scriptPinsApprovalNever(undefined)).toBe(false);
  });

  it('コメント行にだけ書かれていても false (起動引数に乗らない)', () => {
    expect(scriptPinsApprovalNever('# TODO: -c approval_policy=never\ncodex exec -\n')).toBe(false);
    expect(scriptPinsApprovalNever('  # -c approval_policy=never を後で足す\ncodex exec -\n')).toBe(false);
  });

  it('-c の引数として書かれていなければ false、引用符付きや行継続の -c 引数は true', () => {
    expect(scriptPinsApprovalNever('echo approval_policy=never\ncodex exec -\n')).toBe(false);
    expect(scriptPinsApprovalNever('codex exec -c "approval_policy=never" -\n')).toBe(true);
    expect(scriptPinsApprovalNever("codex exec \\\n  -c 'approval_policy=never' \\\n  -\n")).toBe(true);
  });

  it('codex exec 以外のコマンドの引数や、行末コメントに書かれていても false', () => {
    expect(scriptPinsApprovalNever('echo -c approval_policy=never\ncodex exec -\n')).toBe(false);
    expect(scriptPinsApprovalNever('codex exec - # TODO: -c approval_policy=never\n')).toBe(false);
    expect(scriptPinsApprovalNever('codex exec \\\n  - # -c approval_policy=never\n')).toBe(false);
  });

  it('実物の codex-agent.sh と同じ形 (環境変数の前置、継続行、変数展開の引数) は true', () => {
    const real = [
      'CODEX_HOME="$codex_home" codex exec \\',
      '  --skip-git-repo-check \\',
      '  --sandbox "$codex_sandbox" \\',
      '  -m "$codex_model" \\',
      '  -c "model_reasoning_effort=\\"$codex_effort\\"" \\',
      '  -c approval_policy=never \\',
      '  -C "$workdir" \\',
      '  - <<<"$prompt" >"$out_file" 2>"$err_file"',
      '',
    ].join('\n');
    expect(scriptPinsApprovalNever(real)).toBe(true);
  });
});

describe('cross-review codexAgentNameFor', () => {
  it('明示指定が無ければ --fix の有無で定義名を選ぶ', () => {
    expect(codexAgentNameFor({ fix: false })).toBe(CODEX_AGENT_REVIEW_NAME);
    expect(codexAgentNameFor({ fix: true })).toBe(CODEX_AGENT_FIX_NAME);
  });

  it('明示指定があればそれを使う', () => {
    expect(codexAgentNameFor({ fix: false, codexAgent: 'other' })).toBe('other');
  });
});

describe('cross-review isUsageLimitExit', () => {
  it('bridge 経由は終了コード 75 だけを上限と判定する', () => {
    expect(isUsageLimitExit({ via: 'agent', code: 75, outputTail: '' })).toBe(true);
    expect(isUsageLimitExit({ via: 'agent', code: 1, outputTail: 'usage limit reached' })).toBe(false);
    expect(isUsageLimitExit({ via: 'agent', code: 0, outputTail: '' })).toBe(false);
  });

  it('直接起動は非ゼロ終了かつ出力に上限の語があるときだけ上限と判定する', () => {
    expect(isUsageLimitExit({ via: 'direct', code: 1, outputTail: 'You have hit your usage limit.' })).toBe(true);
    expect(isUsageLimitExit({ via: 'direct', code: 1, outputTail: 'Rate Limit exceeded' })).toBe(true);
    expect(isUsageLimitExit({ via: 'direct', code: 1, outputTail: 'HTTP 429 Too Many Requests' })).toBe(true);
    expect(isUsageLimitExit({ via: 'direct', code: 1, outputTail: 'syntax error' })).toBe(false);
  });

  it('正常終了とシグナル終了は上限として扱わない', () => {
    expect(isUsageLimitExit({ via: 'direct', code: 0, outputTail: 'usage limit' })).toBe(false);
    expect(isUsageLimitExit({ via: 'direct', code: null, outputTail: 'usage limit' })).toBe(false);
  });

  it('429 は単語境界で照合する (桁の一致で誤検出しない)', () => {
    expect(isUsageLimitExit({ via: 'direct', code: 1, outputTail: 'id=14290 failed' })).toBe(false);
  });
});

describe('cross-review resolveFallbackPromptPath', () => {
  it('--fallback-prompt を最優先する', () => {
    expect(resolveFallbackPromptPath({ fallbackPromptPath: 'notes.md' }, { tmpdir: '/tmp', pid: 1 }))
      .toBe('notes.md');
  });

  it('未指定なら一時ディレクトリに pid 付きの名前を作る', () => {
    expect(resolveFallbackPromptPath({}, { tmpdir: '/tmp', pid: 42 }))
      .toBe(path.join('/tmp', 'cross-review-fallback-42.md'));
  });
});

describe('cross-review resolveReviewerCommandForSpawn', () => {
  it('Windows では where.exe 候補から .exe を優先し shell:false にする', () => {
    const resolved = resolveReviewerCommandForSpawn('claude', {
      platform: 'win32',
      lookup: () => [
        'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
        'C:\\Users\\me\\.local\\bin\\claude.exe',
      ],
    });

    expect(resolved).toEqual({
      cmd: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      shell: false,
    });
  });

  it('Windows で .exe が無ければ .cmd shim を shell:true で使う', () => {
    const resolved = resolveReviewerCommandForSpawn('codex', {
      platform: 'win32',
      lookup: () => ['C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd'],
    });

    expect(resolved).toEqual({
      cmd: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
      shell: true,
    });
  });

  it('Windows で lookup 候補が空ならコマンド名を shell:true で使う', () => {
    const resolved = resolveReviewerCommandForSpawn('claude', {
      platform: 'win32',
      lookup: () => [],
    });

    expect(resolved).toEqual({
      cmd: 'claude',
      shell: true,
    });
  });

  it('Windows で .ps1 しか見つからない場合は shell:true で候補を使う', () => {
    const resolved = resolveReviewerCommandForSpawn('codex', {
      platform: 'win32',
      lookup: () => ['C:\\Users\\me\\AppData\\Roaming\\npm\\codex.ps1'],
    });

    expect(resolved).toEqual({
      cmd: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.ps1',
      shell: true,
    });
  });

  it('非 Windows では PATH 解決をせず shell:false のまま使う', () => {
    const resolved = resolveReviewerCommandForSpawn('claude', {
      platform: 'linux',
      lookup: () => { throw new Error('呼ばれないはず'); },
    });

    expect(resolved).toEqual({ cmd: 'claude', shell: false });
  });
});

describe('cross-review collectReviewDiff', () => {
  it('base モードは <ref>...HEAD の差分を返す', () => {
    const calls = [];
    const fakeGit = (args) => {
      calls.push(args);
      return 'BASE_DIFF\n';
    };
    const out = collectReviewDiff({ mode: 'base', baseRef: 'main' }, fakeGit);
    expect(calls[0]).toEqual(['diff', 'main...HEAD']);
    expect(out.diffText).toBe('BASE_DIFF');
    expect(out.excludedFiles).toEqual([]);
  });

  it('uncommitted モードは tracked 差分に untracked 新規ファイルも含める', () => {
    const fakeGit = (args) => {
      if (args[0] === 'diff' && args[1] === 'HEAD') return 'TRACKED_DIFF\n';
      if (args[0] === 'ls-files') {
        expect(args).toEqual(['ls-files', '--others', '--exclude-standard', '-z']);
        return 'new-a.js\0new dir/new-b.txt\0';
      }
      if (args[0] === 'diff' && args[2] === '--' && args[3] === '/dev/null') {
        return `NEWFILE_DIFF(${args[4]})\n`;
      }
      return '';
    };
    const out = collectReviewDiff({ mode: 'uncommitted' }, fakeGit).diffText;
    expect(out).toContain('TRACKED_DIFF');
    expect(out).toContain('NEWFILE_DIFF(new-a.js)');
    expect(out).toContain('NEWFILE_DIFF(new dir/new-b.txt)');
  });

  it('uncommitted で untracked が無ければ tracked 差分のみ', () => {
    const fakeGit = (args) => {
      if (args[0] === 'diff' && args[1] === 'HEAD') return 'TRACKED_ONLY\n';
      if (args[0] === 'ls-files') return '';
      return '';
    };
    expect(collectReviewDiff({ mode: 'uncommitted' }, fakeGit).diffText).toBe('TRACKED_ONLY');
  });

  it('uncommitted で --instructions の申し送りファイルは untracked 差分から除外する', () => {
    const fakeGit = (args) => {
      if (args[0] === 'diff' && args[1] === 'HEAD') return '';
      if (args[0] === 'ls-files') return 'review-notes.md\0real-new.js\0';
      if (args[0] === 'diff' && args[3] === '/dev/null') return `NEWFILE(${args[4]})\n`;
      return '';
    };
    // instructionsPath と untracked 候補は同一相対パス文字列なので path.resolve 後も一致し、除外される。
    const out = collectReviewDiff({ mode: 'uncommitted', instructionsPath: 'review-notes.md' }, fakeGit).diffText;
    expect(out).toContain('NEWFILE(real-new.js)');
    expect(out).not.toContain('review-notes.md');
  });
});

describe('cross-review loadInstructions', () => {
  it('ファイル本文を読み、末尾空白を除いて返す', () => {
    const out = loadInstructions('/tmp/notes.md', { readFile: (p) => (p === '/tmp/notes.md' ? '指摘A\n指摘B\n\n' : 'OTHER') });
    expect(out).toBe('指摘A\n指摘B');
  });

  it('読めなければ例外を投げる (呼び出し側でエラー終了させる)', () => {
    expect(() => loadInstructions('/missing.md', { readFile: () => { throw new Error('ENOENT'); } })).toThrow();
  });
});

describe('cross-review loadIgnorePatterns', () => {
  it('ファイルが無ければ既定パターン (DEFAULT_EXCLUDE_PATTERNS) のみを返す', () => {
    const out = loadIgnorePatterns({
      env: {},
      cwd: '/repo',
      scriptDir: path.join('/repo', 'tools'),
      exists: () => false,
      readFile: () => { throw new Error('読まれないはず'); },
      warn: () => { throw new Error('警告は出ないはず'); },
    });
    expect(out).toEqual(DEFAULT_EXCLUDE_PATTERNS);
  });

  it('<cwd>/.cross-review-ignore があれば既定 + ファイルのパターンを併合する', () => {
    const expected = path.join('/repo', IGNORE_FILENAME);
    const out = loadIgnorePatterns({
      env: {},
      cwd: '/repo',
      exists: (p) => p === expected,
      readFile: () => 'dist/**\n# コメント\n\n  *.snap  \n',
      warn: () => { throw new Error('警告は出ないはず'); },
    });
    expect(out).toEqual(DEFAULT_EXCLUDE_PATTERNS.concat(['dist/**', '*.snap']));
  });

  it('コメント行 (#) と空行は無視する', () => {
    const out = loadIgnorePatterns({
      env: {},
      cwd: '/repo',
      exists: () => true,
      readFile: () => '# 全部コメント\n\n   \n# もう 1 行\n',
      warn: () => {},
    });
    expect(out).toEqual(DEFAULT_EXCLUDE_PATTERNS); // 追加パターンなし
  });

  it('環境変数 CROSS_REVIEW_IGNORE のパスを優先する', () => {
    const out = loadIgnorePatterns({
      env: { CROSS_REVIEW_IGNORE: '/custom/ignore' },
      cwd: '/repo',
      exists: (p) => p === '/custom/ignore',
      readFile: (p) => (p === '/custom/ignore' ? 'fixtures/**' : 'OTHER'),
      warn: () => { throw new Error('警告は出ないはず'); },
    });
    expect(out).toEqual(DEFAULT_EXCLUDE_PATTERNS.concat(['fixtures/**']));
  });

  it('CROSS_REVIEW_IGNORE 指定先が無効なら警告し、次候補へフォールバックする', () => {
    let warned = '';
    const cwdIgnore = path.join('/repo', IGNORE_FILENAME);
    const out = loadIgnorePatterns({
      env: { CROSS_REVIEW_IGNORE: '/missing/ignore' },
      cwd: '/repo',
      scriptDir: path.join('/repo', 'tools'),
      exists: (p) => p === cwdIgnore, // env 先は無い。cwd にはある。
      readFile: () => 'from-cwd/**',
      warn: (m) => { warned += m; },
    });
    expect(out).toEqual(DEFAULT_EXCLUDE_PATTERNS.concat(['from-cwd/**']));
    expect(warned).toContain('CROSS_REVIEW_IGNORE');
  });
});

describe('cross-review toExcludePathspecs', () => {
  it('各パターンを glob マジックワード + **/ 接頭の除外パススペックにする', () => {
    expect(toExcludePathspecs(['package-lock.json', '*.min.js'])).toEqual([
      ':(exclude,glob,top)**/package-lock.json',
      ':(exclude,glob,top)**/*.min.js',
    ]);
  });
});

describe('cross-review summarizeLargeFileDiffs', () => {
  const fileChunk = (path, body) => `diff --git a/${path} b/${path}\n${body}`;

  it('maxFileDiffKb が 0 なら無置換でそのまま返す', () => {
    const text = fileChunk('x', '+'.repeat(5000));
    expect(summarizeLargeFileDiffs(text, 0)).toEqual({ text, replacedCount: 0 });
  });

  it('閾値以下のチャンクは変更しない', () => {
    const text = fileChunk('x', '+small');
    const out = summarizeLargeFileDiffs(text, 64);
    expect(out.replacedCount).toBe(0);
    expect(out.text).toBe(text);
  });

  it('超過チャンクのみ置換し、追加/削除行数を数える (複数ファイル混在)', () => {
    const small = fileChunk('small.js', '+a\n-b');
    // 2KB 超の本文 (+ 行を大量に). 追加行数 = body の + 行数。
    const bigBody = Array.from({ length: 3000 }, () => '+x').join('\n') + '\n-y';
    const big = fileChunk('big.js', bigBody);
    const out = summarizeLargeFileDiffs(`${small}\n${big}`, 1);
    expect(out.replacedCount).toBe(1);
    expect(out.text).toContain('+a');                         // 小さいファイルは本文を保持
    expect(out.text).toContain('diff --git a/big.js b/big.js'); // ヘッダは残す
    expect(out.text).toContain('本文を省略');
    expect(out.text).toContain('追加 3000 行');
    expect(out.text).toContain('削除 1 行');
    expect(out.text).not.toContain('+x');                     // 本文は省略済み
  });

  it('+++ / --- のヘッダ行は追加/削除行数に数えない', () => {
    const body = ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '+added', '-removed', ...Array.from({ length: 2000 }, () => '+pad')].join('\n');
    const text = `diff --git a/f b/f\n${body}`;
    const out = summarizeLargeFileDiffs(text, 1);
    expect(out.replacedCount).toBe(1);
    expect(out.text).toContain('追加 2001 行'); // +added と +pad*2000。+++ は数えない
    expect(out.text).toContain('削除 1 行');    // -removed のみ。--- は数えない
  });

  it('複数チャンクの先頭・末尾の両方を置換できる', () => {
    const padBody = Array.from({ length: 2000 }, () => '+p').join('\n');
    const a = `diff --git a/a b/a\n${padBody}`;
    const b = `diff --git a/b b/b\n${padBody}`;
    const out = summarizeLargeFileDiffs(`${a}\n${b}`, 1);
    expect(out.replacedCount).toBe(2);
    expect(out.text).toContain('diff --git a/a b/a');
    expect(out.text).toContain('diff --git a/b b/b');
    expect(out.text).not.toContain('+p');
  });
});

describe('cross-review resolveMaxFileDiffKb', () => {
  it('CLI フラグ (maxFileDiffKb 数値) を最優先する', () => {
    expect(resolveMaxFileDiffKb({ maxFileDiffKb: 128 }, { CROSS_REVIEW_MAX_FILE_DIFF_KB: '32' })).toBe(128);
    expect(resolveMaxFileDiffKb({ maxFileDiffKb: 0 }, { CROSS_REVIEW_MAX_FILE_DIFF_KB: '32' })).toBe(0);
  });

  it('フラグ未指定なら環境変数へフォールバックする', () => {
    expect(resolveMaxFileDiffKb({ maxFileDiffKb: null }, { CROSS_REVIEW_MAX_FILE_DIFF_KB: '32' })).toBe(32);
  });

  it('フラグも env も無ければ既定 64', () => {
    expect(resolveMaxFileDiffKb({ maxFileDiffKb: null }, {})).toBe(64);
  });

  it('env が非負整数として解釈できなければ無視して既定 64', () => {
    expect(resolveMaxFileDiffKb({ maxFileDiffKb: null }, { CROSS_REVIEW_MAX_FILE_DIFF_KB: 'x' })).toBe(64);
  });
});

describe('cross-review collectReviewDiff (除外パススペック配線)', () => {
  it('base モード: 除外パススペックが diff 引数に入る', () => {
    const calls = [];
    const fakeGit = (args) => {
      calls.push(args);
      if (args.includes('--name-only')) return 'kept.js\n';
      return 'BASE_DIFF\n';
    };
    const out = collectReviewDiff(
      { mode: 'base', baseRef: 'main', excludePathspecs: [':(exclude,glob,top)**/package-lock.json'] },
      fakeGit,
    );
    expect(calls[0]).toEqual(['diff', 'main...HEAD', '--', ':/', ':(exclude,glob,top)**/package-lock.json']);
    expect(out.diffText).toBe('BASE_DIFF');
  });

  it('base モード: excludePathspecs が無ければ従来どおり除外指定を入れない', () => {
    const calls = [];
    const fakeGit = (args) => { calls.push(args); return 'BASE_DIFF\n'; };
    collectReviewDiff({ mode: 'base', baseRef: 'main' }, fakeGit);
    expect(calls[0]).toEqual(['diff', 'main...HEAD']); // --no-exclude 相当: 除外指定なし
  });

  it('base モード: 除外で落ちたファイル一覧を name-only の差集合で返す', () => {
    const fakeGit = (args) => {
      if (args[0] === 'diff' && args.includes('--name-only')) {
        // 除外あり (-- :/ spec) は kept のみ、除外なしは full を返す。
        return args.includes(':/') ? 'kept.js\n' : 'kept.js\npackage-lock.json\nsub/x.min.js\n';
      }
      return 'DIFF\n';
    };
    const out = collectReviewDiff(
      { mode: 'base', baseRef: 'main', excludePathspecs: [':(exclude,glob,top)**/package-lock.json'] },
      fakeGit,
    );
    expect(out.excludedFiles).toEqual(['package-lock.json', 'sub/x.min.js']);
  });

  it('uncommitted モード: 除外パススペックが tracked diff と ls-files に入る', () => {
    const calls = [];
    const fakeGit = (args) => {
      calls.push(args);
      if (args[0] === 'diff' && args[1] === 'HEAD' && !args.includes('--name-only')) return 'TRACKED\n';
      if (args[0] === 'ls-files') return '';
      if (args.includes('--name-only')) return '';
      return '';
    };
    collectReviewDiff(
      { mode: 'uncommitted', excludePathspecs: [':(exclude,glob,top)**/*.min.js'] },
      fakeGit,
    );
    const trackedCall = calls.find((c) => c[0] === 'diff' && c[1] === 'HEAD' && !c.includes('--name-only'));
    expect(trackedCall).toEqual(['diff', 'HEAD', '--', ':/', ':(exclude,glob,top)**/*.min.js']);
    const lsCall = calls.find((c) => c[0] === 'ls-files' && c.includes('--'));
    expect(lsCall).toEqual(['ls-files', '--others', '--exclude-standard', '-z', '--', ':/', ':(exclude,glob,top)**/*.min.js']);
  });

  it('uncommitted モード: untracked の除外ファイルを差集合で返す', () => {
    const fakeGit = (args) => {
      if (args[0] === 'diff' && args[1] === 'HEAD' && args.includes('--name-only')) return ''; // tracked 変更なし
      if (args[0] === 'diff' && args[1] === 'HEAD') return ''; // tracked 本体なし
      if (args[0] === 'ls-files') {
        // 除外あり (-- :/ spec) は real-new.js のみ、除外なしは min も返す。
        return args.includes(':/') ? 'real-new.js\0' : 'real-new.js\0gen/app.min.js\0';
      }
      if (args[0] === 'diff' && args[3] === '/dev/null') return `NEWFILE(${args[4]})\n`;
      return '';
    };
    const out = collectReviewDiff(
      { mode: 'uncommitted', excludePathspecs: [':(exclude,glob,top)**/*.min.js'] },
      fakeGit,
    );
    expect(out.diffText).toContain('NEWFILE(real-new.js)');
    expect(out.excludedFiles).toEqual(['gen/app.min.js']);
  });
});

describe('cross-review buildReviewPrompt', () => {
  it('渡したレビュー観点と差分本文の両方を含める', () => {
    const prompt = buildReviewPrompt('diff --git a/x b/x', { mode: 'base', baseRef: 'main' }, 'MY_CHECKLIST');
    expect(prompt).toContain('MY_CHECKLIST');
    expect(prompt).toContain('diff --git a/x b/x');
    expect(prompt).toContain('main');
    expect(prompt).toContain('DIFF START');
  });

  it('checklist 未指定/空なら汎用観点 (GENERIC_CHECKLIST) にフォールバックする', () => {
    expect(buildReviewPrompt('diff', { mode: 'base', baseRef: 'main' })).toContain(GENERIC_CHECKLIST);
    expect(buildReviewPrompt('diff', { mode: 'base', baseRef: 'main' }, '   ')).toContain(GENERIC_CHECKLIST);
  });

  it('汎用観点は指摘の出し方 (件数上限と反例) を含む', () => {
    expect(GENERIC_CHECKLIST).toContain('指摘の出し方');
    expect(GENERIC_CHECKLIST).toContain('10 件');
    expect(GENERIC_CHECKLIST).toContain('反例');
  });

  it('既定 (fix なし) はレビューのみ指示を含み、修正指示は含めない', () => {
    const prompt = buildReviewPrompt('diff', { mode: 'base', baseRef: 'main', fix: false }, 'CL');
    expect(prompt).toContain(REVIEW_ONLY_INSTRUCTION);
    expect(prompt).not.toContain(FIX_INSTRUCTION);
  });

  it('--fix は修正指示を含み、レビューのみ指示は含めない', () => {
    const prompt = buildReviewPrompt('diff', { mode: 'uncommitted', fix: true }, 'CL');
    expect(prompt).toContain(FIX_INSTRUCTION);
    expect(prompt).not.toContain(REVIEW_ONLY_INSTRUCTION);
  });

  it('instructions を渡すと申し送り見出しと本文を観点に加えて含める', () => {
    const prompt = buildReviewPrompt('diff', { mode: 'base', baseRef: 'main', fix: true }, 'CL', 'これを直して');
    expect(prompt).toContain('CL');                      // 観点は残る (置き換えない)
    expect(prompt).toContain(REVIEWER_NOTES_HEADER);     // 申し送り見出し
    expect(prompt).toContain('これを直して');             // 申し送り本文
    expect(prompt).toContain(FIX_INSTRUCTION);
  });

  it('instructions が空/未指定なら申し送り見出しを含めない', () => {
    expect(buildReviewPrompt('diff', { mode: 'base', baseRef: 'main' }, 'CL')).not.toContain(REVIEWER_NOTES_HEADER);
    expect(buildReviewPrompt('diff', { mode: 'base', baseRef: 'main' }, 'CL', '   ')).not.toContain(REVIEWER_NOTES_HEADER);
  });

  it('excludedFiles が 1 件以上なら除外一覧セクションを含める', () => {
    const prompt = buildReviewPrompt('diff', { mode: 'base', baseRef: 'main' }, 'CL', null, ['package-lock.json', 'dist/app.min.js']);
    expect(prompt).toContain('レビュー対象外（除外済み）');
    expect(prompt).toContain('- package-lock.json');
    expect(prompt).toContain('- dist/app.min.js');
  });

  it('excludedFiles が空/未指定なら除外一覧セクションを含めない', () => {
    expect(buildReviewPrompt('diff', { mode: 'base', baseRef: 'main' }, 'CL')).not.toContain('レビュー対象外');
    expect(buildReviewPrompt('diff', { mode: 'base', baseRef: 'main' }, 'CL', null, [])).not.toContain('レビュー対象外');
  });

  it('差分の再取得を抑止する枠付け文言を含む', () => {
    const prompt = buildReviewPrompt('diff', { mode: 'base', baseRef: 'main' }, 'CL');
    expect(prompt).toContain('git diff やファイル全文の再取得はしないこと');
    expect(prompt).not.toContain('必要なら作業ディレクトリのファイルを読んで文脈を補ってください'); // 旧文言は撤去
  });
});

describe('cross-review loadChecklist', () => {
  it('<cwd>/.cross-review.md があれば末尾空白を除いて返す', () => {
    // path.join は OS で区切り文字が変わる (Windows は \\)。期待パスも path.join で組む。
    const expected = path.join('/repo', CHECKLIST_FILENAME);
    const seen = [];
    const out = loadChecklist({
      env: {},
      cwd: '/repo',
      exists: (p) => { seen.push(p); return p === expected; },
      readFile: () => 'PROJECT_CHECKLIST\n\n',
      warn: () => { throw new Error('警告は出ないはず'); },
    });
    expect(out).toBe('PROJECT_CHECKLIST');
    expect(seen).toContain(expected);
  });

  it('cwd に無くてもスクリプト基準 (tools/../.cross-review.md) があれば拾う', () => {
    // サブディレクトリから直接実行しても (cwd がリポ外でも) 観点を解決できることの担保。
    const scriptDir = path.join('/app', 'tools');
    const repoChecklist = path.join(scriptDir, '..', CHECKLIST_FILENAME);
    const out = loadChecklist({
      env: {},
      cwd: '/somewhere/else',
      scriptDir,
      exists: (p) => p === repoChecklist,
      readFile: () => 'SCRIPT_RELATIVE',
      warn: () => { throw new Error('警告は出ないはず'); },
    });
    expect(out).toBe('SCRIPT_RELATIVE');
  });

  it('環境変数 CROSS_REVIEW_CHECKLIST のパスを優先する', () => {
    const out = loadChecklist({
      env: { CROSS_REVIEW_CHECKLIST: '/custom/list.md' },
      cwd: '/repo',
      exists: (p) => p === '/custom/list.md',
      readFile: (p) => (p === '/custom/list.md' ? 'ENV_CHECKLIST' : 'OTHER'),
      warn: () => { throw new Error('警告は出ないはず'); },
    });
    expect(out).toBe('ENV_CHECKLIST');
  });

  it('CROSS_REVIEW_CHECKLIST 指定先が無効なら警告し、次候補へフォールバックする', () => {
    let warned = '';
    const cwdChecklist = path.join('/repo', CHECKLIST_FILENAME);
    const out = loadChecklist({
      env: { CROSS_REVIEW_CHECKLIST: '/missing/list.md' },
      cwd: '/repo',
      scriptDir: path.join('/repo', 'tools'),
      exists: (p) => p === cwdChecklist, // env 先は無い。cwd にはある。
      readFile: () => 'FROM_CWD',
      warn: (m) => { warned += m; },
    });
    expect(out).toBe('FROM_CWD');
    expect(warned).toContain('CROSS_REVIEW_CHECKLIST');
  });

  it('候補が無ければ GENERIC_CHECKLIST へフォールバックし警告する', () => {
    let warned = '';
    const out = loadChecklist({
      env: {},
      cwd: '/repo',
      exists: () => false,
      readFile: () => { throw new Error('読まれないはず'); },
      warn: (m) => { warned += m; },
    });
    expect(out).toBe(GENERIC_CHECKLIST);
    expect(warned).toContain(CHECKLIST_FILENAME);
  });

  it('空ファイルは無効としてフォールバックする', () => {
    const out = loadChecklist({
      env: {},
      cwd: '/repo',
      exists: () => true,
      readFile: () => '   \n  ',
      warn: () => {},
    });
    expect(out).toBe(GENERIC_CHECKLIST);
  });
});

describe('cross-review resolveBaseRef', () => {
  // gh と環境変数は実行環境に依存させない (gh 不在 = PR 無しの既定挙動を固定する)。
  const baseDeps = (extra = {}) => ({ ghRun: () => null, env: {}, ...extra });

  it('--base 明示時は fetch も rev-parse も呼ばれず baseRef をそのまま返す', () => {
    const calls = [];
    const gitRun = (args) => { calls.push(args); return ''; };
    const out = resolveBaseRef({ mode: 'base', baseRef: 'develop', baseExplicit: true }, gitRun, baseDeps());
    expect(out).toBe('develop');
    expect(calls).toEqual([]); // git は一切呼ばれない
  });

  it('uncommitted 時も git を呼ばず baseRef をそのまま返す', () => {
    const calls = [];
    const gitRun = (args) => { calls.push(args); return ''; };
    const out = resolveBaseRef({ mode: 'uncommitted', baseRef: 'main', baseExplicit: false }, gitRun, baseDeps());
    expect(out).toBe('main');
    expect(calls).toEqual([]);
  });

  it('fetch 失敗でも origin/main が verify できれば origin/main を返す', () => {
    const gitRun = (args) => {
      if (args[0] === 'fetch') return null;           // fetch 失敗 (allowFailure で null)
      if (args[0] === 'rev-parse') return 'abc123\n'; // origin/main は verify できる
      return '';
    };
    const out = resolveBaseRef({ mode: 'base', baseRef: 'main', baseExplicit: false }, gitRun, baseDeps());
    expect(out).toBe('origin/main');
  });

  it('origin/main が verify できなければ main を返す', () => {
    const gitRun = (args) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return null; // origin/main 無し
      return '';
    };
    const out = resolveBaseRef({ mode: 'base', baseRef: 'main', baseExplicit: false }, gitRun, baseDeps());
    expect(out).toBe('main');
  });

  it('fetch 失敗時は stderr に警告を出し、使う参照の最終コミット日時を添える', () => {
    let err = '';
    const gitRun = (args) => {
      if (args[0] === 'log') return '2026-09-01 12:00:00 +0900\n';
      return null; // fetch も rev-parse も失敗 → ローカル main
    };
    resolveBaseRef(
      { mode: 'base', baseRef: 'main', baseExplicit: false },
      gitRun,
      baseDeps({ err: (s) => { err += s; } }),
    );
    expect(err).toMatch(/取得に失敗/);
    expect(err).toContain('2026-09-01 12:00:00 +0900');
  });

  it('origin/main 採用時は stderr に通知を出す', () => {
    let err = '';
    const gitRun = (args) => (args[0] === 'rev-parse' ? 'abc\n' : '');
    resolveBaseRef(
      { mode: 'base', baseRef: 'main', baseExplicit: false },
      gitRun,
      baseDeps({ err: (s) => { err += s; } }),
    );
    expect(err).toMatch(/origin\/main/);
  });
});

describe('cross-review resolveBaseSelection (既定 base の 3 段解決)', () => {
  const sha = 'a'.repeat(40);
  const opts = { mode: 'base', baseRef: 'main', baseExplicit: false };

  it('1 段目: 状態ファイルの lastReviewedSha が現存すればそれを base にする', () => {
    const calls = [];
    let err = '';
    const gitRun = (args) => {
      calls.push(args[0]);
      if (args[0] === 'cat-file') return ''; // SHA は現存する
      return '';
    };
    const sel = resolveBaseSelection(opts, gitRun, {
      env: {},
      err: (s) => { err += s; },
      ghRun: () => { throw new Error('SHA が使えるなら gh は呼ばない'); },
      branchState: { round: 1, lastReviewedSha: sha, dismissed: [] },
    });
    expect(sel.ref).toBe(sha);
    expect(sel.source).toBe('state');
    expect(calls).not.toContain('fetch'); // 増分レビューでは fetch も要らない
    expect(err).toMatch(/往復 2 回目/);
  });

  it('1 段目: SHA が現存しなければ (rebase 等) 次の解決へ進む', () => {
    const gitRun = (args) => {
      if (args[0] === 'cat-file') return null; // SHA が消えている
      if (args[0] === 'rev-parse') return 'abc\n';
      return '';
    };
    const sel = resolveBaseSelection(opts, gitRun, {
      env: {},
      err: () => {},
      ghRun: () => null,
      branchState: { round: 2, lastReviewedSha: sha, dismissed: [] },
    });
    expect(sel.ref).toBe('origin/main');
    expect(sel.source).toBe('origin-main');
  });

  it('2 段目: gh の baseRefName を origin/<name> として採用する (スタック PR 対策)', () => {
    const fetched = [];
    let err = '';
    const gitRun = (args) => {
      if (args[0] === 'fetch') { fetched.push(args[2]); return ''; }
      if (args[0] === 'rev-parse') return args[3] === 'origin/develop' ? 'def\n' : null;
      return '';
    };
    const sel = resolveBaseSelection(opts, gitRun, {
      env: {},
      err: (s) => { err += s; },
      ghRun: () => 'develop\n',
    });
    expect(sel.ref).toBe('origin/develop');
    expect(sel.source).toBe('pr');
    expect(fetched).toEqual(['develop']);
    expect(err).toMatch(/PR の base/);
  });

  it('2 段目: origin/<name> が verify できなければ origin/main の解決へ戻る', () => {
    const gitRun = (args) => {
      if (args[0] === 'rev-parse') return args[3] === 'origin/main' ? 'abc\n' : null;
      return '';
    };
    const sel = resolveBaseSelection(opts, gitRun, { env: {}, err: () => {}, ghRun: () => 'develop\n' });
    expect(sel.ref).toBe('origin/main');
  });

  it('2 段目: gh が無い / PR が無い / 危険なブランチ名は黙って次へ進む', () => {
    const gitRun = (args) => (args[0] === 'rev-parse' ? 'abc\n' : '');
    const run = (ghRun) => resolveBaseSelection(opts, gitRun, { env: {}, err: () => {}, ghRun }).ref;
    expect(run(() => null)).toBe('origin/main');                       // gh 不在 / PR 無し
    expect(run(() => '')).toBe('origin/main');                          // 空出力
    expect(run(() => { throw new Error('spawn failed'); })).toBe('origin/main');
    expect(run(() => '--upload-pack=evil\n')).toBe('origin/main');      // オプションに化ける名前は使わない
  });

  it('CROSS_REVIEW_NO_FETCH=1 なら fetch も gh も呼ばない', () => {
    const calls = [];
    const gitRun = (args) => {
      calls.push(args[0]);
      if (args[0] === 'rev-parse') return 'abc\n';
      return '';
    };
    const sel = resolveBaseSelection(opts, gitRun, {
      env: { CROSS_REVIEW_NO_FETCH: '1' },
      err: () => {},
      ghRun: () => { throw new Error('NO_FETCH では gh を呼ばない'); },
    });
    expect(sel.ref).toBe('origin/main');
    expect(calls).not.toContain('fetch');
  });

  it('CROSS_REVIEW_NO_FETCH=0 / 空文字は無効 (従来どおり fetch する)', () => {
    expect(isNoFetch({ CROSS_REVIEW_NO_FETCH: '1' })).toBe(true);
    expect(isNoFetch({ CROSS_REVIEW_NO_FETCH: 'true' })).toBe(true);
    expect(isNoFetch({ CROSS_REVIEW_NO_FETCH: '0' })).toBe(false);
    expect(isNoFetch({ CROSS_REVIEW_NO_FETCH: '' })).toBe(false);
    expect(isNoFetch({})).toBe(false);
  });

  it('--base 明示と --uncommitted では解決方法を explicit / uncommitted で返す', () => {
    const gitRun = () => { throw new Error('git は呼ばない'); };
    const deps = { env: {}, ghRun: () => { throw new Error('gh も呼ばない'); } };
    expect(resolveBaseSelection({ ...opts, baseExplicit: true, baseRef: 'develop' }, gitRun, deps).source).toBe('explicit');
    expect(resolveBaseSelection({ ...opts, mode: 'uncommitted' }, gitRun, deps).source).toBe('uncommitted');
  });
});

describe('cross-review shrinkDiffToFit (差分ガードの段階的縮退)', () => {
  // 1 ファイル 20KB 相当のチャンクを 2 つ作る。32KB の段では置換されず、16KB の段で 2 件とも置換される。
  const chunk = (name) => [`diff --git a/${name} b/${name}`, `+${'x'.repeat(20 * 1024)}`].join('\n');
  const diffText = [chunk('a.txt'), chunk('b.txt')].join('\n');

  it('段を下げて閾値以下に収まればその段で止める', () => {
    const out = shrinkDiffToFit(diffText, { maxDiffKb: 1, maxFileDiffKb: 64 });
    expect(out.fits).toBe(true);
    expect(out.usedFileKb).toBe(16);   // 32KB では縮まず 16KB で収まる
    expect(out.replacedCount).toBe(2);
    expect(out.tried).toEqual([32, 16]);
    expect(out.text).toContain('本文を省略');
  });

  it('最小の段でも収まらなければ fits:false と試した段を返す', () => {
    // 要約後も 1 チャンクあたり 1 行残るので、極端に小さい全体閾値には収まらない。
    const out = shrinkDiffToFit(diffText, { maxDiffKb: 0.05, maxFileDiffKb: 64 });
    expect(out.fits).toBe(false);
    expect(out.tried).toEqual([32, 16, 8]);
  });

  it('要約が無効 (maxFileDiffKb 0) なら縮退しない', () => {
    const out = shrinkDiffToFit(diffText, { maxDiffKb: 1, maxFileDiffKb: 0 });
    expect(out.fits).toBe(false);
    expect(out.replacedCount).toBe(0);
    expect(out.tried).toEqual([]);
    expect(out.text).toBe(diffText);
  });

  it('全体ガードが無効 (maxDiffKb 0) なら縮退しない', () => {
    const out = shrinkDiffToFit(diffText, { maxDiffKb: 0, maxFileDiffKb: 64 });
    expect(out.tried).toEqual([]);
    expect(out.text).toBe(diffText);
  });

  it('現在の閾値以上の段は飛ばす (縮まないので試さない)', () => {
    const out = shrinkDiffToFit(diffText, { maxDiffKb: 1, maxFileDiffKb: 16 });
    expect(out.tried).toEqual([8]);
  });
});

describe('cross-review 状態ファイルの純粋関数', () => {
  const sha = 'b'.repeat(40);

  it('nextState: 初回は round 1 と lastReviewedSha を記録する', () => {
    const out = nextState({ branches: {} }, { branch: 'feat/x', sha, reviewer: 'codex' });
    expect(out.branches['feat/x']).toEqual({ round: 1, lastReviewedSha: sha, dismissed: [] });
  });

  it('nextState: sha が無い (--uncommitted) 場合は round だけ増やし SHA は据え置く', () => {
    const before = { branches: { 'feat/x': { round: 1, lastReviewedSha: sha, dismissed: ['既知'] } } };
    const out = nextState(before, { branch: 'feat/x', sha: null, reviewer: 'subagent' });
    expect(out.branches['feat/x']).toEqual({ round: 2, lastReviewedSha: sha, dismissed: ['既知'] });
  });

  it('nextState: ブランチ名が無ければ何も記録しない', () => {
    const out = nextState({ branches: {} }, { branch: null, sha, reviewer: 'codex' });
    expect(out).toEqual({ branches: {} });
  });

  it('nextState: 他の枝の記録は変えない', () => {
    const before = { branches: { other: { round: 3, lastReviewedSha: null, dismissed: [] } } };
    const out = nextState(before, { branch: 'feat/x', sha, reviewer: 'codex' });
    expect(out.branches.other).toEqual({ round: 3, lastReviewedSha: null, dismissed: [] });
    expect(before.branches['feat/x']).toBeUndefined(); // 元の state を破壊しない
  });

  it('withDismissed: 同じ要約は重複して追加しない (前後の空白は無視)', () => {
    let state = withDismissed({ branches: {} }, 'feat/x', '運用上到達しない入力への指摘');
    state = withDismissed(state, 'feat/x', '  運用上到達しない入力への指摘  ');
    state = withDismissed(state, 'feat/x', '別の指摘');
    expect(branchStateOf(state, 'feat/x').dismissed).toEqual(['運用上到達しない入力への指摘', '別の指摘']);
  });

  it('withDismissed: 空の要約は追加しない', () => {
    const state = withDismissed({ branches: {} }, 'feat/x', '   ');
    expect(branchStateOf(state, 'feat/x').dismissed).toEqual([]);
  });

  it('withoutBranch: 指定した枝だけを消す', () => {
    const before = {
      branches: {
        'feat/x': { round: 2, lastReviewedSha: sha, dismissed: ['a'] },
        other: { round: 1, lastReviewedSha: null, dismissed: [] },
      },
    };
    const out = withoutBranch(before, 'feat/x');
    expect(out.branches['feat/x']).toBeUndefined();
    expect(out.branches.other.round).toBe(1);
  });

  it('normalizeState: 型が違う値は初期値へ落とす', () => {
    const out = normalizeState({ branches: { x: { round: -1, lastReviewedSha: 42, dismissed: 'a' } } });
    expect(out.branches.x).toEqual({ round: 0, lastReviewedSha: null, dismissed: [] });
    expect(normalizeState(null)).toEqual({ branches: {} });
    expect(normalizeState('壊れた値')).toEqual({ branches: {} });
  });

  it('branchStateOf: 記録が無ければ初期状態', () => {
    expect(branchStateOf({ branches: {} }, 'feat/x')).toEqual({ round: 0, lastReviewedSha: null, dismissed: [] });
  });
});

describe('cross-review readState / writeState', () => {
  const statePath = path.join('/repo', STATE_FILENAME);
  const deps = (files) => ({
    scriptDir: path.join('/repo', 'tools'),
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFile: (p) => files[p],
  });

  it('ファイルが無ければ空の状態を返す (corrupt:false)', () => {
    const out = readState(deps({}));
    expect(out.state).toEqual({ branches: {} });
    expect(out.corrupt).toBe(false);
    expect(out.path).toBe(statePath);
  });

  it('JSON が壊れていれば corrupt:true で空の状態を返す', () => {
    const out = readState(deps({ [statePath]: '{壊れた' }));
    expect(out.corrupt).toBe(true);
    expect(out.state).toEqual({ branches: {} });
  });

  it('読み込んだ内容は正規化して返す', () => {
    const body = JSON.stringify({ branches: { 'feat/x': { round: 2, lastReviewedSha: 'c'.repeat(40), dismissed: ['x'] } } });
    const out = readState(deps({ [statePath]: body }));
    expect(branchStateOf(out.state, 'feat/x').round).toBe(2);
  });

  it('writeState は正規化した JSON を書き、失敗しても例外を投げず警告する', () => {
    const written = {};
    const ok = writeState({ branches: { x: { round: 1, lastReviewedSha: null, dismissed: [] } } }, {
      scriptDir: path.join('/repo', 'tools'),
      writeStateFile: (p, body) => { written[p] = body; },
    });
    expect(ok).toBe(true);
    expect(JSON.parse(written[statePath]).branches.x.round).toBe(1);

    let warned = '';
    const ng = writeState({ branches: {} }, {
      scriptDir: path.join('/repo', 'tools'),
      writeStateFile: () => { throw new Error('EACCES'); },
      warn: (s) => { warned += s; },
    });
    expect(ng).toBe(false);
    expect(warned).toMatch(/状態ファイルを書けません/);
  });
});

describe('cross-review buildDismissedSection / joinReviewerNotes', () => {
  it('1 件以上あれば見出し付きの節にする', () => {
    const out = buildDismissedSection(['A の指摘', 'B の指摘']);
    expect(out).toContain(DISMISSED_HEADER);
    expect(out).toContain('- A の指摘');
    expect(out).toContain('- B の指摘');
  });

  it('空なら null (何も添えない)', () => {
    expect(buildDismissedSection([])).toBeNull();
    expect(buildDismissedSection(undefined)).toBeNull();
    expect(buildDismissedSection(['  '])).toBeNull();
  });

  it('joinReviewerNotes は申し送りの後ろに dismissed を置く', () => {
    const out = joinReviewerNotes('申し送り本文', buildDismissedSection(['A の指摘']));
    expect(out.indexOf('申し送り本文')).toBeLessThan(out.indexOf(DISMISSED_HEADER));
    expect(joinReviewerNotes(null, null)).toBeNull();
    expect(joinReviewerNotes('のみ', null)).toBe('のみ');
  });
});

describe('cross-review state / dismiss サブコマンド', () => {
  const gitRun = (args) => (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'feat/x\n' : '');

  it('state は現在の枝の記録を JSON で表示する', () => {
    let out = '';
    const mem = memoryState({ branches: { 'feat/x': { round: 2, lastReviewedSha: 'd'.repeat(40), dismissed: ['A'] } } });
    runStateCommand({ reset: false }, { ...mem, gitRun, out: (s) => { out += s; }, err: () => {} });
    const parsed = JSON.parse(out);
    expect(parsed.branch).toBe('feat/x');
    expect(parsed.round).toBe(2);
    expect(parsed.dismissed).toEqual(['A']);
  });

  it('state --reset は現在の枝だけを消す', () => {
    const mem = memoryState({
      branches: {
        'feat/x': { round: 2, lastReviewedSha: null, dismissed: [] },
        other: { round: 1, lastReviewedSha: null, dismissed: [] },
      },
    });
    runStateCommand({ reset: true }, { ...mem, gitRun, out: () => {}, err: () => {} });
    expect(mem.store.state.branches['feat/x']).toBeUndefined();
    expect(mem.store.state.branches.other.round).toBe(1);
  });

  // state --mark は、利用上限フォールバックのように CLI がレビューの成立を観測できない経路で、
  // レビューを終えた利用者が往復を進めるための入口。
  const markSha = 'e'.repeat(40);
  const markGitRun = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x\n';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${markSha}\n`;
    return '';
  };

  it('state --mark は往復を 1 増やし、直前レビュー SHA を現在の HEAD にする', () => {
    const mem = memoryState({
      branches: {
        'feat/x': { round: 1, lastReviewedSha: 'd'.repeat(40), dismissed: ['A'] },
        other: { round: 3, lastReviewedSha: null, dismissed: [] },
      },
    });
    let err = '';
    runStateCommand({ mark: true }, {
      ...mem, gitRun: markGitRun, out: () => {}, err: (s) => { err += s; },
    });
    expect(branchStateOf(mem.store.state, 'feat/x')).toEqual({ round: 2, lastReviewedSha: markSha, dismissed: ['A'] });
    expect(mem.store.state.branches.other.round).toBe(3); // 他の枝は触らない
    expect(err).toMatch(/往復を記録しました/);
  });

  it('state --mark --uncommitted は往復だけ進め、直前レビュー SHA を据え置く (--uncommitted のレビューと同じ規則)', () => {
    const prevSha = 'd'.repeat(40);
    const mem = memoryState({
      branches: { 'feat/x': { round: 1, lastReviewedSha: prevSha, dismissed: [] } },
    });
    runStateCommand({ mark: true, mode: 'uncommitted' }, {
      ...mem, gitRun: markGitRun, out: () => {}, err: () => {},
    });
    expect(branchStateOf(mem.store.state, 'feat/x')).toEqual({ round: 2, lastReviewedSha: prevSha, dismissed: [] });
  });

  it('state --mark は書き込みに失敗したら成功通知を出さずエラー終了する', () => {
    let err = '';
    process.exitCode = 0;
    runStateCommand({ mark: true }, { ...failingWriteDeps((s) => { err += s; }), gitRun: markGitRun });
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/状態ファイルを書けません/);
    expect(err).not.toMatch(/往復を記録しました/);
    process.exitCode = 0;
  });

  it('壊れた状態ファイルには書き戻さず、エラー終了する (記録を消さない)', () => {
    const mem = memoryState({ branches: {} }, { corrupt: true });
    let err = '';
    process.exitCode = 0;
    runStateCommand({ reset: true }, { ...mem, gitRun, out: () => {}, err: (s) => { err += s; } });
    expect(mem.store.writes).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/JSON 不正/);
    process.exitCode = 0;
  });

  it('dismiss は要約を追加し、同じ要約は追加しない', () => {
    const mem = memoryState();
    let err = '';
    runDismissCommand({ dismissText: 'A の指摘' }, { ...mem, gitRun, err: (s) => { err += s; } });
    expect(branchStateOf(mem.store.state, 'feat/x').dismissed).toEqual(['A の指摘']);
    runDismissCommand({ dismissText: 'A の指摘' }, { ...mem, gitRun, err: (s) => { err += s; } });
    expect(mem.store.writes).toHaveLength(1);          // 2 回目は書かない
    expect(err).toMatch(/既に記録されています/);
  });

  it('ブランチ名を取れなければ何もせずエラー終了する', () => {
    const mem = memoryState();
    process.exitCode = 0;
    runStateCommand({ reset: false }, { ...mem, gitRun: () => null, out: () => {}, err: () => {} });
    expect(process.exitCode).toBe(1);
    expect(mem.store.writes).toEqual([]);
    process.exitCode = 0;
  });

  // 書き込みが失敗したのに成功通知を出すと、記録が消えた / 残ったを取り違える。
  // 実物の writeState を使い、その下の writeStateFile だけを失敗させる。
  const failingWriteDeps = (err) => ({
    gitRun,
    readState: () => ({
      path: '<test-state>',
      state: { branches: { 'feat/x': { round: 1, lastReviewedSha: null, dismissed: [] } } },
      corrupt: false,
    }),
    writeStateFile: () => { throw new Error('EACCES'); },
    scriptDir: path.join('/repo', 'tools'),
    out: () => {},
    err,
  });

  it('state --reset は書き込みに失敗したら成功通知を出さずエラー終了する', () => {
    let err = '';
    process.exitCode = 0;
    runStateCommand({ reset: true }, failingWriteDeps((s) => { err += s; }));
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/状態ファイルを書けません/);
    expect(err).not.toMatch(/記録を消しました/);
    process.exitCode = 0;
  });

  it('dismiss は書き込みに失敗したら成功通知を出さずエラー終了する', () => {
    let err = '';
    process.exitCode = 0;
    runDismissCommand({ dismissText: 'A の指摘' }, failingWriteDeps((s) => { err += s; }));
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/状態ファイルを書けません/);
    expect(err).not.toMatch(/記録しました/);
    process.exitCode = 0;
  });
});

describe('cross-review currentBranchName / currentHeadSha', () => {
  it('取得できなければ null (状態の読み書きを行わない印)', () => {
    expect(currentBranchName(() => null)).toBeNull();
    expect(currentBranchName(() => '  \n')).toBeNull();
    expect(currentHeadSha(() => null)).toBeNull();
  });

  it('detached HEAD は git が返す HEAD をそのままキーにする', () => {
    expect(currentBranchName(() => 'HEAD\n')).toBe('HEAD');
  });

  it('SHA として解釈できない出力は記録しない', () => {
    expect(currentHeadSha(() => 'abc\n')).toBeNull();
    expect(currentHeadSha(() => `${'e'.repeat(40)}\n`)).toBe('e'.repeat(40));
  });
});

describe('cross-review resolveMaxDiffKb', () => {
  it('CLI フラグ (maxDiffKb 数値) を最優先する', () => {
    expect(resolveMaxDiffKb({ maxDiffKb: 512 }, { CROSS_REVIEW_MAX_DIFF_KB: '128' })).toBe(512);
    expect(resolveMaxDiffKb({ maxDiffKb: 0 }, { CROSS_REVIEW_MAX_DIFF_KB: '128' })).toBe(0);
  });

  it('フラグ未指定なら環境変数へフォールバックする', () => {
    expect(resolveMaxDiffKb({ maxDiffKb: null }, { CROSS_REVIEW_MAX_DIFF_KB: '128' })).toBe(128);
    expect(resolveMaxDiffKb({ maxDiffKb: null }, { CROSS_REVIEW_MAX_DIFF_KB: '0' })).toBe(0);
  });

  it('フラグも env も無ければ既定 256', () => {
    expect(resolveMaxDiffKb({ maxDiffKb: null }, {})).toBe(256);
  });

  it('env が非負整数として解釈できなければ無視して既定 256', () => {
    expect(resolveMaxDiffKb({ maxDiffKb: null }, { CROSS_REVIEW_MAX_DIFF_KB: 'abc' })).toBe(256);
    expect(resolveMaxDiffKb({ maxDiffKb: null }, { CROSS_REVIEW_MAX_DIFF_KB: '-5' })).toBe(256);
    expect(resolveMaxDiffKb({ maxDiffKb: null }, { CROSS_REVIEW_MAX_DIFF_KB: '1.5' })).toBe(256);
  });
});

describe('cross-review runReview (gitRun / spawnFn 注入)', () => {
  // 実物の spawnReviewer は終了コードを process.exitCode に載せてから onExit を呼ぶ。
  // テスト用の spawnFn も同じ契約にし、フォールバックが終了コードを上書きするのか、
  // 元の終了コードが維持されるのかを区別できるようにする。
  // 往復の記録は onExit の結果で決まるので、記録を検証するテストは必ずこれで終了させる。
  const settle = (onExit, result) => {
    process.exitCode = result.code == null ? 1 : result.code;
    onExit({ outputTail: '', error: null, ...result });
  };

  // codex 経路でも「観点 + 差分本文 + モード指示」を stdin に渡す配線を固定する。
  // 旧挙動 (codex に観点だけ渡す) への退行を検知するための結合テスト。
  it('codex レビューのみ: read-only + 差分本文 + 観点 + レビューのみ指示を stdin に渡す', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    const gitRun = (args) => (args[0] === 'diff' ? 'diff --git a/x b/x\n+changed\n' : '');
    runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', fix: false },
      { ...isolated(), gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', exists: () => false },
    );
    expect(captured.cmd).toBe('codex');
    expect(captured.args).toContain('read-only');
    expect(captured.stdin).toContain('diff --git a/x b/x');   // 差分本文が stdin に乗る
    expect(captured.stdin).toContain('CHECKLIST_MARKER');     // 注入した観点が stdin に乗る
    expect(captured.stdin).toContain(REVIEW_ONLY_INSTRUCTION);
    expect(captured.stdin).not.toContain(FIX_INSTRUCTION);
  });

  it('codex --fix: workspace-write + 差分本文 + 修正指示を stdin に渡す', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    const gitRun = (args) => {
      if (args[0] === 'diff' && args[1] === 'HEAD') return 'DIFF_BODY\n';
      return '';
    };
    runReview(
      { reviewer: 'codex', mode: 'uncommitted', fix: true },
      { ...isolated(), gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', exists: () => false },
    );
    expect(captured.cmd).toBe('codex');
    expect(captured.args).toContain('workspace-write');
    expect(captured.stdin).toContain('DIFF_BODY');
    expect(captured.stdin).toContain(FIX_INSTRUCTION);
  });

  it('claude 経路は claude -p に差分本文入りプロンプトを渡す', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    const gitRun = (args) => (args[0] === 'diff' ? 'CLAUDE_DIFF\n' : '');
    runReview(
      { reviewer: 'claude', mode: 'base', baseRef: 'main', fix: false },
      { ...isolated(), gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', exists: () => false },
    );
    expect(captured.cmd).toBe('claude');
    expect(captured.args).toEqual(['-p']);
    expect(captured.stdin).toContain('CLAUDE_DIFF');
  });

  it('codex --fix + instructions: 申し送り本文を stdin に乗せる (指摘の受け渡し)', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    const gitRun = (args) => (args[0] === 'diff' && args[1] === 'HEAD' ? 'DIFF_BODY\n' : '');
    runReview(
      { reviewer: 'codex', mode: 'uncommitted', fix: true, instructionsPath: 'notes.md' },
      { ...isolated(), gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', instructions: 'レビュアーの指摘: X を直す', exists: () => false },
    );
    expect(captured.args).toContain('workspace-write');
    expect(captured.stdin).toContain('CHECKLIST_MARKER');           // 観点は残る
    expect(captured.stdin).toContain(REVIEWER_NOTES_HEADER);         // 申し送り見出し
    expect(captured.stdin).toContain('レビュアーの指摘: X を直す');   // 申し送り本文
    expect(captured.stdin).toContain('DIFF_BODY');
  });

  it('subagent: 外部 CLI を起動せず、レビュープロンプトを stdout に出す (通知は stderr)', () => {
    let called = false;
    const spawnFn = () => { called = true; return null; };
    const gitRun = (args) => (args[0] === 'diff' ? 'SUBAGENT_DIFF\n+x\n' : '');
    let out = '';
    let err = '';
    const ret = runReview(
      { reviewer: 'subagent', mode: 'base', baseRef: 'main', fix: false },
      { ...isolated(), gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', out: (s) => { out += s; }, exists: () => false, err: (s) => { err += s; } },
    );
    expect(called).toBe(false);                  // 外部プロセスは起動しない
    expect(ret).toBeNull();
    expect(out).toContain('SUBAGENT_DIFF');      // 差分本文が stdout に乗る
    expect(out).toContain('CHECKLIST_MARKER');   // 観点も stdout に乗る
    expect(out).toContain(REVIEW_ONLY_INSTRUCTION);
    expect(out).not.toContain(FIX_INSTRUCTION);
    expect(err).toMatch(/サブエージェント/);      // 人向け通知は stderr 側に分離
  });

  it('subagent --fix: stdout のプロンプトに修正指示を含める', () => {
    const spawnFn = () => { throw new Error('subagent では spawn してはいけない'); };
    const gitRun = (args) => (args[0] === 'diff' && args[1] === 'HEAD' ? 'FIX_DIFF\n' : '');
    let out = '';
    runReview(
      { reviewer: 'subagent', mode: 'uncommitted', fix: true },
      { ...isolated(), gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', out: (s) => { out += s; }, exists: () => false, err: () => {} },
    );
    expect(out).toContain('FIX_DIFF');
    expect(out).toContain(FIX_INSTRUCTION);
    expect(out).not.toContain(REVIEW_ONLY_INSTRUCTION);
  });

  it('差分が空ならレビュアーを起動しない', () => {
    let called = false;
    const spawnFn = () => { called = true; return null; };
    const gitRun = () => '';
    const ret = runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', fix: false },
      { ...isolated(), gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', exists: () => false },
    );
    expect(called).toBe(false);
    expect(ret).toBeNull();
  });

  it('差分サイズが閾値超過なら spawn せず exitCode 1、回避策入りエラーを stderr に出す', () => {
    let called = false;
    const spawnFn = () => { called = true; return null; };
    // fetch/rev-parse は '' を返し、diff に大きな本文を返す。
    const big = 'x'.repeat(2 * 1024); // 2KB
    const gitRun = (args) => (args[0] === 'diff' ? big : '');
    let err = '';
    process.exitCode = 0;
    const ret = runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', baseExplicit: false, fix: false, maxDiffKb: 1 },
      { ...isolated(), gitRun, spawnFn, checklist: 'CL', out: () => {}, exists: () => false, err: (s) => { err += s; } },
    );
    expect(called).toBe(false);
    expect(ret).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/閾値/);
    expect(err).toMatch(/--max-diff-kb/);   // 回避策
    expect(err).toMatch(/stale/);           // 原因の示唆
    process.exitCode = 0;
  });

  it('subagent でも閾値超過なら stdout にプロンプトを出さない', () => {
    const big = 'y'.repeat(2 * 1024);
    const gitRun = (args) => (args[0] === 'diff' ? big : '');
    let out = '';
    process.exitCode = 0;
    runReview(
      { reviewer: 'subagent', mode: 'base', baseRef: 'main', baseExplicit: false, fix: false, maxDiffKb: 1 },
      { ...isolated(), gitRun, spawnFn: () => { throw new Error('spawn してはいけない'); }, checklist: 'CL', out: (s) => { out += s; }, exists: () => false, err: () => {} },
    );
    expect(out).toBe('');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('閾値以下なら従来どおり動き、サイズ表示が stderr に出る (env で閾値解決)', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    const gitRun = (args) => (args[0] === 'diff' ? 'SMALL_DIFF\n' : '');
    let err = '';
    runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', baseExplicit: false, fix: false, maxDiffKb: null },
      { ...isolated(), gitRun, spawnFn, checklist: 'CL', out: () => {}, exists: () => false, err: (s) => { err += s; }, env: { CROSS_REVIEW_MAX_DIFF_KB: '256' } },
    );
    expect(captured.cmd).toBe('codex');
    expect(captured.stdin).toContain('SMALL_DIFF');
    expect(err).toMatch(/レビュー差分サイズ:/);
  });

  it('スコープ表記に解決後 base (origin/main) が反映される', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    // fetch '' / rev-parse はハッシュを返す → origin/main が採用される。
    const gitRun = (args) => {
      if (args[0] === 'rev-parse') return 'abc\n';
      if (args[0] === 'diff') return 'DIFF\n';
      return '';
    };
    runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', baseExplicit: false, fix: false, maxDiffKb: 0 },
      { ...isolated(), gitRun, spawnFn, checklist: 'CL', out: () => {}, exists: () => false, err: () => {} },
    );
    expect(captured.stdin).toContain('origin/main...HEAD');
  });

  it('巨大ファイル差分は stat 置換され、置換通知が stderr に出る', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    const bigBody = Array.from({ length: 2000 }, () => '+x').join('\n');
    const gitRun = (args) => {
      if (args[0] === 'diff' && !args.includes('--name-only')) return `diff --git a/big.js b/big.js\n${bigBody}\n`;
      return '';
    };
    let err = '';
    runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', baseExplicit: false, fix: false, maxDiffKb: 0, maxFileDiffKb: 1, noExclude: true },
      { ...isolated(), gitRun, spawnFn, checklist: 'CL', out: () => {}, exists: () => false, err: (s) => { err += s; } },
    );
    expect(captured.stdin).toContain('本文を省略');         // stat 要約に置換された
    expect(captured.stdin).not.toContain('+x');             // 本文は載らない
    expect(err).toMatch(/要約に置換/);                       // 置換通知
  });

  it('巨大 1 ファイルが置換で縮めば全体ガードを通る (置換後サイズで判定)', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    // 元は 4KB 超 (ガード 2KB を超える) だが、1KB 超で置換されると小さくなりガードを通る。
    const bigBody = Array.from({ length: 2000 }, () => '+x').join('\n');
    const gitRun = (args) => {
      if (args[0] === 'diff' && !args.includes('--name-only')) return `diff --git a/big.js b/big.js\n${bigBody}\n`;
      return '';
    };
    let called = false;
    process.exitCode = 0;
    runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', baseExplicit: false, fix: false, maxDiffKb: 2, maxFileDiffKb: 1, noExclude: true },
      { ...isolated(), gitRun, spawnFn: (...a) => { called = true; return spawnFn(...a); }, checklist: 'CL', out: () => {}, exists: () => false, err: () => {} },
    );
    expect(called).toBe(true);          // 置換で縮みガードを通過し spawn される
    expect(process.exitCode).toBe(0);
    process.exitCode = 0;
  });

  it('除外ファイルがあればプロンプトに除外一覧が乗る (deps.ignorePatterns 注入)', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    const gitRun = (args) => {
      if (args[0] === 'diff' && args.includes('--name-only')) {
        return args.includes(':/') ? 'kept.js\n' : 'kept.js\npackage-lock.json\n';
      }
      if (args[0] === 'diff') return 'KEPT_DIFF\n';
      return '';
    };
    runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', baseExplicit: false, fix: false, maxDiffKb: 0, maxFileDiffKb: 0 },
      { ...isolated(), gitRun, spawnFn, checklist: 'CL', ignorePatterns: ['package-lock.json'], out: () => {}, exists: () => false, err: () => {} },
    );
    expect(captured.stdin).toContain('レビュー対象外（除外済み）');
    expect(captured.stdin).toContain('- package-lock.json');
  });

  it('--no-exclude なら除外パススペックを git に渡さない', () => {
    const calls = [];
    const spawnFn = () => null;
    const gitRun = (args) => { calls.push(args); return args[0] === 'diff' ? 'DIFF\n' : ''; };
    runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', baseExplicit: true, fix: false, maxDiffKb: 0, maxFileDiffKb: 0, noExclude: true },
      { ...isolated(), gitRun, spawnFn, checklist: 'CL', ignorePatterns: ['package-lock.json'], out: () => {}, exists: () => false, err: () => {} },
    );
    const diffCall = calls.find((c) => c[0] === 'diff' && !c.includes('--name-only'));
    expect(diffCall).toEqual(['diff', 'main...HEAD']); // 除外指定が入らない (baseExplicit で origin/main 解決をスキップ)
  });

  it('subagent で差分が空なら stdout は空のまま、通知は stderr に出す (プロンプト契約を保つ)', () => {
    let out = '';
    let err = '';
    const ret = runReview(
      { reviewer: 'subagent', mode: 'base', baseRef: 'main', fix: false },
      { ...isolated(), gitRun: () => '', spawnFn: () => { throw new Error('起動しないはず'); }, checklist: 'CL', out: (s) => { out += s; }, exists: () => false, err: (s) => { err += s; } },
    );
    expect(ret).toBeNull();
    expect(out).toBe('');                    // stdout は空 (空通知をプロンプトと誤認させない)
    expect(err).toContain('差分がありません'); // 通知は stderr 側
  });

  // 状態ファイル (往復回数 / 直前レビュー SHA / 非対応指摘) の配線。
  const sha = 'f'.repeat(40);
  const stateGitRun = (extra = {}) => (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x\n';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${sha}\n`;
    if (args[0] === 'diff') return 'STATE_DIFF\n';
    if (Object.prototype.hasOwnProperty.call(extra, args[0])) return extra[args[0]];
    return '';
  };
  const stateOpts = (extra = {}) => ({
    reviewer: 'codex', mode: 'base', baseRef: 'main', baseExplicit: true, fix: false, maxDiffKb: 0, ...extra,
  });

  it('レビュアーが正常終了したら往復を 1 増やし、直前レビュー SHA を記録する', () => {
    const mem = memoryState();
    process.exitCode = 0;
    runReview(stateOpts(), {
      ...mem,
      gitRun: stateGitRun(),
      spawnFn: (cmd, args, stdin, onExit) => { settle(onExit, { code: 0 }); return null; },
      checklist: 'CL',
      out: () => {},
      err: () => {},
      exists: () => false,
    });
    expect(mem.store.writes).toHaveLength(1);
    expect(branchStateOf(mem.store.state, 'feat/x')).toEqual({ round: 1, lastReviewedSha: sha, dismissed: [] });
    process.exitCode = 0;
  });

  it('--uncommitted は往復だけ増やし、直前レビュー SHA を更新しない', () => {
    const mem = memoryState({ branches: { 'feat/x': { round: 1, lastReviewedSha: sha, dismissed: [] } } });
    process.exitCode = 0;
    runReview(stateOpts({ mode: 'uncommitted' }), {
      ...mem,
      gitRun: (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x\n';
        if (args[0] === 'diff' && args[1] === 'HEAD') return 'UNCOMMITTED_DIFF\n';
        if (args[0] === 'rev-parse') throw new Error('--uncommitted では HEAD の SHA を取らない');
        return '';
      },
      spawnFn: (cmd, args, stdin, onExit) => { settle(onExit, { code: 0 }); return null; },
      checklist: 'CL',
      out: () => {},
      err: () => {},
      exists: () => false,
    });
    expect(branchStateOf(mem.store.state, 'feat/x')).toEqual({ round: 2, lastReviewedSha: sha, dismissed: [] });
    process.exitCode = 0;
  });

  it('差分が無ければ往復を数えない', () => {
    const mem = memoryState();
    runReview(stateOpts(), {
      ...mem,
      gitRun: (args) => (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'feat/x\n' : ''),
      spawnFn: () => null,
      checklist: 'CL',
      out: () => {},
      err: () => {},
      exists: () => false,
    });
    expect(mem.store.writes).toEqual([]);
  });

  it('ガード中断でも往復を数えない', () => {
    const mem = memoryState();
    process.exitCode = 0;
    runReview(stateOpts({ maxDiffKb: 1, maxFileDiffKb: 0 }), {
      ...mem,
      gitRun: (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x\n';
        if (args[0] === 'rev-parse') return `${sha}\n`;
        return args[0] === 'diff' ? 'z'.repeat(2 * 1024) : '';
      },
      spawnFn: () => { throw new Error('起動しないはず'); },
      checklist: 'CL',
      out: () => {},
      err: () => {},
      exists: () => false,
    });
    expect(mem.store.writes).toEqual([]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('--no-state なら状態ファイルを読み書きしない', () => {
    const mem = memoryState();
    runReview(stateOpts({ noState: true }), {
      ...mem,
      readState: () => { throw new Error('--no-state では読まない'); },
      gitRun: stateGitRun(),
      spawnFn: () => null,
      checklist: 'CL',
      out: () => {},
      err: () => {},
      exists: () => false,
    });
    expect(mem.store.writes).toEqual([]);
  });

  it('状態ファイルが壊れていれば警告して無視し、書き戻さない', () => {
    const mem = memoryState({ branches: {} }, { corrupt: true });
    let err = '';
    process.exitCode = 0;
    runReview(stateOpts(), {
      ...mem,
      gitRun: stateGitRun(),
      spawnFn: (cmd, args, stdin, onExit) => { settle(onExit, { code: 0 }); return null; },
      checklist: 'CL',
      out: () => {},
      err: (s) => { err += s; },
      exists: () => false,
    });
    expect(err).toMatch(/JSON 不正/);
    expect(mem.store.writes).toEqual([]);
    process.exitCode = 0;
  });

  it('非対応と判断した指摘はプロンプトへ「再指摘しない」節として乗る', () => {
    const captured = {};
    const mem = memoryState({
      branches: { 'feat/x': { round: 1, lastReviewedSha: null, dismissed: ['運用上到達しない入力への指摘'] } },
    });
    runReview(stateOpts(), {
      ...mem,
      gitRun: stateGitRun(),
      spawnFn: (cmd, args, stdin) => { Object.assign(captured, { stdin }); return null; },
      checklist: 'CL',
      instructions: '申し送り本文',
      out: () => {},
      err: () => {},
      exists: () => false,
    });
    expect(captured.stdin).toContain(DISMISSED_HEADER);
    expect(captured.stdin).toContain('- 運用上到達しない入力への指摘');
    // 観点 → 申し送り → 非対応指摘 → 差分 の順を保つ。
    expect(captured.stdin.indexOf('CL')).toBeLessThan(captured.stdin.indexOf('申し送り本文'));
    expect(captured.stdin.indexOf('申し送り本文')).toBeLessThan(captured.stdin.indexOf(DISMISSED_HEADER));
    expect(captured.stdin.indexOf(DISMISSED_HEADER)).toBeLessThan(captured.stdin.indexOf('STATE_DIFF'));
  });

  it('3 往復目の実行は起動前に警告を出す (実行は止めない)', () => {
    let err = '';
    let called = false;
    const mem = memoryState({ branches: { 'feat/x': { round: 2, lastReviewedSha: null, dismissed: [] } } });
    process.exitCode = 0;
    runReview(stateOpts(), {
      ...mem,
      gitRun: stateGitRun(),
      spawnFn: (cmd, args, stdin, onExit) => { called = true; settle(onExit, { code: 0 }); return null; },
      checklist: 'CL',
      out: () => {},
      err: (s) => { err += s; },
      exists: () => false,
    });
    expect(err).toMatch(/往復は 3 回目/);
    expect(called).toBe(true);
    expect(branchStateOf(mem.store.state, 'feat/x').round).toBe(3);
    process.exitCode = 0;
  });

  it('往復 2 回目は既定 base に前回レビュー SHA を使い、その旨を出す', () => {
    const captured = {};
    let err = '';
    const mem = memoryState({ branches: { 'feat/x': { round: 1, lastReviewedSha: sha, dismissed: [] } } });
    runReview(stateOpts({ baseExplicit: false }), {
      ...mem,
      gitRun: (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x\n';
        if (args[0] === 'rev-parse') return `${sha}\n`;
        if (args[0] === 'cat-file') return '';        // 前回 SHA は現存する
        if (args[0] === 'diff') return 'INCREMENTAL_DIFF\n';
        return '';
      },
      spawnFn: (cmd, args, stdin) => { Object.assign(captured, { stdin }); return null; },
      checklist: 'CL',
      out: () => {},
      err: (s) => { err += s; },
      exists: () => false,
    });
    expect(captured.stdin).toContain(`${sha}...HEAD`);   // スコープ表記に前回 SHA が入る
    expect(err).toMatch(/往復 2 回目/);
    expect(err).toMatch(/base: fffffff \(前回レビュー時の SHA\)/); // 差分サイズと同じ行に解決方法を出す
  });

  // 差分サイズガードの段階的縮退。
  const bigFileDiff = (name, kb) => [`diff --git a/${name} b/${name}`, `+${'x'.repeat(kb * 1024)}`].join('\n');

  it('閾値超過はファイル要約の閾値を下げて縮退し、通知したうえで続行する', () => {
    const captured = {};
    let err = '';
    const body = [bigFileDiff('a.txt', 20), bigFileDiff('b.txt', 20)].join('\n');
    runReview(stateOpts({ maxDiffKb: 1, maxFileDiffKb: 64 }), {
      ...isolated(),
      gitRun: (args) => (args[0] === 'diff' ? body : ''),
      spawnFn: (cmd, args, stdin) => { Object.assign(captured, { stdin }); return null; },
      checklist: 'CL',
      out: () => {},
      err: (s) => { err += s; },
      exists: () => false,
    });
    expect(captured.stdin).toContain('本文を省略');
    expect(err).toMatch(/要約閾値を 16KB へ下げて 2 件/);
    expect(err).not.toMatch(/レビュアーを起動せず中断/);
  });

  it('--strict-diff-guard は縮退を試さず従来どおり即中断する', () => {
    let err = '';
    const body = [bigFileDiff('a.txt', 20), bigFileDiff('b.txt', 20)].join('\n');
    process.exitCode = 0;
    runReview(stateOpts({ maxDiffKb: 1, maxFileDiffKb: 64, strictDiffGuard: true }), {
      ...isolated(),
      gitRun: (args) => (args[0] === 'diff' ? body : ''),
      spawnFn: () => { throw new Error('起動しないはず'); },
      checklist: 'CL',
      out: () => {},
      err: (s) => { err += s; },
      exists: () => false,
    });
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/--strict-diff-guard 指定のため/);
    process.exitCode = 0;
  });

  it('縮退しても収まらなければ、試した閾値を添えて中断する', () => {
    let err = '';
    const body = Array.from({ length: 40 }, (_, i) => bigFileDiff(`f${i}.txt`, 20)).join('\n');
    process.exitCode = 0;
    runReview(stateOpts({ maxDiffKb: 1, maxFileDiffKb: 64 }), {
      ...isolated(),
      gitRun: (args) => (args[0] === 'diff' ? body : ''),
      spawnFn: () => { throw new Error('起動しないはず'); },
      checklist: 'CL',
      out: () => {},
      err: (s) => { err += s; },
      exists: () => false,
    });
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/32KB → 16KB → 8KB まで下げても収まりませんでした/);
    process.exitCode = 0;
  });

  it('--max-file-diff-kb 0 (要約無効) では縮退を試さない', () => {
    let err = '';
    process.exitCode = 0;
    runReview(stateOpts({ maxDiffKb: 1, maxFileDiffKb: 0 }), {
      ...isolated(),
      gitRun: (args) => (args[0] === 'diff' ? bigFileDiff('a.txt', 20) : ''),
      spawnFn: () => { throw new Error('起動しないはず'); },
      checklist: 'CL',
      out: () => {},
      err: (s) => { err += s; },
      exists: () => false,
    });
    expect(process.exitCode).toBe(1);
    expect(err).toMatch(/--max-file-diff-kb 0/);
    process.exitCode = 0;
  });

  // 利用上限のフォールバックと bridge 未導入時の再起動は spawnFn の onExit を差し替えて検証する。
  // 共通の配線: bridge を「有る」ことにし、差分・観点・書き出し先をすべて注入する。
  const bridgeScriptPath = path.join('/home/u', '.claude', 'tools', 'codex-agent.sh');
  // bridge 経由はスクリプトが approval_policy=never を明示している場合に限るので、既定では明示済みにする。
  const bridgeScriptText = 'codex exec --sandbox "$codex_sandbox" -c approval_policy=never -\n';
  const agentDefText = (sandbox) => `---\ncodex_home: ~/.codex\ncodex_model: gpt-5.6-sol\ncodex_sandbox: ${sandbox}\n---\n\n役割\n`;
  const bridgeDeps = (extra = {}) => {
    const files = { [bridgeScriptPath]: bridgeScriptText, ...(extra.files || {}) };
    const rest = { ...extra };
    delete rest.files;
    return {
      ...isolated(),
      gitRun: (args) => (args[0] === 'diff' ? 'LIMIT_DIFF\n' : ''),
      checklist: 'CL',
      out: () => {},
      err: () => {},
      // 擬似ファイル系のみ「存在する」扱いにする (定義ファイルの既定は不在 = 検査をスキップ)。
      exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
      readFile: (p) => {
        if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
      env: {},
      homedir: '/home/u',
      cwd: '/repo',
      tmpdir: '/tmp',
      pid: 7,
      ...rest,
    };
  };
  const limitOpts = (extra = {}) => ({
    reviewer: 'codex',
    mode: 'base',
    baseRef: 'main',
    baseExplicit: true,
    fix: false,
    maxDiffKb: 0,
    maxFileDiffKb: 0,
    noExclude: true,
    ...extra,
  });
  const fallbackPath = path.join('/tmp', 'cross-review-fallback-7.md');

  it('bridge 経由の利用上限 (終了コード 75) は代替プロンプトを書き出し exitCode 75 で終える', () => {
    const calls = [];
    const written = {};
    let err = '';
    const spawnFn = (cmd, args, stdin, onExit) => {
      calls.push({ cmd, args, stdin });
      settle(onExit, { code: USAGE_LIMIT_EXIT_CODE });
      return null;
    };
    process.exitCode = 0;
    runReview(limitOpts(), bridgeDeps({
      spawnFn,
      err: (s) => { err += s; },
      writeFile: (p, body) => { written[p] = body; },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bash');
    expect(calls[0].args).toContain(CODEX_AGENT_REVIEW_NAME);
    expect(process.exitCode).toBe(USAGE_LIMIT_EXIT_CODE);
    expect(written[fallbackPath]).toContain('LIMIT_DIFF'); // subagent と同じプロンプト本文
    expect(written[fallbackPath]).toContain('CL');
    expect(err).toMatch(/利用上限/);
    expect(err).toContain(fallbackPath);
    process.exitCode = 0;
  });

  it('直接起動は非ゼロ終了 + 出力の上限メッセージでフォールバックする', () => {
    const written = {};
    const spawnFn = (cmd, args, stdin, onExit) => {
      settle(onExit, { code: 1, outputTail: 'error: You have hit your usage limit.' });
      return null;
    };
    process.exitCode = 0;
    runReview(limitOpts(), bridgeDeps({
      spawnFn,
      exists: () => false, // bridge 不在 → codex を直接起動する経路
      writeFile: (p, body) => { written[p] = body; },
    }));
    expect(process.exitCode).toBe(USAGE_LIMIT_EXIT_CODE);
    expect(written[fallbackPath]).toContain('LIMIT_DIFF');
    process.exitCode = 0;
  });

  it('--no-fallback なら代替プロンプトを書かず、レビュアーの終了コードを維持する', () => {
    let wrote = false;
    const spawnFn = (cmd, args, stdin, onExit) => {
      settle(onExit, { code: USAGE_LIMIT_EXIT_CODE });
      return null;
    };
    process.exitCode = 0;
    runReview(limitOpts({ noFallback: true }), bridgeDeps({
      spawnFn,
      writeFile: () => { wrote = true; },
    }));
    expect(wrote).toBe(false);
    expect(process.exitCode).toBe(USAGE_LIMIT_EXIT_CODE); // 上限のまま失敗終了する
    process.exitCode = 0;
  });

  it('--no-fallback は上限以外の失敗でも終了コードを維持する', () => {
    let wrote = false;
    const spawnFn = (cmd, args, stdin, onExit) => {
      settle(onExit, { code: 1, outputTail: 'error: something broke' });
      return null;
    };
    process.exitCode = 0;
    runReview(limitOpts({ noFallback: true }), bridgeDeps({
      spawnFn,
      exists: () => false, // 直接起動の経路 (出力から上限を判定する側)
      writeFile: () => { wrote = true; },
    }));
    expect(wrote).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('--fallback-prompt の指定先へ書き出す', () => {
    const written = {};
    const spawnFn = (cmd, args, stdin, onExit) => {
      settle(onExit, { code: USAGE_LIMIT_EXIT_CODE });
      return null;
    };
    process.exitCode = 0;
    runReview(limitOpts({ fallbackPromptPath: 'my-fallback.md' }), bridgeDeps({
      spawnFn,
      writeFile: (p, body) => { written[p] = body; },
    }));
    expect(Object.keys(written)).toEqual(['my-fallback.md']);
    expect(process.exitCode).toBe(USAGE_LIMIT_EXIT_CODE);
    process.exitCode = 0;
  });

  it('bridge 未導入 (終了コード 3) なら同じプロンプトで直接起動へ切り替える', () => {
    const calls = [];
    let err = '';
    const spawnFn = (cmd, args, stdin, onExit) => {
      calls.push({ cmd, args, stdin });
      // 1 回目 (bridge) は未導入、2 回目 (直接起動) は正常終了。
      settle(onExit, calls.length === 1 ? { code: CODEX_AGENT_EXIT_MISSING } : { code: 0 });
      return null;
    };
    process.exitCode = 0;
    runReview(limitOpts(), bridgeDeps({
      spawnFn,
      err: (s) => { err += s; },
      writeFile: () => { throw new Error('未導入では代替プロンプトを書かない'); },
    }));
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('bash');
    expect(calls[1].cmd).toBe('codex');
    expect(calls[1].args).toEqual(['exec', '-s', 'read-only', '-c', 'approval_policy=never', '-']);
    expect(calls[1].stdin).toBe(calls[0].stdin); // プロンプトは組み立て直さない
    expect(err).toMatch(/直接起動へ切り替え/);
    expect(process.exitCode).toBe(0); // 直接起動が成功したので正常終了
  });

  it('bash が無い (ENOENT) 場合も直接起動へ切り替える', () => {
    const calls = [];
    const spawnFn = (cmd, args, stdin, onExit) => {
      calls.push({ cmd });
      settle(onExit, calls.length === 1
        ? { code: 1, error: { code: 'ENOENT' } }
        : { code: 0 });
      return null;
    };
    process.exitCode = 0;
    runReview(limitOpts(), bridgeDeps({ spawnFn }));
    expect(calls.map((c) => c.cmd)).toEqual(['bash', 'codex']);
  });

  it('claude 経路は上限フォールバックの対象外 (従来どおり失敗終了)', () => {
    let wrote = false;
    const calls = [];
    const spawnFn = (cmd, args, stdin, onExit) => {
      calls.push(cmd);
      settle(onExit, { code: 1, outputTail: 'usage limit reached' });
      return null;
    };
    process.exitCode = 0;
    runReview(limitOpts({ reviewer: 'claude' }), bridgeDeps({
      spawnFn,
      writeFile: () => { wrote = true; },
    }));
    expect(calls).toEqual(['claude']); // フォールバックも直接起動への切り替えも起きない
    expect(wrote).toBe(false);
    expect(process.exitCode).toBe(1); // レビュアーの終了コードがそのまま残る
    process.exitCode = 0;
  });

  // 定義ファイルの codex_sandbox 検査 (レビューのみで書き込み可能な定義を使わせない)。
  it('レビューのみで workspace-write の定義なら spawn せず exitCode 2 で止める', () => {
    let called = false;
    let err = '';
    process.exitCode = 0;
    runReview(limitOpts(), bridgeDeps({
      files: { [path.join('/home/u', '.claude', 'gpt-agents', `${CODEX_AGENT_REVIEW_NAME}.md`)]: agentDefText('workspace-write') },
      spawnFn: () => { called = true; return null; },
      err: (s) => { err += s; },
    }));
    expect(called).toBe(false);
    expect(process.exitCode).toBe(2);
    expect(err).toMatch(/codex_sandbox/);
    process.exitCode = 0;
  });

  it('定義ファイルが無ければ検査せず bridge 経由で起動する', () => {
    const calls = [];
    process.exitCode = 0;
    runReview(limitOpts(), bridgeDeps({
      spawnFn: (cmd, args, stdin, onExit) => {
        calls.push({ cmd, args });
        settle(onExit, { code: 0 });
        return null;
      },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bash');
    expect(calls[0].args).toContain(CODEX_AGENT_REVIEW_NAME);
    expect(process.exitCode).toBe(0);
  });

  // 承認 never 固定の検査 (bridge が明示していなければ直接起動へ戻す)。
  it('スクリプトが approval_policy=never を明示していなければ直接起動で走らせ、警告を出す', () => {
    const calls = [];
    let err = '';
    process.exitCode = 0;
    runReview(limitOpts(), bridgeDeps({
      files: { [bridgeScriptPath]: 'codex exec --sandbox "$codex_sandbox" -\n' },
      spawnFn: (cmd, args, stdin, onExit) => {
        calls.push({ cmd, args });
        settle(onExit, { code: 0 });
        return null;
      },
      err: (s) => { err += s; },
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('codex');
    expect(calls[0].args).toEqual(['exec', '-s', 'read-only', '-c', 'approval_policy=never', '-']);
    expect(err).toMatch(/approval_policy=never/);
    expect(err).toMatch(/claude-codex-bridge #16/);
  });

  // 往復を数えるタイミング。起動しただけで数えると、失敗時の SHA が次回の base になり
  // 「差分なし」で再試行できなくなるので、レビューが成立した結果でのみ数える。
  describe('往復を数えるタイミング', () => {
    const recordDeps = (mem, extra = {}) => ({
      ...mem,
      gitRun: stateGitRun(),
      checklist: 'CL',
      out: () => {},
      err: () => {},
      exists: () => false, // bridge 不在 = codex を直接起動する経路
      tmpdir: '/tmp',
      pid: 7,
      ...extra,
    });

    it('起動に失敗したら (ENOENT) 往復を数えない', () => {
      const mem = memoryState();
      process.exitCode = 0;
      runReview(stateOpts(), recordDeps(mem, {
        spawnFn: (cmd, args, stdin, onExit) => {
          settle(onExit, { code: 1, error: { code: 'ENOENT' } });
          return null;
        },
        writeFile: () => { throw new Error('上限ではないので代替プロンプトは書かない'); },
      }));
      expect(mem.store.writes).toEqual([]);
      process.exitCode = 0;
    });

    it('非ゼロ終了 (フォールバック無し) では往復を数えない', () => {
      const mem = memoryState();
      process.exitCode = 0;
      runReview(stateOpts(), recordDeps(mem, {
        spawnFn: (cmd, args, stdin, onExit) => {
          settle(onExit, { code: 1, outputTail: 'error: something broke' });
          return null;
        },
        writeFile: () => { throw new Error('上限ではないので代替プロンプトは書かない'); },
      }));
      expect(mem.store.writes).toEqual([]);
      process.exitCode = 0;
    });

    it('--no-fallback の上限失敗でも往復を数えない', () => {
      const mem = memoryState();
      process.exitCode = 0;
      runReview(stateOpts({ noFallback: true }), recordDeps(mem, {
        spawnFn: (cmd, args, stdin, onExit) => {
          settle(onExit, { code: 1, outputTail: 'usage limit reached' });
          return null;
        },
        writeFile: () => { throw new Error('--no-fallback では代替プロンプトを書かない'); },
      }));
      expect(mem.store.writes).toEqual([]);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    });

    it('正常終了 (0) なら往復を数える', () => {
      const mem = memoryState();
      process.exitCode = 0;
      runReview(stateOpts(), recordDeps(mem, {
        spawnFn: (cmd, args, stdin, onExit) => { settle(onExit, { code: 0 }); return null; },
      }));
      expect(mem.store.writes).toHaveLength(1);
      expect(branchStateOf(mem.store.state, 'feat/x')).toEqual({ round: 1, lastReviewedSha: sha, dismissed: [] });
      process.exitCode = 0;
    });

    // CLI はサブエージェントがレビューを終えたかを観測できない。書き出した時点で数えると、
    // プロンプトを渡さずに再実行したとき未レビューの差分が「差分なし」になってしまう。
    it('利用上限の代替プロンプトを書き出しても往復を数えない (記録は state --mark で行う)', () => {
      const mem = memoryState();
      const written = {};
      let err = '';
      process.exitCode = 0;
      runReview(stateOpts({ fallbackPromptPath: 'fb.md' }), recordDeps(mem, {
        spawnFn: (cmd, args, stdin, onExit) => {
          settle(onExit, { code: 1, outputTail: 'You have hit your usage limit.' });
          return null;
        },
        writeFile: (p, body) => { written[p] = body; },
        err: (s) => { err += s; },
      }));
      expect(Object.keys(written)).toEqual(['fb.md']);
      expect(mem.store.writes).toEqual([]);
      expect(err).toMatch(/state --mark/); // 記録の手順を案内する
      expect(err).not.toMatch(/state --mark --uncommitted/); // コミット済み差分のレビューなら SHA を進めてよい
      expect(process.exitCode).toBe(USAGE_LIMIT_EXIT_CODE);
      process.exitCode = 0;
    });

    it('--uncommitted のレビューが利用上限で代替になったら、案内は state --mark --uncommitted にする', () => {
      const mem = memoryState();
      let err = '';
      process.exitCode = 0;
      runReview(stateOpts({ mode: 'uncommitted', baseRef: 'HEAD', fallbackPromptPath: 'fb.md' }), recordDeps(mem, {
        spawnFn: (cmd, args, stdin, onExit) => {
          settle(onExit, { code: 1, outputTail: 'You have hit your usage limit.' });
          return null;
        },
        writeFile: () => {},
        err: (s) => { err += s; },
      }));
      expect(err).toMatch(/state --mark --uncommitted/);
      process.exitCode = 0;
    });

    it('bridge 未導入 → 直接起動が成功した場合は 1 回だけ数える', () => {
      const mem = memoryState();
      const calls = [];
      process.exitCode = 0;
      runReview(stateOpts(), bridgeDeps({
        ...mem,
        gitRun: stateGitRun(),
        spawnFn: (cmd, args, stdin, onExit) => {
          calls.push(cmd);
          settle(onExit, calls.length === 1 ? { code: CODEX_AGENT_EXIT_MISSING } : { code: 0 });
          return null;
        },
      }));
      expect(calls).toEqual(['bash', 'codex']);
      expect(mem.store.writes).toHaveLength(1);
      expect(branchStateOf(mem.store.state, 'feat/x').round).toBe(1);
      process.exitCode = 0;
    });

    // レビュアーの実行中に別プロセスが状態ファイルを書くことがある。起動前のスナップショットを
    // 基に書き戻すとその更新が消えるので、書く直前に読み直した状態へ遷移を適用する。
    it('書き込み直前に状態を読み直し、実行中に入った他プロセスの更新を保つ', () => {
      const before = { branches: { 'feat/x': { round: 0, lastReviewedSha: null, dismissed: [] } } };
      // 起動後に別プロセスが「他の枝のレビュー完了」と「現在の枝への dismiss」を書いた状態。
      const during = {
        branches: {
          'feat/x': { round: 0, lastReviewedSha: null, dismissed: ['実行中に登録された指摘'] },
          other: { round: 5, lastReviewedSha: 'c'.repeat(40), dismissed: [] },
        },
      };
      const reads = [before, during];
      const writes = [];
      process.exitCode = 0;
      runReview(stateOpts(), recordDeps({}, {
        readState: () => ({ path: '<test-state>', state: reads.shift() || during, corrupt: false }),
        writeState: (next) => { writes.push(next); return true; },
        ghRun: () => null,
        spawnFn: (cmd, args, stdin, onExit) => { settle(onExit, { code: 0 }); return null; },
      }));
      expect(writes).toHaveLength(1);
      expect(writes[0].branches.other).toEqual({ round: 5, lastReviewedSha: 'c'.repeat(40), dismissed: [] });
      expect(branchStateOf(writes[0], 'feat/x')).toEqual({
        round: 1, lastReviewedSha: sha, dismissed: ['実行中に登録された指摘'],
      });
      process.exitCode = 0;
    });

    it('読み直しで状態ファイルが壊れていたら往復を記録しない', () => {
      const writes = [];
      let err = '';
      let reads = 0;
      process.exitCode = 0;
      runReview(stateOpts(), recordDeps({}, {
        readState: () => {
          reads += 1;
          return { path: '<test-state>', state: { branches: {} }, corrupt: reads > 1 };
        },
        writeState: (next) => { writes.push(next); return true; },
        ghRun: () => null,
        spawnFn: (cmd, args, stdin, onExit) => { settle(onExit, { code: 0 }); return null; },
        err: (s) => { err += s; },
      }));
      expect(writes).toEqual([]);
      expect(err).toMatch(/往復を記録しません/);
      process.exitCode = 0;
    });

    it('subagent はプロンプトを出力した時点で往復を数える', () => {
      const mem = memoryState();
      runReview(stateOpts({ reviewer: 'subagent' }), recordDeps(mem, {
        spawnFn: () => { throw new Error('subagent では spawn してはいけない'); },
        out: () => {},
      }));
      expect(mem.store.writes).toHaveLength(1);
      expect(branchStateOf(mem.store.state, 'feat/x')).toEqual({ round: 1, lastReviewedSha: sha, dismissed: [] });
    });
  });
});
