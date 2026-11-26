import {
  BODY_LIMIT,
  VALID_THINKING_EFFORTS,
  resolveLocalGenerateUrl,
  hasPresetReplyTool,
  estimateRequestContextBytes,
  preparePgRequest,
  buildRescueRequestBody,
  dedupeContinuationOverlap,
} from "./src/request.mjs";
import { restorePgResponse, readRescueFunctionResponse } from "./src/json-stream.mjs";
import { installPgMeowPreview } from "./src/meow-preview.mjs";

const PLUGIN_ID = "pg-streaming-anti-truncation";
export const PLUGIN_VERSION = "1.5.0";
const FETCH_KEY = Symbol.for("pg-streaming-anti-truncation.fetch");

const TAG_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:~-]{0,63}$/;
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const HOST_PLACEHOLDER_EFFORTS = new Set(["", "auto", "none", "off", "default", "disabled", "disable"]);

const DEFAULT_SETTINGS = {
  mode: "streaming",         // off | streaming | buffered | native-fc
  thinkingEffort: "preset",  // preset | low | medium | high | minimal | model-default
  autoRescue: true,          // 撞 PROHIBITED_CONTENT / SAFETY 自动切原生 functionCall 无感接力续写
  meowCompat: true,          // 小猫预设（soliumbra_reply）多字段流式
  autoDetectTool: true,      // 自动兼容 4ACH / 图灵 / 莱莎 / 小猫 Reborn 等正文工具
  transportToolName: "",     // 手动指定正文工具名（留空自动识别）
  enableForPlain: false,     // 无工具纯文本预设默认走原生流式；勾选后强制走结构化抗截断
  onlyReverseProxy: false,   // 仅在使用反向代理时接管
  tagStop: false,            // 自定义标签截停
  stopTag: "tucao",
  stopCount: 2,
  stopExemptTag: "",
};

const BYPASS_TEXT = {
  disabled: "",
  "other-provider": "",
  "quiet-request": "",
  "impersonate-request": "",
  "background-request": "",
  "native-fc-mode": "已启用原生函数抗截断（保留原工具调用，等待整段稳出）",
  "not-reverse-proxy": "当前未使用反向代理，走默认通道。",
  model: "当前模型不适用结构化流式，走默认通道。",
  "image-generation": "生图请求走默认通道。",
  "web-search": "当前预设开启了联网搜索，已走默认通道。",
  "multiple-candidates": "多候选请求走默认通道。",
  "structured-output": "请求自带结构化输出，走默认通道。",
  "assistant-prefill": "当前纯文本预设包含末尾预填充，已自动走 PG 原生流式以保护预填充结构。",
  "plain-native-stream": "当前为无工具纯文本预设，已走 PG 原生流式输出。",
  "multi-client-tools": "请求包含多个自定义业务工具，已走默认通道。",
  "tool-choice-none": "当前请求禁用了工具调用，已走默认通道。",
  "unsupported-tools": "当前工具格式不支持流式转换，已走默认通道。",
  "target-tool-choice": "请求指定了辅助或其他工具，已走默认通道。",
  "target-tool-schema": "目标工具不属于正文输出结构，已走默认通道。",
  "too-large": "请求体超过 8 MB，已走默认通道。",
};

const THINKING_LABEL = {
  preset: "跟随预设默认",
  minimal: "极简思考",
  low: "低思考",
  medium: "中思考",
  high: "高思考",
  "model-default": "模型默认思考",
};

const BLOCK_REASON_CN = {
  SAFETY: "触发安全过滤",
  PROHIBITED_CONTENT: "触发禁限内容策略",
  BLOCKLIST: "命中敏感词表",
  RECITATION: "触发版权复述保护",
  SPII: "触发敏感隐私保护",
  IMAGE_SAFETY: "触发图像安全过滤",
  EMPTY_STOP: "上游静默空回（仅思考或 0 字结束）",
  MISSING_BODY_STOP: "上游仅输出思维链未写正文",
  OTHER: "上游异常中止",
  BLOCKED: "触发上游安全拦截",
};

const FIELD_STAGE_CN = {
  think_nya: "小猫规划",
  ryza_brew: "调合构思",
  game_content: "正文",
  game: "正文",
  story_content: "正文",
  story_body: "正文",
  content: "正文",
  continuation: "续写",
  options: "选项",
  summary: "摘要",
  comment: "评论",
};

const context = SillyTavern.getContext();
const events = context.eventTypes ?? context.event_types;
let statusEl = null;
let presetHintEl = null;
let runtimeSummaryEl = null;
let rescuePillEl = null;
let meowStreams = null;
let activeMainReqId = 0;
let inFlightMainReqId = null;
let inFlightMainSignal = null;
let mainGenActive = false;
let mainGenStartedAt = 0;
let stopActiveWaitTimer = null;
let pillAutoHideTimer = null;
let pillStickyUntil = 0;
let pillSeq = 0;
let lastSettingsReadyEffort = null;
let lastSettingsReadyAt = 0;
let lastStatus = { text: "", tone: "info" };
let globalListenersBound = false;

// TauriTavern 单扩展更新钩子（manifest.hooks.update）：更新后立刻提示并自动刷新加载新版 JS，解决手机端旧内存滞留
export function onExtensionUpdate() {
  try {
    const busy = inFlightMainReqId !== null && !inFlightMainSignal?.aborted;
    const msg = busy
      ? "PG 流式抗截断已完成更新，当前生成结束后请刷新页面以加载新版。"
      : "PG 流式抗截断已完成更新，正在刷新页面以加载新版…";
    if (globalThis.toastr?.info) {
      globalThis.toastr.info(msg, "PG 流式抗截断");
    } else if (window?.toastr?.info) {
      window.toastr.info(msg, "PG 流式抗截断");
    }
    setStatus(msg, "info");
    if (!busy) {
      setTimeout(() => {
        try {
          window?.location?.reload?.();
        } catch {
          // ignore reload failure in non-browser environment
        }
      }, 1200);
    }
  } catch {
    // never crash extension updater
  }
}

function ensureMeowPreview() {
  if (meowStreams) return meowStreams;
  const ctx = SillyTavern.getContext();
  if (!ctx?.messageFormatter?.addHook) return null;
  meowStreams = installPgMeowPreview(() => SillyTavern.getContext(), () => {
    const cur = getSettings();
    return cur.mode === "streaming" && cur.meowCompat !== false;
  });
  return meowStreams;
}

function getSettings() {
  const store = SillyTavern.getContext().extensionSettings;
  if (!store[PLUGIN_ID] || typeof store[PLUGIN_ID] !== "object") {
    store[PLUGIN_ID] = { ...DEFAULT_SETTINGS };
  } else {
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
      if (store[PLUGIN_ID][key] === undefined) store[PLUGIN_ID][key] = val;
    }
  }
  if (!VALID_THINKING_EFFORTS.has(store[PLUGIN_ID].thinkingEffort)) {
    store[PLUGIN_ID].thinkingEffort = "preset";
  }
  return store[PLUGIN_ID];
}

function saveSettings(patch) {
  Object.assign(getSettings(), patch);
  SillyTavern.getContext().saveSettingsDebounced();
}

function getLiveStatusEl() {
  if (statusEl?.isConnected) return statusEl;
  statusEl = document.getElementById("pg_streaming_status");
  return statusEl;
}

function setStatus(text, tone = "info", reqId = null) {
  if (reqId !== null && reqId !== activeMainReqId) return;
  lastStatus = { text: text || "", tone };
  const el = getLiveStatusEl();
  if (!el) return;
  el.textContent = lastStatus.text;
  el.hidden = !lastStatus.text;
  el.classList.toggle("pg-status-error", tone === "error" || tone === true);
  el.classList.toggle("pg-status-warn", tone === "warn");
}

function clearPillTimer() {
  if (pillAutoHideTimer !== null) {
    clearTimeout(pillAutoHideTimer);
    pillAutoHideTimer = null;
  }
}

// 聊天界面顶部居中轻提示胶囊（适配电脑端与 Android/iOS 刘海屏，避开右下角小猫悬浮球/4ACH 胶囊/底部输入法）
function setRescuePill(text, reqId = null, { tone = "warn", autoHideMs = 0, force = false } = {}) {
  if (reqId !== null && reqId !== activeMainReqId) return;
  if (!text) {
    if (!force && pillStickyUntil > performance.now()) return;
    pillSeq++;
    clearPillTimer();
    pillStickyUntil = 0;
    if (rescuePillEl) {
      rescuePillEl.textContent = "";
      rescuePillEl.hidden = true;
      rescuePillEl.classList.remove("pg-pill-info", "pg-pill-error");
    }
    return;
  }
  const mySeq = ++pillSeq;
  clearPillTimer();
  pillStickyUntil = autoHideMs > 0 ? performance.now() + autoHideMs : 0;
  if (!rescuePillEl?.isConnected) {
    const existing = document.getElementById("pg_rescue_floating_pill");
    if (existing) {
      rescuePillEl = existing;
    } else if (document.body?.append) {
      rescuePillEl = document.createElement("div");
      rescuePillEl.id = "pg_rescue_floating_pill";
      rescuePillEl.setAttribute("role", "status");
      rescuePillEl.setAttribute("aria-live", "polite");
      document.body.append(rescuePillEl);
    }
  }
  if (!rescuePillEl) return;
  rescuePillEl.classList.toggle("pg-pill-info", tone === "info");
  rescuePillEl.classList.toggle("pg-pill-error", tone === "error");
  rescuePillEl.textContent = text;
  rescuePillEl.hidden = false;
  if (autoHideMs > 0) {
    pillAutoHideTimer = setTimeout(() => {
      if (pillSeq !== mySeq) return;
      pillAutoHideTimer = null;
      pillStickyUntil = 0;
      setRescuePill("", null, { force: true });
    }, autoHideMs);
  }
}

function formatHttpStatusError(status) {
  const map = {
    400: "请求参数被上游拒绝，请检查模型或附加参数",
    401: "API 密钥无效或未授权",
    403: "账号无权限访问该模型或触发地区/配额限制",
    404: "所选模型不存在或接口路径错误",
    408: "上游请求超时",
    429: "触发上游限流或额度已满，请稍后再试",
    500: "上游服务内部错误",
    502: "反代或上游网关异常，可稍后重发",
    503: "上游服务繁忙/暂不可用（模型节点拥堵），可点重发",
    504: "上游响应超时，建议改低思考或稍后重发",
  };
  return map[status] ? `状态码 ${status}：${map[status]}` : `状态码 ${status}`;
}

function localizeNetworkError(errOrMsg) {
  const msg = typeof errOrMsg === "string" ? errOrMsg : String(errOrMsg?.message ?? "");
  if (!msg) return "网络连接异常";
  if (/failed to fetch|network\s*error|load failed|socket|econnreset|econnrefused|epipe/i.test(msg)) {
    return "网络连接异常或代理中断，请确认反代服务运行正常";
  }
  if (/timeout|timed out|超时/i.test(msg)) {
    return /超时/.test(msg) ? msg.slice(0, 160) : "请求连接超时";
  }
  if (/aborted|abort/i.test(msg)) return "请求已中止";
  if (/503|service.*unavailable/i.test(msg) && !/拥堵|繁忙|暂不可用/.test(msg)) {
    return `${msg.slice(0, 120)}（上游节点拥堵/暂不可用，可重发）`;
  }
  return msg.slice(0, 160);
}

function localizeReason(code) {
  return BLOCK_REASON_CN[code] ?? `上游中止（${code}）`;
}

function formatTargetLabel(target) {
  if (!target) return "";
  if (target.kind === "soliumbra") {
    const labels = target.fieldOrder.map(k => FIELD_STAGE_CN[k] ?? k);
    return `小猫真流式（${labels.join(" → ")}）`;
  }
  if (target.kind === "multi-field") {
    const labels = target.fieldOrder.map(k => FIELD_STAGE_CN[k] ?? k);
    return `多字段真流式（${labels.join(" → ")}）`;
  }
  if (target.kind === "continuation") {
    return "无缝续写真流式";
  }
  if (target.kind === "single-field") {
    return `预设工具真流式（${target.toolName}）`;
  }
  return "内置结构化真流式";
}

function formatContextMetrics(body) {
  const bytes = estimateRequestContextBytes(body);
  const kb = Math.max(1, Math.round(bytes / 1024));
  const msgArr = Array.isArray(body?.messages) ? body.messages : [];
  const turns = Math.max(1, msgArr.filter(m => m?.role === "user" || m?.role === "assistant").length);
  return { kb, turns, label: `${turns} 轮上下文 · 约 ${kb} KB` };
}

function readTagStopRule(s) {
  if (!s.tagStop) return null;
  const tag = String(s.stopTag ?? "").trim();
  const count = Number(s.stopCount);
  const exemptTag = String(s.stopExemptTag ?? "").trim();
  if (!TAG_NAME_RE.test(tag)) return null;
  if (!Number.isInteger(count) || count < 1) return null;
  if (exemptTag && (!TAG_NAME_RE.test(exemptTag) || exemptTag === tag)) return null;
  return { tag, count, exemptTag };
}

function isReasoningOmittedByHost() {
  const omit = SillyTavern.getContext()?.chatCompletionSettings?.extensions?.tauritavern?.omit_params;
  return Array.isArray(omit) && omit.includes("reasoning_effort");
}

function readHostReasoningEffort({ consumeSnapshot = false } = {}) {
  if (isReasoningOmittedByHost()) {
    if (consumeSnapshot) {
      lastSettingsReadyEffort = null;
      lastSettingsReadyAt = 0;
    }
    return null;
  }
  // 1. 优先读取本次生成触发的 CHAT_COMPLETION_SETTINGS_READY 快照（30 秒有效，发包时一次性消费）
  if (lastSettingsReadyEffort && (performance.now() - lastSettingsReadyAt) <= 30000) {
    const snap = lastSettingsReadyEffort;
    if (consumeSnapshot) {
      lastSettingsReadyEffort = null;
      lastSettingsReadyAt = 0;
    }
    if (!HOST_PLACEHOLDER_EFFORTS.has(snap.toLowerCase())) {
      return snap;
    }
  } else if (consumeSnapshot) {
    lastSettingsReadyEffort = null;
    lastSettingsReadyAt = 0;
  }
  // 2. DOM 控件值仅在非占位值（非 auto/none/空串）时优先，避免 DOM 滞留 auto 遮蔽真实设置
  const sel = document.getElementById("openai_reasoning_effort");
  const fromDom = typeof sel?.value === "string" ? sel.value.trim() : "";
  if (fromDom && !HOST_PLACEHOLDER_EFFORTS.has(fromDom.toLowerCase())) {
    return fromDom;
  }
  // 3. 回退 chatCompletionSettings.reasoning_effort
  const fromSettings = SillyTavern.getContext()?.chatCompletionSettings?.reasoning_effort;
  const trimmedSettings = typeof fromSettings === "string" ? fromSettings.trim() : "";
  if (trimmedSettings && !HOST_PLACEHOLDER_EFFORTS.has(trimmedSettings.toLowerCase())) {
    return trimmedSettings;
  }
  return fromDom || trimmedSettings || null;
}

// 判别是否为非 quiet 的后台扩展请求（如 st-memory-enhancement generateRaw、LittleWhiteBox 后台辅助摘要）：
// 1) 若主请求仍在进行且未被手动中止，并发进入的次级请求 100% 为后台请求；
// 2) 若当前处于主生成流程（GENERATION_STARTED 或活跃 streamingProcessor 或明确主生成 type），视为真实主请求；
// 3) 若未经主生成流程：无工具请求（如 generateRaw(stream:true)）或宿主开流式但请求 stream:false，视作后台静默请求。
function formatHostEffortLabel(raw) {
  const low = String(raw ?? "").trim().toLowerCase();
  if (!low || HOST_PLACEHOLDER_EFFORTS.has(low)) return "";
  if (low === "min" || low === "minimal") return THINKING_LABEL.minimal;
  if (low === "low") return THINKING_LABEL.low;
  if (low === "medium" || low === "med") return THINKING_LABEL.medium;
  if (low === "high" || low === "xhigh" || low === "extra_high" || low === "max" || low === "maximum") {
    return THINKING_LABEL.high;
  }
  return THINKING_LABEL.preset;
}

function isLikelyBackgroundRequest(body) {
  if (body.type === "quiet" || body.type === "impersonate") return false;
  if (inFlightMainReqId !== null && !inFlightMainSignal?.aborted) return true;
  const ctx = SillyTavern.getContext();
  const activeProc = Boolean(ctx?.streamingProcessor && !ctx.streamingProcessor.isFinished);
  const mainActiveFresh = mainGenActive && (performance.now() - mainGenStartedAt) <= 15_000;
  if (mainActiveFresh || activeProc) return false;
  if (body.type === "continue" || body.type === "regenerate" || body.type === "swipe" || body.type === "normal") {
    return false;
  }
  const hostStreamEl = document.getElementById("stream_toggle");
  const hostStreaming = hostStreamEl
    ? hostStreamEl.checked
    : ctx?.chatCompletionSettings?.stream_openai !== false;
  if (!hasPresetReplyTool(body)) return true;
  if (body.stream === false && hostStreaming) return true;
  return false;
}

async function readRequestBodyJson(input, init) {
  const raw = init?.body;
  if (typeof raw === "string") return JSON.parse(raw);
  if (raw instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(raw)));
  }
  if (ArrayBuffer.isView(raw)) {
    return JSON.parse(new TextDecoder().decode(raw));
  }
  if (typeof Blob !== "undefined" && raw instanceof Blob) {
    return JSON.parse(await raw.text());
  }
  if (raw == null && input instanceof Request) {
    return await input.clone().json();
  }
  return null;
}

async function sendModifiedBody(originalFetch, input, init, url, payloadText, overrideSignal = undefined) {
  if (input instanceof Request) {
    const source = new Request(input.clone(), init);
    const headers = new Headers(source.headers);
    headers.delete("content-length");
    const nextReq = new Request(url.href, {
      method: "POST",
      headers,
      body: payloadText,
      signal: overrideSignal ?? source.signal,
      credentials: source.credentials,
      cache: source.cache,
      redirect: source.redirect,
      referrer: source.referrer,
      referrerPolicy: source.referrerPolicy,
      mode: source.mode,
    });
    return originalFetch(nextReq);
  }
  return originalFetch(input, {
    ...init,
    body: payloadText,
    ...(overrideSignal ? { signal: overrideSignal } : {}),
  });
}

// 在模块加载阶段即包裹 window.fetch（loading_order: 0，早于 SPreset、小白X、JS-Slash-Runner 与预设脚本）
function installFetchInterceptor() {
  if (window[FETCH_KEY]) return;
  const originalFetch = window.fetch.bind(window);

  async function pgStreamingFetch(input, init) {
    const s = getSettings();
    if (s.mode === "off" && s.thinkingEffort === "preset") {
      return originalFetch(input, init);
    }

    const url = resolveLocalGenerateUrl(input, init, globalThis.location?.href);
    if (!url) {
      return originalFetch(input, init);
    }

    let body;
    try {
      body = typeof init?.body === "string"
        ? JSON.parse(init.body)
        : await readRequestBodyJson(input, init);
    } catch {
      return originalFetch(input, init);
    }

    if (!body || body.chat_completion_source !== "makersuite") {
      return originalFetch(input, init);
    }

    const isBackground = isLikelyBackgroundRequest(body);
    const isSilentInput = isBackground || body.type === "quiet" || body.type === "impersonate";
    const tagStop = readTagStopRule(s);
    const hostReasoningEffort = isSilentInput ? null : readHostReasoningEffort({ consumeSnapshot: true });
    const prepared = preparePgRequest(body, s, tagStop, { isBackground, hostReasoningEffort });

    // 静默后台请求（quiet / 替我说 / 并发扩展任务 / 记忆整理）：绝不写状态栏、绝不改工具，仅静默透传防 400 修正
    if (prepared.silent) {
      if (prepared.preprocessedBody) {
        const preText = JSON.stringify(prepared.preprocessedBody);
        if (new TextEncoder().encode(preText).length <= BODY_LIMIT) {
          return sendModifiedBody(originalFetch, input, init, url, preText);
        }
      }
      return originalFetch(input, init);
    }

    // 绕过结构化流式，但若前置阶段应用了思考档位或修正了超限参数，仍发送修正后的请求
    if (prepared.bypass) {
      const reqId = ++activeMainReqId;
      mainGenActive = false;
      setRescuePill("", reqId, { force: true });
      const baseMsg = BYPASS_TEXT[prepared.bypass];
      const extraHints = [];
      if (prepared.thinkingApplied) {
        const downgrade = prepared.thinkingDowngradedFrom ? "（Gemini 4 自动降为低思考）" : "";
        extraHints.push(`已应用${THINKING_LABEL[prepared.thinkingApplied]}${downgrade}`);
      } else {
        extraHints.push("未指定思考（模型默认）");
      }
      if (prepared.fixedMaxReasoning) extraHints.push("已自动修正预设超限思考参数");
      const fullMsg = [baseMsg, ...extraHints].filter(Boolean).join(" · ");
      if (fullMsg) setStatus(fullMsg, "info", reqId);

      if (prepared.preprocessedBody) {
        const preText = JSON.stringify(prepared.preprocessedBody);
        if (new TextEncoder().encode(preText).length <= BODY_LIMIT) {
          return sendModifiedBody(originalFetch, input, init, url, preText);
        }
      }
      return originalFetch(input, init);
    }

    const payloadText = JSON.stringify(prepared.body);
    const reqId = ++activeMainReqId;
    if (new TextEncoder().encode(payloadText).length > BODY_LIMIT) {
      mainGenActive = false;
      setRescuePill("", reqId, { force: true });
      setStatus(BYPASS_TEXT["too-large"], "warn", reqId);
      return originalFetch(input, init);
    }

    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    inFlightMainReqId = reqId;
    inFlightMainSignal = signal ?? null;
    setRescuePill("", reqId, { force: true });

    const clearInFlight = () => {
      if (inFlightMainReqId === reqId) {
        inFlightMainReqId = null;
        inFlightMainSignal = null;
        mainGenActive = false;
      }
    };

    const downgrade = prepared.thinkingDowngradedFrom ? "（自动按低思考）" : "";
    const thinkShort = prepared.thinkingApplied
      ? `${THINKING_LABEL[prepared.thinkingApplied]}${downgrade}`
      : "未指定思考（模型默认）";
    const ctxInfo = formatContextMetrics(body);
    const modeLabel = `${prepared.upstreamStream ? formatTargetLabel(prepared.target) : "非流式抗截断（整段校验）"} · ${thinkShort}`;
    const hostStreamOff = prepared.mode === "streaming" && !prepared.stream;
    const startedAt = performance.now();

    const waitPrefix = hostStreamOff
      ? `提示：酒馆原生「流式传输」未开启（${thinkShort} · ${ctxInfo.label}）`
      : `已启用 ${modeLabel}（${ctxInfo.label}）`;

    setStatus(`${waitPrefix}，正在等待首字…`, hostStreamOff ? "warn" : "info", reqId);

    // 首字前每秒刷新等待计时；超过 12 秒在聊天顶部居中浮出轻提示胶囊，首字到达即隐藏
    let waitPillActive = false;
    let waitTimer = setInterval(() => {
      if (reqId !== activeMainReqId) {
        stopWaitTimer();
        clearInFlight();
        return;
      }
      const sec = Math.max(1, Math.floor((performance.now() - startedAt) / 1000));
      const slowHint = sec >= 90 ? "（等待较久，可能遇慢节点，可点停止重发）" : "";
      setStatus(`${waitPrefix}，正在等待首字（${sec} 秒）${slowHint}…`, hostStreamOff || sec >= 90 ? "warn" : "info", reqId);
      if (sec >= 12) {
        waitPillActive = true;
        const pillMsg = sec >= 90
          ? `等待首字较久（${sec} 秒 · ${thinkShort} · 约 ${ctxInfo.kb} KB，可停止重发）…`
          : `正在等待首字（${sec} 秒 · ${thinkShort} · 约 ${ctxInfo.kb} KB）…`;
        setRescuePill(pillMsg, reqId, { tone: sec >= 90 ? "warn" : "info" });
      }
    }, 1000);
    const stopWaitTimer = ({ keepPill = false } = {}) => {
      if (waitTimer !== null) {
        clearInterval(waitTimer);
        waitTimer = null;
      }
      if (waitPillActive && !keepPill) {
        waitPillActive = false;
        setRescuePill("", reqId);
      }
      if (stopActiveWaitTimer === stopWaitTimer) stopActiveWaitTimer = null;
    };
    stopActiveWaitTimer?.();
    stopActiveWaitTimer = stopWaitTimer;

    const processor = prepared.target.kind === "soliumbra" && prepared.upstreamStream
      ? SillyTavern.getContext().streamingProcessor
      : null;

    let response;
    try {
      response = await sendModifiedBody(originalFetch, input, init, url, payloadText);
    } catch (err) {
      stopWaitTimer();
      clearInFlight();
      if (signal?.aborted || err?.name === "AbortError") {
        const sec = ((performance.now() - startedAt) / 1000).toFixed(1);
        setStatus(`已手动停止生成（等待 ${sec} 秒）`, "info", reqId);
      } else {
        setStatus(`PG 请求失败：${localizeNetworkError(err)}`, "error", reqId);
      }
      throw err;
    }

    if (!response.ok) {
      stopWaitTimer();
      clearInFlight();
      setStatus(`PG 上游报错（${formatHttpStatusError(response.status)}）`, "error", reqId);
      return response;
    }

    const previewSet = ensureMeowPreview();
    if (processor && previewSet) {
      previewSet.add(processor);
    }

    let doneHandled = false;
    let rescueTimer = null;
    let activeRescueAbort = null;
    const stopRescueTimer = ({ keepPill = false } = {}) => {
      if (rescueTimer !== null) {
        clearInterval(rescueTimer);
        rescueTimer = null;
      }
      if (!keepPill) setRescuePill("", reqId);
    };
    const stopAllTimers = () => {
      stopWaitTimer();
      stopRescueTimer();
      if (activeRescueAbort) {
        const fn = activeRescueAbort;
        activeRescueAbort = null;
        fn();
      }
    };
    stopActiveWaitTimer = stopAllTimers;

    const onRescue = prepared.autoRescue
      ? async rescueCtx => {
          stopWaitTimer();
          stopRescueTimer();
          const rescueStart = performance.now();
          let rescueThoughtChars = 0;
          const modeDesc = rescueCtx.mode === "full-fallback"
            ? (rescueCtx.reason === "EMPTY_STOP"
              ? "上游仅思考未出正文（空回复提前结束），自动切换原生函数抗截断通道补发"
              : "0 字或未进正文截断，自动切换原生函数抗截断通道重发")
            : rescueCtx.reason === "MISSING_BODY_STOP"
              ? "上游仅输出思维链未写正文，正在原生函数通道无感补写完整正文"
              : `检测到上游安全截断（已收 ${rescueCtx.collectedText.length} 字），正在原生函数通道无感接力续写`;
          const pillPrefix = rescueCtx.mode === "full-fallback"
            ? "防截断通道生成中"
            : rescueCtx.reason === "MISSING_BODY_STOP"
              ? "仅出思维链，正在自动补写正文"
              : "触发安全截断，正在无感接力续写";
          setStatus(`${modeDesc}…`, "warn", reqId);
          setRescuePill(`${pillPrefix}…`, reqId, { tone: "warn" });

          rescueTimer = setInterval(() => {
            if (reqId !== activeMainReqId) {
              stopRescueTimer();
              return;
            }
            const sec = Math.max(1, Math.floor((performance.now() - rescueStart) / 1000));
            const thoughtTip = rescueThoughtChars > 0 ? ` · 已思考 ${rescueThoughtChars} 字` : "";
            const slowTip = sec >= 120 && rescueCtx.collectedText?.length > 0
              ? "（等待较久，可点停止保留已出正文再点继续）"
              : "";
            setStatus(`${modeDesc}（已等待 ${sec} 秒${thoughtTip}）${slowTip}…`, "warn", reqId);
            setRescuePill(
              `${pillPrefix}（已等 ${sec} 秒${thoughtTip}${sec >= 120 && rescueCtx.collectedText?.length > 0 ? "，可停止后点继续" : ""}）…`,
              reqId,
              { tone: "warn" },
            );
          }, 1000);

          // 接力独立超时保护（continue 180s / full-fallback 240s，单调不减截止时间，收到思考增量仅可向 300s 硬上限延长、绝不缩短）
          const rescueAc = new AbortController();
          const baseTimeoutMs = rescueCtx.mode === "full-fallback" ? 240_000 : 180_000;
          const hardCapMs = 300_000;
          let deadlineAt = rescueStart + baseTimeoutMs;
          let timedOut = false;
          let timeoutId = null;

          const scheduleTimeout = () => {
            if (timeoutId !== null) clearTimeout(timeoutId);
            const waitMs = Math.max(1000, deadlineAt - performance.now());
            timeoutId = setTimeout(() => {
              timedOut = true;
              rescueAc.abort();
            }, waitMs);
          };
          scheduleTimeout();

          activeRescueAbort = () => {
            rescueAc.abort();
          };
          const onUserAbort = () => {
            rescueAc.abort();
          };
          if (rescueCtx.signal) {
            if (rescueCtx.signal.aborted) rescueAc.abort();
            else rescueCtx.signal.addEventListener("abort", onUserAbort, { once: true });
          }

          try {
            const built = buildRescueRequestBody(prepared, s, rescueCtx);
            const rescueRes = await sendModifiedBody(
              originalFetch,
              input,
              init,
              url,
              JSON.stringify(built.body),
              rescueAc.signal,
            );
            const parsed = await readRescueFunctionResponse(
              rescueRes,
              built.rescueTarget,
              rescueAc.signal,
              info => {
                if (typeof info?.thoughtChars === "number" && info.thoughtChars > rescueThoughtChars) {
                  rescueThoughtChars = info.thoughtChars;
                  const now = performance.now();
                  const extended = Math.min(rescueStart + hardCapMs, now + 90_000);
                  const nextDeadline = Math.max(deadlineAt, extended);
                  if (nextDeadline > deadlineAt) {
                    deadlineAt = nextDeadline;
                    scheduleTimeout();
                  }
                }
              },
            );
            if (parsed.text && rescueCtx.mode === "continue") {
              parsed.text = dedupeContinuationOverlap(rescueCtx.collectedText, parsed.text, rescueCtx.openWrapperTag);
            }
            return parsed;
          } catch (err) {
            if (timedOut && !rescueCtx.signal?.aborted) {
              const sec = Math.round((performance.now() - rescueStart) / 1000);
              const tErr = new Error(`接力超时（已等待 ${sec} 秒，已保留前文），可点「继续」续写`);
              tErr.name = "AbortError";
              tErr.isRescueTimeout = true;
              throw tErr;
            }
            throw err;
          } finally {
            activeRescueAbort = null;
            if (timeoutId !== null) clearTimeout(timeoutId);
            rescueCtx.signal?.removeEventListener("abort", onUserAbort);
            stopRescueTimer({ keepPill: true });
          }
        }
      : null;

    try {
      const restored = await restorePgResponse(response, prepared, signal, info => {
        if (reqId !== activeMainReqId) {
          stopWaitTimer();
          stopRescueTimer();
          clearInFlight();
          return;
        }
        if (info.phase === "thinking") {
          const keepThinkingPill = waitPillActive || (info.elapsedMs >= 12_000);
          stopWaitTimer({ keepPill: keepThinkingPill });
          const sec = (info.elapsedMs / 1000).toFixed(0);
          setStatus(`${modeLabel} · 模型思考中（已思考 ${info.thoughtChars} 字，${sec} 秒）…`, "info", reqId);
          if (keepThinkingPill) {
            waitPillActive = true;
            setRescuePill(`模型思考中（已思考 ${info.thoughtChars} 字，${sec} 秒）…`, reqId, { tone: "info" });
          }
        } else if (info.phase === "first-token") {
          stopWaitTimer();
          setRescuePill("", reqId, { force: true });
          const tailMsg = prepared.upstreamStream ? "正在实时输出…" : "正在后台校验接收…";
          setStatus(`${modeLabel} · 首字已到达（${(info.ttftMs / 1000).toFixed(1)} 秒），${tailMsg}`, "info", reqId);
        } else if (info.phase === "streaming") {
          stopWaitTimer();
          const elapsedSec = (info.elapsedMs / 1000).toFixed(1);
          const genSec = info.ttftMs != null ? Math.max(0.2, (info.elapsedMs - info.ttftMs) / 1000) : Math.max(0.2, info.elapsedMs / 1000);
          const speed = Math.round(info.chars / genSec);
          const stage = info.field && FIELD_STAGE_CN[info.field] ? ` · ${FIELD_STAGE_CN[info.field]}` : "";
          const prefix = prepared.upstreamStream ? "实时输出中" : "后台校验接收中";
          setStatus(`${modeLabel}${stage} · ${prefix}：已收 ${info.chars} 字（${elapsedSec} 秒，约 ${speed} 字/秒）`, "info", reqId);
        } else if (info.phase === "done") {
          doneHandled = true;
          stopWaitTimer();
          clearInFlight();
          const chars = info.chars ?? 0;
          const totalSec = info.totalMs != null ? info.totalMs / 1000 : null;
          if (info.aborted) {
            stopRescueTimer();
            setRescuePill("", reqId, { force: true });
            setStatus(`已手动停止生成（已收 ${chars} 字，耗时 ${(totalSec ?? 0).toFixed(1)} 秒）`, "info", reqId);
            return;
          }
          if (info.errorMessage) {
            stopRescueTimer({ keepPill: chars > 0 });
            const localizedErr = localizeNetworkError(info.errorMessage);
            if (chars > 0) {
              setStatus(`${modeLabel} · 接力异常（${localizedErr}），已保留前 ${chars} 字，可点「继续」续写`, "error", reqId);
              setRescuePill(`接力未完成，已保留前 ${chars} 字，可点「继续」续写`, reqId, { tone: "error", autoHideMs: 8000 });
            } else {
              setRescuePill("", reqId, { force: true });
              setStatus(`PG 上游报错：${localizedErr}`, "error", reqId);
            }
            return;
          }
          if (info.blockReason) {
            stopRescueTimer({ keepPill: chars > 0 });
            if (chars > 0) {
              setStatus(`${modeLabel} · ${localizeReason(info.blockReason)}，已保留前 ${chars} 字，可点「继续」续写`, "error", reqId);
              setRescuePill(`已保留前 ${chars} 字，可点「继续」续写`, reqId, { tone: "error", autoHideMs: 8000 });
            } else {
              setRescuePill("", reqId, { force: true });
              setStatus(`请求被上游安全策略拦截：${localizeReason(info.blockReason)}`, "error", reqId);
            }
            return;
          }
          stopRescueTimer();
          setRescuePill("", reqId, { force: true });
          const genSec = info.ttftMs != null && info.totalMs != null
            ? Math.max(0.2, (info.totalMs - info.ttftMs) / 1000)
            : totalSec;
          const speedText = chars > 0 && genSec && genSec > 0 ? `，约 ${Math.round(chars / genSec)} 字/秒` : "";
          const ttft = info.ttftMs != null ? `首字 ${(info.ttftMs / 1000).toFixed(1)} 秒` : "已完成";
          const total = totalSec != null ? `，总耗时 ${totalSec.toFixed(1)} 秒` : "";
          const stopHint = info.stoppedByTag ? `，命中 ${info.stoppedByTag} 截停` : "";
          const rescueHint = info.rescuedCount > 0 ? `，已无感接力 ${info.rescuedCount} 次防截断` : "";

          if (info.finishReason === "MAX_TOKENS") {
            setStatus(`${modeLabel} · 达到单次长度上限，已保留 ${chars} 字正文，可点击“继续”无缝续写（${ttft}${total}）`, "warn", reqId);
            return;
          }
          if (info.finishReason && info.finishReason !== "STOP") {
            setStatus(`${modeLabel} · 生成中途${localizeReason(info.finishReason)}，已保留前 ${chars} 字`, "error", reqId);
            return;
          }
          setStatus(`${modeLabel} · ${ttft}${total}，共 ${chars} 字${speedText}（${info.chunks} 个流式分块${rescueHint}${stopHint}）`, "info", reqId);
        }
      }, onRescue);

      // 若上游直接返回 200 application/json 或空流导致 restorePgResponse 原样返回，必须立刻释放定时器与占位态
      if (restored === response) {
        stopWaitTimer();
        stopRescueTimer();
        clearInFlight();
        if (!doneHandled) {
          const sec = ((performance.now() - startedAt) / 1000).toFixed(1);
          setStatus(`${modeLabel} · 上游返回非流式响应（耗时 ${sec} 秒）`, "info", reqId);
        }
      } else if (!prepared.upstreamStream) {
        stopWaitTimer();
        stopRescueTimer({ keepPill: pillStickyUntil > performance.now() });
        clearInFlight();
      }
      return restored;
    } catch (err) {
      stopWaitTimer();
      stopRescueTimer();
      clearInFlight();
      if (!doneHandled) {
        if (signal?.aborted || err?.name === "AbortError") {
          const sec = ((performance.now() - startedAt) / 1000).toFixed(1);
          setStatus(`已手动停止生成（耗时 ${sec} 秒）`, "info", reqId);
        } else {
          const kind = prepared.upstreamStream ? "PG 流式还原中断" : "PG 响应接收中断";
          setStatus(`${kind}：${localizeNetworkError(err)}`, "error", reqId);
        }
      }
      throw err;
    }
  }

  window.fetch = pgStreamingFetch;
  window[FETCH_KEY] = pgStreamingFetch;
}

function updatePresetHint() {
  if (!presetHintEl?.isConnected) {
    presetHintEl = document.getElementById("pg_preset_hint");
  }
  if (!runtimeSummaryEl?.isConnected) {
    runtimeSummaryEl = document.getElementById("pg_runtime_summary");
  }
  const s = getSettings();
  const ctx = SillyTavern.getContext();
  const modelSel = document.getElementById("model_google_select");
  const curModel = String(modelSel?.value ?? ctx?.chatCompletionSettings?.google_model ?? "").trim();
  const hostEff = String(readHostReasoningEffort({ consumeSnapshot: false }) ?? "").trim().toLowerCase();
  const hostStream = document.getElementById("stream_toggle");
  const isHostStreaming = hostStream ? hostStream.checked : ctx?.chatCompletionSettings?.stream_openai !== false;
  const webSearchEl = document.getElementById("openai_enable_web_search");
  const isWebSearch = Boolean(webSearchEl?.checked ?? ctx?.chatCompletionSettings?.enable_web_search);

  if (runtimeSummaryEl) {
    const modelShort = curModel ? curModel.replace(/^models\//, "") : "未选择模型";
    const hostLabel = formatHostEffortLabel(hostEff);
    const effDisplay = s.thinkingEffort !== "preset"
      ? `${THINKING_LABEL[s.thinkingEffort]}（插件覆盖）`
      : (hostLabel ? `${hostLabel}（预设桥接）` : "未指定（模型默认）");
    runtimeSummaryEl.textContent = `当前：${modelShort} · 思考：${effDisplay} · ${isHostStreaming ? "流式已开" : "流式未开"}`;
  }

  if (!presetHintEl) return;

  if (s.mode === "off") {
    if (s.thinkingEffort !== "preset") {
      presetHintEl.textContent = `抗截断已关闭，当前仅覆盖 PG 思考强度（${THINKING_LABEL[s.thinkingEffort]}）。`;
      presetHintEl.hidden = false;
      presetHintEl.classList.remove("pg-hint-warn");
    } else {
      presetHintEl.hidden = true;
    }
    return;
  }

  let text = "";
  let warn = false;
  if (s.mode === "native-fc") {
    text = `就绪：保留预设原生函数抗截断通道（整段稳出、不流式）${s.thinkingEffort !== "preset" ? ` · ${THINKING_LABEL[s.thinkingEffort]}` : ""}。`;
  } else if (s.mode === "streaming" && !isHostStreaming) {
    text = "提醒：酒馆原生「流式传输」开关未勾选，当前只能整段交付；勾选后即可逐字真流式。";
    warn = true;
  } else if (isWebSearch) {
    text = "提示：当前预设开启了联网搜索，发送时会自动放行走默认通道。";
    warn = true;
  } else if (s.thinkingEffort !== "preset") {
    const modeDesc = s.mode === "buffered" ? "整段校验抗截断" : (s.autoRescue !== false ? "真流式 + 自动接力防截断" : "结构化真流式");
    text = `就绪：${modeDesc} · 将覆盖预设思考参数为「${THINKING_LABEL[s.thinkingEffort]}」。`;
  } else if (s.mode === "buffered") {
    text = "就绪：发送时自动识别小猫 / 4ACH / 图灵 / 莱莎等工具预设并转为整段校验抗截断。";
  } else {
    const hasLowPreset = hostEff === "low" || hostEff === "min" || hostEff === "minimal";
    const hasExplicitPreset = hostEff === "medium" || hostEff === "med" || hostEff === "high" || hostEff === "xhigh" || hostEff === "extra_high" || hostEff === "max" || hostEff === "maximum";
    const explicitLabel = formatHostEffortLabel(hostEff);
    const carbonTip = /gemini-4-carbon/i.test(curModel)
      ? (hasLowPreset
        ? " 已自动桥接预设里的「低思考」到 Gemini 4（已自动清理预设空占位）。"
        : hasExplicitPreset
          ? ` 已自动桥接预设思考（${explicitLabel}）到 Gemini 4；如长对话首字慢可改低思考。`
          : " 提示：长对话使用 Gemini 4 时建议开启「低思考」，可显著缩短首字等待。")
      : "";
    text = (s.autoRescue !== false
      ? "就绪：真流式秒出字，如遇安全截断或仅出思维链提前结束，将自动切原生函数通道无感补全。"
      : "就绪：发送时自动识别小猫 / 4ACH / 图灵 / 莱莎等工具预设并转为真流式。") + carbonTip;
  }

  presetHintEl.textContent = text;
  presetHintEl.hidden = !text;
  presetHintEl.classList.toggle("pg-hint-warn", warn);
}

function bindHostControlEvents() {
  const bindings = [
    ["stream_toggle", ["change", "input"]],
    ["openai_enable_web_search", ["change", "input"]],
    ["model_google_select", ["change", "input"]],
    ["openai_reasoning_effort", ["change", "input"]],
    ["chat_completion_source", ["change", "input"]],
  ];
  for (const [id, evList] of bindings) {
    const el = document.getElementById(id);
    if (!el || el.dataset?.pgHintBound) continue;
    if (el.dataset) el.dataset.pgHintBound = "1";
    for (const ev of evList) {
      el.addEventListener(ev, updatePresetHint);
    }
  }
}

function bindGlobalListenersOnce() {
  if (globalListenersBound) return;
  globalListenersBound = true;

  const resetInFlight = ({ forceClearPill = false } = {}) => {
    inFlightMainReqId = null;
    inFlightMainSignal = null;
    stopActiveWaitTimer?.();
    setRescuePill("", null, { force: forceClearPill });
  };

  if (events?.CHAT_COMPLETION_SETTINGS_READY) {
    context.eventSource.on(events.CHAT_COMPLETION_SETTINGS_READY, data => {
      if (!data || typeof data !== "object" || data.chat_completion_source !== "makersuite") return;
      if (data.type === "quiet" || data.type === "impersonate") return;
      if (inFlightMainReqId !== null && !inFlightMainSignal?.aborted) return;
      const eff = typeof data.reasoning_effort === "string" ? data.reasoning_effort.trim() : "";
      lastSettingsReadyEffort = eff || null;
      lastSettingsReadyAt = performance.now();
    });
  }

  if (events?.GENERATION_STARTED) {
    context.eventSource.on(events.GENERATION_STARTED, (type, _opts, dryRun) => {
      if (!dryRun && type !== "quiet" && type !== "impersonate") {
        mainGenActive = true;
        mainGenStartedAt = performance.now();
        resetInFlight({ forceClearPill: true });
      }
    });
  }

  if (events?.GENERATION_ENDED) {
    context.eventSource.on(events.GENERATION_ENDED, () => {
      const proc = SillyTavern.getContext()?.streamingProcessor;
      const mainStillStreaming = Boolean(proc && !proc.isFinished && !proc.abortController?.signal?.aborted);
      if (mainStillStreaming && inFlightMainReqId !== null && !inFlightMainSignal?.aborted) {
        // 后台 quiet 任务完成触发的 GENERATION_ENDED，绝不误杀进行中的主请求计时器与占位态
        return;
      }
      mainGenActive = false;
      resetInFlight({ forceClearPill: false });
    });
  }

  if (events?.GENERATION_STOPPED) {
    context.eventSource.on(events.GENERATION_STOPPED, () => {
      mainGenActive = false;
      resetInFlight({ forceClearPill: true });
    });
  }

  const onPresetChanged = () => {
    if (!document.getElementById("pg_streaming_settings")) mountPanel();
    bindHostControlEvents();
    updatePresetHint();
  };
  if (events?.OAI_PRESET_CHANGED_AFTER) {
    context.eventSource.on(events.OAI_PRESET_CHANGED_AFTER, onPresetChanged);
  }
  if (events?.PRESET_CHANGED) {
    context.eventSource.on(events.PRESET_CHANGED, onPresetChanged);
  }
  if (events?.CHAT_CHANGED) {
    context.eventSource.on(events.CHAT_CHANGED, () => {
      activeMainReqId++;
      mainGenActive = false;
      resetInFlight({ forceClearPill: true });
      setStatus("");
      if (!document.getElementById("pg_streaming_settings")) mountPanel();
      bindHostControlEvents();
      updatePresetHint();
    });
  }
}

function mountPanel() {
  if (document.getElementById("pg_streaming_settings")) return;
  const parent = document.getElementById("makersuite_form");
  if (!parent) {
    console.warn("[PG 流式抗截断] 未找到 Google AI Studio 连接面板 (#makersuite_form)。");
    return;
  }

  const s = getSettings();
  const panel = document.createElement("div");
  panel.id = "pg_streaming_settings";
  panel.innerHTML = `
    <div class="pg-header">
      <div class="pg-title-group">
        <span class="pg-title">PG / AI Studio 真流式抗截断</span>
        <span class="pg-version">v${PLUGIN_VERSION}</span>
      </div>
      <span class="pg-badge" id="pg_mode_badge">流式+防截断</span>
    </div>
    <div class="pg-runtime-summary" id="pg_runtime_summary"></div>
    <label class="pg-control-label" for="pg_streaming_mode">
      <span>传输模式</span>
      <select id="pg_streaming_mode" class="text_pole">
        <option value="off">关闭（走原始 AI Studio / PG）</option>
        <option value="streaming">流式抗截断（真流式 + 自动接力，推荐）</option>
        <option value="native-fc">原生函数抗截断（整段稳出，不流式）</option>
        <option value="buffered">非流式抗截断（整段校验后输出）</option>
      </select>
    </label>
    <label class="pg-control-label" for="pg_thinking_effort">
      <span>PG 思考强度</span>
      <select id="pg_thinking_effort" class="text_pole">
        <option value="preset">跟随预设默认（自动桥接并防报错）</option>
        <option value="low">低思考（最快出字，推荐提速）</option>
        <option value="medium">中思考（速度与质量均衡）</option>
        <option value="high">高思考（深度推理，等待较长）</option>
        <option value="minimal">极简思考（Gemini 4 自动降为低）</option>
        <option value="model-default">恢复模型默认（清除预设思考限制）</option>
      </select>
    </label>
    <small>默认走原生结构化真流式秒出字；遇到高尺度安全截断或仅出思维链时，自动切原生函数通道无感补全。</small>
    <div class="pg-preset-hint" id="pg_preset_hint" hidden></div>
    <details id="pg_advanced_options">
      <summary>预设兼容与截停设置 <span id="pg_options_summary"></span></summary>
      <div class="pg-fields">
        <label class="checkbox_label">
          <input type="checkbox" id="pg_auto_rescue">
          <span>截断自动无感接力（强烈推荐）</span>
        </label>
        <small>流式输出若中途撞到上游安全截断，自动在同条消息内切换原生函数抗截断续完剩余正文与状态栏，不断文。</small>

        <label class="checkbox_label">
          <input type="checkbox" id="pg_meow_compat">
          <span>小猫兼容模式（Meowssiah）</span>
        </label>
        <small>自动识别小猫回复结构（思考 + 正文 + 自定义栏目），逐字流式吐出并保留完整上下文历史。</small>

        <label class="checkbox_label">
          <input type="checkbox" id="pg_auto_detect_tool">
          <span>自动兼容预设正文工具（4ACH / 图灵 / 莱莎 / Reborn 等）</span>
        </label>
        <small>自动保留工具描述里的完整写作规范，支持单字段与正文语义多字段工具。</small>

        <label>
          <span>手动指定正文工具名（可选）</span>
          <input class="text_pole" id="pg_transport_tool_name" placeholder="留空自动识别，例如 response_body 或 ryza_reply" maxlength="64" spellcheck="false">
        </label>

        <label class="checkbox_label">
          <input type="checkbox" id="pg_enable_plain">
          <span>普通无工具预设也启用结构化抗截断</span>
        </label>
        <small>不勾选时，无工具纯文本预设直接走 PG 原生流式最快；若预设带末尾助手预填充，勾选后也会自动放行保护预填充。</small>

        <label class="checkbox_label">
          <input type="checkbox" id="pg_only_proxy">
          <span>仅在使用反向代理时启用</span>
        </label>

        <label class="checkbox_label">
          <input type="checkbox" id="pg_tag_stop">
          <span>自定义标签截停</span>
        </label>
        <div class="pg-fields" id="pg_tag_stop_fields">
          <label>
            <span>截停标签名（不含尖括号）</span>
            <input class="text_pole" id="pg_stop_tag" maxlength="64" spellcheck="false">
          </label>
          <label>
            <span>豁免标签块（块内不计数，留空关闭）</span>
            <input class="text_pole" id="pg_stop_exempt_tag" maxlength="64" placeholder="例如 konatan_planning~" spellcheck="false">
          </label>
          <label>
            <span>完整出现次数</span>
            <input class="text_pole" id="pg_stop_count" type="number" min="1" step="1">
          </label>
        </div>
      </div>
    </details>
    <small class="pg-status" id="pg_streaming_status" role="status" aria-live="polite" hidden></small>
  `;

  parent.append(panel);

  const modeEl = panel.querySelector("#pg_streaming_mode");
  const thinkingEl = panel.querySelector("#pg_thinking_effort");
  const badgeEl = panel.querySelector("#pg_mode_badge");
  const advancedEl = panel.querySelector("#pg_advanced_options");
  const summaryEl = panel.querySelector("#pg_options_summary");
  const rescueEl = panel.querySelector("#pg_auto_rescue");
  const meowEl = panel.querySelector("#pg_meow_compat");
  const autoToolEl = panel.querySelector("#pg_auto_detect_tool");
  const toolNameEl = panel.querySelector("#pg_transport_tool_name");
  const plainEl = panel.querySelector("#pg_enable_plain");
  const proxyOnlyEl = panel.querySelector("#pg_only_proxy");
  const tagStopEl = panel.querySelector("#pg_tag_stop");
  const tagFieldsEl = panel.querySelector("#pg_tag_stop_fields");
  const stopTagEl = panel.querySelector("#pg_stop_tag");
  const stopExemptEl = panel.querySelector("#pg_stop_exempt_tag");
  const stopCountEl = panel.querySelector("#pg_stop_count");
  statusEl = panel.querySelector("#pg_streaming_status");
  presetHintEl = panel.querySelector("#pg_preset_hint");
  runtimeSummaryEl = panel.querySelector("#pg_runtime_summary");
  if (lastStatus.text) {
    setStatus(lastStatus.text, lastStatus.tone);
  }

  modeEl.value = s.mode;
  thinkingEl.value = s.thinkingEffort;
  rescueEl.checked = s.autoRescue !== false;
  meowEl.checked = s.meowCompat !== false;
  autoToolEl.checked = s.autoDetectTool !== false;
  toolNameEl.value = s.transportToolName ?? "";
  plainEl.checked = s.enableForPlain === true;
  proxyOnlyEl.checked = s.onlyReverseProxy === true;
  tagStopEl.checked = s.tagStop === true;
  stopTagEl.value = s.stopTag ?? "tucao";
  stopExemptEl.value = s.stopExemptTag ?? "";
  stopCountEl.value = String(s.stopCount ?? 2);

  function render() {
    const cur = getSettings();
    const enabled = cur.mode !== "off";
    if (cur.mode === "streaming") badgeEl.textContent = cur.autoRescue !== false ? "流式+防截断" : "真流式已开启";
    else if (cur.mode === "native-fc") badgeEl.textContent = "原生抗截断";
    else if (cur.mode === "buffered") badgeEl.textContent = "整段抗截断";
    else badgeEl.textContent = cur.thinkingEffort !== "preset" ? "仅思考生效" : "已关闭";
    badgeEl.style.opacity = enabled || cur.thinkingEffort !== "preset" ? "1" : "0.55";
    advancedEl.hidden = !enabled || cur.mode === "native-fc";
    tagFieldsEl.hidden = !cur.tagStop;

    const parts = [];
    if (cur.autoRescue !== false) parts.push("自动接力");
    if (cur.meowCompat) parts.push("小猫");
    if (cur.autoDetectTool) parts.push("自动工具");
    if (cur.transportToolName) parts.push(`指定 ${cur.transportToolName}`);
    if (cur.enableForPlain) parts.push("含纯文本");
    if (cur.onlyReverseProxy) parts.push("仅反代");
    if (cur.tagStop) parts.push(`第 ${cur.stopCount} 对 <${cur.stopTag}> 截停`);
    summaryEl.textContent = parts.join(" / ") || "基础模式";
    updatePresetHint();
  }

  modeEl.addEventListener("change", () => {
    saveSettings({ mode: modeEl.value });
    if (modeEl.value === "off" && inFlightMainReqId === null) setStatus("");
    render();
  });
  thinkingEl.addEventListener("change", () => {
    saveSettings({ thinkingEffort: thinkingEl.value });
    render();
  });
  rescueEl.addEventListener("change", () => { saveSettings({ autoRescue: rescueEl.checked }); render(); });
  meowEl.addEventListener("change", () => { saveSettings({ meowCompat: meowEl.checked }); render(); });
  autoToolEl.addEventListener("change", () => { saveSettings({ autoDetectTool: autoToolEl.checked }); render(); });
  toolNameEl.addEventListener("change", () => {
    const val = toolNameEl.value.trim();
    if (val && !TOOL_NAME_RE.test(val)) {
      toolNameEl.value = getSettings().transportToolName ?? "";
      setStatus("工具名须以字母或下划线开头，且不含尖括号与空格，已恢复上次设置。", "warn");
      return;
    }
    toolNameEl.value = val;
    saveSettings({ transportToolName: val });
    if (inFlightMainReqId === null) setStatus("");
    render();
  });
  plainEl.addEventListener("change", () => { saveSettings({ enableForPlain: plainEl.checked }); render(); });
  proxyOnlyEl.addEventListener("change", () => { saveSettings({ onlyReverseProxy: proxyOnlyEl.checked }); render(); });
  tagStopEl.addEventListener("change", () => { saveSettings({ tagStop: tagStopEl.checked }); render(); });
  stopTagEl.addEventListener("change", () => {
    const val = stopTagEl.value.trim();
    const curExempt = getSettings().stopExemptTag || "";
    if (!TAG_NAME_RE.test(val)) {
      stopTagEl.value = getSettings().stopTag || "tucao";
      setStatus("截停标签名须以字母或下划线开头，且仅含字母、数字、下划线、点、冒号、波浪号或连字符，已恢复上次设置。", "warn");
      return;
    }
    if (curExempt && val === curExempt) {
      stopTagEl.value = getSettings().stopTag || "tucao";
      setStatus("截停标签名不能与豁免标签相同，已恢复上次设置。", "warn");
      return;
    }
    stopTagEl.value = val;
    saveSettings({ stopTag: val });
    if (inFlightMainReqId === null) setStatus("");
    render();
  });
  stopExemptEl.addEventListener("change", () => {
    const val = stopExemptEl.value.trim();
    const curTag = getSettings().stopTag || "tucao";
    if (val && !TAG_NAME_RE.test(val)) {
      stopExemptEl.value = getSettings().stopExemptTag || "";
      setStatus("豁免标签名格式不合法，已恢复上次设置。", "warn");
      return;
    }
    if (val && val === curTag) {
      stopExemptEl.value = getSettings().stopExemptTag || "";
      setStatus("豁免标签不能与截停标签相同，已恢复上次设置。", "warn");
      return;
    }
    stopExemptEl.value = val;
    saveSettings({ stopExemptTag: val });
    if (inFlightMainReqId === null) setStatus("");
    render();
  });
  stopCountEl.addEventListener("change", () => {
    const n = Math.max(1, Math.floor(Number(stopCountEl.value) || 1));
    stopCountEl.value = String(n);
    saveSettings({ stopCount: n });
    render();
  });

  bindHostControlEvents();
  ensureMeowPreview();
  render();
}

installFetchInterceptor();
ensureMeowPreview();
bindGlobalListenersOnce();
if (document.getElementById("makersuite_form")) {
  mountPanel();
}
if (events?.APP_READY) context.eventSource.on(events.APP_READY, mountPanel);
if (events?.APP_INITIALIZED && events.APP_INITIALIZED !== events.APP_READY) {
  context.eventSource.on(events.APP_INITIALIZED, mountPanel);
}
