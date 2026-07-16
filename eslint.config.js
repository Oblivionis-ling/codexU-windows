module.exports = [
  {
    ignores: ['backups/**', 'dist/**', 'node_modules/**']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        exports: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly'
      }
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        document: 'readonly',
        window: 'readonly'
      }
    }
  }
];
