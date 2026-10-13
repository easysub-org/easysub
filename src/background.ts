// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
import { t } from './i18n';
import { createLogBuffer } from './logbus';
import { apiSettingsFromPrefs, originPatternFor } from './translate-api';
// 字幕记录的读写全部收敛在 transcript-store（与纯 Web 版共用同一份实现）；
// 这里只需要追加与挂译文两个入口，其余导出留给未来可能用到的地方。
import { appendTranscript, attachTranscriptTranslation } from './transcript-store';
const PENDING_KEY = 'pendingInit';
// offscreen 文档"当前装的是哪套识别配置"的指纹（见 startRecognition 的复用判定）。
// 识别配置（语言/标点/端点阈值/热词）在 createOnlineRecognizer 时一次性烘焙进 WASM，
// 只有配置一致才允许复用残留文档；不一致必须重建，否则用户改了热词/阈值却不生效。
// 正常流程下停止即销毁文档（见 cleanupAll），此指纹只服务于崩溃残留等异常场景的复用判定。
const OFFSCREEN_CFG_KEY = 'offscreenCfgKey';
// 坑：会话核心状态全是下面的 SW 内存全局变量，service worker 空闲约 30 秒即被杀、全部归零。
// 不在 storage.session 里留一份跨重启快照的话，"SW 已死期间用户关掉了被捕获标签页"
// 这一窗口期内触发的事件将无人能识别（onRemoved 冷启动后内存里 tabId 是 null）。
// storage.session 随浏览器关闭自动清空、且对页面内容不可见，正适合放这类敏感运行态。
const SESSION_KEY = 'runningSession';
// 坑：锁态的唯一事实源是 storage.local['tmspeech_locked']；下面的 overlayLocked 只是
// 本 SW 生命周期的内存缓存。SW 空闲约 30s 被杀后缓存归零，若任何路径只读缓存不回源
// storage，就会出现"三端锁态发散"（popup 说没锁 / 字幕层实际锁着 / 新建层按未锁绘制）。
const LOCK_KEY = 'tmspeech_locked';
let captureTabId: number | null = null;
// 音频来源：'tab'=标签页捕获 | 'system'=系统音频（offscreen 内 getDisplayMedia 环回）
// | 'mic'=麦克风。system/mic 模式无目标标签页，captureTabId 恒为 null，
// "关标签页自动停止"/字幕层注入等 tab 逻辑全部天然跳过，字幕显示端为悬浮窗。
let sessionSource: 'tab' | 'system' | 'mic' | 'helper' = 'tab';
// 麦克风采集的宿主是悬浮字幕窗（可见扩展页）：Chrome 不允许 offscreen 文档做
// getUserMedia 音频采集（报 NotAllowedError，权限气泡也无从展示），而系统音频的
// getDisplayMedia 选择器是特批例外——所以 mic 模式的音频轨只能在悬浮窗里拿。
// popup → bg → 悬浮窗开流，PCM 块经 bg 中转喂给 offscreen 的识别管道。
// 设备不在此处指定：交给 Chrome 授权弹窗选择并记住，扩展内不做设备下拉。
// 悬浮字幕窗（独立扩展页弹窗，可置顶画中画）：仅显示端，关窗不影响识别会话。
let floatingWinId: number | null = null;
// 悬浮窗 id 的持久化镜像（storage.session）：SW 被回收后内存值归零，而"关的是不是悬浮窗"
// 与"要不要开新窗"都依赖它。不落库的话，冷启动后用户在关别的窗口时会被误判成关悬浮窗
// （system/mic 会话被无辜停掉）。
const FLOATING_WIN_KEY = 'floatingWindowId';
function persistFloatingWin() {
  if (floatingWinId != null) chrome.storage.session.set({ [FLOATING_WIN_KEY]: floatingWinId }).catch(() => {});
  else chrome.storage.session.remove(FLOATING_WIN_KEY).catch(() => {});
}
let floatingPort: chrome.runtime.Port | null = null;
let pipelineStatus = 'Stopped';
// 会话开始时刻（Date.now()）：START 成功或 FW_POP 首见 Running 时盖章；
// 纳入 persistSession 快照，SW 重启后 GET_STATUS 仍能还原真实计时基准。
// 0 = 无进行中会话（cleanupAll 清零）。
let sessionStartedAt = 0;
let overlayLocked = false;
let offscreenPort: chrome.runtime.Port | null = null;
// 本 SW 生命周期内的配置指纹镜像（与 storage.session 的 OFFSCREEN_CFG_KEY 同步）。
// 用于同步判断"当前 offscreen 文档是不是正在跑的会话文档"，避免"测试翻译"结束时
// 的 closeDocument 把正在识别的文档（连同已加载的模型）误杀。
let offscreenCfgKeyInMem: string | null = null;
let reconnectTimer: any = null;
// 坑：START_RECOGNITION 的异步体里有多个 await 点（closeDocument、轮询等最长可拖 1.5s+），
// 期间用户点 STOP 触发 cleanupAll 后，START 残余代码仍会继续执行：重置 Running、新建
// offscreen 文档、投递 INIT——用户已明确停止，采集却继续（幽灵会话）。
// 解法：会话代次计数器，每次 START 与任何清理路径都自增；START 异步体在每个恢复点核对
// 代次，不匹配立即中止（不再置状态/不发消息/不创建文档）。SW 重启后计数归零无妨：
// 代次只在同一次 SW 生命周期内的 START 与清理之间做比对。
let sessionEpoch = 0;
/**
 * 我们**自己**关闭 offscreen 文档的时刻（盲审 severe 1）。
 * 为什么需要：START 因配置变化会 closeDocument 重建文档，而它在 `++sessionEpoch` **之后**才关，
 * 于是旧端口 onDisconnect 里取的代次快照恰好等于新代次 —— 守卫失效 → 3 秒后把**刚起来的新会话**
 * 按"后台页面意外关闭"整场拆掉（表现：点开始约 3 秒后自动停止，日志原因是错的，"第一次重启必失败"）。
 * 这里记下自关闭时刻，onDisconnect 看到"刚才是我们自己关的"就不武装重连定时器。
 */
let lastSelfCloseAt = 0;
// 电平快照（最近 60 条，~7s）：波形只在 popup 打开时渲染，LEVEL 消息收不到时
// 快照兜底，让"每次打开面板"都能恢复上一段波形而不是从空基线重新填充。
const LEVEL_SNAPSHOT_MAX = 60;
let bgLevels: number[] = [];

// —— 全部日志（用户要的"日志区"）：默认不看，面板底部按钮才展开 ——
// 单一真相源放在 background：面板(popup)、offscreen、浮窗、助手的消息都汇到这里，
// popup 关掉再打开也能看到历史（节流镜像到 storage.session，SW 被回收也还能捞回来）。
const bgLogs = createLogBuffer();
let logFlushTimer: any = null;
//: 出错时不要把唯一显示端（悬浮字幕窗）关掉——用户得看见原因（"闪一下就没了"曾是最差体验）。
let keepFloatingForNotice = false;

/** 记一条并广播。`meta`（id/t）用于**沿用调用方的身份** —— 面板自己记过的那条会带着
 *  同一个 id 回来，去重才命中（否则同一条在日志窗里出现两三遍，独立审查 B1）。 */
function logLine(level: 'info' | 'warn' | 'error', source: string, message: string,
                 meta?: { t?: number; id?: string }) {
  const entry = bgLogs.append(level, source, String(message == null ? '' : message), meta);
  sendToPopup({ type: 'LOG_APPEND', entry });
  if (!logFlushTimer) logFlushTimer = setTimeout(flushLogs, 1000);
  return entry;
}

function flushLogs() {
  logFlushTimer = null;
  try {
    // 只镜像最后 200 条：storage.session 是给"重开面板还能看到刚才发生了什么"，不是长期档案
    chrome.storage.session.set({ tmspeech_logs: bgLogs.list().slice(-200) }).catch(() => {});
  } catch { /* session 存储不可用（老浏览器）：内存里那份仍然能用 */ }
}

async function restoreLogs() {
  try {
    const r = await chrome.storage.session.get('tmspeech_logs');
    const saved = (r && (r as any).tmspeech_logs) || [];
    // 独立审查 B11：恢复的条目要**按时间插回正确位置**，不能无脑追加到末尾 —— SW 冷启动后
    // 可能已经有新日志进来，追加会把顺序弄反，而且超上限时环形裁剪从头部丢的正是这些新日志。
    const known = new Set(bgLogs.list().map((e) => e.id));
    const restored = saved.filter((e: any) => e && !known.has(e.id));
    const merged = [...restored, ...bgLogs.list()].sort((a, b) => (a.t || 0) - (b.t || 0));
    bgLogs.clear();
    for (const e of merged) bgLogs.append(e.level || 'info', e.source || 'app', e.message || '', { t: e.t, id: e.id });
  } catch { /* 读不到就算新会话 */ }
}

void restoreLogs();

// SW 冷启动补装一次 Origin 规则：用户可能早就配好了地址、之后没再改过设置
// （动态规则本身是持久化的，这里只是保证"升级/首次启用"后也一定装上）。
void chrome.storage.local.get('tmspeech_prefs')
  .then((r: any) => syncApiOriginRule(apiSettingsFromPrefs(r?.tmspeech_prefs || {}).base))
  .catch(() => {});

//: 只维护**一条**动态规则（用户改地址就替换它）。
const API_ORIGIN_RULE_ID = 90210;

/**
 * 给"用户配置的翻译 API 地址"去掉 `Origin`/`Referer` 请求头。
 *
 * 为什么需要（用户实测）：Ollama 默认只放行 localhost 页面，扩展发的是
 * `Origin: chrome-extension://<ID>` → **403**，而 Web 版同配置能用。`Origin` 是禁止修改的
 * 头，JS 层面删不掉，只能用 declarativeNetRequest。
 * 范围刻意收得很紧：**只这一个 host**、只删这两个头、只作用于本扩展发起的请求
 * （`initiatorDomains: [chrome.runtime.id]`），对网页与其它域名零影响。
 * 对非 Ollama 的服务同样安全（云端 API 一般不看 Origin；删掉也无副作用）。
 */
async function syncApiOriginRule(base: string) {
  try {
    const dnr: any = (chrome as any).declarativeNetRequest;
    if (!dnr?.updateDynamicRules) return;                 // 老版本/权限缺失：静默跳过，报错文案兜底
    const pattern = originPatternFor(base);
    const existing = await dnr.getDynamicRules();
    const current = existing.find((r: any) => r.id === API_ORIGIN_RULE_ID);
    const same = !!current
      && current.condition?.urlFilter === pattern
      && Array.isArray(current.condition?.initiatorDomains)
      && current.condition.initiatorDomains[0] === chrome.runtime.id;
    // 规则没变化就**什么都不做**：既不重写、也不打日志。
    // 这条同步会被面板每次保存/测试翻译/SW 冷启动各调一次，早先每次都打一行 →
    // 用户日志区被"已为该地址移除 Origin/Referer 请求头…"刷屏（实测反馈）。
    if (same) return;
    const removeRuleIds = existing.filter((r: any) => r.id === API_ORIGIN_RULE_ID).map((r: any) => r.id);
    if (!pattern) {
      if (removeRuleIds.length) await dnr.updateDynamicRules({ removeRuleIds });
      return;
    }
    await dnr.updateDynamicRules({
      removeRuleIds,
      addRules: [{
        id: API_ORIGIN_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Origin', operation: 'remove' },
            { header: 'Referer', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: pattern,
          // **必须收窄到"本扩展发起的请求"** —— 这条是血的教训：先前为了排查扩展 403
          // 把它去掉后，规则开始匹配**整个 profile 里所有发往该地址的请求**，包括 :8000
          // 页面的 CORS 预检：页面预检的 Origin 被删掉 → Ollama 的 CORS 层不接管、落到路由
          // → /v1/chat/completions 只注册 POST → **405 + Allow: POST** → 页面被 CORS 挡死。
          // （用户用逐字节复刻证明了这一点：带 Origin → 204 全套 CORS 头；无 Origin → 405。）
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      }],
    });
    // 只在**真的装/换**规则时记一条（用户能据此确认规则已就位，且不再刷屏）
    logLine('info', 'app', `已为该地址移除 Origin/Referer 请求头：${pattern}`);
  } catch (e) {
    // 规则下发失败不该影响翻译本身（顶多还是 403，报错文案会告诉用户怎么办）
    logLine('warn', 'app', '同步翻译 API 的 Origin 规则失败: ' + e);
  }
}

function sendToPopup(msg: any) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

//: 浮窗还没连上端口时暂存的提示（独立审查 B5：NOTICE 是一次性的，丢了就永远没有原因了）。
let pendingNotice: any = null;

/** 给浮窗发常驻提示；窗口/端口还没就绪就先存着，等 onConnect 补发。 */
function notifyFloating(level: 'info' | 'error', message: string) {
  const payload = { type: 'NOTICE', level, message };
  if (!floatingPort) {
    pendingNotice = payload;
    return;
  }
  sendToFloating(payload);
}

/** 撤掉浮窗上的常驻提示（新会话开始、或原因已不成立时）。 */
function clearFloatingNotice() {
  pendingNotice = null;
  sendToFloating({ type: 'NOTICE', message: '' });
}

function sendToTab(tabId: number, msg: any) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// 悬浮字幕窗显示消息扇出：端口随窗口关闭已自动置空，发送失败（窗口正在关闭）静默忽略
function sendToFloating(payload: any) {
  if (!floatingPort) return;
  try { floatingPort.postMessage(payload); } catch {} // eslint-disable-line no-empty
}

// 字幕显示设置消息双扇出：tab 模式进页内叠层，system 模式进悬浮窗（同一套协议，
// overlay.ts 共用实现）——popup 的锁定/字号/上一句/回看/外观调整实时同步到两个端
function sendToDisplays(payload: any) {
  if (captureTabId) sendToTab(captureTabId, payload);
  sendToFloating(payload);
}

// —— 悬浮字幕窗开合（唯一入口：START_RECOGNITION 按音源自动决定，popup 不再手动开关）——
async function openFloating() {
  // 已开着就聚焦；窗口 id 失效（用户手动关闭后 storage 之外的陈旧引用）则重建
  if (floatingWinId != null) {
    try { await chrome.windows.update(floatingWinId, { focused: true }); return; } catch { floatingWinId = null; }
  }
  // 坑：floatingWinId 是内存值，SW 被回收后重启就归零。同一场会话若再开窗（RECONNECT
  // 自愈等路径），这里会以为"没开过"而新开一个——桌面上出现两个悬浮字幕窗，旧的那个
  // 还成了没人管的孤儿（后续消息只发给新窗口）。回源持久化镜像先复用旧窗。
  try {
    const id = (await chrome.storage.session.get(FLOATING_WIN_KEY))[FLOATING_WIN_KEY];
    if (typeof id === 'number') {
      try { await chrome.windows.update(id, { focused: true }); floatingWinId = id; return; }
      catch { persistFloatingWin(); } // 陈旧 id：清掉镜像，走新建
    }
  } catch { /* storage 异常：按"没开过"处理，与旧行为一致 */ }
  const win = await chrome.windows.create({
    url: 'floating.html', type: 'popup', width: 780, height: 240,
  });
  floatingWinId = win?.id ?? null;
  persistFloatingWin();
}

function closeFloating() {
  if (floatingWinId != null) {
    chrome.windows.remove(floatingWinId).catch(() => {});
    // floatingWinId/floatingPort 与镜像由下方 onRemoved 监听器统一清理。
    // 这里**不要**抢先清空内存值：那样 onRemoved 就认不出关的是哪个窗口，
    // floatingPort 会一直挂着，后续消息继续发给一个已消失的窗口。
  }
}

function persistSession() {
  // 坑：会话快照的单一出口。所有改写 captureTabId/pipelineStatus 的地方都要同步调它，
  // 否则 SW 冷启动后 onRemoved/RECONNECT 会读到过期快照（把已停会话当活的，或反之）。
  if (pipelineStatus === 'Running' && (captureTabId != null || sessionSource !== 'tab')) {
    // 坑：startedAt 仅在 >0 时写入——SW 冷启动恢复路径（RECONNECT 自愈）内存里是 0，
    // 若无条件覆盖会把重启前已盖章的真实开始时刻冲掉，popup 计时又归零
    const snap: any = { tabId: captureTabId, status: pipelineStatus, source: sessionSource };
    if (sessionStartedAt > 0) snap.startedAt = sessionStartedAt;
    chrome.storage.session.set({ [SESSION_KEY]: snap }).catch(() => {});
  } else {
    chrome.storage.session.remove(SESSION_KEY).catch(() => {});
  }
}

// 坑：hasDocument() 与 createDocument() 之间没有互斥（TOCTOU）。START 与"测试翻译"
// 两条路径几乎同时冷启动时会双发 createDocument，第二个必抛
// "Only a single offscreen document may be created"——START 路径直接变"启动失败"。
// 用模块级 in-flight promise 串行化，catch 后复查文档确实在就视为成功（被对手创建）。
let ensureOffscreenInFlight: Promise<void> | null = null;
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;
  if (ensureOffscreenInFlight) {
    await ensureOffscreenInFlight.catch(() => {});
    if (!(await chrome.offscreen.hasDocument().catch(() => false))) {
      throw new Error('offscreen 文档创建失败');
    }
    return;
  }
  ensureOffscreenInFlight = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      // DISPLAY_MEDIA：system 模式在文档内直接 getDisplayMedia（桌面采集+系统音频）
      reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'] as any,
      justification: 'Speech recognition audio processing',
    })
    .then(
      undefined,
      async (e) => {
        // 并发对手赢下了创建 → 文档在即可视为成功；文档真不在才把原始错误抛出
        if (!(await chrome.offscreen.hasDocument().catch(() => false))) throw e;
      },
    )
    .finally(() => { ensureOffscreenInFlight = null; });
  await ensureOffscreenInFlight;
}

chrome.runtime.onConnect.addListener((port) => {
  // —— 悬浮字幕窗端点：独立显示端，与 offscreen 端点互不相干 ——
  if (port.name === 'floating') {
    floatingPort = port;
    port.onDisconnect.addListener(() => {
      if (floatingPort === port) floatingPort = null;
    });
    // 独立审查 B5：端口就绪时补发暂存的常驻提示 —— 否则"错误发生在窗口创建/连接之前"
    // 的那次提示会被静默丢掉，而 cleanupAll 又刻意留了窗口，用户得到一个没有原因的空白浮窗。
    if (pendingNotice) {
      sendToFloating(pendingNotice);
      pendingNotice = null;
    }
    // 悬浮窗回传：mic PCM 块转发给 offscreen 直接喂管道；开流失败则终止会话
    port.onMessage.addListener((m: any) => {
      if (m?.type === 'MIC_CHUNK') {
        if (!m.audio) return;
        // 复核 P0-2：只在**当前会话确实是 mic** 时才转发。保留浮窗的例外路径能让旧 mic 采集
        // 活过会话边界，而 feedMicChunk 不判来源（只判 pipeline 存不存在）→ 会把麦克风
        // 混进下一场系统音频会话。这里按会话音源门控，双保险。
        if (sessionSource !== 'mic') return;
        // audio 是 number[]（Port 的 JSON 克隆所致，见 floating.ts 注释），原样中继即可
        try { offscreenPort?.postMessage({ type: 'MIC_CHUNK', audio: m.audio, sampleRate: m.sampleRate }); } catch { /* offscreen 未就绪，丢弃本块 */ }
        return;
      }
      if (m?.type === 'MIC_RESULT' && m.ok !== true) {
        // 盲审 P1-2/P2-2：mic 失败是**最常见**的错误，但它以前既不进日志缓冲、也没留住浮窗
        // （浮窗正是授权弹框所在窗口）—— 用户只看到权限 UI 一闪，popup 已关，什么都没有。
        logLine('error', 'app', '麦克风采集失败：' + String(m.error || '未知原因'));
        keepFloatingForNotice = true;
        notifyFloating('error', '麦克风采集失败：' + String(m.error || '未知原因'));
        // 文案走 i18n（双语）：权限被拒 / 无设备（系统禁用时 Chrome 不弹授权框直接拒，
        // NotFoundError 单列给排查指引）/ 被占用 / 其它失败分开表述；
        // micFailure 标记让面板把这类启动失败升级为模态（状态栏一行小字不够醒目）
        void (async () => {
          const msg = m.name === 'NotAllowedError'
            ? `${await t('micDenied')} ${await t('micGrantTip')}`
            : m.name === 'NotFoundError'
              ? await t('micNotFound')
              : m.name === 'NotReadableError' || m.name === 'AbortError'
                ? await t('micNotReadable')
                : m.name === 'TrackEnded'
                  ? await t('micTrackEnded')
                  : `${await t('micFailFallback')}: ${m.error || ''}`.trim();
          sendToPopup({ type: 'ERROR', message: msg, micFailure: true });
        })();
        cleanupAll();
      }
    });
    // 刚打开的悬浮窗不知道会话状态：补发当前状态 + 让 offscreen 重发当前句文本
    sendToFloating({ type: 'STATUS_CHANGED', status: pipelineStatus, startedAt: sessionStartedAt });
    try { offscreenPort?.postMessage({ type: 'RESEND_CURRENT_TEXT' }); } catch {} // eslint-disable-line no-empty
    // mic 会话的采集端就在这个窗口里：端口一连上（含冷 SW 复活/窗口重载）就下采集令。
    // 内存态不可信时回源会话快照——SW 被回收再唤醒后 sessionSource 归零是常态。
    (async () => {
      let src = sessionSource, status = pipelineStatus;
      if (status !== 'Running') {
        try {
          const s = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as
            { source?: 'tab' | 'system' | 'mic' | 'helper'; status?: string } | undefined;
          if (s?.status === 'Running') { src = s.source || src; status = s.status; }
        } catch { /* 读不到快照就按内存态 */ }
      }
      if (status === 'Running' && src === 'mic') sendToFloating({ type: 'MIC_CAPTURE_START' });
    })();
    return;
  }
  if (port.name !== 'offscreen') return;
  offscreenPort = port;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'TRANSLATE_TEST_RESULT') {
      // 面板"测试翻译"的一次性应答：按 id 回给发起方 sendResponse。
      // 坑：offscreen 经 sendSafe() 发送，实际结构是 {type, payload:{id,...}}，必须从 payload 取值
      const p = msg.payload || {};
      const cb = translateTestResolvers[p.id];
      delete translateTestResolvers[p.id];
      if (cb) cb({ ok: p.ok, text: p.text, error: p.error, debug: p.debug });
      // 测试是临时拉的 offscreen。只有当前没有识别会话、且这个文档不是正在跑会话的文档
      // 时才回收它——会话文档里装着已加载的 WASM/模型，误杀会立刻中断正在进行的识别。
      if (pipelineStatus !== 'Running' && !offscreenCfgKeyInMem) {
        chrome.offscreen.closeDocument().catch(() => {});
        lastSelfCloseAt = Date.now();
      }
      return;
    }
    if (msg.type === 'FW_STOP') {
      // offscreen 采集被取消/失败：音频注定进不来，走与手动停止完全相同的统一清理，
      // 否则 bg 停在 Running、悬浮窗空挂成幽灵会话（同条 ERROR 已先行扇出，popup 归位）
      cleanupAll();
      return;
    }
    if (msg.type === 'FW_CT') {
      // 字幕显示消息双扇出：tab 模式进页面字幕层；system 模式无 tab，悬浮窗是唯一显示端
      if (captureTabId) sendToTab(captureTabId, msg.payload);
      sendToFloating(msg.payload);
    }
    if (msg.type === 'FW_POP') {
      const p = msg.payload || {};
      // 定稿译文：offscreen 每句完成时经 FW_POP 送来，按 seq 挂到对应历史原句
      // （seq 缺失时退回"末条"旧语义）；同时照常转发 popup
      if (p.type === 'TRANSLATION_FINAL') {
        attachTranscriptTranslation(p.text, p.seq, (e) => console.log('[TM BG] 转写译文持久化失败:', e));
      }
      // 电平快照：popup 关闭时 LEVEL 消息无人消费，这里留着，重开面板时还原最近波形，
      // 避免"每次打开都从空基线重新填充"。钳值防脏；只保留最近 ~7s（60 条 × 120ms）。
      if (p.type === 'LEVEL') {
        bgLevels.push(Math.max(0, Math.min(1, Number(p.v) || 0)));
        if (bgLevels.length > LEVEL_SNAPSHOT_MAX) bgLevels.shift();
      }
      // 悬浮窗只消费这三类 FW_POP 消息（其余显示类已由 FW_CT 扇出覆盖，避免重复）
      // HELPER_SILENT：助手暂停 / 连上后掉线的**静音降级**（连着，只是暂时没声音）。
      // 它不是故障：不惊动悬浮窗、不走 ERROR 的 cleanupAll（那会把模型整场拆掉），
      // 只进面板日志区提醒一句"助手没连上，当前是静音"。
      if (p.type === 'HELPER_SILENT') {
        // 坑（独立审查 ①②）：以前只发给 popup 的日志行 —— 点「开始」后 popup 必然已关闭，
        // 而浮窗又刻意不接这类消息，于是"助手暂停/掉线"这类最高频的静音降级**零反馈**。
        // 现在：进日志 + 给浮窗发一条常驻提示（浮窗是采集时唯一看得见的界面）。
        logLine('warn', 'helper', p.message);
        notifyFloating('info', p.message);
        sendToPopup({ type: 'LOG', message: p.message });
      } else if (p.type === 'STATUS_CHANGED' || p.type === 'ERROR' || p.type === 'LEVEL') {
        sendToFloating(p);
      }
      if (p.type === 'STATUS_CHANGED') {
        if (pipelineStatus !== p.status) logLine('info', 'session', p.status);
        pipelineStatus = p.status;
        // 坑：offscreen 不知道会话何时开始（尤其 SW 重启后 RECONNECT 自愈恢复的
        // Running），首次见到 Running 就地盖章；已有戳（正常 START 路径）不覆盖
        if (p.status === 'Running' && !sessionStartedAt) sessionStartedAt = Date.now();
        persistSession();
        // 附带 startedAt 让已打开的 popup 直接校准计时基准（重开面板不再从 00:00 起）
        sendToPopup({ ...p, startedAt: sessionStartedAt });
      } else if (p.type === 'LOG') {
        logLine('info', 'engine', p.message);
        sendToPopup(p);
      } else if (p.type !== 'SENTENCE_DONE' && p.type !== 'HELPER_SILENT') {
        // 坑：SENTENCE_DONE 不能走这里原样转发——下方盖章块会再发一份带 ts 的，
        // 不排除的话 popup 每句收两条（一条无时标一条有），列表重复。
        // HELPER_SILENT 也排除：上面已按 LOG 转发过一次，原样再发会让面板打出
        // 第二条、还带"错误："前缀——它不是故障（独立审查抓的）。
        sendToPopup(p);
      }
      if (p.type === 'ERROR') {
        // 真故障（设备被拔/助手崩了/休眠唤醒）：先让用户看见原因，**再**收敛会话。
        // keepFloatingForNotice 让 cleanupAll 不要关掉浮窗 —— 否则用户只看到"闪一下消失"。
        logLine('error', 'app', p.message);
        keepFloatingForNotice = true;
        notifyFloating('error', p.message);
        cleanupAll();
      }
      if (p.type === 'SENTENCE_DONE') {
        // 坑：offscreen 发的 SENTENCE_DONE 只带 text 不带 ts——原样转发会让 popup
        // 推 {text, ts:0}，新句在面板里永远不显示时间戳（storage 入库反而是对的）。
        // 这里统一盖一次戳：转发与入库共用同一时刻，屏上偏移与存储条目严格一致。
        // seq 原样透传：popup 的 TRANSLATION_FINAL 也按它精确挂译文，两侧索引一致。
        const ts = Date.now();
        sendToPopup({ ...p, ts });
        appendTranscript(p.text, ts, Number(p.seq) || undefined, (e) => console.log('[TM BG] 转写持久化失败:', e));
      }
      if (p.type === 'LOG') console.log('[TM BG]', p.message);
      if (msg.payload?.type === 'REQUEST_STREAM') {
        // 仅 tab 模式会出现（system 模式由 offscreen 直接 getDisplayMedia）
        handleRequestStream(msg.payload.tabId);
      }
      if (msg.payload?.type === 'RECONNECT') {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        console.log('[TM BG] offscreen 重连, status=', msg.payload.status, 'tabId=', msg.payload.tabId);
        pipelineStatus = msg.payload.status;
        const reviveSource: 'tab' | 'system' | 'mic' | 'helper' =
          msg.payload.source === 'system' || msg.payload.source === 'mic'
            || msg.payload.source === 'helper' ? msg.payload.source : 'tab';
        sessionSource = reviveSource;
        if (msg.payload.status === 'Running' && reviveSource !== 'tab') {
          // system/mic 模式自愈：无标签页可校验，直接恢复会话状态（悬浮窗/popup 靠扇出消息刷新）
          captureTabId = null;
          const backfill = !sessionStartedAt
            ? chrome.storage.session.get(SESSION_KEY).then((stored) => {
                const sess = stored[SESSION_KEY] as { startedAt?: number } | undefined;
                if (sess?.startedAt) sessionStartedAt = sess.startedAt;
              }).catch(() => {})
            : Promise.resolve();
          backfill.then(() => {
            sendToPopup({ type: 'STATUS_CHANGED', status: 'Running', startedAt: sessionStartedAt });
            persistSession();
          });
        } else if (msg.payload.tabId && msg.payload.status === 'Running') {
          // 坑：RECONNECT 自愈绝不能无条件复活会话——offscreen 文档独立于 SW 存活，
          // 它上报的标签页可能在 SW 死亡期间已被用户关闭；不校验存活的话，
          // "关标签页自动停止"会被这条自愈路径原样绕过（复活后继续解码静音）。
          const reviveTabId = msg.payload.tabId;
          chrome.tabs.get(reviveTabId).then(async () => {
            // 坑：冷启动后内存 sessionStartedAt=0，必须先从快照回填真实开始时刻，
            // 否则下面 persistSession 整对象覆写会把重启前盖的章抹掉、popup 计时归零
            // （对齐 onRemoved 路径 :281 的回填做法）
            if (!sessionStartedAt) {
              try {
                const stored = await chrome.storage.session.get(SESSION_KEY);
                const sess = stored[SESSION_KEY] as { startedAt?: number } | undefined;
                if (sess?.startedAt) sessionStartedAt = sess.startedAt;
              } catch { /* 快照读不到就维持无戳，popup 退回本地基线 */ }
            }
            captureTabId = reviveTabId;
            const id = captureTabId!;
            // 同导航：复活字幕层也要尊重 overlayVisible（独立审查 m3）
            chrome.storage.local.get('tmspeech_prefs').then(r => {
              const prefs = (r['tmspeech_prefs'] as any) || {};
              sendToTab(id, { type: 'OVERLAY_TOGGLE', visible: prefs.overlayVisible !== false });
            });
            // 坑：同 START——复活路径也必须把权威锁态推给（可能新建的）字幕层，
            // 否则重连自愈后新层按未锁定样式绘制且无人纠正。
            chrome.storage.local.get(LOCK_KEY).then(r => {
              sendToTab(id, { type: 'LOCK_TOGGLE', locked: r[LOCK_KEY] === true });
            }).catch(() => {});
            // 状态文案走 STATUS_TEXT 独立通道（见 offscreen.ts sendStatus 注释）：
            // 借 TEXT_CHANGED 会把"正在等待音频"当成一句字幕写进字幕行。
            sendToTab(id, { type: 'STATUS_TEXT', key: 'waiting' });
            chrome.storage.local.get('tmspeech_prefs').then(r => {
              const prefs = (r['tmspeech_prefs'] as any) || {};
              if (prefs.fontSize) sendToTab(id, { type: 'SET_FONT_SIZE', fontSize: prefs.fontSize });
              sendToTab(id, { type: 'SET_PREV_OPTS', showPrev: prefs.showPrev !== false, prevOpacity: prefs.prevOpacity ?? 35 });
            });
            // 坑：startedAt 必须带上（可能为 0）——popup 据此校准计时基准；
            // 且这行要放在回填之后，否则转发的还是 0
            sendToPopup({ type: 'STATUS_CHANGED', status: 'Running', startedAt: sessionStartedAt });
            persistSession();
          }).catch(() => {
            // 标签页已不存在：offscreen 还在空转解码静音，走统一清理把文档整个关掉。
            // 此时本 SW 的 offscreenPort 多半为 null（冷启动），STOP_OFFSCREEN 发不出去，
            // cleanupAll 里无条件执行的 closeDocument 是最后兜底，足以销毁文档终止一切循环。
            console.log('[TM BG] 重连上报的标签页已关闭，清理残留会话');
            cleanupAll();
          });
        }
      }
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[TM BG] offscreen 端口断开, pipelineStatus=', pipelineStatus);
    if (offscreenPort !== port) return;
    offscreenPort = null;
    if (pipelineStatus !== 'Running') return;
    if (Date.now() - lastSelfCloseAt < 2000) {
      // 盲审 severe 1：这次断开是我们自己 closeDocument（START 换配置重建文档）造成的，
      // 绝不能武装"重连超时"定时器 —— 否则 3 秒后会把刚起来的新会话整场拆掉。
      console.log('[TM BG] 断开来自我们自己的文档重建，不武装重连定时器');
      return;
    }
    console.log('[TM BG] offscreen 断开，等待重连...');
    // 坑：只判 pipelineStatus==='Running' 不够——"Running 状态下重启会话"（START 里
    // 因配置变化而 closeDocument 重建）会在旧端口断开处武装本定时器，3 秒后把刚起来的
    // 新会话按"后台页面意外关闭"清掉：表现为字幕突然消失 + 弹一条莫名其妙的错误。
    // 用会话代次快照兜住：期间只要发生过 START/STOP（sessionEpoch 前进），本定时器即已过期。
    const epochAtDisconnect = sessionEpoch;
    reconnectTimer = setTimeout(() => {
      if (pipelineStatus !== 'Running') return;
      if (epochAtDisconnect !== sessionEpoch) {
        console.log('[TM BG] 重连超时定时器已过期（期间发生过 Start/Stop），忽略');
        return;
      }
      console.log('[TM BG] 重连超时，清理');
      // 坑（盲审 S2，major）：这条路径以前**手写收尾**，漏了 cleanupAll 的那些步骤 ——
      // 悬浮字幕窗收不到任何终态/提示也没被关（停在"运行中"外观：最后一句字幕 + 可点的停止
      // 按钮，用户以为还在识别），mic 会话更糟：没人发 MIC_CAPTURE_STOP，浮窗继续采集、
      // 系统录音指示灯常亮（MIC_CHUNK 因 offscreenPort 为空被丢弃）。
      // 直接复用 cleanupAll：它已经把这些都做对了（含保留浮窗时的 MIC_CAPTURE_STOP 与终态补发）。
      logLine('error', 'app', '后台页面意外关闭，识别已停止');
      cleanupAll();
      return;
    }, 3000);
  });

  checkPendingInit(port);
});

async function checkPendingInit(port: chrome.runtime.Port) {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  if (stored[PENDING_KEY]) {
    port.postMessage(stored[PENDING_KEY]);
    chrome.storage.session.remove(PENDING_KEY);
  }
}

// offscreen 模型就绪后回调：此刻才签发 capture streamId 并立即投递，把
// "签发→消费"的时间窗压缩到毫秒级，根治 streamId 过期导致的 "Error starting tab capture"。
// 仅 tab 模式有这个往返（system 模式由 offscreen 内 getDisplayMedia 直接开流，无 streamId）。
async function handleRequestStream(tabId: number | null) {
  try {
    // 坑：本 SW 可能刚被这条消息唤醒、内存态全空，所以优先用 offscreen 随消息带来的
    // tabId（它记的是 INIT 时的目标页），绝不能依赖 captureTabId/pipelineStatus 做守卫。
    const target = tabId ?? captureTabId;
    if (!target) throw new Error('没有可捕获的目标标签页');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target });
    offscreenPort?.postMessage({ type: 'STREAM_READY', streamId, source: 'tab' });
  } catch (e: any) {
    console.log('[TM BG] 获取音频流失败:', e?.message || e);
    // 盲审 S1（major）：这三条宿主级 ERROR 以前只 sendToPopup —— 而点开始后 popup 必然已关闭，
    // 于是"所有日志"里恰好没有原因。补齐进日志缓冲。
    logLine('error', 'app', `获取音频流失败: ${e?.message || e}`);
    sendToPopup({ type: 'ERROR', message: `获取音频流失败: ${e?.message || e}` });
    cleanupAll();
  }
}

async function isContentScriptInjected(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return true;
  } catch { return false; }
}

function hideOverlay(tabId: number | null) {
  if (tabId) sendToTab(tabId, { type: 'OVERLAY_TOGGLE', visible: false });
}

function cleanupAll() {
  // 坑：任何清理都必须作废在途的 START 异步体——否则 STOP 后残余启动代码会重建
  // offscreen 文档并恢复采集（幽灵会话）。自增代次后，START 各恢复点的比对全部失配。
  sessionEpoch++;
  sessionStartedAt = 0; // 会话终结即清开始戳（epoch 失配/STOP/错误清理统一走这里）
  bgLevels = []; // 波形快照随之清空：停止后的面板不再显示已结束会话的电平残留
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // mic 的采集端在悬浮窗里：下面"保留浮窗看错误"的分支必须先知道本场是不是 mic ——
  // sessionSource 紧接着就会被重置成 'tab'（复核 P0-2 时正是这里踩了：判断写在重置之后，
  // 于是麦克风永不停止采集，tsc 还会报"两个类型没有交集"）。
  const wasMic = sessionSource === 'mic';
  sessionSource = 'tab';
  const tabId = captureTabId;
  pipelineStatus = 'Stopped';
  hideOverlay(tabId);
  chrome.storage.session.remove(PENDING_KEY);
  // 停止即回收（2026-09-22 用户决策，恢复旧行为）：会话结束**无条件**销毁 offscreen 文档。
  // 模型（__recognizer + WASM 堆，full 版 400MB+）活在文档里，只有销毁文档才能把内存
  // 真正还回去。曾试过"常驻复用"换下次秒开，因停止后内存一直被占，已按用户要求回退。
  // 代价：下次"开始"要重新从 IndexedDB 读模型 + WASM 解析（数秒 CPU/内存峰值，即
  // "启动时主页面卡"的来源）。STOP_OFFSCREEN 仍先发（端口活着的话）：让 offscreen 先
  // 停音频、清 60ms flush 定时器、pipeline.stop()；随后 closeDocument 无条件兜底——
  // 冷启动 SW 场景端口不可达，销毁文档是停止必然生效的唯一硬保证。
  if (offscreenPort) {
    try { offscreenPort.postMessage({ type: 'STOP_OFFSCREEN' }); } catch {}
  }
  chrome.offscreen.closeDocument().catch(() => {});
  lastSelfCloseAt = Date.now();   // 标记"这次断开是我们自己造成的"（见字段说明）
  chrome.storage.session.remove(OFFSCREEN_CFG_KEY).catch(() => {});
  offscreenCfgKeyInMem = null;
  // offscreenPort 不在这里手动置空：closeDocument 触发的 port.onDisconnect 会负责清它，
  // 手动提前置空反而可能与"STOP 消息还在路上"的窗口竞争。
  captureTabId = null;
  // 重试一次，防止 content script 未就绪
  if (tabId) setTimeout(() => hideOverlay(tabId), 300);
  // 坑：closeDocument 销毁 offscreen 文档的同时会截断它经 port 回传状态的通道，
  // 终态必须由 bg 在这里显式补发，否则已经打开的 popup 会永远停在 Running 界面。
  // （手动停止时 popup 本地已自行置为 Stopped，重复收到同一终态是幂等的。）
  persistSession();
  // 生命周期绑定（悬浮窗随会话）：会话停止即关闭悬浮窗——system 模式下它是唯一显示端，
  // 会话结束没有继续存在的意义。closeFloating 会触发 windows.onRemoved，彼时
  // pipelineStatus 已是 Stopped，onRemoved 里的"关窗即停止"守卫自然跳过，不会二次清理。
  // 例外：刚发了错误提示时留着它，让用户读得到原因（否则"闪一下就消失"）。用户点提示即关窗
  // （见 overlay 的 onNoticeDismiss）。
  if (keepFloatingForNotice) {
    keepFloatingForNotice = false;
    // 复核 P0-2（真 bug）：留着浮窗时**必须显式停 mic** —— 浮窗就是麦克风的采集端，
    // 会话已经 Stopped 却没人发 MIC_CAPTURE_STOP，麦克风会一直热着（指示灯常亮），
    // 而且下一场 system/helper 会话复用同一窗口时，旧 mic 的 MIC_CHUNK 会被喂进新管道
    // （系统音频里混进麦克风声音）。tab 会话没有浮窗，但 pendingNotice 也要清掉，
    // 否则以后"不走 START 就开浮窗"的路径会把上一条旧错误回播出去（复核 P2-9）。
    pendingNotice = null;
    if (wasMic) sendToFloating({ type: 'MIC_CAPTURE_STOP' });
  } else {
    closeFloating();
  }
  // 独立审查 B2-B：保留浮窗时也必须把终态推给它 —— 否则被留下的窗口仍显示"运行中"的
  // 停止按钮与旧加载文案（它会跨会话复用），用户点一下才触发第二次 cleanupAll 关掉。
  sendToFloating({ type: 'STATUS_CHANGED', status: 'Stopped' });
  sendToPopup({ type: 'STATUS_CHANGED', status: 'Stopped' });
}

// 坑：MV3 的事件监听器必须在模块顶层同步注册，放进异步回调里注册会错过事件。
// 这个监听器是"关标签页自动停止"的唯一触发入口：此前项目没有任何代码感知标签页关闭，
// 而 offscreen 内的 AudioWorklet + 60ms 自递归 flush 定时器是外部信号打不断的永动循环，
// 唯一的打断方式就是这里触发的 cleanupAll()。
chrome.tabs.onRemoved.addListener((closedTabId) => {
  handleCapturedTabClosed(closedTabId);
});

async function handleCapturedTabClosed(closedTabId: number) {
  let tabId = captureTabId;
  let status = pipelineStatus;
  // 坑：若本事件唤醒的是一个冷启动的 SW，内存全局变量全是初始值（null/'Stopped'），
  // 不可信；回退读 storage.session 里持久化的会话快照再判断。
  if (tabId == null || status !== 'Running') {
    try {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      const sess = stored[SESSION_KEY] as { tabId: number; status: string; startedAt?: number } | undefined;
      if (sess) {
        tabId = sess.tabId; status = sess.status;
        // 坑：冷启动内存 sessionStartedAt=0，从快照回填，保证后续 GET_STATUS/快照
        // 续写的计时基准不丢（0 视为无戳，不覆盖语义）
        if (sess.startedAt && !sessionStartedAt) sessionStartedAt = sess.startedAt;
      }
    } catch { /* storage 异常时退化为纯内存判断 */ }
  }
  // 关闭的是非捕获标签页 → no-op。整窗关闭/浏览器退出时每个标签页都会触发本事件，
  // 第一轮清理后状态已是 Stopped，后续触发全部命中这里的早退，天然幂等。
  if (status !== 'Running' || closedTabId !== tabId) return;
  // 把恢复出的会话先同步回内存，再走与手动停止完全相同的统一清理路径。
  captureTabId = tabId!;
  pipelineStatus = status;
  console.log('[TM BG] 被捕获标签页已关闭 (tabId=', closedTabId, ')，自动停止');
  cleanupAll();
}

let translateTestSeq = 0;
const translateTestResolvers: Record<number, (r: any) => void> = {};

// 识别会话启动体：popup 的 START_RECOGNITION 消息进入。respond 统一收口
// sendResponse（异步完成时经闭包回调确认通道）。
async function startRecognition(msg: any, respond: () => void) {
  // 本次启动的会话代次：异步体在每个 await 恢复点核对，期间发生过任何清理
  // （STOP/关标签页/错误清理）代次都会前进，此时必须立即中止后续步骤，
  // 否则就是"用户已停止但采集继续"的幽灵会话。
  // 提到 try 外：外层 catch 也要核对代次（见 catch 内注释）。
  const myEpoch = ++sessionEpoch;
  const stale = () => myEpoch !== sessionEpoch;
  try {
    // 坑：上一会话可能刚被"关标签页自动停止"清理，其 closeDocument 是异步生效的；
    // 旧文档还没销毁完就创建新文档、申请新 capture 流会撞上释放竞态，典型表现就是
    // offscreen 里 getUserMedia 报 "Error starting tab capture"。
    // 同时清掉可能遗留的重连超时定时器，防止它把刚启动的新会话误判成断连而清场。
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // 坑：PENDING_KEY 要在这里就先清掉。下面复用残留文档时会有"等端口重连"的窗口，
    // 期间端口一连上就会触发 checkPendingInit，把上一轮遗留的过期 INIT 投递出去
    // （幽灵启动：参数是旧会话的，pipeline 却为新会话跑起来）。先清后等。
    chrome.storage.session.remove(PENDING_KEY);

    // 先取本次会话的识别配置。它决定能否复用残留的 offscreen 文档：语言 / 标点 / 端点阈值 /
    // 热词都在 createOnlineRecognizer 时一次性烘焙进 WASM 配置，配置一致才能复用；
    // 不一致必须重建文档，否则用户改了热词或端点阈值会"看起来没生效"。
    const lang = (await chrome.storage.local.get('tmspeech_lang'))['tmspeech_lang'] || 'zh_CN';
    const punctPref = (await chrome.storage.local.get('tmspeech_use_punct'))['tmspeech_use_punct'];
    const prefs = ((await chrome.storage.local.get('tmspeech_prefs'))['tmspeech_prefs'] as any) || {};
    const hotwords = (await chrome.storage.local.get('tmspeech_hotwords'))['tmspeech_hotwords'];
    if (stale()) { respond(); return; }
    const usePunct = punctPref !== false;
    const sessionHotwords = Array.isArray(hotwords) && hotwords.length ? hotwords : null;
    const cfgKey = JSON.stringify([
      lang, usePunct,
      prefs.endpointRule1 ?? null, prefs.endpointRule2 ?? null, prefs.endpointRule3 ?? null,
      sessionHotwords,
    ]);

    // 文档复用判定：文档在 + 配置未变 → 复用。正常流程下停止时文档已销毁（见 cleanupAll），
    // hasDocument() 恒为 false，每次"开始"都会重新载模型（数秒 CPU/内存峰值，用户已接受
    // 该代价换停止后内存归还）；本分支只覆盖崩溃残留等异常场景——文档还活着且配置没变时
    // 直接复用，省一次无意义的重建。
    let reuseDoc = false;
    if (await chrome.offscreen.hasDocument()) {
      const storedKey = (await chrome.storage.session.get(OFFSCREEN_CFG_KEY))[OFFSCREEN_CFG_KEY];
      reuseDoc = storedKey === cfgKey;
    }
    if (stale()) { respond(); return; }
    if (reuseDoc && !offscreenPort) {
      // 端口可能在 SW 冷启动或停机后断开：offscreen 侧有 1s 重连策略，等它连上（上限 1.5s）
      const portDeadline = Date.now() + 1500;
      while (!offscreenPort && Date.now() < portDeadline) {
        await new Promise(r => setTimeout(r, 50));
        if (stale()) { respond(); return; }
      }
      if (!offscreenPort) reuseDoc = false; // 连不上 → 降级为重建，避免 INIT 投递不进去的静默失败
    }
    if (!reuseDoc) {
      await chrome.offscreen.closeDocument().catch(() => {});
      if (stale()) { respond(); return; }
      // closeDocument 会触发 onDisconnect 置空 offscreenPort
      // 等旧文档真正消失（上限 1.5s）再继续，给 Chrome 时间异步释放旧 capture 流
      const releaseDeadline = Date.now() + 1500;
      while (await chrome.offscreen.hasDocument()) {
        if (Date.now() > releaseDeadline) break; // 极端情况下放行，让后续错误正常暴露
        await new Promise(r => setTimeout(r, 50));
        if (stale()) { respond(); return; }
      }
      // 记住这套配置：下次 START 配置一致就直接复用文档，跳过整段重建
      chrome.storage.session.set({ [OFFSCREEN_CFG_KEY]: cfgKey }).catch(() => {});
    }
    offscreenCfgKeyInMem = cfgKey;
    if (stale()) { respond(); return; }

    pipelineStatus = 'Running';
    // 音频来源：system/mic 模式无目标标签页（captureTabId 恒 null），跳过字幕层注入等 tab 逻辑
    const source: 'tab' | 'system' | 'mic' | 'helper' =
      msg.source === 'system' || msg.source === 'mic' || msg.source === 'helper' ? msg.source : 'tab';
    sessionSource = source;
    captureTabId = source === 'tab' ? (msg.tabId || null) : null;
    sessionStartedAt = Date.now(); // START 成功即盖会话开始戳，计时基准唯一事实源
    persistSession();
    // 独立审查 B2-A：新会话开始 → 上一场留下的错误提示必须撤掉。浮窗是跨会话复用的
    // （openFloating 命中已有窗口就复用），否则用户会对着一条已经不成立的错误等到开口说话。
    clearFloatingNotice();
    // 用户确认：音源为系统/麦克风 → 自动开悬浮字幕窗（无标签页可注入，悬浮窗是唯一显示端）；
    // 音源为标签页 → 关闭悬浮窗，字幕回到浏览器内叠层。失败仅记日志，不阻断识别启动。
    if (source !== 'tab') {
      // 坑（跨仓审查 P1，回归）：**麦克风的采集端就住在悬浮字幕窗里** —— Chrome 禁止 offscreen
      // 调 getUserMedia，所以 mic 的 PCM 只能由浮窗里的 floating.ts 采集后回传。于是这个窗口
      // 对 mic 是"采集设备"而不仅是"显示端"：如果因为用户取消了「显示字幕」就不开窗，
      // 会话会显示「识别中」却永远没有音频、也没有任何报错（本仓最忌讳的幽灵会话）。
      // system/helper 的音频在 offscreen 里采，浮窗只是显示端，才受这个勾选影响。
      if (source === 'mic' || msg.overlayVisible !== false) {
        openFloating().catch((e) => console.log('[TM BG] 自动打开悬浮字幕窗失败:', e));
      } else {
        closeFloating();
      }
      // mic：悬浮窗已在（二次启动复用旧窗，不会有新的 onConnect）→ 直接下采集令；
      // 新开窗口则等 onConnect 补发。floating 侧对重复指令幂等，双发无害。
      if (source === 'mic' && floatingPort) sendToFloating({ type: 'MIC_CAPTURE_START' });
    } else {
      closeFloating();
    }
    if (captureTabId && msg.overlayVisible) {
      const alreadyInjected = await isContentScriptInjected(captureTabId);
      if (stale()) { respond(); return; }
      if (!alreadyInjected) {
        await chrome.scripting.executeScript({
          target: { tabId: captureTabId },
          files: ['content.js'],
        }).catch(() => {});
        if (stale()) { respond(); return; }
      }
      sendToTab(captureTabId, { type: 'OVERLAY_TOGGLE', visible: true });
      // 坑：新建字幕层初始按未锁定样式绘制，content 自身异步读 storage 存在窗口期；
      // 若权威锁态是"已锁"而无人纠正，就出现用户报告的"锁定后仍有半透明背景/毛玻璃"。
      // 这里读唯一事实源立即补发 LOCK_TOGGLE，让新层马上收敛到权威锁态。
      chrome.storage.local.get(LOCK_KEY).then(r => {
        // fire-and-forget 回调同样要核对会话代次，防止停止后残留回调打扰新会话。
        if (stale() || !captureTabId) return;
        sendToTab(captureTabId!, { type: 'LOCK_TOGGLE', locked: r[LOCK_KEY] === true });
      }).catch(() => {});
      chrome.storage.local.get('tmspeech_prefs').then(r => {
        // 坑：此回调是 fire-and-forget，恢复执行时不做代次核对的话，
        // 停止后残留的回调会把 prefs 发到新会话（或已停止会话）的标签页上。
        if (stale() || !captureTabId) return;
        const prefs = (r['tmspeech_prefs'] as any) || {};
        if (prefs.fontSize) sendToTab(captureTabId!, { type: 'SET_FONT_SIZE', fontSize: prefs.fontSize });
        sendToTab(captureTabId!, { type: 'SET_PREV_OPTS', showPrev: prefs.showPrev !== false, prevOpacity: prefs.prevOpacity ?? 35 });
      });
    }

    // 坑：不要在这里预先签发 capture streamId！它的有效期很短，而 offscreen 冷启动
    // 加载 WASM 模型可能耗时远超这个窗口，等模型就绪再用早已过期的 id 去
    // getUserMedia，就会报 "Error starting tab capture"。改为由 offscreen 在模型
    // 就绪后发 REQUEST_STREAM，这里即时签发、立即消费。
    await ensureOffscreen();
    if (stale()) { respond(); return; }
    // 坑：文档建了但自身脚本起不来（构建缺文件/初始化即崩）时端口永远连不上，INIT
    // 躺在 PENDING_KEY 里无人投递——会话停在 Running、无字幕、无报错、只有计时在走，
    // 用户完全无从排查。等端口有限时长，超时按启动失败收敛（ERROR + cleanupAll）。
    if (!offscreenPort) {
      const readyDeadline = Date.now() + 10000;
      while (!offscreenPort && Date.now() < readyDeadline) {
        await new Promise(r => setTimeout(r, 100));
        if (stale()) { respond(); return; }
      }
      if (!offscreenPort) throw new Error('offscreen 文档未能就绪（10s 超时），请重载扩展后重试');
    }

    // 配置在上面已读过（复用判定要用），这里只组装消息，不再重复读 storage
    const initMsg: any = { type: 'INIT_OFFSCREEN', tabId: msg.tabId, source, lang, usePunct };
    // 桌面助手音源：面板探测/配对后拿到 {port, token}，随 START 一起上来，这里转交 offscreen
    // （offscreen 没有 storage 访问权，也无法自己探测——探测/配对全在面板（可见页）完成）。
    if (source === 'helper') {
      initMsg.helperPort = msg.helperPort;
      initMsg.helperToken = msg.helperToken;
    }
    if (prefs.endpointRule1) initMsg.endpointRule1 = prefs.endpointRule1;
    if (prefs.endpointRule2) initMsg.endpointRule2 = prefs.endpointRule2;
    if (prefs.endpointRule3) initMsg.endpointRule3 = prefs.endpointRule3;
    // 实时翻译开关/方向随 INIT 下发（offscreen 无 chrome.storage 访问权，由 bg 转发）
    initMsg.translationEnabled = prefs.translationEnabled === true;
    const tdir = prefs.translationDirection;
    initMsg.translationDirection = tdir === 'zh-en' || tdir === 'en-zh' ? tdir : 'auto';
    initMsg.translationTiming = prefs.translationTiming === 'final' ? 'final' : 'stream';
    // 翻译来源 + OpenAI 兼容 API 配置（地址/模型/Key、自定义 Headers 与请求体字段、推理控制）
    // 一起随 INIT 下发；全部来自持久化偏好，缺省走内置离线模型。
    initMsg.translationApi = apiSettingsFromPrefs(prefs);
    // 热词随 INIT 下发：offscreen 建 recognizer 时一次性烘焙进配置
    if (sessionHotwords) initMsg.hotwords = sessionHotwords;
    if (offscreenPort) {
      offscreenPort.postMessage(initMsg);
    } else {
      await chrome.storage.session.set({ [PENDING_KEY]: initMsg });
      if (stale()) {
        // 坑：pending 快照是给"下一个连上的 offscreen 文档"的投递队列——START 已被
        // 作废时必须删掉它，否则下次无关的端口连接会把过期 INIT 投递出去（幽灵启动）。
        chrome.storage.session.remove(PENDING_KEY).catch(() => {});
        respond();
        return;
      }
    }

    respond();
  } catch (e) {
    // 坑：catch 必须先核对代次。异常若来自"已被清理/被新 START 作废"的旧启动体
    // （epoch 已前进），这里的 cleanupAll() 会把**新会话**整个拆掉，再弹一条与用户
    // 操作无关的"启动失败"——旧实现正是 P1-5 双创建异常的放大器。
    if (stale()) { respond(); return; }
    logLine('error', 'app', `启动失败: ${e}`);   // 盲审 S1：popup 已关时这条错误只有日志能留住
    sendToPopup({ type: 'ERROR', message: `启动失败: ${e}` });
    cleanupAll();
    respond();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SYNC_API_ORIGIN') {
    // 面板每次保存 API 设置都同步一次（改地址就替换规则；清空地址就撤掉规则）
    void syncApiOriginRule(String(msg.base || ''));
    return;
  }
  if (msg.type === 'GET_LOGS') {
    sendResponse({ entries: bgLogs.list() });
    return;
  }
  if (msg.type === 'CLEAR_LOGS') {
    bgLogs.clear();
    flushLogs();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'LOG') {
    // 面板/浮窗把各自那一条日志送来汇合（它们自己没有历史）。**沿用它的 id/t**：
    // 面板本地已经记过一份，回播时带同一个 id 才能在日志窗里去重（独立审查 B1）。
    logLine(msg.level || 'info', msg.source || 'panel', msg.message || '', { t: msg.t, id: msg.id });
    return;
  }
  if (msg.type === 'TRANSLATE_TEST') {
    // 面板"测试翻译"：转发给 offscreen（无 storage 权限，纯中继），用 id 关联应答。
    // 没在识别时 offscreen 文档不存在（offscreenPort 为空），先建文档等端口连上再发。
    (async () => {
      if (!offscreenPort) {
        await ensureOffscreen().catch(() => {});
        const deadline = Date.now() + 8000;
        while (!offscreenPort && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
      if (!offscreenPort) { sendResponse({ ok: false, error: 'offscreen-not-ready' }); return; }
      const id = ++translateTestSeq;
      // 一起把「翻译来源 + API 配置」送过去：测试翻译是"还没开始识别也想试模型"的场景，
      // 那个 offscreen 文档没跑过 INIT，不带配置就只能按内置模型测（用户实测报 no-model）。
      const prefsR = await chrome.storage.local.get('tmspeech_prefs').catch(() => ({} as any));
      const api = msg.api || apiSettingsFromPrefs((prefsR as any)?.tmspeech_prefs || {});
      // 测试前再同步一次规则：用户可能刚改完地址就点测试（避免"先测后生效"的假失败）
      void syncApiOriginRule(api.base);
      translateTestResolvers[id] = sendResponse;
      offscreenPort.postMessage({ type: 'TRANSLATE_TEST', id, text: msg.text, direction: msg.direction, api });
    })();
    return true;
  }

  if (msg.type === 'TRANSLATE_TEST_CANCEL') {
    // 面板"测试翻译"的取消：转发给 offscreen 让它 terminate 临时 worker 并结束挂起应答。
    // 坑：此前 bg 没有这个分支，消息被静默丢弃——"取消"按钮是假的，测试 worker 会把
    // 216MB 翻译模型加载完才收尾。端口不活时无事可做（SW 重启后旧应答通道已失效）。
    if (offscreenPort) {
      try { offscreenPort.postMessage({ type: 'TRANSLATE_TEST_CANCEL' }); } catch {}
    }
  }

  if (msg.type === 'START_RECOGNITION') {
    // 启动体已抽成独立函数（startRecognition）：tab/system/mic 三态共用同一套
    // 竞态防护（代次核对、旧文档释放等待、pending 投递队列），此处只做通道收口。
    startRecognition(msg, () => sendResponse({}));
    return true;
  }

  if (msg.type === 'INJECT_TEST') {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (tabId) {
        const already = await isContentScriptInjected(tabId);
        if (!already) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js'],
          }).catch(() => {});
        }
        sendToTab(tabId, { type: 'TEST_SHOW' });
      }
    })();
  }

  if (msg.type === 'GET_STATUS') {
    // 坑：locked 不能只读内存缓存——SW 重启后 overlayLocked 归零，会向 popup 谎报
    // locked=false 而页面字幕层实际仍锁定。改为异步回源 storage（唯一事实源）。
    // 处理器因此异步化：必须保持 return true，否则 sendResponse 通道在监听器返回后
    // 即关闭，popup 永远收不到响应（其余同步分支不受影响，各自显式 sendResponse）。
    // 坑：locked 与 startedAt 分属 storage.local / storage.session，Promise.all 双读合并
    Promise.all([
      chrome.storage.local.get(LOCK_KEY),
      chrome.storage.session.get(SESSION_KEY),
    ]).then(([lockR, snapR]) => {
      const sess = snapR[SESSION_KEY] as { tabId: number; status: string; startedAt?: number } | undefined;
      // 坑：SW 冷启动后内存 pipelineStatus/sessionStartedAt 都是初值（'Stopped'/0），而
      // offscreen 文档独立于 SW 存活，会话可能仍在跑。快照只在 Running 时写入、停止时删除，
      // 所以"内存说停了但对快照说在跑"只可能是 SW 刚被唤醒——此时以快照为准，
      // 否则 popup 会在冷启动窗口期把正在跑的会话显示成已停止、停止键变灰。
      const status = pipelineStatus === 'Running' ? pipelineStatus : (sess?.status === 'Running' ? 'Running' : pipelineStatus);
      const startedAt = (status === 'Running' && sess?.startedAt) || sessionStartedAt || 0;
      // 回填内存，后续同步判断（如 onRemoved 守卫）不必再等一次异步读
      if (status !== pipelineStatus) { pipelineStatus = status; if (!sessionStartedAt && startedAt) sessionStartedAt = startedAt; }
      sendResponse({ status, locked: lockR[LOCK_KEY] === true, startedAt, levels: bgLevels.slice() });
    }).catch(() => {
      // storage 异常时退化为内存缓存值，至少不阻塞 popup 初始化。
      sendResponse({ status: pipelineStatus, locked: overlayLocked, startedAt: sessionStartedAt, levels: bgLevels.slice() });
    });
    return true;
  }

  if (msg.type === 'OVERLAY_TOGGLE') {
    if (captureTabId) {
      sendToTab(captureTabId, { type: 'OVERLAY_TOGGLE', visible: msg.visible });
    } else {
      // 非 tab 音源（系统音频/麦克风/桌面助手）没有可注入的叠层，唯一显示端就是悬浮窗：
      // 这个勾选框必须真的能开关它，否则就是"点了没反应"（独立审查 M1）。
      // **例外：mic 会话不能关**（复核 P2-8）—— 浮窗就是麦克风的采集端，关窗会被
      // handleFloatingClosed 当成"用户关窗即停"处理（静默结束整场识别）。mic 想让字幕
      // 消失目前只能停会话，这一点写进面板的音源提示里。
      if (msg.visible) openFloating().catch((e) => console.log('[TM BG] 打开悬浮字幕窗失败:', e));
      else if (sessionSource !== 'mic') closeFloating();
    }
  }

  if (msg.type === 'LOCK_TOGGLE') {
    overlayLocked = msg.locked;
    // 坑：popup 发起的锁定此前从不写 storage（只有字幕层按钮的 toggleLock 会写），
    // 三端记账由此发散：popup 锁定后 SW 重启/字幕层重建时读到的仍是旧值。
    // storage.local['tmspeech_locked'] 是唯一事实源，转发的同时必须持久化。
    chrome.storage.local.set({ [LOCK_KEY]: msg.locked === true }).catch(() => {});
    sendToDisplays({ type: 'LOCK_TOGGLE', locked: msg.locked });
  }

  if (msg.type === 'SET_FONT_SIZE') {
    sendToDisplays({ type: 'SET_FONT_SIZE', fontSize: msg.fontSize });
  }

  if (msg.type === 'SET_PREV_OPTS') {
    sendToDisplays({ type: 'SET_PREV_OPTS', showPrev: msg.showPrev, prevOpacity: msg.prevOpacity });
  }

  if (msg.type === 'SET_ENDPOINT') {
    if (offscreenPort) offscreenPort.postMessage({ type: 'SET_ENDPOINT', rule1: msg.rule1, rule2: msg.rule2, rule3: msg.rule3 });
  }

  if (msg.type === 'LOCK_CHANGED_FROM_CONTENT') {
    overlayLocked = msg.locked;
    sendToPopup({ type: 'LOCK_CHANGED', locked: msg.locked });
  }

  if (msg.type === 'STOP_RECOGNITION') {
    cleanupAll();
  }

  if (msg.type === 'SET_PUNCT') {
    if (offscreenPort) offscreenPort.postMessage({ type: 'SET_PUNCT', enabled: msg.enabled });
  }

  if (msg.type === 'TRANSLATION_MODEL_IMPORTED') {
    // 面板刚导入/更新翻译模型：转发给 offscreen 解除"缺模型"记忆，
    // 运行中的会话无需重启即可开始出译文（offscreen 未建时无需转发——下次 INIT 自会生效）。
    if (offscreenPort) offscreenPort.postMessage({ type: 'TRANSLATION_MODEL_IMPORTED' });
  }

  if (msg.type === 'TRANSLATION_SETTINGS_LIVE') {
    // 会话运行中改了实时翻译开关/方向/时机：转发给 offscreen 当场生效。
    // 不转发的话，运行中改这些设置是完全静默无效的（只有下次开始才生效），
    // 用户会以为"翻译开关坏了"。
    if (offscreenPort) offscreenPort.postMessage({
      type: 'TRANSLATION_SETTINGS_LIVE',
      enabled: msg.enabled,
      direction: msg.direction,
      timing: msg.timing,
      api: msg.api,
    });
  }

  if (msg.type === 'RESET_OVERLAY_POSITION') {
    sendToDisplays({ type: 'RESET_OVERLAY_POSITION' });
  }

  if (msg.type === 'FORWARD_TO_CONTENT') {
    // popup 的偏好修改（PREFS_PATCH 等）实时同步到页内叠层与悬浮窗
    sendToDisplays(msg.payload);
  }

  if (msg.type === 'FORWARD_TO_POPUP') {
    sendToPopup(msg.payload);
    if (msg.payload?.type === 'STATUS_CHANGED') { pipelineStatus = msg.payload.status; persistSession(); }
  }

  // —— 悬浮字幕窗：开合统一走 openFloating()/closeFloating()，START 时按音源自动触发 ——
  if (msg.type === 'OPEN_FLOATING') {
    openFloating().catch((e) => console.log('[TM BG] 打开悬浮字幕窗失败:', e));
  }

  if (msg.type === 'CLOSE_FLOATING') {
    closeFloating();
  }
});

// 悬浮窗被用户关闭：system/mic 模式下它是唯一显示端（mic 模式还兼任采集端）——
// 关闭即视为结束会话，触发统一清理（关 offscreen、停采集）；tab 模式走不到这里。
chrome.windows.onRemoved.addListener((closedWinId) => {
  void handleFloatingClosed(closedWinId);
});

async function handleFloatingClosed(closedWinId: number) {
  // 坑：本事件也会唤醒冷启动的 SW，那时 floatingWinId/sessionSource/pipelineStatus
  // 全是初值（null/'tab'/'Stopped'），直接比对会把"关悬浮窗"当成无关窗口而漏掉清理，
  // 于是 offscreen 继续空转采集（system/mic 会话已没有显示端）。与 handleCapturedTabClosed
  // 同构：内存值不可信时回源 storage.session 的会话快照再判断。
  let winId = floatingWinId;
  let source = sessionSource;
  let status = pipelineStatus;
  // 内存值可能不可信（SW 冷启动后全是初值）：除了会话快照，窗口 id 本身也从
  // storage.session 回源，否则"用户关的到底是不是悬浮窗"根本判不出来。
  // 内存已经明确知道有浮窗且在跑会话时才是快路径，可以不读。
  if (winId == null || status !== 'Running') {
    try {
      const stored = await chrome.storage.session.get([SESSION_KEY, FLOATING_WIN_KEY]);
      const storedWinId = stored[FLOATING_WIN_KEY];
      if (typeof storedWinId === 'number') winId = storedWinId;
      const sess = stored[SESSION_KEY] as { source?: string; status?: string } | undefined;
      if (sess) {
        source = (sess.source as any) || source;
        status = sess.status || status;
      }
    } catch { /* storage 异常时退化为纯内存判断 */ }
  }
  if (closedWinId !== winId) return;
  floatingWinId = null;
  floatingPort = null;
  persistFloatingWin();
  if (source !== 'tab' && status === 'Running') {
    console.log('[TM BG] 悬浮字幕窗已关闭，自动停止识别');
    cleanupAll();
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== captureTabId || changeInfo.status !== 'complete' || pipelineStatus !== 'Running') return;
  setTimeout(async () => {
    // 坑：executeScript 每次都会注入一份全新的 content.js 副本，而每份副本都会创建
    // 自己的字幕层——不加探测就直接注入，导航几次就叠几层悬浮字幕。先 PING 再注入。
    const already = await isContentScriptInjected(tabId);
    if (!already) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
    }
    // 坑（独立审查 m3）：以前无条件 visible:true —— 用户"隐藏字幕"的选择会在页面导航后
    // 被静默撤销，而 storage 里的 overlayVisible 仍是 false（勾选态与实际显示分叉）。
    chrome.storage.local.get('tmspeech_prefs').then(r => {
      const prefs = (r['tmspeech_prefs'] as any) || {};
      sendToTab(tabId, { type: 'OVERLAY_TOGGLE', visible: prefs.overlayVisible !== false });
      if (prefs.fontSize) sendToTab(tabId, { type: 'SET_FONT_SIZE', fontSize: prefs.fontSize });
    });
    if (offscreenPort) offscreenPort.postMessage({ type: 'RESEND_CURRENT_TEXT' });
  }, 300);
});
