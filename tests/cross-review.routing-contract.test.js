import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { readReviewRoute } = require('../tools/cross-review.js');
const fixtureDirectory = fileURLToPath(new URL('./fixtures/agent-cockpit-routing/read/', import.meta.url));
const sourcePath = fileURLToPath(new URL('./fixtures/agent-cockpit-routing/SOURCE.json', import.meta.url));
const fixtures = fs.readdirSync(fixtureDirectory)
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(fs.readFileSync(path.join(fixtureDirectory, file), 'utf8')));

describe('agent-cockpit routing 読み取り契約', () => {
  it('検証データがあり、SOURCE.json の revision は完全な SHA である', () => {
    expect(fixtures.length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(sourcePath, 'utf8')).revision).toMatch(/^[0-9a-f]{40}$/i);
  });

  it.each(fixtures)('$description', ({ input, expected }) => {
    const readFile = () => {
      if (input === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return input;
    };

    expect(readReviewRoute({
      env: { AGENT_COCKPIT_HOME: '/agent-cockpit-routing-test' },
      homedir: '/unused-home',
      readFile,
    })).toBe(expected.review);
  });

  it('読み取りに失敗したときは default を返す', () => {
    const readFile = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };

    expect(readReviewRoute({
      env: { AGENT_COCKPIT_HOME: '/agent-cockpit-routing-test' },
      homedir: '/unused-home',
      readFile,
    })).toBe('default');
  });
});
