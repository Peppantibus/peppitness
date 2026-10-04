// Lint del progetto: correttezza, non stile. Il codice dell'app usa le regole con informazione di tipo
// (promise non gestite, await su valori non thenable); test e script le regole di base.
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'artifacts/**', 'backups/**', 'private-imports/**', 'supabase/**', '.npm-cache/**', '.browser-profile/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked, reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // `void promise` è la convenzione per le promise lanciate di proposito senza attesa.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // I validatori rifiutano proprio i caratteri di controllo: le regex li nominano di proposito.
      'no-control-regex': 'off',
    },
  },
  {
    // Confine con Supabase: il client non è tipizzato (`data: any`), ma ogni risposta viene trattata
    // come unknown e validata (record/owned/contratti) prima dell'uso.
    files: ['src/persistence/*-repository.ts', 'src/auth/*.tsx'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off', '@typescript-eslint/no-unsafe-member-access': 'off', '@typescript-eslint/no-unsafe-return': 'off' },
  },
  {
    files: ['tests/**/*.ts', 'vite.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Fixture JSON modificate liberamente per costruire i casi.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', '*.js', '*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }] },
  },
)
