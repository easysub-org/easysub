# 易字幕 / EasySub

<p>
  <img src="logo.jpg" width="64" height="64" style="border-radius:12px;">
</p>

免费、安全的基于本地模型的实时字幕浏览器扩展。

[目前已上架微软插件市场](https://microsoftedge.microsoft.com/addons/detail/elphdofjlfpccfkcfaamkodcniemecao)

[网页版-预览版](https://easysub-preview.hcz1017.dpdns.org/)

## 简介

易字幕 是一款完全离线的浏览器扩展，无需注册、无需联网、无需上传任何数据。通过 WASM 在本地运行语音识别模型，在浏览任意网页时实时生成字幕。

- **免费** — 无付费，无订阅
- **安全** — 所有计算在本地完成，音频数据不上传
- **离线** — 模型加载后可离线使用
- **实时** — 低延迟流式识别，说话即现

## 使用

1. 安装扩展后，点击浏览器工具栏的图标打开面板
2. 点击 **开始** 按钮
3. 当前标签页播放的音频会实时生成字幕叠加层
4. 字幕层操作：
   - 拖动调整位置；**锁定**后只剩纯文字（锁定状态持久记忆，重启后不丢）
   - 点左上角箭头**回看最近 10 句**——走神漏看时立即补看，锁定状态下也可用
   - 右下角**延迟指示器**：🟢 优秀 <200ms ｜ 🟡 中 <1s ｜ 🔴 高 ≥1s（建议检查设备资源占用）；未锁定时直接显示实时毫秒数，锁定后收起为色点、悬停查看状态
5. 面板功能：
   - **搜索**历史字幕：实时过滤 + 命中高亮 + 命中计数
   - 较高级的设置项旁有 **？** 图标，悬停查看中英双语详细说明
   - 近句回看与延迟指示器均可在面板中**开关**（默认开启，关闭后零性能开销）

## 想识别「整机声音」（浏览器之外的声音）？装本机助手

浏览器只能拿到**当前标签页**或**麦克风**的声音；想识别浏览器之外的声音（播放器、会议软件、
系统提示音…），需要本机助手来采：

1. 到 [easysub-helper Releases](https://github.com/easysub-org/easysub-helper/releases) 下载对应平台的文件并运行
   （助手是独立仓库；Windows 首次可能被 SmartScreen 拦 →「更多信息 → 仍要运行」，
   macOS 未签名 → 右键「打开」或 `xattr -d com.apple.quarantine easysub-helper`）。
2. 面板里把「音频来源」选成最后一项 **桌面助手**，点「开始」。
3. 弹出配对框后，把助手窗口里的 6 位配对码填进去（**只需一次**，之后不再问）。

日常注意两点：

* 助手窗口的总开关**默认是暂停**：配对不需要点它，但要听到声音得点一次「启动」
  （状态行显示「正在采集…」，电平图会动）。助手开着处于暂停时，页面这条音源是**静音**、
  识别照常跑，不会报错。
* 助手**没在运行**时，页面会**拦住「开始」**并给出下载链接（而不是让你对着一个静音的会话发呆）。

助手窗口里还有：**关闭窗口时最小化到托盘**（服务继续跑）、**已配对设备 → 管理…**（逐个/全部解绑）。
更多细节（Linux 依赖、macOS 系统音频、端口、排障）见
[助手仓库的 README](https://github.com/easysub-org/easysub-helper#readme)。

## 开发

```bash
npm install
# 首次构建需要下载 WASM 运行时与模型 (full 版 412MB)：它提供 sherpa-onnx-wasm-main-asr.js /
# .wasm / .data（这些不进 git）。注意下载包里带的 sherpa-onnx-asr.js 是**未打补丁的原始版**，
# 会覆盖仓库里 git 跟踪的补丁版 —— 见下方 ⚠️，脚本与 CI 都会在下载后把它还原。
npm run download-wasm
# 如需轻量版 (lite, 150MB) 使用:
npm run download-wasm -- --lite
npm run build
```

> Windows 上用 PowerShell 脚本；Linux/macOS 用 `npm run download-wasm:sh`（等价）。
>
> ⚠️ `public/wasm/sherpa-onnx-asr.js` 和 `public/wasm/sherpa-onnx-punctuation.js`
> 是**git 跟踪的补丁版本**（`.gitignore` 用 `!` 负向规则单独放行），修复了 WASM builder
> release 中 config 被替换、module 守卫缺失的 bug。下载脚本铺开整包后必须把它们还原：
> 手动操作时请执行 `git checkout -- public/wasm/sherpa-onnx-asr.js public/wasm/sherpa-onnx-punctuation.js`，
> **不要直接替换成 release 原始版**。

然后 Chrome → 扩展程序 → 加载已解压的扩展 → 选择 `dist/` 目录。

### 纯 Web 版

同一份源码还能构建出一个**不依赖任何扩展 API 的静态网页版**，可以直接扔到 GitHub Pages、
对象存储或任意静态服务器上（`npm run build:web` → `dist-web/`）：

```bash
npm run build:web
# dist-web/ 即为可托管的静态站点。本地预览首选（自带跨源隔离响应头，免首次刷新）：
npm run serve:web             # http://127.0.0.1:8000，可跟端口参数，如 serve:web 8322
# 或任意静态服务器（靠 dist-web/coi-serviceworker.js 在客户端补头，首次访问会自动刷新一次）：
npx serve dist-web            # 或 python -m http.server -d dist-web
```

Web 版与扩展版的差别只有三处，识别引擎、标点、翻译、字幕层、控制面板全部是同一份代码：

| | 扩展版 | Web 版 |
|---|---|---|
| 音频来源 | 当前标签页 / 系统音频 / 麦克风 | 系统音频 / 麦克风 |
| 字幕显示 | 页内叠加层，或悬浮字幕窗 | 字幕浮窗（可置顶，`window.open` 独立窗口） |
| 识别模型 | 包内自带（full/lite）或首次导入 | 首次使用时一键下载或手动导入（存 IndexedDB，之后长期有效） |

会话生命周期两端对齐（这些是最容易被漏掉、漏掉就"看起来一样、用起来不一样"的部分）：

- **开始识别**：自动打开字幕浮窗，并把面板窗口缩到屏幕右上角让位（浏览器只允许脚本
  打开的窗口调整自身几何，所以面板自己挪不动时会请浮窗用 `window.opener` 代劳；
  两条路都不行时如实提示，不假装挪过）。停止时恢复原窗口几何。
- **模型缺失**：整页环境用带遮罩的居中大卡（不是角落里的小卡片），下载/导入完成后
  亮出「开始识别」主按钮。**不自动续跑**是刻意的——首次下载 412MB 要几分钟，
  那次点击的用户手势早已过期，此时再调 `getDisplayMedia` 必被浏览器拒绝，
  表现为"模型下好了却卡住"。用户点按钮的那一刻才是新鲜手势。
- **停止 / 关闭浮窗**：两者互为因果。点停止会关掉字幕浮窗；手动关掉浮窗即结束会话
  （浮窗是唯一显示端）。取消勾选「显示字幕」只是隐藏浮窗，识别继续跑
  （面板里还有实时预览与字幕记录）。浮窗刷新（F5）不算关闭：新文档会重新握手、
  补齐状态与当前字幕，会话继续。
- **会话配置回源**：翻译开关/方向/时机、标点开关、端点阈值、热词都存在 storage 里，
  宿主在每次 START 时读取（与扩展 background 的行为一致），改完设置后下次开始生效。
  端点阈值与热词是烘焙进识别器的，配置变了会自动重建识别器（两端都如此）。
- **翻译模型按站点隔离**：IndexedDB 跟着源走——在扩展里导入过的翻译模型**不会**
  出现在网页版，需要在网页版「实时翻译 → 选择模型」重新导入一次（识别模型同理，
  但 Web 版本来就是首次下载到当前站点）。「模型状态」会显示已加载的文件数，
  「测试翻译」可以一键验证整条链路。

> ⚠️ **Web 版必须处于「跨源隔离」状态**。sherpa-onnx 的 wasm 是 pthreads 构建
> （共享内存 + worker），没有 `crossOriginIsolated` 连初始化都会抛 `DataCloneError`。
> 具体见下方「跨源隔离」一节。

#### 跨源隔离（Web 版部署必读）

普通网页需要服务端下发两个响应头才能进入隔离态：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**GitHub Pages 等静态托管不允许自定义响应头**，所以 `dist-web/` 里带了一个
`coi-serviceworker.js`：它注册一个 Service Worker，在客户端给同源响应补上这两个头。
首次访问会自动刷新一次（Service Worker 接管后才生效），之后页面即为隔离态。
用户无需任何操作。

如果托管方支持自定义头（Cloudflare Pages / Netlify / 自建 nginx），直接用响应头即可，
`coi-serviceworker.js` 检测到已隔离会自动空转，不会重复刷新。nginx 示例：

```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

页面加载时会自检这两个条件，不合格就在说明区直接显示原因与处理办法（不会静默失败）。

**GitHub Pages 具体说明**：Pages **没有**任何自定义响应头机制（没有 Netlify 的
`_headers` 文件，也没有 Cloudflare Pages 的头配置），所以这两个头在 Pages 上
**只能靠 `coi-serviceworker.js` 在客户端补**：

- 首次访问流程：页面注册 Service Worker → 自动刷新一次 → 刷新后的导航响应被 SW
  拦截并补上 COOP/COEP → 页面进入 `crossOriginIsolated`。那次刷新是必然的一次性
  代价（刷新次数有 `sessionStorage` 计数上限 3 次，不会无限刷）。
- **跨源请求会被 SW 原样放行**（否则破坏 CORS 语义）。识别模型从 ModelScope 下载，
  其响应带 `Access-Control-Allow-Origin: *`，在 `require-corp` 下能通；若换成不带
  CORS 头的镜像源，"一键下载模型"在 Pages 上会失败。
- Range 请求（大文件分片）同样原样放行，不补头也不改写（包一层 Response 会丢掉
  206 语义）。
- Pages 强制 HTTPS，满足安全上下文要求；`coi-serviceworker.js` 必须与 `index.html`
  同目录、同源部署。
- 本地开发用 `npm run serve:web`（自带 COOP/COEP 响应头），可以省掉垫片的那次
  自动刷新；生产环境不依赖本地服务。

#### 获取与使用

- **发布版**：带版本号的 workflow 运行会把 `easysub-web-v*.zip` 与扩展包一起发布到
  GitHub Releases（资产名 `web`）。
- **CI 产物**：日常构建（push / PR / 不带版本号的手动运行）也会把 `dist-web/` 单独打成
  `easysub-web*.zip` 上传为 workflow artifact（artifact 名叫 `web`），
  下载解压到任意静态目录即可托管。
- **使用流程**：打开页面 → 环境自检（安全上下文 + 跨源隔离，不合格会在页面说明区给出
  原因与处理办法）→ 点「开始」→ 首次按引导下载或导入识别模型（存 IndexedDB，之后
  长期有效）→ 选系统音频或麦克风开讲。翻译模型同样在面板里导入（「实时翻译 → 选择模型」）。
- **浏览器要求**：现代 Chrome / Edge（需要 AudioWorklet 与 crossOriginIsolated）。

#### 已知限制

- **没有"当前标签页"音源**：网页拿不到 tab id。系统音频走 `getDisplayMedia`——
  整屏 + 勾「共享系统音频」，或选某个标签页 + 勾「共享标签页音频」（后者 Linux 也可用）。
- **无 BroadcastChannel 的极老浏览器**上，面板与浮窗的兜底通道是半双工的
  （字幕能显示，浮窗上的控制可能失灵）；现代 Chrome/Edge 均内置 BroadcastChannel。
- **多开面板标签页没有互斥**：两场会话的字幕会交错进同一个浮窗，别同时开两个面板页。
- **刷新面板页 = 结束会话**：识别引擎就住在面板页里，刷新即销毁；字幕浮窗刷新则会话继续
  （新文档会重新握手并补齐状态）。
- **模型按站点隔离**：IndexedDB 跟着源走，换域名要重新下载/导入（见上）。
- **重新导入识别模型后需要刷新页面**：识别模型是在页面加载时被读进识别运行时的，
  同一个页面内换不掉（扩展版每次停止都会销毁并重建整个运行时，所以没这个问题）。
  网页版会明确提示并给出「刷新页面」按钮，不会让用户点下去却仍用旧模型跑。

### 开发要求（扩展版与 Web 版长期共存）

本分支随后会合并回 master，扩展版与 Web 版从此共用同一份源码。之后所有改动请遵守
（每一条都对应一个真实踩过的坑）：

1. **新功能优先写进共享层**，两端自动都有：

   - 面板 UI：`src/ui-body.html` + `src/ui.css`（扩展 popup 与 Web 面板共用同一份模板），
     逻辑在 `src/panel.ts`
   - 字幕浮窗：`src/subtitle-shell.html` + `src/subtitle-shell.css` + `src/subtitle-shell.ts`
   - 识别引擎：`src/asr-engine.ts`（含 ASR / 标点 / 翻译队列 / 音频采集 / 延迟与电平测量）
   - 字幕记录：`src/transcript-store.ts`
   - 宿主差异：`src/platform.ts`（storage / URL / 消息总线）+ `src/web/`（Web 宿主接线）

   只有真的需要 `chrome.*` 时才在 `src/platform.ts` 里加封装或按 `IS_EXTENSION` 分支；
   **不要在共享模块里直接调 `chrome.*`**，否则 Web 版会跟着一起坏。
2. **收尾前三项检查都要过**：`npm run typecheck`、`npm run build`（扩展）、
   `npm run build:web`（网页版）。只跑其中一个就提交，等于把另一端当实验场。
3. **改共享文件 = 同时改了两端**：消息分支、`ui-body.html` 的元素 id、i18n 键都是
   两端共用的，删除或改名前先确认另一端没有引用。扩展侧的回归基准是 `dist/` 产物与
   master 等价：manifest 逐字节相同、popup 的全部元素 id 保留、原有消息协议不删不改。
4. **i18n 中英成对**：`src/i18n.ts` 的 zh 与 en 键位必须一一对应（目前各 226 键），
   漏掉一侧，另一语言会直接显示键名。
5. **音频出块模式别混**（见「数据流」）：扩展 offscreen 用 **pull**（延迟指示的测量
   口径依赖"发 flush → 收回包"的因果关系）；可能被最小化或遮挡的页面（Web 面板、
   扩展悬浮窗）必须 **push**——后台页面的 `setTimeout` 会被 Chrome 节流到分钟级，
   pull 模式下音频只进不出、识别静默停摆。
6. **Web 宿主的生命周期必须与扩展 background 逐条对齐**：START 时回源 storage 读会话
   配置（翻译开关/方向/时机、标点、端点阈值、热词都不要指望面板消息带来）、结束即关
   显示端、用户关显示端即结束会话、锁态回源 storage——漏任何一条都会表现成
   "看起来一样、用起来不一样"。

## 技术栈

- **识别引擎**: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/) WASM 离线推理
- **模型**: Zipformer 中英双语 — [full] 全量版 (fp32, 412MB) / [lite] 轻量版 (int8, 150MB)
- **Node**: ≥ 18.12（`copy-webpack-plugin` 的下限；CI 固定用 20）
- **标点恢复**: CT-Transformer INT8 + 规则回退（流式非阻塞，句完成调模型）
- **架构**: Chrome Extension Manifest V3

## 架构

```
┌──────────────┐   popup.html     ┌─────────────────────────────┐
│  Popup UI    │ ◄── popup.ts ──  │  Background Service Worker  │
│ (控制面板)    │                  │  (background.ts)            │
└──────────────┘                  │  状态管理 / 消息路由         │
       ▲                         │  offscreen 生命周期          │
       │ chrome.runtime          └───────────┬─────────────────┘
       ▼                                     │ chrome.runtime.connect
┌──────────────────────┐                     │
│  Content Script      │                     ▼
│  (content.ts)        │        ┌──────────────────────────────┐
│  网页字幕叠加层       │ ◄──── │  Offscreen Document          │
│  拖动 / 锁定 / 动画   │        │  (offscreen.html + .ts)      │
└──────────────────────┘        │                              │
                                │  ┌──────────────────────┐    │
                                │  │  sherpa-onnx WASM    │    │
                                │  │  ASR 模型 (Zipformer)│    │
                                │  │  自动断句 + 端点检测  │    │
                                │  └──────────────────────┘    │
                                │  ┌──────────────────────┐    │
                                │  │  CT-Transformer      │    │
                                │  │  标点恢复 (INT8)     │    │
                                │  │  setTimeout(0) 异步  │    │
                                │  └──────────────────────┘    │
                                │                              │
                                │  ┌──────────────────────┐    │
                                │  │  AudioWorklet        │    │
                                │  │  (音频线程)            │    │
                                │  │  独立读帧 / 缓冲      │    │
                                │  │  主线程阻塞不丢帧     │    │
                                │  └──────────────────────┘    │
                                └──────────────────────────────┘
```

### 代码结构（两版共用）

```
src/
  platform.ts        宿主差异的唯一收口（storage / URL 解析 / 消息总线 / 能力探测）
  asr-engine.ts      识别引擎：ASR + 标点 + 翻译优先级队列 + 音频采集 + 延迟/电平测量
  mic-capture.ts     麦克风采集（16k 单声道定长出块），两端共用
  transcript-store.ts 字幕记录持久化（串行写队列 + 裁剪 + 译文按 seq 归位）
  subtitle-shell.ts  字幕浮窗外壳（叠层 + 工具条 + 画中画置顶），两端共用
  overlay.ts         字幕叠层本体（拖拽/锁定/回看/延迟指示/译文行）
  panel.ts           控制面板逻辑            ┐ 与 ui-body.html + ui.css
  ui-body.html       控制面板 DOM（两端同一份）├ 组成两端的面板
  ui.css             控制面板样式            ┘
  background.ts      扩展：SW 路由 / offscreen 与悬浮窗生命周期（Web 版无此角色）
  offscreen.ts       扩展：只做端口接线，引擎在 asr-engine.ts
  floating.ts        扩展：悬浮字幕窗宿主（mic 采集端也在这里）
  popup.ts           扩展：弹窗入口，只负责挂载 panel.ts
  web/panel.ts       纯 Web：面板入口 + 屏幕共享预取 + 字幕浮窗开合
  web/host.ts        纯 Web：扮演 background + offscreen 的角色（同页承载引擎）
  web/subtitle.ts    纯 Web：字幕浮窗宿主
  web/channel.ts     纯 Web：面板 ↔ 浮窗的跨窗口消息通道（postMessage + 心跳握手）
web-static/
  coi-serviceworker.js  Web 版跨源隔离垫片（静态托管无法下发 COOP/COEP）
scripts/
  serve-web.js          Web 版本地预览服务（静态托管 + 跨源隔离响应头）
```

### 数据流

1. **音频捕获**: AudioWorklet（`audio-worklet-processor.js`）在独立音频线程读取音频帧。
   出块模式由宿主任选：**pull**（主线程每 60ms 发 `flush`，扩展 offscreen 用；offscreen
   不受节流影响，且"发 flush → 收回包"的因果关系是延迟指示的测量口径）或 **push**
   （音频线程自己每 60ms 出块，Web 面板页与扩展悬浮窗用——它们可能被最小化或被字幕窗
   盖住而进入后台，`setTimeout` 会被 Chrome 节流到分钟级，pull 模式下音频只进不出、
   识别静默停摆）。
2. **ASR 解码**: `pipeline.feedAudio()` → sherpa-onnx `acceptWaveform()` + `decode()`
3. **流式文本**: `onTextChanged` → 立即送显示 → `setTimeout(0)` 触发标点恢复
4. **标点恢复**: CT-Transformer 模型推理（同步阻塞主线程），AudioWorklet 继续缓冲不丢帧
5. **句完成**: `onSentenceDone` → 终版标点 → 追加到字幕记录 → 清理缓存
6. **显示**: 显示端（页内叠加层 / 字幕浮窗）收到文本 → 更新叠加层（流式标点/终版标点）
7. **延迟测量**: 引擎以 EMA 统计「flush RTT + 解码耗时」，每 ≥2s 推送至字幕层右下角指示器。
   push 模式下 RTT 无因果意义（回包不是 flush 触发的），该项只统计解码耗时

### 进程模型

```
Tab Audio ──→ AudioWorklet (音频线程)
                  │ 持续缓冲
                  │ 60ms 定时 flush
                  ▼
Offscreen 主线程 ──→ ASR 解码 ──→ 文本
                  │                │
                  │      setTimeout(0) 非阻塞
                  │                │
                  ▼                ▼
             AudioWorklet      CT-Transformer
             继续缓冲音频        标点推理（短期阻塞）
                  │                │
                  └── 解阻塞 ────┘
                          │
                          ▼
                     pipeline.feedAudio(积压帧)
```

### 降级路径

- **AudioWorklet 不可用**（极旧 Chrome）→ `ScriptProcessorNode` 缓冲 16384 帧
- **标点模型加载失败** → 纯规则标点（正则 + 上下文判断）
- **MediaStreamTrack 不可转移** → 已确认不可行，AudioWorklet 是正式方案

## 贡献

欢迎 issue 与 PR。**提代码 PR 前请先签 [CLA](CLA.md)**：在你的 PR 里发一条评论，内容照抄

> I have read the CLA Document and I hereby sign the CLA.

即可 —— 你**保留**自己贡献的版权，项目所有者获得"可按任意许可证（含商业许可）再许可"的权利
（`cla` 工作流会自动打标签）。其余约定见 [CONTRIBUTING.md](CONTRIBUTING.md)：本地检查命令、
领域边界（助手是独立仓库、音频契约固定 16k/20ms）、以及 **所有用户可见文案必须中英双语**。

安全问题请走 GitHub 的 **Security → Report a vulnerability**，不要开公开 issue。

## 鸣谢

- [Loser123zbx](https://github.com/Loser123zbx) — Logo 设计
- [jxlpzqc/TMSpeech](https://github.com/jxlpzqc/TMSpeech) — 项目灵感来源
- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/) — 离线语音识别引擎
- [Zipformer](https://github.com/k2-fsa/sherpa-onnx/) — 中英双语识别模型

## 许可证

Copyright (C) 2026 hcz1017

本项目以 **GNU Affero 通用公共许可证第 3 版或更高版本（AGPL-3.0-or-later）** 发布，全文见
[LICENSE](LICENSE)。这意味着：

- 你可以自由使用、修改、再分发（包括商用），但**分发修改版必须同样以 AGPL 提供完整源码**；
- 把修改版当作**网络服务**提供给他人时（例如自己部署一份 Web 版），同样必须向使用者提供对应源码
  （AGPL 第 13 条）。对应源码即：
  主仓库 <https://github.com/easysub-org/easysub>、
  本机助手 <https://github.com/easysub-org/easysub-helper>（独立仓库，同样 AGPL）；
- 想**闭源**集成/再发布是不允许的；确有此需求请联系作者洽谈商业授权；
- "易字幕 / EasySub"名称与图标**不在**许可证授权范围内，请勿用于衍生品的品牌。

> **不追溯**：v1.7.3 及之前已按 MIT 发布的版本，那份授权对已获得副本的每个人**永久有效**；
> 自本次变更起的版本按 AGPL-3.0-or-later 发布。

### 第三方组件

| 组件 | 许可证 | 说明 |
|---|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/) WASM 运行时 | Apache-2.0 | 与 AGPL-3.0 兼容 |
| Zipformer 中英双语模型 | Apache-2.0 | 随 Releases 分发 |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | MIT | |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | Apache-2.0 | |
| [soundcard](https://github.com/bastibe/SoundCard)（助手） | BSD-3-Clause | |
| [aiohttp](https://github.com/aio-libs/aiohttp)（助手） | Apache-2.0 AND MIT | |
| [numpy](https://numpy.org/)（助手） | BSD-3-Clause | |
| [soxr](https://github.com/dofuuz/python-soxr)（助手，**可选**） | **LGPL-2.1-or-later** | 官方二进制**不打包**它，见下 |

助手的高质量重采样是可选的 `soxr`（LGPL）。LGPL 要求使用者能替换该库，而 PyInstaller 单文件
打包做不到，所以**官方发行包只装 `[capture]`（不含 `quality`）**，重采样退回内置 polyphase FIR——
需要极致音质时请自行 `pip install "easysub-helper[quality]"`。

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=easysub-org/easysub&type=Date)](https://star-history.com/#easysub-org/easysub&Date)
