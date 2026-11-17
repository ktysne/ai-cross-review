#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ENTRY_PROTOCOL = 1;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

function isNoFetch(env) {
  const raw = env.CROSS_REVIEW_NO_FETCH;
  if (raw == null) return false;
  const value = String(raw).trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

function resolveCacheRoot(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const home = typeof deps.homedir === 'function' ? deps.homedir() : (deps.homedir ?? os.homedir());
  return path.resolve(env.XDG_CACHE_HOME || (platform === 'win32' && env.LOCALAPPDATA) || (home && path.join(home, '.cache')) || (deps.tmpdir || os.tmpdir)(), 'ai-cross-review');
}

function readRefs(cacheRoot, io) {
  try {
    const refs = JSON.parse(io.readFileSync(path.join(cacheRoot, 'refs.json'), 'utf8'));
    return refs && typeof refs === 'object' && !Array.isArray(refs) ? refs : {};
  } catch { return {}; }
}

function writeRefs(cacheRoot, refs, io, platform) {
  const temp = path.join(cacheRoot, 'refs-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.tmp');
  try {
    io.mkdirSync(cacheRoot, { recursive: true });
    io.writeFileSync(temp, JSON.stringify(refs) + '\n');
    for (let attempt = 0; attempt < (platform === 'win32' ? 3 : 1); attempt++) {
      try { io.renameSync(temp, path.join(cacheRoot, 'refs.json')); return; } catch {}
    }
  } catch {} finally {
    try { io.unlinkSync(temp); } catch {}
  }
}

function resolveRemoteSha(output, ref) {
  const lines = String(output).trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/));
  const find = (name) => {
    const row = lines.find(([sha, target]) => target === name && SHA_PATTERN.test(sha));
    return row ? row[0].toLowerCase() : null;
  };
  if (ref.startsWith('refs/')) return find(ref + '^{}') || find(ref);
  return find('refs/heads/' + ref) || find('refs/tags/' + ref + '^{}') || find('refs/tags/' + ref);
}

function resolveCachedEngine(projectRoot, deps = {}) {
  const io = deps.fs || fs;
  const env = deps.env || process.env;
  const gitRun = deps.gitRun || ((args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const cacheRoot = resolveCacheRoot(deps);
  const warn = deps.err || ((s) => process.stderr.write(s));
  let upstream;
  let syncedCommit;
  try {
    const manifest = JSON.parse(io.readFileSync(path.join(projectRoot, 'tools/cross-review.sync.json'), 'utf8'));
    upstream = manifest.upstream;
    syncedCommit = typeof manifest.lastSyncedCommit === 'string' ? manifest.lastSyncedCommit.toLowerCase() : null;
    if (!upstream || typeof upstream.repo !== 'string' || !upstream.repo || typeof upstream.ref !== 'string' || !upstream.ref) throw new Error('upstream.repo と upstream.ref が必要です');
  } catch (err) { throw new Error('導入先のマニフェストを読めません。tools/cross-review.sync.json の upstream.repo と upstream.ref を確認してください: ' + err.message); }
  const { repo, ref } = upstream;
  const refs = readRefs(cacheRoot, io);
  const key = repo + '#' + ref;
  const pinned = SHA_PATTERN.test(ref);
  let sha = pinned ? ref.toLowerCase() : null;
  let offline = isNoFetch(env);
  let resolvedFromRemote = false;
  let remoteFailed = false;
  if (!sha && !offline) {
    try {
      sha = resolveRemoteSha(gitRun(['ls-remote', repo, ref]), ref);
      if (!sha) throw new Error('ref が見つかりません');
      resolvedFromRemote = true;
    } catch { offline = true; remoteFailed = true; }
  }
  if (!sha && SHA_PATTERN.test(refs[key])) {
    sha = refs[key].toLowerCase();
    if (remoteFailed) warn('[cross-review] 上流の ' + ref + ' を問い合わせできないため、記録済みの SHA の本体に切り替える: ' + sha + '\n');
  }
  if (!sha) throw new Error('本体の ref を解決できず、最後の SHA の記録もありません。ネットワークにつなぐか checkout を --register で登録してください。');
  // ブランチやタグの指す先は上流への push で変わるため、sync が記録したコミットと同じ本体だけを実行する。
  // sync は新しい版を取り込んで記録を進める経路なので対象外にする。述語は本体の振り分け (先頭の引数が sync) とそろえる。
  if (!pinned && (deps.argv || process.argv.slice(2))[0] !== 'sync' && sha !== syncedCommit) {
    throw new Error(syncedCommit
      ? 'upstream.ref ' + ref + ' の本体 (' + sha + ') が、同期済みのコミット (' + syncedCommit + ') と一致しないため、実行しません。上流の変更を確かめてから 導入先で node tools/cross-review.js sync を実行して取り込んでください。'
      : 'マニフェストに lastSyncedCommit の記録が無いため、upstream.ref ' + ref + ' の本体 (' + sha + ') を実行しません。導入先で node tools/cross-review.js sync を実行して取り込んでから再実行してください。');
  }
  const engines = path.join(cacheRoot, 'engines');
  const checkout = path.join(engines, sha);
  const enginePath = path.join(checkout, 'tools/cross-review.js');
  if (!io.existsSync(enginePath)) {
    if (offline) throw new Error('最後の SHA の本体キャッシュがありません。ネットワークにつないで再実行してください。');
    io.mkdirSync(engines, { recursive: true });
    const temp = io.mkdtempSync(path.join(engines, 'fetch-'));
    try {
      gitRun(['init', '--quiet', temp]);
      gitRun(['-C', temp, 'remote', 'add', 'origin', repo]);
      gitRun(['-C', temp, 'fetch', '--quiet', '--depth', '1', 'origin', sha]);
      gitRun(['-C', temp, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'checkout', '--quiet', 'FETCH_HEAD']);
      if (!io.existsSync(path.join(temp, 'tools/cross-review.js'))) throw new Error('取得した木に tools/cross-review.js がありません');
      try { io.renameSync(temp, checkout); } catch (err) {
        if (!io.existsSync(enginePath)) throw err;
      }
      warn('[cross-review] 本体を取得した: ' + sha + '\n');
    } catch (err) { throw new Error('本体を取得できません。ネットワークと upstream.ref を確認してください: ' + err.message); }
    finally {
      const target = path.resolve(temp);
      if (path.dirname(target) === path.resolve(engines) && path.basename(target).startsWith('fetch-')) {
        try { io.rmSync(target, { recursive: true, force: true }); } catch {}
      }
    }
  }
  // refs.json はオフライン時に使う本体を指すため、本体がキャッシュにある SHA だけを記録する。
  if (resolvedFromRemote && refs[key] !== sha) {
    refs[key] = sha;
    writeRefs(cacheRoot, refs, io, deps.platform || process.platform);
  }
  return { engineSource: 'cache', enginePath, cacheRoot, engineSha: sha };
}

function resolveEngine(projectRoot, deps = {}) {
  const env = deps.env || process.env;
  const io = deps.fs || fs;
  if (env.CROSS_REVIEW_ENGINE) return { engineSource: 'env', enginePath: path.resolve(env.CROSS_REVIEW_ENGINE, 'tools/cross-review.js') };
  const home = typeof deps.homedir === 'function' ? deps.homedir() : (deps.homedir ?? os.homedir());
  const registry = path.join(home, '.cross-review/engine.json');
  let record;
  try { record = io.readFileSync(registry, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return resolveCachedEngine(projectRoot, deps);
    throw new Error('登録ファイルを読めません: ' + registry + '。node <checkout>/tools/cross-review.sync-all.js --register で登録し直してください。');
  }
  try {
    const { checkout } = JSON.parse(record);
    if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) throw new Error('checkout は絶対パスの文字列が必要です');
    return { engineSource: 'registry', enginePath: path.join(checkout, 'tools/cross-review.js') };
  } catch (err) { throw new Error('登録ファイルが不正です: ' + registry + '。node <checkout>/tools/cross-review.sync-all.js --register で登録し直してください: ' + err.message); }
}

function loadEngine(projectRoot, deps) {
  const selected = resolveEngine(projectRoot, deps);
  let engine;
  const advice = selected.engineSource === 'env' ? 'CROSS_REVIEW_ENGINE の指す checkout を確認してください。' : selected.engineSource === 'registry' ? 'node <checkout>/tools/cross-review.sync-all.js --register で登録し直してください。' : 'ネットワークとマニフェストの upstream.ref を確認してください。';
  try { engine = (deps.require || require)(selected.enginePath); }
  catch (cause) { throw new Error('本体を読み込めません: ' + selected.enginePath + '。' + advice + ' ' + cause.message); }
  if (!engine || typeof engine.checkEntryProtocol !== 'function' || !engine.ENTRY_PROTOCOL_RANGE) throw new Error('対応外の古い本体です: ' + selected.enginePath + '。' + (selected.engineSource === 'registry' ? '登録した checkout を git pull で更新してください。' : selected.engineSource === 'env' ? 'CROSS_REVIEW_ENGINE の指す checkout を更新してください。' : 'マニフェストの upstream.ref を対応する版へ上げてください。'));
  return { engine, selected };
}

function main(deps = {}) {
  const projectRoot = path.resolve(deps.scriptDir || __dirname, '..');
  const err = deps.err || ((s) => process.stderr.write(s));
  let loaded;
  try {
    loaded = loadEngine(projectRoot, deps);
  } catch (cause) {
    err('[cross-review] ' + cause.message + '\n');
    process.exitCode = 2;
    return;
  }
  // 本体の中の例外は設定の誤りではないので、終了コード 2 に読み替えずにそのまま伝える。
  const { engine, selected } = loaded;
  return engine.main({ argv: deps.argv || process.argv.slice(2), projectRoot, entryProtocol: ENTRY_PROTOCOL,
    engineSource: selected.engineSource, ...(selected.engineSource === 'cache' ? { cacheRoot: selected.cacheRoot, engineSha: selected.engineSha } : {}) });
}

module.exports = { ENTRY_PROTOCOL, isNoFetch, resolveCacheRoot, readRefs, writeRefs, resolveRemoteSha, resolveCachedEngine, resolveEngine, main };
if (require.main === module) main();
