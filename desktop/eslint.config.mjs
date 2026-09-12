// 桌面端的 lint。和引擎那份同一条规矩:**只留能抓到真错的规则**,不做风格警察。
// 这里额外要管的是三种运行环境:主进程(Node + Electron)、渲染层(浏览器 + React)、
// 工具脚本(Node)。三者的全局变量集不同,混在一起会互相误报。
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const shared = {
  'no-constant-binary-expression': 'error',
  'no-self-compare': 'error',
  'no-unreachable-loop': 'error',
  'no-template-curly-in-string': 'error',
  eqeqeq: ['error', 'smart'],
  // 回测的条件搭建器用全角空格排流程图(`　　　└──否→`),那是内容不是笔误
  'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipJSXText: true }],
  'no-promise-executor-return': 'off',
  'require-atomic-updates': 'off',
  'no-useless-assignment': 'off',
};

export default tseslint.config(
  {
    ignores: [
      'node_modules/**', 'build/**', 'dist/**',
      'renderer-react/dist/**', 'renderer-react/dist-preview/**', '.uipreview/**',
    ],
  },

  // ---- 渲染层:React + 浏览器 ----------------------------------------------
  {
    files: ['renderer-react/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...shared,
      // 这一条真能抓到 bug:K线 PA 的 20 秒自动刷新就是因为依赖数组写错,
      // 每取一次数就拆掉重建一次定时器,周期漂成「20 秒 + 一次取数耗时」(见 docs/features/ui.md)
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',   // 引擎回包的结构由引擎定
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  // ---- 主进程与预加载:Node + Electron(CommonJS)----------------------------
  {
    files: ['main.js', 'preload.js', 'rpc-client.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },  // preload 两边的全局都碰得到
      sourceType: 'commonjs',
    },
    rules: shared,
  },

  // ---- 工具脚本:Node ---------------------------------------------------------
  {
    files: ['tools/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: { ...shared, 'no-console': 'off' },
  },

  // ---- 预览台注入的假 bridge:跑在渲染层里,是经典脚本 ------------------------
  {
    files: ['tools/mock-bridge*.js'],
    languageOptions: { globals: { ...globals.browser, module: 'writable' }, sourceType: 'script' },
  },

  // ---- 图表引擎:经典脚本,挂在 window 上 -------------------------------------
  {
    files: ['renderer-react/public/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
    rules: shared,
  },
);
