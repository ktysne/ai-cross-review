// Vitest 設定。
// `.claude/worktrees/<name>/` には git worktree (別ブランチの完全なコピー) が置かれるため、
// 既定の探索範囲のままだと配下の tests/ も拾って同じテストが二重に実行される。
// `.claude/**` ごと除外して、テストはこのリポジトリ直下の tests/ だけを対象にする。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['.claude/**', 'node_modules/**'],
  },
});
