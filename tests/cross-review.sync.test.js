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
  parseMigrationFrontMatter,
  collectMigrationNotes,
  selectMigrationNotes,
  formatMigrationNotes,
  findMissingManifestEntries,
  collectMissingManifestEntries,
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

  // --check-manifest は列挙するだけの検査なので、単独指定でも書き込みモードにしない
  // (文書の「書き換えない」という案内と挙動を一致させる)。
  it('--check-manifest は単独でも --check を含意し、--check と併用もできる', () => {
    expect(parseArgs(['--check-manifest'])).toMatchObject({ mode: 'check', checkManifest: true, error: null });
    expect(parseArgs(['--check', '--check-manifest'])).toMatchObject({ mode: 'check', checkManifest: true, error: null });
    expect(parseArgs(['--check-manifest', '--dry-run'])).toMatchObject({ mode: 'check', checkManifest: true, dryRun: true });
    expect(parseArgs([]).checkManifest).toBe(false);
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

  it('旧形式 {source,ref,commit} は移行を促すエラー', () => {
    expect(() => validateManifest({ source: 'o/r', ref: 'main', commit: 'abc' })).toThrow(/旧形式/);
    // source だけ / commit だけでも検出する
    expect(() => validateManifest({ source: 'o/r' })).toThrow(/旧形式/);
    expect(() => validateManifest({ commit: 'abc' })).toThrow(/旧形式/);
  });

  it('upstream を持つマニフェストは旧形式エラーにならない (source キーが混在しても)', () => {
    // upstream があれば新形式とみなし、通常の検証へ進む。
    const m = { upstream: { repo: 'x', ref: 'main' }, files: [{ from: 'a', to: 'b' }], source: 'legacy' };
    expect(() => validateManifest(m)).not.toThrow();
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
// 参照側 (readFile / exists / writeFile) はキーを path.resolve で正規化するため、
// 初期データのキーも同じく正規化して登録する (Windows では '/up/...' が 'D:\up\...' に
// 解決されるので、生のキーのままだと一致せず全テストが落ちる)。
function makeFs(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [path.resolve(k), v]));
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
    expect(h.fsx.store.get(path.resolve('/proj/tools/cross-review.js'))).toBe('NEW');
    // マニフェストに取り込み元コミットが記録される
    const written = JSON.parse(h.fsx.store.get(path.resolve('/proj/tools/cross-review.sync.json')));
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

  it('sync: 上流コミットが進めばファイル一致でもマニフェストの記録だけ更新する', () => {
    // 取り込み先ファイルは上流と一致しているが、上流コミットが古い記録から進んだ状態。
    const synced = { ...manifestObj, lastSyncedCommit: 'oldcommit', lastSyncedRef: 'main' };
    const fsx = makeFs({
      '/proj/tools/cross-review.sync.json': JSON.stringify(synced, null, 2),
      '/up/tools/cross-review.js': 'E',
      '/up/docs/cross-review.md': 'D',
      '/proj/tools/cross-review.js': 'E',
      '/proj/docs/cross-review.md': 'D',
    });
    const res = runSync({ mode: 'sync', dryRun: false }, {
      scriptDir: '/proj/tools',
      readFile: fsx.readFile,
      writeFile: fsx.writeFile,
      exists: fsx.exists,
      out: () => {},
      err: () => {},
      prepareUpstream: () => ({ dir: '/up', commit: 'newcommit', cleanup: () => {} }),
    });
    expect(res.wrote).toEqual([]); // ファイルは一致なので書かない
    // 書き込みはマニフェストの記録更新のみ
    expect(fsx.writes.map((w) => w.path)).toEqual([path.resolve('/proj/tools/cross-review.sync.json')]);
    const written = JSON.parse(fsx.store.get(path.resolve('/proj/tools/cross-review.sync.json')));
    expect(written.lastSyncedCommit).toBe('newcommit');
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

describe('parseMigrationFrontMatter', () => {
  it('since を読む', () => {
    expect(parseMigrationFrontMatter('---\nsince: abc123\n---\n本文\n')).toEqual({ ok: true, since: 'abc123' });
  });

  it('CRLF でも読める', () => {
    expect(parseMigrationFrontMatter('---\r\nsince: abc123\r\n---\r\n本文\r\n').since).toBe('abc123');
  });

  it('フロントマターが無い / 閉じない / since が無い / 未知の行 は ok:false', () => {
    expect(parseMigrationFrontMatter('# 見出しだけ\n').ok).toBe(false);
    expect(parseMigrationFrontMatter('---\nsince: abc\n本文\n').ok).toBe(false);
    expect(parseMigrationFrontMatter('---\n---\n本文\n').ok).toBe(false);
    expect(parseMigrationFrontMatter('---\nsince: abc\ntitle: x\n---\n').ok).toBe(false);
  });
});

describe('selectMigrationNotes', () => {
  const notes = [{ name: 'a.md', body: 'A' }, { name: 'b.md', body: 'B' }];

  it('初回同期 (lastSyncedCommit が null) で記録が無ければ、表示せず全件を記録する', () => {
    const res = selectMigrationNotes({ manifest: { lastSyncedCommit: null }, notes });
    expect(res.toShow).toEqual([]);
    expect(res.nextShown).toEqual(['a.md', 'b.md']);
  });

  it('初回同期で記録が空配列でも、表示せず全件を記録する (雛形の shownMigrations: [] をそのまま使う導入先)', () => {
    const res = selectMigrationNotes({ manifest: { lastSyncedCommit: null, shownMigrations: [] }, notes });
    expect(res.toShow).toEqual([]);
    expect(res.nextShown).toEqual(['a.md', 'b.md']);
  });

  it('同期実績があり記録が無ければ、全件を未読として表示する', () => {
    const res = selectMigrationNotes({ manifest: { lastSyncedCommit: 'abc' }, notes });
    expect(res.toShow.map((n) => n.name)).toEqual(['a.md', 'b.md']);
    expect(res.nextShown).toEqual(['a.md', 'b.md']);
  });

  it('記録があれば、記録に無いノートだけ表示する', () => {
    const res = selectMigrationNotes({ manifest: { lastSyncedCommit: 'abc', shownMigrations: ['a.md'] }, notes });
    expect(res.toShow.map((n) => n.name)).toEqual(['b.md']);
    expect(res.nextShown).toEqual(['a.md', 'b.md']);
  });

  it('全件が記録済みなら表示せず、記録も変わらない', () => {
    const res = selectMigrationNotes({ manifest: { lastSyncedCommit: 'abc', shownMigrations: ['a.md', 'b.md'] }, notes });
    expect(res.toShow).toEqual([]);
    expect(res.nextShown).toEqual(['a.md', 'b.md']);
  });

  it('上流から消えたノートの記録は残す (再表示を防ぐ)', () => {
    const res = selectMigrationNotes({ manifest: { lastSyncedCommit: 'abc', shownMigrations: ['old.md'] }, notes });
    expect(res.nextShown).toEqual(['old.md', 'a.md', 'b.md']);
  });
});

describe('collectMigrationNotes', () => {
  it('置き場が無ければ present:false (機能ごと何もしない)', () => {
    const fsx = makeFs({});
    const res = collectMigrationNotes('/up', 'docs/migrations', { ...fsx, listMigrations: () => [] });
    expect(res).toEqual({ present: false, notes: [], warnings: [] });
  });

  it('フロントマターが不正なノートは警告してスキップし、他は読む', () => {
    const fsx = makeFs({
      '/up/docs/migrations': '',
      '/up/docs/migrations/ok.md': '---\nsince: abc\n---\n本文\n',
      '/up/docs/migrations/bad.md': '# フロントマター無し\n',
    });
    const res = collectMigrationNotes('/up', 'docs/migrations', {
      ...fsx,
      listMigrations: () => ['bad.md', 'ok.md'],
    });
    expect(res.present).toBe(true);
    expect(res.notes.map((n) => n.name)).toEqual(['ok.md']);
    expect(res.warnings.join('')).toMatch(/bad\.md/);
  });

  it('置き場が上流ルートの外を指すならエラー', () => {
    const fsx = makeFs({});
    expect(() => collectMigrationNotes('/up', '../escape', fsx)).toThrow(/外/);
  });
});

describe('formatMigrationNotes', () => {
  it('件数の見出しとファイル名、本文を含む', () => {
    const s = formatMigrationNotes([{ name: 'a.md', body: '---\nsince: abc\n---\n本文\n' }]);
    expect(s).toMatch(/未読の移行ノート \(1 件\)/);
    expect(s).toMatch(/--- a\.md ---/);
    expect(s).toMatch(/本文/);
  });
});

// 移行ノートの表示と記録がモード (同期 / --dry-run / --check) ごとに変わることを、
// 仮想 FS と listMigrations の差し替えで固定する。
describe('runSync の移行ノート', () => {
  const NOTE = '---\nsince: aaa111\n---\n# 例のノート\n\n## 取り込み先で必要な作業\n- gitignore に一行足す\n';

  // lastSyncedCommit / shownMigrations を差し替えたマニフェストで deps 一式を組む。
  function migrationDeps(manifestPatch = {}, upstreamFiles = {}) {
    const manifestObj = {
      upstream: { repo: 'https://example.com/x.git', ref: 'main' },
      lastSyncedCommit: 'oldcommit',
      lastSyncedRef: 'main',
      files: [{ from: 'tools/cross-review.js', to: 'tools/cross-review.js' }],
      ...manifestPatch,
    };
    const fsx = makeFs({
      '/proj/tools/cross-review.sync.json': JSON.stringify(manifestObj, null, 2),
      '/up/tools/cross-review.js': 'E',
      '/proj/tools/cross-review.js': 'E',
      '/up/docs/migrations': '',
      '/up/docs/migrations/2026-09-example.md': NOTE,
      ...upstreamFiles,
    });
    const out = [];
    const err = [];
    return {
      fsx,
      out,
      err,
      deps: {
        scriptDir: '/proj/tools',
        readFile: fsx.readFile,
        writeFile: fsx.writeFile,
        exists: fsx.exists,
        listMigrations: () => ['2026-09-example.md'],
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        prepareUpstream: () => ({ dir: '/up', commit: 'newcommit', cleanup: () => {} }),
      },
    };
  }

  const readManifest = (fsx) => JSON.parse(fsx.store.get(path.resolve('/proj/tools/cross-review.sync.json')));

  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it('sync: 未読ノートを stderr へ全文表示し、shownMigrations に記録する', () => {
    const h = migrationDeps();
    const res = runSync({ mode: 'sync', dryRun: false }, h.deps);
    expect(h.err.join('')).toMatch(/未読の移行ノート \(1 件\)/);
    expect(h.err.join('')).toMatch(/gitignore に一行足す/);
    expect(res.migrations).toEqual(['2026-09-example.md']);
    expect(readManifest(h.fsx).shownMigrations).toEqual(['2026-09-example.md']);
  });

  it('sync: 記録済みのノートは表示せず、マニフェストも書き換えない', () => {
    const h = migrationDeps({ lastSyncedCommit: 'newcommit', shownMigrations: ['2026-09-example.md'] });
    const res = runSync({ mode: 'sync', dryRun: false }, h.deps);
    expect(res.migrations).toEqual([]);
    expect(h.err.join('')).not.toMatch(/未読の移行ノート/);
    expect(h.fsx.writes).toEqual([]);
  });

  it('sync: 初回同期 (lastSyncedCommit が null) は表示せず記録だけする', () => {
    const h = migrationDeps({ lastSyncedCommit: null, lastSyncedRef: undefined });
    const res = runSync({ mode: 'sync', dryRun: false }, h.deps);
    expect(res.migrations).toEqual([]);
    expect(h.err.join('')).not.toMatch(/未読の移行ノート/);
    expect(readManifest(h.fsx).shownMigrations).toEqual(['2026-09-example.md']);
  });

  it('--dry-run: 表示はするが記録しない', () => {
    const h = migrationDeps();
    const res = runSync({ mode: 'sync', dryRun: true }, h.deps);
    expect(h.err.join('')).toMatch(/未読の移行ノート \(1 件\)/);
    expect(res.migrations).toEqual(['2026-09-example.md']);
    expect(h.fsx.writes).toEqual([]);
  });

  it('--check: 件数の 1 行だけ出し、本文は出さず記録もしない。ドリフト判定にも含めない', () => {
    const h = migrationDeps();
    const res = runSync({ mode: 'check', dryRun: false }, h.deps);
    expect(h.err.join('')).toMatch(/未読の移行ノートが 1 件あります/);
    expect(h.err.join('')).not.toMatch(/gitignore に一行足す/);
    expect(h.fsx.writes).toEqual([]);
    expect(res.drift).toBe(false);
    expect(process.exitCode).toBe(0); // 未読ノートはドリフトではない
  });

  it('フロントマターが不正なノートは警告してスキップする (同期は続く)', () => {
    const h = migrationDeps({}, { '/up/docs/migrations/broken.md': '# フロントマター無し\n' });
    h.deps.listMigrations = () => ['2026-09-example.md', 'broken.md'];
    const res = runSync({ mode: 'sync', dryRun: false }, h.deps);
    expect(h.err.join('')).toMatch(/broken\.md/);
    expect(res.migrations).toEqual(['2026-09-example.md']);
    expect(readManifest(h.fsx).shownMigrations).toEqual(['2026-09-example.md']);
  });

  it('上流に置き場が無ければ何もしない (shownMigrations を作らない)', () => {
    const manifestObj = {
      upstream: { repo: 'https://example.com/x.git', ref: 'main' },
      lastSyncedCommit: 'oldcommit',
      lastSyncedRef: 'main',
      files: [{ from: 'tools/cross-review.js', to: 'tools/cross-review.js' }],
    };
    const fsx = makeFs({
      '/proj/tools/cross-review.sync.json': JSON.stringify(manifestObj, null, 2),
      '/up/tools/cross-review.js': 'E',
      '/proj/tools/cross-review.js': 'E',
    });
    const err = [];
    const res = runSync({ mode: 'sync', dryRun: false }, {
      scriptDir: '/proj/tools',
      readFile: fsx.readFile,
      writeFile: fsx.writeFile,
      exists: fsx.exists,
      listMigrations: () => { throw new Error('呼ばれてはいけない'); },
      out: () => {},
      err: (s) => err.push(s),
      prepareUpstream: () => ({ dir: '/up', commit: 'newcommit', cleanup: () => {} }),
    });
    expect(res.migrations).toEqual([]);
    expect(err.join('')).toBe('');
    expect(readManifest(fsx).shownMigrations).toBeUndefined();
  });

  it('migrationsDir で上流の置き場を上書きできる', () => {
    const h = migrationDeps({ migrationsDir: 'notes' }, { '/up/notes': '', '/up/notes/x.md': NOTE });
    const seen = [];
    h.deps.listMigrations = (dir) => { seen.push(dir); return ['x.md']; };
    const res = runSync({ mode: 'sync', dryRun: false }, h.deps);
    expect(seen).toEqual([path.resolve('/up/notes')]);
    expect(res.migrations).toEqual(['x.md']);
  });
});

describe('findMissingManifestEntries', () => {
  const example = {
    files: [
      { from: 'tools/cross-review.js', to: 'tools/cross-review.js' },
      { from: 'tools/cross-review.sync-all.js', to: 'tools/cross-review.sync-all.js' },
      { from: '.claude/skills/cross-review/SKILL.md', to: '.claude/skills/cross-review/SKILL.md' },
    ],
  };

  it('雛形にあって取り込み先に無いエントリを雛形の並び順で返す', () => {
    const local = { files: [{ from: 'tools/cross-review.js', to: 'tools/cross-review.js' }] };
    expect(findMissingManifestEntries(example, local)).toEqual([
      { from: 'tools/cross-review.sync-all.js', to: 'tools/cross-review.sync-all.js' },
      { from: '.claude/skills/cross-review/SKILL.md', to: '.claude/skills/cross-review/SKILL.md' },
    ]);
  });

  it('全て登録済みなら空 (to が違っても from が一致すれば登録済み)', () => {
    const local = {
      files: [
        { from: 'tools/cross-review.js', to: 'lib/cross-review.js' },
        { from: 'tools/cross-review.sync-all.js', to: 'tools/cross-review.sync-all.js' },
        { from: '.claude/skills/cross-review/SKILL.md', to: 'skills/SKILL.md' },
      ],
    };
    expect(findMissingManifestEntries(example, local)).toEqual([]);
  });

  it('雛形 / 取り込み先が壊れていても落ちない (files が無い、null)', () => {
    expect(findMissingManifestEntries(null, { files: [] })).toEqual([]);
    expect(findMissingManifestEntries({}, { files: [] })).toEqual([]);
    expect(findMissingManifestEntries(example, null)).toHaveLength(3);
    expect(findMissingManifestEntries(example, {})).toHaveLength(3);
  });
});

describe('collectMissingManifestEntries', () => {
  const localManifest = { files: [{ from: 'tools/cross-review.js', to: 'tools/cross-review.js' }] };
  const EXAMPLE = JSON.stringify({
    files: [
      { from: 'tools/cross-review.js', to: 'tools/cross-review.js' },
      { from: 'docs/cross-review.md', to: 'docs/cross-review.md' },
    ],
  });

  it('上流の雛形を読んで未登録エントリを返す', () => {
    const fsx = makeFs({ '/up/tools/cross-review.sync.example.json': EXAMPLE });
    const r = collectMissingManifestEntries('/up', localManifest, { readFile: fsx.readFile, exists: fsx.exists });
    expect(r.warning).toBeNull();
    expect(r.entries).toEqual([{ from: 'docs/cross-review.md', to: 'docs/cross-review.md' }]);
  });

  it('上流に雛形が無ければ警告して検査をスキップする', () => {
    const fsx = makeFs({});
    const r = collectMissingManifestEntries('/up', localManifest, { readFile: fsx.readFile, exists: fsx.exists });
    expect(r.entries).toEqual([]);
    expect(r.warning).toMatch(/雛形/);
  });

  it('雛形が JSON として不正なら警告して検査をスキップする', () => {
    const fsx = makeFs({ '/up/tools/cross-review.sync.example.json': '{ not json' });
    const r = collectMissingManifestEntries('/up', localManifest, { readFile: fsx.readFile, exists: fsx.exists });
    expect(r.entries).toEqual([]);
    expect(r.warning).toMatch(/雛形/);
  });

  // 突き合わせる相手が 1 件も無い雛形を「未登録なし」と誤報しないことを固定する
  // (検査したのに何も見ていない状態と、検査に成功した状態を区別する)。
  it('雛形に files が無ければ構造不正として警告し、検査をスキップする', () => {
    const fsx = makeFs({ '/up/tools/cross-review.sync.example.json': JSON.stringify({ upstream: { repo: 'x', ref: 'main' } }) });
    const r = collectMissingManifestEntries('/up', localManifest, { readFile: fsx.readFile, exists: fsx.exists });
    expect(r.entries).toEqual([]);
    expect(r.warning).toMatch(/構造が不正/);
  });

  it('雛形の files が配列でなければ構造不正として警告する', () => {
    const fsx = makeFs({ '/up/tools/cross-review.sync.example.json': JSON.stringify({ files: { from: 'tools/a.js' } }) });
    const r = collectMissingManifestEntries('/up', localManifest, { readFile: fsx.readFile, exists: fsx.exists });
    expect(r.entries).toEqual([]);
    expect(r.warning).toMatch(/構造が不正/);
  });

  it('雛形の files に from を持つエントリが 1 つも無ければ構造不正として警告する', () => {
    const fsx = makeFs({
      '/up/tools/cross-review.sync.example.json': JSON.stringify({ files: [{ to: 'tools/a.js' }, null, { from: 42 }] }),
    });
    const r = collectMissingManifestEntries('/up', localManifest, { readFile: fsx.readFile, exists: fsx.exists });
    expect(r.entries).toEqual([]);
    expect(r.warning).toMatch(/構造が不正/);
  });

  it('from を持つエントリが 1 つでもあれば検査する (不正な要素は無視する)', () => {
    const fsx = makeFs({
      '/up/tools/cross-review.sync.example.json': JSON.stringify({
        files: [{ to: 'tools/a.js' }, { from: 'docs/cross-review.md', to: 'docs/cross-review.md' }],
      }),
    });
    const r = collectMissingManifestEntries('/up', localManifest, { readFile: fsx.readFile, exists: fsx.exists });
    expect(r.warning).toBeNull();
    expect(r.entries).toEqual([{ from: 'docs/cross-review.md', to: 'docs/cross-review.md' }]);
  });
});

// --check-manifest は「上流の配布物を取りこぼしていないか」だけを報告し、マニフェストを書き換えず
// 終了コードにも影響させない、という不変条件を固定する。
describe('runSync の --check-manifest', () => {
  const manifestObj = {
    upstream: { repo: 'https://example.com/x.git', ref: 'main' },
    lastSyncedCommit: 'newcommit',
    lastSyncedRef: 'main',
    files: [{ from: 'tools/cross-review.js', to: 'tools/cross-review.js' }],
  };
  const EXAMPLE = JSON.stringify({
    files: [
      { from: 'tools/cross-review.js', to: 'tools/cross-review.js' },
      { from: 'tools/cross-review.sync-all.js', to: 'tools/cross-review.sync-all.js' },
    ],
  });

  function checkDeps(extraFiles = {}) {
    const fsx = makeFs({
      '/proj/tools/cross-review.sync.json': JSON.stringify(manifestObj, null, 2),
      '/up/tools/cross-review.js': 'E',
      '/proj/tools/cross-review.js': 'E',
      ...extraFiles,
    });
    const out = [];
    const err = [];
    return {
      fsx,
      out,
      err,
      deps: {
        scriptDir: '/proj/tools',
        readFile: fsx.readFile,
        writeFile: fsx.writeFile,
        exists: fsx.exists,
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        prepareUpstream: () => ({ dir: '/up', commit: 'newcommit', cleanup: () => {} }),
      },
    };
  }

  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it('指定しなければ検査せず、結果も空', () => {
    const h = checkDeps({ '/up/tools/cross-review.sync.example.json': EXAMPLE });
    const res = runSync({ mode: 'check', dryRun: false, checkManifest: false }, h.deps);
    expect(res.missingManifestEntries).toEqual([]);
    expect(h.out.join('')).not.toMatch(/マニフェスト未登録/);
  });

  it('--check と併用しても未登録は exit 1 にせず、マニフェストも書き換えない', () => {
    const h = checkDeps({ '/up/tools/cross-review.sync.example.json': EXAMPLE });
    const res = runSync({ mode: 'check', dryRun: false, checkManifest: true }, h.deps);
    expect(res.missingManifestEntries).toEqual([{ from: 'tools/cross-review.sync-all.js', to: 'tools/cross-review.sync-all.js' }]);
    expect(h.out.join('')).toMatch(/マニフェスト未登録の配布物 \(1 件\)/);
    expect(h.out.join('')).toMatch(/tools\/cross-review\.sync-all\.js/);
    expect(h.fsx.writes).toEqual([]);
    expect(res.drift).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('未登録が無ければその旨を出す', () => {
    const h = checkDeps({
      '/up/tools/cross-review.sync.example.json': JSON.stringify({ files: [{ from: 'tools/cross-review.js', to: 'tools/cross-review.js' }] }),
    });
    const res = runSync({ mode: 'check', dryRun: false, checkManifest: true }, h.deps);
    expect(res.missingManifestEntries).toEqual([]);
    expect(h.out.join('')).toMatch(/マニフェスト未登録の配布物はありません/);
  });

  it('上流に雛形が無ければ警告してスキップし、同期は続く', () => {
    const h = checkDeps();
    const res = runSync({ mode: 'sync', dryRun: false, checkManifest: true }, h.deps);
    expect(res.missingManifestEntries).toEqual([]);
    expect(h.err.join('')).toMatch(/雛形/);
    expect(h.out.join('')).not.toMatch(/マニフェスト未登録/);
    expect(process.exitCode).toBe(0);
  });

  // 検査をスキップした理由は戻り値にも載せる。一括同期 (sync-all) が「未登録 0 件」と
  // 「そもそも検査できていない」を区別するために使う。
  it('スキップ理由を manifestCheckWarning として返し、検査できたときは null', () => {
    const skipped = runSync({ mode: 'check', dryRun: false, checkManifest: true }, checkDeps().deps);
    expect(skipped.manifestCheckWarning).toMatch(/雛形/);
    const h = checkDeps({ '/up/tools/cross-review.sync.example.json': EXAMPLE });
    expect(runSync({ mode: 'check', dryRun: false, checkManifest: true }, h.deps).manifestCheckWarning).toBeNull();
    expect(runSync({ mode: 'check', dryRun: false, checkManifest: false }, h.deps).manifestCheckWarning).toBeNull();
  });
});

// --check-manifest 単独指定は --check を含意するので、ドリフトがあっても取り込み先ファイルと
// マニフェスト (lastSyncedCommit) を書き換えない。parseArgs と runSync の配線ごと固定する。
describe('runSync の --check-manifest 単独指定 (非書き込み)', () => {
  const manifestObj = {
    upstream: { repo: 'https://example.com/x.git', ref: 'main' },
    lastSyncedCommit: 'oldcommit',
    lastSyncedRef: 'main',
    files: [{ from: 'tools/cross-review.js', to: 'tools/cross-review.js' }],
  };

  function driftingDeps() {
    const fsx = makeFs({
      '/proj/tools/cross-review.sync.json': JSON.stringify(manifestObj, null, 2),
      '/up/tools/cross-review.js': 'NEW',
      '/proj/tools/cross-review.js': 'OLD',
      '/up/tools/cross-review.sync.example.json': JSON.stringify({
        files: [
          { from: 'tools/cross-review.js', to: 'tools/cross-review.js' },
          { from: 'tools/cross-review.sync-all.js', to: 'tools/cross-review.sync-all.js' },
        ],
      }),
    });
    const out = [];
    const err = [];
    return {
      fsx,
      out,
      err,
      deps: {
        scriptDir: '/proj/tools',
        readFile: fsx.readFile,
        writeFile: fsx.writeFile,
        exists: fsx.exists,
        out: (s) => out.push(s),
        err: (s) => err.push(s),
        prepareUpstream: () => ({ dir: '/up', commit: 'newcommit', cleanup: () => {} }),
      },
    };
  }

  beforeEach(() => { process.exitCode = 0; });
  afterAll(() => { process.exitCode = 0; });

  it('ドリフトがあっても書き込まず、未登録を列挙し、ドリフトで exit 1 になる', () => {
    const h = driftingDeps();
    const res = runSync(parseArgs(['--check-manifest']), h.deps);
    expect(h.fsx.writes).toEqual([]);
    expect(h.fsx.store.get(path.resolve('/proj/tools/cross-review.js'))).toBe('OLD');
    expect(JSON.parse(h.fsx.store.get(path.resolve('/proj/tools/cross-review.sync.json'))).lastSyncedCommit).toBe('oldcommit');
    expect(res.wrote).toEqual([]);
    expect(res.drift).toBe(true);
    expect(res.missingManifestEntries).toEqual([{ from: 'tools/cross-review.sync-all.js', to: 'tools/cross-review.sync-all.js' }]);
    expect(h.out.join('')).toMatch(/マニフェスト未登録の配布物 \(1 件\)/);
    expect(process.exitCode).toBe(1);
  });

  it('ドリフトが無ければ書き込まず exit 0 (未登録があっても exit 1 にしない)', () => {
    const h = driftingDeps();
    h.fsx.store.set(path.resolve('/proj/tools/cross-review.js'), 'NEW');
    const res = runSync(parseArgs(['--check-manifest']), h.deps);
    expect(h.fsx.writes).toEqual([]);
    expect(res.drift).toBe(false);
    expect(res.missingManifestEntries).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });
});
