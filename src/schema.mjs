// MakerSuite / AI Studio 底层 Schema 净化与多预设正文工具识别
export const SOLIUMBRA_TOOL = "soliumbra_reply";
export const SOLIUMBRA_PRIORITY = ["think_nya", "game_content", "game", "story_body", "options", "summary", "comment"];
export const RESERVED_AUX_TOOLS = new Set(["context", "get_context", "read_context"]);

const PLAN_FIELD_RE = /^(?:think|plan|brew|thought|reasoning|.*_brew|.*_think|.*_plan)$/i;
const BODY_FIELD_RE = /^(?:content|story_content|story_body|body|reply|response|text|output|actual_content|game_content|game)$/i;
const REPLY_TOOL_NAME_RE = /(?:reply|response|story|game|content|output|body)/i;

export const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const TYPE_MAP = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  int: "INTEGER",
  boolean: "BOOLEAN",
  bool: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

export function isStringSchemaProp(prop) {
  if (!isObject(prop)) return false;
  let rawType = prop.type;
  if (Array.isArray(rawType)) {
    const nonNull = rawType.filter(item => String(item).trim().toLowerCase() !== "null");
    if (nonNull.length !== 1) return false;
    rawType = nonNull[0];
  }
  const typeKey = String(rawType ?? "").split(".").pop().trim().toLowerCase();
  return typeKey === "string";
}

// MakerSuite Proto Schema 上限为 Field 23 (propertyOrdering)，
// 严禁携带 additionalProperties / title / default / $schema；
// 同时剔除易触发上游 XGrammar 400 的复杂 pattern / minLength / maxLength。
export function sanitizeMakerSuiteSchema(raw, depth = 0) {
  if (!isObject(raw) || depth > 16) return { type: "OBJECT", properties: {} };
  const out = {};

  let rawType = raw.type;
  let inferredNullable = false;
  if (Array.isArray(rawType)) {
    const nonNull = rawType.filter(item => String(item).trim().toLowerCase() !== "null");
    if (rawType.some(item => String(item).trim().toLowerCase() === "null")) inferredNullable = true;
    rawType = nonNull[0] ?? "object";
  }
  const typeKey = String(rawType ?? "").split(".").pop().trim().toLowerCase();
  if (TYPE_MAP[typeKey]) {
    out.type = TYPE_MAP[typeKey];
  } else if (isObject(raw.properties)) {
    out.type = "OBJECT";
  } else if (raw.items != null) {
    out.type = "ARRAY";
  } else {
    out.type = "STRING";
  }

  if (typeof raw.format === "string" && raw.format) out.format = raw.format;
  if (typeof raw.description === "string" && raw.description) out.description = raw.description;
  if (typeof raw.nullable === "boolean") out.nullable = raw.nullable;
  else if (inferredNullable) out.nullable = true;

  if (Array.isArray(raw.enum) && raw.enum.length > 0) {
    out.enum = raw.enum.map(item => String(item));
  }

  if (out.type === "ARRAY" && isObject(raw.items)) {
    out.items = sanitizeMakerSuiteSchema(raw.items, depth + 1);
  }

  if (isObject(raw.properties)) {
    const props = {};
    for (const [key, val] of Object.entries(raw.properties)) {
      if (isObject(val)) props[key] = sanitizeMakerSuiteSchema(val, depth + 1);
    }
    out.properties = props;
  }

  if (Array.isArray(raw.required) && raw.required.length > 0) {
    const validProps = out.properties ? new Set(Object.keys(out.properties)) : null;
    const req = raw.required
      .map(item => String(item))
      .filter(name => !validProps || validProps.has(name));
    if (req.length > 0) out.required = [...new Set(req)];
  }

  const order = raw.propertyOrdering ?? raw.property_ordering;
  if (Array.isArray(order) && order.length > 0 && out.properties) {
    const validOrder = order.map(String).filter(name => Object.hasOwn(out.properties, name));
    if (validOrder.length > 0) out.propertyOrdering = [...new Set(validOrder)];
  }

  for (const key of ["minProperties", "maxProperties", "minimum", "maximum", "minItems", "maxItems"]) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) out[key] = raw[key];
  }

  return out;
}

export function extractFunctionTool(tool) {
  if (!isObject(tool)) return null;
  if (tool.type === "function" && isObject(tool.function) && typeof tool.function.name === "string" && tool.function.name) {
    return {
      name: tool.function.name,
      description: typeof tool.function.description === "string" ? tool.function.description : "",
      parameters: tool.function.parameters ?? tool.function.parametersJsonSchema ?? { type: "object", properties: {} },
    };
  }
  if (typeof tool.name === "string" && tool.name && (tool.parameters || tool.parametersJsonSchema)) {
    return {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: tool.parameters ?? tool.parametersJsonSchema,
    };
  }
  return null;
}

export function listFunctionTools(tools) {
  if (!Array.isArray(tools)) return [];
  const result = [];
  for (const item of tools) {
    const direct = extractFunctionTool(item);
    if (direct) {
      result.push(direct);
      continue;
    }
    const decls = item?.functionDeclarations ?? item?.function_declarations;
    if (Array.isArray(decls)) {
      for (const decl of decls) {
        const fn = extractFunctionTool(decl);
        if (fn) result.push(fn);
      }
    }
  }
  return result;
}

export function soliumbraFieldOrder(properties) {
  const keys = Object.keys(properties ?? {});
  const ordered = [];
  for (const key of SOLIUMBRA_PRIORITY) {
    if (keys.includes(key)) ordered.push(key);
  }
  for (const key of keys) {
    if (key !== "nya_oath" && !ordered.includes(key)) ordered.push(key);
  }
  return ordered;
}

export function multiFieldOrder(properties, preferredOrder = null) {
  const keys = Object.keys(properties ?? {});
  if (Array.isArray(preferredOrder) && preferredOrder.length > 0) {
    const ordered = preferredOrder.filter(k => keys.includes(k));
    for (const k of keys) {
      if (!ordered.includes(k)) ordered.push(k);
    }
    return ordered;
  }
  const plans = keys.filter(k => PLAN_FIELD_RE.test(k));
  const bodies = keys.filter(k => !plans.includes(k) && BODY_FIELD_RE.test(k));
  const rest = keys.filter(k => !plans.includes(k) && !bodies.includes(k));
  return [...plans, ...bodies, ...rest];
}

export function classifyMultiFieldRole(key) {
  if (PLAN_FIELD_RE.test(key)) return "plan";
  if (BODY_FIELD_RE.test(key)) return "body";
  return "section";
}

function mergeToolDescription(clean, fnDescription) {
  if (!fnDescription) return;
  clean.description = clean.description
    ? `${fnDescription}\n\n${clean.description}`
    : fnDescription;
}

// 校验小猫 soliumbra_reply 工具声明（所有属性须为字符串）
export function parseSoliumbraTool(tools) {
  const fns = listFunctionTools(tools);
  const matches = fns.filter(fn => fn.name === SOLIUMBRA_TOOL);
  if (matches.length !== 1) return null;
  const fn = matches[0];
  const params = fn.parameters;
  if (!isObject(params) || !isObject(params.properties)) return null;
  const entries = Object.entries(params.properties);
  if (!entries.length) return null;
  if (!entries.every(([, prop]) => isStringSchemaProp(prop))) {
    return null;
  }
  const clean = sanitizeMakerSuiteSchema(params);
  mergeToolDescription(clean, fn.description);
  const order = soliumbraFieldOrder(clean.properties);
  clean.propertyOrdering = Object.hasOwn(clean.properties, "nya_oath")
    ? [...order, "nya_oath"]
    : order;
  clean.required = Array.isArray(clean.required) && clean.required.length > 0
    ? clean.required
    : order;
  return {
    kind: "soliumbra",
    toolName: SOLIUMBRA_TOOL,
    description: fn.description,
    schema: clean,
    fieldOrder: order,
  };
}

// 解析单字符串字段的正文工具（如 4ACH 的 response_body、actual_content、game_content 等）
export function parseSingleFieldTool(fn) {
  if (!fn || !isObject(fn.parameters) || !isObject(fn.parameters.properties)) return null;
  const entries = Object.entries(fn.parameters.properties);
  if (entries.length !== 1) return null;
  const [fieldName, fieldSpec] = entries[0];
  if (!isStringSchemaProp(fieldSpec)) return null;
  const clean = sanitizeMakerSuiteSchema(fn.parameters);
  clean.required = [fieldName];
  clean.propertyOrdering = [fieldName];
  mergeToolDescription(clean, fn.description);
  return {
    kind: "single-field",
    toolName: fn.name,
    fieldName,
    description: fn.description,
    schema: clean,
  };
}

// 解析全字符串多字段正文工具（如《莱莎的秘密工坊》ryza_reply(ryza_brew, story_content)）
// 自动识别模式下要求命中正文语义（字段含正文字段名或工具名含 reply/response/story/game/content/output/body），
// 避免误劫持如 search_memory(query, category) 这类多参数业务工具！
export function parseMultiFieldTool(fn, { strictAuto = false } = {}) {
  if (!fn || !isObject(fn.parameters) || !isObject(fn.parameters.properties)) return null;
  const entries = Object.entries(fn.parameters.properties);
  if (entries.length < 2 || entries.length > 8) return null;
  if (!entries.every(([, prop]) => isStringSchemaProp(prop))) return null;
  if (strictAuto) {
    const hasBodyField = entries.some(([name]) => BODY_FIELD_RE.test(name));
    const hasReplyName = REPLY_TOOL_NAME_RE.test(fn.name);
    if (!hasBodyField && !hasReplyName) return null;
  }
  const clean = sanitizeMakerSuiteSchema(fn.parameters);
  mergeToolDescription(clean, fn.description);
  const order = multiFieldOrder(clean.properties, clean.propertyOrdering);
  clean.propertyOrdering = order;
  clean.required = Array.isArray(clean.required) && clean.required.length > 0
    ? clean.required
    : order;
  return {
    kind: "multi-field",
    toolName: fn.name,
    description: fn.description,
    schema: clean,
    fieldOrder: order,
  };
}

function readToolChoiceState(body) {
  const tc = body.tool_choice;
  const toolCfg = body.toolConfig ?? body.tool_config;
  const fnCfg = toolCfg?.functionCallingConfig ?? toolCfg?.function_calling_config;
  const fnMode = String(fnCfg?.mode ?? "").toUpperCase();
  const disabled = tc === "none" || fnMode === "NONE";

  let forcedName = "";
  if (isObject(tc)) {
    if (tc.type === "function" && typeof tc.function?.name === "string" && tc.function.name) {
      forcedName = tc.function.name;
    } else if ((tc.type === "function" || tc.type === "tool") && typeof tc.name === "string" && tc.name) {
      forcedName = tc.name;
    }
  }
  if (!forcedName) {
    const allowed = fnCfg?.allowedFunctionNames ?? fnCfg?.allowed_function_names;
    if (Array.isArray(allowed) && allowed.length === 1 && typeof allowed[0] === "string") {
      forcedName = allowed[0];
    }
  }
  return { disabled, forcedName };
}

// 按配置和当前请求自动判定应使用的 PG 结构化流式传输模式
export function detectTransportTarget(body, options = {}) {
  const {
    meowCompat = true,
    autoDetectTool = true,
    transportToolName = "",
    enableForPlain = false,
  } = options;

  const fns = listFunctionTools(body.tools);
  const { disabled, forcedName } = readToolChoiceState(body);

  // 全局工具禁用或强制调用保留辅助工具（如 context）时，严禁劫持
  if (fns.length > 0 && disabled) {
    return { bypass: "tool-choice-none" };
  }
  if (forcedName && RESERVED_AUX_TOOLS.has(forcedName)) {
    return { bypass: "target-tool-choice" };
  }

  // 1. 小猫兼容模式（Meowssiah: soliumbra_reply）
  if (meowCompat) {
    const sol = parseSoliumbraTool(body.tools);
    if (sol) {
      if (forcedName && forcedName !== SOLIUMBRA_TOOL) {
        return { bypass: "target-tool-choice" };
      }
      return sol;
    }
  }

  // 2. 用户手动填写了预设正文工具名（仅当当前请求实际声明了该工具时才介入，切到其他预设自动回退识别）
  const customName = String(transportToolName ?? "").trim();
  if (customName) {
    const target = fns.find(fn => fn.name === customName);
    if (target) {
      if (forcedName && forcedName !== customName) {
        return { bypass: "target-tool-choice" };
      }
      if (customName === SOLIUMBRA_TOOL) {
        const sol = parseSoliumbraTool(body.tools);
        if (sol) return sol;
      }
      const parsed = parseSingleFieldTool(target) ?? parseMultiFieldTool(target, { strictAuto: false });
      if (parsed) return parsed;
      return { bypass: "target-tool-schema" };
    }
  }

  // 3. 自动识别预设正文工具（4ACH response_body、图灵 actual_content、小猫 Reborn game_content、莱莎 ryza_reply 等）
  if (autoDetectTool && fns.length > 0) {
    // 若明确强制了某个非辅助工具，只针对它解析，失败立即绕过、绝不串改其他工具
    if (forcedName) {
      const forcedFn = fns.find(fn => fn.name === forcedName);
      const parsed = parseSingleFieldTool(forcedFn) ?? parseMultiFieldTool(forcedFn, { strictAuto: true });
      if (parsed) return parsed;
      return { bypass: "target-tool-choice" };
    }
    // 过滤掉像 context 这种辅助历史工具，若只剩一个正文工具，自动适配单字段或正文语义多字段结构
    const replyCandidates = fns.filter(fn => !RESERVED_AUX_TOOLS.has(fn.name));
    if (replyCandidates.length === 1) {
      const parsed = parseSingleFieldTool(replyCandidates[0]) ?? parseMultiFieldTool(replyCandidates[0], { strictAuto: true });
      if (parsed) return parsed;
      return { bypass: "target-tool-schema" };
    }
    if (replyCandidates.length === 0) {
      return { bypass: "target-tool-choice" };
    }
    return { bypass: "multi-client-tools" };
  }

  // 4. 无工具的普通纯文本预设
  if (fns.length === 0) {
    if (!enableForPlain) return { bypass: "plain-native-stream" };
    return {
      kind: "builtin-json",
      toolName: "pg_stream_reply",
      fieldName: "content",
      description: "",
      schema: {
        type: "OBJECT",
        properties: {
          content: {
            type: "STRING",
            description: "完整的用户可见回复正文，保留所有请求的语言、分段、标签与排版格式。",
          },
        },
        required: ["content"],
        propertyOrdering: ["content"],
      },
    };
  }

  return { bypass: "unsupported-tools" };
}
