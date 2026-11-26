import { isObject, listFunctionTools, RESERVED_AUX_TOOLS, detectTransportTarget } from "./schema.mjs";

export const BODY_LIMIT = 8 * 1024 * 1024;
export const GENERATE_PATH = "/api/backends/chat-completions/generate";

const LOCAL_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1|tauri\.localhost|.+\.tauri\.localhost)$/i;

// 兼容桌面端与手机端 TauriTavern（含 tauri:// / https://tauri.localhost / 本地回环端口跨域）：
// 使用 location.href 作基准避免不透明 origin ("null") 触发 new URL 抛错导致手机端静默漏拦截。
export function resolveLocalGenerateUrl(input, init, pageHref = globalThis.location?.href || "http://localhost/") {
  const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
  if (!rawUrl) return null;
  const method = String(init?.method ?? (input && typeof input === "object" ? input.method : null) ?? "GET").toUpperCase();
  if (method !== "POST") return null;
  let url;
  let pageUrl = null;
  try {
    pageUrl = new URL(pageHref || "http://localhost/");
  } catch {
    pageUrl = new URL("http://localhost/");
  }
  try {
    url = new URL(rawUrl, pageUrl.href);
  } catch {
    return null;
  }
  if (url.pathname !== GENERATE_PATH) return null;
  const sameOrigin = url.origin !== "null" && pageUrl.origin !== "null" && url.origin === pageUrl.origin;
  const sameOpaqueScheme = url.protocol === pageUrl.protocol && url.hostname === pageUrl.hostname && url.port === pageUrl.port;
  const localHost = LOCAL_HOST_RE.test(url.hostname);
  if (!sameOrigin && !sameOpaqueScheme && !localHost) return null;
  return url;
}

export function hasPresetReplyTool(body) {
  const fns = listFunctionTools(body?.tools);
  return fns.some(fn => fn?.name && !RESERVED_AUX_TOOLS.has(fn.name));
}

export const CONTINUATION_INSTRUCTION =
  "请严格承接上方未写完的回复末尾继续往下写，只输出需要追加的新增内容；严禁重复、总结、重新输出开头的思考块或已打开的外层标签，保持原本的语言、人称、格式并自然收束未闭合标签。";

export const VALID_THINKING_EFFORTS = new Set(["preset", "minimal", "low", "medium", "high", "model-default"]);

const FORBIDDEN_INCLUDE_KEYS = new Set([
  "tools",
  "toolConfig",
  "tool_config",
  "tool_choice",
  "functions",
  "function_call",
  "generationConfig",
  "generation_config",
]);

const REASONING_KEYS = new Set(["reasoning_effort", "reasoningEffort"]);

const GEMINI_4_RE = /^(?:models\/)?gemini-4/i;
const GEMINI_25_OR_3_RE = /^(?:models\/)?gemini-(?:2\.5|3)/i;
const GEMINI_65K_CAP_RE = /^(?:models\/)?gemini-(?:2\.5|3|4)/i;

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingCommas(jsonText) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < jsonText.length && /\s/.test(jsonText[j])) j++;
      if (jsonText[j] === "}" || jsonText[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

// 剥离 YAML 标量值末尾的 # 注释（保留引号内的 #）
function stripYamlInlineComment(text) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trim();
    }
  }
  return text.trim();
}

function unquoteYamlScalar(raw) {
  const s = stripYamlInlineComment(raw);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// 尝试把简单的单层/双层 YAML 流式映射（如 { reasoning_effort: max, 'top_p': 0.9 }）规范化为 JSON 解析
function tryParseJsonOrFlowMap(text) {
  try {
    const parsed = JSON.parse(text);
    if (isObject(parsed)) return { obj: parsed, fixedSyntax: false };
  } catch {
    // 尝试去尾逗号
    try {
      const parsed = JSON.parse(stripTrailingCommas(text));
      if (isObject(parsed)) return { obj: parsed, fixedSyntax: true };
    } catch {
      // 尝试轻量单引号/裸键流式映射转标准 JSON（仅在不含复杂 YAML 锚点时）
      try {
        const normalized = stripTrailingCommas(text)
          .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => JSON.stringify(inner.replace(/\\'/g, "'")))
          .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_.-]*)(\s*:)/g, '$1"$2"$3')
          .replace(/:\s*(max|xhigh|extra_high|maximum|none|minimal|low|medium|high|off)(?=\s*[,}])/gi, (_, val) => `: ${JSON.stringify(val)}`);
        const parsed = JSON.parse(normalized);
        if (isObject(parsed)) return { obj: parsed, fixedSyntax: true };
      } catch {
        return null;
      }
    }
  }
  return null;
}

// 解析 YAML（对象映射 / 对象列表 / 流式映射）或 JSON（含前导注释与尾逗号容错）
function parseCustomInclude(raw) {
  if (raw == null || raw === "") return { format: "empty", obj: {} };
  if (isObject(raw)) return { format: "object", obj: { ...raw } };
  if (typeof raw !== "string") return { format: "raw", raw };

  const rawLines = raw.split(/\r?\n/);
  // 先过滤纯注释行和空行，判断是否本质为 JSON / 流式映射（修复 "# 注释\n{...}" 被误判为 YAML 块导致语法崩坏）
  const contentLines = rawLines.filter(line => {
    const t = line.trim();
    return t.length > 0 && !t.startsWith("#") && t !== "---" && t !== "...";
  });
  if (contentLines.length === 0) return { format: "empty", obj: {} };

  const strippedContent = contentLines.join("\n").trim();
  if (strippedContent.startsWith("{") && strippedContent.endsWith("}")) {
    const parsed = tryParseJsonOrFlowMap(strippedContent);
    if (parsed) {
      return { format: "json", obj: parsed.obj, fixedSyntax: parsed.fixedSyntax };
    }
    return { format: "raw", raw };
  }

  // 检测 TT custom_parameters.rs 支持的 YAML 对象列表（如 "- reasoning_effort: max\n- seed: 1"）
  const firstNonEmpty = contentLines[0];
  const baseIndent = firstNonEmpty.length - firstNonEmpty.trimStart().length;
  if (firstNonEmpty.trimStart().startsWith("- ")) {
    const items = [];
    let current = null;
    for (const line of rawLines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) {
        if (current) current.lines.push(line);
        else items.push({ key: null, lines: [line], scalar: "" });
        continue;
      }
      const indent = line.length - line.trimStart().length;
      const itemMatch = /^\s*-\s+([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*:(.*)$/.exec(line);
      if (itemMatch && indent <= baseIndent) {
        const rawKey = itemMatch[1].replace(/^['"]|['"]$/g, "");
        const scalar = unquoteYamlScalar(itemMatch[2]);
        current = { key: rawKey, lines: [line], scalar, indent: line.slice(0, indent) };
        items.push(current);
      } else if (current) {
        current.lines.push(line);
      } else {
        items.push({ key: null, lines: [line], scalar: "" });
      }
    }
    return { format: "yaml-list", blocks: items, indent: " ".repeat(baseIndent) };
  }

  // 常规 YAML 映射（容忍统一前导缩进，保留注释与无关嵌套块原文不失真）
  const blocks = [];
  let current = null;
  for (const line of rawLines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      if (current) current.lines.push(line);
      else blocks.push({ key: null, lines: [line], scalar: "" });
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const topMatch = /^\s*([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*:(.*)$/.exec(line);
    if (topMatch && indent <= baseIndent) {
      const rawKey = topMatch[1].replace(/^['"]|['"]$/g, "");
      const scalar = unquoteYamlScalar(topMatch[2]);
      current = { key: rawKey, lines: [line], scalar, indent: line.slice(0, indent) };
      blocks.push(current);
    } else if (current && indent > baseIndent) {
      current.lines.push(line);
    } else {
      current = null;
      blocks.push({ key: null, lines: [line], scalar: "" });
    }
  }
  return { format: "yaml", blocks, indent: " ".repeat(baseIndent) };
}

function serializeCustomInclude(state) {
  if (state.format === "empty") return "";
  if (state.format === "raw") return state.raw;
  if (state.format === "object") return state.obj;
  if (state.format === "json") {
    return Object.keys(state.obj).length > 0 ? JSON.stringify(state.obj) : "";
  }
  return state.blocks.flatMap(b => b.lines).join("\n").trim();
}

function normalizeInvalidReasoningValue(val) {
  if (typeof val !== "string") return val;
  const low = val.trim().toLowerCase();
  if (low === "max" || low === "xhigh" || low === "extra_high" || low === "maximum") return "high";
  return val;
}

// 统一净化 custom_include_body（支持 JSON、尾逗号 JSON、前导注释+JSON、流式映射、YAML 映射与 YAML 对象列表）
export function transformCustomIncludeBody(raw, options = {}) {
  const {
    stripConflictingKeys = false,
    sanitizeMaxReasoning = true,
    setReasoningKey = null,
    setReasoningValue = null,
    clearReasoning = false,
  } = options;

  const state = parseCustomInclude(raw);
  let changed = Boolean(state.fixedSyntax);

  if (state.format === "raw") {
    // 不可安全解析的原文绝不盲目拼接破坏语法
    return { value: raw, changed: false };
  }

  if (state.format === "empty") {
    if (setReasoningKey && setReasoningValue) {
      return { value: JSON.stringify({ [setReasoningKey]: setReasoningValue }), changed: true };
    }
    return { value: raw ?? "", changed: false };
  }

  if (state.format === "json" || state.format === "object") {
    const obj = { ...state.obj };
    if (stripConflictingKeys) {
      for (const k of FORBIDDEN_INCLUDE_KEYS) {
        if (Object.hasOwn(obj, k)) {
          delete obj[k];
          changed = true;
        }
      }
    }
    if (clearReasoning || (setReasoningKey && setReasoningValue)) {
      for (const k of REASONING_KEYS) {
        if (Object.hasOwn(obj, k)) {
          delete obj[k];
          changed = true;
        }
      }
      if (setReasoningKey && setReasoningValue) {
        obj[setReasoningKey] = setReasoningValue;
        changed = true;
      }
    } else if (sanitizeMaxReasoning) {
      for (const k of REASONING_KEYS) {
        if (Object.hasOwn(obj, k)) {
          const fixed = normalizeInvalidReasoningValue(obj[k]);
          if (fixed !== obj[k]) {
            obj[k] = fixed;
            changed = true;
          }
        }
      }
    }
    return {
      value: changed ? serializeCustomInclude({ format: state.format, obj }) : raw,
      changed,
    };
  }

  // YAML 映射 或 YAML 对象列表
  const isList = state.format === "yaml-list";
  const prefix = isList ? `${state.indent}- ` : state.indent;
  let blocks = state.blocks.map(b => ({ ...b, lines: [...b.lines] }));

  if (stripConflictingKeys) {
    const before = blocks.length;
    blocks = blocks.filter(b => !b.key || !FORBIDDEN_INCLUDE_KEYS.has(b.key));
    if (blocks.length !== before) changed = true;
  }
  if (clearReasoning || (setReasoningKey && setReasoningValue)) {
    const before = blocks.length;
    blocks = blocks.filter(b => !b.key || !REASONING_KEYS.has(b.key));
    if (blocks.length !== before) changed = true;
    if (setReasoningKey && setReasoningValue) {
      blocks.push({
        key: setReasoningKey,
        lines: [`${prefix}${setReasoningKey}: ${setReasoningValue}`],
        scalar: setReasoningValue,
      });
      changed = true;
    }
  } else if (sanitizeMaxReasoning) {
    for (const b of blocks) {
      if (b.key && REASONING_KEYS.has(b.key)) {
        const fixed = normalizeInvalidReasoningValue(b.scalar);
        if (fixed !== b.scalar) {
          const linePrefix = isList ? `${b.indent ?? state.indent}- ` : (b.indent ?? state.indent);
          b.lines = [`${linePrefix}${b.key}: ${fixed}`];
          b.scalar = fixed;
          changed = true;
        }
      }
    }
  }

  return {
    value: changed ? serializeCustomInclude({ format: state.format, blocks }) : raw,
    changed,
  };
}

// 从 custom_exclude_body 中移除 generationConfig（兼容 JSON/单引号/裸流式数组、YAML 列表与 YAML Map 四种写法）
export function stripGenerationConfigFromExclude(raw) {
  const DROP = new Set(["generationConfig", "generation_config"]);
  if (Array.isArray(raw)) {
    const next = raw.filter(item => !DROP.has(String(item).trim()));
    return { value: next, changed: next.length !== raw.length };
  }
  if (typeof raw !== "string" || !raw.trim()) return { value: raw, changed: false };
  const trimmed = raw.trim();

  // 流式数组：["generationConfig", "seed"] / ['generationConfig', 'seed'] / [generationConfig, seed]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return { value: raw, changed: false };
    const items = inner.split(",").map(s => s.trim()).filter(Boolean);
    const kept = items.filter(item => !DROP.has(unquoteYamlScalar(item)));
    if (kept.length !== items.length) {
      return { value: `[${kept.join(", ")}]`, changed: true };
    }
    return { value: raw, changed: false };
  }

  const lines = raw.split(/\r?\n/);
  const kept = lines.filter(line => {
    const noComment = stripYamlInlineComment(line);
    if (!noComment) return true;
    // 兼容 YAML Map（如 "generationConfig: true"）与 YAML 列表项（如 "- generationConfig"）
    const mapMatch = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*:/.exec(noComment);
    if (mapMatch) {
      const k = mapMatch[1].replace(/^['"]|['"]$/g, "");
      return !DROP.has(k);
    }
    const listItem = noComment.replace(/^-\s*/, "").replace(/,$/, "").trim();
    return !DROP.has(unquoteYamlScalar(listItem));
  });
  if (kept.length !== lines.length) {
    return { value: kept.join("\n").trim(), changed: true };
  }
  return { value: raw, changed: false };
}

// 公共前置预处理：安全应用 PG 思考档位 + 修正 17 预设 max 400 + 65536 上限保护
// 对 quiet/impersonate/并发后台请求仅执行防 400 修正（max->high 与 65535 上限），不覆盖用户思考档位。
export function applyMakerSuitePreprocess(body, settings = {}, { crashFixOnly = false } = {}) {
  if (!body || body.chat_completion_source !== "makersuite") {
    return { body, modified: false, thinkingApplied: null, thinkingDowngradedFrom: null, fixedMaxReasoning: false };
  }
  const model = String(body.model ?? "");
  if (!/^(?:models\/)?gemini-[\w.-]+$/i.test(model) || /image|embedding|tts|veo/i.test(model)) {
    return { body, modified: false, thinkingApplied: null, thinkingDowngradedFrom: null, fixedMaxReasoning: false };
  }
  if (settings.onlyReverseProxy && !body.reverse_proxy) {
    return { body, modified: false, thinkingApplied: null, thinkingDowngradedFrom: null, fixedMaxReasoning: false };
  }

  const isSilentType = crashFixOnly || body.type === "quiet" || body.type === "impersonate";
  const effort = isSilentType
    ? "preset"
    : (VALID_THINKING_EFFORTS.has(settings.thinkingEffort) ? settings.thinkingEffort : "preset");

  const nextBody = { ...body };
  let modified = false;
  let thinkingApplied = null;
  let thinkingDowngradedFrom = null;
  let fixedMaxReasoning = false;

  // 1. 思考档位双轨路由
  if (effort === "model-default") {
    let clearedAny = false;
    const res = transformCustomIncludeBody(nextBody.custom_include_body, { clearReasoning: true });
    if (res.changed) {
      nextBody.custom_include_body = res.value;
      modified = true;
      clearedAny = true;
    }
    if (nextBody.reasoning_effort !== undefined) {
      delete nextBody.reasoning_effort;
      modified = true;
      clearedAny = true;
    }
    if (clearedAny) thinkingApplied = "model-default";
  } else if (effort !== "preset") {
    if (GEMINI_4_RE.test(model)) {
      // 活体实测：gemini-4-carbon 拒绝 minimal 报 HTTP 400，Gemini 4 自动平滑降档为 low！
      const effectiveEffort = effort === "minimal" ? "low" : effort;
      if (effort === "minimal") thinkingDowngradedFrom = "minimal";
      const res = transformCustomIncludeBody(nextBody.custom_include_body, {
        setReasoningKey: "reasoningEffort",
        setReasoningValue: effectiveEffort,
      });
      if (res.changed) {
        nextBody.custom_include_body = res.value;
        modified = true;
      }
      if (nextBody.reasoning_effort !== undefined) {
        delete nextBody.reasoning_effort;
        modified = true;
      }
      thinkingApplied = effectiveEffort;
    } else if (GEMINI_25_OR_3_RE.test(model)) {
      const res = transformCustomIncludeBody(nextBody.custom_include_body, { clearReasoning: true });
      if (res.changed) {
        nextBody.custom_include_body = res.value;
        modified = true;
      }
      if (nextBody.reasoning_effort !== effort) {
        nextBody.reasoning_effort = effort;
        modified = true;
      }
      thinkingApplied = effort;
    }
  } else if (nextBody.custom_include_body !== undefined) {
    // 跟随预设默认（含 quiet/测试连接）：自动修正 17 个本机预设里的 reasoning_effort: max -> high，避免 aistudio-api 400
    const res = transformCustomIncludeBody(nextBody.custom_include_body, { sanitizeMaxReasoning: true });
    if (res.changed) {
      nextBody.custom_include_body = res.value;
      modified = true;
      fixedMaxReasoning = true;
    }
  }

  // 2. Gemini 2.5 / 3 / 4 单次输出上限保护（覆盖图灵 4A 500000 等超大预设值）
  const maxTok = Number(nextBody.max_tokens);
  if (GEMINI_65K_CAP_RE.test(model) && Number.isFinite(maxTok) && maxTok > 65536) {
    nextBody.max_tokens = 65535;
    modified = true;
  }

  return { body: nextBody, modified, thinkingApplied, thinkingDowngradedFrom, fixedMaxReasoning };
}

function hasAssistantPrefill(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || Array.isArray(last.tool_calls)) return false;
  if (typeof last.content === "string") return last.content.trim().length > 0;
  if (Array.isArray(last.content)) {
    return last.content.some(p => p?.type === "text" && typeof p.text === "string" && p.text.trim().length > 0);
  }
  return false;
}

export function checkPgBypass(body, settings) {
  if (!settings || settings.mode === "off") return "disabled";
  if (body?.chat_completion_source !== "makersuite") return "other-provider";
  if (body.type === "quiet") return "quiet-request";
  if (body.type === "impersonate") return "impersonate-request";
  if (settings.mode === "native-fc") return "native-fc-mode";
  if (settings.onlyReverseProxy && !body.reverse_proxy) return "not-reverse-proxy";
  const model = String(body.model ?? "");
  if (!/^(?:models\/)?gemini-[\w.-]+$/i.test(model) || /image|embedding|tts|veo/i.test(model)) return "model";
  if (body.request_images) return "image-generation";
  if (body.enable_web_search) return "web-search";
  if ((body.n != null && body.n !== 1) || (body.best_of != null && body.best_of !== 1)) return "multiple-candidates";
  const genCfg = body.generationConfig ?? body.generation_config;
  if (
    body.json_schema
    || body.responseSchema
    || body.response_schema
    || (body.responseMimeType && body.responseMimeType !== "text/plain")
    || (body.response_mime_type && body.response_mime_type !== "text/plain")
    || genCfg?.responseSchema
    || genCfg?.response_schema
    || (genCfg?.responseMimeType && genCfg.responseMimeType !== "text/plain")
    || (genCfg?.response_mime_type && genCfg.response_mime_type !== "text/plain")
    || (body.response_format && body.response_format.type !== "text")
  ) {
    return "structured-output";
  }
  return null;
}

function appendNoteToLastUser(cloned, fullNote) {
  const last = cloned.at(-1);
  if (last?.role === "user" && typeof last.content === "string") {
    cloned[cloned.length - 1] = { ...last, content: `${last.content}\n\n${fullNote}` };
  } else if (last?.role === "user" && Array.isArray(last.content)) {
    cloned[cloned.length - 1] = { ...last, content: [...last.content, { type: "text", text: `\n\n${fullNote}` }] };
  } else {
    cloned.push({ role: "user", content: fullNote });
  }
}

function rewriteMeowMessages(messages, fieldOrder) {
  const cloned = messages.map(msg => (isObject(msg) ? { ...msg } : msg));
  const fieldHint = fieldOrder.join("、");
  let rewroteStatus = false;

  for (let i = cloned.length - 1; i >= Math.max(0, cloned.length - 4); i--) {
    const msg = cloned[i];
    if (!msg) continue;
    if (msg.role === "tool" && (msg.name === "context" || msg.tool_call_id === "call_sync_final") && typeof msg.content === "string") {
      try {
        const parsed = JSON.parse(msg.content);
        if (isObject(parsed) && typeof parsed.status === "string") {
          let nextStatus = parsed.status
            .replace(/立刻调用\s*`?soliumbra_reply`?\s*工具?/g, `直接输出符合 soliumbra_reply 结构的 JSON 对象（按顺序包含 ${fieldHint} 字段，不要调用工具）`)
            .replace(/这就调用\s*`?soliumbra_reply`?/g, `这就直接输出符合 soliumbra_reply 结构的 JSON 对象（按顺序包含 ${fieldHint} 字段，不要调用工具）`)
            .replace(/调用\s*`?soliumbra_reply`?/g, `直接输出符合 soliumbra_reply 结构的 JSON 对象（不要调用工具）`);
          if (nextStatus === parsed.status) {
            nextStatus = `${parsed.status}\n（请直接输出符合 schema 结构的 JSON 对象，依次填写 ${fieldHint}，不要再发起工具调用喵！）`;
          }
          cloned[i] = { ...msg, content: JSON.stringify({ ...parsed, status: nextStatus }) };
          rewroteStatus = true;
          break;
        }
      } catch {
        // 非 JSON 的 tool content 走统一指令补足
      }
    }
  }

  for (let i = cloned.length - 1; i >= Math.max(0, cloned.length - 4); i--) {
    const msg = cloned[i];
    if (msg?.role === "assistant" && typeof msg.content === "string" && msg.content.includes("soliumbra_reply")) {
      cloned[i] = {
        ...msg,
        content: msg.content
          .replace(/然后立刻调用\s*`?soliumbra_reply`?\s*工具/g, `然后直接输出符合 soliumbra_reply 结构的 JSON 对象（按顺序填写 ${fieldHint}）`)
          .replace(/立刻调用\s*`?soliumbra_reply`?\s*工具/g, `直接输出符合 soliumbra_reply 结构的 JSON 对象`),
      };
      break;
    }
  }

  if (!rewroteStatus) {
    appendNoteToLastUser(
      cloned,
      `传输格式要求：请直接输出符合 responseSchema 的单个 JSON 对象（按顺序包含 ${fieldHint} 字符串字段），不要发起工具调用。`,
    );
  }

  return cloned;
}

function rewriteToolPhrasing(text, toolName, fieldDesc) {
  if (typeof text !== "string" || !toolName || !text.includes(toolName)) return text;
  const escaped = escapeRegExp(toolName);
  return text
    .replace(
      new RegExp(`(都|全|已经)?放在\\s*\`?${escaped}\`?\\s*(工具)?里`, "g"),
      `$1放在本次请求的 responseSchema（原 ${toolName} 说明）里`,
    )
    .replace(
      new RegExp(`(记得|请|务必|立刻|这就)?调用(一次)?\\s*\`?${escaped}\`?\\s*(工具)?`, "g"),
      `$1直接输出符合 responseSchema 的 JSON 对象（按要求填写 ${fieldDesc}，无需调用工具）`,
    )
    .replace(
      new RegExp(`(?:call|invoke|use)\\s+(?:the\\s+)?\`?${escaped}\`?\\s+(?:function|tool)(?:\\s+exactly\\s+once)?`, "gi"),
      `output a single JSON object matching responseSchema (${fieldDesc}) directly without calling any tool`,
    )
    .replace(
      new RegExp(`in\\s+its\\s+\`?[a-zA-Z0-9_]+\`?\\s+(?:argument|parameter|field)`, "gi"),
      `in the JSON ${fieldDesc}`,
    );
}

// 对 role: "tool" 的 JSON 字符串做结构化重写，绝不往 JSON 内注入未转义双引号破坏结构
function rewriteToolMessageContent(content, toolName, fieldDesc) {
  if (typeof content !== "string" || !content.includes(toolName)) return { content, rewroteJsonStatus: false };
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isObject(parsed)) {
        let changed = false;
        let rewroteJsonStatus = false;
        const next = { ...parsed };
        for (const [k, v] of Object.entries(next)) {
          if (typeof v === "string" && v.includes(toolName)) {
            const rewritten = rewriteToolPhrasing(v, toolName, fieldDesc);
            if (rewritten !== v) {
              next[k] = rewritten;
              changed = true;
              if (k === "status") rewroteJsonStatus = true;
            }
          }
        }
        return { content: changed ? JSON.stringify(next) : content, rewroteJsonStatus };
      }
    } catch {
      // 非合法 JSON 走纯文本替换
    }
  }
  return { content: rewriteToolPhrasing(content, toolName, fieldDesc), rewroteJsonStatus: false };
}

function rewriteRecentToolMessages(cloned, toolName, fieldDesc) {
  if (!toolName || toolName === "pg_stream_reply") return { rewroteLastToolStatus: false };
  let rewroteLastToolStatus = false;
  const tailStart = Math.max(0, cloned.length - 4);

  for (let i = cloned.length - 1; i >= 0; i--) {
    const msg = cloned[i];
    if (!msg) continue;
    // system 层的英文控制口令（4ACH / 图灵 4A4C / 我即浪潮）可能位于锚点处而非末 4 条，需全量扫描 system
    const inTail = i >= tailStart;
    if (!inTail && msg.role !== "system") continue;

    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.includes(toolName)) {
      const res = rewriteToolMessageContent(msg.content, toolName, fieldDesc);
      if (res.content !== msg.content) {
        cloned[i] = { ...msg, content: res.content };
        if (i === cloned.length - 1 && res.rewroteJsonStatus) rewroteLastToolStatus = true;
      }
    } else if (msg.role === "user" || msg.role === "assistant" || msg.role === "system") {
      if (typeof msg.content === "string" && msg.content.includes(toolName)) {
        cloned[i] = { ...msg, content: rewriteToolPhrasing(msg.content, toolName, fieldDesc) };
      } else if (Array.isArray(msg.content)) {
        let changed = false;
        const nextParts = msg.content.map(part => {
          if (part?.type === "text" && typeof part.text === "string" && part.text.includes(toolName)) {
            changed = true;
            return { ...part, text: rewriteToolPhrasing(part.text, toolName, fieldDesc) };
          }
          return part;
        });
        if (changed) cloned[i] = { ...msg, content: nextParts };
      }
    }
  }
  return { rewroteLastToolStatus };
}

function appendJsonInstruction(messages, target) {
  const cloned = messages.map(msg => (isObject(msg) ? { ...msg } : msg));
  const isPresetTool = Boolean(target.toolName && target.toolName !== "pg_stream_reply");

  if (target.kind === "multi-field") {
    const fieldHint = target.fieldOrder.join("、");
    const { rewroteLastToolStatus } = rewriteRecentToolMessages(cloned, target.toolName, `${fieldHint} 字段`);
    if (rewroteLastToolStatus) {
      // 末尾如为 call_ryza_sync_final 的 JSON tool response 且已改写 status，直接补充说明避免追加多余 user 轮次
      const last = cloned.at(-1);
      try {
        const parsed = JSON.parse(last.content);
        parsed.status = `${parsed.status}\n【流式传输格式覆盖】原 ${target.toolName} 规范已保留在 responseSchema.description 中，请直接按顺序输出包含 ${fieldHint} 字段的单个 JSON 对象。`;
        cloned[cloned.length - 1] = { ...last, content: JSON.stringify(parsed) };
        return cloned;
      } catch {
        // 回退追加
      }
    }
    const note = `【流式传输格式覆盖】原 ${target.toolName} 工具的完整规范已保留在 responseSchema.description 中。本次无需调用任何工具，请直接输出严格符合 responseSchema 的单个 JSON 对象，按顺序填写 ${fieldHint} 字符串字段，不要在 JSON 外输出任何额外说明。`;
    appendNoteToLastUser(cloned, note);
    return cloned;
  }

  const fieldName = target.fieldName || "content";
  if (isPresetTool) {
    rewriteRecentToolMessages(cloned, target.toolName, `「${fieldName}」字段`);
  }

  const note = isPresetTool
    ? `【流式传输格式覆盖】原 ${target.toolName} 工具的完整规范已全部保留在本请求的 responseSchema.description 中。本次无需调用任何工具，请直接输出严格符合 responseSchema 的单个 JSON 对象 {"${fieldName}": "..."}，将全部完整的用户可见回复内容（保留所有要求的标签、分段与格式）完整写入 "${fieldName}" 字符串中，不要在 JSON 外输出任何额外说明。`
    : `【传输格式】请直接输出严格符合 responseSchema 的单个 JSON 对象 {"${fieldName}": "..."}，将全部完整的用户可见回复内容（保留所有要求的语言、分段、标签与排版）完整写入 "${fieldName}" 字符串中，不要在 JSON 外输出多余文字。`;

  appendNoteToLastUser(cloned, note);
  return cloned;
}

// 专用续写改写：避免 continue_prefill 下在小猫/多字段模式里重新套出双层 <think_nya> 和 <game>
function rewriteContinuationMessages(messages, originalToolName) {
  const cloned = messages.map(msg => (isObject(msg) ? { ...msg } : msg));
  if (originalToolName && originalToolName !== "pg_stream_reply") {
    rewriteRecentToolMessages(cloned, originalToolName, "「continuation」续写字段");
  }
  const note = `【流式续写格式】本次为续写请求，无需调用任何工具，也不要重新生成思考块或重复已有外层开标签。请直接输出单个 JSON 对象 {"continuation": "..."}，仅在 "continuation" 字符串中写入紧接前文末尾的新增续写文本。\n${CONTINUATION_INSTRUCTION}`;
  appendNoteToLastUser(cloned, note);
  return cloned;
}

export function preparePgRequest(body, settings, tagStop = null, runtimeOptions = {}) {
  const isBackground = Boolean(runtimeOptions.isBackground);
  const pre = applyMakerSuitePreprocess(body, settings, { crashFixOnly: isBackground });
  const workingBody = pre.body;

  if (isBackground) {
    return {
      bypass: "background-request",
      silent: true,
      preprocessedBody: pre.modified ? workingBody : null,
      thinkingApplied: null,
      thinkingDowngradedFrom: null,
      fixedMaxReasoning: pre.fixedMaxReasoning,
    };
  }

  const bypass = checkPgBypass(workingBody, settings);
  if (bypass) {
    return {
      bypass,
      silent: bypass === "quiet-request" || bypass === "impersonate-request",
      preprocessedBody: pre.modified ? workingBody : null,
      thinkingApplied: pre.thinkingApplied,
      thinkingDowngradedFrom: pre.thinkingDowngradedFrom,
      fixedMaxReasoning: pre.fixedMaxReasoning,
    };
  }

  const detected = detectTransportTarget(workingBody, {
    meowCompat: settings.meowCompat !== false,
    autoDetectTool: settings.autoDetectTool !== false,
    transportToolName: settings.transportToolName ?? "",
    enableForPlain: settings.enableForPlain === true,
  });
  if (detected.bypass) {
    return {
      bypass: detected.bypass,
      preprocessedBody: pre.modified ? workingBody : null,
      thinkingApplied: pre.thinkingApplied,
      thinkingDowngradedFrom: pre.thinkingDowngradedFrom,
      fixedMaxReasoning: pre.fixedMaxReasoning,
    };
  }

  const continuation = workingBody.type === "continue";

  // 勾选普通纯文本预设时，若检测到末尾非空 Assistant Prefill（非继续模式），自动放行避免破坏预填充结构
  if (!continuation && detected.kind === "builtin-json" && hasAssistantPrefill(workingBody.messages)) {
    return {
      bypass: "assistant-prefill",
      preprocessedBody: pre.modified ? workingBody : null,
      thinkingApplied: pre.thinkingApplied,
      thinkingDowngradedFrom: pre.thinkingDowngradedFrom,
      fixedMaxReasoning: pre.fixedMaxReasoning,
    };
  }

  // Continue 模式统一改用无外壳纯续写单字段 Schema，防止小猫/莱莎二次包裹破坏已打开的正文标签
  const target = continuation
    ? {
        kind: "continuation",
        toolName: detected.toolName,
        fieldName: "continuation",
        description: detected.description || "",
        schema: {
          type: "OBJECT",
          ...(detected.description ? { description: detected.description } : {}),
          properties: {
            continuation: {
              type: "STRING",
              description: CONTINUATION_INSTRUCTION,
            },
          },
          required: ["continuation"],
          propertyOrdering: ["continuation"],
        },
      }
    : detected;

  const upstreamStream = settings.mode === "streaming" && workingBody.stream === true;
  const nextBody = { ...workingBody };

  // 移除全部工具与工具选择键，改为 responseMimeType + responseSchema 真流式解码通道
  delete nextBody.tools;
  delete nextBody.tool_choice;
  delete nextBody.toolConfig;
  delete nextBody.tool_config;
  delete nextBody.functions;
  delete nextBody.function_call;

  // 同步净化 custom_include_body 与 custom_exclude_body，
  // 防止 TT 后端顶层浅覆盖重新塞入 tools 或抹杀 generationConfig
  if (nextBody.custom_include_body !== undefined) {
    const cleaned = transformCustomIncludeBody(nextBody.custom_include_body, {
      stripConflictingKeys: true,
      sanitizeMaxReasoning: false,
    });
    nextBody.custom_include_body = cleaned.value;
  }
  if (nextBody.custom_exclude_body !== undefined) {
    const cleanedEx = stripGenerationConfigFromExclude(nextBody.custom_exclude_body);
    nextBody.custom_exclude_body = cleanedEx.value;
  }

  nextBody.stream = true;
  nextBody.responseMimeType = "application/json";
  nextBody.responseSchema = target.schema;

  if (Array.isArray(nextBody.messages)) {
    if (continuation) {
      nextBody.messages = rewriteContinuationMessages(nextBody.messages, detected.toolName);
    } else if (target.kind === "soliumbra") {
      nextBody.messages = rewriteMeowMessages(nextBody.messages, target.fieldOrder);
    } else {
      nextBody.messages = appendJsonInstruction(nextBody.messages, target);
    }
  }

  return {
    body: nextBody,
    originalWorkingBody: workingBody,
    target,
    model: workingBody.model,
    stream: workingBody.stream === true,
    upstreamStream,
    mode: settings.mode,
    autoRescue: settings.autoRescue !== false,
    continuation,
    tagStop,
    thinkingApplied: pre.thinkingApplied,
    thinkingDowngradedFrom: pre.thinkingDowngradedFrom,
    fixedMaxReasoning: pre.fixedMaxReasoning,
  };
}

// 去除接力续写开头偶发重复前文末尾的 2~60 字重叠，保证拼接无缝
export function dedupeContinuationOverlap(existingText, rescueText) {
  if (!existingText || !rescueText) return rescueText || "";
  const maxCheck = Math.min(60, existingText.length, rescueText.length);
  for (let len = maxCheck; len >= 2; len--) {
    if (existingText.endsWith(rescueText.slice(0, len))) {
      return rescueText.slice(len);
    }
  }
  // 容忍续写开头多出一个换行后再重复末尾短语
  if (rescueText.startsWith("\n")) {
    const trimmed = rescueText.replace(/^\n+/, "");
    const max2 = Math.min(60, existingText.length, trimmed.length);
    for (let len = max2; len >= 3; len--) {
      if (existingText.endsWith(trimmed.slice(0, len))) {
        return trimmed.slice(len);
      }
    }
  }
  return rescueText;
}

// 构造截断无感接力请求体（走原生 functionCall 抗截断通道，彻底规避 PROHIBITED_CONTENT 输出截断）
export function buildRescueRequestBody(prepared, settings, rescueCtx = {}) {
  const {
    mode = "continue",      // "continue" | "full-fallback"
    reason = "",
    collectedText = "",
    openFieldKey = "",
    openWrapperTag = null,
  } = rescueCtx;

  const base = prepared.originalWorkingBody ? { ...prepared.originalWorkingBody } : { ...prepared.body };
  delete base.responseMimeType;
  delete base.response_mime_type;
  delete base.responseSchema;
  delete base.response_schema;
  base.stream = true;

  // 若用户思考强度为 preset 且模型为 Gemini 4，接力阶段默认用 low 提速（实测 65s 稳出 3200+ 字）
  const model = String(base.model ?? "");
  const effort = settings?.thinkingEffort || "preset";
  if (effort === "preset" && GEMINI_4_RE.test(model)) {
    const res = transformCustomIncludeBody(base.custom_include_body, {
      stripConflictingKeys: true,
      setReasoningKey: "reasoningEffort",
      setReasoningValue: "low",
    });
    base.custom_include_body = res.value;
    delete base.reasoning_effort;
  } else if (base.custom_include_body !== undefined) {
    const res = transformCustomIncludeBody(base.custom_include_body, {
      stripConflictingKeys: true,
      sanitizeMaxReasoning: true,
    });
    base.custom_include_body = res.value;
  }

  // 模式 A：0 字拦截全量回退——直接保留原始预设工具（soliumbra_reply / response_body / ryza_reply）走原生 functionCall
  if (mode === "full-fallback" && Array.isArray(base.tools) && base.tools.length > 0) {
    return {
      body: base,
      rescueToolName: prepared.target?.toolName || "",
      rescueTarget: prepared.target,
    };
  }

  // 模式 B：半句截断无缝续写——用通用 continuation_reply functionCall 接力续完剩余正文与全部后续栏目
  const toolDesc = prepared.target?.description
    ? `${prepared.target.description}\n\n【接力续写任务】严格紧接前文中断处续写剩余内容、闭合未完成标签并补全所有要求的后续栏目与变量更新，严禁重复前文。`
    : "无缝续写上方被中断的完整回复剩余部分（仅包含从中断处接着往下写的新增内容，不要重复前文）。";

  const tailSnippet = collectedText.slice(-36).replace(/\r?\n/g, " ");
  let tagHint = "";
  if (reason === "MISSING_BODY_STOP") {
    tagHint = prepared.target?.kind === "soliumbra"
      ? "你刚才只完成了 <think_nya> 思考规划，尚未写出正式正文。请直接输出完整的 <game>...</game> 正文以及所有要求的选项、摘要、评论与变量更新，严禁再重复输出 <think_nya> 思考块！"
      : "你刚才只完成了思考规划，尚未写出正式正文。请直接写出完整正文以及所有要求的后续栏目与变量更新，严禁再重复输出思考块！";
  } else if (openWrapperTag === "think_nya") {
    tagHint = "当前中断位置正处于 <think_nya> 思考块内部，请先自然收尾思考并输出 </think_nya><!--</think>-->，再紧接写出完整正文与所有后续栏目。";
  } else if (openWrapperTag) {
    tagHint = `当前中断位置正处于 <${openWrapperTag}> 标签内部，请直接续写该块剩余正文并自然闭合 </${openWrapperTag}>，然后输出其余要求的后续栏目与变量更新。`;
  } else if (openFieldKey === "game_content" || openFieldKey === "game") {
    tagHint = "请直接紧接中断字句续写完剩余正文、闭合 </game>，并完整输出所有要求的选项、摘要、评论与变量更新。";
  } else {
    tagHint = "请直接紧接中断字句续写完剩余正文，自然闭合所有未闭合标签，并完整输出所有要求的后续栏目与变量更新。";
  }

  const baseMessages = Array.isArray(prepared.body?.messages)
    ? prepared.body.messages.map(m => (isObject(m) ? { ...m } : m))
    : Array.isArray(base.messages)
      ? base.messages.map(m => (isObject(m) ? { ...m } : m))
      : [];

  if (collectedText) {
    baseMessages.push({ role: "assistant", content: collectedText });
  }
  const rescuePrompt = reason === "MISSING_BODY_STOP"
    ? `上方回复仅输出了思考规划便提前结束了。请立即调用 \`continuation_reply\` 工具，把完整的正式正文与所有后续栏目写入 \`content\` 参数中。${tagHint}`
    : collectedText
      ? `上方回复在末尾意外中断（停在「${tailSnippet}」处）。请立即调用 \`continuation_reply\` 工具，把紧接末尾的新增续写内容完整写入 \`content\` 参数中。${tagHint}严禁重复前文已输出的任何字句或开头标签！`
      : `请立即调用 \`continuation_reply\` 工具，将完整的用户可见回复内容（包含所有要求的标签、正文与后续栏目）完整写入 \`content\` 参数中。`;
  baseMessages.push({
    role: "user",
    content: rescuePrompt,
  });

  base.messages = baseMessages;
  base.tools = [{
    type: "function",
    function: {
      name: "continuation_reply",
      description: toolDesc,
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "紧接前文中断处的新增续写全文、未闭合标签收尾以及全部后续栏目与变量更新。",
          },
        },
        required: ["content"],
      },
    },
  }];
  base.tool_choice = { type: "function", function: { name: "continuation_reply" } };
  base.toolConfig = {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: ["continuation_reply"],
    },
  };
  delete base.tool_config;

  return {
    body: base,
    rescueToolName: "continuation_reply",
    rescueTarget: { kind: "single-field", toolName: "continuation_reply", fieldName: "content" },
  };
}
