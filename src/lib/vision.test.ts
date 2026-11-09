import { replaceFoodLibrary } from './nutrition';
import { SYNTHETIC_FOODS } from '../../tests/synthetic-foods';
// vision 通道单测：统一关思考、口述数组解析、缓存、错误语义
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recognizeFood, recognizeFoodText, recognizeFoodNarration, NarrationError } from './vision';
import { isFoodQuery } from './food-narration';

const VALID_ARRAY = JSON.stringify([
  { meal: '早餐', name: '水煮蛋', amount: 2, unit: '个', grams: 110, kcal: 154, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
  { meal: '午餐', name: '黄焖鸡米饭', amount: 1, unit: '份', grams: 400, kcal: 650, protein_g: 30, carbs_g: 80, fat_g: 25 },
]);

const store = new Map<string, string>();
const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

function okResponse(content: string, usage?: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errResponse(status: number, msg: string) {
  return new Response(JSON.stringify({ error: { message: msg } }), { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  store.clear();
  replaceFoodLibrary(SYNTHETIC_FOODS.map(f=>({...f})));
});

describe('统一请求构造：使用兼容请求', () => {
  it('口述请求不带非标准 thinking 字段，保留 token 上限', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID_ARRAY));
    await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4000);
    expect(body.model).toBe('text');
    expect(body.stream).toBe(true); // 口述走流式（zen/go 非流式排队慢）
  });

  it('手输请求不含非标准参数或密钥', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('{"name":"米饭","weight_g":200,"kcal":232,"protein_g":5.2,"carbs_g":51,"fat_g":0.6}'));
    await recognizeFoodText('酱香饼');
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body as string);
      expect(body.thinking).toBeUndefined();
      expect(call[1].headers.Authorization ?? call[1].headers.authorization ?? '').toBe('');
      expect(JSON.stringify(body)).not.toContain('enable_thinking');
    }
  });

  it('拍照请求使用视觉模型别名且不含密钥', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('{"name":"苹果","weight_g":150,"kcal":80,"protein_g":0.3,"carbs_g":20,"fat_g":0.2}'));
    await recognizeFood('base64data');
    // 拍照识别走视觉模型（mimo-v2.5 全模态，flash 不支持图片），不再走 qwen/阿里
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).not.toContain('/api/vision/qwen/');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.model).toBe('vision'); // 拍照：视觉单模型（无回退链）
  });
});

describe('recognizeFoodNarration', () => {
  it('解析合法数组（含 Markdown 前缀容错：匹配第一个 []）', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('好的，这是解析结果：\n```json\n' + VALID_ARRAY + '\n```'));
    const items = await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    expect(items.length).toBe(2);
    expect(items[0].name).toBe('水煮蛋');
  });

  it('空数组合法返回 []（不抛错）', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('[]'));
    expect(await recognizeFoodNarration('今天没吃什么')).toEqual([]);
  });

  it('缓存命中不再请求（二次秒出）', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(VALID_ARRAY));
    await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('缓存坏数据时删除并重新请求', async () => {
    store.set('food-narration:v1:1ny8zyrn9', '{"not":"array"}'); // hash 需与文本一致，这里直接注入坏缓存
    fetchMock.mockResolvedValueOnce(okResponse(VALID_ARRAY));
    await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('HTTP 错误抛"识别失败"且不带响应原文', async () => {
    fetchMock.mockResolvedValue(errResponse(500, 'secret-internal-error')); // flash + mimo 都 500
    await expect(recognizeFoodNarration('随便说说')).rejects.toThrow('识别失败');
  });

  it('schema 非法整批拒绝（缺字段）', async () => {
    // flash 首次缺字段 → 修正仍缺字段 → mimo 回退同失败（共 4 次）→ 结构化错误（主文案：缺字段）
    fetchMock
      .mockResolvedValueOnce(okResponse('[{"meal":"早餐","name":"鸡蛋"}]'))
      .mockResolvedValueOnce(okResponse('[{"meal":"早餐","name":"鸡蛋"}]'))
      .mockResolvedValueOnce(okResponse('[{"meal":"早餐","name":"鸡蛋"}]'))
      .mockResolvedValueOnce(okResponse('[{"meal":"早餐","name":"鸡蛋"}]'));
    await expect(recognizeFoodNarration('吃了个鸡蛋')).rejects.toThrow('AI 返回的数据不完整');
  });

  it('无 JSON 抛解析失败', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse('抱歉我没听清'))
      .mockResolvedValueOnce(okResponse('抱歉我还是没听清'))
      .mockResolvedValueOnce(okResponse('抱歉我没听清'))
      .mockResolvedValueOnce(okResponse('抱歉我还是没听清'));
    await expect(recognizeFoodNarration('嗯嗯')).rejects.toThrow('解析失败');
  });

  it('空白输入直接返回 [] 不发请求', async () => {
    expect(await recognizeFoodNarration('   ')).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  // —— 疑问句拦截（查询意图不调模型，直接引导）——
  it('疑问句『今天吃了哪些东西』抛引导文案且不发请求', async () => {
    const err = await recognizeFoodNarration('今天吃了哪些东西').catch((e) => e);
    expect(err).toBeInstanceOf(NarrationError);
    expect(err.kind).toBe('query');
    expect(err.message).toContain('口述记录需要说出具体食物');
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('疑问句『今天吃了什么』抛引导文案且不发请求', async () => {
    const err = await recognizeFoodNarration('今天吃了什么').catch((e) => e);
    expect(err.kind).toBe('query');
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('疑问句不写缓存（重试仍拦截）', async () => {
    await expect(recognizeFoodNarration('今天吃了啥')).rejects.toThrow('口述记录需要说出具体食物');
    await expect(recognizeFoodNarration('今天吃了啥')).rejects.toThrow('口述记录需要说出具体食物');
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(Array.from(store.keys()).filter((k) => k.startsWith('food-narration:')).length).toBe(0);
  });

  it('正常口述不受影响（仍走模型返回食物）', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('[{"meal":"早餐","name":"水煮蛋","amount":2,"unit":"个","grams":110,"kcal":154,"protein_g":12.6,"carbs_g":1.1,"fat_g":10.6}]'));
    const items = await recognizeFoodNarration('早上吃了两个水煮蛋');
    expect(items.length).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(isFoodQuery('早上吃了两个水煮蛋')).toBe(false);
  });

  it('库优先校准：库命中的食物（水煮蛋→鸡蛋）按每100g×克数重算并打 library 标', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('[{"meal":"早餐","name":"水煮蛋","amount":2,"unit":"个","grams":110,"kcal":154,"protein_g":12.6,"carbs_g":1.1,"fat_g":10.6}]'));
    const items = await recognizeFoodNarration('早上吃了两个水煮蛋');
    expect(items[0].source).toBe('library');
    // 鸡蛋 143kcal/100g × 110g → 171kcal（AI 估的 154 被库值覆盖）
    expect(items[0].kcal).toBe(Math.round((143 * 110) / 100));
  });

  it('库未命中的食物保留 AI 估算并打 ai 标', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('[{"meal":"午餐","name":"量子能量餐","amount":1,"unit":"份","grams":300,"kcal":999,"protein_g":10,"carbs_g":30,"fat_g":20}]'));
    const items = await recognizeFoodNarration('中午吃了量子能量餐');
    expect(items[0].source).toBe('ai');
    expect(items[0].kcal).toBe(999); // AI 估算值原样保留
  });

  // —— 定稿批次 1 场景 1-8（自动修正 + 失败分类 + 缓存 + signal）——
  it('场景1: 代码块/前后解释提取、多 JSON 时取第一个完整数组', async () => {
    // 代码块 + 前后解释文字
    fetchMock.mockResolvedValueOnce(okResponse('好的，这是解析结果：\n```json\n' + VALID_ARRAY + '\n```\n希望有帮助'));
    const items = await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    expect(items.length).toBe(2);
    expect(items[0].name).toBe('水煮蛋');
    // 多段 JSON：旧的贪婪正则 `[\[\s\S]*\]` 会从第一个 [ 吞到最后一个 ]（整段非法）；新逻辑取第一个完整数组
    fetchMock.mockResolvedValueOnce(okResponse(
      '中间结果：[{"meal":"早餐","name":"水煮蛋","amount":2,"unit":"个","grams":110,"kcal":154,"protein_g":12.6,"carbs_g":1.1,"fat_g":10.6}]\n' +
      '最终结果：[{"meal":"午餐","name":"黄焖鸡米饭","amount":1,"unit":"份","grams":400,"kcal":650,"protein_g":30,"carbs_g":80,"fat_g":25},{"meal":"加餐","name":"苹果","amount":1,"unit":"个","grams":150,"kcal":80,"protein_g":0.3,"carbs_g":20,"fat_g":0.2}]'
    ));
    const first = await recognizeFoodNarration('中午吃的');
    expect(first.length).toBe(1);
    expect(first[0].name).toBe('水煮蛋');
  });

  it('场景2: 无 JSON → 自动修正成功（2 次 fetch）且修正成功写缓存', async () => {
    const stages: string[] = [];
    fetchMock.mockResolvedValueOnce(okResponse('抱歉，刚才没听清，请再说一遍'));
    fetchMock.mockResolvedValueOnce(okResponse(VALID_ARRAY));
    const items = await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭', { onStage: (s) => stages.push(s) });
    expect(items.length).toBe(2);
    expect(items[0].name).toBe('水煮蛋');
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(stages).toEqual(['calling', 'correcting']);
    // B2：修正成功后写缓存（同文本 hash 键），再次调用不再请求
    await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('场景3: schema 错 → 自动修正成功（2 次 fetch，修正 prompt 带失败原因）', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('[{"meal":"早餐","name":"鸡蛋"}]'));
    fetchMock.mockResolvedValueOnce(okResponse(VALID_ARRAY));
    const items = await recognizeFoodNarration('早上吃了两个水煮蛋，中午吃了黄焖鸡米饭');
    expect(items.length).toBe(2);
    expect(fetchMock.mock.calls.length).toBe(2);
    const fixBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const fixPrompt = fixBody.messages[0].content as string;
    expect(fixPrompt).toContain('第一次返回的 JSON 没有通过校验');
    expect(fixPrompt).toContain('数组元素缺少字段');
    expect(fixPrompt).toContain('不要新增用户没有提到的餐或食物');
  });

  it('场景4: 两次都失败 → 结构化错误含安全摘要（≤120 字，去空白去代码围栏）', async () => {
    // 模型链回退：flash 首试/修正 + mimo 回退/修正都失败（共 4 次）
    fetchMock
      .mockResolvedValueOnce(okResponse('抱歉 我 没听清\n```json\n\n```\n请再说一遍'))
      .mockResolvedValueOnce(okResponse('还是 没有 识别到\n```json\n(这里应该是数组)\n```'))
      .mockResolvedValueOnce(okResponse('抱歉 我 没听清\n```json\n\n```\n请再说一遍'))
      .mockResolvedValueOnce(okResponse('还是 没有 识别到\n```json\n(这里应该是数组)\n```'));
    const err = await recognizeFoodNarration('嗯嗯').catch((e) => e);
    expect(err).toBeInstanceOf(NarrationError);
    expect(err.kind).toBe('no-json');
    expect(err.message).toBe('解析失败：AI 没返回有效内容，请换个说法再试');
    expect(err.summary).toBe('还是没有识别到(这里应该是数组)');
    expect(err.summary.length).toBeLessThanOrEqual(120);
    expect(err.message).not.toContain('SyntaxError');
    expect(err.message).not.toContain('schema');
    expect(fetchMock.mock.calls.length).toBe(2); // configured text model + one repair
  });

  it('场景5: 失败不写缓存（再次调用重新请求）', async () => {
    // flash 首试/修正 + mimo 回退/修正都失败
    fetchMock
      .mockResolvedValueOnce(okResponse('抱歉没听清'))
      .mockResolvedValueOnce(okResponse('还是不行'));
    await expect(recognizeFoodNarration('早上吃了鸡蛋')).rejects.toThrow('解析失败');
    expect(Array.from(store.keys()).filter((k) => k.startsWith('food-narration:')).length).toBe(0);
    // 未写缓存 → 再调用会重新 fetch（flash 一次成功）
    fetchMock.mockResolvedValueOnce(okResponse(VALID_ARRAY));
    const items = await recognizeFoodNarration('早上吃了鸡蛋');
    expect(items.length).toBe(2);
    expect(fetchMock.mock.calls.length).toBe(3); // 2 次失败 + 1 次成功
  });

  it('场景6: 网络/HTTP 错误不触发自动修正', async () => {
    // flash + mimo 都网络错误（回退链也失败）
    fetchMock.mockRejectedValue(new Error('network down'));
    const err = await recognizeFoodNarration('早上吃了鸡蛋').catch((e) => e);
    expect(err).toBeInstanceOf(NarrationError);
    expect(err.kind).toBe('transport');
    expect(err.message).toBe('网络错误，请检查网络后重试');
    expect(fetchMock.mock.calls.length).toBe(1); // one configured text model
    // HTTP 错误同样不修正
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(errResponse(500, 'boom'));
    const err2 = await recognizeFoodNarration('早上吃了鸡蛋').catch((e) => e);
    expect(err2.kind).toBe('transport');
    expect(err2.message).toContain('识别失败');
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('场景7: [] 不触发自动修正', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('[]'));
    expect(await recognizeFoodNarration('今天没吃什么')).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('场景8: 外部 AbortSignal 传导到 fetch（切页/关闭 abort 生效；超时包装不丢 abort）', async () => {
    const ctrl = new AbortController();
    fetchMock.mockResolvedValueOnce(okResponse('[{"meal":"早餐","name":"鸡蛋","amount":1,"unit":"个","grams":55,"kcal":77,"protein_g":6,"carbs_g":0,"fat_g":5}]'));
    const p = recognizeFoodNarration('早上吃了个鸡蛋', { signal: ctrl.signal });
    // 请求已带合并后的 signal：外部 abort 应传导（fetch 收到的 signal.aborted 变 true）
    const fetchSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(fetchSignal.aborted).toBe(false);
    ctrl.abort();
    expect(fetchSignal.aborted).toBe(true);
    // 修正路径的第二次 fetch 同样传导
    fetchMock.mockResolvedValueOnce(okResponse('没听清'));
    fetchMock.mockResolvedValueOnce(okResponse('[{"meal":"午餐","name":"米饭","amount":1,"unit":"碗","grams":200,"kcal":232,"protein_g":5.2,"carbs_g":51,"fat_g":0.6}]'));
    await recognizeFoodNarration('中午吃了米饭', { signal: ctrl.signal });
    expect((fetchMock.mock.calls[1][1].signal as AbortSignal).aborted).toBe(true);
    expect((fetchMock.mock.calls[2][1].signal as AbortSignal).aborted).toBe(true);
    await p.catch(() => {}); // 消化首次请求的 abort 异常
  });
});

describe('既有行为回归', () => {
  it('recognizeFood 仍返回单对象', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('{"name":"苹果","weight_g":150,"kcal":80,"protein_g":0.3,"carbs_g":20,"fat_g":0.2}'));
    const r = await recognizeFood('b64');
    expect(r.name).toBe('苹果');
    expect(r.kcal).toBe(80);
  });

  it('recognizeFoodText 仍走 food-cache', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('{"name":"酱香饼","weight_g":200,"kcal":400,"protein_g":8,"carbs_g":50,"fat_g":15}'));
    await recognizeFoodText('酱香饼');
    expect(fetchMock.mock.calls.length).toBe(1);
    await recognizeFoodText('酱香饼');
    expect(fetchMock.mock.calls.length).toBe(1); // 缓存命中
  });







  it('超时：请求超过时限抛"识别超时"（外部 signal 未 abort 时）', async () => {
    vi.useFakeTimers();
    try {
      // flash + mimo 都挂起等超时（回退链二次超时）
      fetchMock.mockImplementation((_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
      );
      const p = recognizeFoodNarration('早上吃了两个鸡蛋').catch((e) => e); // 先绑定 catch，避免 unhandled rejection
      await vi.advanceTimersByTimeAsync(100000); // 覆盖 flash + mimo 两次超时（各 45s）
      const err = await p;
      expect(err).toBeInstanceOf(NarrationError);
      expect(err.kind).toBe('transport');
      expect(err.message).toContain('超时');
    } finally {
      vi.useRealTimers();
    }
  });
});
