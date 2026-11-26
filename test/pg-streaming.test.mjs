import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { preparePgRequest, transformCustomIncludeBody, stripGenerationConfigFromExclude, buildRescueRequestBody, dedupeContinuationOverlap, resolveLocalGenerateUrl, hasPresetReplyTool } from "../src/request.mjs";
import { restorePgResponse, readRescueFunctionResponse, PgJsonRestorer, StreamingFlatJsonParser, createTagStop, sseData } from "../src/json-stream.mjs";
import { sanitizeMakerSuiteSchema, detectTransportTarget } from "../src/schema.mjs";

const DEFAULT_SETTINGS = {
  mode: "streaming",
  thinkingEffort: "preset",
  meowCompat: true,
  autoDetectTool: true,
  transportToolName: "",
  enableForPlain: false,
  onlyReverseProxy: false,
  tagStop: false,
};

function makeSseResponse(events, chunkSize = 19) {
  const full = events.map(ev => (typeof ev === "string" ? ev : sseData(ev))).join("");
  const bytes = new TextEncoder().encode(full);
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

async function readRestoredSse(response) {
  const raw = await response.text();
  const events = [];
  let text = "";
  let reasoning = "";
  let finishReason = null;
  let usage = null;
  let sawNativeChoice = false;
  for (const block of raw.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      events.push("[DONE]");
      continue;
    }
    const obj = JSON.parse(data);
    events.push(obj);
    if (obj.choices) sawNativeChoice = true;
    if (obj.usageMetadata) usage = obj.usageMetadata;
    const cand = obj.candidates?.[0];
    if (cand?.finishReason) finishReason = cand.finishReason;
    for (const p of cand?.content?.parts ?? []) {
      if (p.thought && p.text) reasoning += p.text;
      else if (p.text) text += p.text;
    }
  }
  return { events, text, reasoning, finishReason, usage, sawNativeChoice };
}

// 1. Schema sanitization strips forbidden & XGrammar-risky fields (title, default, additionalProperties, pattern, minLength)
{
  const clean = sanitizeMakerSuiteSchema({
    type: "object",
    title: "BadTitle",
    additionalProperties: false,
    properties: {
      think_nya: { type: ["string", "null"], default: "", pattern: "^.*$", minLength: 10, description: "思考" },
      game_content: { type: "Type.STRING", description: "正文" },
    },
    required: ["think_nya", "game_content"],
    propertyOrdering: ["think_nya", "game_content"],
  });
  assert.equal(clean.type, "OBJECT");
  assert.equal(clean.title, undefined);
  assert.equal(clean.additionalProperties, undefined);
  assert.equal(clean.properties.think_nya.type, "STRING");
  assert.equal(clean.properties.think_nya.nullable, true);
  assert.equal(clean.properties.think_nya.default, undefined);
  assert.equal(clean.properties.think_nya.pattern, undefined);
  assert.equal(clean.properties.think_nya.minLength, undefined);
  assert.equal(clean.properties.game_content.type, "STRING");
  console.log("[PASS] 1. MakerSuite schema sanitization");
}

// 2. Meowssiah request transformation + real-time streaming restoration (split escapes, emoji, native filter)
{
  const body = {
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    max_tokens: 65535,
    messages: [
      { role: "user", content: "开始游戏" },
      { role: "assistant", content: "<think>先调 `context` 同步，然后立刻调用 `soliumbra_reply` 工具！</think>" },
      { role: "assistant", tool_calls: [{ id: "call_sync_final", type: "function", function: { name: "context", arguments: '{"query":"sync"}' } }] },
      { role: "tool", tool_call_id: "call_sync_final", name: "context", content: JSON.stringify({ mode: "theater", status: "喵呼呼，收到人类的指令啦，本喵这就调用 soliumbra_reply 写出最精彩生动的完整回复喵！" }) },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "soliumbra_reply",
          description: "SoliUmbra replies",
          parameters: {
            type: "object",
            properties: {
              think_nya: { type: ["string", "null"], description: "思考" },
              game_content: { type: "Type.STRING", description: "正文" },
            },
            required: ["think_nya", "game_content"],
            propertyOrdering: ["think_nya", "game_content"],
          },
        },
      },
      { type: "function", function: { name: "context", parameters: { type: "object", properties: { query: { type: "string" } } } } },
    ],
    tool_choice: { type: "function", function: { name: "soliumbra_reply" } },
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["soliumbra_reply"] } },
  };

  const prep = preparePgRequest(body, DEFAULT_SETTINGS);
  assert.equal(prep.bypass, undefined);
  assert.equal(prep.target.kind, "soliumbra");
  assert.equal(prep.body.tools, undefined);
  assert.equal(prep.body.tool_choice, undefined);
  assert.equal(prep.body.toolConfig, undefined);
  assert.equal(prep.body.responseMimeType, "application/json");
  assert.ok(prep.body.responseSchema.description.includes("SoliUmbra replies"), "must keep soliumbra tool description");
  assert.deepEqual(prep.body.responseSchema.propertyOrdering, ["think_nya", "game_content"]);

  const jsonPayload = JSON.stringify({
    think_nya: "喵呜~ <测试> 思考完成\n第二行\\u4e2d 🐾✨",
    game_content: "<game>\n清晨六点十分，阳光洒进房间。🐾\n</game>",
  }).replace("\\\\u4e2d", "\\u4e2d");

  const sseEvents = [];
  for (let i = 0; i < jsonPayload.length; i += 7) {
    sseEvents.push({
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: jsonPayload.slice(i, i + 7) }] } }],
    });
  }
  sseEvents.push({
    candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 23000, candidatesTokenCount: 4000, totalTokenCount: 27000 },
  });
  sseEvents.push({
    choices: [{ index: 0, delta: { native: { role: "model", parts: [{ text: jsonPayload }] } } }],
  });
  sseEvents.push("data: [DONE]\n\n");

  const restored = await restorePgResponse(makeSseResponse(sseEvents, 13), prep);
  const out = await readRestoredSse(restored);
  assert.equal(out.sawNativeChoice, false);
  assert.equal(out.finishReason, "STOP");
  assert.equal(out.usage.candidatesTokenCount, 4000);
  assert.ok(out.text.includes("<think_nya>\n喵呜~ &lt;测试&gt; 思考完成\n第二行中 🐾✨\n</think_nya><!--</think>-->"));
  assert.ok(out.text.includes("<game>\n清晨六点十分，阳光洒进房间。🐾\n</game>"));
  console.log(`[PASS] 2. Meowssiah streaming restoration (${out.events.length} chunks)`);
}

// 3. 4ACH single-field tool (34k description + Chinese & English phrasing rewrite + code fence + native thought)
{
  const bigDesc = "【4ACH 完整创作规范】" + "规".repeat(34000);
  const body = {
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [
      { role: "user", content: "Call the `response_body` function exactly once and put your complete final reply in its `content` argument." },
      { role: "user", content: "那记得调用一次response_body，然后把你所有写出来的东西都放在里面" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "response_body",
        description: bigDesc,
        parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
      },
    }],
    tool_choice: "required",
  };
  const prep = preparePgRequest(body, DEFAULT_SETTINGS);
  assert.equal(prep.target.kind, "single-field");
  assert.ok(prep.body.responseSchema.description.includes(bigDesc));
  assert.ok(!prep.body.messages[0].content.includes("Call the `response_body` function"), "must rewrite English tool call instruction");
  assert.ok(!prep.body.messages[1].content.includes("调用一次response_body"), "must rewrite Chinese tool call instruction");

  const sseEvents = [
    { candidates: [{ index: 0, content: { role: "model", parts: [{ thought: true, text: "先构思一下剧情..." }] } }] },
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '```json\n{"content": "<build>第一段\\n' }] } }] },
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '第二段 \\"引号\\" 结尾</build>"}' }] } }] },
    { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    "data: [DONE]\n\n",
  ];
  const restored = await restorePgResponse(makeSseResponse(sseEvents, 11), prep);
  const out = await readRestoredSse(restored);
  assert.equal(out.reasoning, "先构思一下剧情...");
  assert.equal(out.text, '<build>第一段\n第二段 "引号" 结尾</build>');
  console.log("[PASS] 3. 4ACH 34k description + EN/CN phrasing rewrite + native thought");
}

// 4. Ryza multi-field tool (莱莎的秘密工坊 ryza_reply(ryza_brew, story_content) + context)
{
  const body = {
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "开始冒险" }],
    tools: [
      {
        type: "function",
        function: {
          name: "ryza_reply",
          description: "莱莎秘密工坊正式输出通道",
          parameters: {
            type: "object",
            properties: {
              ryza_brew: { type: "string", description: "六步构思" },
              story_content: { type: "string", description: "正式小说正文" },
            },
            required: ["ryza_brew", "story_content"],
            propertyOrdering: ["ryza_brew", "story_content"],
          },
        },
      },
      { type: "function", function: { name: "context", parameters: { type: "object", properties: { query: { type: "string" } } } } },
    ],
  };
  const prep = preparePgRequest(body, DEFAULT_SETTINGS);
  assert.equal(prep.bypass, undefined);
  assert.equal(prep.target.kind, "multi-field");
  assert.deepEqual(prep.target.fieldOrder, ["ryza_brew", "story_content"]);

  const payload = JSON.stringify({
    ryza_brew: "第一步：确定场景 <检查>\n第二步：写剧情",
    story_content: "<content>\n海风吹过库肯岛。\n</content>",
  });
  const sseEvents = [];
  for (let i = 0; i < payload.length; i += 5) {
    sseEvents.push({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: payload.slice(i, i + 5) }] } }] });
  }
  sseEvents.push({ candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }] });
  const out = await readRestoredSse(await restorePgResponse(makeSseResponse(sseEvents, 9), prep));
  assert.equal(out.text, "<ryza_brew>\n第一步：确定场景 &lt;检查&gt;\n第二步：写剧情\n</ryza_brew>\n<content>\n海风吹过库肯岛。\n</content>");
  console.log("[PASS] 4. Ryza multi-field tool (ryza_reply) streaming restoration");
}

// 5. P0 #1: renderSoliumbraField monotonic offset with CRLF / multi-newline before </think_nya> (1-char chunks!)
{
  const cases = [
    "<think_nya>\n思考正文\n\n</think_nya>",
    "<think_nya>\r\n思考正文\r\n</think_nya>",
    "<think_nya>\n思考正文   \n\n</think_nya>",
    "<think_nya>\n思考正文" + "\n".repeat(30) + "</think_nya>",
  ];
  for (const thinkVal of cases) {
    const restorer = new PgJsonRestorer({
      kind: "soliumbra",
      schema: { properties: { think_nya: { type: "STRING" }, game_content: { type: "STRING" } } },
    });
    const payload = JSON.stringify({ think_nya: thinkVal, game_content: "<game>正文</game>" });
    let out = "";
    for (let i = 0; i < payload.length; i++) {
      out += restorer.feed(payload[i]);
    }
    out += restorer.finish();
    assert.equal(
      out,
      "<think_nya>\n思考正文\n</think_nya><!--</think>-->\n<game>正文</game>",
      `broken closing tag for input ${JSON.stringify(thinkVal)} -> got ${JSON.stringify(out)}`,
    );
  }
  console.log("[PASS] 5. P0 Monotonic renderSoliumbraField across 1-char chunks (CRLF & 30 newlines)");
}

// 6. P0 #2: Illegal \u escape followed by ", \, or emoji surrogate pair
{
  const r1 = new PgJsonRestorer({
    kind: "soliumbra",
    schema: { properties: { think_nya: { type: "STRING" }, game_content: { type: "STRING" } } },
  });
  let o1 = r1.feed('{"think_nya":"思考\\u12","game_content":"<game>绝不丢失的正文</game>"}');
  o1 += r1.finish();
  assert.ok(o1.includes("<game>绝不丢失的正文</game>"), `must not eat closing quote, got: ${o1}`);

  const deltas = [];
  const p2 = new StreamingFlatJsonParser((k, d) => deltas.push(d), () => {});
  p2.feed('{"content":"x\\u12🐾y"}');
  p2.finish();
  assert.equal(deltas.join(""), "x\\u12🐾y");
  assert.ok(!deltas.some(d => d.length === 1 && d.charCodeAt(0) >= 0xd800 && d.charCodeAt(0) <= 0xdfff), "no lone surrogate delta");

  const deltas3 = [];
  const p3 = new StreamingFlatJsonParser((k, d) => deltas3.push(d), () => {});
  p3.feed('{"content":"abc\\u12\\ndef"}');
  p3.finish();
  assert.equal(deltas3.join(""), "abc\\u12\ndef");
  console.log("[PASS] 6. P0 Illegal \\u escape preserves quote, newline & surrogate pair");
}

// 7. P0 #3: Plain text starting with '{' + fenced non-JSON + single-line fence + skipValue missing value
{
  const r1 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  const o1 = r1.feed("{系统提示：进入剧情}\n清晨六点十分") + r1.finish();
  assert.equal(o1, "{系统提示：进入剧情}\n清晨六点十分");

  // Fenced non-JSON split across chunks must preserve opening fence
  const r2 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  const o2 = r2.feed("```markdown\n") + r2.feed("# 标题\n正文\n```") + r2.finish();
  assert.equal(o2, "```markdown\n# 标题\n正文\n```");

  // Single-line ```json {"content":"ok"}
  const r3 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  const o3 = r3.feed('```json {"content":"单行围栏成功"}```') + r3.finish();
  assert.equal(o3, "单行围栏成功");

  // Malformed {"bad":,"content":"正文"} must not swallow content
  const r4 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  const o4 = r4.feed('{"bad":,"content":"依然保留正文"}') + r4.finish();
  assert.equal(o4, "依然保留正文");

  // Wrong single-field key fallback {"text":"3000字"}
  const r5 = new PgJsonRestorer({ kind: "single-field", fieldName: "content" });
  const o5 = r5.feed('{"text":"键名写错也不吞正文"}') + r5.finish();
  assert.equal(o5, "键名写错也不吞正文");
  console.log("[PASS] 7. P0 Non-JSON '{' passthrough, fence preservation, bad skipValue & key fallback");
}

// 8. P0 #4: tool_choice forcing reserved aux tool (context) or NONE must NEVER hijack
{
  const tools = [
    { type: "function", function: { name: "context", parameters: { type: "object", properties: { query: { type: "string" } } } } },
    { type: "function", function: { name: "response_body", parameters: { type: "object", properties: { content: { type: "string" } } } } },
  ];
  assert.equal(
    detectTransportTarget({ tools, tool_choice: { type: "function", function: { name: "context" } } }).bypass,
    "target-tool-choice",
  );
  assert.equal(
    detectTransportTarget({ tools, tool_choice: { type: "tool", name: "context" } }).bypass,
    "target-tool-choice",
  );
  assert.equal(
    detectTransportTarget({ tools, tool_config: { function_calling_config: { mode: "NONE" } } }).bypass,
    "tool-choice-none",
  );
  assert.equal(
    detectTransportTarget({ tools, tool_choice: "none" }, { transportToolName: "response_body" }).bypass,
    "tool-choice-none",
  );
  console.log("[PASS] 8. P0 Reserved aux tool & tool_choice=NONE bypass protection");
}

// 9. P0 YAML / trailing-comma JSON custom_include_body + reasoning_effort: max -> high + generationConfig protection
{
  const yamlInput = "# 预设参数\nreasoning_effort: max\ntools:\n  - name: evil\ngenerationConfig:\n  temperature: 1\nsafetySettings:\n  - threshold: OFF\n";
  const r1 = transformCustomIncludeBody(yamlInput, { stripConflictingKeys: true, sanitizeMaxReasoning: true });
  assert.equal(r1.changed, true);
  assert.ok(r1.value.includes("reasoning_effort: high"), `expected max->high in YAML, got:\n${r1.value}`);
  assert.ok(!r1.value.includes("tools:"), "must strip YAML tools block");
  assert.ok(!r1.value.includes("generationConfig:"), "must strip YAML generationConfig block");
  assert.ok(r1.value.includes("safetySettings:"), "must preserve unrelated YAML blocks");

  // Trailing comma JSON (夏瑾双鱼0.36 / 小爱ds4.2)
  const trailingJson = '{\n  "reasoning_effort": "max",\n  "top_p": 0.95,\n}';
  const r2 = transformCustomIncludeBody(trailingJson, { sanitizeMaxReasoning: true });
  assert.deepEqual(JSON.parse(r2.value), { reasoning_effort: "high", top_p: 0.95 });

  // custom_exclude_body strips generationConfig
  const ex = stripGenerationConfigFromExclude("generationConfig\ntopK\n");
  assert.equal(ex.value, "topK");
  console.log("[PASS] 9. P0 YAML/trailing-comma JSON custom_include_body & exclude protection");
}

// 10. Dual-track PG thinking effort control (Gemini 4 minimal->low live-verified downgrade & Gemini 2.5/3!)
{
  // Gemini 4 plain preset with minimal thinking auto-downgrades to low (live probe proved gemini-4-carbon rejects minimal with 400!)
  const g4 = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    max_tokens: 500000,
    custom_include_body: "reasoning_effort: none\n",
    messages: [{ role: "user", content: "hi" }],
  }, { ...DEFAULT_SETTINGS, thinkingEffort: "minimal" });
  assert.equal(g4.bypass, "plain-native-stream");
  assert.equal(g4.thinkingApplied, "low");
  assert.equal(g4.thinkingDowngradedFrom, "minimal");
  assert.ok(g4.preprocessedBody, "must still emit preprocessedBody on bypassed plain preset");
  assert.equal(g4.preprocessedBody.max_tokens, 65535, "must cap 500000 -> 65535");
  assert.ok(g4.preprocessedBody.custom_include_body.includes("reasoningEffort: low"));
  assert.ok(!g4.preprocessedBody.custom_include_body.includes("reasoning_effort: none"));

  // Gemini 2.5 uses body.reasoning_effort and cleans custom_include_body
  const g25 = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "models/gemini-2.5-pro",
    stream: true,
    custom_include_body: '{"reasoning_effort":"max"}',
    messages: [{ role: "user", content: "hi" }],
  }, { ...DEFAULT_SETTINGS, thinkingEffort: "low" });
  assert.equal(g25.preprocessedBody.reasoning_effort, "low");
  assert.equal(g25.preprocessedBody.custom_include_body, "");
  console.log("[PASS] 10. Dual-track PG thinking effort (Gemini 4 & 2.5/3) + 500000 max_tokens cap");
}

// 11. P0 Continue mode uses raw continuation schema (NEVER re-wraps <think_nya>/<game>)
{
  const body = {
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    type: "continue",
    messages: [
      { role: "user", content: "开始" },
      { role: "assistant", content: "<think_nya>\n已有思考\n</think_nya><!--</think>-->\n<game>\n未写完的正文" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "soliumbra_reply",
        parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } } },
      },
    }],
  };
  const prep = preparePgRequest(body, DEFAULT_SETTINGS);
  assert.equal(prep.target.kind, "continuation");
  assert.equal(prep.target.fieldName, "continuation");
  const out = await readRestoredSse(await restorePgResponse(
    makeSseResponse([{ candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"continuation":"接着往下写完。\n</game>"}' }] }, finishReason: "STOP" }] }, "data: [DONE]\n\n"]),
    prep,
  ));
  assert.equal(out.text, "接着往下写完。\n</game>");
  assert.ok(!out.text.includes("<think_nya>"), "continuation must NEVER inject second <think_nya>");
  console.log("[PASS] 11. P0 Continue mode outputs seamless raw continuation without double wrappers");
}

// 12. P0 Quiet / Impersonate / Assistant Prefill bypass isolation
{
  const quiet = preparePgRequest({ chat_completion_source: "makersuite", model: "gemini-4-carbon", type: "quiet", messages: [{ role: "user", content: "Hi" }] }, { ...DEFAULT_SETTINGS, enableForPlain: true });
  assert.equal(quiet.bypass, "quiet-request");
  assert.equal(quiet.silent, true);

  const imp = preparePgRequest({ chat_completion_source: "makersuite", model: "gemini-4-carbon", type: "impersonate", messages: [{ role: "user", content: "替我说" }] }, { ...DEFAULT_SETTINGS, enableForPlain: true });
  assert.equal(imp.bypass, "impersonate-request");
  assert.equal(imp.silent, true);

  const prefill = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    messages: [{ role: "user", content: "写故事" }, { role: "assistant", content: "<konatan_planning~>\n" }],
  }, { ...DEFAULT_SETTINGS, enableForPlain: true });
  assert.equal(prefill.bypass, "assistant-prefill");
  console.log("[PASS] 12. P0 Quiet, Impersonate & Assistant Prefill bypass protection");
}

// 13. P1 Meowssiah skip-think moves think_nya to END so options/summary/comment stream live!
{
  const restorer = new PgJsonRestorer({
    kind: "soliumbra",
    schema: {
      properties: {
        think_nya: { type: "STRING" },
        game_content: { type: "STRING" },
        options: { type: "STRING" },
        summary: { type: "STRING" },
      },
    },
  });
  let step1 = restorer.feed('{"game_content":"<game>正文</game>",');
  assert.ok(step1.includes("<game>正文</game>"));
  let step2 = restorer.feed('"options":"1.选项A",');
  assert.ok(step2.includes("<options>\n1.选项A\n</options>"), `options must stream immediately, got: ${JSON.stringify(step2)}`);
  let step3 = restorer.feed('"summary":"本轮摘要"}');
  assert.ok(step3.includes("<summary>\n本轮摘要\n</summary>"), `summary must stream immediately, got: ${JSON.stringify(step3)}`);
  restorer.finish();
  console.log("[PASS] 13. P1 Skip-think streams options & summary immediately without stalling");
}

// 14. P1 game_content starting with "< 3分钟后" doesn't freeze; inline <b> still wraps in <game>
{
  const r1 = new PgJsonRestorer({
    kind: "soliumbra",
    schema: { properties: { game_content: { type: "STRING" } } },
  });
  const chunk1 = r1.feed('{"game_content":"< 3分钟后，阳光照进房间，没有尖括号结尾');
  assert.ok(chunk1.includes("< 3分钟后"), `must not freeze on '< 3分钟后', got: ${JSON.stringify(chunk1)}`);

  const r2 = new PgJsonRestorer({
    kind: "soliumbra",
    schema: { properties: { game_content: { type: "STRING" } } },
  });
  const o2 = r2.feed('{"game_content":"<b>序章</b>清晨六点"}') + r2.finish();
  assert.equal(o2, "<game>\n<b>序章</b>清晨六点\n</game>");
  console.log("[PASS] 14. P1 '< 3分钟后' non-freeze & inline HTML <b> preserves <game> wrapper");
}

// 15. P1 Tag stop with attributed exempt tag <plan type="a"> + cancels upstream + single done callback + no leaked thought part
{
  let upstreamCancelled = false;
  const payload = JSON.stringify({
    content: '<plan type="a"><tucao>豁免内</tucao></plan>正文<tucao>第一段</tucao>后面全丢弃',
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseData({
        candidates: [{ index: 0, content: { role: "model", parts: [{ text: payload }, { thought: true, text: "不应泄露" }] } }],
      })));
      controller.enqueue(encoder.encode(sseData({
        candidates: [{ index: 0, content: { role: "model", parts: [{ text: "多余帧" }] } }],
      })));
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const prep = preparePgRequest(
    { chat_completion_source: "makersuite", model: "gemini-4-carbon", stream: true, messages: [{ role: "user", content: "写" }] },
    { ...DEFAULT_SETTINGS, enableForPlain: true },
    { tag: "tucao", count: 1, exemptTag: "plan" },
  );
  const doneEvents = [];
  const res = await restorePgResponse(
    new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    prep,
    undefined,
    info => { if (info.phase === "done") doneEvents.push(info); },
  );
  const out = await readRestoredSse(res);
  assert.equal(out.text, '<plan type="a"><tucao>豁免内</tucao></plan>正文<tucao>第一段</tucao>');
  assert.equal(out.reasoning, "", "must break parts loop on tagStop so trailing thought doesn't leak");
  assert.equal(upstreamCancelled, true, "must cancel upstream stream immediately on tagStop");
  assert.equal(doneEvents.length, 1, "must report done exactly once");
  console.log("[PASS] 15. P1 Attributed exempt tag, upstream cancel & single done callback");
}

// 16. P0 Abort / manual stop in streaming mode fires single aborted done callback & cancels upstream
{
  let cancelled = false;
  const encoder = new TextEncoder();
  const ac = new AbortController();
  let pullCount = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pullCount++;
      if (pullCount === 1) {
        controller.enqueue(encoder.encode(sseData({
          candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"content":"已经吐出的十个字' }] } }],
        })));
      }
      // Second pull stays pending until abort/cancel
    },
    cancel() {
      cancelled = true;
    },
  });
  const prep = preparePgRequest(
    { chat_completion_source: "makersuite", model: "gemini-4-carbon", stream: true, messages: [{ role: "user", content: "写" }] },
    { ...DEFAULT_SETTINGS, enableForPlain: true },
  );
  const doneEvents = [];
  const res = await restorePgResponse(
    new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    prep,
    ac.signal,
    info => { if (info.phase === "done") doneEvents.push(info); },
  );
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  ac.abort();
  await reader.cancel();
  assert.equal(cancelled, true, "must cancel upstream reader on manual stop");
  assert.equal(doneEvents.length, 1, "must report single done event on abort");
  assert.equal(doneEvents[0].aborted, true);
  assert.equal(doneEvents[0].chars, "已经吐出的十个字".length);
  console.log("[PASS] 16. P0 Manual stop / AbortSignal cancels upstream & reports clean aborted status");
}

// 17. P1 Mid-stream [API 错误] frame is NEVER swallowed even after partial output
{
  const prep = preparePgRequest(
    { chat_completion_source: "makersuite", model: "gemini-4-carbon", stream: true, messages: [{ role: "user", content: "hi" }] },
    { ...DEFAULT_SETTINGS, enableForPlain: true },
  );
  const doneEvents = [];
  const sseEvents = [
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"content":"前文正常"}' }] } }] },
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "[API 错误]\n连接中途中断" }] } }] },
    "data: [DONE]\n\n",
  ];
  const out = await readRestoredSse(await restorePgResponse(makeSseResponse(sseEvents), prep, undefined, i => { if (i.phase === "done") doneEvents.push(i); }));
  assert.ok(out.text.includes("前文正常"));
  assert.ok(out.text.includes("[API 错误]\n连接中途中断"));
  assert.ok(doneEvents[0]?.errorMessage?.includes("连接中途中断"));
  console.log("[PASS] 17. P1 Mid-stream [API 错误] preserved after partial output");
}

// 18. MAX_TOKENS mid-string truncation drops incomplete \u4e & unpaired high surrogate cleanly
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "写长文" }],
  }, { ...DEFAULT_SETTINGS, enableForPlain: true });

  const doneEvents = [];
  const sseEvents = [
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"content":"截断前正文\\uD83D' }] }, finishReason: "MAX_TOKENS" }] },
    "data: [DONE]\n\n",
  ];
  const out = await readRestoredSse(await restorePgResponse(makeSseResponse(sseEvents, 23), prep, undefined, i => { if (i.phase === "done") doneEvents.push(i); }));
  assert.equal(out.text, "截断前正文", "must discard unpaired high surrogate at MAX_TOKENS EOF");
  assert.equal(out.finishReason, "MAX_TOKENS");
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].finishReason, "MAX_TOKENS");
  console.log("[PASS] 18. MAX_TOKENS drops incomplete escape & lone high surrogate cleanly");
}

// 19. Buffered mode forwards upstream error, promptFeedback & TT [API 错误] + single done on tagStop
{
  const prepJson = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  }, { ...DEFAULT_SETTINGS, mode: "buffered", enableForPlain: true });

  const errRes = await restorePgResponse(
    makeSseResponse([{ error: { code: 502, message: "Upstream RemoteProtocolError" } }, "data: [DONE]\n\n"]),
    prepJson,
  );
  assert.equal(errRes.status, 502);
  assert.equal((await errRes.json()).error.message, "Upstream RemoteProtocolError");

  const prepTagBuf = preparePgRequest(
    { chat_completion_source: "makersuite", model: "gemini-4-carbon", stream: true, messages: [{ role: "user", content: "hi" }] },
    { ...DEFAULT_SETTINGS, mode: "buffered", enableForPlain: true },
    { tag: "tucao", count: 1, exemptTag: "" },
  );
  const doneEvents = [];
  const bufRes = await restorePgResponse(
    makeSseResponse([{ candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"content":"<tucao>完</tucao>后面不要"}' }] } }] }]),
    prepTagBuf,
    undefined,
    i => { if (i.phase === "done") doneEvents.push(i); },
  );
  const bufOut = await readRestoredSse(bufRes);
  assert.equal(bufOut.text, "<tucao>完</tucao>");
  assert.equal(doneEvents.length, 1, "buffered tagStop must NOT double-report done");
  console.log("[PASS] 19. Buffered error forwarding & single done callback on tagStop");
}

// 20. Manifest loading_order (5, before LittleWhiteBox 10 & JS-Slash-Runner 100) + CSS [hidden] rule
{
  const extDir = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  assert.ok(Number(manifest.loading_order) <= 5, `loading_order must be <= 5 (before LittleWhiteBox 10), got ${manifest.loading_order}`);
  const css = fs.readFileSync(path.join(extDir, "style.css"), "utf8");
  assert.ok(css.includes("#pg_streaming_settings [hidden]") && css.includes("display: none !important"), "CSS must enforce [hidden] specificity");
  console.log("[PASS] 20. Manifest loading_order (5) & CSS [hidden] rule verified");
}

// 21. Tag stop exemptTag with '~' (konatan_planning~ / think_fox~) & identical tag guard
{
  const stop = createTagStop("tucao", 1, "konatan_planning~");
  const res = stop.clip("<konatan_planning~><tucao>内部不计</tucao></konatan_planning~>正文<tucao>正式</tucao>尾");
  assert.equal(res, "<konatan_planning~><tucao>内部不计</tucao></konatan_planning~>正文<tucao>正式</tucao>");

  const sameTagStop = createTagStop("tucao", 1, "tucao");
  assert.equal(sameTagStop.clip("<tucao>命中</tucao>后面"), "<tucao>命中</tucao>");
  console.log("[PASS] 21. Tag stop supports '~' tags & ignores identical exemptTag");
}

// 22. Soliumbra mismatched propertyOrdering alignment + tool_config snake_case cleanup
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    tool_config: { function_calling_config: { mode: "ANY" } },
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      type: "function",
      function: {
        name: "soliumbra_reply",
        parameters: {
          type: "object",
          properties: { game_content: { type: "string" }, think_nya: { type: "string" }, summary: { type: "string" } },
          propertyOrdering: ["summary", "game_content", "think_nya"],
        },
      },
    }],
  }, DEFAULT_SETTINGS);
  assert.equal(prep.body.tool_config, undefined);
  assert.deepEqual(prep.body.responseSchema.propertyOrdering, ["think_nya", "game_content", "summary"]);
  console.log("[PASS] 22. Soliumbra propertyOrdering alignment & snake_case tool_config removal");
}

// 23. Round 2 P0: ReadableStream backpressure + AbortSignal MUST NOT deadlock + pre-aborted emits NO [DONE]
{
  const ac1 = new AbortController();
  ac1.abort();
  const prep = preparePgRequest(
    { chat_completion_source: "makersuite", model: "gemini-4-carbon", stream: true, messages: [{ role: "user", content: "hi" }] },
    { ...DEFAULT_SETTINGS, enableForPlain: true },
  );
  const preAbortedRes = await restorePgResponse(makeSseResponse([{ candidates: [{ index: 0, content: { parts: [{ text: '{"content":"x"}' }] } }] }]), prep, ac1.signal);
  assert.equal(await preAbortedRes.text(), "", "pre-aborted signal must emit empty body, never fake [DONE]");

  // Backpressure + abort deadlock test
  const ac2 = new AbortController();
  const enc = new TextEncoder();
  let pulls = 0;
  const src = new ReadableStream({
    pull(c) {
      pulls++;
      c.enqueue(enc.encode(sseData({ candidates: [{ index: 0, content: { parts: [{ text: pulls === 1 ? '{"content":"一' : "二" }] } }] })));
    },
  });
  const res = await restorePgResponse(new Response(src, { status: 200, headers: { "content-type": "text/event-stream" } }), prep, ac2.signal);
  const reader = res.body.getReader();
  const r1 = await reader.read();
  assert.equal(r1.done, false);
  ac2.abort();
  const r2 = await Promise.race([
    (async () => {
      let last;
      for (let k = 0; k < 5; k++) {
        last = await reader.read();
        if (last.done) return last;
      }
      return last;
    })(),
    new Promise(resolve => setTimeout(() => resolve({ DEADLOCK: true }), 500)),
  ]);
  assert.equal(r2.DEADLOCK, undefined, "must never deadlock when aborted under backpressure");
  assert.equal(r2.done, true);
  console.log("[PASS] 23. Round 2 P0 Backpressure + AbortSignal deadlock fixed & pre-abort clean");
}

// 24. Round 2 P0: renderPlanTagField handles <think_nya >, </think_nya >, </think_nya>\n, ryza_brew across 1-char chunks
{
  const thinkCases = [
    ["<think_nya >\n思考正文\n</think_nya>", "<think_nya>\n思考正文\n</think_nya><!--</think>-->\n<game>正文</game>"],
    ["<think_nya>思考正文</think_nya >", "<think_nya>\n思考正文\n</think_nya><!--</think>-->\n<game>正文</game>"],
    ["<think_nya>\n思考正文\n</think_nya>\n", "<think_nya>\n思考正文\n</think_nya><!--</think>-->\n<game>正文</game>"],
    ["<think_nya></think_nya>\n", "<game>正文</game>"],
  ];
  for (const [val, expected] of thinkCases) {
    const r = new PgJsonRestorer({ kind: "soliumbra", schema: { properties: { think_nya: { type: "STRING" }, game_content: { type: "STRING" } } } });
    const payload = JSON.stringify({ think_nya: val, game_content: "<game>正文</game>" });
    let out = "";
    for (let i = 0; i < payload.length; i++) out += r.feed(payload[i]);
    out += r.finish();
    assert.equal(out, expected, `1-char stream mismatch for ${JSON.stringify(val)}`);
  }
  // ryza_brew with space before >
  const ryza = new PgJsonRestorer({
    kind: "multi-field",
    fieldOrder: ["ryza_brew", "story_content"],
    schema: { properties: { ryza_brew: { type: "STRING" }, story_content: { type: "STRING" } } },
  });
  const rp = JSON.stringify({ ryza_brew: "<ryza_brew >\n炼金规划\n</ryza_brew >\n", story_content: "莱莎推开木门。" });
  let ro = "";
  for (let i = 0; i < rp.length; i++) ro += ryza.feed(rp[i]);
  ro += ryza.finish();
  assert.equal(ro, "<ryza_brew>\n炼金规划\n</ryza_brew>\n莱莎推开木门。");
  console.log("[PASS] 24. Round 2 P0 renderPlanTagField handles spaced & trailing-newline tags");
}

// 25. Round 2 P0: role: "tool" JSON stays valid JSON after rewrite + role: "system" English 4ACH instruction rewritten
{
  const body = {
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    type: "continue",
    messages: [
      { role: "system", content: "Call the `soliumbra_reply` function exactly once and put your complete final reply in its `content` argument." },
      { role: "user", content: "继续" },
      { role: "assistant", content: "前文" },
      { role: "tool", tool_call_id: "call_sync_final", name: "context", content: JSON.stringify({ status: "这就调用 soliumbra_reply 输出吧！" }) },
      { role: "assistant", content: "<game>未写完" },
    ],
    tools: [{ type: "function", function: { name: "soliumbra_reply", parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } } } } }],
  };
  const prep = preparePgRequest(body, DEFAULT_SETTINGS);
  assert.ok(!prep.body.messages[0].content.includes("Call the `soliumbra_reply` function"), "must rewrite system-role English tool call");
  const toolObj = JSON.parse(prep.body.messages[3].content); // MUST NOT throw!
  assert.ok(!toolObj.status.includes("调用 soliumbra_reply"), "must rewrite tool status cleanly inside valid JSON");
  console.log("[PASS] 25. Round 2 P0 role:tool valid JSON preserved & role:system EN phrasing rewritten");
}

// 26. Round 2 P0: YAML comment+JSON, YAML object-list, flow-map, inline # comments & 4 exclude syntaxes
{
  const c1 = transformCustomIncludeBody('# 注释\n{"reasoning_effort": "max", "tools": []}', { stripConflictingKeys: true, setReasoningKey: "reasoningEffort", setReasoningValue: "low" });
  assert.deepEqual(JSON.parse(c1.value), { reasoningEffort: "low" });

  const c2 = transformCustomIncludeBody("- reasoning_effort: max # 注释\n- seed: 42\n- tools:\n  - a: 1\n", { stripConflictingKeys: true, setReasoningKey: "reasoningEffort", setReasoningValue: "low" });
  assert.ok(c2.value.includes("- seed: 42"));
  assert.ok(c2.value.includes("- reasoningEffort: low"));
  assert.ok(!c2.value.includes("tools:"));

  const c3 = transformCustomIncludeBody("  reasoning_effort: max # 顶格缩进加注释\n  seed: 7\n", { sanitizeMaxReasoning: true });
  assert.ok(c3.value.includes("reasoning_effort: high"));
  assert.ok(c3.value.includes("seed: 7"));

  const c4 = transformCustomIncludeBody("{ reasoning_effort: max, tools: [], top_p: 0.9 }", { stripConflictingKeys: true, sanitizeMaxReasoning: true });
  assert.deepEqual(JSON.parse(c4.value), { reasoning_effort: "high", top_p: 0.9 });

  assert.equal(stripGenerationConfigFromExclude("['generationConfig', 'seed']").value, "['seed']");
  assert.equal(stripGenerationConfigFromExclude("[generationConfig, seed]").value, "[seed]");
  assert.equal(stripGenerationConfigFromExclude("generationConfig: true\nseed: true").value, "seed: true");
  assert.equal(stripGenerationConfigFromExclude("- generationConfig # drop\n- seed").value, "- seed");
  console.log("[PASS] 26. Round 2 P0 YAML comment+JSON, list, flow-map & 4 exclude syntaxes");
}

// 27. Round 2 P1: createTagStop resists unclosed "<plan ..." & self-closing "<plan />"
{
  const s1 = createTagStop("tucao", 1, "plan");
  assert.equal(s1.clip("<plan 不是标签\n正文<tucao>截停</tucao>后面10000字"), "<plan 不是标签\n正文<tucao>截停</tucao>");
  const s2 = createTagStop("tucao", 1, "plan");
  assert.equal(s2.clip("<plan />正文<tucao>截停</tucao>后面10000字"), "<plan />正文<tucao>截停</tucao>");
  console.log("[PASS] 27. Round 2 P1 createTagStop resists unclosed & self-closing tags");
}

// 28. Round 2 P1: Auto-detect rejects 2-param business tool search_memory(query, category) & stale transportToolName falls back cleanly
{
  const biz = detectTransportTarget({
    tools: [{ type: "function", function: { name: "search_memory", parameters: { type: "object", properties: { query: { type: "string" }, category: { type: "string" } } } } }],
  });
  assert.equal(biz.bypass, "target-tool-schema", "auto-detect must NOT hijack 2-param business tool");

  const stale = detectTransportTarget({
    tools: [{ type: "function", function: { name: "actual_content", parameters: { type: "object", properties: { content: { type: "string" } } } } }],
    tool_choice: { type: "function", function: { name: "actual_content" } },
  }, { transportToolName: "response_body" });
  assert.equal(stale.kind, "single-field");
  assert.equal(stale.toolName, "actual_content");
  console.log("[PASS] 28. Round 2 P1 Business tool isolation & stale transportToolName fallback");
}

// 29. Round 2 P1: Fenced JS starting with '{', '{}' plain text, '{"角色"}:' non-JSON, '```{...}' & MAX_TOKENS '{\n  '
{
  const r1 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  assert.equal(r1.feed("```js\n{ console.log(1); }\n```") + r1.finish(), "```js\n{ console.log(1); }\n```");

  const r2 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  assert.equal(r2.feed("{}这是一段以空花括号开头的普通中文回复。") + r2.finish(), "{}这是一段以空花括号开头的普通中文回复。");

  const r3 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  assert.equal(r3.feed('{"角色"}: 你好世界') + r3.finish(), '{"角色"}: 你好世界');

  const r4 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  assert.equal(r4.feed('```{"content":"无空格单行围栏"}```') + r4.finish(), "无空格单行围栏");

  const r5 = new PgJsonRestorer({ kind: "builtin-json", fieldName: "content" });
  assert.equal(r5.feed("{\n  ") + r5.finish(), "", "truncated pure '{\\n  ' must not leak stray brace");
  console.log("[PASS] 29. Round 2 P1 Non-JSON fence/'{}'/'{\"角色\"}:' passthrough & truncated brace cleanup");
}

// 30. Round 2 P1: Quiet & concurrent background requests stay silent while still fixing max->high 400 crash
{
  const quietMax = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    type: "quiet",
    custom_include_body: '{"reasoning_effort": "max"}',
    messages: [{ role: "user", content: "Hi" }],
  }, { ...DEFAULT_SETTINGS, thinkingEffort: "low" });
  assert.equal(quietMax.silent, true);
  assert.equal(quietMax.thinkingApplied, null, "quiet must NOT apply user thinking override");
  assert.equal(quietMax.fixedMaxReasoning, true, "quiet MUST still fix max->high 400 crash");
  assert.deepEqual(JSON.parse(quietMax.preprocessedBody.custom_include_body), { reasoning_effort: "high" });

  const bg = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: false,
    tools: [{ type: "function", function: { name: "save_story_summary", parameters: { type: "object", properties: { summary: { type: "string" } } } } }],
    messages: [{ role: "user", content: "summarize" }],
  }, DEFAULT_SETTINGS, null, { isBackground: true });
  assert.equal(bg.bypass, "background-request");
  assert.equal(bg.silent, true);
  console.log("[PASS] 30. Round 2 P1 Quiet crash-fix & background request tool isolation");
}

// 31. v1.3.0 Auto-Rescue: mid-sentence PROHIBITED_CONTENT seamlessly continues via functionCall without premature </game>
{
  const body = {
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "写一段剧情" }],
    tools: [{
      type: "function",
      function: {
        name: "soliumbra_reply",
        description: "SoliUmbra",
        parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } }, required: ["think_nya", "game_content"] },
      },
    }],
  };
  const prep = preparePgRequest(body, { ...DEFAULT_SETTINGS, autoRescue: true });
  const truncatedStream = makeSseResponse([
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"think_nya":"小猫规划","game_content":"<game>\\n另一只手则条件' }] } }] },
    { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "PROHIBITED_CONTENT" }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 } },
    "data: [DONE]\n\n",
  ]);
  const progress = [];
  let rescueArgs = null;
  const restored = await restorePgResponse(
    truncatedStream,
    prep,
    undefined,
    info => progress.push(info),
    async ctx => {
      rescueArgs = ctx;
      const built = buildRescueRequestBody(prep, DEFAULT_SETTINGS, ctx);
      assert.equal(built.rescueToolName, "continuation_reply");
      assert.equal(built.body.responseMimeType, undefined, "rescue must use native functionCall, NOT JSON mode");
      assert.match(built.body.custom_include_body, /reasoningEffort["']?\s*:\s*["']?low/i, "Gemini 4 rescue defaults to fast low thinking");
      // Simulate rescue functionCall repeating last 5 chars ("一只手则条件") to verify overlap deduplication
      const rescueSse = makeSseResponse([
        { candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: "continuation_reply", args: { content: "另一只手则条件反射地探下来。\n</game>\n<UpdateVariable>ok</UpdateVariable>" } } }] } }] },
        { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 } },
        "data: [DONE]\n\n",
      ]);
      const parsed = await readRescueFunctionResponse(rescueSse, built.rescueTarget);
      parsed.text = dedupeContinuationOverlap(ctx.collectedText, parsed.text);
      return parsed;
    },
  );
  const out = await readRestoredSse(restored);
  assert.equal(rescueArgs.mode, "continue");
  assert.equal(out.finishReason, "STOP");
  assert.equal(out.text, "<think_nya>\n小猫规划\n</think_nya><!--</think>-->\n<game>\n另一只手则条件反射地探下来。\n</game>\n<UpdateVariable>ok</UpdateVariable>");
  assert.ok(progress.some(p => p.phase === "rescuing"));
  assert.equal(progress.find(p => p.phase === "done").rescuedCount, 1);
  assert.equal(out.usage.candidatesTokenCount, 800, "must merge initial + rescue output tokens");
  console.log("[PASS] 31. v1.3.0 Mid-sentence PROHIBITED_CONTENT seamless functionCall rescue & dedupe");
}

// 32. v1.3.0 Auto-Rescue: mid-<think_nya> cutoff reports openWrapperTag='think_nya' & never prematurely closes tag
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "soliumbra_reply", parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } } } } }],
  }, { ...DEFAULT_SETTINGS, autoRescue: true });

  let seenCtx = null;
  const restored = await restorePgResponse(
    makeSseResponse([
      { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"think_nya":"思考到一半' }] } }] },
      { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "SAFETY" }] },
    ]),
    prep,
    undefined,
    () => {},
    async ctx => {
      seenCtx = ctx;
      return { text: "继续想完\n</think_nya><!--</think>-->\n<game>完整正文</game>", finishReason: "STOP" };
    },
  );
  const out = await readRestoredSse(restored);
  assert.equal(seenCtx.openWrapperTag, "think_nya");
  assert.ok(!seenCtx.collectedText.includes("</think_nya>"), "must NOT prematurely close <think_nya> before rescue");
  assert.equal(out.text, "<think_nya>\n思考到一半继续想完\n</think_nya><!--</think>-->\n<game>完整正文</game>");
  console.log("[PASS] 32. v1.3.0 Mid-<think_nya> cutoff passes openWrapperTag & stitches cleanly");
}

// 33. v1.3.0 Auto-Rescue: 0-char promptFeedback block falls back to full native functionCall
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "soliumbra_reply", parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } } } } }],
  }, { ...DEFAULT_SETTINGS, autoRescue: true });

  let fallbackMode = null;
  const restored = await restorePgResponse(
    makeSseResponse([{ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }, "data: [DONE]\n\n"]),
    prep,
    undefined,
    () => {},
    async ctx => {
      fallbackMode = ctx.mode;
      const built = buildRescueRequestBody(prep, DEFAULT_SETTINGS, ctx);
      assert.equal(built.rescueToolName, "soliumbra_reply", "full-fallback must restore original preset tool");
      const sse = makeSseResponse([
        { candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: "soliumbra_reply", args: { think_nya: "全量兜底思考", game_content: "<game>全量兜底正文</game>" } } }] } }] },
        { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }] },
      ]);
      return readRescueFunctionResponse(sse, built.rescueTarget);
    },
  );
  const out = await readRestoredSse(restored);
  assert.equal(fallbackMode, "full-fallback");
  assert.equal(out.finishReason, "STOP");
  assert.equal(out.text, "<think_nya>\n全量兜底思考\n</think_nya><!--</think>-->\n<game>全量兜底正文</game>");
  console.log("[PASS] 33. v1.3.0 0-char promptFeedback block falls back to full native functionCall");
}

// 34. v1.3.0 Auto-Rescue graceful fallback on rescue network failure preserves already-streamed partial text
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  }, { ...DEFAULT_SETTINGS, enableForPlain: true, autoRescue: true });

  const doneLog = [];
  const restored = await restorePgResponse(
    makeSseResponse([
      { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"content":"已经吐出的两千字' }] } }] },
      { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "PROHIBITED_CONTENT" }] },
    ]),
    prep,
    undefined,
    i => { if (i.phase === "done") doneLog.push(i); },
    async () => { throw new Error("HTTP 502 rescue failed"); },
  );
  const out = await readRestoredSse(restored);
  assert.equal(out.text, "已经吐出的两千字", "must preserve partial streamed text even if rescue fails");
  assert.equal(out.finishReason, "PROHIBITED_CONTENT");
  assert.ok(doneLog[0]?.errorMessage?.includes("502"));
  console.log("[PASS] 34. v1.3.0 Rescue failure gracefully preserves already-streamed text");
}

// 35. v1.3.0 native-fc mode preserves original tools while applying Gemini 4 low thinking & max->high fix
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    custom_include_body: "reasoning_effort: max\n",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "soliumbra_reply", parameters: { type: "object", properties: { game_content: { type: "string" } } } } }],
  }, { ...DEFAULT_SETTINGS, mode: "native-fc", thinkingEffort: "low" });
  assert.equal(prep.bypass, "native-fc-mode");
  assert.ok(prep.preprocessedBody, "native-fc mode must apply thinking preprocess");
  assert.equal(prep.preprocessedBody.tools.length, 1, "native-fc mode must preserve original tools");
  assert.ok(prep.preprocessedBody.custom_include_body.includes("reasoningEffort: low"));
  console.log("[PASS] 35. v1.3.0 native-fc mode preserves tools with low thinking & crash fix");
}

// 36. v1.4.0 Mobile Tauri v2 URL/origin compatibility (tauri://, https://tauri.localhost, loopback port, opaque origin)
{
  const u1 = resolveLocalGenerateUrl("/api/backends/chat-completions/generate", { method: "POST" }, "tauri://localhost/index.html");
  assert.ok(u1 && u1.pathname === "/api/backends/chat-completions/generate", "must match relative URL under tauri://localhost");

  const u2 = resolveLocalGenerateUrl("http://127.0.0.1:41234/api/backends/chat-completions/generate", { method: "POST" }, "https://tauri.localhost/");
  assert.ok(u2 && u2.hostname === "127.0.0.1", "must match loopback local backend URL from Android https://tauri.localhost");

  const u3 = resolveLocalGenerateUrl("https://evil.example.com/api/backends/chat-completions/generate", { method: "POST" }, "http://tauri.localhost/");
  assert.equal(u3, null, "must reject remote non-local origins");

  const u4 = resolveLocalGenerateUrl("/api/backends/chat-completions/generate", { method: "GET" }, "http://tauri.localhost/");
  assert.equal(u4, null, "must reject non-POST requests");

  assert.equal(hasPresetReplyTool({ tools: [{ type: "function", function: { name: "soliumbra_reply", parameters: { type: "object", properties: {} } } }] }), true);
  assert.equal(hasPresetReplyTool({ tools: [{ type: "function", function: { name: "context", parameters: { type: "object", properties: {} } } }] }), false);
  console.log("[PASS] 36. v1.4.0 Mobile Tauri v2 URL/origin matching & preset reply tool detector");
}

// 37. v1.4.0 Silent empty-body STOP (native thinking ONLY, 0 visible chars, finishReason=STOP) triggers full-fallback rescue
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-neon",
    stream: true,
    messages: [{ role: "user", content: "写剧情" }],
    tools: [{
      type: "function",
      function: {
        name: "soliumbra_reply",
        parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } }, required: ["think_nya", "game_content"] },
      },
    }],
  }, { ...DEFAULT_SETTINGS, autoRescue: true });

  let seenCtx = null;
  const restored = await restorePgResponse(
    makeSseResponse([
      { candidates: [{ index: 0, content: { role: "model", parts: [{ thought: true, text: "先构思一下剧情走向……" }] } }] },
      { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50000, candidatesTokenCount: 364 } },
    ]),
    prep,
    undefined,
    () => {},
    async ctx => {
      seenCtx = ctx;
      const built = buildRescueRequestBody(prep, DEFAULT_SETTINGS, ctx);
      assert.equal(built.rescueToolName, "soliumbra_reply");
      const sse = makeSseResponse([
        { candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: "soliumbra_reply", args: { think_nya: "补全思考", game_content: "<game>完整补全的正文</game>" } } }] } }] },
        { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }] },
      ]);
      return readRescueFunctionResponse(sse, built.rescueTarget);
    },
  );
  const out = await readRestoredSse(restored);
  assert.equal(seenCtx.mode, "full-fallback");
  assert.equal(seenCtx.reason, "EMPTY_STOP");
  assert.equal(out.finishReason, "STOP");
  assert.equal(out.text, "<think_nya>\n补全思考\n</think_nya><!--</think>-->\n<game>完整补全的正文</game>");
  console.log("[PASS] 37. v1.4.0 Thinking-only silent STOP auto-rescues via full-fallback functionCall");
}

// 38. v1.4.0 Soliumbra emits ONLY think_nya & 0 game_content with finishReason=STOP -> MISSING_BODY_STOP rescue stitches <game>
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-neon",
    stream: true,
    messages: [{ role: "user", content: "继续" }],
    tools: [{
      type: "function",
      function: {
        name: "soliumbra_reply",
        parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } }, required: ["think_nya", "game_content"] },
      },
    }],
  }, { ...DEFAULT_SETTINGS, autoRescue: true });

  let seenCtx = null;
  const restored = await restorePgResponse(
    makeSseResponse([
      { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"think_nya":"小猫规划完就停了","game_content":""}' }] } }] },
      { candidates: [{ index: 0, content: { role: "model", parts: [] }, finishReason: "STOP" }] },
    ]),
    prep,
    undefined,
    () => {},
    async ctx => {
      seenCtx = ctx;
      const built = buildRescueRequestBody(prep, DEFAULT_SETTINGS, ctx);
      assert.equal(built.rescueToolName, "continuation_reply");
      assert.ok(built.body.messages.at(-1).content.includes("仅输出了思考规划"), "prompt must instruct model to write missing body");
      return { text: "<game>\n补写出来的完整正文内容。\n</game>", finishReason: "STOP" };
    },
  );
  const out = await readRestoredSse(restored);
  assert.equal(seenCtx.mode, "continue");
  assert.equal(seenCtx.reason, "MISSING_BODY_STOP");
  assert.equal(out.finishReason, "STOP");
  assert.equal(out.text, "<think_nya>\n小猫规划完就停了\n</think_nya><!--</think>-->\n<game>\n补写出来的完整正文内容。\n</game>");
  console.log("[PASS] 38. v1.4.0 Think-only soliumbra STOP auto-rescues missing <game> body");
}

// 39. v1.4.0 Stream EOF without finishReason after only thinking still auto-rescues cleanly
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-neon",
    stream: true,
    messages: [{ role: "user", content: "继续" }],
    tools: [{
      type: "function",
      function: {
        name: "soliumbra_reply",
        parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } }, required: ["think_nya", "game_content"] },
      },
    }],
  }, { ...DEFAULT_SETTINGS, autoRescue: true });

  const restored = await restorePgResponse(
    makeSseResponse([
      { candidates: [{ index: 0, content: { role: "model", parts: [{ text: '{"think_nya":"只来得及思考' }] } }] },
    ]),
    prep,
    undefined,
    () => {},
    async ctx => {
      assert.equal(ctx.reason, "MISSING_BODY_STOP");
      assert.ok(ctx.collectedText.includes("</think_nya><!--</think>-->"), "think_nya must be cleanly closed before body rescue");
      return { text: "<game>补全正文</game>", finishReason: "STOP" };
    },
  );
  const out = await readRestoredSse(restored);
  assert.equal(out.text, "<think_nya>\n只来得及思考\n</think_nya><!--</think>-->\n<game>补全正文</game>");
  console.log("[PASS] 39. v1.4.0 EOF without finishReason after think_nya closes tag and rescues body");
}

// 40. v1.4.1 Preset reasoning_effort ('low'/'min') auto-bridges to Gemini 4 custom_include_body even after Meowssiah deletes request.reasoning_effort
{
  const prep = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "soliumbra_reply", parameters: { type: "object", properties: { think_nya: { type: "string" }, game_content: { type: "string" } } } } }],
  }, { ...DEFAULT_SETTINGS, thinkingEffort: "preset" }, null, { hostReasoningEffort: "low" });
  assert.equal(prep.thinkingApplied, "low");
  assert.deepEqual(JSON.parse(prep.body.custom_include_body), { reasoningEffort: "low" });

  // Also works in native-fc mode!
  const prepFc = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "soliumbra_reply", parameters: { type: "object", properties: { game_content: { type: "string" } } } } }],
  }, { ...DEFAULT_SETTINGS, mode: "native-fc", thinkingEffort: "preset" }, null, { hostReasoningEffort: "min" });
  assert.equal(prepFc.bypass, "native-fc-mode");
  assert.equal(prepFc.thinkingApplied, "low");
  assert.equal(prepFc.thinkingDowngradedFrom, "minimal");
  assert.deepEqual(JSON.parse(prepFc.preprocessedBody.custom_include_body), { reasoningEffort: "low" });
  console.log("[PASS] 40. v1.4.1 Preset reasoning_effort auto-bridges to Gemini 4 (streaming & native-fc)");
}

// 41. v1.4.1 Preset bridge respects explicit custom_include_body reasoning key and ignores 'auto'
{
  const withCustom = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    custom_include_body: "reasoning_effort: none",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "response_body", parameters: { type: "object", properties: { content: { type: "string" } } } } }],
  }, { ...DEFAULT_SETTINGS, thinkingEffort: "preset" }, null, { hostReasoningEffort: "low" });
  assert.equal(withCustom.thinkingApplied, null, "must NOT overwrite explicit custom_include_body reasoning key");
  assert.ok(withCustom.body.custom_include_body.includes("reasoning_effort: none"));

  const withAuto = preparePgRequest({
    chat_completion_source: "makersuite",
    model: "gemini-4-carbon",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "soliumbra_reply", parameters: { type: "object", properties: { game_content: { type: "string" } } } } }],
  }, { ...DEFAULT_SETTINGS, thinkingEffort: "preset" }, null, { hostReasoningEffort: "auto" });
  assert.equal(withAuto.thinkingApplied, null, "auto must not inject reasoningEffort");
  console.log("[PASS] 41. v1.4.1 Preset bridge preserves explicit custom_include_body & ignores auto");
}

console.log("\nALL 41 TEST SUITES PASSED!");
