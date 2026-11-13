// Prüfregeln für `npm run lint` (läuft auch in den GitHub-Tests). Nur echte Fehler brechen ab.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'modules/**', 'data/**', 'logs/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      // Absichtlich weggelassene Eigenschaften ({ geheim, ...rest }) und _-Namen sind erlaubt.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // BOM (﻿) am Dateianfang wird per Regex entfernt – dort ist das Zeichen gewollt.
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true, skipTemplates: true, skipComments: true }],
      eqeqeq: ['error', 'smart'],
    },
  },
  { files: ['oberflaeche/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser } } },
  { files: ['tests/**/*.js'], rules: { 'no-regex-spaces': 'off' } },
];
