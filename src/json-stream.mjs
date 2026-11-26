import { isObject, soliumbraFieldOrder, classifyMultiFieldRole, RESERVED_AUX_TOOLS } from "./schema.mjs";
import { dedupeContinuationOverlap } from "./request.mjs";

const SOLIUMBRA_TAGS = new Map([
  ["think_nya", "think_nya"],
  ["game_content", "game"],
  ["game", "game"],
  ["options", "options"],
  ["summary", "summary"],
  ["comment", "comment"],
]);

const INLINE_HTML_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn",
  "div", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
  "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s",
  "samp", "small", "span", "strong", "sub", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr", "blockquote",
]);

const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error(typeof signal?.reason === "string" && signal.reason ? signal.reason : "Aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal);
}

export const sseData = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;

// 通用 SSE 切分器（兼容 CRLF / LF / CR 以及跨字节块边界）
export function createSseParser(onEvent, maxChars = 4 * 1024 * 1024) {
  const decoder = new TextDecoder();
  let buffer = "";
  let stopped = false;

  const parse = raw => {
    const lines = raw.split(/\r\n|\r|\n/);
    const data = lines
      .filter(line => line === "data" || line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n");
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    return onEvent({ raw, lines, data, event });
  };

  const drain = (final = false) => {
    let boundary;
    while ((boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(buffer))) {
      if (!final && boundary[0].endsWith("\r") && boundary.index + boundary[0].length === buffer.length) break;
      if (boundary.index > maxChars) throw new Error("pg_sse_event_limit");
      if (parse(buffer.slice(0, boundary.index)) === false) {
        stopped = true;
        buffer = "";
        return;
      }
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
    if (buffer.length > maxChars) throw new Error("pg_sse_event_limit");
  };

  return {
    push(bytes) {
      if (stopped) return;
      buffer += decoder.decode(bytes, { stream: true });
      drain(false);
    },
    finish() {
      if (stopped) return;
      buffer += decoder.decode();
      drain(true);
      if (buffer.trim()) parse(buffer);
      buffer = "";
    },
  };
}

// 自定义标签截停（支持跨块匹配、带属性开标签 <plan type="a">、忽略自闭合 <plan />、防未闭合 <plan ... 致盲）
export function createTagStop(tag, count = 1, exemptTag = "") {
  const safeExempt = exemptTag && exemptTag !== tag ? exemptTag : "";
  const closing = `</${tag}>`;
  const exemptClose = safeExempt ? `</${safeExempt}>` : "";
  const openNames = safeExempt ? [tag, safeExempt] : [tag];
  const closeTokens = safeExempt ? [closing, exemptClose] : [closing];
  const MAX_OPEN_TAG_LEN = 256;

  let tail = "";
  let depth = 0;
  let exemptDepth = 0;
  let pairs = 0;
  let matched = false;

  function matchTagAt(str, pos) {
    // 1. 先查闭合标签
    for (const tok of closeTokens) {
      if (str.startsWith(tok, pos)) {
        return { kind: tok === closing ? "close" : "exemptClose", len: tok.length };
      }
      if (str.length - pos < tok.length && tok.startsWith(str.slice(pos))) {
        return { kind: "partial" };
      }
    }
    // 2. 再查开标签（支持 <tag> 或 <tag attr="...">，拒绝跨 < 吞噬后续标签，忽略自闭合 <tag />）
    for (const name of openNames) {
      const prefix = `<${name}`;
      if (str.startsWith(prefix, pos)) {
        const after = pos + prefix.length;
        if (after === str.length) return { kind: "partial" };
        const nextCh = str[after];
        if (nextCh === ">") {
          return { kind: name === tag ? "open" : "exemptOpen", len: prefix.length + 1 };
        }
        if (nextCh === "/" && str[after + 1] === ">") {
          return { kind: "selfClose", len: prefix.length + 2 };
        }
        if (nextCh === "/" && after + 1 === str.length) {
          return { kind: "partial" };
        }
        if (/\s/.test(nextCh)) {
          const gt = str.indexOf(">", after);
          const nextLt = str.indexOf("<", after);
          if (gt < 0) {
            if (nextLt >= 0) return null; // 后面已出现新的 <，说明前文不是合法开标签
            if (str.length - pos <= MAX_OPEN_TAG_LEN) return { kind: "partial" };
            return null;
          }
          if (nextLt >= 0 && nextLt < gt) return null; // 绝不跨过后续 < 吞掉其 >
          if (gt - pos <= MAX_OPEN_TAG_LEN) {
            if (str[gt - 1] === "/") return { kind: "selfClose", len: gt - pos + 1 };
            return { kind: name === tag ? "open" : "exemptOpen", len: gt - pos + 1 };
          }
        }
      } else if (str.length - pos < prefix.length && prefix.startsWith(str.slice(pos))) {
        return { kind: "partial" };
      }
    }
    return null;
  }

  return {
    marker: () => (matched ? closing : undefined),
    clip(text) {
      if (matched || !text) return "";
      const joined = tail + text;
      const prevLen = tail.length;
      tail = "";
      for (let i = joined.indexOf("<"); i >= 0; i = joined.indexOf("<", i + 1)) {
        const m = matchTagAt(joined, i);
        if (!m) continue;
        if (m.kind === "partial") {
          tail = joined.slice(i);
          break;
        }
        if (m.kind === "selfClose") {
          i += m.len - 1;
          continue;
        }
        if (m.kind === "exemptOpen") {
          exemptDepth++;
        } else if (m.kind === "exemptClose") {
          exemptDepth = Math.max(0, exemptDepth - 1);
        } else if (exemptDepth === 0) {
          if (m.kind === "open") {
            depth++;
          } else if (m.kind === "close" && depth > 0 && --depth === 0 && ++pairs === count) {
            matched = true;
            return text.slice(0, Math.max(0, i + m.len - prevLen));
          }
        }
        i += m.len - 1;
      }
      return text;
    },
  };
}

// 顶层扁平 JSON 对象流式键值对解析器：
// 收到一个字符立刻送出对应字段的新增字符串，支持跨块转义、代理对 emoji 与非 JSON 完整直通兜底。
export class StreamingFlatJsonParser {
  constructor(onFieldDelta, onFieldClose) {
    this.onFieldDelta = onFieldDelta;
    this.onFieldClose = onFieldClose;
    this.mode = "leading"; // leading | keyOrEnd | afterEmptyObj | key | colon | valueStart | valueString | skipValue | commaOrEnd | done | passthrough
    this.key = "";
    this.escape = false;
    this.hex = null;
    this.high = "";
    this.leadingBuf = "";
    this.rawBeforeFirstKey = "";
    this.nestedDepth = 0;
    this.inNestedString = false;
    this.nestedEscape = false;
    this.sawAnyKey = false;
    this.sawAnyValue = false;
    this.passthroughBuf = "";
    this._finished = false;
  }

  _emitChar(ch) {
    if (this.mode === "key") {
      if (this.key.length < 128) this.key += ch;
      return;
    }
    const code = ch.charCodeAt(0);
    if (this.high) {
      const pair = this.high + ch;
      this.high = "";
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.onFieldDelta(this.key, pair);
        return;
      }
      this.onFieldDelta(this.key, pair[0]);
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      this.high = ch;
    } else {
      this.onFieldDelta(this.key, ch);
    }
  }

  _emitString(str) {
    for (let j = 0; j < str.length; j++) {
      this._emitChar(str[j]);
    }
  }

  _flushHigh() {
    if (this.high) {
      this.onFieldDelta(this.key, this.high);
      this.high = "";
    }
  }

  _switchToPassthrough(text) {
    this.mode = "passthrough";
    this.passthroughBuf += text;
    this.leadingBuf = "";
    this.rawBeforeFirstKey = "";
  }

  feed(chunk) {
    if (!chunk || this._finished) return;
    let i = 0;

    // 兼容模型在 JSON 前输出 BOM / 空白 / ```json 围栏（含无空格单行 ```{...}、CR 换行），且非 JSON 绝不丢开围栏
    if (this.mode === "leading") {
      this.leadingBuf += chunk;
      const trimmed = this.leadingBuf.replace(/^\uFEFF?\s+/, "").replace(/^\uFEFF/, "");
      if (!trimmed) return;

      if (trimmed.startsWith("```")) {
        const singleLine = /^```[a-zA-Z0-9_-]*[ \t\r]*(\{[\s\S]*)$/.exec(trimmed);
        if (singleLine) {
          const bracePos = this.leadingBuf.indexOf("{");
          this.rawBeforeFirstKey = this.leadingBuf.slice(0, bracePos + 1);
          this.mode = "keyOrEnd";
          chunk = singleLine[1].slice(1);
          this.leadingBuf = "";
        } else {
          const nl = trimmed.indexOf("\n");
          if (nl < 0) {
            if (trimmed.length > 48) {
              this._switchToPassthrough(this.leadingBuf);
            }
            return;
          }
          const afterFence = trimmed.slice(nl + 1).replace(/^\s+/, "");
          if (!afterFence) return;
          if (afterFence[0] === "{") {
            const bracePos = this.leadingBuf.indexOf("{", this.leadingBuf.indexOf("\n") + 1);
            this.rawBeforeFirstKey = this.leadingBuf.slice(0, bracePos + 1);
            this.mode = "keyOrEnd";
            chunk = afterFence.slice(1);
            this.leadingBuf = "";
          } else {
            this._switchToPassthrough(this.leadingBuf);
            return;
          }
        }
      } else if (trimmed[0] === "{") {
        const bracePos = this.leadingBuf.indexOf("{");
        this.rawBeforeFirstKey = this.leadingBuf.slice(0, bracePos + 1);
        this.mode = "keyOrEnd";
        chunk = trimmed.slice(1);
        this.leadingBuf = "";
      } else if ("```".startsWith(trimmed)) {
        return;
      } else {
        this._switchToPassthrough(this.leadingBuf);
        return;
      }
    }

    if (this.mode === "passthrough") {
      this.passthroughBuf += chunk;
      return;
    }

    while (i < chunk.length) {
      const ch = chunk[i++];

      if (this.mode === "afterEmptyObj") {
        if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "`") {
          this.rawBeforeFirstKey += ch;
          continue;
        }
        // 形如 "{}这是一段普通中文回复"：立即回退直通不吞字
        this._switchToPassthrough(this.rawBeforeFirstKey + ch + chunk.slice(i));
        return;
      }

      if (this.mode === "key" || this.mode === "valueString") {
        if (this.mode === "key" && !this.sawAnyValue) this.rawBeforeFirstKey += ch;
        if (this.hex !== null) {
          if (/[0-9a-fA-F]/.test(ch)) {
            this.hex += ch;
            if (this.hex.length === 4) {
              this._emitChar(String.fromCharCode(parseInt(this.hex, 16)));
              this.hex = null;
            }
          } else {
            this._emitString("\\u" + this.hex);
            this.hex = null;
            if (this.mode === "key" && !this.sawAnyValue) {
              this.rawBeforeFirstKey = this.rawBeforeFirstKey.slice(0, -1);
            }
            i--;
          }
          continue;
        }
        if (this.escape) {
          this.escape = false;
          if (ch === "u") {
            this.hex = "";
          } else if (Object.hasOwn(ESCAPES, ch)) {
            this._emitChar(ESCAPES[ch]);
          } else {
            this._emitChar(ch);
          }
          continue;
        }
        if (ch === "\\") {
          this.escape = true;
          continue;
        }
        if (ch === '"') {
          if (this.mode === "key") {
            this.sawAnyKey = true;
            this.mode = "colon";
          } else {
            this._flushHigh();
            this.onFieldClose(this.key);
            this.mode = "commaOrEnd";
          }
          continue;
        }
        if (this.mode === "valueString" && !this.high) {
          let end = i;
          while (end < chunk.length) {
            const c = chunk[end];
            if (c === '"' || c === "\\") break;
            const code = chunk.charCodeAt(end);
            if (code >= 0xd800 && code <= 0xdbff && end === chunk.length - 1) break;
            end++;
          }
          const slice = chunk.slice(i - 1, end);
          const lastCode = slice.charCodeAt(slice.length - 1);
          if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
            if (slice.length > 1) this.onFieldDelta(this.key, slice.slice(0, -1));
            this.high = slice[slice.length - 1];
          } else {
            this.onFieldDelta(this.key, slice);
          }
          i = end;
          continue;
        }
        this._emitChar(ch);
        continue;
      }

      if (this.mode === "skipValue") {
        if (this.nestedDepth > 0) {
          if (this.inNestedString) {
            if (this.nestedEscape) this.nestedEscape = false;
            else if (ch === "\\") this.nestedEscape = true;
            else if (ch === '"') this.inNestedString = false;
            continue;
          }
          if (ch === '"') {
            this.inNestedString = true;
            continue;
          }
          if (ch === "{" || ch === "[") {
            this.nestedDepth++;
            continue;
          }
          if (ch === "}" || ch === "]") {
            this.nestedDepth--;
            if (this.nestedDepth === 0) {
              this.onFieldClose(this.key);
              this.mode = "commaOrEnd";
            }
            continue;
          }
          continue;
        }
        if (ch === ",") {
          this.onFieldClose(this.key);
          this.mode = "keyOrEnd";
        } else if (ch === "}") {
          this.onFieldClose(this.key);
          this.mode = "done";
        } else if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
          this.onFieldClose(this.key);
          this.mode = "commaOrEnd";
        }
        continue;
      }

      if (this.mode === "done") continue;
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        if (!this.sawAnyValue && (this.mode === "keyOrEnd" || this.mode === "colon")) {
          this.rawBeforeFirstKey += ch;
        }
        continue;
      }

      if (this.mode === "keyOrEnd") {
        if (ch === '"') {
          this.key = "";
          if (!this.sawAnyValue) this.rawBeforeFirstKey += '"';
          this.mode = "key";
        } else if (ch === "}") {
          if (!this.sawAnyKey) {
            this.rawBeforeFirstKey += "}";
            this.mode = "afterEmptyObj";
          } else {
            this.mode = "done";
          }
        } else if (!this.sawAnyKey) {
          this._switchToPassthrough(this.rawBeforeFirstKey + ch + chunk.slice(i));
          return;
        }
      } else if (this.mode === "colon") {
        if (ch === ":") {
          this.sawAnyValue = true;
          this.rawBeforeFirstKey = "";
          this.mode = "valueStart";
        } else if (!this.sawAnyValue) {
          // 形如 '{"角色"}: 你好' 的非 JSON 文本，立即回退直通
          this._switchToPassthrough(this.rawBeforeFirstKey + ch + chunk.slice(i));
          return;
        }
      } else if (this.mode === "valueStart") {
        if (ch === '"') {
          this.mode = "valueString";
        } else if (ch === "{" || ch === "[") {
          this.mode = "skipValue";
          this.nestedDepth = 1;
          this.inNestedString = false;
          this.nestedEscape = false;
        } else if (ch === ",") {
          this.onFieldClose(this.key);
          this.mode = "keyOrEnd";
        } else if (ch === "}") {
          this.onFieldClose(this.key);
          this.mode = "done";
        } else {
          this.mode = "skipValue";
          this.nestedDepth = 0;
          this.inNestedString = false;
          this.nestedEscape = false;
        }
      } else if (this.mode === "commaOrEnd") {
        if (ch === ",") this.mode = "keyOrEnd";
        else if (ch === "}") this.mode = "done";
      }
    }
  }

  finish() {
    if (this._finished) return;
    this._finished = true;
    if (this.mode === "valueString") {
      this.escape = false;
      this.hex = null;
      this.high = "";
      this.mode = "done";
      this.onFieldClose(this.key);
      return;
    }
    if (this.mode === "skipValue") {
      this.mode = "done";
      this.onFieldClose(this.key);
      return;
    }
    if (this.mode === "leading" && this.leadingBuf) {
      this._switchToPassthrough(this.leadingBuf);
      return;
    }
    // 截断在纯 "{\n  " 或 "{}" 时不要把半截 JSON 花括号当正文吐出
    if (this.mode === "keyOrEnd" && !this.sawAnyKey) {
      this.mode = "done";
      this.rawBeforeFirstKey = "";
      return;
    }
    if (this.mode === "afterEmptyObj") {
      this.mode = "done";
      this.rawBeforeFirstKey = "";
      return;
    }
    if (this.mode !== "passthrough") {
      this.mode = "done";
    }
  }

  takePassthrough() {
    const text = this.passthroughBuf;
    this.passthroughBuf = "";
    return text;
  }
}

// 暂存尾部残缺的闭合标签（含 "</think_nya " 这种 > 前带空格的写法）
function holdPartialClosingTag(value, tagName) {
  const lower = value.toLowerCase();
  const target = `</${tagName.toLowerCase()}>`;
  const targetNoGt = `</${tagName.toLowerCase()}`;
  const lt = lower.lastIndexOf("<");
  if (lt < 0) return value;
  const tail = lower.slice(lt);
  if (tail.includes(">")) return value;
  // 1) "<" / "</" / "</think_n" 等前缀
  if (tail.length < target.length && target.startsWith(tail)) {
    return value.slice(0, lt);
  }
  // 2) "</think_nya   "（闭合标签名已完整，末尾只带空格等待 ">"）
  if (tail.startsWith(targetNoGt) && /^\s*$/.test(tail.slice(targetNoGt.length)) && tail.length < targetNoGt.length + 16) {
    return value.slice(0, lt);
  }
  return value;
}

// 判断字符串开头是否正处于 "<tagName   "（含空格等待 ">"）的不完整开标签前缀
function isPendingOpeningTag(value, tagName) {
  if (!value.startsWith("<") || value.includes(">")) return false;
  const lower = value.toLowerCase();
  const openNoGt = `<${tagName.toLowerCase()}`;
  if (lower.length < openNoGt.length) {
    return openNoGt.startsWith(lower);
  }
  return lower.startsWith(openNoGt) && /^\s*$/.test(lower.slice(openNoGt.length)) && lower.length < openNoGt.length + 16;
}

// 严格单调的思考/规划块渲染器：
// 流式阶段先 trimEnd 再剥/暂存闭标签再 trimEnd，彻底杜绝 <think_nya > / </think_nya > / </think_nya>\n 导致的回缩或漏剥！
function renderPlanTagField(tagName, field, appendThinkComment) {
  let value = field.raw.trimStart();
  if (!value) return "";

  const esc = escapeRegExp(tagName);
  const openRe = new RegExp(`^<${esc}\\s*>`, "i");
  const openStripRe = new RegExp(`^<${esc}\\s*>\\s*`, "i");
  const closeStripRe = new RegExp(`\\s*</${esc}\\s*>$`, "i");

  if (!field.closed && isPendingOpeningTag(value, tagName)) {
    return "";
  }
  const hadOuter = openRe.test(value);
  if (hadOuter) {
    value = value.replace(openStripRe, "");
  }

  // 先统一 trimEnd，使 "</think_nya>\n" 或 "</think_nya>   " 立刻露出尾部的闭合标签
  value = value.trimEnd();

  if (field.closed) {
    if (hadOuter) value = value.replace(closeStripRe, "");
    value = value.trimEnd();
  } else {
    if (hadOuter) {
      value = value.replace(closeStripRe, "");
      value = holdPartialClosingTag(value, tagName);
    }
    value = value.replace(/`+$/, "");
    value = value.trimEnd();
  }

  value = value.replace(/`{3,}/g, "").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (!value) return "";
  return `<${tagName}>\n${value}${field.closed ? `\n</${tagName}>${appendThinkComment ? "<!--</think>-->" : ""}` : ""}`;
}

const BODY_CONTAINER_TAGS = new Set([
  "game", "story", "content", "scene", "chapter", "reply", "narrative", "novel", "body", "main", "text", "output",
]);

function isCustomBlockWrapperTag(value, closed) {
  const m = /^<([a-zA-Z][a-zA-Z0-9_-]*)>/.exec(value);
  if (!m) return false;
  const tagName = m[1].toLowerCase();
  if (INLINE_HTML_TAGS.has(tagName)) return false;
  if (!closed) {
    // 若首块已出现闭合且其后还有正文（如 <status>HP:100</status>\n正文），属于局部前缀标签而非全文外框
    const closeMatch = new RegExp(`</${escapeRegExp(m[1])}\\s*>`, "i").exec(value);
    if (closeMatch && value.slice(closeMatch.index + closeMatch[0].length).trim().length > 0) {
      return false;
    }
    return BODY_CONTAINER_TAGS.has(tagName);
  }
  return new RegExp(`</${escapeRegExp(m[1])}\\s*>$`, "i").test(value);
}

function renderSoliumbraField(key, field) {
  const tag = SOLIUMBRA_TAGS.get(key);
  if (key === "think_nya") {
    return renderPlanTagField("think_nya", field, true);
  }
  const value = field.raw.trim();
  if (!value) return "";
  if (!tag) return value;

  if (!field.style) {
    if (!field.closed && value.startsWith("<") && !value.includes(">") && value.length < 48 && /^<(?:[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?)?$/.test(value)) {
      return "";
    }
    const open = new RegExp(`^<${escapeRegExp(tag)}[\\s>]`, "i");
    const prewrapped = open.test(value);
    const custom = tag === "game" && isCustomBlockWrapperTag(value, field.closed);
    field.style = prewrapped || custom || (tag === "comment" && /^<details[\s>]/i.test(value)) ? "raw" : "wrap";
  }
  if (field.style === "raw") return value;
  return `<${tag}>\n${value}${field.closed ? `\n</${tag}>` : ""}`;
}

function renderMultiField(key, field) {
  const role = classifyMultiFieldRole(key);
  if (role === "plan") {
    return renderPlanTagField(key, field, false);
  }
  const value = field.raw.trim();
  if (!value) return "";
  if (role === "body") return value;

  if (!field.style) {
    if (!field.closed && value.startsWith("<") && !value.includes(">") && value.length < 48 && /^<(?:[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?)?$/.test(value)) {
      return "";
    }
    const open = new RegExp(`^<${escapeRegExp(key)}[\\s>]`, "i");
    field.style = open.test(value) || isCustomBlockWrapperTag(value, field.closed) ? "raw" : "wrap";
  }
  if (field.style === "raw") return value;
  return `<${key}>\n${value}${field.closed ? `\n</${key}>` : ""}`;
}

// 统一流式内容还原器（支持小猫多字段 + 莱莎等泛化多字段 + 4ACH/自定义单字段 + 续写 + 内置 JSON）
export class PgJsonRestorer {
  constructor(target, stop = null) {
    this.target = target;
    this.stop = stop;
    this.pending = "";
    this.hasOutput = false;
    this.currentField = "";

    if (target.kind === "soliumbra" || target.kind === "multi-field") {
      this.isSoliumbra = target.kind === "soliumbra";
      this.order = this.isSoliumbra
        ? soliumbraFieldOrder(target.schema.properties)
        : [...(target.fieldOrder ?? Object.keys(target.schema.properties ?? {}))];
      this.fields = new Map();
      this.position = 0;
      this.offset = 0;
      this.hasText = false;
      this.parser = new StreamingFlatJsonParser(
        (key, delta) => this._appendStructured(key, delta, false),
        key => this._appendStructured(key, "", true),
      );
    } else {
      this.targetField = target.fieldName || "content";
      this.sawTargetField = false;
      this.fallbackKey = "";
      this.fallbackText = "";
      this.parser = new StreamingFlatJsonParser(
        (key, delta) => {
          if (this.stop?.marker()) return;
          if (key === this.targetField) {
            this.sawTargetField = true;
            this.currentField = key;
            const piece = this.stop ? this.stop.clip(delta) : delta;
            if (piece) {
              this.pending += piece;
              this.hasOutput = true;
            }
          } else if (!this.sawTargetField) {
            if (!this.fallbackKey) this.fallbackKey = key;
            if (key === this.fallbackKey) this.fallbackText += delta;
          }
        },
        () => {},
      );
    }
  }

  _appendStructured(key, fragment, closed) {
    if (this.stop?.marker()) return;
    if (this.isSoliumbra && key === "nya_oath") return;
    this.currentField = key;
    let field = this.fields.get(key);
    if (!field) {
      field = { raw: "", closed: false };
      this.fields.set(key, field);
      if (!this.order.includes(key)) {
        this.order.push(key);
      }
    }
    field.raw += fragment;
    if (closed) field.closed = true;

    if (this.position === 0 && this.order.length > 1) {
      const firstKey = this.order[0];
      const isFirstPlan = firstKey === "think_nya" || (!this.isSoliumbra && classifyMultiFieldRole(firstKey) === "plan");
      if (isFirstPlan && key !== firstKey && !this.fields.get(firstKey)?.raw.trim() && field.raw.trim()) {
        this.order.shift();
        this.order.push(firstKey);
      }
    }
    this._flushStructured(false);
  }

  _flushStructured(final) {
    while (this.position < this.order.length && !this.stop?.marker()) {
      const key = this.order[this.position];
      const field = this.fields.get(key);
      if (!field && !final) break;
      if (field) {
        const rendered = this.isSoliumbra
          ? renderSoliumbraField(key, field)
          : renderMultiField(key, field);
        const end = !field.closed && /[\ud800-\udbff]$/.test(rendered) ? rendered.length - 1 : rendered.length;
        if (end > this.offset) {
          const delta = (!this.offset && this.hasText ? "\n" : "") + rendered.slice(this.offset, end);
          const clipped = this.stop ? this.stop.clip(delta) : delta;
          if (clipped) {
            this.pending += clipped;
            this.hasOutput = true;
          }
          this.hasText = true;
          this.offset = end;
        }
        if (!field.closed) break;
      }
      this.position++;
      this.offset = 0;
    }
  }

  feed(text) {
    this.parser.feed(text);
    const pt = this.parser.takePassthrough();
    if (pt && !this.stop?.marker()) {
      const piece = this.stop ? this.stop.clip(pt) : pt;
      if (piece) {
        this.pending += piece;
        this.hasOutput = true;
      }
    }
    return this.take();
  }

  finish() {
    this.parser.finish();
    const pt = this.parser.takePassthrough();
    if (pt && !this.stop?.marker()) {
      const piece = this.stop ? this.stop.clip(pt) : pt;
      if (piece) {
        this.pending += piece;
        this.hasOutput = true;
      }
    }
    if (this.target.kind === "soliumbra" || this.target.kind === "multi-field") {
      this._flushStructured(true);
    } else if (!this.sawTargetField && this.fallbackText && !this.stop?.marker()) {
      const piece = this.stop ? this.stop.clip(this.fallbackText) : this.fallbackText;
      this.fallbackText = "";
      if (piece) {
        this.pending += piece;
        this.hasOutput = true;
      }
    }
    return this.take();
  }

  take() {
    const out = this.pending;
    this.pending = "";
    return out;
  }

  // 安全截断检查：返回当前尚未闭合的字段与外壳标签信息（用于无感接力时告知续写模型精确状态，绝不提前误闭合标签）
  getOpenState() {
    if (this.target.kind !== "soliumbra" && this.target.kind !== "multi-field") {
      return { openFieldKey: this.currentField || this.targetField || "", openWrapperTag: null };
    }
    const key = this.order[this.position] || this.currentField || "";
    const field = key ? this.fields.get(key) : null;
    if (!field || field.closed) {
      return { openFieldKey: key, openWrapperTag: null };
    }
    if (this.isSoliumbra) {
      if (key === "think_nya") return { openFieldKey: key, openWrapperTag: "think_nya" };
      const tag = SOLIUMBRA_TAGS.get(key);
      return { openFieldKey: key, openWrapperTag: field.style === "wrap" && tag ? tag : null };
    }
    const role = classifyMultiFieldRole(key);
    if (role === "plan") return { openFieldKey: key, openWrapperTag: key };
    return { openFieldKey: key, openWrapperTag: field.style === "wrap" ? key : null };
  }

  // 检查结构化回复是否“只吐了思考规划、正文主体字段完全为空”（Gemini 4 高尺度静默假 STOP 典型症状）
  isMissingBody() {
    if (this.parser.mode === "passthrough") return false;
    if (this.target.kind === "soliumbra") {
      const schemaKeys = Object.keys(this.target.schema?.properties ?? {});
      const bodyKeys = schemaKeys.filter(k => k === "game_content" || k === "game" || k === "story_body");
      if (bodyKeys.length === 0) return false;
      return bodyKeys.every(k => !(this.fields.get(k)?.raw?.trim()));
    }
    if (this.target.kind === "multi-field") {
      const schemaKeys = Object.keys(this.target.schema?.properties ?? {});
      const bodyKeys = schemaKeys.filter(k => classifyMultiFieldRole(k) === "body");
      if (bodyKeys.length === 0) return false;
      return bodyKeys.every(k => !(this.fields.get(k)?.raw?.trim()));
    }
    return false;
  }
}

// 把原生 functionCall 返回的参数还原为与流式一致的最终正文文本
export function formatFunctionCallArgs(fnCall, target) {
  if (!isObject(fnCall)) return "";
  let args = fnCall.args ?? fnCall.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return args; }
  }
  if (!isObject(args)) return "";

  if (target?.kind === "soliumbra") {
    const order = soliumbraFieldOrder(target.schema?.properties ?? args);
    const blocks = [];
    for (const key of order) {
      if (key === "nya_oath" || typeof args[key] !== "string") continue;
      const rendered = renderSoliumbraField(key, { raw: args[key], closed: true });
      if (rendered) blocks.push(rendered);
    }
    for (const [key, val] of Object.entries(args)) {
      if (key === "nya_oath" || order.includes(key) || typeof val !== "string") continue;
      const rendered = renderSoliumbraField(key, { raw: val, closed: true });
      if (rendered) blocks.push(rendered);
    }
    return blocks.join("\n");
  }

  if (target?.kind === "multi-field") {
    const order = target.fieldOrder?.length ? target.fieldOrder : Object.keys(args);
    const blocks = [];
    for (const key of order) {
      if (typeof args[key] !== "string") continue;
      const rendered = renderMultiField(key, { raw: args[key], closed: true });
      if (rendered) blocks.push(rendered);
    }
    return blocks.join("\n");
  }

  const fieldName = target?.fieldName || "content";
  if (typeof args[fieldName] === "string") return args[fieldName];
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val) return val;
  }
  return "";
}

// 动态扫描已输出文本末尾尚未闭合的外层标签（忽略自闭合 <tag />，覆盖容器标签，用于 raw 风格与二次接力/失败收口）
export function detectOpenWrapperTag(collectedText, target) {
  if (!collectedText) return null;
  const candidates = target?.kind === "soliumbra"
    ? ["think_nya", ...BODY_CONTAINER_TAGS, "options", "summary", "comment"]
    : target?.kind === "multi-field"
      ? [...(target.fieldOrder ?? []), ...BODY_CONTAINER_TAGS]
      : ["think_nya", ...BODY_CONTAINER_TAGS];
  const seen = new Set();
  let latestTag = null;
  let latestPos = -1;
  for (const tag of candidates) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    const esc = escapeRegExp(tag);
    const openRe = new RegExp(`<${esc}(?:\\s[^>]*)?>`, "gi");
    const closeRe = new RegExp(`</${esc}\\s*>`, "gi");
    let lastOpen = -1;
    let m;
    while ((m = openRe.exec(collectedText)) !== null) {
      if (/\/\s*>$/.test(m[0])) continue; // 忽略自闭合 <game /> / <content type="a"/>
      lastOpen = m.index;
    }
    if (lastOpen < 0) continue;
    let lastClose = -1;
    while ((m = closeRe.exec(collectedText)) !== null) lastClose = m.index;
    if (lastOpen > lastClose && lastOpen > latestPos) {
      latestPos = lastOpen;
      latestTag = tag;
    }
  }
  return latestTag;
}

function isAcceptedRescueToolName(name, target) {
  if (!name) return true;
  if (RESERVED_AUX_TOOLS.has(name)) return false;
  if (target?.toolName && name !== target.toolName && name !== "continuation_reply") {
    return false;
  }
  return true;
}

// 读取接力 functionCall 响应（兼容 SSE 与 JSON，拒绝 context 等辅助工具误解包，回调思考/保活进度并提取上游错误体）
export async function readRescueFunctionResponse(response, target, signal, onRescueProgress = null) {
  if (!response?.ok) {
    let detail = "";
    try {
      const rawErr = (await response.text()).slice(0, 4096).trim();
      if (rawErr) {
        try {
          const parsedErr = JSON.parse(rawErr);
          detail = parsedErr?.error?.message || parsedErr?.message || rawErr;
        } catch {
          detail = rawErr.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
      }
    } catch {
      // ignore body read error
    }
    const shortDetail = detail ? `：${detail.slice(0, 180)}` : "";
    const err = new Error(`接力请求失败（状态码 ${response?.status ?? "未知"}）${shortDetail}`);
    err.httpStatus = response?.status ?? 0;
    throw err;
  }
  const ct = response.headers.get("content-type") ?? "";
  let textOut = "";
  let fnText = "";
  let finishReason = "STOP";
  let sawFinishReason = false;
  let usageMetadata = null;
  let errorMessage = "";
  let blockReason = "";
  let thoughtChars = 0;

  const consumeObj = parsed => {
    if (!isObject(parsed)) return;
    if (parsed.error) {
      errorMessage = parsed.error?.message || (typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error));
      return;
    }
    if (!parsed.candidates?.length && parsed.promptFeedback) {
      blockReason = parsed.promptFeedback.blockReason || "BLOCKED";
      return;
    }
    if (!Array.isArray(parsed.candidates) && Array.isArray(parsed.choices)) {
      const msg = parsed.choices?.[0]?.message;
      if (Array.isArray(msg?.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fc = tc?.function;
          if (fc && isAcceptedRescueToolName(fc.name, target)) {
            const formatted = formatFunctionCallArgs(fc, target);
            if (formatted) fnText += formatted;
          }
        }
      } else if (typeof msg?.content === "string" && msg.content) {
        textOut += msg.content;
      }
      return;
    }
    if (isObject(parsed.usageMetadata)) usageMetadata = parsed.usageMetadata;
    const cand = parsed.candidates?.[0];
    if (cand?.finishReason && cand.finishReason !== "FINISH_REASON_UNSPECIFIED") {
      finishReason = cand.finishReason;
      sawFinishReason = true;
    }
    for (const part of cand?.content?.parts ?? []) {
      if (!isObject(part)) continue;
      if (part.thought === true && typeof part.text === "string" && part.text) {
        thoughtChars += part.text.length;
        onRescueProgress?.({ phase: "rescue-thinking", thoughtChars });
        continue;
      }
      if (part.functionCall) {
        if (!isAcceptedRescueToolName(part.functionCall.name, target)) continue;
        const formatted = formatFunctionCallArgs(part.functionCall, target);
        if (formatted) fnText += formatted;
      } else if (!part.thought && typeof part.text === "string" && part.text) {
        if (isTauriErrorText(part.text)) {
          errorMessage = part.text.split(/\r?\n/).slice(0, 2).join(" ").trim();
        } else {
          textOut += part.text;
        }
      }
    }
  };

  if (ct.includes("application/json")) {
    consumeObj(await response.json());
  } else if (response.body) {
    const reader = response.body.getReader();
    const onAbort = () => { reader.cancel().catch(() => {}); };
    if (signal && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
    const parser = createSseParser(({ raw, data, event }) => {
      if (event === "error") {
        if (!errorMessage) {
          try {
            const errObj = JSON.parse(data);
            errorMessage = errObj?.error?.message || errObj?.message || data || "接力上游 SSE 错误";
          } catch {
            errorMessage = (data || raw || "接力上游 SSE 错误").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
          }
        }
        return;
      }
      if (!data) {
        if (raw && raw.trim().startsWith(":")) {
          onRescueProgress?.({ phase: "rescue-keepalive", thoughtChars });
        }
        return;
      }
      if (data.trim() === "[DONE]") return;
      try {
        consumeObj(JSON.parse(data));
      } catch {
        const plain = data.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (plain && !errorMessage) {
          errorMessage = `接力上游返回非 JSON 响应：${plain.slice(0, 140)}`;
        }
      }
    });
    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          throwIfAborted(signal);
        }
        const { done, value } = await reader.read();
        if (signal?.aborted) throwIfAborted(signal);
        if (done) break;
        parser.push(value);
      }
      parser.finish();
    } finally {
      signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  return {
    text: fnText || textOut,
    usedFunctionCall: Boolean(fnText),
    finishReason,
    sawFinishReason,
    thoughtChars,
    usageMetadata,
    errorMessage,
    blockReason,
  };
}

const RESCUE_TRIGGER_REASONS = new Set([
  "PROHIBITED_CONTENT",
  "SAFETY",
  "BLOCKLIST",
  "RECITATION",
  "SPII",
  "IMAGE_SAFETY",
  "OTHER",
]);

function mergeUsageMetadata(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    promptTokenCount: a.promptTokenCount ?? b.promptTokenCount ?? 0,
    candidatesTokenCount: (a.candidatesTokenCount ?? 0) + (b.candidatesTokenCount ?? 0),
    thoughtsTokenCount: (a.thoughtsTokenCount ?? 0) + (b.thoughtsTokenCount ?? 0),
    totalTokenCount: (a.promptTokenCount ?? b.promptTokenCount ?? 0)
      + (a.candidatesTokenCount ?? 0) + (b.candidatesTokenCount ?? 0)
      + (a.thoughtsTokenCount ?? 0) + (b.thoughtsTokenCount ?? 0),
  };
}

function isTauriErrorText(text) {
  if (typeof text !== "string" || !text.startsWith("[")) return false;
  if (text.startsWith("[API Error]") || text.startsWith("[API 错误]")) return true;
  const label = globalThis.SillyTavern?.i18n?.translate?.("API Error", "API Error");
  return Boolean(label && text.startsWith(`[${label}]`));
}

function extractHttpStatusCode(message) {
  const m = /(?:状态码|HTTP)\s*(\d{3})|\b(4\d{2}|5\d{2})\b/.exec(String(message || ""));
  const code = Number(m?.[1] ?? m?.[2] ?? 0);
  return code >= 400 && code < 600 ? code : 0;
}

// 接力结果无损去重与标签闭合拼接（顺序执行：去重复规划块 -> 去重复开标签/补闭标签 -> 续写末尾重叠二次去重）
function stitchRescuePiece(collectedText, rawPiece, openState, ctx, target) {
  let piece = rawPiece || "";
  if (!piece || !collectedText) return piece;

  const openTag = openState?.openWrapperTag || null;
  let strippedAnyTag = false;

  // 1. 若前文已有已闭合的规划块（且当前并非处于该规划块内部），先剥除续写开头误吐的重复规划块
  const planTag = target?.kind === "soliumbra"
    ? "think_nya"
    : (target?.kind === "multi-field"
      ? (target.fieldOrder ?? []).find(k => classifyMultiFieldRole(k) === "plan")
      : null);
  if (planTag && openTag !== planTag) {
    const escPlan = escapeRegExp(planTag);
    const alreadyHasPlan = new RegExp(`<${escPlan}(?:\\s[^>]*)?>[\\s\\S]*?</${escPlan}\\s*>`, "i").test(collectedText);
    if (alreadyHasPlan) {
      const dupPlanBlockRe = new RegExp(`^\\s*<${escPlan}(?:\\s[^>]*)?>[\\s\\S]*?</${escPlan}\\s*>(?:<!--</think>-->)?\\s*`, "i");
      if (dupPlanBlockRe.test(piece)) {
        piece = piece.replace(dupPlanBlockRe, "");
        strippedAnyTag = true;
      }
    }
  }

  // 2. 若前文正处于某未闭合外层标签内：剥离重复开标签（正文续写绝不往半句中间插换行），或 full-fallback 缺闭标签时先闭合旧块
  if (openTag) {
    const escOpen = escapeRegExp(openTag);
    const dupOpenRe = new RegExp(`^\\s*<${escOpen}(?:\\s[^>]*)?>\\s*`, "i");
    const hasCloseRe = new RegExp(`</${escOpen}\\s*>`, "i");
    if (dupOpenRe.test(piece)) {
      piece = piece.replace(dupOpenRe, "");
      strippedAnyTag = true;
      const isPlanOpen = openTag === "think_nya"
        || (target?.kind === "multi-field" && classifyMultiFieldRole(openTag) === "plan");
      if ((ctx.mode === "full-fallback" || isPlanOpen) && piece && !collectedText.endsWith("\n") && !piece.startsWith("\n")) {
        piece = `\n${piece}`;
      }
    } else if (ctx.mode === "full-fallback" && !hasCloseRe.test(piece)) {
      const closeSuffix = openTag === "think_nya" ? "<!--</think>-->" : "";
      piece = `\n</${openTag}>${closeSuffix}\n${piece.trimStart()}`;
    }
  }

  // 3. 若剥离过重复规划块或开标签，在 continue 模式下再补一次末尾句子重叠去重
  if (strippedAnyTag && ctx.mode === "continue" && piece) {
    piece = dedupeContinuationOverlap(collectedText, piece, openTag);
  }
  return piece;
}

// 把 TauriTavern 的原生 Gemini SSE 流实时还原为标准正文 SSE（或非流式 JSON）；
// 当遇到 PROHIBITED_CONTENT / SAFETY 等上游安全截断且提供 onRescue 时，自动在同条流内切到原生 functionCall 无感续完剩余正文！
export async function restorePgResponse(response, prepared, signal, onProgress = () => {}, onRescue = null) {
  if (!response.ok || !response.body) return response;
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return response;

  const stopRule = prepared.tagStop;
  const stop = stopRule ? createTagStop(stopRule.tag, stopRule.count, stopRule.exemptTag) : null;
  const restorer = new PgJsonRestorer(prepared.target, stop);
  const canRescue = typeof onRescue === "function" && prepared.autoRescue !== false;
  const hasOriginalTools = Array.isArray(prepared.originalWorkingBody?.tools) && prepared.originalWorkingBody.tools.length > 0;
  const MAX_RESCUES = 2;

  const startedAt = performance.now();
  let firstTextMs = null;
  let usageMetadata = null;
  let finalFinishReason = "STOP";
  let collectedText = "";
  let collectedReasoning = "";
  let chunksEmitted = 0;
  let errorMessage = "";
  let blockReason = "";
  let upstreamErrorObj = null;
  let promptFeedbackObj = null;
  let rawErrorFrame = "";
  let doneReported = false;
  let lastProgressAt = 0;
  let pendingRescue = null;
  let rescuedCount = 0;
  let finishFrameEmitted = false;
  let sawUpstreamDone = false;
  let stoppedByTag = false;

  const reportDone = (extra = {}) => {
    if (doneReported) return;
    doneReported = true;
    onProgress({
      phase: "done",
      ttftMs: firstTextMs,
      totalMs: Math.round(performance.now() - startedAt),
      chunks: chunksEmitted,
      chars: collectedText.length,
      thoughtChars: collectedReasoning.length,
      finishReason: finalFinishReason,
      rescuedCount,
      ...(errorMessage ? { errorMessage } : {}),
      ...(blockReason ? { blockReason } : {}),
      ...extra,
    });
  };

  const maybeEmitProgress = (kind) => {
    const now = performance.now();
    if (now - lastProgressAt < 500) return;
    lastProgressAt = now;
    if (kind === "thinking") {
      onProgress({
        phase: "thinking",
        thoughtChars: collectedReasoning.length,
        elapsedMs: Math.round(now - startedAt),
      });
    } else {
      onProgress({
        phase: "streaming",
        chars: collectedText.length,
        ttftMs: firstTextMs,
        elapsedMs: Math.round(now - startedAt),
        chunks: chunksEmitted,
        field: restorer.currentField,
      });
    }
  };

  const markFirstText = () => {
    if (firstTextMs === null) {
      firstTextMs = Math.round(performance.now() - startedAt);
      lastProgressAt = performance.now();
      onProgress({ phase: "first-token", ttftMs: firstTextMs });
    }
  };

  const emitChunkedText = (emit, text) => {
    for (let off = 0; off < text.length; ) {
      let end = Math.min(off + 160, text.length);
      if (end < text.length) {
        const lastCode = text.charCodeAt(end - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
          end = end > off + 1 ? end - 1 : Math.min(end + 1, text.length);
        }
      }
      chunksEmitted++;
      emit(sseData({
        candidates: [{ index: 0, content: { role: "model", parts: [{ text: text.slice(off, end) }] } }],
      }));
      off = end;
    }
  };

  const runRescueLoop = async (emit, shouldStreamChunks) => {
    while (pendingRescue && rescuedCount < MAX_RESCUES) {
      const ctx = pendingRescue;
      pendingRescue = null;
      const attempt = rescuedCount + 1;
      const rawOpen = attempt === 1
        ? restorer.getOpenState()
        : { openFieldKey: "", openWrapperTag: null };
      const openState = {
        openFieldKey: rawOpen.openFieldKey,
        openWrapperTag: rawOpen.openWrapperTag || detectOpenWrapperTag(collectedText, prepared.target),
      };
      onProgress({
        phase: "rescuing",
        attempt,
        mode: ctx.mode,
        reason: ctx.reason,
        chars: collectedText.length,
        elapsedMs: Math.round(performance.now() - startedAt),
      });

      let rescued;
      try {
        rescued = await onRescue({
          mode: ctx.mode,
          reason: ctx.reason,
          collectedText,
          openFieldKey: openState.openFieldKey,
          openWrapperTag: openState.openWrapperTag,
          attempt,
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        rescued = {
          text: "",
          errorMessage: err?.message || "接力请求失败",
          timedOut: Boolean(err?.isRescueTimeout),
        };
      }

      const rawRescueText = typeof rescued?.text === "string" ? rescued.text : "";
      let piece = rawRescueText.trim()
        ? stitchRescuePiece(collectedText, rawRescueText, openState, ctx, prepared.target)
        : "";
      if (!rescued || !piece.trim()) {
        // 接力失败、静默 0 字或纯重复空接力：退回常规收尾、闭合已开标签并保留已生成的全部前文，绝不伪造 STOP
        if (rescued?.errorMessage) errorMessage = rescued.errorMessage;
        else if (rescued?.blockReason) blockReason = rescued.blockReason;
        else errorMessage = "接力通道未返回有效正文（已保留前文），可点「继续」续写";

        if (!ctx.discardedPartial) {
          if (attempt === 1) {
            const closeTail = restorer.finish();
            if (closeTail) {
              markFirstText();
              collectedText += closeTail;
              if (shouldStreamChunks) {
                chunksEmitted++;
                emit(sseData({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: closeTail }] } }] }));
              }
            }
          }
          const stillOpen = detectOpenWrapperTag(collectedText, prepared.target);
          if (stillOpen) {
            const extraClose = `\n</${stillOpen}>${stillOpen === "think_nya" ? "<!--</think>-->" : ""}`;
            collectedText += extraClose;
            if (shouldStreamChunks) {
              chunksEmitted++;
              emit(sseData({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: extraClose }] } }] }));
            }
          }
        }
        finalFinishReason = ctx.reason;
        finishFrameEmitted = true;
        emit(sseData({
          candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: finalFinishReason }],
          ...(usageMetadata ? { usageMetadata } : {}),
        }));
        return;
      }

      rescuedCount = attempt;
      if (rescued.usageMetadata) {
        usageMetadata = mergeUsageMetadata(usageMetadata, rescued.usageMetadata);
      }

      if (stop && piece) piece = stop.clip(piece);
      if (ctx.reason === "MISSING_BODY_STOP" && piece && collectedText && !collectedText.endsWith("\n") && !piece.startsWith("\n")) {
        piece = `\n${piece}`;
      }
      if (piece) {
        markFirstText();
        collectedText += piece;
        if (shouldStreamChunks) {
          emitChunkedText(emit, piece);
        } else {
          chunksEmitted++;
        }
      }

      // 接力中途已吐出部分文字但随后报错/拦截：保留已吐续文、上报错误、闭合残余标签且不谎报正常 STOP
      if (rescued.errorMessage || rescued.blockReason) {
        if (rescued.errorMessage) errorMessage = rescued.errorMessage;
        else blockReason = rescued.blockReason;
        const stillOpen = detectOpenWrapperTag(collectedText, prepared.target);
        if (stillOpen) {
          const extraClose = `\n</${stillOpen}>${stillOpen === "think_nya" ? "<!--</think>-->" : ""}`;
          collectedText += extraClose;
          if (shouldStreamChunks) {
            chunksEmitted++;
            emit(sseData({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: extraClose }] } }] }));
          }
        }
        finalFinishReason = ctx.reason;
        finishFrameEmitted = true;
        emit(sseData({
          candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: finalFinishReason }],
          ...(usageMetadata ? { usageMetadata } : {}),
        }));
        return;
      }

      if (stop?.marker()) {
        stoppedByTag = true;
        finalFinishReason = "STOP";
        finishFrameEmitted = true;
        emit(sseData({
          candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }],
          ...(usageMetadata ? { usageMetadata } : {}),
        }));
        return;
      }

      const nextReason = rescued.finishReason || "STOP";
      if (RESCUE_TRIGGER_REASONS.has(nextReason) && rescuedCount < MAX_RESCUES && collectedText.trim().length > 0) {
        pendingRescue = { mode: "continue", reason: nextReason };
        continue;
      }

      finalFinishReason = nextReason;
      blockReason = "";
      promptFeedbackObj = null;
      finishFrameEmitted = true;
      emit(sseData({
        candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: finalFinishReason }],
        ...(usageMetadata ? { usageMetadata } : {}),
      }));
      return;
    }
  };

  const handleEvent = ({ raw, data, event }, emit) => {
    if (event === "error") {
      rawErrorFrame = raw + "\n\n";
      if (!errorMessage) {
        try {
          const errObj = JSON.parse(data);
          errorMessage = errObj?.error?.message || errObj?.message || data || "上游 SSE 错误事件";
          if (!upstreamErrorObj && isObject(errObj)) upstreamErrorObj = errObj;
        } catch {
          errorMessage = (data || "上游 SSE 错误事件").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
        }
      }
      emit(rawErrorFrame);
      return;
    }
    if (!data) return;
    if (data.trim() === "[DONE]") {
      // 严禁在 handleEvent 内提前发出 [DONE]，统一交由流末/接力闭环按严格顺序单次收口！
      sawUpstreamDone = true;
      return false;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      const trimmed = data.trim();
      if (trimmed && !errorMessage) {
        const looksLikeError = /(?:<html|<!doctype|bad gateway|service unavailable|gateway timeout|error|50[0234]|429|40[0134])/i.test(trimmed);
        if (looksLikeError || (!collectedText && chunksEmitted === 0)) {
          errorMessage = `上游返回非 JSON 响应：${trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140)}`;
          rawErrorFrame = raw + "\n\n";
        }
      }
      return;
    }

    if (parsed?.error) {
      upstreamErrorObj = parsed;
      errorMessage = parsed.error?.message || (typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error));
      emit(sseData(parsed));
      return;
    }
    if (!parsed?.candidates?.length && parsed?.promptFeedback) {
      const br = parsed.promptFeedback.blockReason || "BLOCKED";
      if (canRescue && rescuedCount < MAX_RESCUES && !collectedText.trim()) {
        // 0 字即被 promptFeedback 拦截：自动回退原工具原生 functionCall 抗截断！
        pendingRescue = { mode: "full-fallback", reason: br };
        return false;
      }
      promptFeedbackObj = parsed;
      blockReason = br;
      emit(sseData(parsed));
      return;
    }

    // 忽略 TauriTavern 后端在流末附加的 choices[0].delta.native，防止原始 JSON 污染历史回放
    if (!Array.isArray(parsed?.candidates) && Array.isArray(parsed?.choices)) {
      return;
    }

    if (isObject(parsed.usageMetadata)) {
      usageMetadata = parsed.usageMetadata;
    }

    const candidate = parsed.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const outParts = [];

    for (const part of parts) {
      if (!isObject(part)) continue;
      const sig = part.thoughtSignature ?? part.thought_signature;
      const sigObj = sig ? { thoughtSignature: sig } : null;
      if (part.thought === true && typeof part.text === "string" && part.text) {
        collectedReasoning += part.text;
        outParts.push({ thought: true, text: part.text, ...(sigObj || {}) });
        if (firstTextMs === null) maybeEmitProgress("thinking");
        continue;
      }
      if (typeof part.text === "string" && part.text) {
        if (isTauriErrorText(part.text)) {
          errorMessage = part.text.split(/\r?\n/).slice(0, 2).join(" ").trim();
          collectedText += part.text;
          outParts.push({ text: part.text, ...(sigObj || {}) });
          continue;
        }
        const restoredText = restorer.feed(part.text);
        if (restoredText) {
          markFirstText();
          collectedText += restoredText;
          chunksEmitted++;
          outParts.push({ text: restoredText, ...(sigObj || {}) });
          maybeEmitProgress("streaming");
        } else if (sigObj) {
          outParts.push(sigObj);
        }
        if (stop?.marker()) break;
        continue;
      }
      if (sigObj) {
        outParts.push(sigObj);
      }
    }

    const reason = candidate?.finishReason;
    if (!stop?.marker() && reason && reason !== "FINISH_REASON_UNSPECIFIED") {
      // 命中安全/策略截断（PROHIBITED_CONTENT / SAFETY 等）且开启无感接力：
      // 先发出本帧已解出的文字，绝不提前调 restorer.finish() 误闭合标签，也不发 [DONE]，交由 runRescueLoop 无感续写！
      if (canRescue && rescuedCount < MAX_RESCUES && RESCUE_TRIGGER_REASONS.has(reason)) {
        if (!prepared.upstreamStream) {
          // 非流式整段校验模式：极短截断 (<150 字) 或正文未出时直接清空走纯净 full-fallback
          const useFull = collectedText.trim().length === 0
            || (hasOriginalTools && (collectedText.trim().length < 150 || restorer.isMissingBody()));
          if (useFull) {
            collectedText = "";
            chunksEmitted = 0;
            firstTextMs = null;
            pendingRescue = { mode: "full-fallback", reason, discardedPartial: true };
            return false;
          }
          pendingRescue = { mode: "continue", reason };
          return false;
        }
        if (outParts.length > 0) {
          emit(sseData({
            candidates: [{ index: candidate?.index ?? 0, content: { role: "model", parts: outParts } }],
          }));
        }
        const useFull = collectedText.trim().length === 0
          || (hasOriginalTools && collectedText.trim().length < 150 && restorer.isMissingBody());
        pendingRescue = {
          mode: useFull ? "full-fallback" : "continue",
          reason,
        };
        return false;
      }

      finalFinishReason = reason;
      const tail = restorer.finish();
      if (tail) {
        markFirstText();
        collectedText += tail;
        chunksEmitted++;
        outParts.push({ text: tail });
      }

      // Gemini 4 静默假 STOP 或思考耗尽 MAX_TOKENS（正文 0 字）自动接力补全，在发出 finishReason 之前决策！
      if (canRescue && rescuedCount < MAX_RESCUES && !errorMessage && !blockReason) {
        const missingAll = collectedText.trim().length === 0;
        if (reason === "STOP") {
          const missingBody = !missingAll && restorer.isMissingBody();
          if (missingAll || missingBody) {
            if (outParts.length > 0) {
              emit(sseData({
                candidates: [{ index: candidate?.index ?? 0, content: { role: "model", parts: outParts } }],
              }));
            }
            pendingRescue = missingAll
              ? { mode: "full-fallback", reason: "EMPTY_STOP" }
              : { mode: "continue", reason: "MISSING_BODY_STOP" };
            return false;
          }
        } else if (reason === "MAX_TOKENS" && missingAll) {
          if (outParts.length > 0) {
            emit(sseData({
              candidates: [{ index: candidate?.index ?? 0, content: { role: "model", parts: outParts } }],
            }));
          }
          pendingRescue = { mode: "full-fallback", reason: "EMPTY_STOP" };
          return false;
        }
      }
    }

    if (stop?.marker()) {
      stoppedByTag = true;
      finalFinishReason = "STOP";
      finishFrameEmitted = true;
      const outFrame = {
        candidates: [{ index: 0, content: { role: "model", parts: outParts }, finishReason: "STOP" }],
        ...(usageMetadata ? { usageMetadata } : {}),
      };
      emit(sseData(outFrame));
      emit(sseData("[DONE]"));
      reportDone({ stoppedByTag: stop.marker() });
      return false;
    }

    if (outParts.length > 0 || reason || parsed.usageMetadata) {
      if (reason && reason !== "FINISH_REASON_UNSPECIFIED") finishFrameEmitted = true;
      const outFrame = {
        candidates: [{
          index: candidate?.index ?? 0,
          content: { role: "model", parts: outParts },
          ...(reason ? { finishReason: reason } : {}),
        }],
        ...(parsed.usageMetadata ? { usageMetadata: parsed.usageMetadata } : {}),
      };
      emit(sseData(outFrame));
    }
  };

  // 模式 1：真流式输出（start + pull + cancel 彻底杜绝背压死锁，并在同条流内无缝接力抗截断）
  if (prepared.upstreamStream) {
    const encoder = new TextEncoder();
    const reader = response.body.getReader();
    let streamController = null;
    let sseParser = null;
    let stopped = false;
    let doneEmitted = false;
    let closed = false;

    const closeStreamSafely = () => {
      if (closed) return;
      closed = true;
      try { streamController?.close(); } catch {}
    };

    const cleanupSignal = () => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      stopped = true;
      cleanupSignal();
      reader.cancel().catch(() => {});
      reportDone({ aborted: true });
      closeStreamSafely();
    };

    const finalizeStream = async emit => {
      if (!pendingRescue && !stoppedByTag && !closed) {
        const tail = restorer.finish();
        if (tail) {
          markFirstText();
          collectedText += tail;
          chunksEmitted++;
          emit(sseData({
            candidates: [{ index: 0, content: { role: "model", parts: [{ text: tail }] } }],
          }));
        }
        if (!finishFrameEmitted && canRescue && rescuedCount < MAX_RESCUES && !errorMessage && !blockReason && !stop?.marker()) {
          if (collectedText.trim().length === 0) {
            pendingRescue = { mode: "full-fallback", reason: "EMPTY_STOP" };
          } else if (restorer.isMissingBody()) {
            pendingRescue = { mode: "continue", reason: "MISSING_BODY_STOP" };
          }
        }
      }
      if (pendingRescue && !closed) {
        await runRescueLoop(emit, true);
        if (!doneEmitted && !closed) emit(sseData("[DONE]"));
        reportDone(stop?.marker() ? { stoppedByTag: stop.marker() } : {});
      } else if (!stoppedByTag && !closed) {
        const hasHardError = Boolean(upstreamErrorObj || promptFeedbackObj || errorMessage || blockReason);
        if (!collectedText && !upstreamErrorObj && !promptFeedbackObj && errorMessage) {
          const inferredCode = extractHttpStatusCode(errorMessage) || 502;
          emit(sseData({ error: { code: inferredCode, message: errorMessage } }));
        }
        if (!finishFrameEmitted && !(hasHardError && !collectedText)) {
          finishFrameEmitted = true;
          emit(sseData({
            candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: finalFinishReason }],
            ...(usageMetadata ? { usageMetadata } : {}),
          }));
        }
        if (!doneEmitted) emit(sseData("[DONE]"));
        reportDone();
      }
    };

    const streamBody = new ReadableStream({
      start(controller) {
        streamController = controller;
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      },
      async pull(controller) {
        if (stopped || closed) {
          closeStreamSafely();
          return;
        }
        const emit = text => {
          if (closed) return;
          if (text.includes("data: [DONE]")) doneEmitted = true;
          controller.enqueue(encoder.encode(text));
        };
        if (!sseParser) {
          sseParser = createSseParser(ev => {
            if (handleEvent(ev, emit) === false) {
              stopped = true;
              return false;
            }
          });
        }
        try {
          while (!stopped && !closed) {
            const { done, value } = await reader.read();
            if (stopped || closed) {
              closeStreamSafely();
              return;
            }
            if (done) {
              sseParser.finish();
              await finalizeStream(emit);
              cleanupSignal();
              closeStreamSafely();
              return;
            }
            sseParser.push(value);
            if (pendingRescue && !closed) {
              await reader.cancel().catch(() => {});
              await runRescueLoop(emit, true);
              if (!doneEmitted && !closed) emit(sseData("[DONE]"));
              reportDone(stop?.marker() ? { stoppedByTag: stop.marker() } : {});
              cleanupSignal();
              closeStreamSafely();
              return;
            }
            if (sawUpstreamDone && !closed) {
              await reader.cancel().catch(() => {});
              await finalizeStream(emit);
              cleanupSignal();
              closeStreamSafely();
              return;
            }
            if (stopped || closed) {
              await reader.cancel().catch(() => {});
              cleanupSignal();
              closeStreamSafely();
              return;
            }
            if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
          }
          closeStreamSafely();
        } catch (err) {
          cleanupSignal();
          await reader.cancel().catch(() => {});
          if (stopped || closed || signal?.aborted || err?.name === "AbortError") {
            reportDone({ aborted: true });
            closeStreamSafely();
          } else {
            closed = true;
            errorMessage = errorMessage || err?.message || "流式连接意外中断";
            reportDone({ errorMessage });
            try { controller.error(err); } catch {}
          }
        }
      },
      async cancel() {
        stopped = true;
        closed = true;
        cleanupSignal();
        await reader.cancel().catch(() => {});
        reportDone({ aborted: true });
      },
    });

    return new Response(streamBody, {
      status: response.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "x-pg-streaming-transport": prepared.target.kind,
      },
    });
  }

  // 模式 2：非流式抗截断（收完校验后整段交付；若触发安全截断亦自动无感接力）
  const reader = response.body.getReader();
  const noopEmit = () => {};
  const parser = createSseParser(ev => handleEvent(ev, noopEmit));
  const onBufAbort = () => { reader.cancel().catch(() => {}); };
  if (signal && !signal.aborted) {
    signal.addEventListener("abort", onBufAbort, { once: true });
  }
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        reportDone({ aborted: true });
        throwIfAborted(signal);
      }
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        reportDone({ aborted: true });
        throwIfAborted(signal);
      }
      if (done) break;
      parser.push(value);
      if (stop?.marker() || pendingRescue || sawUpstreamDone) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    parser.finish();
    if (!pendingRescue && !stoppedByTag) {
      const tail = restorer.finish();
      if (tail) {
        markFirstText();
        collectedText += tail;
      }
      if (!finishFrameEmitted && canRescue && rescuedCount < MAX_RESCUES && !errorMessage && !blockReason && !stop?.marker()) {
        if (collectedText.trim().length === 0) {
          pendingRescue = { mode: "full-fallback", reason: "EMPTY_STOP" };
        } else if (restorer.isMissingBody()) {
          pendingRescue = { mode: "continue", reason: "MISSING_BODY_STOP" };
        }
      }
    }
    if (pendingRescue) {
      await runRescueLoop(noopEmit, false);
    }
  } catch (err) {
    if (signal?.aborted || err?.name === "AbortError") {
      reportDone({ aborted: true });
    } else {
      errorMessage = errorMessage || err?.message || "连接意外中断";
      reportDone({ errorMessage });
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", onBufAbort);
    reader.releaseLock();
  }

  reportDone(stop?.marker() ? { stoppedByTag: stop.marker() } : {});

  if (!collectedText && (upstreamErrorObj || promptFeedbackObj || rawErrorFrame || errorMessage || blockReason)) {
    const inferredCode = Number(upstreamErrorObj?.error?.code) || extractHttpStatusCode(errorMessage) || 502;
    const synthPayload = upstreamErrorObj
      ?? promptFeedbackObj
      ?? { error: { code: inferredCode, message: errorMessage || `请求被上游拦截（${blockReason}）` } };
    if (prepared.stream) {
      const errBody = rawErrorFrame || (sseData(synthPayload) + sseData("[DONE]"));
      return new Response(errBody, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "x-pg-streaming-transport": "buffered" },
      });
    }
    const statusCode = Number(synthPayload?.error?.code) || inferredCode;
    return new Response(JSON.stringify(synthPayload), {
      status: statusCode >= 400 && statusCode < 600 ? statusCode : 502,
      headers: { "content-type": "application/json; charset=utf-8", "x-pg-streaming-transport": "buffered" },
    });
  }

  if (prepared.stream) {
    const parts = [];
    if (collectedReasoning) parts.push({ thought: true, text: collectedReasoning });
    if (collectedText) parts.push({ text: collectedText });
    const body = sseData({
      candidates: [{ index: 0, content: { role: "model", parts }, finishReason: finalFinishReason }],
      ...(usageMetadata ? { usageMetadata } : {}),
    }) + sseData("[DONE]");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "x-pg-streaming-transport": "buffered" },
    });
  }

  const parts = [];
  if (collectedReasoning) parts.push({ thought: true, text: collectedReasoning });
  if (collectedText) parts.push({ text: collectedText });
  const finishMap = {
    STOP: "stop",
    MAX_TOKENS: "length",
    SAFETY: "content_filter",
    PROHIBITED_CONTENT: "content_filter",
    BLOCKLIST: "content_filter",
    RECITATION: "content_filter",
  };
  return new Response(JSON.stringify({
    object: "chat.completion",
    model: prepared.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: collectedText,
        ...(collectedReasoning ? { reasoning_content: collectedReasoning } : {}),
      },
      finish_reason: finishMap[finalFinishReason] ?? "stop",
    }],
    responseContent: { role: "model", parts },
    ...(usageMetadata ? { usageMetadata } : {}),
  }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "x-pg-streaming-transport": "buffered" },
  });
}
