const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const HtmlPlugin = require('html-webpack-plugin');

// —— 共享的 UI 模板拼装 ——
// 控制面板的 HTML/CSS 是扩展 popup 与 Web 版面板共用的一份（src/ui.css + src/ui-body.html），
// 差异只在"外壳"：扩展的 popup.html 是 380px 弹窗，Web 版是宽屏页面 + 自己的一小段额外 UI。
// 用占位符替换而不是引入 pug/ejs 之类的模板引擎，保持零新依赖。
const read = (p) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

function buildTemplate(shellPath, opts = {}) {
  let html = read(shellPath);
  if (opts.webCss) html = html.replace('/*__EASYSUB_WEB_CSS__*/', () => read(opts.webCss));
  if (opts.extras) html = html.replace('<!--__EASYSUB_WEB_EXTRAS__-->', () => read(opts.extras));
  html = html.replace('<!--__EASYSUB_UI_BODY__-->', () => read('src/ui-body.html').trimEnd());
  html = html.replace('/*__EASYSUB_UI_CSS__*/', () => read('src/ui.css').trimEnd());
  return html;
}

// 离线翻译运行时的静态资源：onnxruntime-web 的 wasm 二进制 + 对应的 .mjs 包装。
// 坑：onnxruntime 会动态 import `ort-wasm/ort-wasm-simd-threaded.jsep.mjs` 等文件，
// 只拷 .wasm 会 "Failed to fetch dynamically imported module"，故统一拷全量 ort-wasm*。
// ort.bundle.min.mjs 是它按 worker 自身地址解析到根目录的 ESM 运行时，也要单独拷一份。
const ortPatterns = [
  { from: 'node_modules/onnxruntime-web/dist/ort-wasm*', to: 'ort-wasm/[name][ext]' },
  { from: 'node_modules/onnxruntime-web/dist/ort.bundle.min.mjs', to: 'ort.bundle.min.mjs' },
];

// 构建前置断言（两类，缺一不可）：
//   ① sherpa-onnx 运行时（main-asr.js/.wasm 等）不进 git，靠 `npm run download-wasm` 取得。
//      缺失时 CopyPlugin 只会静默跳过一个 pattern，产物少文件却构建成功——在浏览器里
//      表现为"识别永远起不来"，极难定位。
//   ② sherpa-onnx-asr.js / sherpa-onnx-punctuation.js 是**仓库里 git 跟踪的补丁版**，
//      下载包铺开后必须是打过补丁的那一份。有人手动用 release 原始版覆盖的话，构建能过、
//      运行时才炸（config 被整体替换 / module 未定义），所以这里连"是不是补丁版"一起校验。
const PATCHED_LOADERS = ['public/wasm/sherpa-onnx-asr.js', 'public/wasm/sherpa-onnx-punctuation.js'];
function assertWasmAssets() {
  const required = [
    'public/wasm/sherpa-onnx-wasm-main-asr.js',
    'public/wasm/sherpa-onnx-wasm-main-asr.wasm',
    'public/wasm/sherpa-onnx-punctuation.js',
    'public/wasm/sherpa-onnx-asr.js',
    'public/wasm/preload.js',
  ];
  const missing = required.filter((p) => !fs.existsSync(path.resolve(__dirname, p)));
  if (missing.length) {
    throw new Error(
      `缺少 WASM 运行时文件：\n  ${missing.join('\n  ')}\n` +
      '请先执行 `npm run download-wasm`（Linux/macOS 用 `npm run download-wasm:sh`）。',
    );
  }
  const unpatched = PATCHED_LOADERS.filter((p) => !read(p).includes('补丁版本'));
  if (unpatched.length) {
    throw new Error(
      `以下文件不是 git 跟踪的补丁版本（缺失补丁标记）：\n  ${unpatched.join('\n  ')}\n` +
      '很可能是用 `npm run download-wasm` 铺开的 release 原始版覆盖了补丁版。\n' +
      '请执行：git checkout -- public/wasm/sherpa-onnx-asr.js public/wasm/sherpa-onnx-punctuation.js\n' +
      '（两个下载脚本与 CI 都会自动还原这一份，见 README「开发」的 ⚠️ 说明。）',
    );
  }
}

// 字幕浮窗外壳（扩展悬浮窗 + Web 字幕浮窗）共用一份 markup/style，同 popup 的处理方式
function buildSubtitleTemplate(shellPath) {
  return read(shellPath)
    .replace('/*__EASYSUB_SUBTITLE_CSS__*/', () => read('src/subtitle-shell.css').trimEnd())
    .replace('<!--__EASYSUB_SUBTITLE_BODY__-->', () => read('src/subtitle-shell.html').trimEnd());
}

const baseRules = {
  module: {
    rules: [
      { test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      // 坑：@huggingface/transformers 的 exports 指向预打包的 transformers.web.js，
      // 它是"webpack 包套 webpack 包"，内层 publicPath 会烘焙成绝对路径，扩展里必坏。
      // 改打包其 src 源码，让 onnxruntime-web 成为真正的依赖被 webpack 内联（无外部加载）。
      '@huggingface/transformers': path.resolve(__dirname, 'node_modules/@huggingface/transformers/src/transformers.js'),
    },
  },
};

// ponytail: transformers src/env.js 用 import.meta，webpack 5.87+ 把它替换成
// { url, webpack:5, main: __webpack_module__===... }，而经典 worker（非 ESM 输出）
// 不定义 __webpack_module__ 直接 ReferenceError。注入一个变量即可；
// 其 url 被烘焙成 file:///E:/... 只喂 cacheDir/localModelPath 默认值，
// worker 里已用显式 wasmPaths/localModelPath/useBrowserCache 覆盖，无害。
const workerBanner = () => new webpack.BannerPlugin({
  banner: 'var __webpack_module__;',
  raw: true,
  entryOnly: true,
  test: /translation-worker/,
});

// ============ ① 浏览器扩展（MV3，默认构建） ============
function extensionConfig() {
  // 同样的前置断言：扩展产物里若缺 wasm 运行时，识别也是永远起不来（见 assertWasmAssets）
  assertWasmAssets();
  return {
    ...baseRules,
    entry: {
      background: './src/background.ts',
      content: './src/content.ts',
      popup: './src/popup.ts',
      offscreen: './src/offscreen.ts',
      floating: './src/floating.ts',
      'translation-worker': './src/translation-worker.ts',
      permission: './src/permission.ts',
      // 页面媒体采音（内容脚本，按需由 background 用 chrome.scripting 注入；Web 版没有）
      'page-audio': './src/page-audio.ts',
      i18n: './src/i18n.ts', // ponytail: 纯导出模块做 entry 生成孤立 i18n.js，不被任何页面引用
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'public', to: '.' },
          { from: 'manifest.json', to: '.' },
          { from: '_locales', to: '_locales' },
          ...ortPatterns,
        ],
      }),
      new HtmlPlugin({
        templateContent: () => buildTemplate('src/popup.html'),
        filename: 'popup.html',
        chunks: ['popup'],
      }),
      // pitfall: HtmlPlugin 会自动注入 <script defer src="offscreen.js">，
      // 所以 template 里不能手动写 <script src="offscreen.js">，否则同一文件执行两遍
      new HtmlPlugin({
        template: 'src/offscreen.html',
        filename: 'offscreen.html',
        chunks: ['offscreen'],
      }),
      new HtmlPlugin({
        template: 'src/permission.html',
        filename: 'permission.html',
        chunks: ['permission'],
      }),
      new HtmlPlugin({
        templateContent: () => buildSubtitleTemplate('src/floating.html'),
        filename: 'floating.html',
        chunks: ['floating'],
      }),
      workerBanner(),
    ],
  };
}

// ============ ② 纯 Web 版（可静态托管，nomodel） ============
// 与扩展版的差别只有三处，其余（面板 UI、识别引擎、标点、翻译、叠层、字幕记录）
// 全部复用同一份源码：
//   ① 音源只有系统音频与麦克风（没有"当前标签页"这个概念）；
//   ② 字幕显示端是 window.open 出来的浮窗（对应扩展的悬浮字幕窗）；
//   ③ 不打包 412MB 的识别模型 .data（GitHub Pages 单文件上限 100MB），
//      用户首次使用时在面板里一键下载或手动导入一次（存 IndexedDB）。
function webConfig() {
  // 坑：sherpa-onnx 的 wasm 与加载器脚本不进 git（见 README「开发」），必须在构建时
  // 显式校验存在——否则 CopyPlugin 会静默跳过，构建"成功"但产物跑不起来（页面注入
  // wasm 脚本 404 → waitForWasm 30s 超时，识别永远起不来，且现象与"环境不合格"相似，
  // 排查成本极高）。扩展构建同理，但它的产物本来就要求这些文件，这里一并断言。
  assertWasmAssets();
  return {
    ...baseRules,
    entry: {
      panel: './src/web/panel.ts',
      subtitle: './src/web/subtitle.ts',
      'translation-worker': './src/translation-worker.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist-web'),
      filename: '[name].js',
      clean: true,
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          // 坑：必须排除 .data——它是构建机上 public/wasm 里的 412MB 模型，
          // 带进产物后既上传不了也加载不动。用户侧走"一键下载/导入"（存 IndexedDB）。
          { from: 'public', to: '.', globOptions: { ignore: ['**/*.data'] } },
          // 跨源隔离垫片（见 web-static/coi-serviceworker.js 注释）：
          // 静态托管无法下发 COOP/COEP，而 sherpa-onnx 的 wasm 是 pthreads 构建，
          // 没有跨源隔离就起不来。由它在客户端补响应头。
          { from: 'web-static', to: '.' },
          ...ortPatterns,
        ],
      }),
      new HtmlPlugin({
        templateContent: () => buildTemplate('src/web/index.html', {
          webCss: 'src/web/web.css',
          extras: 'src/web/extras.html',
        }),
        filename: 'index.html',
        chunks: ['panel'],
      }),
      // pitfall: 同扩展的 floating.html——不要手写 <script src="subtitle.js">，
      // HtmlPlugin 已自动注入，手写会让同一脚本执行两遍（监听器注册两次）
      new HtmlPlugin({
        templateContent: () => buildSubtitleTemplate('src/web/subtitle.html'),
        filename: 'subtitle.html',
        chunks: ['subtitle'],
      }),
      workerBanner(),
    ],
  };
}

module.exports = (env) => (env && env.target === 'web' ? webConfig() : extensionConfig());
