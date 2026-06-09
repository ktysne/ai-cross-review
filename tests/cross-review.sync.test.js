// tools/cross-review.sync.js の引数解析・マニフェスト検証・置換・同期プラン算出・同期/検査の
// 配線を検証する。実 git・一時ディレクトリ・実 I/O は外部依存なので、runSync は prepareUpstream /
// readFile / writeFile / exists を注入して書き込み内容と exit コードまで検証する。

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  parseArgs,
  loadManifest,
  validateManifest,
  applyReplacements,
  assertWithinRoot,
  computeSyncPlan,
  runSync,
} = require('../tools/cross-review.sync.js');

describe('sync parseArgs', () => {
  it('既定は sync モード', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'sync', dryRun: false, ref: null, error: null });
  });

  it('--check で検査モードに切り替わる', () => {
    expect(parseArgs(['--check'])).toMatchObject({ mode: 'check', error: null });
  });

  it('--dry-run を解釈する', () => {
    expect(parseArgs(['--dry-run'])).toMatchObject({ mode: 'sync', dryRun: true });
  });

  it('--ref <value> を解釈する', () => {
    expect(parseArgs(['--ref', 'v1.2.3'])).toMatchObject({ ref: 'v1.2.3', error: null });
  });

  it('--ref=<value> を解釈する', () => {
    expect(parseArgs(['--ref=develop'])).toMatchObject({ ref: 'develop', error: null });
  });

  it('--ref の値が無いとエラー', () => {
    expect(parseArgs(['--ref']).error).toMatch(/--ref/);
  });

  it('--manifest <path> を解釈する', () => {
    expect(parseArgs(['--manifest', 'cfg.json'])).toMatchObject({ manifestPath: 'cfg.json', error: null });
  });

  it('--manifest= の空値はエラー', () => {
    expect(parseArgs(['--manifest=']).error).toMatch(/--manifest/);
  });

  it('--root <path> を解釈する', () => {
    expect(parseArgs(['--root', '/proj'])).toMatchObject({ root: '/proj', error: null });
  });

  it('-h / --help でヘルプ', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('不明なオプションはエラー', () => {
    expect(parseArgs(['--nope']).error).toMatch(/不明なオプション/);
  });

  it('余計な位置引数はエラー', () => {
    expect(parseArgs(['extra']).error).toMatch(/不明な引数/);
  });
});

describe('sync validateManifest', () => {
  const valid = () => ({
    upstream: { repo: 'https://example.com/x.git', ref: 'main' },
    files: [{ from: 'a', to: 'b' }],
  });

  it('正常なマニフェストは通る', () => {
    expect(() => validateManifest(valid())).not.toThrow();
  });

  it('オブジェクトでないとエラー', () => {
    expect(() => validateManifest(null)).toThrow(/オブジェクト/);
    expect(() => validateManifest([])).toThrow(/オブジェクト/);
  });

  it('upstream が無いとエラー', () => {
    const m = valid();
    delete m.upstream;
    expect(() => validateManifest(m)).toThrow(/upstream/);
  });

  it('upstream.repo が無いとエラー', () => {
    const m = valid();
    delete m.upstream.repo;
    expect(() => validateManifest(m)).toThrow(/repo/);
  });

  it('upstream.ref が無くても --ref があれば通る', () => {
    const m = valid();
    delete m.upstream.ref;
    expect(() => validateManifest(m, 'main')).not.toThrow();
    expect(() => validateManifest(m)).toThrow(/ref/);
  });

  it('files が空だとエラー', () => {
    const m = valid();
    m.files = [];
    expect(() => validateManifest(m)).toThrow(/files/);
  });

  it('files エントリに from / to が無いとエラー', () => {
    const m = valid();
    m.files = [{ to: 'b' }];
    expect(() => validateManifest(m)).toThrow(/from/);
    m.files = [{ from: 'a' }];
    expect(() => validateManifest(m)).toThrow(/to/);
  });

  it('replace が配列でないとエラー', () => {
    const m = valid();
    m.files = [{ from: 'a', to: 'b', replace: 'x' }];
    expect(() => validateManifest(m)).toThrow(/replace/);
  });

  it('replace エントリの形が不正だとエラー', () => {
    const m = valid();
    m.files = [{ from: 'a', to: 'b', replace: [{ from: 'x' }] }];
    expect(() => validateManifest(m)).toThrow(/replace/);
  });
});

describe('sync applyReplacements', () => {
  it('置換が無ければそのまま', () => {
    expect(applyReplacements('abc', undefined)).toBe('abc');
    expect(applyReplacements('abc', [])).toBe('abc');
  });

  it('文字列リテラルとして全置換する (正規表現メタ文字を特別扱いしない)', () => {
    const src = "require('../tools/cross-review.js')\nrequire('../tools/cross-review.js')";
    const out = applyReplacements(src, [{ from: '../tools/cross-review.js', to: '../../tools/cross-review.js' }]);
    expect(out).toBe("require('../../tools/cross-review.js')\nrequire('../../tools/cross-review.js')");
  });

  it('複数の置換を順に適用する', () => {
    const out = applyReplacements('a b', [{ from: 'a', to: 'x' }, { from: 'b', to: 'y' }]);
    expect(out).toBe('x y');
  });
});

describe('sync assertWithinRoot', () => {
  it('ルート配下は通る', () => {
    expect(() => assertWithinRoot('/root', '/root/sub/file', 'x')).not.toThrow();
  });

  it('ルート自身はエラー (配下でない)', () => {
    expect(() => assertWithinRoot('/root', '/root', 'x')).toThrow(/外/);
  });

  it('ルートの外はエラー', () => {
    expect(() => assertWithinRoot('/root', '/etc/passwd', 'x')).toThrow(/外/);
    expect(() => assertWithinRoot('/root', '/root/../secret', 'x')).toThrow(/外/);
  });
});

// 仮想 FS (絶対パス -> 内容) を使い、実 I/O 無しで computeSyncPlan / runSync を検証する。
function makeFs(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    store,
    writes,
    readFile: (p) => {
      const key = path.resolve(p);
      if (!store.has(key)) throw new Error(`ENOENT: ${key}`);
      return store.get(key);
    },
    exists: (p) => store.has(path.resolve(p)),
    writeFile: (p, c) => { const key = path.resolve(p); store.set(key, c); writes.push({ path: key, content: c }); },
  };
}

describe('sync computeSyncPlan', () => {
  const manifest = {
    files: [
      { from: 'tools/cross-review.js', to: 'tools/cross-review.js' },
      { from: 'tests/cross-review.test.js', to: 'tests/tools/cross-review.test.js',
        replace: [{ from: '../tools/cross-review.js', to: '../../tools/cross-review.js' }] },
    ],
  };

  it('新規 / 更新 / 一致 を判定し、replace を expected に反映する', () => {
    const fsx = makeFs({
      '/up/tools/cross-review.js': 'ENGINE',
      '/up/tests/cross-review.test.js': "require('../tools/cross-review.js')",
      // 取り込み先: 1 つ目は一致、2 つ目は存在しない (新規)
      '/proj/tools/cross-review.js': 'ENGINE',
    });
    const plan = computeSyncPlan(manifest, '/up', '/proj', fsx);
    expect(plan[0]).toMatchObject({ to: 'tools/cross-review.js', status: 'unchanged' });
    expect(plan[1]).toMatchObject({ to: 'tests/tools/cross-review.test.js', status: 'create' });
    // replace 適用後の内容が expected になる
    expect(plan[1].expected).toBe("require('../../tools/cross-review.js')");
  });

  it('内容が違えば update', () => {
    const fsx = makeFs({
      '/up/tools/cross-review.js': 'NEW',
      '/up/tests/cross-review.test.js': 'x',
      '/proj/tools/cross-review.js': 'OLD',
      '/proj/tests/tools/cross-review.test.js': 'x',
    });
    const plan = computeSyncPlan(manifest, '/up', '/proj', fsx);
    expect(plan[0].status).toBe('update');
    expect(plan[1].status).toBe('unchanged');
  });

  it('上流にファイルが無ければエラー', () => {
    const fsx = makeFs({ '/up/tools/cross-review.js': 'x' });
    expect(() => computeSyncPlan(manifest, '/up', '/proj', fsx)).toThrow(/上流にファイルがありません/);
  });

  it('to がルート外を指すならエラー (パストラバーサル防止)', () => {
    const bad = { files: [{ from: 'a', to: '../escape' }] };
    const fsx = makeFs({ '/up/a': 'x' });
    expect(() => computeSyncPlan(bad, '/up', '/proj', fsx)).toThrow(/外/);
  });

  it('from がルート外を指すならエラー (パストラバーサル防止)', () => {
    const bad = { files: [{ from: '../escape', to: 'a' }] };
    const fsx = makeFs({});
    expect(() => computeSyncPlan(bad, '/up', '/proj', fsx)).toThrow(/外/);
  });
});

describe('sync loadManifest', () => {
  it('存在しないとエラー', () => {
    const fsx = makeFs({});
    expect(() => loadManifest('/x.json', fsx)).toThrow(/見つかりません/);
  });

  it('不正な JSON はエラー', () => {
    const fsx = makeFs({ '/x.json': '{ not json' });
    expect(() => loadManifest('/x.json', fsx)).toThrow(/JSON/);
  });

  it('正常な JSON を読める', () => {
    const fsx = makeFs({ '/x.json': '{"a":1}' });
    expect(loadManifest('/x.json', fsx)).toEqual({ a: 1 });
  });
});

describe('sync runSync', () => {
  const manifestObj = {
    upstream: { repo: 'https://example.com/x.git', ref: 'main' },
    lastSyncedCommit: null,
    files: [
      { from: 'tools/cross-review.js', to: 'tools/cross-review.js' },
      { from: 'docs/cross-review.md', to: 'docs/cross-review.md' },
    ],
  };

  // scriptDir=/proj/tools → destRoot=/proj, manifestPath=/proj/tools/cross-review.sync.json
  function baseDeps(extraFiles = {}) {
    const fsx = makeFs({
      '/proj/tools/cross-review.sync.json': JSON.stringify(manifestObj, null, 2),
      ...extraFiles,
    });
    const out = [];
    const err = [];
    let cleaned = false;
    return {
      fsx,
      out,
      err,
      get cleaned() { return cleaned; },
      deps: {
        scriptDir: '/proj/tools',
        readFile: fsx.readFile,
        writeFile: fsx.writeFile,
        exists: fsx.exists,
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        prepareUpstream: () => ({
          dir: '/up',
          commit: 'abc123def456',
          cleanup: () => { cleaned = true; },
        }),
      },
    };
  }

  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it('check: ドリフト無しなら exit 0', () => {
    const h = baseDeps({
      '/up/tools/cross-review.js': 'E',
      '/up/docs/cross-review.md': 'D',
      '/proj/tools/cross-review.js': 'E',
      '/proj/docs/cross-review.md': 'D',
    });
    const res = runSync({ mode: 'check', dryRun: false }, h.deps);
    expect(res.drift).toBe(false);
    expect(process.exitCode).toBe(0);
    expect(h.fsx.writes).toEqual([]); // 検査は書き込まない
    expect(h.cleaned).toBe(true); // 一時ディレクトリを片付ける
  });

  it('check: ドリフトがあれば exit 1 で書き込まない', () => {
    const h = baseDeps({
      '/up/tools/cross-review.js': 'NEW',
      '/up/docs/cross-review.md': 'D',
      '/proj/tools/cross-review.js': 'OLD',
      '/proj/docs/cross-review.md': 'D',
    });
    const res = runSync({ mode: 'check', dryRun: false }, h.deps);
    expect(res.drift).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(h.fsx.writes).toEqual([]);
  });

  it('--check は --dry-run より優先 (検査として振る舞い、ドリフトで exit 1・書き込まない)', () => {
    const h = baseDeps({
      '/up/tools/cross-review.js': 'NEW',
      '/up/docs/cross-review.md': 'D',
      '/proj/tools/cross-review.js': 'OLD',
      '/proj/docs/cross-review.md': 'D',
    });
    const res = runSync({ mode: 'check', dryRun: true }, h.deps);
    expect(res.drift).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(h.fsx.writes).toEqual([]);
  });

  it('sync: 差分のあるファイルを書き、lastSyncedCommit を記録する', () => {
    const h = baseDeps({
      '/up/tools/cross-review.js': 'NEW',
      '/up/docs/cross-review.md': 'D',
      '/proj/tools/cross-review.js': 'OLD',
      '/proj/docs/cross-review.md': 'D',
    });
    const res = runSync({ mode: 'sync', dryRun: false }, h.deps);
    expect(res.wrote).toContain('tools/cross-review.js');
    expect(res.wrote).not.toContain('docs/cross-review.md'); // 一致は書かない
    // 取り込み先が更新されている
    expect(h.fsx.store.get('/proj/tools/cross-review.js')).toBe('NEW');
    // マニフェストに取り込み元コミットが記録される
    const written = JSON.parse(h.fsx.store.get('/proj/tools/cross-review.sync.json'));
    expect(written.lastSyncedCommit).toBe('abc123def456');
    expect(written.lastSyncedRef).toBe('main');
    expect(process.exitCode).toBe(0);
  });

  it('sync: 同一コミットで一致なら何も書き込まない (マニフェストの整形崩れを防ぐ)', () => {
    // 既に同じコミットまで同期済み・取り込み先も一致している状態。
    const synced = { ...manifestObj, lastSyncedCommit: 'abc123def456', lastSyncedRef: 'main' };
    const fsx = makeFs({
      '/proj/tools/cross-review.sync.json': JSON.stringify(synced, null, 2),
      '/up/tools/cross-review.js': 'E',
      '/up/docs/cross-review.md': 'D',
      '/proj/tools/cross-review.js': 'E',
      '/proj/docs/cross-review.md': 'D',
    });
    runSync({ mode: 'sync', dryRun: false }, {
      scriptDir: '/proj/tools',
      readFile: fsx.readFile,
      writeFile: fsx.writeFile,
      exists: fsx.exists,
      out: () => {},
      err: () => {},
      prepareUpstream: () => ({ dir: '/up', commit: 'abc123def456', cleanup: () => {} }),
    });
    expect(fsx.writes).toEqual([]); // ファイルもマニフェストも書き込まない
    expect(process.exitCode).toBe(0);
  });

  it('sync --dry-run: 書き込まない', () => {
    const h = baseDeps({
      '/up/tools/cross-review.js': 'NEW',
      '/up/docs/cross-review.md': 'D',
      '/proj/tools/cross-review.js': 'OLD',
      '/proj/docs/cross-review.md': 'D',
    });
    const res = runSync({ mode: 'sync', dryRun: true }, h.deps);
    expect(res.drift).toBe(true);
    expect(h.fsx.writes).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('--ref で upstream.ref を上書きできる', () => {
    const h = baseDeps({
      '/up/tools/cross-review.js': 'E',
      '/up/docs/cross-review.md': 'D',
      '/proj/tools/cross-review.js': 'E',
      '/proj/docs/cross-review.md': 'D',
    });
    const res = runSync({ mode: 'check', dryRun: false, ref: 'v9' }, h.deps);
    expect(res.ref).toBe('v9');
  });

  it('マニフェストが無ければ exit 2', () => {
    const fsx = makeFs({});
    const err = [];
    runSync({ mode: 'sync' }, {
      scriptDir: '/proj/tools',
      readFile: fsx.readFile,
      writeFile: fsx.writeFile,
      exists: fsx.exists,
      out: () => {},
      err: (s) => err.push(s),
      prepareUpstream: () => { throw new Error('呼ばれてはいけない'); },
    });
    expect(process.exitCode).toBe(2);
    expect(err.join('')).toMatch(/マニフェスト/);
  });

  it('上流取得に失敗したら exit 1', () => {
    const h = baseDeps();
    h.deps.prepareUpstream = () => { throw new Error('fetch failed'); };
    runSync({ mode: 'sync' }, h.deps);
    expect(process.exitCode).toBe(1);
    expect(h.err.join('')).toMatch(/上流の取得に失敗/);
  });
});
