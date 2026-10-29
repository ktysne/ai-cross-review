import { afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const base = path.resolve('.cross-review');
fs.mkdirSync(base, { recursive: true });
const directory = fs.mkdtempSync(path.join(base, 'state-test-'));
const previous = process.env.CROSS_REVIEW_STATE_DIR;
process.env.CROSS_REVIEW_STATE_DIR = directory;
afterAll(() => {
  if (previous === undefined) delete process.env.CROSS_REVIEW_STATE_DIR;
  else process.env.CROSS_REVIEW_STATE_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
