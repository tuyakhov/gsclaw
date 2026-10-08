import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Modules under src/core must run unchanged on Node, Vercel, Netlify and Cloudflare Workers.
const NODE_ONLY_MODULES = [
  'node:*',
  'fs',
  'fs/*',
  'path',
  'os',
  'crypto',
  'http',
  'https',
  'net',
  'tls',
  'child_process',
  'stream',
  'buffer',
  'url',
  'util',
  'srvx',
  'srvx/*',
  '@modelcontextprotocol/server/stdio',
];

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', '.wrangler', '.vercel', '.netlify'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: NODE_ONLY_MODULES,
              message: 'src/core must stay runtime-agnostic (no Node-only APIs).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Pass env in from the adapter instead.' },
        { name: 'Buffer', message: 'Use Uint8Array / TextEncoder instead.' },
        { name: '__dirname', message: 'Not available outside Node.' },
        { name: 'require', message: 'ESM only.' },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
