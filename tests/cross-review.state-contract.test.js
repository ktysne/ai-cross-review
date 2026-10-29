import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeStates, parseStateText, normalizeState, nextState, withTriage, withDismissed, withoutBranch, writeState } = require('../tools/cross-review.js');
const fixtures = new URL('../contracts/cross-review-state/', import.meta.url);
const sha = 'a'.repeat(40);

const writerSteps = {
  'first-round.json': () => nextState(null, { branch: 'feature/x', sha }),
  'converged.json': () => withTriage(writerSteps['first-round.json'](), 'feature/x', { round: 1, sha, outcome: 'converged' }),
  'dismissed.json': () => withDismissed(writerSteps['converged.json'](), 'feature/x', '  対応不要と確認済み  '),
  'reset-branch.json': () => withoutBranch(nextState(writerSteps['dismissed.json'](), { branch: 'feature/other', sha: 'b'.repeat(64) }), 'feature/x'),
};

describe('状態ファイルのパーサー契約', () => {
  for (const name of fs.readdirSync(new URL('parse/', fixtures)).filter((name) => name.endsWith('.json')).sort()) {
    const fixture = JSON.parse(fs.readFileSync(new URL(`parse/${name}`, fixtures), 'utf8'));
    it(`${name}: ${fixture.description}`, () => {
      const parsed = parseStateText(fixture.input);
      expect(parsed).toEqual(fixture.expected);
      if (parsed.kind === 'ok') {
        expect(normalizeState(JSON.parse(fixture.input))).toEqual(fixture.expected.state);
      }
    });
  }
});

describe('状態ファイルの書き手契約', () => {
  it('検証データと再生成手順が対応する', () => {
    expect(fs.readdirSync(new URL('writer/', fixtures)).sort()).toEqual(Object.keys(writerSteps).sort());
  });

  for (const [name, steps] of Object.entries(writerSteps)) {
    it(`${name}: 本番の状態遷移と書き込みの出力がバイト単位で一致する`, () => {
      let written;
      expect(writeState(steps(), {
        writeStateFile: (_path, body) => { written = Buffer.from(body, 'utf8'); },
      })).toBe(true);
      expect(written).toEqual(fs.readFileSync(new URL(`writer/${name}`, fixtures)));
      expect(parseStateText(written.toString('utf8'))).toEqual({ kind: 'ok', state: steps(), issues: [] });
    });
  }
});

describe('状態ファイルの統合契約', () => {
  for (const name of fs.readdirSync(new URL('merge/', fixtures)).filter((name) => name.endsWith('.json')).sort()) {
    const fixture = JSON.parse(fs.readFileSync(new URL(`merge/${name}`, fixtures), 'utf8'));
    it(`${name}: ${fixture.description}`, () => {
      const merged = mergeStates(fixture.shared, fixture.legacy);
      expect(merged).toEqual(fixture.expected);
      expect(mergeStates(merged, fixture.legacy)).toEqual(merged);
    });
  }
});
