// ESLint flat config。
// CLI 本体 (tools/) は CommonJS、テスト (tests/) と設定ファイルは ESM、と実行環境が
// 分かれるため per-file で言語設定を分ける。
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'tools/node_modules/**'],
  },
  js.configs.recommended,

  {
    rules: {
      // best-effort の空 catch を許容する (読めなければ次の候補へ進む、等)。
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 未使用引数・未使用 catch 束縛は許容、_ 接頭辞も許容。
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },

  // CLI 本体 (CommonJS)
  {
    files: ['tools/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globals.node },
  },

  // テスト (Node + ESM)
  {
    files: ['tests/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },

  // 設定ファイル (Node + ESM)
  {
    files: ['*.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },
];
