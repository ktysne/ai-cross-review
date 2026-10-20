'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { values } = parseArgs({ options: {
  checkout: { type: 'string' },
  revision: { type: 'string' },
} });
if (!values.checkout || !/^[0-9a-f]{40}$/i.test(values.revision || '')) {
  throw new Error('使い方: node tools/import-agent-cockpit-routing.js --checkout <checkout> --revision <完全な SHA>');
}

const sourcePath = 'contracts/routing';
const contractPath = `${sourcePath}/read`;
const destination = path.resolve(__dirname, '../tests/fixtures/agent-cockpit-routing');
const git = (...args) => execFileSync('git', ['-C', values.checkout, ...args]);
const files = git('ls-tree', '-r', '--name-only', values.revision, '--', sourcePath)
  .toString('utf8').trim().split('\n')
  .filter((file) => /^contracts\/routing\/read\/[^/]+\.json$/.test(file));
if (!files.length) throw new Error('指定 revision に routing.json の読み取り検証データがありません');
const contents = files.map((file) => ({ file, body: git('show', `${values.revision}:${file}`) }));

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const { file, body } of contents) {
  const target = path.join(destination, file.slice(sourcePath.length + 1));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}
fs.writeFileSync(path.join(destination, 'SOURCE.json'), `${JSON.stringify({
  repository: 'https://github.com/ktysne/agent-cockpit',
  revision: values.revision,
  path: contractPath,
  contract: 'docs/contracts/routing.md',
}, null, 2)}\n`);
