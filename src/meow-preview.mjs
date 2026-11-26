// 小猫预设（Meowssiah）流式思考块平滑预览：
// 1) 流式阶段隐藏 </think_nya> 后的 <!--</think>--> 占位注释，避免界面闪出残余 HTML；
// 2) 思考切到正文时先给思考块一次重绘机会，再平滑展开正文（防并发回退闪烁与空串覆盖 DOM）。
const PLAN_END = "</think_nya><!--</think>-->";

function afterPaint() {
  return new Promise(resolve => {
    let frame;
    const done = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(done, 80);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(done);
    });
  });
}

export function installPgMeowPreview(getContext, isActive) {
  const ctx = getContext();
  const eventSource = ctx?.eventSource;
  const eventTypes = ctx?.eventTypes ?? ctx?.event_types;
  const messageFormatter = ctx?.messageFormatter;
  const streams = new WeakSet();
  if (!eventSource || !messageFormatter?.addHook || !eventTypes?.STREAM_TOKEN_RECEIVED) return streams;
  let active;

  messageFormatter.addHook((text, floor) => {
    if (active?.bodyLimit == null || floor.isUser || floor.isSystem || floor.isReasoning) return text;
    const { processor, bodyLimit } = active;
    if (processor !== getContext().streamingProcessor || processor.isFinished || floor.messageId !== processor.messageId) return text;
    const prefix = processor.continueMessage || "";
    const start = prefix && text.startsWith(prefix) ? prefix.length : 0;
    const end = text.indexOf(PLAN_END, start);
    if (end < 0) return text;
    return text.slice(0, end + PLAN_END.length + bodyLimit).replace(/[\uD800-\uDBFF]$/, "");
  }, { stage: messageFormatter.stage.BEFORE_REGEX });

  messageFormatter.addHook((text, floor) => {
    if (!text.includes(PLAN_END) || floor.isUser || floor.isSystem || floor.isReasoning) return text;
    const processor = getContext().streamingProcessor;
    if (!isActive() || !processor || !streams.has(processor) || processor.isFinished || processor.messageId !== floor.messageId) return text;
    return text.replaceAll(PLAN_END, "</think_nya>");
  }, { stage: messageFormatter.stage.AFTER_REGEX });

  eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, async text => {
    const processor = getContext().streamingProcessor;
    if (!processor || !streams.has(processor) || processor.type === "impersonate") return;
    if (typeof processor.onProgressStreaming !== "function") return;
    if (active?.processor !== processor) {
      if (typeof text !== "string" || !text.startsWith("<think_nya>")) return;
      active = watch(processor, getContext);
    }
    await active.received(text);
  });

  const clearActive = () => {
    if (
      !active
      || active.processor !== getContext().streamingProcessor
      || active.processor.isFinished
      || active.processor.abortController?.signal?.aborted
    ) {
      active = undefined;
    }
  };
  if (eventTypes.GENERATION_ENDED) eventSource.on(eventTypes.GENERATION_ENDED, clearActive);
  if (eventTypes.GENERATION_STOPPED) eventSource.on(eventTypes.GENERATION_STOPPED, clearActive);

  return streams;
}

function watch(processor, getContext) {
  const state = { processor, bodyLimit: null, received };
  const progress = processor.onProgressStreaming.bind(processor);
  const signal = processor.abortController?.signal;
  const fps = Math.max(1, Number(getContext().powerUserSettings?.streaming_fps) || 60);
  const interval = 1000 / fps;
  const current = () => !(signal?.aborted) && !processor.isFinished && getContext().streamingProcessor === processor;

  let latestText = "";
  const fullNow = () => {
    const res = typeof processor.result === "string" ? processor.result : "";
    const body = res.length >= latestText.length ? res : latestText;
    return (processor.continueMessage || "") + body;
  };

  let timer;
  let trailingPaint;
  let planClosed = false;
  let revealing = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  signal?.addEventListener("abort", cancel, { once: true });

  processor.onProgressStreaming = async (...args) => {
    cancel();
    if (trailingPaint) await trailingPaint;
    return progress(...args);
  };

  async function received(text) {
    if (typeof text === "string" && text.length >= latestText.length) {
      latestText = text;
    }
    if (trailingPaint) await trailingPaint;
    if (!current()) return;
    const end = planClosed ? -1 : latestText.indexOf(PLAN_END);
    if (end >= 0) {
      planClosed = true;
      const tail = latestText.slice(end + PLAN_END.length);
      if (!document.hidden) {
        cancel();
        revealing = true;
        const step = Math.max(64, Math.ceil(tail.length / 4));
        try {
          for (let length = 0; length < Math.max(1, tail.length) && current() && !document.hidden; length += step) {
            state.bodyLimit = length;
            await progress(processor.messageId, fullNow());
            await afterPaint();
          }
        } finally {
          state.bodyLimit = null;
          revealing = false;
        }
        if (!current()) return;
      }
    }
    if (!revealing && timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        if (revealing || !current()) return;
        trailingPaint = progress(processor.messageId, fullNow())
          .catch(() => {})
          .finally(() => {
            trailingPaint = undefined;
          });
      }, interval);
    }
  }

  return state;
}
