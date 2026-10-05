// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 共享控制面板（扩展弹窗 + 纯 Web 版共用）。
//
// 本模块的**全部** DOM 引用都来自 src/ui-body.html 里的 id（两端同一份模板），
// 与宿主的差异只通过 platform.ts 的宿主判定体现：
//   - 音源三态里 'tab' 只有扩展有（HAS_TAB_SOURCE）；
//   - 'overlayVisible' 在 Web 版等价于"是否显示字幕浮窗"，语义一致故沿用同一条链路；
//   - 窄屏（<560px，扩展弹窗恒命中）走单列窄布局，其余走宽屏栅格（web.css 里定义）。
//
// 纪律：新增功能优先加在本文件 + ui-body.html 里，两端自动共享；
// 只有真的需要 chrome.* 才按 IS_EXTENSION 分支，并且分支必须在 platform.ts 有对应封装。
import { getLang, setLang, tSync } from './i18n';
import {
  storage, sendToHost, onMessageFromHost, getActiveTabId,
  hasBundledResource, probeBundledResource, IS_EXTENSION, HAS_TAB_SOURCE, DEFAULT_AUDIO_SOURCE,
} from './platform';
import { listModelKeys, saveModelFilesAtomic, saveModelBlob, getModelFile } from './model-db';
import { TRANSCRIPT_MAX, clearTranscript } from './transcript-store';
import { initCompatCheck, openCompatCheck } from './compat';
// 本机助手（桌面端）：探测 → 配对 → 从桌面端取 16k PCM。产品纪律见 src/helper.ts 文件头。
import {
  HelperInfo, HelperSession, helperErrorMessage, loadHelperSession, pairHelper, probeHelper, saveHelperSession,
  HELPER_RELEASES_URL,
} from './helper';

const $ = (id: string) => document.getElementById(id)!;
// 可选元素（Web 版外壳独有）：扩展 popup 模板里没有这些 id，取值一律走这里，
// 拿到 null 就跳过相关接线——这样同一份面板逻辑能安全跑在两种模板上。
const $opt = (id: string) => document.getElementById(id);

// —— 宿主钩子 ——
// 面板逻辑两端共用，但有两个动作只有纯 Web 版需要，且必须发生在**用户手势内**：
//   ① 预取屏幕共享流（getDisplayMedia 要求瞬时激活，而启动链路里隔着一串 await）
//   ② 打开字幕浮窗（window.open 同样要求手势）
// 与其在面板里写 if (!IS_EXTENSION) 到处分支，不如留一个钩子让 Web 入口注册。
// 扩展入口不注册，两个钩子都是 undefined，行为与改造前逐字节一致。
export interface PanelHostHooks {
  // 「开始」按钮的第一件事（任何 await 之前）。返回对象会合并进 START_RECOGNITION 消息。
  // 抛错视为"用户取消了本次启动"，不再继续。
  prepareStart?(source: 'tab' | 'system' | 'mic' | 'helper'): Promise<Record<string, any> | void>;
  // 本次启动半路夭折（用户取消屏幕选择、环境不合格、模型没装、没有可用音源……）。
  // 宿主用它回收 prepareStart 里已经做掉的副作用——否则"预开的字幕浮窗"会孤零零留在
  // 屏幕上（用户以为已经开始识别了，实际什么都没跑）。扩展侧不注册（它没有预开窗口）。
  startAborted?(): void;
  // 音源下拉的宿主定制（Web 版要把"当前标签页"选项摘掉）
  customizeSources?(sel: HTMLSelectElement): void;
  // 模板文案的宿主定制：Web 版没有"浏览器之外的软件"这种话术，也没有标签页概念，
  // 需要换一批提示。在每次 applyLang 之后调用（语言切换要跟着刷），lang 为当前语言。
  customizeText?(lang: string): void;
  // 音源提示语覆盖：拿到 source 返回自定义文案，返回 undefined 走模板默认的 i18n 文案。
  // Web 版的系统音频走"共享标签页音频"也能用，提示语与扩展侧不是一回事。
  sourceHint?(source: 'tab' | 'system' | 'mic' | 'helper', lang: string): string | undefined;
  // 模型刚就绪（一键下载完成 / 手动导入成功）后的宿主动作。
  // 纯 Web 版用它在此时才注入 wasm 脚本（此前模型缺失，注入会留下半初始化的运行时），
  // 这样用户点「开始」时 wasm 往往已就绪，出字更快。扩展包内自带模型，无需此回调。
  onModelReady?(): void;
  // 刚导入的识别模型**本页换不掉**（纯 Web 版专用）：识别模型是在 wasm 运行时初始化
  // 那一刻读进文件系统的，之后整页范围内无法替换——扩展侧靠"停止即销毁 offscreen 文档"
  // 天然规避，Web 页面常驻。宿主据此返回 true，面板就不再让用户满怀期待地点「开始识别」
  // （那会静默用旧模型跑），改为明确提示刷新页面。
  modelNeedsReload?(): boolean;
  // 模型引导面板的呈现方式。扩展弹窗只有 380px 宽，内置 subpanel 浮层已占满整窗，
  // 足够醒目；纯 Web 版是整页，同一个小卡片缩在角落用户根本注意不到（实测反馈），
  // 所以 Web 侧返回 'modal' 把它变成带遮罩的居中大卡。
  modelGuideStyle?: 'panel' | 'modal';
  // 模型装好后是否要求用户**手动**再点一次才开始识别（纯 Web 版为 true）。
  // 根因是浏览器的瞬时用户激活：Web 版首次安装模型要下载 412MB（分钟级），
  // 等它结束时当初那次点击的手势早已过期，此时再调 getDisplayMedia 必被拒绝——
  // 于是用户看到的现象就是"模型下载好了却卡在那里、必须重开一次"。
  // 正确做法不是假装自动续跑，而是把"再点一次"变成卡片上一个显眼的主按钮：
  // 用户点它的那一刻才是新鲜手势，采集与开窗都能正常完成。
  // 扩展侧不传（下载/导入成功即自动续跑，与改造前一致）。
  manualRestartAfterModel?: boolean;
}
let hooks: PanelHostHooks | null = null;
// 经函数取值：直接读模块级变量会被 TS 的流程分析在"首次赋值前"窄化成 null，
// 属性访问报 never（本模块的接线代码散落在顶层，读点早于任何赋值）。
function hostHooks(): PanelHostHooks | null { return hooks; }

// 「是否要求跨源隔离」：纯 Web 版 true（宿主入口调用一次），扩展 false。
// 面板在点「开始」时据此拦下必然失败的启动，并说明补隔离的两条路。
let needIsolation = false;
export function requireCrossOriginIsolation(on: boolean) { needIsolation = on; }
function preloadNeedIsolation() { return needIsolation; }

// 面板挂载入口：宿主入口模块 import 本模块后立即调用一次。
// 顶层的 DOM 接线与偏好加载在 import 时已跑完（那是初始化，与宿主无关）；
// 这里只做"宿主定制"，必须在用户可能交互之后、且晚于模块体。
export function mountPanel(h: PanelHostHooks = {}) {
  hooks = h;
  h.customizeSources?.(selSource);
  // 宿主定制可能改了选项/文案，提示与语言表都要跟着重算一次
  updateSourceHint();
  refreshHostText();
  // 浏览器兼容性自检（两端共用）：内部按 UA 记忆，同一浏览器只在首次启动弹一次
  void initCompatCheck();
}

const statusDot = $('statusDot');
const btnStart = $('btnStart') as HTMLButtonElement;
const btnStop = $('btnStop') as HTMLButtonElement;
// —— 音频来源（tab=当前标签页 / system=系统音频 / mic=麦克风）——
const selSource = $('selSource') as HTMLSelectElement;
const sourceHintEl = $('sourceHint');
// —— 系统音频不支持·模态提示 ——
const unsupModal = $('unsupModal') as HTMLDivElement;
const unsupTitle = $('unsupTitle');
const unsupBody = $('unsupBody');
const unsupSwitch = $('unsupSwitch') as HTMLButtonElement;
const unsupClose = $('unsupClose') as HTMLButtonElement;
// —— 麦克风启动失败·模态（两端共用）——
// getUserMedia 被浏览器直接拒绝时（设备不存在/系统隐私禁用/曾被拒绝）授权框根本
// 不会出现，会话随即收敛——只给状态栏一行小字，用户看到的就是"没弹框就闪退"。
// 模态把具体原因（DOMException 名映射的排查指引，见 mic-capture.ts micErrorText）顶到眼前。
const micErrModal = $('micErrModal') as HTMLDivElement;
const micErrBodyEl = $('micErrBody');
const micErrOk = $('micErrOk') as HTMLButtonElement;
let micErrBody = '';
function fillMicErrorModalText() {
  $('micErrTitleEl').textContent = tSync(currentLang, 'micErrTitle');
  micErrBodyEl.textContent = micErrBody;
  micErrOk.textContent = tSync(currentLang, 'unsupGotIt');
}
function showMicErrorModal(body: string) {
  micErrBody = body;
  fillMicErrorModalText();
  micErrModal.hidden = false;
  micErrOk.focus();
}
micErrOk.onclick = () => { micErrModal.hidden = true; };
micErrModal.onclick = (e) => { if (e.target === micErrModal) micErrModal.hidden = true; };

// —— 桌面助手·配对（两端共用）——
// 产品决定（2026-10-05 修正）：音源**常驻显示**、介绍固定一句常态文案；**没启动/没配对/
// 暂停都不拦启动**（空音频=静音帧，识别照常）——只有「检测到了但未配对」才在点开始时弹配对框。
// 助手会把本机音频交给任何连上来的页面，所以配对码只显示在用户自己启动的助手窗口里，
// 它就是"用户在场"的证明；配对成功后换长期设备令牌，之后不再打扰用户。
let helperInfo: HelperInfo | null = null;
let helperSession: HelperSession | null = null;
let helperContinuation: (() => void) | null = null;
//: 用户在配对框上点过「取消」（= "这次先不配对，照样开始"）。本次会话内不再弹框，
//: 因为产品决定是"没配对也允许启动、此刻就是静音"——没有这个开关的话，配对框一弹出来
//: 用户就只能"配对"或"放弃启动"，与决定 1 冲突。
//: 复位点：**会话结束**（`setStatus('Stopped')`，覆盖面板停止按钮 / 从字幕浮窗停止 / ERROR
//: 收敛——只挂面板按钮会在 Web 上漏掉浮窗那条路）、换音源、配对成功。取消处理里会在
//: `setStatus('Stopped')` **之后**再置位，避免立刻重弹。
let helperPairSkipped = false;

const helperPairModal = $opt('helperPairModal') as HTMLDivElement | null;
const helperPairCodeEl = $opt('helperPairCode') as HTMLInputElement | null;
const helperPairErrEl = $opt('helperPairErrEl') as HTMLParagraphElement | null;

function fillHelperPairText() {
  if (!helperPairModal) return;
  const set = (id: string, key: string) => { const el = $opt(id); if (el) el.textContent = tSync(currentLang, key); };
  set('helperPairTitleEl', 'helperPairTitle');
  set('helperPairBodyEl', 'helperPairBody');
  set('helperPairCodeLabel', 'helperPairCodeLabel');
  set('helperPairSubmit', 'helperPairSubmit');
  set('helperPairCancel', 'helperPairCancel');
}
function showHelperPairModal() {
  if (!helperPairModal) return;
  fillHelperPairText();
  if (helperPairErrEl) { helperPairErrEl.hidden = true; helperPairErrEl.textContent = ''; }
  helperPairModal.hidden = false;
  helperPairCodeEl?.focus();
}
function hideHelperPairModal() {
  if (helperPairModal) helperPairModal.hidden = true;
  if (helperPairCodeEl) helperPairCodeEl.value = '';
}
function showHelperPairError(text: string) {
  if (!helperPairErrEl) return;
  helperPairErrEl.textContent = text;
  helperPairErrEl.hidden = false;
}
async function submitHelperPair() {
  // **提交前无条件重探**：配对框打开后助手可能重启/漂移端口，拿缓存的 helperInfo.port 去提交
  // 会连到死端口，用户看到的是"没探测到助手"这种误导性错误、而且失败后不重探、只能取消重来
  // （独立审查抓的）。重探一次 ~几百毫秒，换来端口与"是否已配对"都是新的。
  await detectHelper(true);
  const port = helperInfo?.port;
  const code = (helperPairCodeEl?.value || '').trim();
  if (!port) { showHelperPairError(tSync(currentLang, 'helperNotFound')); return; }
  if (!code) return;
  if (helperPairErrEl) helperPairErrEl.hidden = true;
  const res = await pairHelper(port, code);
  if (!res.ok) {
    // 前端按助手的稳定 code 渲染自己的文案（message 只是桌面端语言的兜底）
    showHelperPairError(helperErrorMessage(res.code, res.message, currentLang));
    return;
  }
  helperSession = { port, token: res.token, label: res.label, pairedAt: Date.now() };
  helperPairSkipped = false;          // 配对成功：之后正常不再弹框（本就来问"要不要配"）
  await saveHelperSession(helperSession);
  hideHelperPairModal();
  log(tSync(currentLang, 'helperPairSuccess'));
  const cont = helperContinuation;
  helperContinuation = null;
  if (cont) cont();
}
if (helperPairModal) {
  $opt('helperPairSubmit')?.addEventListener('click', () => { void submitHelperPair(); });
  $opt('helperPairCancel')?.addEventListener('click', () => {
    // 取消 = "这次先不配对，照样开始"（产品决定：没配对也允许启动，此刻是静音）。
    // 坑（独立审查指出的张力）：旧代码这里是 setStatus('Stopped') + return —— 于是
    // "探测到助手但没配对"时用户**永远无法静音启动**。
    // 顺序很关键：`setStatus('Stopped')` 会把 helperPairSkipped 复位（见 setStatus 里的注释，
    // 那是为了覆盖"从浮窗停止"等所有停止路径），所以标志必须在它**之后**再置位，
    // 否则 doStart 读到的还是 false → 立刻又弹一次配对框（死循环）。
    helperContinuation = null;
    hideHelperPairModal();
    updateSourceHint();
    setStatus('Stopped');
    helperPairSkipped = true;
    void doStart();
  });
  helperPairCodeEl?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void submitHelperPair();
  });
}

//: detectHelper 的代次（见函数内的守卫注释）
let detectGeneration = 0;
// 探测本机助手：**音源常驻显示**，介绍固定一句常态文案（不再随启动/配对状态切换）。
// 产品决定（2026-10-05 修正）：不再"探测不到就藏起来"——用户实测在 dist-web 里根本找不到这个
// 音源（CORS/端口一变探测就失败），于是连"该怎么配对"都无从下手。现在改成：
// 音源一直在列表里；**没启动/没配对/暂停都不拦启动**（空音频=静音帧，识别照常），
// 只有"检测到但未配对"才在点开始时弹配对模态（没有令牌，助手的 /ws 反正会拒，先问清楚）。
// 探测结果仍有两个用处：配对框要用端口；端口语/助手重启后回写漂移的端口。
async function detectHelper(full = false) {
  // 代次守卫（独立审查指出）：面板打开时的 quick 探测与"点开始/选音源"的 full 探测可能并发，
  // 谁先发起不一定谁先返回 —— 没有这层守卫时，先发起、后返回的那次会把新结果覆盖回旧状态
  // （helperInfo/helperSession 抖回上一轮的样子，进而误弹/误不弹配对框）。
  const gen = ++detectGeneration;
  const saved = await loadHelperSession();
  let info: HelperInfo | null = null;
  // full=false：面板打开时只探开头几个端口（别在控制台刷 20 条失败请求）；
  // 用户选了「桌面助手」或点了「开始」时用 full=true 全扫一遍（助手可能漂移到后面的端口）。
  try { info = await probeHelper({ full, token: saved?.token }); } catch { info = null; }
  if (gen !== detectGeneration) return;      // 已有更新的一次探测：本次结果作废，别覆盖它
  helperInfo = info;
  // 带上已存令牌探测：助手回 paired=true 才说明这个浏览器配过（B1：以前不带令牌，
  // 于是 paired 恒为 false，"只需配对一次"直接失效）。
  // 端口以**探测到的**为准：助手重启可能漂移端口，令牌与端口无关，不该因此把有效令牌丢掉；
  // 顺手写回 storage，让存储端口跟上（storedPort() 下次直接命中）。
  // 坑（独立审查抓的）：`tokenChecked === false` 表示第二步复探**没问出来**（助手重启中、
  // 端口抖动），这时 paired 只能退回第一步的 false —— 不能据此把已配好的浏览器打成"未配对"
  // （会弹出配对框要求重配）。保留已存会话，真令牌无效时下一次 WS 握手自然会拒绝并降级成静音。
  helperSession = null;
  const keepSaved = !!saved && !!helperInfo && (helperInfo.paired || helperInfo.tokenChecked === false);
  if (keepSaved && saved && helperInfo) {
    helperSession = { ...saved, port: helperInfo.port };
    void saveHelperSession(helperSession);
  }
  updateSourceHint();
}

// —— 系统音频·选择器前置确认框（两端共用）——
const sysPickModal = $('sysPickModal') as HTMLDivElement;
const sysPickTitle = $('sysPickTitle');
const sysPickBody = $('sysPickBody');
const sysPickConfirmBtn = $('sysPickConfirm') as HTMLButtonElement;
const sysPickCancelBtn = $('sysPickCancel') as HTMLButtonElement;
// 坑：系统音频捕获的支持范围随平台差异很大——getDisplayMedia 选择器的「分享系统音频」
// 勾选项：Windows/ChromeOS 全版本支持；macOS 自 Chrome 141（且 macOS 14.2+）起支持；
// Linux/安卓一律不支持（Linux 的 Chromium 明确拒绝采集系统音频）。
// 设计取舍：不支持平台上【不禁用】该选项——置灰会让用户以为插件坏了却无从得知原因。
// 改为始终可选，选中后在提示区说明「当前设备不支持」并给出替代建议（改用麦克风）。
//
// 扩展与 Web 版的判定**刻意不同**（用户要求）：
//   - 扩展：off32 文档里只有"共享整个屏幕并勾系统音频"一条路，平台不支持就是真的没戏，
//     必须在校验点硬拦并弹模态说明，否则用户对着"识别中却没字幕"无从排查。
//   - Web：页面里 getDisplayMedia 还能选"共享某个标签页 + 共享标签页音频"，
//     这条路在 Linux 上照样能拿到声音，所以不做平台限制，交给选择器自己决定。
const UA = navigator.userAgent;
const PLATFORM_HAS_SYSTEM_AUDIO =
  /Windows|CrOS|Chromium OS/i.test(UA) ||
  (/Mac OS X|Macintosh/i.test(UA) && Number(UA.match(/Chrome\/(\d+)/)?.[1] ?? 0) >= 141);
const SYSTEM_AUDIO_SUPPORTED = IS_EXTENSION ? PLATFORM_HAS_SYSTEM_AUDIO : true;
// 麦克风音源不做设备下拉：首次启动时 Chrome 的授权弹窗自带设备选择，
// 且浏览器会记住所选设备，后续不指定 deviceId 即沿用——无需在扩展里重复这套 UI。
const chkOverlay = $('chkOverlay') as HTMLInputElement;
const chkPunct = $('chkPunct') as HTMLInputElement;
const chkShowPrev = $('chkShowPrev') as HTMLInputElement;
const prevOpacitySlider = $('prevOpacitySlider') as HTMLInputElement;
const prevOpacityLabel = $('prevOpacityLabel');
const endpointRule1 = $('endpointRule1') as HTMLInputElement;
const endpointRule2 = $('endpointRule2') as HTMLInputElement;
const endpointRule3 = $('endpointRule3') as HTMLInputElement;
const endpointVal1 = $('endpointVal1');
const endpointVal2 = $('endpointVal2');
const endpointVal3 = $('endpointVal3');
const textPreview = $('textPreview');
const modelStatus = $('modelStatus');
const btnLock = $('btnLock') as HTMLButtonElement;
const lockLabel = $('lockLabel');
const fontSizeSlider = $('fontSizeSlider') as HTMLInputElement;
const fontSizeLabel = $('fontSizeLabel');
const btnLang = $('btnLang') as HTMLButtonElement;
const btnResetOverlay = $('btnResetOverlay') as HTMLButtonElement;
const btnCopy = $('btnCopy') as HTMLButtonElement;
const btnClear = $('btnClear') as HTMLButtonElement;
const transcriptBox = $('transcriptBox');
// —— 历史检索 ——
const searchInput = $('searchInput') as HTMLInputElement;
const searchCount = $('searchCount');
const btnSearchClear = $('btnSearchClear') as HTMLButtonElement;
// —— 新功能开关 ——
const chkLookback = $('chkLookback') as HTMLInputElement;
const chkLatency = $('chkLatency') as HTMLInputElement;
// —— Hero 状态卡 / 主题系统 ——
const hero = $('heroCard');
const statusWordEl = $('statusWord');
const timerEl = $('sessionTimer');
// —— 波形 / 叠层外观 ——
const waveCanvas = $('waveCanvas') as HTMLCanvasElement;
const chkWaveform = $('chkWaveform') as HTMLInputElement;
// —— 时间戳显示开关 ——
const chkShowTs = $('chkShowTs') as HTMLInputElement;
// —— 实时翻译（离线自带模型）——
const chkTranslate = $('chkTranslate') as HTMLInputElement;
// —— 历史字幕显示译文开关 ——
const chkTranscriptTr = $('chkTranscriptTr') as HTMLInputElement;
const btnPickModel = $('btnPickModel') as HTMLButtonElement;
const btnTestTranslate = $('btnTestTranslate') as HTMLButtonElement;
const modelFolderPicker = $('modelFolderPicker') as HTMLInputElement;
const translateNotice = $('translateNotice');
const translateStatus = $('translateStatus');
const translateDirRow = $('translateDirRow');
const translateTimingRow = $('translateTimingRow');
const TRANSLATE_RELEASES_URL = 'https://github.com/easysub-org/easysub/releases';
// —— ASR 模型缺失引导（nomodel 版安装包）——
const ASR_DATA_PATH = 'wasm/sherpa-onnx-wasm-main-asr.data';
const ASR_DB_KEY = '__asr_wasm_data';

let locked = false;
let lastStatus = 'Stopped';
let hasStarted = false; // 是否启动过识别：区分 Hero 卡「待命」与「已停止」两种静止态
let currentLang = 'zh_CN';
// 坑：t19 起存储契约升级为 {text, ts}（ts=Date.now()，0=legacy 无时标哨兵）——
// 读取必须做 string→{text,ts:0} 懒归一化（bg 同款逻辑），否则 .text/.ts 是 undefined 直接炸 UI
// seq：本会话内句序号（1 起）。仅用于实时消息流中 SENTENCE_DONE ↔ TRANSLATION_FINAL 的
// 精确配对；不持久化（storage 侧历史由 bg 按"尾部偏移"归位，见 background.ts 注释）
interface TranscriptEntry { text: string; ts: number; tr?: string; seq?: number }
let transcriptEntries: TranscriptEntry[] = [];
// 本 popup 生命周期内见过的最大句序号：SENTENCE_DONE 的 seq 回绕（小于等于它）
// 即"用户重启了会话"，旧条目的 seq 全部作废（见 SENTENCE_DONE 分支注释）
let maxSeqSeen = 0;
// 引导卡停在"需要刷新页面"的就绪态（刚导入的识别模型本页换不掉）
let asrReloadPending = false;
const PREFS_KEY = 'tmspeech_prefs';
const TRANSCRIPT_KEY = 'tmspeech_transcript';

requestAnimationFrame(() => {
  document.querySelector('.container')?.classList.add('loaded');
});

async function applyLang() {
  currentLang = await getLang();
  const tr = (key: string) => tSync(currentLang, key);
  $('appTitle').textContent = tr('appTitle');
  $('btnStartText').textContent = tr('btnStart');
  $('btnStopText').textContent = tr('btnStop');
  $('audioSource').textContent = tr('audioSource');
  // 坑：sourceDesc 静态块已被音源下拉替换（#sourceDesc 元素不存在），
  // 此处必须同步删除旧赋值，否则 null.textContent 抛错会中断整个 applyLang
  // 坑：这三项必须走可选访问。纯 Web 版会把"当前标签页"选项从下拉里摘掉，
  // $('optSourceTab') 返回 null，直接 .textContent 抛 TypeError —— 而 applyLang
  // 是一整条链，抛错会让后面所有文案刷新与 renderTranscript 全部中断。
  const optTab = $opt('optSourceTab');
  if (optTab) optTab.textContent = tr('sourceTab');
  const optSys = $opt('optSourceSystem');
  if (optSys) optSys.textContent = tr('sourceSystem');
  const optMic = $opt('optSourceMic');
  if (optMic) optMic.textContent = tr('sourceMic');
  const optHelper = $opt('optSourceHelper');
  if (optHelper) optHelper.textContent = tr('sourceHelper');
  $('sourceTip').textContent = tr('sourceOutsideTip');
  updateSourceHint();
  // 模态开着时切语言：卡片文案同步刷新（见 fillUnsupportedModalText 注释）
  if (!unsupModal.hidden) fillUnsupportedModalText();
  // 选择器前置确认框同理：开着时切语言不能停在旧语言
  if (!sysPickModal.hidden) fillSysPickModalText();
  // 麦克风失败模态同理
  if (!micErrModal.hidden) fillMicErrorModalText();
  // 配对模态的语言也要跟着切换刷新（与 mic 错误模态同一处理）
  if (helperPairModal && !helperPairModal.hidden) fillHelperPairText();
  $('showSubtitles').textContent = tr('showSubtitles');
  $('fontLabel').textContent = tr('font');
  $('modelInfo').textContent = tr('modelInfo');
  const rt = document.getElementById('readyText');
  if (rt) rt.textContent = tr('ready');
  $('transcriptLabel').textContent = tr('transcript');
  $('copyLabel').textContent = tr('copy');
  $('clearLabel').textContent = tr('clearTranscript');
  $('disclaimer').textContent = tr('disclaimer');
  $('resetOverlayLabel').textContent = tr('resetPosition');
  $('showPunct').textContent = tr('showPunct');
  // 坑：punctNote 小字注释已升级为 ? 帮助气泡，原元素与赋值一并移除；
  // 帮助文案必须在 applyLang 内刷新，否则语言切换后气泡仍显示旧语言
  $('helpTipPunct').textContent = tr('helpPunct');
  $('helpTipPrev').textContent = tr('helpPrev');
  $('helpTipEndpoint1').textContent = tr('helpEndpoint1');
  $('helpTipEndpoint2').textContent = tr('helpEndpoint2');
  $('helpTipEndpoint3').textContent = tr('helpEndpoint3');
  document.querySelectorAll<HTMLElement>('.help-btn').forEach(b => b.setAttribute('aria-label', tr('helpHint')));
  $('showPrev').textContent = tr('showPrev');
  $('prevOpacity').textContent = tr('prevOpacity');
  $('endpointLabel1').textContent = tr('endpointRule1');
  $('endpointLabel2').textContent = tr('endpointRule2');
  $('endpointLabel3').textContent = tr('endpointRule3');
  $('secDisplay').textContent = tr('secDisplay');
  $('secPrev').textContent = tr('secPrev');
  $('secPunct').textContent = tr('secPunct');
  $('resetEndpointLabel').textContent = tr('resetEndpoint');
  // —— 历史检索 + 新功能开关（文案随语言切换实时刷新）——
  searchInput.setAttribute('placeholder', tr('searchPlaceholder'));
  // 坑（t32）：清除按钮的 aria-label 此前是 HTML 静态中文，英文界面读屏仍报中文——补刷新
  $('btnSearchClear').setAttribute('aria-label', tr('clearSearch'));
  $('showLookback').textContent = tr('showLookback');
  $('helpTipLookback').textContent = tr('helpLookback');
  $('showLatency').textContent = tr('showLatency');
  $('helpTipLatency').textContent = tr('helpLatency');
  // —— 外观主题（色板名/分段控件名随语言切换，统一走 data-key 委托）——
  $('appearanceLabel').textContent = tr('appearanceLabel');
  $('overlayBgLabel').textContent = tr('overlayBgLabel');
  document.querySelectorAll<HTMLElement>('[data-key]').forEach(el => {
    if (el.dataset.key) el.textContent = tr(el.dataset.key);
  });
  $('showWaveform').textContent = tr('showWaveform');
  $('helpTipWaveform').textContent = tr('helpWaveform');
  $('showTimestamps').textContent = tr('showTimestamps');
  $('showTrInHistory').textContent = tr('showTrInHistory');
  $('helpTipTimestamps').textContent = tr('helpTimestamps');
  $('helpTipAppearance').textContent = tr('helpAppearance');
  $('helpTipOverlayBg').textContent = tr('helpOverlayBg');
  $('bgSchemeLabel').textContent = tr('bgSchemeLabel');
  $('helpTipBgScheme').textContent = tr('helpBgScheme');
  $('showAnimations').textContent = tr('showAnimations');
  $('helpTipAnimations').textContent = tr('helpAnimations');
  $('colorModeLabel').textContent = tr('colorModeLabel');
  // 坑（t33 根因）：深色/浅色两个按钮名是 data-key 委托的 span（HTML 无 id）——
  // 此前这里多写了两行 $('modeDark').textContent，$() 返回 null 抛 TypeError，
  // applyLang 从该行起整体中断：helpTipColorMode 气泡/btnLang/状态词/renderTranscript
 // 全部停止刷新，表现为「英文界面下深浅模式 ? 气泡仍是中文」。两行已删，
  // 文案由上方 [data-key] 通用循环正确覆盖；新增 $() 引用时务必复跑 id 存在性比对。
  $('helpTipColorMode').textContent = tr('helpColorMode');
  // —— 实时翻译文案随语言切换（方向选项走上方 [data-key] 通用循环）——
  $('secTranslate').textContent = tr('secTranslate');
  $('showTranslate').textContent = tr('showTranslate');
  $('experimentalLabel').textContent = tr('experimentalBadge');
  $('pickModelLabel').textContent = tr('pickModel');
  $('testTranslateLabel').textContent = tr('testTranslate');
  $('helpTipTranslate').textContent = tr('helpTranslate');
  $('helpTipTranslateTiming').textContent = tr('helpTranslateTiming');
  // —— 热词（窗中窗）+ 导出文案 ——
  $('hotwordsOpenLabel').textContent = tr('hotwordsOpen');
  $('hotwordsTitle').textContent = tr('hotwordsTitle');
  $('hotwordsHint').textContent = tr('hotwordsHint');
  $('hotwordsNextRun').textContent = tr('hotwordsNextRun');
  $('hotwordsSaveLabel').textContent = tr('hotwordsSave');
  $('btnHotwordsClose').setAttribute('aria-label', tr('close'));
  // —— ASR 模型缺失引导（窗中窗）——
  // 坑：卡片处于"模型已就绪"态时标题已被换成 asrModelReadyTitle，这里不能无条件写回
  // 缺失态标题（否则在就绪页面上切语言，标题会变回"缺少语音识别模型"）。
  const asrReadyRow = $opt('asrReadyRow');
  const asrReadyVisible = !!asrReadyRow && !asrReadyRow.hidden;
  $('asrModelTitle').textContent = asrReadyVisible
    ? tr(asrReloadPending ? 'asrModelReloadTitle' : 'asrModelReadyTitle')
    : tr('asrModelTitle');
  // 就绪态下缺模型态的 hint 是自相矛盾的文案（标题已说"模型已就绪"），一并切换可见性
  $('asrModelHint').hidden = asrReadyVisible;
  $('asrModelHint').textContent = tr('asrModelHint');
  $('asrModelLinkGithub').textContent = tr('asrModelGithub');
  $('asrModelLinkGitee').textContent = tr('asrModelGitee');
  $('asrModelLinkModelScope').textContent = tr('asrModelModelScope');
  $('asrModelImportLabel').textContent = tr('asrModelImportBtn');
  $('btnAsrModelClose').setAttribute('aria-label', tr('close'));
  // 坑：下载进行中 applyLang 不能覆盖按钮标签（会把「正在下载…」冲掉）
  if (!($('btnAsrModelDownload') as HTMLButtonElement).disabled) {
    $('asrModelDownloadLabel').textContent = tr('asrModelDownloadBtn');
  }
  $('asrAltToggle').textContent =
    ($('asrAltLinks').classList.contains('open') ? '▲ ' : '▼ ') + tr('asrModelAltToggle');
  // 「模型已就绪 → 再点一次开始」区（仅 Web）：文案随语言切换
  const readyRow = $opt('asrReadyRow');
  if (readyRow && !readyRow.hidden) {
    const readyKey = selSource.value === 'mic' ? 'asrModelReadyHintMic' : 'asrModelReadyHint';
    $opt('asrReadyHint')!.textContent = tr(asrReloadPending ? 'asrModelReloadHint' : readyKey);
    $opt('asrModelStartNowLabel')!.textContent = tr(asrReloadPending ? 'asrModelReloadBtn' : 'asrModelStartNow');
  }
  $('reselectModelLabel').textContent = tr('reselectModel');
  $('exportLabel').textContent = tr('exportLabel');
  $('helpTipExport').textContent = tr('exportHelp');
  refreshHotwordsStatus();
  buildTranslateNotice();
  refreshTranslateStatus();
  updateBgSchemeNames(); // 背景方案名按当前模式+语言刷新（t31，见函数内坑注）
  // Hero 大状态词也要跟随语言刷新（依据最近一次状态与是否启动过；
  // 模型加载中则刷新加载文案本身——见 setHeroLoading）
  statusWordEl.textContent = heroLoadingKey ? tSync(currentLang, heroLoadingKey)
    : tSync(currentLang,
      lastStatus === 'Running' ? 'stateRunning' : (hasStarted ? 'stateStopped' : 'stateReady'));
  btnLang.textContent = tr('langSwitch');
  // 兼容性检测按钮是纯图标：名称走 aria-label + title 随语言刷新
  $('btnCompat').setAttribute('aria-label', tr('compatTitle'));
  $('btnCompat').title = tr('compatTitle');
  updateLockUI();
  renderTranscript();
  refreshHostText();
  // 兼容性检测弹窗跟随语言（compat.ts 注册）：弹窗遮罩挡住了本面板的 btnLang，
  // 用户只能用弹窗内自己的语言按钮——那也是委托到这里切换的，切完由本钩子回填弹窗文案
  (window as any).__easysubCompatRefresh?.(currentLang);
}

// 宿主文案定制的转发（定义在 applyLang 之后避免 TDZ；applyLang 里直接调用本函数）
function refreshHostText() { hostHooks()?.customizeText?.(currentLang); }

async function loadPrefs() {
  const r = await storage.get(PREFS_KEY);
  const prefs: Record<string, any> = r[PREFS_KEY] || {};
  // 音源恢复：三态直读，不做平台相关的静默回退。若在不支持平台上恢复出 system，
  // 用户会立刻看到 updateSourceHint 给出的「当前设备不支持」原因——比偷偷改成 tab
  // 更可理解（用户上次明确选过 system，回退会让他以为选项丢失）。
  // 四态直读（含 helper）：与下面 updateSourceHint 的"选中后当面告知"策略一致
  const savedSource: AudioSourceId = prefs.audioSource === 'mic' ? 'mic'
    : prefs.audioSource === 'system' ? 'system'
    : prefs.audioSource === 'helper' ? 'helper'
    : (HAS_TAB_SOURCE ? 'tab' : DEFAULT_AUDIO_SOURCE);
  selSource.value = savedSource;
  updateSourceHint();
  if (prefs.fontSize) {
    fontSizeSlider.value = String(prefs.fontSize);
    fontSizeLabel.textContent = String(prefs.fontSize);
  }
  chkShowPrev.checked = prefs.showPrev !== false;
  // 新功能开关默认开（!== false），与 savePrefs 的合并语义配合：
  // 老用户 storage 里没有这两个键，首次打开即为默认开启
  chkLookback.checked = prefs.lookbackEnabled !== false;
  chkLatency.checked = prefs.latencyIndicatorEnabled !== false;
  // 坑：字幕开关必须从 prefs 恢复——此前勾选态永远回到 HTML 默认 checked，
  // 与上次会话的真实可见性脱节（START 时才把当次值带上，用户上次的选择丢失）。
  // 键名 overlayVisible 与 START 消息的 msg.overlayVisible 对齐；默认开（!== false）。
  chkOverlay.checked = prefs.overlayVisible !== false;
  // 主题：白名单校验，storage 被手改成未知值时回退 cyan（body 无匹配 data-theme
  // 时 CSS 变量自然落到 :root 默认组，不会出现无色控件）
  const theme = THEMES.includes(prefs.accentTheme) ? prefs.accentTheme : DEFAULT_THEME;
  applyTheme(theme);
  // 叠层外观三模式（契约与 content.ts t18 对齐：glass 默认/solid/outline）
  const bm = BG_MODES.includes(prefs.overlayBgMode) ? prefs.overlayBgMode : 'glass';
  applyBgMode(bm);
  // 背景风格四选一（白名单校验回退 obsidian）
  const bs = BG_SCHEMES.includes(prefs.bgScheme) ? prefs.bgScheme : 'obsidian';
  applyBgScheme(bs);
  // 深浅模式（默认 auto=跟随系统；浅色为独立调色非反色，白名单回退 auto。
  // 老用户存过 'dark'/'light' 的保持原样，不受默认值变更影响）
  const cm = COLOR_MODES.includes(prefs.colorMode) ? prefs.colorMode : 'auto';
  applyColorMode(cm);
  // 动效开关默认关（=== true 才开，与"用户要求默认关闭"对齐）；恢复即挂/摘 .anim
  chkAnim.checked = prefs.animationsEnabled === true;
  applyAnim();
  chkWaveform.checked = prefs.waveformEnabled !== false;
  updateWaveVisibility();
  // 时间戳显示默认开；切换只影响 popup 渲染，不进 FORWARD 链路
  chkShowTs.checked = prefs.showTimestamps !== false;
  // 实时翻译：开关默认关（=== true 才开）；方向白名单校验，非法值回退 auto
  chkTranslate.checked = prefs.translationEnabled === true;
  const tdir = prefs.translationDirection;
  applyTranslateDir(TRANSLATE_DIRS.includes(tdir) ? tdir : 'auto');
  // 翻译时机：白名单校验，非法值回退 stream（实时跟句，与旧行为一致）
  applyTranslateTiming(prefs.translationTiming === 'final' ? 'final' : 'stream');
  updateTranslateUi();
  // 历史字幕显示译文：默认开（!== false）
  chkTranscriptTr.checked = prefs.transcriptTrEnabled !== false;
  const po = prefs.prevOpacity ?? 35;
  prevOpacitySlider.value = String(po);
  prevOpacityLabel.textContent = String(po);
  const r1 = prefs.endpointRule1 ?? 0.8;
  const r2 = prefs.endpointRule2 ?? 0.6;
  const r3 = prefs.endpointRule3 ?? 15;
  endpointRule1.value = String(Math.round(r1 * 10));
  endpointVal1.textContent = r1.toFixed(1) + 's';
  endpointRule2.value = String(Math.round(r2 * 10));
  endpointVal2.textContent = r2.toFixed(1) + 's';
  endpointRule3.value = String(r3);
  endpointVal3.textContent = r3 + 's';
}

// 坑：读-合并-写三段式的经典 lost-update——两个 savePrefs 并发时各自读到同一份旧
// prefs，后写者把自己的合并结果整个覆盖上去，先写者的键无声蒸发（例如选音源的同时
// 另一个回调补写自己的键，audioSource 就是这样被盖丢的，表现为"设置不持久化"）。
// 全部走 Promise 链串行：每个合并都基于上一次写完的最新状态。
let prefsChain: Promise<void> = Promise.resolve();
function savePrefs(partial: Record<string, any>) {
  prefsChain = prefsChain.then(async () => {
    const r = await storage.get(PREFS_KEY);
    const merged = { ...((r[PREFS_KEY] as any) || {}), ...partial };
    await storage.set({ [PREFS_KEY]: merged });
  }).catch(() => {});
}

// 音源提示与当前选择一一对应：mic 给设备指引；system 在支持的平台给选择器操作指引、
// 在不支持的平台给「当前设备不支持」原因与替代建议。三态提示都挂在选中项上，
// 用户选了才会看到原因——这就是「允许切换 + 选中后告知为何不行」的实现点。
function updateSourceHint() {
  // 宿主覆盖优先（Web 版系统音频的说明与扩展不同）
  const src = selSource.value as AudioSourceId;
  const overridden = hostHooks()?.sourceHint?.(src, currentLang);
  if (overridden !== undefined) {
    sourceHintEl.textContent = overridden;
    sourceHintEl.hidden = !overridden;
    return;
  }
  if (selSource.value === 'mic') {
    sourceHintEl.textContent = tSync(currentLang, 'sourceHintMic');
    sourceHintEl.hidden = false;
    return;
  }
  if (selSource.value === 'system') {
    sourceHintEl.textContent = tSync(currentLang, SYSTEM_AUDIO_SUPPORTED ? 'sourceHintSystem' : 'sourceHintNoSysAudio');
    sourceHintEl.hidden = false;
    return;
  }
  if (selSource.value === 'helper') {
    // 产品决定（2026-10-05）：**不再区分"启没启动/配没配对"**——一句常态介绍固定显示。
    // 助手是否在跑只影响"有没有声音"（没启动 = 空音频/静音帧，识别照常），
    // 不影响这个音源的说明。（原先是四种状态各一句，介绍跟着探测结果变来变去。）
    // 助手音源是**实验性**的：提示里附上助手仓库的 Releases 地址（还没装 / 想升级的人
    // 直接点过去）。用 DOM 拼 <a> 而不是 innerHTML —— 文案来自 i18n，不该被当 HTML 解析。
    sourceHintEl.textContent = tSync(currentLang, 'sourceHintHelper') + ' ' + tSync(currentLang, 'helperReleases') + ' ';
    const helperLink = document.createElement('a');
    helperLink.href = HELPER_RELEASES_URL;
    helperLink.target = '_blank';
    helperLink.rel = 'noopener';
    helperLink.textContent = HELPER_RELEASES_URL;
    sourceHintEl.appendChild(helperLink);
    sourceHintEl.hidden = false;
    return;
  }
  sourceHintEl.hidden = true;
  sourceHintEl.textContent = '';
}

// —— C. 主题系统：切 body[data-theme] 换 CSS 变量组，纯属性切换零重排成本 ——
const DEFAULT_THEME = 'cyan';
// 坑：与 popup.html 中五个 .swatch 的 data-theme 一一对应；新增色板要两处同步
const THEMES = ['cyan', 'emerald', 'violet', 'amber', 'rose'];
// 波形当前柱颜色缓存：rAF 每帧读 getComputedStyle 太贵，主题切换时才刷新一次
let accentCache = '#5e9eff';
// 波形静柱色缓存：随深浅模式二态（暗底白柱 / 浅底黑柱），模式切换时刷新
let waveDimCache = 'rgba(255, 255, 255, 0.22)';

function applyTheme(theme: string) {
  document.body.dataset.theme = theme;
  document.querySelectorAll<HTMLButtonElement>('.swatch').forEach(b => {
    const on = b.dataset.theme === theme;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  accentCache = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#5e9eff';
}

document.querySelectorAll<HTMLButtonElement>('.swatch').forEach(b => {
  b.onclick = () => {
    const t = b.dataset.theme!;
    applyTheme(t);
    savePrefs({ accentTheme: t });
  };
});

// —— 叠层外观三模式（契约：overlayBgMode ∈ 'glass'|'solid'|'outline'，字段名勿改）——
// 坑：与 content.ts t18 的 BG_MODES 白名单保持一致，新增模式要两处同步
const BG_MODES = ['glass', 'solid', 'outline'];

// —— 背景风格四选一（t28）：纯 popup 视觉，不进 FORWARD/PREFS_PATCH 链路 ——
const BG_SCHEMES = ['obsidian', 'pitch', 'graphite', 'ember'];

function applyBgScheme(scheme: string) {
  document.body.dataset.bg = scheme;
  document.querySelectorAll<HTMLButtonElement>('.bsg').forEach(b => {
    const on = b.dataset.scheme === scheme;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

document.querySelectorAll<HTMLButtonElement>('.bsg').forEach(b => {
  b.onclick = () => {
    const s = b.dataset.scheme!;
    applyBgScheme(s);
    savePrefs({ bgScheme: s });
  };
});

// —— 动效开关（t28，animationsEnabled 默认关=false）：body.anim 门控呼吸+交错入场 ——
const chkAnim = $('chkAnim') as HTMLInputElement;

function applyAnim() {
  // 坑：系统 prefers-reduced-motion 在 CSS 层用 !important 压过 .anim（层级最高），
  // 这里无需读 matchMedia 双重判断，挂类即可
  document.body.classList.toggle('anim', chkAnim.checked);
}

chkAnim.onchange = () => {
  savePrefs({ animationsEnabled: chkAnim.checked });
  applyAnim();
};

// —— 深浅模式（t29+）：'auto'（默认，跟随系统 prefers-color-scheme）| 'dark' | 'light' ——
// 纯 popup 视觉不进 FORWARD/PREFS_PATCH 链路（同 bgScheme）。
// auto 的实现：body[data-mode] 始终写**解析后的实际值**（dark/light），CSS 无需感知 auto；
// 系统深浅切换时 matchMedia 的 change 事件再解析一次。prefs.colorMode 存的是用户选择
// （auto/dark/light），弹窗高亮也按用户选择走，实际生效模式由这里解析。
const COLOR_MODES = ['auto', 'dark', 'light'];
const darkSchemeMQ = window.matchMedia('(prefers-color-scheme: dark)');
let colorModePref = 'auto';

function applyColorMode(mode: string) {
  colorModePref = mode;
  const eff = mode === 'auto' ? (darkSchemeMQ.matches ? 'dark' : 'light') : mode;
  document.body.dataset.mode = eff;
  document.querySelectorAll<HTMLButtonElement>('.cmode').forEach(b => {
    const on = b.dataset.cmode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  // 波形静柱色随深浅模式二态刷新（canvas 无 CSS 继承，只能 JS 给色）
  waveDimCache = eff === 'light' ? 'rgba(0, 0, 0, 0.20)' : 'rgba(255, 255, 255, 0.22)';
  // 波形当前柱的 accent 缓存跟着实际模式刷（浅色主题是加深变体，与深色不同值）；
  // loadPrefs 里 applyTheme 先于 applyColorMode 执行，不刷的话 auto→浅色时波形仍是深色 accent
  accentCache = getComputedStyle(document.body).getPropertyValue('--accent').trim() || accentCache;
  updateBgSchemeNames();
}

// 跟随系统：仅当用户选了 auto 才响应系统深浅切换（手动模式下系统变化不影响面板）
darkSchemeMQ.addEventListener('change', () => {
  if (colorModePref === 'auto') applyColorMode('auto');
});

// —— 背景方案名随深浅模式联动（t31）：dark=曜石黑/纯黑/石墨蓝灰/暖碳，light=暖灰白/纯白/冷灰蓝/米暖 ——
// 坑：两个维度都要覆盖——语言切换（applyLang）用当前模式的文案，模式切换（applyColorMode）
// 用当前语言的文案；故不能走静态 [data-key] 委托（那只会按深色 key 刷），统一由此函数按
// body.dataset.mode + currentLang 取词。HTML 里这四个 span 已摘除 data-key 防通用循环回写。
function updateBgSchemeNames() {
  const light = document.body.dataset.mode === 'light';
  const names: Record<string, string> = {
    obsidian: tSync(currentLang, light ? 'bgObsidianLight' : 'bgObsidian'),
    pitch: tSync(currentLang, light ? 'bgPitchLight' : 'bgPitch'),
    graphite: tSync(currentLang, light ? 'bgGraphiteLight' : 'bgGraphite'),
    ember: tSync(currentLang, light ? 'bgEmberLight' : 'bgEmber'),
  };
  document.querySelectorAll<HTMLElement>('.bsg .seg-name').forEach(el => {
    const scheme = el.closest<HTMLButtonElement>('.bsg')?.dataset.scheme;
    if (scheme && names[scheme]) el.textContent = names[scheme];
  });
}

document.querySelectorAll<HTMLButtonElement>('.cmode').forEach(b => {
  b.onclick = () => {
    const m = b.dataset.cmode!;
    applyColorMode(m);
    savePrefs({ colorMode: m });
  };
});

function applyBgMode(mode: string) {
  document.querySelectorAll<HTMLButtonElement>('.seg').forEach(b => {
    const on = b.dataset.bgmode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

document.querySelectorAll<HTMLButtonElement>('.seg').forEach(b => {
  b.onclick = () => {
    const m = b.dataset.bgmode!;
    applyBgMode(m);
    savePrefs({ overlayBgMode: m });
    // 运行中即时生效走既有 PREFS_PATCH 转发链路（bg 只转发 payload）
    sendToHost({
      type: 'FORWARD_TO_CONTENT',
      payload: { type: 'PREFS_PATCH', overlayBgMode: m },
    }).catch(() => {});
  };
});

// —— A. 实时波形条：LEVEL 消息入环形采样，rAF 仅在打开+Running 时重绘 ——
const LEVEL_BARS = 60; // 保留最近 60 个采样（~120ms/条 ≈ 7 秒历史）
let levels: number[] = [];
let waveRaf = 0;
//: 减弱动效模式下的低频重绘定时器（没它波形会在没数据时冻住，见 startWave）
let waveTimer = 0;
//: 最近一次收到 LEVEL 的时刻。用来判断"到底还有没有电平数据在来"——见 decayLevelsIfStale。
let lastLevelAt = 0;
let lastDecayAt = 0;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// 无 LEVEL 时的兜底采样（用户实测「波形不动」）：助手没连上、助手处于暂停、采集彻底停掉
// 时，一条 LEVEL 都不会来，波形会**冻结在最后一个形状**上——看着像卡死，其实是没数据。
// 这里按 ~120ms 补一个 0，让它自己落回基线："没声音"就该看起来是空的。
// 只在 Running 时补：停止后本来就画静止基线。
function decayLevelsIfStale() {
  if (lastStatus !== 'Running') return;
  const now = Date.now();
  if (now - lastLevelAt < 300 || now - lastDecayAt < 120) return;
  lastDecayAt = now;
  levels.push(0);
  if (levels.length > LEVEL_BARS) levels.shift();
}

function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = waveCanvas.clientWidth || 300;
  const cssH = 28;
  // 坑：canvas 位图尺寸必须含 dpr，否则高分屏上波形模糊；容器宽变化（罕见）时重设
  if (waveCanvas.width !== Math.round(cssW * dpr)) {
    waveCanvas.width = Math.round(cssW * dpr);
    waveCanvas.height = Math.round(cssH * dpr);
  }
  const ctx = waveCanvas.getContext('2d');
  if (!ctx) return;
  decayLevelsIfStale();     // 没数据时自己落回基线，别冻结在上一帧
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const gap = 2;
  const barW = (cssW - gap * (LEVEL_BARS - 1)) / LEVEL_BARS;
  const mid = cssH / 2;
  for (let i = 0; i < LEVEL_BARS; i++) {
    const v = levels[i] ?? 0;
    // 静止基线：无数据时也画 2px 小柱，避免空白块突兀
    const barH = Math.max(2, v * (cssH - 2));
    // 坑：当前柱取"最新推入的那根"（i === levels.length-1）而非固定最后一格——
    // 打开面板/新会话初始几秒数据不满 60 根时，固定末端柱永远轮到空体位，亮色不出现
    ctx.fillStyle = i === levels.length - 1 ? accentCache : waveDimCache;
    ctx.fillRect(i * (barW + gap), mid - barH / 2, barW, barH);
  }
}

function startWave() {
  // 坑：先 cancel 再启——Running 抖动会连发 startWave，不清旧 rAF 会叠多个循环越画越快
  stopWaveLoop();
  if (!chkWaveform.checked || lastStatus !== 'Running') { drawWave(); return; }
  if (reduceMotion.matches) {
    // 减弱动效：不跑 rAF，但**不能只等 LEVEL 事件**——助手掉线/处于暂停时一条 LEVEL 都不会来，
    // 只靠消息驱动会让波形冻结在最后一帧（独立审查抓的）。改用低频定时器驱动重绘：
    // 既保持"不播放动画"的初衷，又让"没数据 → 落回基线"（decayLevelsIfStale）真的生效。
    drawWave();
    waveTimer = window.setInterval(() => drawWave(), 150);
    return;
  }
  const loop = () => { drawWave(); waveRaf = requestAnimationFrame(loop); };
  waveRaf = requestAnimationFrame(loop);
}

function stopWaveLoop() {
  if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = 0; }
  if (waveTimer) { clearInterval(waveTimer); waveTimer = 0; }
}

function updateWaveVisibility() {
  waveCanvas.style.display = chkWaveform.checked ? '' : 'none';
  levels = []; // 关闭再开从空基线起步，不残留旧形状
  if (lastStatus === 'Running' && chkWaveform.checked) startWave();
  else { stopWaveLoop(); if (chkWaveform.checked) drawWave(); }
}

chkWaveform.onchange = () => {
  savePrefs({ waveformEnabled: chkWaveform.checked });
  updateWaveVisibility();
};

chkShowTs.onchange = () => {
  // 只影响 popup 渲染层，storage 权威数据不动；即时重渲染无需 FORWARD
  savePrefs({ showTimestamps: chkShowTs.checked });
  renderTranscript();
};

chkTranscriptTr.onchange = () => {
  // 同上：只影响 popup 渲染层，译文已在 background 落库，切换即时重渲染
  savePrefs({ transcriptTrEnabled: chkTranscriptTr.checked });
  renderTranscript();
};

// —— 术语/热词：窗中窗子面板（浮层盖在弹出窗内容上，避免二级 HTML 页面）——
const HOTWORDS_KEY = 'tmspeech_hotwords';
const hotwordsPanel = $('hotwordsPanel') as HTMLDivElement;
const hotwordsInput = $('hotwordsInput') as HTMLTextAreaElement;
const hotwordsCountEl = $('hotwordsCount');
const hotwordsStatus = $('hotwordsStatus');
const hotwordsSaveLabel = $('hotwordsSaveLabel');
const btnOpenHotwords = $('btnOpenHotwords') as HTMLButtonElement;
const btnHotwordsClose = $('btnHotwordsClose') as HTMLButtonElement;
const btnHotwordsSave = $('btnHotwordsSave') as HTMLButtonElement;

// 解析 textarea：每行一条 → trim → 去空 → 去重（保序）
function parseHotwords(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of hotwordsInput.value.split('\n')) {
    const s = line.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function updateHotwordsCount() {
  const n = parseHotwords().length;
  hotwordsCountEl.textContent = tSync(currentLang, 'hotwordsCount').replace('{n}', String(n));
}

async function refreshHotwordsStatus() {
  const r = await storage.get(HOTWORDS_KEY);
  const arr = Array.isArray(r[HOTWORDS_KEY]) ? r[HOTWORDS_KEY] : [];
  const n = arr.filter((s: unknown) => typeof s === 'string' && s.trim()).length;
  hotwordsStatus.textContent = n
    ? tSync(currentLang, 'hotwordsCount').replace('{n}', String(n))
    : tSync(currentLang, 'hotwordsStatusNone');
}

function saveHotwords() {
  storage.set({ [HOTWORDS_KEY]: parseHotwords() }).catch(() => {});
  hotwordsSaveLabel.textContent = tSync(currentLang, 'hotwordsSaved');
  setTimeout(() => { hotwordsSaveLabel.textContent = tSync(currentLang, 'hotwordsSave'); }, 1600);
  refreshHotwordsStatus();
}

function openHotwords() {
  setSubpanelBackdrop(true);
  storage.get(HOTWORDS_KEY).then(r => {
    const arr = Array.isArray(r[HOTWORDS_KEY]) ? r[HOTWORDS_KEY].filter((s: unknown) => typeof s === 'string') : [];
    hotwordsInput.value = arr.join('\n');
    updateHotwordsCount();
    hotwordsPanel.hidden = false;
    hotwordsInput.focus();
  }).catch(() => { hotwordsPanel.hidden = false; });
}

function closeHotwords() {
  saveHotwords(); // 关闭即保存：编辑内容不丢
  hotwordsPanel.hidden = true;
  setSubpanelBackdrop(false);
}

// —— 子面板遮罩（#subpanelBackdrop，仅 Web 整页显示）——
// Web 里热词等 .subpanel 是居中小卡，页面其余内容原样亮着没有焦点感，垫一层灰底压暗；
// 扩展弹窗里 .subpanel inset:0 铺满整窗、遮罩会被完全盖住，因此扩展侧恒不显示（零视觉变化）。
const subpanelBackdrop = $opt('subpanelBackdrop') as HTMLDivElement | null;
function setSubpanelBackdrop(visible: boolean) {
  if (subpanelBackdrop) subpanelBackdrop.hidden = !(visible && !IS_EXTENSION);
}

btnOpenHotwords.onclick = openHotwords;
btnHotwordsSave.onclick = saveHotwords;
btnHotwordsClose.onclick = closeHotwords;
hotwordsInput.oninput = updateHotwordsCount;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!hotwordsPanel.hidden) closeHotwords();
    // Esc 关 ASR 引导面板 = 取消本次启动（settleAsrPanel 为函数声明，模块内可前向引用）
    else if (!asrModelPanel.hidden) { asrDlAbort?.abort(); settleAsrPanel(false); }
  }
});

// —— 字幕记录导出：TXT / SRT / JSON（含译文）——
const btnExport = $('btnExport') as HTMLButtonElement;
const exportFormat = $('exportFormat') as HTMLSelectElement;

function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtClockMmm(sec: number): string {
  const r = Math.max(0, Math.floor(sec * 1000));
  const ms = r % 1000;
  return `${fmtClock(r - ms)},${String(ms).padStart(3, '0')}`;
}

function buildExport(): { name: string; content: string; mime: string } {
  const fmt = exportFormat.value;
  // 坑：译文是否导出跟随"历史字幕显示翻译"开关——用户没勾就只导出原文
  const withTr = chkTranscriptTr.checked;
  const entries = transcriptEntries.filter(e => e && e.text);
  const baseTs = entries.find(e => e.ts > 0)?.ts || 0;
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  };
  if (fmt === 'json') {
    return {
      name: `easysub-${stamp()}.json`,
      mime: 'application/json',
      content: JSON.stringify(entries.map(e => ({ ts: e.ts || 0, text: e.text, ...(withTr && e.tr ? { tr: e.tr } : {}) })), null, 2),
    };
  }
  if (fmt === 'srt') {
    // 时标按首条有效 ts 为原点偏移；legacy ts=0 条目无真实时刻，顺延上一条结束 +0.5s
    let prevEnd = 0;
    let cue = 1;
    const blocks: string[] = [];
    for (const e of entries) {
      const start = e.ts && baseTs ? (e.ts - baseTs) / 1000 : prevEnd + (prevEnd ? 0.5 : 0);
      const end = start + 2;
      prevEnd = end;
      blocks.push(`${cue}\n${fmtClockMmm(start)} --> ${fmtClockMmm(end)}\n${e.text}${withTr && e.tr ? '\n' + e.tr : ''}\n`);
      cue++;
    }
    return { name: `easysub-${stamp()}.srt`, mime: 'text/plain', content: blocks.join('\n') };
  }
  // txt
  const lines = entries.map(e => {
    const t = e.ts && baseTs ? `[${fmtClock(e.ts - baseTs)}] ` : '';
    return t + e.text + (withTr && e.tr ? '\n' + e.tr : '');
  });
  return { name: `easysub-${stamp()}.txt`, mime: 'text/plain', content: lines.join('\n\n') };
}

btnExport.onclick = () => {
  const { name, content, mime } = buildExport();
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// —— 会话计时：全面板仅此一个 interval ——
let timerId: number | undefined = undefined;
let runStartTs = 0;

function fmtDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// 坑：必须先清后启——Running/Stopped 短时间抖动会连发 setStatus，
// 不清旧 interval 会叠加出多个每秒回调，计时越走越快且停止后仍在跑
function startTimer(baseTs?: number) {
  stopTimer(false);
  // 坑：计时基准优先用 bg 下发的 startedAt（会话真实开始时刻，纳入 storage.session
  // 快照、SW 重启可恢复）——否则 popup 每次打开都从 00:00 重计，与"已进行时长"不符；
  // 无戳（旧版本 bg/异常路径）才退回本地时刻，行为与旧版一致
  runStartTs = baseTs && baseTs > 0 ? baseTs : Date.now();
  timerEl.textContent = fmtDuration(Math.floor((Date.now() - runStartTs) / 1000));
  timerId = window.setInterval(() => {
    timerEl.textContent = fmtDuration(Math.floor((Date.now() - runStartTs) / 1000));
  }, 1000);
}

function stopTimer(resetDisplay: boolean) {
  if (timerId !== undefined) { clearInterval(timerId); timerId = undefined; }
  if (resetDisplay) timerEl.textContent = '00:00';
}

function setStatus(status: string, startedAt?: number) {
  // 任何会话状态推进（Running/Stopped）都终结"模型加载中"的临时态（见 setHeroLoading）
  heroLoadingKey = null;
  statusDot.className = 'status-dot ' + status;
  btnStart.disabled = status === 'Running';
  btnStop.disabled = status === 'Stopped';
  // 记录当前会话态，供 chkOverlay 切换时判断"是否处于运行中"以给出对应反馈
  lastStatus = status;
  // Hero 卡联动：光晕描边 + 大状态词（待命→聆听中→已停止）+ 计时启停
  hero.classList.toggle('Running', status === 'Running');
  if (status === 'Running') {
    hasStarted = true;
    statusWordEl.textContent = tSync(currentLang, 'stateRunning');
    // 坑：必须把 bg 下发的 startedAt 传给计时器——写死 startTimer() 会以"收到这条
    // 消息的时刻"为基线，重开面板计时归零、跨面板不连续
    startTimer(startedAt);
    startWave();
  } else {
    // 停止即冻结并清零计时；波形停循环并画静止基线（ERROR 也走这里，同样停表）
    stopTimer(true);
    stopWaveLoop();
    levels = [];
    if (chkWaveform.checked) drawWave();
    statusWordEl.textContent = tSync(currentLang, hasStarted ? 'stateStopped' : 'stateReady');
    // 任何"会话结束"都该重新给一次配对机会（独立审查抓的 F1）：只挂面板自己的停止按钮不够——
    // Web 版从**字幕浮窗**停止（工具条/关画中画/关浮窗）走的是 host.stopSession()，面板只会收到
    // STATUS_CHANGED:Stopped，复位点就漏了。放这里覆盖全部停止路径（面板按钮、浮窗、ERROR 收敛）。
    // 注意**不能**反过来担心死循环：取消处理是先 setStatus('Stopped') 再置 helperPairSkipped=true，
    // 顺序保证 doStart 读到的仍是 true（见 helperPairCancel 的注释）。
    helperPairSkipped = false;
  }
}

// —— 模型加载中的可见反馈（用户实测反馈「点了开始毫无反应，页面还是已停止」）——
// 引擎的 STATUS_TEXT 'loadingModel' 此前只落状态栏一行小字，Hero 大状态词仍是
// 「待命/已停止」、状态灯仍是红点，模型加载的几十秒看起来就像卡死。
// 这里把加载态顶到大状态词：琥珀点 + 加载文案（Web 版附"勿切出页面"——切出后主线程
// 被浏览器节流，加载明显变慢）。任何 STATUS_CHANGED 都经 setStatus 复位回常规两态。
let heroLoadingKey: string | null = null;
function setHeroLoading(key: string | null) {
  heroLoadingKey = key;
  if (!key) return;
  // 加载 ≠ 运行：摘掉 setStatus('Running') 刚盖上的绿色描边（乐观盖章），
  // 否则边框说"运行中"、大状态词说"加载中"，视觉自相矛盾
  hero.classList.remove('Running');
  statusDot.className = 'status-dot Loading';
  statusWordEl.textContent = tSync(currentLang, key);
  log(tSync(currentLang, key));
}

function log(msg: string) {
  modelStatus.textContent = msg;
}

// —— 系统音频不支持·模态提示 ——
// 为什么要模态而不是行内小字：点「开始」后 popup 会立刻关闭，行内提示用户根本
// 来不及看（早期版本就是这么写，等于没有反馈）。模态层需要用户动手关掉，能把
// 原因和下一步顶到眼前，且不引入 notifications 权限。
// 「改用麦克风」按钮直接把音源切过去并存盘，用户读到原因的同时就能完成修正。
// 文案填充单独成函数：模态开着时用户切语言（applyLang 重跑）也要跟着刷新，
// 否则卡片停在旧语言，与周围刚变过的界面不一致。
function fillUnsupportedModalText() {
  unsupTitle.textContent = tSync(currentLang, 'notifUnsupportedTitle');
  unsupBody.textContent = tSync(currentLang, 'notifUnsupportedBody');
  unsupSwitch.textContent = tSync(currentLang, 'unsupSwitchMic');
  unsupClose.textContent = tSync(currentLang, 'unsupGotIt');
}

function showUnsupportedModal() {
  fillUnsupportedModalText();
  unsupModal.hidden = false;
  // 焦点给主操作：键盘用户 Tab 一次即可确认，不被遮罩层吞掉焦点
  unsupSwitch.focus();
}

function hideUnsupportedModal() {
  unsupModal.hidden = true;
}

unsupSwitch.onclick = () => {
  // 切到麦克风并落库：与手动改下拉完全等价（走同一条 savePrefs 串行链）
  selSource.value = 'mic';
  savePrefs({ audioSource: 'mic' });
  updateSourceHint();
  hideUnsupportedModal();
};

unsupClose.onclick = hideUnsupportedModal;

// —— 系统音频·选择器前置确认框 ——
// 为什么要有它：浏览器限制 getDisplayMedia 不能只授权音频，必须画面+音频一起勾，
// 很多用户到这一步会因为"要共享我的屏幕？"担心隐私而直接放弃。在弹选择器之前用
// 模态框把三件事讲清楚：①这是浏览器硬性限制；②画面流授权后立刻销毁（只有音频
// 被使用，见 acquireSystemAudioStream）；③选择时必须勾上"同时分享音频"。
// 时序：模态的「打开选择器」按钮本身就是用户手势，选择器从它的 click 链里弹出
// （两端各自的取流路径见 sysPickContinue 的调用方）。
function fillSysPickModalText() {
  sysPickTitle.textContent = tSync(currentLang, 'sysPickTitle');
  sysPickBody.textContent = tSync(currentLang, 'sysPickBody');
  sysPickConfirmBtn.textContent = tSync(currentLang, 'sysPickConfirm');
  sysPickCancelBtn.textContent = tSync(currentLang, 'sysPickCancel');
}

function showSysPickModal() {
  fillSysPickModalText();
  sysPickModal.hidden = false;
  sysPickConfirmBtn.focus();
}

function hideSysPickModal() {
  sysPickModal.hidden = true;
}

// 用户点「打开选择器」：收掉模态、续跑启动流程。继续的动作由调用方注册
// （扩展=重新触发 doStart 走 preAcquireAudio；Web=从本手势内预取屏幕共享流），
// 本模块不知道宿主差异。
let sysPickContinuation: (() => void) | null = null;
sysPickConfirmBtn.onclick = () => {
  hideSysPickModal();
  const go = sysPickContinuation;
  sysPickContinuation = null;
  go?.();
};
sysPickCancelBtn.onclick = () => {
  hideSysPickModal();
  sysPickContinuation = null;
  setStatus('Stopped');
};
// 点遮罩空白处 = 取消（与「不支持」模态同一交互习惯）
sysPickModal.onclick = (e) => {
  if (e.target === sysPickModal) { hideSysPickModal(); sysPickContinuation = null; setStatus('Stopped'); }
};

// 点遮罩空白处关闭（卡片内部点击不冒泡到此：见下方 stopPropagation 处理）
unsupModal.onclick = (e) => {
  if (e.target === unsupModal) hideUnsupportedModal();
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !unsupModal.hidden) hideUnsupportedModal();
  // Esc 关确认框 = 取消本次启动（与点「取消」按钮同语义）
  if (e.key === 'Escape' && !sysPickModal.hidden) {
    hideSysPickModal();
    sysPickContinuation = null;
    setStatus('Stopped');
  }
});

function updateLockUI() {
  const tr = (key: string) => tSync(currentLang, key);
  const isLocked = locked;
  lockLabel.textContent = isLocked ? tr('unlock') : tr('lock');
  btnLock.innerHTML = isLocked
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8.5 11V7a3.5 3.5 0 0 1 6.5-2"/></svg><span id="lockLabel">' + tr('unlock') + '</span>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg><span id="lockLabel">' + tr('lock') + '</span>';
}


// 音源下拉 → 音源 id。四态统一在这里读，避免各处 if/else 漏掉新音源
// （历史上就踩过：新增音源后某处回退逻辑把它静默降级成了 tab）。
type AudioSourceId = 'tab' | 'system' | 'mic' | 'helper';
function readSelectedSource(): AudioSourceId {
  const v = selSource.value;
  if (v === 'mic') return 'mic';
  if (v === 'system') return 'system';
  if (v === 'helper') return 'helper';
  return HAS_TAB_SOURCE ? 'tab' : DEFAULT_AUDIO_SOURCE;
}

selSource.onchange = () => {
  // 三态原样落库（含不支持平台上的 system）：不静默改写用户的显式选择，
  // 不支持一事由 updateSourceHint 在选中后当面告知。
  const v: AudioSourceId = readSelectedSource();
  // 换了音源就作废"已确认过系统音频说明"：否则用户确认后切走再切回来，
  // 会被当成已确认而直接弹选择器（少了一道说明，也违背"每次重新开始都讲一遍"）。
  pickConfirmPassed = false;
  // 用户主动换过音源：把"这次先不配对"的记忆清掉——下次再选回助手时该重新问一次
  helperPairSkipped = false;
  savePrefs({ audioSource: v });
  // 用户主动选了「桌面助手」：这时候值得全端口扫一遍（助手可能不在默认端口上）
  if (v === 'helper') void detectHelper(true);
  updateSourceHint();
};

// 启动流程本体。抽成函数是为了两处复用：
//   ① 「开始」按钮；
//   ② 模型刚装好后的续跑（扩展自动续跑；Web 版由引导卡上的主按钮调用，那次点击
//      才是浏览器认可的新鲜手势，见 manualRestartAfterModel 的注释）。
//
// —— 系统音频·选择器前置确认：必须排在**任何取流动作之前** ——
// 坑（实测"选择器弹两次、选好的流被打断"的根因）：确认框原先挂在 prepareStart
// **之后**，而 Web 版正是 prepareStart 在用户手势内直接调 getDisplayMedia。于是实际
// 顺序成了：点开始 → 真选择器弹出（用户选好、preStream 到手）→ 走到确认框分支 →
// releasePreStream() 把刚选好的流停掉 → 弹确认框 → 点「打开选择器」→ 又弹一次选择器。
// 现在把确认框提到最前面：弹模态不需要用户手势，用户点「打开选择器」的那一刻才是
// 真正进入启动流程的手势，选择器全程只弹一次。
//
// 标志语义：一旦为 true，后续 doStart 不再重复弹说明，直接进入取流链路。
// 置 true 的唯一来源是确认框的「打开选择器」；在"用户取消/本次启动已受理"两处清掉。
// 中途的 modelPending 早退**刻意保留**它：用户已确认过，下完模型点引导卡上的
// 「开始识别」应当直接弹屏幕选择器，而不是再被问一遍。
let pickConfirmPassed = false;
async function doStart(): Promise<void> {
  const pendingSource: AudioSourceId = readSelectedSource();
  // 桌面助手音源：**没启动/没配对/暂停都不拦启动**（空音频=静音帧，识别照常）。
  // 只有「探测到了但未配对」才弹配对模态（配对码换来的设备令牌是助手认这个页面的唯一凭据；
  // 没有令牌，助手的 /ws 反正会拒，不如先问清楚）。用户提交成功后由 continuation 重走 doStart。
  // 位置刻意排在"系统音频·选择器说明"之前：两者互不相干，别让用户先读一遍无关说明。
  if (pendingSource === 'helper') {
    // **无条件重探一次**：助手的状态在面板打开之后可能已经变了（用户刚去窗口点了「启动」或
    // 「暂停」）。用缓存的 helperInfo 判断会形成死循环 —— 提示"请在助手窗口点启动"，用户去点了、
    // 回来再点「开始」，仍然读到旧的 paused=true。Web 版页面常驻，必然复现。
    await detectHelper(true);
    // 产品决定（2026-10-05）：**不再要求助手已启动/已配对才能点开始**。
    // 助手没启动 → 这条音源就是空音频（静音帧），识别照常进行，用户看到的只是"没字"。
    // 助手在跑（**含暂停**）但没配对 → 弹配对框：没有令牌，助手的 /ws 反正会拒，不如先问清楚。
    // 坑：这里**不能**加 `&& !helperInfo.paused`（独立审查抓的 major）——助手窗口的总开关
    // **默认就是暂停**，加了这一条等于"新用户装好助手、点开始"这条主路径永远拿不到配对入口：
    // 页面既没连上 WS（用户在助手窗口点「启动」也不会出声，协议只在已连时广播），
    // 又会一直静音，用户完全没有下一步。配对接口本身不检查暂停（server.handle_pair 只看
    // Origin + 配对码），所以暂停时弹框、提交都能正常工作。
    if (!helperSession && helperInfo && !helperPairSkipped) {
      // 检测到了但未配对：弹配对框；配对成功后由 continuation 重走 doStart
      helperContinuation = () => { void doStart(); };
      showHelperPairModal();
      setStatus('Stopped');
      return;
    }
  }
  // 系统音频：先把"浏览器不能单独授权音频、画面流授权后立刻销毁、记得勾上分享音频"
  // 三件事讲清楚，用户点确认后才进入下面的取流链路。
  // 平台不支持系统音频时不弹它——那种情况由下方 SYSTEM_AUDIO_SUPPORTED 门卫弹
  // "无法使用系统音频"，先弹确认框只会让用户白读一遍。
  if (pendingSource === 'system' && SYSTEM_AUDIO_SUPPORTED && !pickConfirmPassed) {
    sysPickContinuation = () => { pickConfirmPassed = true; void doStart(); };
    showSysPickModal();
    return;
  }
  // 加载反馈**从这里就亮起**，早于任何加载/探测动作（用户实测「卡住直到启动、没有任何提示」）。
  // 原因：点「开始」到引擎发 STATUS_TEXT('loadingModel') 之间隔着一段完全静默的窗口——
  // Web 版 prepareStart 里先 HEAD 探测包内模型 + 查 IndexedDB，然后才弹屏幕选择器
  // （弱网下光探测就要数秒）；扩展侧 START 之后还要建 offscreen 文档、等端口握手。
  // 这一整段此前 Hero 停在「已停止/识别中」纹丝不动。引擎稍后的 STATUS_TEXT 只是再确认；
  // 下方每条早退路径都必须经 setStatus('Stopped') 把它清掉（现状已满足，见各路径）。
  setHeroLoading(!IS_EXTENSION ? 'loadingModelWeb' : 'loadingModel');
  // 坑（纯 Web 版）：宿主前置动作必须在**本函数最前面**、任何 await 之前发起。
  // getDisplayMedia / window.open 都要求瞬时用户激活，而下面的 ensureAsrModel()
  // 至少要跨一个 fetch，等它返回时手势早已失效，浏览器会直接拒绝采集。
  let hostExtras: Record<string, any> | void;
  try {
    hostExtras = await hostHooks()?.prepareStart?.(pendingSource);
  } catch (e: any) {
    // 用户在选择器里点了取消：按取消处理，不进识别流程，也不报错
    const cancelled = e?.name === 'NotAllowedError' || e?.name === 'AbortError';
    if (!cancelled) log(`${tSync(currentLang, 'errorPrefix')}`.replace('{m}', String(e?.message || e)));
    setStatus('Stopped');
    // 用户取消了本次启动：清掉确认态，下次点「开始」重新走一遍说明
    pickConfirmPassed = false;
    // 宿主在 prepareStart 里可能已经预开了字幕浮窗：本次启动已夭折，必须让它收回去，
    // 否则屏幕上留着一个空浮窗（用户以为已经在识别了，其实什么都没跑）。
    hostHooks()?.startAborted?.();
    return;
  }
  // 坑：宿主预取的屏幕共享流（hostExtras.preStream）一旦到手就必须有人负责回收。
  // 下面每一条早退路径都得先把它停掉，否则"用户共享了屏幕 → 又取消了模型引导"
  // 会在屏幕上留下一个永不关闭的共享（录制指示灯常亮，用户只能手动点停止共享）。
  // 同一处收口也回收宿主预开/预置的其它副作用（Web 的字幕浮窗），早退路径一律调用它。
  const releasePreStream = () => {
    const s = (hostExtras as any)?.preStream as MediaStream | undefined;
    if (s) s.getTracks().forEach((t) => t.stop());
    hostHooks()?.startAborted?.();
  };
  // 跨源隔离门卫（纯 Web 版）：sherpa 的 wasm 是 pthreads 构建，需要 SharedArrayBuffer，
  // 而 SAB 只在 crossOriginIsolated 下可用。没隔离就点开始，只会得到一句
  // DataCloneError，用户完全无从排查——这里提前拦下并说明补隔离的两条路。
  // 扩展侧恒 false，不受影响（chrome-extension:// 页面豁免该限制）。
  if (preloadNeedIsolation() && !window.crossOriginIsolated) {
    releasePreStream();
    // 本次启动中止：清掉确认态，下次点「开始」重新走一遍说明
    pickConfirmPassed = false;
    setStatus('Stopped');
    log(tSync(currentLang, 'webNoIsolation'));
    return;
  }
  // 宿主明说"显示端开不出来"（纯 Web 版被浏览器的弹窗拦截挡住）：这时起来也是无声会话，
  // 宿主已在说明区写清原因，本次启动就此收尾。要排在模型引导之前——否则用户先被引导去
  // 下载 412MB 模型，下完才发现显示端依然开不出来。
  if ((hostExtras as any)?.displayUnavailable) {
    releasePreStream();
    pickConfirmPassed = false;
    setStatus('Stopped');
    return;
  }
  // nomodel 版门卫：包内无 .data 且未导入过 → 弹窗中窗引导，导入成功自动继续本次启动。
  // 走到 false（用户关掉引导卡）说明本次启动夭折：清掉 doStart 开头亮起的加载态
  if (!(await ensureAsrModel())) { releasePreStream(); pickConfirmPassed = false; setStatus('Stopped'); return; }
  // 坑：宿主明确告知"这次手势已被模型流程吃掉"（纯 Web 版首次安装模型时必然如此：
  // 下载 412MB 耗时以分钟计，用户激活早已过期，此时再去 getDisplayMedia 必被拒绝）。
  // 不装模作样地继续启动，而是走"装好后请用户再点一次"的显式流程：
  // Web 侧会在引导卡上亮出「开始识别」主按钮（那一次点击才是新鲜激活）。
  if ((hostExtras as any)?.modelPending) {
    releasePreStream();
    setStatus('Stopped');
    // 模型引导卡已经在屏幕上，用户看得到下一步做什么，这里不必再写一行会被冲掉的日志
    return;
  }
  const source: AudioSourceId = readSelectedSource();
  // 坑：不支持平台选了 system 时【必须明确拦下并说明】，不能静默降级成 tab——
  // 降级会让用户以为系统音频能用、只是没声音，排查方向完全错。
  if (source === 'system' && !SYSTEM_AUDIO_SUPPORTED) {
    releasePreStream();
    setStatus('Stopped');
    log(tSync(currentLang, 'sysAudioUnsupported'));
    updateSourceHint();
    // 行内提示会随 popup 关闭一起消失，模态层才是用户真正看得见的那一次反馈
    showUnsupportedModal();
    return;
  }
  // 系统音频·选择器前置确认框已在 doStart 最前面处理完（见那里的注释），
  // 走到这里说明用户已确认过，可以直接进入取流/启动。
  // 本次启动已正式受理：清掉确认态，下次点「开始」重新走一遍说明。
  pickConfirmPassed = false;
  // 系统音频/麦克风模式不依赖活动标签页（captureTabId 恒 null，字幕走悬浮窗），跳过 noActiveTab 检查
  if (source !== 'tab') {
    // 麦克风授权与采集都发生在悬浮字幕窗（可见页面）：popup 不再碰 getUserMedia——
    // offscreen 文档禁采麦克风、popup 内气泡又不可靠（挂死/被抑制），只有真窗口能弹框。
    // 不传 deviceId：由 Chrome 授权弹窗让用户选设备，浏览器记住所选，后续自动沿用。
    sendToHost({
      type: 'START_RECOGNITION',
      source,
      lang: currentLang, // 会话语言：宿主用它取 i18n 错误文案（扩展侧由 bg 再读 storage）
      overlayVisible: chkOverlay.checked,
      // 桌面助手：把探测/配对得到的 {port, token} 交给宿主
      // （扩展：popup→bg→offscreen 转交；Web：宿主自己也读 storage，这里带上只是同一条协议）
      ...(source === 'helper' && helperSession
        ? { helperPort: helperSession.port, helperToken: helperSession.token }
        : {}),
      ...(hostExtras || {}),
    }).catch(() => {});
    setStatus('Running');
    // 坑（用户实测「加载提示卡住显示不出来」）：模型加载真正开始于宿主侧——扩展是
    // offscreen 文档一建就预热，Web 是引擎收到 START 就开等 wasm；而引擎的
    // STATUS_TEXT('loadingModel') 要等 INIT 穿过"建文档/端口握手"才发得出来，那段窗口里
    // Hero 停在乐观盖章的「识别中」。加载态必须在发送 START 的此刻就地亮出（必须排在
    // setStatus('Running') 之后——setStatus 会清掉加载态），引擎稍后的同名 STATUS_TEXT 只是再确认。
    setHeroLoading(!IS_EXTENSION ? 'loadingModelWeb' : 'loadingModel');
    return;
  }
  const tabId = await getActiveTabId();
  // 没有活动标签页 = 本次启动夭折：清掉 doStart 开头亮起的加载态
  if (!tabId) { releasePreStream(); setStatus('Stopped'); log(tSync(currentLang, 'noActiveTab')); return; }

  sendToHost({
    type: 'START_RECOGNITION',
    tabId,
    source,
    lang: currentLang,
    overlayVisible: chkOverlay.checked,
    ...(hostExtras || {}),
  }).catch(() => {});
  setStatus('Running');
  // 同上：tab 音源的加载态也在发送 START 的此刻亮出，不等引擎的 STATUS_TEXT
  setHeroLoading(!IS_EXTENSION ? 'loadingModelWeb' : 'loadingModel');
}

export function triggerStart(): void { void doStart(); }
btnStart.onclick = () => { void doStart(); };

// 兼容性检测·手动入口（Hero 顶栏盾牌按钮）：随时重开检测弹窗，不受"已读"记忆限制。
// 每次点击都重跑一轮完整检测，给用户当前环境的最新结果。
$('btnCompat').onclick = () => { void openCompatCheck(); };

btnStop.onclick = () => {
  sendToHost({ type: 'STOP_RECOGNITION' }).catch(() => {});
  setStatus('Stopped');       // 复位 helperPairSkipped 就在 setStatus 里（覆盖浮窗停止等全部路径）
};

// —— ASR 模型缺失引导（nomodel 版安装包）——
// 检测顺序：HEAD 探测包内 .data（full/lite/开发版恒存在）→ IndexedDB 已导入（上传一次
// 后永不再问）→ 都没有才弹窗中窗。Promise 在「导入成功(true)」或「手动关闭(false)」时落定。
const ASR_MODEL_URL = 'https://modelscope.cn/models/hcz1017/easysub-model/resolve/master/sherpa-onnx-wasm-main-asr.data';
const asrModelPanel = $('asrModelPanel') as HTMLDivElement;
const asrModelStatus = $('asrModelStatus');
const btnAsrModelImport = $('btnAsrModelImport') as HTMLButtonElement;
const asrModelPicker = $('asrModelPicker') as HTMLInputElement;
const btnReselectModel = $('btnReselectModel') as HTMLButtonElement;
const btnAsrModelDownload = $('btnAsrModelDownload') as HTMLButtonElement;
const asrProgressWrap = $('asrProgressWrap') as HTMLDivElement;
const asrProgressFill = $('asrProgressFill') as HTMLDivElement;
const asrProgressText = $('asrProgressText');
const asrAltToggle = $('asrAltToggle') as HTMLButtonElement;
const asrAltLinks = $('asrAltLinks') as HTMLDivElement;
let asrPanelResolve: ((ok: boolean) => void) | null = null;
// 与 asrPanelResolve 配套：并发的 ensureAsrModel 复用同一个等待中的 Promise（见那里注释）
let asrPanelPending: Promise<boolean> | null = null;
let asrDlAbort: AbortController | null = null;

function refreshAsrPanelLang() {
  // 打开前按当前语言刷新文案（直链 href 在 HTML 写死，文案走 i18n）
  $('asrModelTitle').textContent = tSync(currentLang, 'asrModelTitle');
  $('asrModelHint').textContent = tSync(currentLang, 'asrModelHint');
  $('asrModelLinkGithub').textContent = tSync(currentLang, 'asrModelGithub');
  $('asrModelLinkGitee').textContent = tSync(currentLang, 'asrModelGitee');
  $('asrModelLinkModelScope').textContent = tSync(currentLang, 'asrModelModelScope');
  $('asrModelImportLabel').textContent = tSync(currentLang, 'asrModelImportBtn');
  $('asrAltToggle').textContent =
    (asrAltLinks.classList.contains('open') ? '▲ ' : '▼ ') + tSync(currentLang, 'asrModelAltToggle');
  if (!btnAsrModelDownload.disabled) {
    $('asrModelDownloadLabel').textContent = tSync(currentLang, 'asrModelDownloadBtn');
  }
  const readyRow = $opt('asrReadyRow');
  if (readyRow) {
    $opt('asrReadyHint')!.textContent = tSync(currentLang, 'asrModelReadyHint');
    $opt('asrModelStartNowLabel')!.textContent = tSync(currentLang, 'asrModelStartNow');
  }
}

// 遮罩的显隐只跟着引导卡的可见性走。扩展侧没有 #asrBackdrop（模板里是 Web 也不载入？
// 不——它在共享 ui-body 里，扩展也有该节点），所以这里按 modelGuideStyle 判定，
// 扩展恒为 panel 风格，遮罩永不显示。
function setAsrBackdrop(visible: boolean) {
  const bd = $opt('asrBackdrop');
  if (!bd) return;
  bd.hidden = !(visible && hostHooks()?.modelGuideStyle === 'modal');
}

// 模型就绪态的卡片内容：隐藏下载/导入区，露出"再点一次开始"的主按钮。
// 只有声明了 manualRestartAfterModel 的宿主（Web）需要这一步；扩展走 settleAsrPanel(true)
// 直接关面板并自动续跑，看不到这个状态。
// reload=true 是另一种结局：刚导入的模型本页换不掉（wasm 运行时已把旧的读进文件系统），
// 此时**不能**给「开始识别」按钮——点了只会静默用旧模型跑，比不给按钮更糟。
function showAsrReadyState(reload = false) {
  const readyRow = $opt('asrReadyRow');
  if (!readyRow) return;
  asrReloadPending = reload;
  // 就绪提示要跟音源走：系统音频那句说的是"在屏幕选择器里勾选分享音频"，麦克风用户
  // 看到的就是完全无关的指引。按用户当时选的音源给对应的下一步。
  const readyKey = selSource.value === 'mic' ? 'asrModelReadyHintMic' : 'asrModelReadyHint';
  $opt('asrReadyHint')!.textContent = tSync(currentLang, reload ? 'asrModelReloadHint' : readyKey);
  $opt('asrModelStartNowLabel')!.textContent = tSync(currentLang, reload ? 'asrModelReloadBtn' : 'asrModelStartNow');
  $('asrModelTitle').textContent = tSync(currentLang, reload ? 'asrModelReloadTitle' : 'asrModelReadyTitle');
  // 坑：缺模型态的 hint（"当前安装包未内置模型，点击下方按钮下载…"）在就绪态下
  // 与标题自相矛盾——用户会以为下载没成功。就绪态只保留 readyRow 里的说明。
  $('asrModelHint').hidden = true;
  btnAsrModelDownload.hidden = true;
  asrProgressWrap.hidden = true;
  ($('asrDlWarn') as HTMLElement).hidden = true;
  asrAltToggle.hidden = true;
  asrAltLinks.classList.remove('open');
  asrAltLinks.hidden = true;
  asrModelStatus.textContent = '';
  readyRow.hidden = false;
}

function openAsrModelPanel() {
  refreshAsrPanelLang();
  asrModelStatus.textContent = '';
  resetAsrDownloadUi();
  // 复位"就绪态"的隐藏项：重新选择模型时下载/导入区必须回来（上次走到 ready 态时被藏了）
  asrReloadPending = false;
  const readyRow = $opt('asrReadyRow');
  if (readyRow) readyRow.hidden = true;
  const startNow = $opt('btnAsrModelStartNow') as HTMLElement | null;
  if (startNow) startNow.hidden = false;
  $('asrModelHint').hidden = false;
  btnAsrModelDownload.hidden = false;
  asrAltToggle.hidden = false;
  asrAltLinks.hidden = false;
  // 呈现方式由宿主定：扩展=面板内浮层（窗口太小，浮层已足够），Web=带遮罩的模态大卡。
  // 只切一个 class，DOM 与逻辑两端完全共用。
  const modal = hostHooks()?.modelGuideStyle === 'modal';
  asrModelPanel.classList.toggle('guide-modal', modal);
  asrModelPanel.hidden = false;
  setAsrBackdrop(true);
}

function resetAsrDownloadUi() {
  btnAsrModelDownload.disabled = false;
  $('asrModelDownloadLabel').textContent = tSync(currentLang, 'asrModelDownloadBtn');
  asrProgressWrap.hidden = true;
  asrProgressFill.style.width = '0%';
  asrProgressText.textContent = '';
  ($('asrDlWarn') as HTMLElement).hidden = true;
}

// 只探测不弹窗：宿主在"取音频前"要先知道模型在不在（见 web/panel.ts 的 prepareStart）。
// 放在 ensureAsrModel 之前是为了让两条路径共用同一套判定，避免"探测说有一处、
// 引导说没有"这种自相矛盾。
// 判定与引擎的注入门卫同口径（`'absent'` 才算缺）。扩展侧该探测恒为 present/absent
// （等价于 master 的 `res.ok`），不会因探测异常把包内自带模型的 full/lite 版判成缺模型；
// Web 托管侧才可能出现 unknown，那按"有"处理（宁可让它去报真实错误，也比把能跑的包锁死强）。
export async function isAsrModelReady(): Promise<boolean> {
  if ((await probeBundledResource(ASR_DATA_PATH)) !== 'absent') return true;
  try {
    const blob = await getModelFile(ASR_DB_KEY);
    return !!(blob && blob.size > 0);
  } catch { return false; } // 库损坏视为未导入
}

async function ensureAsrModel(): Promise<boolean> {
  if (await isAsrModelReady()) return true;
  // 坑：并发的两次 doStart（用户连点「开始」）会先后走到这里，若各自 new 一个 Promise
  // 覆盖 asrPanelResolve，先来的那个 await 永远不落定——它的 prepareStart 已经预取了
  // 屏幕共享流，于是那次的流永远没人回收（共享指示灯常亮）。复用同一个 pending Promise。
  // 卡片也只在首次打开：重复 openAsrModelPanel 会把下载 UI 复位（清进度、重新启用按钮），
  // 用户在下载途中再点一次「开始」就会把正在跑的下载界面清掉。
  if (!asrPanelPending) {
    openAsrModelPanel();
    asrPanelPending = new Promise<boolean>(resolve => { asrPanelResolve = resolve; });
  }
  return asrPanelPending;
}

function settleAsrPanel(ok: boolean) {
  // 纯 Web 版的"就绪态"：模型已装好，但**不能自动续跑**——首次下载 412MB 耗以分钟计，
  // 点「开始」时那次手势早已过期，此时再去 getDisplayMedia 必被浏览器拒绝，用户看到的
  // 就是"下好了却卡住、必须重来一次"。改成把"再点一次"做成卡片上的主按钮：
  // 用户点它的那一刻才是有效手势，采集与开窗都能正常完成。
  if (ok && hostHooks()?.manualRestartAfterModel) {
    btnReselectModel.hidden = false;
    // 本次导入的模型本页换不掉（wasm 运行时已定型）→ 明说需要刷新，且不给开始按钮
    showAsrReadyState(!!hostHooks()?.modelNeedsReload?.());
    // 让被拦下的那次 doStart 就此收尾（它已把预取的流回收掉），不要再自动启动。
    if (asrPanelResolve) { asrPanelResolve(false); asrPanelResolve = null; }
    asrPanelPending = null;
    return;
  }
  asrModelPanel.hidden = true;
  setAsrBackdrop(false);
  if (ok) btnReselectModel.hidden = false; // 导入成功 → 显示重新选择按钮
  if (asrPanelResolve) { asrPanelResolve(ok); asrPanelResolve = null; }
  asrPanelPending = null;
}

// 就绪态里的主按钮：正常情况下是「开始识别」（那一次点击才是浏览器认可的新鲜手势）；
// 需要刷新页面时（本页换不掉刚导入的识别模型）同一位置变成「刷新页面」——
// 与其不给按钮、让用户自己找刷新，不如把这个动作直接放在他正在看的地方。
$opt('btnAsrModelStartNow')?.addEventListener('click', () => {
  if (asrReloadPending) { location.reload(); return; }
  asrModelPanel.hidden = true;
  setAsrBackdrop(false);
  const readyRow = $opt('asrReadyRow');
  if (readyRow) readyRow.hidden = true;
  triggerStart();
});
$('btnAsrModelClose').onclick = () => { asrDlAbort?.abort(); settleAsrPanel(false); };

// —— 一键下载：popup 直连 ModelScope 流式下载 → IndexedDB ——
// host_permissions 已含 <all_urls>，不新增权限；扩展页 fetch 不受目标站 CORS 限制。
asrAltToggle.onclick = () => {
  const open = asrAltLinks.classList.toggle('open');
  asrAltToggle.textContent = (open ? '▲ ' : '▼ ') + tSync(currentLang, 'asrModelAltToggle');
};

function fmtMB(bytes: number) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

btnAsrModelDownload.onclick = async () => {
  btnAsrModelDownload.disabled = true;
  $('asrModelDownloadLabel').textContent = tSync(currentLang, 'asrModelDownloading');
  asrProgressWrap.hidden = false;
  asrProgressFill.style.width = '0%';
  // 下载全程跑在 popup 里：窗口一关 fetch 即断且无断点续传，先亮出保窗提醒
  $('asrDlWarn').textContent = tSync(currentLang, 'asrModelDlKeepOpen');
  ($('asrDlWarn') as HTMLElement).hidden = false;
  asrModelStatus.textContent = '';
  asrDlAbort = new AbortController();
  try {
    const res = await fetch(ASR_MODEL_URL, { signal: asrDlAbort.signal });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('Content-Length')) || 0;
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      // 进度：有 Content-Length 走百分比，没有退化为已下载 MB 数
      if (total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        asrProgressFill.style.width = pct + '%';
        asrProgressText.textContent = pct + '% · ' + fmtMB(received) + ' / ' + fmtMB(total);
      } else {
        asrProgressFill.style.width = '50%';
        asrProgressText.textContent = fmtMB(received);
      }
    }
    // 坑：完整性校验必须在落库前做。旧实现只看 res.ok——截断的响应（中途断连）或
    // 代理错误页会被存成几百 MB 垃圾条目，之后每次启动在 offscreen 撞 30s 超时，
    // 且坏条目不会自愈（导入路径的 100MB 下限校验这里原本是缺的）。
    if (total > 0 && received < total) {
      throw new Error(`下载不完整 ${fmtMB(received)} / ${fmtMB(total)}`);
    }
    if (received < 100 * 1024 * 1024) {
      throw new Error(`文件过小（${fmtMB(received)}），不是有效的模型文件`);
    }
    asrModelStatus.textContent = tSync(currentLang, 'asrModelDownloadDone');
    // 直接存 Blob（IndexedDB 原生支持），避免再拷贝一份 412MB
    await saveModelBlob(ASR_DB_KEY, new Blob(chunks));
    asrModelStatus.textContent = tSync(currentLang, 'asrModelImported');
    hostHooks()?.onModelReady?.();
    settleAsrPanel(true); // 自动继续被拦下的启动
  } catch (e: any) {
    if (e?.name === 'AbortError') return; // 关闭面板触发的取消：静默复位即可
    asrProgressWrap.hidden = true;
    asrModelStatus.textContent = tSync(currentLang, 'asrModelDownloadErr');
  } finally {
    asrDlAbort = null;
    if (!asrModelPanel.hidden) resetAsrDownloadUi();
  }
};

btnAsrModelImport.onclick = () => asrModelPicker.click();

asrModelPicker.onchange = async () => {
  const f = asrModelPicker.files?.[0];
  asrModelPicker.value = '';
  if (!f) return;
  // 宽松校验：emscripten 加载器按 .data 提取文件系统映像，只能接受同格式单文件
  if (!f.name.endsWith('.data') || f.size < 100 * 1024 * 1024) {
    asrModelStatus.textContent = tSync(currentLang, 'asrModelError');
    return;
  }
  asrModelStatus.textContent = tSync(currentLang, 'asrModelImporting');
  try {
    // 直接存 File（IndexedDB 原生支持 Blob），避免 412MB arrayBuffer 拷贝
    await saveModelBlob(ASR_DB_KEY, f);
    asrModelStatus.textContent = tSync(currentLang, 'asrModelImported');
    hostHooks()?.onModelReady?.();
    settleAsrPanel(true); // 导入成功：关面板并自动继续被拦下的启动
  } catch (e: any) {
    log(tSync(currentLang, 'errorPrefix').replace('{m}', String(e?.message || e)));
  }
};

chkOverlay.onchange = () => {
  const visible = chkOverlay.checked;
  // 坑：无论会话是否运行都要持久化——此前只在 bg 有 captureTabId 时才转发生效，
  // 未启动会话时切换是静默无效的，且重开 popup 后勾选态丢失。
  // 写入 tmspeech_prefs.overlayVisible 后，下次 START 时随 msg.overlayVisible 生效。
  savePrefs({ overlayVisible: visible });
  sendToHost({ type: 'OVERLAY_TOGGLE', visible }).catch(() => {});
  // 可见反馈：运行中切换由 OVERLAY_TOGGLE 链路即时生效，无需提示；
  // 未启动会话时明确告知"已保存、下次开始识别时生效"，不再静默。
  if (lastStatus !== 'Running') {
    log(tSync(currentLang, 'overlaySavedOffline'));
  }
};

chkPunct.onchange = () => {
  const val = chkPunct.checked;
  storage.set({ tmspeech_use_punct: val });
  sendToHost({ type: 'SET_PUNCT', enabled: val }).catch(() => {});
};

btnResetOverlay.onclick = () => {
  sendToHost({ type: 'RESET_OVERLAY_POSITION' }).catch(() => {});
};

btnLock.onclick = () => {
  locked = !locked;
  sendToHost({ type: 'LOCK_TOGGLE', locked }).catch(() => {});
  updateLockUI();
};

btnLang.onclick = async () => {
  const newLang = currentLang === 'zh_CN' ? 'en' : 'zh_CN';
  await setLang(newLang);
  await applyLang();
};

async function loadTranscript() {
  const r = await storage.get(TRANSCRIPT_KEY);
  // 坑：legacy 纯字符串与新版 {text,ts} 可能混存，读取必须懒归一化（同 bg 逻辑），
  // 否则老用户升级后首次打开 popup 就在渲染层炸 undefined
  transcriptEntries = ((r[TRANSCRIPT_KEY] as unknown[]) || []).map(e => {
    if (typeof e === 'string') return { text: e, ts: 0 };
    const o = e as any;
    return {
      text: String(o?.text ?? ''),
      ts: Number(o?.ts) || 0,
      tr: typeof o?.tr === 'string' && o.tr ? o.tr : undefined,
      seq: Number(o?.seq) > 0 ? Number(o.seq) : undefined,
    };
  });
  // 坑：从存储装载的都是**历史会话**的条目，它们带的 seq 对新会话毫无意义（seq 是会话内
  // 从 1 起的句号，两场会话必然撞号）。装载时一律抹掉，让"按 seq 精确配对"只在本场条目里
  // 生效——否则本场第一句的译文可能挂到上一场同号的句子上。
  // maxSeqSeen 保持 0（不是回填历史最大值）：回填的话，本场前几句会满足 seq <= maxSeqSeen
  // 而被误判成"会话重启回绕"，把本场条目的 seq 一起抹掉，反而造成译文错位。
  transcriptEntries.forEach(e => { delete e.seq; });
  renderTranscript();
}

function saveTranscript() {
  storage.set({ [TRANSCRIPT_KEY]: transcriptEntries });
}

function renderTranscript() {
  if (transcriptEntries.length === 0) {
    // 空态：内联 SVG 图标 + 主句 + 双语提示语，垂直居中（样式见 .transcript-empty）
    transcriptBox.innerHTML = `<div class="transcript-empty" id="transcriptEmpty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>${tSync(currentLang, 'transcriptEmpty')}</span>
      <small>${tSync(currentLang, 'transcriptHint')}</small></div>`;
    return;
  }
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    // 无搜索词：原样全量渲染（清空搜索框后 DOM 完全复原走这里）
    transcriptBox.innerHTML = transcriptEntries.map(t =>
      `<div class="transcript-entry">${renderEntryHtml(t)}</div>`
    ).join('');
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
    return;
  }
  // 搜索态：纯内存过滤（数组 ≤1000 条），input 直接重渲，无防抖/无新常驻开销
  const hits = transcriptEntries.filter(t => t.text.toLowerCase().includes(q));
  if (hits.length === 0) {
    transcriptBox.innerHTML = `<div class="transcript-empty">${tSync(currentLang, 'searchNoMatch')}</div>`;
    return;
  }
  transcriptBox.innerHTML = hits.map(t =>
    `<div class="transcript-entry">${renderEntryHtml(t, q)}</div>`
  ).join('');
}

// 单条渲染：时间戳（相对本会话第一条带时标条目的 [mm:ss] 偏移）+ 正文 +（开关开启时的）译文
function renderEntryHtml(entry: TranscriptEntry, q?: string): string {
  // 坑：origin 曾取 transcriptEntries[0].ts——升级用户的存储里首条往往是 legacy(ts=0)，
  // 会把整个列表的时间戳全部误伤抑制。改为取首条 ts>0 的条目做会话零点；
  // 自身 ts=0（legacy/转发缺戳兜底）的条目仍单独不显示时标
  const origin = transcriptEntries.find(t => t.ts > 0)?.ts || 0;
  let html = '';
  if (chkShowTs.checked && entry.ts > 0 && origin > 0) {
    const sec = Math.max(0, Math.round((entry.ts - origin) / 1000));
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    html += `<span class="entry-ts">[${mm}:${ss}]</span> `;
  }
  html += (q ? highlightEntry(entry.text, q) : escapeHtml(entry.text));
  // 译文：独立一行小字（蓝灰），由历史设置开关控制显隐
  if (chkTranscriptTr.checked && entry.tr) {
    html += `<div class="entry-tr">${escapeHtml(entry.tr)}</div>`;
  }
  return html;
}

// 坑：高亮必须"按原文切分、逐段转义后再拼 <mark>"——若先整体 escapeHtml 再替换
// 原始查询词，查询含 &/</> 时会与已转义实体错位，产生错误高亮甚至注入点
function highlightEntry(text: string, q: string): string {
  const lower = text.toLowerCase();
  // 坑：某些字符（İ 等）转小写后长度会变，lower 的下标与原文不再一一对应，
  // 按它切分会切错位置甚至拆开代理对。长度不一致就放弃高亮，只做转义（显示正确优先）。
  if (lower.length !== text.length) return escapeHtml(text);
  let out = '';
  let last = 0;
  while (true) {
    const i = lower.indexOf(q, last);
    if (i < 0) break;
    out += escapeHtml(text.slice(last, i)) + '<mark>' + escapeHtml(text.slice(i, i + q.length)) + '</mark>';
    last = i + q.length;
  }
  return out + escapeHtml(text.slice(last));
}

// —— 搜索框交互：仅 input 事件触发重渲；命中计数只在有搜索词时显示 ——
searchInput.oninput = () => {
  btnSearchClear.style.display = searchInput.value ? 'flex' : 'none';
  renderTranscript();
  const q = searchInput.value.trim().toLowerCase();
  if (!q) { searchCount.textContent = ''; return; }
  const n = transcriptEntries.filter(t => t.text.toLowerCase().includes(q)).length;
  searchCount.textContent = tSync(currentLang, 'searchHits').replace('{n}', String(n));
};

btnSearchClear.onclick = () => {
  searchInput.value = '';
  searchCount.textContent = '';
  btnSearchClear.style.display = 'none';
  renderTranscript();
  searchInput.focus();
};

btnCopy.onclick = async () => {
  // 复制只拼纯文本，不带时间戳（时标仅用于屏上回看）；
  // 勾选"历史字幕显示翻译"时顺带把译文跟在其原句后一行
  const lines = transcriptEntries.map(t => chkTranscriptTr.checked && t.tr ? `${t.text}\n${t.tr}` : t.text);
  const text = lines.join('\n');
  if (!text) return;
  const label = $('copyLabel');
  const orig = label.textContent!;
  try {
    await navigator.clipboard.writeText(text);
    label.textContent = tSync(currentLang, 'copied');
  } catch {
    // 剪贴板不可用（非安全上下文/权限被拒）：按钮文字不动即"没复制成"，不弹错
  }
  setTimeout(() => { label.textContent = orig; }, 1200);
};

btnClear.onclick = () => {
  transcriptEntries = [];
  // 走 transcript-store 的串行队列：直接 storage.remove 会与 bg/宿主正在排队的
  // appendTranscript（get→push→set）交错——remove 落在读之后写之前，那一句就被写回来了，
  // 表现为"清空后凭空冒出一句"。入队消除这个竞态。
  clearTranscript();
  // 清空记录时一并复位搜索框——否则残留的搜索词让空态显示成"没有匹配的字幕"，误导用户
  searchInput.value = '';
  searchCount.textContent = '';
  btnSearchClear.style.display = 'none';
  renderTranscript();
};

function sendEndpoint() {
  const r1 = parseInt(endpointRule1.value) / 10;
  const r2 = parseInt(endpointRule2.value) / 10;
  const r3 = parseInt(endpointRule3.value);
  savePrefs({ endpointRule1: r1, endpointRule2: r2, endpointRule3: r3 });
  sendToHost({ type: 'SET_ENDPOINT', rule1: r1, rule2: r2, rule3: r3 }).catch(() => {});
}

endpointRule1.oninput = () => { endpointVal1.textContent = (parseInt(endpointRule1.value) / 10).toFixed(1) + 's'; sendEndpoint(); };
endpointRule2.oninput = () => { endpointVal2.textContent = (parseInt(endpointRule2.value) / 10).toFixed(1) + 's'; sendEndpoint(); };
endpointRule3.oninput = () => { endpointVal3.textContent = endpointRule3.value + 's'; sendEndpoint(); };

const ENDPOINT_DEFAULTS = { endpointRule1: 0.8, endpointRule2: 0.6, endpointRule3: 15 };
$('btnResetEndpoint').onclick = () => {
  endpointRule1.value = String(Math.round(ENDPOINT_DEFAULTS.endpointRule1 * 10));
  endpointVal1.textContent = ENDPOINT_DEFAULTS.endpointRule1.toFixed(1) + 's';
  endpointRule2.value = String(Math.round(ENDPOINT_DEFAULTS.endpointRule2 * 10));
  endpointVal2.textContent = ENDPOINT_DEFAULTS.endpointRule2.toFixed(1) + 's';
  endpointRule3.value = String(ENDPOINT_DEFAULTS.endpointRule3);
  endpointVal3.textContent = ENDPOINT_DEFAULTS.endpointRule3 + 's';
  initRangeFills(); // 程序化赋值不触发 input 事件，填充色需手动刷新
  sendEndpoint();
};

chkShowPrev.onchange = () => {
  savePrefs({ showPrev: chkShowPrev.checked });
  sendToHost({ type: 'SET_PREV_OPTS', showPrev: chkShowPrev.checked, prevOpacity: parseInt(prevOpacitySlider.value) }).catch(() => {});
};

prevOpacitySlider.oninput = () => {
  const v = parseInt(prevOpacitySlider.value);
  prevOpacityLabel.textContent = String(v);
  savePrefs({ prevOpacity: v });
  sendToHost({ type: 'SET_PREV_OPTS', showPrev: chkShowPrev.checked, prevOpacity: v }).catch(() => {});
};

fontSizeSlider.oninput = () => {
  fontSizeLabel.textContent = fontSizeSlider.value;
  const size = parseInt(fontSizeSlider.value);
  sendToHost({ type: 'SET_FONT_SIZE', fontSize: size }).catch(() => {});
  savePrefs({ fontSize: size });
};

// —— 滑杆填充：已选区间染 accent 色，仅 init/input 时重算，无定时器/无轮询 ——
function updateRangeFill(el: HTMLInputElement) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const p = ((parseFloat(el.value) - min) / (max - min)) * 100;
  // 坑：Webkit 无法按 value 动态给 range 轨道着色（-webkit-slider-runnable-track
  // 不接受动态进度），只能内联 linear-gradient 双色硬断点模拟填充；
  // 百分比 toFixed(2) 消浮点尾巴，避免断点处出现 1px 锯齿
  el.style.background = `linear-gradient(to right, var(--accent) ${p.toFixed(2)}%, var(--border) ${p.toFixed(2)}%)`;
}
function initRangeFills() {
  document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(updateRangeFill);
}
// addEventListener 与上方 .oninput 赋值互不覆盖，两个监听都会触发
document.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(el => {
  el.addEventListener('input', () => updateRangeFill(el));
});
initRangeFills(); // 先按 HTML 默认值兜底；storage 异步读回后再刷一次真实值

// 坑：bg 的 FORWARD_TO_CONTENT 处理器只转发 msg.payload 给 content，
// PREFS_PATCH 必须整体放进 payload；字段名是 popup↔content 的显示契约
// （content 端由 auditor-ui 并行实现），勿改键名，否则运行中切换静默失效
chkLookback.onchange = () => {
  savePrefs({ lookbackEnabled: chkLookback.checked });
  sendToHost({
    type: 'FORWARD_TO_CONTENT',
    payload: { type: 'PREFS_PATCH', lookbackEnabled: chkLookback.checked },
  }).catch(() => {});
};

chkLatency.onchange = () => {
  savePrefs({ latencyIndicatorEnabled: chkLatency.checked });
  sendToHost({
    type: 'FORWARD_TO_CONTENT',
    payload: { type: 'PREFS_PATCH', latencyIndicatorEnabled: chkLatency.checked },
  }).catch(() => {});
};

// —— 实时翻译（离线自带模型）：方向选择 / 模型选择 / 下载指引 ——
const TRANSLATE_DIRS = ['auto', 'zh-en', 'en-zh'];

function applyTranslateDir(dir: string) {
  document.querySelectorAll<HTMLButtonElement>('#translateDirRow .seg').forEach(b => {
    const on = b.dataset.dir === dir;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

document.querySelectorAll<HTMLButtonElement>('#translateDirRow .seg').forEach(b => {
  b.onclick = () => {
    const d = b.dataset.dir!;
    applyTranslateDir(d);
    savePrefs({ translationDirection: d });
    pushTranslateLive();
  };
});

// —— 翻译时机：stream=实时跟句（中间态重译，冷却 0.5s）｜final=仅定稿（句完才翻） ——
function applyTranslateTiming(timing: string) {
  document.querySelectorAll<HTMLButtonElement>('#translateTimingRow .seg').forEach(b => {
    const on = b.dataset.timing === timing;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}

document.querySelectorAll<HTMLButtonElement>('#translateTimingRow .seg').forEach(b => {
  b.onclick = () => {
    const t = b.dataset.timing!;
    applyTranslateTiming(t);
    savePrefs({ translationTiming: t });
    pushTranslateLive();
  };
});

// 运行中改实时翻译设置：只有会话在跑时才需要通知宿主（空闲时改的就是"下次生效"，
// 由 START 时的配置回源读取）。不通知的话运行中改开关/方向/时机是完全静默无效的
// ——用户会以为功能坏了（实测反馈过"网页版翻译用不了"）。
function pushTranslateLive() {
  if (lastStatus !== 'Running') return;
  sendToHost({
    type: 'TRANSLATION_SETTINGS_LIVE',
    enabled: chkTranslate.checked,
    direction: activeTranslateDir(),
    timing: activeTranslateTiming(),
  }).catch(() => {});
}

function buildTranslateNotice() {
  translateNotice.textContent = '';
  translateNotice.appendChild(document.createTextNode(tSync(currentLang, 'translateNeedModel') + ' '));
  const link = document.createElement('a');
  link.href = TRANSLATE_RELEASES_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = tSync(currentLang, 'openReleases');
  translateNotice.appendChild(link);
}

async function refreshTranslateStatus() {
  try {
    const keys = await listModelKeys();
    translateStatus.textContent = keys.length > 0
      ? tSync(currentLang, 'modelLoaded').replace('{n}', String(keys.length))
      : tSync(currentLang, 'modelMissing');
  } catch {
    translateStatus.textContent = tSync(currentLang, 'modelMissing');
  }
}

function updateTranslateUi() {
  translateDirRow.style.display = chkTranslate.checked ? '' : 'none';
  translateTimingRow.style.display = chkTranslate.checked ? '' : 'none';
  translateNotice.style.display = chkTranslate.checked ? '' : 'none';
  if (chkTranslate.checked) buildTranslateNotice();
}

chkTranslate.onchange = () => {
  savePrefs({ translationEnabled: chkTranslate.checked });
  updateTranslateUi();
  pushTranslateLive();
};

btnPickModel.onclick = () => modelFolderPicker.click();

// 测试翻译：按当前方向发一次真实翻译请求，走 bg → offscreen → worker 全链路
function activeTranslateDir(): string {
  return document.querySelector<HTMLButtonElement>('#translateDirRow .seg.active')?.dataset.dir || 'auto';
}
function activeTranslateTiming(): 'stream' | 'final' {
  return document.querySelector<HTMLButtonElement>('#translateTimingRow .seg.active')?.dataset.timing === 'final'
    ? 'final' : 'stream';
}

let translateTesting = false;
let translateTestCancelled = false;

btnTestTranslate.onclick = async () => {
  if (translateTesting) {
    // 二次点击 = 取消：终止测试 worker（若为测试临时创建的），释放 CPU
    translateTestCancelled = true;
    sendToHost({ type: 'TRANSLATE_TEST_CANCEL' }).catch(() => {});
    translateTesting = false;
    $('testTranslateLabel').textContent = tSync(currentLang, 'testTranslate');
    translateStatus.textContent = tSync(currentLang, 'translateTestCancelled');
    return;
  }
  translateTesting = true;
  translateTestCancelled = false;
  const dir = activeTranslateDir();
  const sample = dir === 'en-zh' ? 'Hello world!' : '你好，世界！';
  $('testTranslateLabel').textContent = tSync(currentLang, 'translateTestCancel');
  translateStatus.textContent = tSync(currentLang, 'translateTesting');
  let r: any = null;
  try {
    r = await sendToHost({ type: 'TRANSLATE_TEST', text: sample, direction: dir });
  } catch { r = null; }
  translateTesting = false;
  if (translateTestCancelled) return;
  $('testTranslateLabel').textContent = tSync(currentLang, 'testTranslate');
  if (!r || typeof r.ok !== 'boolean') {
    translateStatus.textContent = tSync(currentLang, 'translateTestFail');
  } else if (r.ok) {
    translateStatus.textContent = tSync(currentLang, 'translateTestOk').replace('{t}', String(r.text ?? ''));
  } else if (r.error === 'no-model') {
    translateStatus.textContent = tSync(currentLang, 'translateTestNoModel');
  } else {
    translateStatus.textContent = tSync(currentLang, 'translateTestError').replace('{m}', String(r.error || ''));
  }
};

modelFolderPicker.onchange = async () => {
  const files = modelFolderPicker.files;
  if (!files || files.length === 0) return;
  try {
    // 先在内存里收齐全部文件再一次性原子落库（删旧 opus-mt 键 + 写新键同事务）。
    // 坑：旧实现先删后逐文件写，中途失败（配额触顶/页面关闭）留下半套模型——
    // worker 按"缺文件"报错，用户重传前翻译彻底不可用。
    const entries: { key: string; data: ArrayBuffer }[] = [];
    for (const f of Array.from(files)) {
      // webkitRelativePath 形如 `<选中文件夹>/opus-mt-en-zh/config.json`，
      // 存库时去掉选中文件夹前缀、以模型目录（opus-mt-en-zh/opus-mt-zh-en）为根，
      // 否则 worker 按 `opus-mt-en-zh/...` 匹配不到。
      const parts = f.webkitRelativePath.split('/');
      const modelIdx = parts.findIndex(p => p === 'opus-mt-en-zh' || p === 'opus-mt-zh-en');
      // 坑：用户可能选中上级目录、连带一堆无关文件（截图/视频）。全量 arrayBuffer()
      // 进内存会在导入前就 OOM，且无关文件也会被写进模型库。只收模型目录下的文件。
      if (modelIdx < 0) continue;
      const key = parts.slice(modelIdx).join('/');
      entries.push({ key, data: await f.arrayBuffer() });
    }
    if (entries.length === 0) {
      log(tSync(currentLang, 'errorPrefix').replace('{m}', tSync(currentLang, 'modelFolderEmpty')));
      modelFolderPicker.value = '';
      return;
    }
    // deleteMatch 用 includes 而不是 `^opus-mt-...`：历史版本曾把
    // `<选中文件夹>/opus-mt-en-zh/...` 整段存进库，锚定行首的正则清不掉这些旧键，
    // worker 的后缀兜底（translation-worker.ts 的 resolveFile）可能仍读到旧文件。
    // 新写入的键本来就以 opus-mt- 开头，宽松匹配不会误删其它模型数据。
    await saveModelFilesAtomic(entries, k => k.includes('opus-mt'));
    translateStatus.textContent = tSync(currentLang, 'modelLoaded').replace('{n}', String(entries.length));
    // 坑：worker 与引擎都把"缺模型"记忆化了（worker 缓存 + translateWarned 告警门），
    // 不通知的话，会话中途导入的模型要到下次启动才生效——用户会以为导入失败。
    // 通知宿主解除记忆：运行中的会话下一句就开始出译文，无需重启。
    sendToHost({ type: 'TRANSLATION_MODEL_IMPORTED' }).catch(() => {});
    log(tSync(currentLang, 'translateModelLive'));
  } catch (e: any) {
    log(tSync(currentLang, 'errorPrefix').replace('{m}', String(e?.message || e)));
  }
  modelFolderPicker.value = '';
};

onMessageFromHost((msg) => {
  switch (msg.type) {
    case 'TEXT_CHANGED':
      textPreview.innerHTML = `<div class="current-text">${escapeHtml(msg.text) || '...'}</div>`;
      break;
    case 'STATUS_TEXT':
      // 状态文案（正在加载模型 / 正在等待音频 / 请选择共享屏幕）落到状态栏，
      // 不再走 TEXT_CHANGED 混进"当前字幕"预览区——旧实现会把这类状态显示成一句字幕。
      if (msg.key === 'loadingModel') {
        // 加载态顶到 Hero 大状态词；Web 版换用带"勿切出页面"叮嘱的变体文案
        setHeroLoading(!IS_EXTENSION ? 'loadingModelWeb' : 'loadingModel');
      } else {
        if (!msg.key) setHeroLoading(null);
        log(msg.key ? tSync(currentLang, msg.key) : '');
      }
      break;
    case 'SENTENCE_DONE': {
      const el = document.createElement('div');
      el.className = 'sentence';
      el.textContent = msg.text;
      textPreview.prepend(el);
      if (textPreview.children.length > 10) textPreview.lastElementChild?.remove();
      // 坑：bg 转发的 SENTENCE_DONE 可能不带 ts（旧版本/异常路径），归零走 legacy
      // 渲染（无时标）；storage 里的权威条目由 bg appendTranscript 统一写 ts
      // seq：句序号（offscreen 原样送达），TRANSLATION_FINAL 据此精确配对译文；
      // 旧消息无 seq 时为 0，配对退回"末条"旧语义
      const seq = Number(msg.seq) || 0;
      // 坑：popup 开着时用户可能重启识别会话，seq 从 1 重新计数，与上一场条目撞号
      // → 译文按 seq 配对会挂到上一场的句子上。检测到回绕（seq 没有继续递增）就把已有
      // 条目的 seq 全抹掉，**并把基线重置到本句**——不重置的话，本场后续每一句都仍满足
      // seq <= 旧基线，会反复全表 strip，本场条目永远留不住 seq、迟到译文只能退回
      // "末条"兜底而错位。存储装载时已抹掉历史 seq（见 loadTranscript），基线只反映本场。
      if (seq > 0 && seq <= maxSeqSeen) {
        transcriptEntries.forEach(e => { delete e.seq; });
        maxSeqSeen = seq;
      } else if (seq > maxSeqSeen) {
        maxSeqSeen = seq;
      }
      transcriptEntries.push({ text: String(msg.text ?? ''), ts: Number(msg.ts) || 0, seq });
      // 内存里也按同一上限裁剪：本列表原本只增不减，而 renderTranscript 每次全量重渲
      //（O(n) 字符串拼接 + innerHTML），几小时的长会话下来内存与每句渲染耗时都会线性恶化。
      // 存储侧本来就是同一上限，裁掉最老的条目与"记录里能看到的历史"一致。
      if (transcriptEntries.length > TRANSCRIPT_MAX) {
        transcriptEntries.splice(0, transcriptEntries.length - TRANSCRIPT_MAX);
      }
      renderTranscript();
      break;
    }
    case 'TRANSLATION_FINAL':
      // 定稿译文：按 seq 精确挂到对应原句（慢速下译文迟到时句子可能已不是末条——
      // 旧实现挂"末条"导致译文错位/丢失）；无 seq 的旧消息退回"末条无译文"旧语义
      if (msg.text) {
        const seq = Number(msg.seq) || 0;
        let target = seq > 0
          ? [...transcriptEntries].reverse().find(e => e.seq === seq && !e.tr)
          : undefined;
        if (!target) {
          const last = transcriptEntries[transcriptEntries.length - 1];
          if (last && !last.tr) target = last;
        }
        if (target) {
          target.tr = String(msg.text);
          renderTranscript();
        }
      }
      break;
    case 'LEVEL': {
      // 坑：v 可能越界/非数值（测量端异常），钳到 [0,1] 防画布炸
      const v = Math.max(0, Math.min(1, Number(msg.v) || 0));
      levels.push(v);
      if (levels.length > LEVEL_BARS) levels.shift();
      lastLevelAt = Date.now();   // 有数据在来，别触发兜底补零
      // 减弱动态模式下无 rAF 循环，随消息事件驱动重绘（~120ms 一条，足够顺滑）
      if (reduceMotion.matches && lastStatus === 'Running' && chkWaveform.checked) drawWave();
      break;
    }
    case 'STATUS_CHANGED':
      // bg 会在 Running 转发里附带 startedAt（会话真实开始时刻），用于校准计时基准
      setStatus(msg.status, msg.startedAt);
      break;
    case 'LOG':
      log(msg.message);
      break;
    case 'HELPER_SILENT':
      // 桌面助手没启动/没连上/处于暂停：不是故障——会话照常跑（这个音源此刻就是静音）。
      // 只在日志区提醒一句（**不带**"错误："前缀，它不是错误），不置 Stopped、不弹模态。
      log(String(msg.message || ''));
      break;
    case 'ERROR':
      // 坑：errorPrefix 的 {m} 是占位符，须手动 replace（与 searchHits 同一套约定）
      log(tSync(currentLang, 'errorPrefix').replace('{m}', String(msg.message)));
      // 麦克风启动失败升级为模态：授权框没出现就闪退时，这是用户唯一读得到原因的地方
      if (msg.micFailure) showMicErrorModal(String(msg.message || ''));
      setStatus('Stopped');
      break;
    case 'LOCK_CHANGED':
      locked = msg.locked;
      updateLockUI();
      break;
  }
});

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s; return d.innerHTML;
}

loadPrefs().then(initRangeFills); // storage 值写回滑杆后再刷填充色
refreshTranslateStatus(); // 独立于 prefs，直接查 IndexedDB 模型安装状态
loadTranscript();
applyLang();
// 已导入过 ASR 模型则显示「重新选择识别模型」按钮（位于音频来源上方）
// 只有 nomodel 版且 IndexedDB 里有模型才显示：完整/lite 版包内自带，无需重新选择
(async () => {
  if (await hasBundledResource(ASR_DATA_PATH)) return; // 包内有模型，永不显示按钮
  try {
    const blob = await getModelFile(ASR_DB_KEY);
    if (blob && blob.size > 0) btnReselectModel.hidden = false;
  } catch { /* 库异常保持隐藏 */ }
})();
btnReselectModel.onclick = () => { openAsrModelPanel(); };
storage.get('tmspeech_use_punct').then(r => {
  chkPunct.checked = r['tmspeech_use_punct'] !== false;
});
// 坑：GET_STATUS 的 locked 现由 bg 异步回源 storage 后 sendResponse（处理器 return true），
// promise 仍会正常 resolve，但响应晚于同步分支——此处不得假设响应同步可达。
// 探测本机助手（并行、几百毫秒内出结果，不阻塞面板其它初始化）：
// **音源常驻显示**，探测结果只决定"能不能启动"和提示语（早期"探测到才显示"已废弃，
// 用户实测在 Web 版里因此找不到这个音源 —— 见 detectHelper 上方注释）。
void detectHelper();
sendToHost({ type: 'GET_STATUS' }).then((resp: any) => {
  // 坑：status 缺失（响应异常）时不得调 setStatus——undefined 会落进 else 分支误显 Stopped
  if (resp?.status) setStatus(resp.status, resp.startedAt);
  if (resp?.locked !== undefined) { locked = resp.locked; updateLockUI(); }
  // 波形快照回填：setStatus 画的是空基线，这里用 bg 兜底的最近 ~7s 电平重画，
  // 面板每次打开都能看到上一段波形，而不是从空白重新填充
  if (Array.isArray(resp?.levels) && resp.levels.length) {
    levels = resp.levels.slice(-LEVEL_BARS);
    if (chkWaveform.checked && lastStatus === 'Running') drawWave();
  }
}).catch(() => {});
