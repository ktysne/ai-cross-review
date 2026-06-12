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
  collectReviewDiff,
  resolveBaseRef,
  resolveMaxDiffKb,
  buildReviewPrompt,
  runReview,
  loadChecklist,
  loadInstructions,
  resolveReviewerCommandForSpawn,
  CHECKLIST_FILENAME,
  GENERIC_CHECKLIST,
  REVIEW_ONLY_INSTRUCTION,
  FIX_INSTRUCTION,
  REVIEWER_NOTES_HEADER,
} = require('../tools/cross-review.js');

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

  it('未知のレビュアーはエラー', () => {
    expect(parseArgs(['gemini']).error).toMatch(/codex/);
    expect(parseArgs([]).error).toMatch(/codex/);
  });

  it('不明なオプションはエラー', () => {
    expect(parseArgs(['codex', '--bogus']).error).toMatch(/不明なオプション/);
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
  it('codex レビューのみは codex を read-only で起動する', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: false });
    expect(inv.cmd).toBe('codex');
    expect(inv.args).toEqual(['exec', '-s', 'read-only', '-c', 'approval_policy=never', '-']);
  });

  it('codex --fix は workspace-write で起動し、編集する旨を通知する', () => {
    const inv = reviewerInvocation({ reviewer: 'codex', fix: true });
    expect(inv.cmd).toBe('codex');
    expect(inv.args).toEqual(['exec', '-s', 'workspace-write', '-c', 'approval_policy=never', '-']);
    expect(inv.notice).toMatch(/修正/);
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
    expect(out).toBe('BASE_DIFF');
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
    const out = collectReviewDiff({ mode: 'uncommitted' }, fakeGit);
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
    expect(collectReviewDiff({ mode: 'uncommitted' }, fakeGit)).toBe('TRACKED_ONLY');
  });

  it('uncommitted で --instructions の申し送りファイルは untracked 差分から除外する', () => {
    const fakeGit = (args) => {
      if (args[0] === 'diff' && args[1] === 'HEAD') return '';
      if (args[0] === 'ls-files') return 'review-notes.md\0real-new.js\0';
      if (args[0] === 'diff' && args[3] === '/dev/null') return `NEWFILE(${args[4]})\n`;
      return '';
    };
    // instructionsPath と untracked 候補は同一相対パス文字列なので path.resolve 後も一致し、除外される。
    const out = collectReviewDiff({ mode: 'uncommitted', instructionsPath: 'review-notes.md' }, fakeGit);
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
  it('--base 明示時は fetch も rev-parse も呼ばれず baseRef をそのまま返す', () => {
    const calls = [];
    const gitRun = (args) => { calls.push(args); return ''; };
    const out = resolveBaseRef({ mode: 'base', baseRef: 'develop', baseExplicit: true }, gitRun);
    expect(out).toBe('develop');
    expect(calls).toEqual([]); // git は一切呼ばれない
  });

  it('uncommitted 時も git を呼ばず baseRef をそのまま返す', () => {
    const calls = [];
    const gitRun = (args) => { calls.push(args); return ''; };
    const out = resolveBaseRef({ mode: 'uncommitted', baseRef: 'main', baseExplicit: false }, gitRun);
    expect(out).toBe('main');
    expect(calls).toEqual([]);
  });

  it('fetch 失敗でも origin/main が verify できれば origin/main を返す', () => {
    const gitRun = (args) => {
      if (args[0] === 'fetch') return null;           // fetch 失敗 (allowFailure で null)
      if (args[0] === 'rev-parse') return 'abc123\n'; // origin/main は verify できる
      return '';
    };
    const out = resolveBaseRef({ mode: 'base', baseRef: 'main', baseExplicit: false }, gitRun);
    expect(out).toBe('origin/main');
  });

  it('origin/main が verify できなければ main を返す', () => {
    const gitRun = (args) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return null; // origin/main 無し
      return '';
    };
    const out = resolveBaseRef({ mode: 'base', baseRef: 'main', baseExplicit: false }, gitRun);
    expect(out).toBe('main');
  });

  it('fetch 失敗時は stderr に警告を出す', () => {
    let err = '';
    const gitRun = (args) => (args[0] === 'fetch' ? null : null);
    resolveBaseRef(
      { mode: 'base', baseRef: 'main', baseExplicit: false },
      gitRun,
      { err: (s) => { err += s; } },
    );
    expect(err).toMatch(/取得に失敗/);
  });

  it('origin/main 採用時は stderr に通知を出す', () => {
    let err = '';
    const gitRun = (args) => (args[0] === 'rev-parse' ? 'abc\n' : '');
    resolveBaseRef(
      { mode: 'base', baseRef: 'main', baseExplicit: false },
      gitRun,
      { err: (s) => { err += s; } },
    );
    expect(err).toMatch(/origin\/main/);
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
  // codex 経路でも「観点 + 差分本文 + モード指示」を stdin に渡す配線を固定する。
  // 旧挙動 (codex に観点だけ渡す) への退行を検知するための結合テスト。
  it('codex レビューのみ: read-only + 差分本文 + 観点 + レビューのみ指示を stdin に渡す', () => {
    const captured = {};
    const spawnFn = (cmd, args, stdin) => { Object.assign(captured, { cmd, args, stdin }); return null; };
    const gitRun = (args) => (args[0] === 'diff' ? 'diff --git a/x b/x\n+changed\n' : '');
    runReview(
      { reviewer: 'codex', mode: 'base', baseRef: 'main', fix: false },
      { gitRun, spawnFn, checklist: 'CHECKLIST_MARKER' },
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
      { gitRun, spawnFn, checklist: 'CHECKLIST_MARKER' },
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
      { gitRun, spawnFn, checklist: 'CHECKLIST_MARKER' },
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
      { gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', instructions: 'レビュアーの指摘: X を直す' },
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
      { gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', out: (s) => { out += s; }, err: (s) => { err += s; } },
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
      { gitRun, spawnFn, checklist: 'CHECKLIST_MARKER', out: (s) => { out += s; }, err: () => {} },
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
      { gitRun, spawnFn, checklist: 'CHECKLIST_MARKER' },
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
      { gitRun, spawnFn, checklist: 'CL', out: () => {}, err: (s) => { err += s; } },
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
      { gitRun, spawnFn: () => { throw new Error('spawn してはいけない'); }, checklist: 'CL', out: (s) => { out += s; }, err: () => {} },
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
      { gitRun, spawnFn, checklist: 'CL', out: () => {}, err: (s) => { err += s; }, env: { CROSS_REVIEW_MAX_DIFF_KB: '256' } },
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
      { gitRun, spawnFn, checklist: 'CL', out: () => {}, err: () => {} },
    );
    expect(captured.stdin).toContain('origin/main...HEAD');
  });

  it('subagent で差分が空なら stdout は空のまま、通知は stderr に出す (プロンプト契約を保つ)', () => {
    let out = '';
    let err = '';
    const ret = runReview(
      { reviewer: 'subagent', mode: 'base', baseRef: 'main', fix: false },
      { gitRun: () => '', spawnFn: () => { throw new Error('起動しないはず'); }, checklist: 'CL', out: (s) => { out += s; }, err: (s) => { err += s; } },
    );
    expect(ret).toBeNull();
    expect(out).toBe('');                    // stdout は空 (空通知をプロンプトと誤認させない)
    expect(err).toContain('差分がありません'); // 通知は stderr 側
  });
});
