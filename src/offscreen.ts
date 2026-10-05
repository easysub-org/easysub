// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// Offscreen 文档（MV3 扩展宿主）：**只做宿主接线**，识别/标点/翻译/采集的全部逻辑
// 在 asr-engine.ts 里，与纯 Web 版共用同一份实现。
//
// 本文件负责三件事：
//   ① 与 background 建立长连接，把引擎的出站消息按既有 FW_CT / FW_POP 协议转发出去；
//   ② 把入站消息路由进引擎（INIT_OFFSCREEN / STOP_OFFSCREEN / MIC_CHUNK / ...）；
//   ③ 端口断开后重连（SW 被回收是常态）。
//
// 坑：**引擎实例必须跨端口重连存活**。MV3 的 SW 空闲被杀会断开端口，offscreen 侧的
// 重连策略是重连后发一条 RECONNECT 让 background 自愈会话状态——而那条消息里的
// tabId/streamId/source 全来自引擎的会话状态。若在重连时新建引擎，这些状态归零，
// background 会收到 source:'tab' + tabId:null 的 RECONNECT，system/mic 会话被
// 误判为"标签页已关闭"而整个清理掉（画面无字幕、麦克风灯灭，且没有任何提示）。
// 所以：引擎建一次，sink 通过可变引用取"当前端口"。
import { AsrEngine } from './asr-engine';
import { HelperSource, isHelperSilentCode } from './helper';
import { tSync } from './i18n';

let port: chrome.runtime.Port;
//: 会话代次：INIT/STOP 都会 +1。用来让"还在飞的 engine.init() 回调"作废 ——
//: 用户可能在 init 期间就点了停止，那时再把 WS 接上只会留一条没人读的连接。
let sessionGeneration = 0;

const engine = new AsrEngine({
  resolveUrl: (p) => chrome.runtime.getURL(p),
  // pushMs 缺省 0 = pull 模式（主线程 60ms flush）。扩展侧必须保持 pull：
  // offscreen 文档不受标签页节流影响，而"发 flush → 收回包"的因果链正是延迟指示的
  // 测量口径，改成 push 会让回包与 flush 不再对应、延迟数值系统性失真。
  sink: {
    log(message: string) {
      console.log('[易字幕 Offscreen]', message);
      try { port.postMessage({ type: 'FW_POP', payload: { type: 'LOG', message } }); } catch {}
    },
    toDisplay(payload: any) {
      try { port.postMessage({ type: 'FW_CT', payload }); } catch {}
    },
    toPanel(payload: any) {
      try { port.postMessage({ type: 'FW_POP', payload }); } catch {}
    },
    requestStop() {
      try { port.postMessage({ type: 'FW_STOP', payload: {} }); } catch {}
    },
  },
});

// 坑：文档一建就开始把 IndexedDB 里的模型读成 blob URL 并注入三个 wasm 脚本——
// 这是旧实现里 `asrDataReady` 在模块顶层立即执行的行为。等 INIT 到达时 WASM 往往
// 已就绪，"点开始"到出字的空窗因此明显更短；漏掉它会让模型加载整个后移到 INIT 之后。
// （模型未安装时 preload 内部会静默跳过，见 asr-engine 的 injectWasmScripts 注释）
void engine.preload().catch((e) => console.log('[TM Offscreen] wasm 预加载失败:', e));

function setupPort() {
  const myPort = chrome.runtime.connect({ name: 'offscreen' });
  port = myPort;

  myPort.onDisconnect.addListener(() => {
    console.log('[TM Offscreen] 端口断开');
    const wasRunning = engine.hasPipeline();
    if (wasRunning) console.log('[TM Offscreen] 管道还在运行，1 秒后重连...');
    setTimeout(() => {
      // 竞态守卫：期间若已建立更新的端口（另一次重连已成功），不重复建连。
      if (port !== myPort) return;
      // 无条件重连：运行中 SW 被回收断开时，重连 + RECONNECT 让 background 自愈会话状态；
      // 停止时 background 会立刻销毁本文档，这段代码大概率没机会执行——即便在销毁完成前
      // 抢跑重连一次，也只是空连一秒后随文档一起消亡，无副作用。
      setupPort();
      if (wasRunning) {
        const info = engine.getReconnectInfo();
        try {
          port.postMessage({
            type: 'FW_POP',
            payload: {
              type: 'RECONNECT',
              tabId: info.tabId,
              streamId: info.streamId,
              source: info.source,
              status: 'Running',
            },
          });
        } catch { /* 新端口尚未就绪：bg 侧靠端口 onConnect 的补发兜底 */ }
      }
    }, 1000);
  });

  myPort.onMessage.addListener((msg: any) => {
    try {
      switch (msg?.type) {
        case 'INIT_OFFSCREEN': {
          const generation = ++sessionGeneration;
          const initDone = engine.init({
            source: msg.source === 'system' ? 'system'
              : msg.source === 'mic' ? 'mic'
              : msg.source === 'helper' ? 'helper' : 'tab',
            tabId: msg.tabId ?? null,
            lang: msg.lang,
            usePunct: msg.usePunct,
            endpointRule1: msg.endpointRule1,
            endpointRule2: msg.endpointRule2,
            endpointRule3: msg.endpointRule3,
            hotwords: msg.hotwords,
            translationEnabled: msg.translationEnabled,
            translationDirection: msg.translationDirection,
            translationTiming: msg.translationTiming,
          });
          // 桌面助手：PCM 由本机助手进程采集，经 WS 直接喂进引擎。
          // 与 mic 的区别：不需要可见页（没有授权框）、不需要 bg 逐块转发（WS 就在本进程里）。
          // **必须在 init 完成之后再接**：init 未完成时 Pipeline 还没进入 Running，
          // feedAudio 会直接丢弃，表现为"按下开始后的头几个字没了"。Web 宿主就是这么做的。
          if (msg.source === 'helper') {
            void initDone
              .then(() => {
                // init 期间用户可能已经点了停止（或又开了一场）：代次变了就放弃，别接音频
                if (generation !== sessionGeneration) return;
                startHelperSource(msg.helperPort, msg.helperToken, msg.lang);
              })
              .catch(() => { /* init 失败内部只 log 不上抛；这里兜底避免未处理的拒绝 */ });
          } else {
            // 非 helper 的 INIT：必须停掉上一场的 helper WS（Web 宿主在 startSession 里也这么做，
            // 两端不对称正是独立审查抓的）。否则旧 WS 还活着、继续把 PCM 喂进**新**管道：
            // 同一配置下 Running 中再来一次 START 时会串音，而且没人负责关它。
            stopHelperSource();
          }
          break;
        }
        case 'STOP_OFFSCREEN':
          sessionGeneration += 1;          // 作废在飞的 init 回调
          stopHelperSource();
          engine.stop();
          break;
        case 'SET_PUNCT':
          engine.setPunctuation(msg.enabled !== false);
          break;
        case 'SET_ENDPOINT':
          engine.logEndpoint(msg.rule1, msg.rule2, msg.rule3);
          break;
        case 'RESEND_CURRENT_TEXT':
          engine.resendCurrentText();
          break;
        case 'TRANSLATE_TEST':
          void engine.testTranslate(String(msg.text ?? ''), msg.direction || 'auto').then((r) => {
            try { port.postMessage({ type: 'TRANSLATE_TEST_RESULT', payload: { id: msg.id, ...r } }); } catch {}
          });
          break;
        case 'TRANSLATE_TEST_CANCEL':
          // 面板二次点击"取消"：终止测试 worker（若为测试临时创建的）并结束挂起的应答。
          // 此前"取消"是假的，临时 worker 会继续把 216MB 翻译模型加载完（白烧数秒 CPU）才收尾。
          engine.cancelTranslateTest();
          break;
        case 'TRANSLATION_MODEL_IMPORTED':
          // 面板刚导入/更新翻译模型：解除"缺模型"记忆，运行中的会话无需重启即可出译文。
          engine.notifyTranslationModelImported();
          break;
        case 'TRANSLATION_SETTINGS_LIVE':
          // 会话运行中改了实时翻译开关/方向/时机：当场生效
          engine.setTranslationLive(
            msg.enabled === true,
            msg.direction === 'zh-en' || msg.direction === 'en-zh' ? msg.direction : 'auto',
            msg.timing === 'final' ? 'final' : 'stream',
          );
          break;
        case 'MIC_CHUNK':
          // mic 模式音频入口：悬浮窗（可见扩展页）采集 PCM，经 bg 逐块转发至此。
          // 坑：Port 走 JSON 克隆，ArrayBuffer 到这里已变成普通数组（见 floating.ts 注释），
          // 故这里按 number[] 还原；同时兼容直传 ArrayBuffer 的情形。
          engine.feedMicChunk(msg.audio, msg.sampleRate);
          break;
        case 'STREAM_READY':
          // background 对 REQUEST_STREAM 的应答：拿到新鲜 streamId，立即开流。
          if (!engine.hasPipeline()) { engine.log('STREAM_READY 到达时会话已停止，丢弃'); break; }
          engine.log('收到 STREAM_READY，开始音频捕获');
          void engine.startTabCapture(msg.streamId).catch((err: any) => {
            engine.log('音频捕获失败: ' + (err?.message || err));
            try { port.postMessage({ type: 'FW_POP', payload: { type: 'ERROR', message: `${err?.message || err}` } }); } catch {}
          });
          break;
      }
    } catch (err) {
      // 坑：必须走 log 通道上抛。写成 console.log 的话，offscreen 的 console 只有打开
      // 扩展的"检查视图"才能看到 —— 消息路由异常（例如某条消息分支写错）会表现为
      // "点了没反应且毫无线索"，面板日志里一片空白。
      engine.log('消息处理异常: ' + ((err as any)?.stack || err));
    }
  });
}

setupPort();
console.log('[TM Offscreen] 文档已加载');

// ---- 桌面助手音频源（本机助手 easysub-helper）----
// 为什么放在 offscreen：这里就是引擎宿主，PCM 到手直接 feedMicChunk，不需要可见页、
// 不需要 bg 逐块转发（对比 mic：那条链路必须由悬浮窗采、经 bg 中转，因为 Chrome 禁止
// offscreen 调 getUserMedia）。WS 的地址与令牌由面板探测/配对后经 INIT 下发。
let helperSource: HelperSource | null = null;
// 错误文案用会话语言（offscreen 的 getLang 是异步的，这里的 lang 由 INIT 带下来）
let helperLang = 'zh_CN';

function toPanel(payload: any) {
  try { port.postMessage({ type: 'FW_POP', payload }); } catch { /* 端口未就绪：丢弃 */ }
}

function stopHelperSource() {
  if (helperSource) {
    helperSource.stop();
    helperSource = null;
  }
}

function startHelperSource(portRaw: any, tokenRaw: any, langRaw?: any) {
  stopHelperSource();
  helperLang = typeof langRaw === 'string' && langRaw ? langRaw : helperLang;
  const port = Number(portRaw);
  const token = String(tokenRaw || '');
  if (!port || !token) {
    // 缺令牌 = 没配对（可能压根没启动助手，也可能助手开着但没配过）。
    // 这些全是常态：当静音音源处理，不发 ERROR（那会把整场会话拆掉）。文案要与"只在没有令牌
    // 时发送"这一事实一致——别说"没在运行"（用户明明开着助手窗口），也别提"暂停"（那由
    // ERR_PAUSED → helperPaused 那条路负责，独立审查两轮分别抓过这两处漂移）。
    toPanel({ type: 'HELPER_SILENT', message: tSync(helperLang, 'helperSilentGeneric') });
    return;
  }
  helperSource = new HelperSource({
    port,
    token,
    source: 'system',
    // PCM 与其它音源走**同一条**注入通道（feedMicChunk → recordLevel → LEVEL），
    // 所以这里不需要任何 helper 专属的电平/波形处理——引擎自己会算。
    onPcm: (f32, rate) => engine.feedMicChunk(f32, rate),
    onError: (message, code) => {
      console.log('[TM Offscreen] 桌面助手错误:', code, message);
      // 产品决定（2026-10-05）：助手没启动/处于暂停都是**常态**而不是故障——这个音源
      // 是"连上过之后掉线/助手处于暂停"这类**连着但不该拆会话**的情况（"从没连上"由
      // never_connected 走 ERROR 收敛）。所以这三类只降级成
      // HELPER_SILENT（面板日志一句话），不再把整场会话当 ERROR 拆掉——此前一发 ERROR，
      // background 会 cleanupAll 连模型一起拆，比"改前白拦一次"更糟（复审抓到的）。
      // 'paused' 必须在清单里：助手窗口默认就是暂停，连接后对 start 必回 ERR_PAUSED，
      // 这是最高频的一条；其余未知 code（真正故障）仍走 ERROR。
      // 清单与 Web 宿主共用 isHelperSilentCode（两端各写一份正是审查抓过的不一致）。
      if (isHelperSilentCode(code)) {
        toPanel({ type: 'HELPER_SILENT', message });
        return;
      }
      toPanel({ type: 'ERROR', message });
    },
    log: (message) => engine.log(message),
  });
  helperSource.start();
}
