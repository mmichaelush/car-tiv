import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Flat ESLint config.
 *
 * Type-aware linting needs to know which TypeScript project a file belongs to,
 * and this repository has three with incompatible global libraries (browser,
 * Cloudflare Workers, Node). Each block below therefore names its own tsconfig
 * rather than relying on a single default project.
 *
 * The rules encode the parts of CONTRIBUTING.md a linter can actually enforce.
 */
const sharedRules = {
  /* Types */
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/explicit-module-boundary-types': 'off',
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/restrict-template-expressions': [
    'error',
    { allowNumber: true, allowBoolean: false, allowNullish: false },
  ],

  /* Correctness */
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-console': ['error', { allow: ['warn', 'error'] }],
  'prefer-const': 'error',
  'no-param-reassign': 'error',
  'object-shorthand': 'error',
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'build/**',
      'public/static-data/**',
      '.wrangler/**',
    ],
  },

  js.configs.recommended,

  /* ---------------------------------------------------------------------- */
  /* Browser code                                                            */
  /* ---------------------------------------------------------------------- */
  {
    files: ['src/**/*.ts', 'shared/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { project: './tsconfig.client.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...sharedRules,
      /* A component never talks to the network directly — it goes through a
         repository in src/data. */
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'UI code must not call fetch directly. Use a repository from src/data.',
        },
      ],
    },
  },
  {
    /* The data layer is the one place allowed to use fetch. */
    files: ['src/data/**/*.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },

  /* ---------------------------------------------------------------------- */
  /* Cloudflare Worker code                                                  */
  /* ---------------------------------------------------------------------- */
  {
    files: ['worker/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.worker.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: sharedRules,
  },

  /* ---------------------------------------------------------------------- */
  /* Node scripts and tooling                                                */
  /* ---------------------------------------------------------------------- */
  {
    files: ['scripts/**/*.ts', '*.config.ts'],
    extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { project: './tsconfig.node.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: { ...sharedRules, 'no-console': 'off' },
  },

  /* ---------------------------------------------------------------------- */
  /* Tests — checked against the Cloudflare runtime, like the Worker itself   */
  /* ---------------------------------------------------------------------- */
  {
    files: ['tests/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { project: './tsconfig.test.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...sharedRules,
      'no-console': 'off',
      /* Tests routinely assert on loosely-typed JSON payloads. */
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  /* ---------------------------------------------------------------------- */
  /* UI tests — browser code under happy-dom, so DOM globals, not Workers     */
  /* ---------------------------------------------------------------------- */
  {
    files: ['tests/ui/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { project: './tsconfig.test-ui.json', tsconfigRootDir: import.meta.dirname },
    },
  },

  /* ---------------------------------------------------------------------- */
  /* Plain JavaScript config files, outside every TypeScript project          */
  /* ---------------------------------------------------------------------- */
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },

  /* The pre-paint bootstrap is a classic browser script, not a module. */
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },

  prettier,
);
