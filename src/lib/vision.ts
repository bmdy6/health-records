// 拍照/文字识别 + 口述饮食：全部走 lib/ai.ts 统一任务管线
// （传输含超时+外部 signal；JSON 容错提取；一次自动修正；缓存）
// 保留对外 API 兼容：RecognizeResult / NarrationError / compressImage / pendingRec
import {
  runAiTask,
  AiTaskError,
  truncateResponse,
  aiConfig,
  type RecognizeResult,
  type AiStage,
} from './ai';
import {
  VISION_PROMPT,
  foodTextPrompt,
  narrationUserMessage,
  narrationFixPrompt,
} from './vision-prompts';
import {
  validateNarration,
  normalizeText,
  hashText,
  isFoodQuery,
  type OralFoodAIItem,
  type NarrationValidation,
} from './food-narration';
import { calibrateFoodNutrition } from './nutrition';

export type { RecognizeResult } from './ai';
export type NarrationStage = AiStage;
export type NarrationErrorKind = 'no-json' | 'invalid-json' | 'invalid-schema' | 'transport' | 'query';

// 结构化错误：kind 分类 + 说人话 message + 安全摘要（≤120 字，不暴露 schema/SyntaxError）
export class NarrationError extends Error {
  readonly kind: NarrationErrorKind;
  readonly summary: string;

  constructor(kind: NarrationErrorKind, message: string, summary: string) {
    super(message);
    this.name = 'NarrationError';
    this.kind = kind;
    this.summary = summary;
  }
}

// 压缩图片到 maxSize 并返回 JPEG base64（不含 data: 前缀）
export async function compressImage(file: File, maxSize = 1024): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
}

export async function recognizeFood(base64: string): Promise<RecognizeResult> {
  return runAiTask<RecognizeResult>({
    want: 'object',
    model: aiConfig.visionModel,
    stream: false, // 拍照无中间态，不走流式
    messages: () => [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
        ],
      },
    ],
    timeoutMs: 30000,
    parse: (v) => ({ ok: true, value: v as RecognizeResult }),
  });
}

// 按食物名直接估算营养（库里没有的食物，如"酱香饼 1份"）
// 带缓存：同一食物名第二次秒出；结果存 localStorage，切页不丢
export async function recognizeFoodText(text: string): Promise<RecognizeResult> {
  const key = `food-cache:${text.trim()}`;
  return runAiTask<RecognizeResult>({
    want: 'object',
    maxTokens: aiConfig.foodMaxTokens,
    messages: () => [{ role: 'user', content: foodTextPrompt(text) }],
    timeoutMs: 30000,
    parse: (v) => {
      const o = v as Partial<RecognizeResult> | null;
      if (o && typeof o.name === 'string') return { ok: true, value: o as RecognizeResult };
      return { ok: false, reason: '返回结果缺少 name 字段' };
    },
    cache: {
      key,
      read: (raw) => {
        try {
          return raw ? (JSON.parse(raw) as RecognizeResult) : null;
        } catch {
          return null;
        }
      },
      write: (r) => {
        try {
          localStorage.setItem(key, JSON.stringify(r));
        } catch {
          // ignore
        }
      },
    },
  });
}

// —— 口述全天饮食：一次解析多餐多食物（JSON 数组）——
export interface NarrationOptions {
  signal?: AbortSignal;
  onStage?: (stage: NarrationStage) => void;
}

// 口述疑问句引导文案：不调模型直接返回（查询意图，如『今天吃了什么/哪些东西』）
const QUERY_GUIDANCE_MESSAGE = '你想查今天吃什么了？口述记录需要说出具体食物，比如：早上吃了两个水煮蛋一杯牛奶，中午吃了一份黄焖鸡米饭';

// 缓存：同文本（归一化后 hash）第二次秒出；只缓存通过严格校验的结果（含自动修正成功）
// 失败/中间结果不缓存
const NARRATION_CACHE_PREFIX = 'food-narration:v1:';

// schema 校验失败 → 供修正 prompt 使用的原因文案（说人话，不暴露 schema/SyntaxError）
function schemaReasonText(v: NarrationValidation): string {
  switch (v.reason) {
    case 'not-array': return '返回的不是 JSON 数组';
    case 'missing-field': return v.field ? `数组元素缺少字段「${v.field}」` : '数组元素缺少字段';
    case 'invalid-meal': return `数组元素字段「${v.field ?? 'meal'}」不在允许范围（早餐/午餐/晚餐/加餐）`;
    case 'invalid-unit': return `数组元素字段「${v.field ?? 'unit'}」不在允许范围（克/碗/份/个/杯/毫升/包/瓶/袋/盒/罐/条）`;
    case 'invalid-number': return v.field ? `数组元素字段「${v.field}」必须是正数或非负数字` : '数组元素存在非法数字';
    default: return '数组元素校验失败';
  }
}

// text, options 向后兼容（signal 真传给 fetch，切页/关闭时 abort 生效）
export async function recognizeFoodNarration(text: string, options: NarrationOptions = {}): Promise<OralFoodAIItem[]> {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  // 疑问句（查询意图）：不调模型，直接抛引导文案（前端已展示 NarrationError.message）
  if (isFoodQuery(normalized)) {
    throw new NarrationError('query', QUERY_GUIDANCE_MESSAGE, '');
  }
  const { signal, onStage } = options;
  const key = NARRATION_CACHE_PREFIX + hashText(normalized);
  try {
    const items = await runAiTask<OralFoodAIItem[]>({
      want: 'array',
      messages: () => [{ role: 'user', content: narrationUserMessage(normalized) }],
      maxTokens: aiConfig.narrationMaxTokens,
      timeoutMs: aiConfig.timeoutMs,
      signal,
      onStage,
      parse: (v) => {
        const r = validateNarration(v);
        return r.ok
          ? { ok: true, value: r.items as OralFoodAIItem[] }
          : { ok: false, reason: schemaReasonText(r) };
      },
      // 格式/schema 类错误：自动修正 1 次（网络/HTTP/超时已在传输层抛错不重试）
      fixPrompt: (firstContent, reason) => narrationFixPrompt(normalized, truncateResponse(firstContent), reason),
      cache: {
        key,
        read: (raw) => {
          if (raw === null) return null;
          try {
            const r = validateNarration(JSON.parse(raw));
            if (r.ok) return r.items as OralFoodAIItem[];
            localStorage.removeItem(key); // 坏缓存，重取
          } catch {
            // ignore
          }
          return null;
        },
        write: (items) => {
          try {
            localStorage.setItem(key, JSON.stringify(items));
          } catch {
            // ignore
          }
        },
      },
      messages_: {
        'no-json': '解析失败：AI 没返回有效内容，请换个说法再试',
        'invalid-json': 'AI 返回格式不对，请重试或换个说法',
        'invalid-schema': 'AI 返回的数据不完整，请重试或换个说法',
      },
    });
    // 营养库优先校准：库命中（如鸡蛋/米饭/辣条/炸鸡）→ 用每100g×克数重算，AI 估的密度作废
    // 库未命中 → 保留 AI 估算并打 source:'ai' 标（确认页可见）
    return items.map((it) => {
      const c = calibrateFoodNutrition(it.name, it.grams);
      if (!c) return { ...it, source: 'ai' as const };
      return { ...it, kcal: c.kcal, protein_g: c.protein, carbs_g: c.carbs, fat_g: c.fat, source: 'library' as const };
    });
  } catch (e) {
    if (e instanceof AiTaskError) throw new NarrationError(e.kind, e.message, e.summary);
    throw e; // 外部 abort 原样上抛
  }
}

// —— 待确认识别结果持久化（切页不丢）——
const PENDING_KEY = 'food-pending-rec';

export function savePendingRec(r: RecognizeResult): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(r));
  } catch {
    // ignore
  }
}

export function getPendingRec(): RecognizeResult | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as RecognizeResult) : null;
  } catch {
    return null;
  }
}

export function clearPendingRec(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}
