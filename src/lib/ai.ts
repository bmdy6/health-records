export interface RecognizeResult {
  name: string;
  weight_g: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

// Browser calls the local runtime proxy. Keys never enter the client bundle.
export const aiConfig = {
  apiUrl: import.meta.env.VITE_AI_API_URL ?? '/api/ai/chat/completions',
  textModelChain: import.meta.env.VITE_AI_TEXT_MODEL_CHAIN ?? 'text',
  visionModel: import.meta.env.VITE_AI_VISION_MODEL ?? 'vision',
  thinking: (import.meta.env.VITE_AI_THINKING ?? 'disabled') as 'enabled' | 'disabled',
  // 单次调用超时（口述解析给足余量）
  timeoutMs: Number(import.meta.env.VITE_AI_TIMEOUT_MS ?? 45000),
  stream: (import.meta.env.VITE_AI_STREAM ?? 'true') !== 'false',
  // 各任务输出上限
  narrationMaxTokens: Number(import.meta.env.VITE_AI_NARRATION_MAX_TOKENS ?? 4000),
  classifyMaxTokens: Number(import.meta.env.VITE_AI_CLASSIFY_MAX_TOKENS ?? 500),
  foodMaxTokens: Number(import.meta.env.VITE_AI_FOOD_MAX_TOKENS ?? 2000),
} as const;

// 模型链拆分：逗号分割 → { primary, fallbacks }（主模型 + 回退模型列表）
export function splitModelChain(chain: string): { primary: string; fallbacks: string[] } {
  const models = chain.split(',').map((m) => m.trim()).filter(Boolean);
  return { primary: models[0] ?? '', fallbacks: models.slice(1) };
}

// —— SSE 解析（流式响应逐 data 行收集 content；跳过 reasoning_content）——
export function parseSseText(raw: string): string {
  let content = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      const delta = obj?.choices?.[0]?.delta;
      if (delta && typeof delta.content === 'string') content += delta.content;
    } catch {
      // 跳过坏行（keep-alive 注释等）
    }
  }
  return content;
}

// 从响应原文提取 content：兼容 SSE 流式文本与普通 JSON（防御上游非流式/测试 mock）
export function extractContent(raw: string): string {
  if (raw.includes('data:')) {
    const c = parseSseText(raw);
    if (c) return c;
  }
  try {
    const obj = JSON.parse(raw);
    const c = obj?.choices?.[0]?.message?.content;
    return typeof c === 'string' ? c : '';
  } catch {
    return '';
  }
}

// 传输层错误（HTTP 非 2xx / 网络失败 / 超时）：不参与自动修正，直接失败（可触发模型链回退）
class VisionTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionTransportError';
  }
}

// 结构化任务错误：kind 分类 + 说人话 message + 安全摘要（≤120 字，不暴露 schema/SyntaxError）
export type AiErrorKind = 'no-json' | 'invalid-json' | 'invalid-schema' | 'transport';

export class AiTaskError extends Error {
  readonly kind: AiErrorKind;
  readonly summary: string;

  constructor(kind: AiErrorKind, message: string, summary: string) {
    super(message);
    this.name = 'AiTaskError';
    this.kind = kind;
    this.summary = summary;
  }
}

// 超时 + 外部 signal 合并为一个 fetch signal（外部 abort 或超时都会终止请求）
function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const propagate = () => ac.abort(signal?.reason);
  if (signal?.aborted) propagate();
  signal?.addEventListener('abort', propagate, { once: true });
  return {
    signal: ac.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', propagate);
    },
  };
}

interface CallOptions {
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
  endpoint?: string;
  stream?: boolean;
}

interface ChatBody {
  model: string;
  messages: unknown[];
  temperature: number;
  max_tokens: number;
  thinking?: { type: 'enabled' | 'disabled' };
  stream?: boolean;
}

// 读响应体全文（流式 SSE 或普通 JSON 均为文本）
async function readBodyText(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

// 统一请求构造：关闭深度思考（temperature=0 + thinking disabled）；stream 默认开
async function callVision(messages: unknown[], opts: CallOptions = {}): Promise<string> {
  const {
    maxTokens = 2000, timeoutMs = aiConfig.timeoutMs, signal,
    model = splitModelChain(aiConfig.textModelChain).primary, endpoint = aiConfig.apiUrl,
    stream = aiConfig.stream,
  } = opts;
  const body: ChatBody = {
    model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    stream,
  };
  const merged = mergeSignals(signal, timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: merged.signal,
    });
  } catch (e) {
    // 超时：merged.signal 被我们 abort（reason=TimeoutError）；外部 signal 未 abort 才算超时
    if (merged.signal.aborted && !signal?.aborted) {
      throw new VisionTransportError('识别超时，请检查网络后重试');
    }
    if (signal?.aborted) throw e; // 外部主动取消：原样上抛，由调用方决定
    throw new VisionTransportError('网络错误，请检查网络后重试');
  } finally {
    merged.clear();
  }
  const raw = await readBodyText(resp).catch(() => '');
  if (!resp.ok) {
    let serverMsg = '';
    try {
      const obj = JSON.parse(raw);
      serverMsg = typeof obj?.error?.message === 'string' ? obj.error.message : '';
    } catch {
      // ignore
    }
    throw new VisionTransportError(serverMsg ? `识别失败：${serverMsg.slice(0, 60)}` : `识别失败（${resp.status}）`);
  }
  return extractContent(raw);
}

// —— JSON 容错提取 ——
// 按顺序尝试：①完整内容解析 ②```json 代码块 ③括号配对扫描（识别字符串/转义，不做贪婪匹配）
// 返回类型匹配的第一个结果；替换旧的贪婪正则（会吞掉多段 JSON）
type JsonExtract = { status: 'ok'; value: unknown } | { status: 'no-json' } | { status: 'invalid-json' };

// 括号配对扫描：从 content 中取第一个最外层配对区间，跳过字符串内容与转义字符
function extractBalanced(content: string, open: string, close: string): string | null {
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; } // 跳过转义字符（如 \" ）
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close) {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) return content.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractJson(content: string, want: 'object' | 'array'): JsonExtract {
  const open = want === 'array' ? '[' : '{';
  const close = want === 'array' ? ']' : '}';
  const matchesType = (v: unknown): boolean =>
    want === 'array' ? Array.isArray(v) : typeof v === 'object' && v !== null && !Array.isArray(v);

  // 候选按优先级排列：完整内容 → 第一个 ```json/``` 代码块 → 目标括号配对区间
  const texts: string[] = [content.trim()];
  const fence = content.match(/```(?:json)?\s*\r?\n?([\s\S]*?)(?:```|$)/i);
  if (fence?.[1]?.trim()) texts.push(fence[1].trim());
  const balanced = extractBalanced(content, open, close);
  if (balanced) texts.push(balanced);

  let sawJson = false;
  for (const t of texts) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      continue; // 这段不是合法 JSON，试下一层
    }
    sawJson = true;
    if (matchesType(v)) return { status: 'ok', value: v };
  }
  // 有 JSON 但形状不对（如口述想要数组却返回对象），归为 invalid-json；否则 no-json
  const other = extractBalanced(content, want === 'array' ? '{' : '[', want === 'array' ? '}' : ']');
  return { status: sawJson || other ? 'invalid-json' : 'no-json' };
}

// 安全摘要：AI 响应去空白、去代码围栏后前 120 字符（供错误展示，不暴露响应原文细节）
function safeSummary(content: string): string {
  return content.replace(/```(?:json)?/gi, '').replace(/```/g, '').replace(/\s+/g, '').slice(0, 120);
}

export function truncateResponse(content: string, max = 1500): string {
  return content.length <= max ? content : `${content.slice(0, max)}…（已截断）`;
}

// —— 通用任务管线 ——
export type AiStage = 'calling' | 'correcting' | 'fallback';

export interface AiTask<T> {
  want: 'object' | 'array';
  // prompt 构造：支持延迟（读缓存命中时不构造）
  messages: unknown[] | (() => unknown[]);
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  model?: string;
  // 模型链：逗号分割，第一个主模型，后续回退；默认 aiConfig.textModelChain
  modelChain?: string;
  // 流式：默认 aiConfig.stream
  stream?: boolean;
  endpoint?: string;
  // 校验：JSON 形状对但内容不对 → invalid-schema + reason（供修正 prompt 使用）
  parse: (value: unknown) => { ok: true; value: T } | { ok: false; reason: string };
  // 可选：首次失败时自动修正一次（传输错误/超时不触发）
  fixPrompt?: (firstContent: string, reason: string) => string;
  // 可选：本地缓存（同 key 第二次秒出；失败结果不缓存）
  cache?: {
    key: string;
    read: (raw: string | null) => T | null;
    write: (v: T) => void;
  };
  onStage?: (stage: AiStage) => void;
  // 失败文案（默认通用）
  messages_?: Partial<Record<'no-json' | 'invalid-json' | 'invalid-schema', string>>;
}

function defaultHumanMessage(kind: 'no-json' | 'invalid-json' | 'invalid-schema'): string {
  switch (kind) {
    case 'no-json': return '解析失败：AI 没返回有效内容，请重试';
    case 'invalid-json': return 'AI 返回格式不对，请重试';
    case 'invalid-schema': return 'AI 返回的数据不完整，请重试';
  }
}

// 解析 + 校验：区分 无 JSON / JSON 格式错 / 内容校验错
function parseContent<T>(task: AiTask<T>, content: string): { ok: true; value: T } | { ok: false; kind: 'no-json' | 'invalid-json' | 'invalid-schema'; reason: string } {
  const ex = extractJson(content, task.want);
  if (ex.status !== 'ok') {
    return {
      ok: false,
      kind: ex.status,
      reason: ex.status === 'no-json' ? '没有找到任何 JSON，需要只输出对应格式的 JSON' : '返回的 JSON 无法解析或类型不对，需要只输出对应格式的 JSON',
    };
  }
  const v = task.parse(ex.value);
  if (v.ok) return { ok: true, value: v.value };
  return { ok: false, kind: 'invalid-schema', reason: v.reason };
}

// 单个模型的一次完整尝试：调用 → 解析 → 失败则自动修正一次 → 返回结果或抛 AiTaskError
async function attemptWithModel<T>(
  task: AiTask<T>,
  model: string,
  buildMessages: () => unknown[],
  callOpts: Omit<CallOptions, 'model'>,
  onStage: ((stage: AiStage) => void) | undefined,
): Promise<T> {
  // 第一次调用（缓存命中已在外层处理）
  const firstContent = await callVision(buildMessages(), { ...callOpts, model });
  const first = parseContent(task, firstContent);
  if (first.ok) return first.value;

  // 格式/schema 类错误：自动修正 1 次（网络/HTTP/超时已在 callVision 抛错，不重试）
  if (task.fixPrompt) {
    onStage?.('correcting');
    const fixContent = await callVision(
      [{ role: 'user', content: task.fixPrompt(firstContent, first.reason) }],
      { ...callOpts, model },
    );
    const fixed = parseContent(task, fixContent);
    if (fixed.ok) return fixed.value;
    throw new AiTaskError(fixed.kind, task.messages_?.[fixed.kind] ?? defaultHumanMessage(fixed.kind), safeSummary(fixContent));
  }

  // 无修正能力：直接抛首次错误
  throw new AiTaskError(first.kind, task.messages_?.[first.kind] ?? defaultHumanMessage(first.kind), safeSummary(firstContent));
}

export async function runAiTask<T>(task: AiTask<T>): Promise<T> {
  const { signal, onStage } = task;

  // 缓存命中：直接返回（不构造 prompt、不发请求）
  if (task.cache) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(task.cache.key);
    } catch {
      // ignore
    }
    const cached = task.cache.read(raw);
    if (cached !== null) return cached;
  }

  // 箭头函数体内不保留外部 typeof 收窄，显式断言
  const buildMessages: () => unknown[] = typeof task.messages === 'function'
    ? task.messages
    : () => task.messages as unknown[];

  // 模型列表：单模型（视觉任务）或模型链（主 + 回退）
  const modelList = task.model
    ? [task.model]
    : (() => {
      const c = splitModelChain(task.modelChain ?? aiConfig.textModelChain);
      return c.primary ? [c.primary, ...c.fallbacks] : [];
    })();
  if (modelList.length === 0) {
    throw new AiTaskError('transport', '未配置 AI 模型（检查 .env 的 VITE_AI_*）', '');
  }

  const callOpts = {
    maxTokens: task.maxTokens,
    timeoutMs: task.timeoutMs,
    signal,
    stream: task.stream ?? aiConfig.stream,
    endpoint: task.endpoint,
  };

  // 模型链回退：主模型失败（传输错误 或 解析失败含修正后）→ 依次切回退模型重试
  let lastError: AiTaskError | null = null;
  for (let i = 0; i < modelList.length; i++) {
    const model = modelList[i];
    onStage?.(i === 0 ? 'calling' : 'fallback');
    try {
      const value = await attemptWithModel(task, model, buildMessages, callOpts, onStage);
      task.cache?.write(value);
      return value;
    } catch (e) {
      if (e instanceof VisionTransportError) {
        lastError = new AiTaskError('transport', e.message, '');
        continue; // 传输错误：切下一个模型
      }
      if (e instanceof AiTaskError) {
        lastError = e;
        continue; // 解析失败（修正后仍失败）：切下一个模型
      }
      throw e; // 外部 abort 原样上抛
    }
  }
  // 所有模型都失败：抛最后一个错误（transport 错误给通用文案，其余保留解析细节）
  throw lastError ?? new AiTaskError('transport', '模型调用全部失败，请稍后重试', '');
}
