// AI 管线单测：模型链拆分、SSE 流式解析、回退链（主模型失败切回退模型）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAiTask, splitModelChain, parseSseText, extractContent, AiTaskError } from './ai';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

function okJson(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
function errResp(status: number, msg: string) {
  return new Response(JSON.stringify({ error: { message: msg } }), { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  store.clear();
});

describe('splitModelChain（模型链拆分，字符串模型链拆分）', () => {
  it('拆主模型与回退列表', () => {
    expect(splitModelChain('deepseek-v4-flash,mimo-v2.5')).toEqual({ primary: 'deepseek-v4-flash', fallbacks: ['mimo-v2.5'] });
  });
  it('空/单模型', () => {
    expect(splitModelChain('')).toEqual({ primary: '', fallbacks: [] });
    expect(splitModelChain('mimo-v2.5')).toEqual({ primary: 'mimo-v2.5', fallbacks: [] });
  });
  it('去空白与空项', () => {
    expect(splitModelChain(' a ,, b , ')).toEqual({ primary: 'a', fallbacks: ['b'] });
  });
});

describe('SSE 流式解析', () => {
  it('收集 content delta，跳过 reasoning_content 与 [DONE]', () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}',
      'data: {"choices":[{"delta":{"content":"{\\"category\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"\\"餐饮\\"}"}}]}',
      'data: [DONE]',
    ].join('\n');
    expect(parseSseText(sse)).toBe('{"category":"餐饮"}');
  });
  it('非 data 行与坏行忽略', () => {
    expect(parseSseText(': keep-alive\n\ndata: {"choices":[{"delta":{"content":"x"}}]}')).toBe('x');
    expect(parseSseText('data: {bad json}\ndata: [DONE]')).toBe('');
  });
  it('普通 JSON 响应也能提取（防御上游非流式/测试 mock）', () => {
    expect(extractContent(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }))).toBe('{"a":1}');
  });
  it('无 content 返回空串', () => {
    expect(extractContent('no json')).toBe('');
  });
});

describe('模型链回退', () => {
  const task = (modelChain: string) => ({
    want: 'object' as const,
    modelChain,
    messages: () => [{ role: 'user', content: '分类' }],
    parse: (v: unknown): { ok: true; value: string } | { ok: false; reason: string } => {
      const o = v as { category?: unknown } | null;
      return o && typeof o.category === 'string'
        ? { ok: true, value: o.category }
        : { ok: false, reason: '缺 category 字段' };
    },
  });

  it('主模型传输错误 → 自动切回退模型成功', async () => {
    fetchMock.mockResolvedValueOnce(errResp(500, 'upstream down'));
    fetchMock.mockResolvedValueOnce(okJson('{"category":"餐饮"}'));
    const r = await runAiTask(task('flash主,回退'));
    expect(r).toBe('餐饮');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const models = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string).model);
    expect(models).toEqual(['flash主', '回退']);
  });

  it('主模型解析失败（自动修正后仍失败）→ 切回退模型成功', async () => {
    fetchMock.mockResolvedValueOnce(okJson('不是JSON')); // 主模型首次 no-json
    fetchMock.mockResolvedValueOnce(okJson('还不是JSON')); // 主模型自动修正 no-json
    fetchMock.mockResolvedValueOnce(okJson('{"category":"交通"}')); // 回退模型成功
    const r = await runAiTask({ ...task('a,b'), fixPrompt: () => '请重新输出严格 JSON' });
    expect(r).toBe('交通');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('全部模型失败 → 抛最后一个 AiTaskError', async () => {
    fetchMock.mockResolvedValue(okJson('不是JSON'));
    await expect(runAiTask({ ...task('a,b'), fixPrompt: () => '请重新输出' })).rejects.toThrow(AiTaskError);
  });

  it('外部 abort 原样上抛，不触发回退', async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation(() => {
      ac.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    await expect(runAiTask({ ...task('a,b'), signal: ac.signal })).rejects.toThrow(DOMException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('单模型（视觉任务拍照）不参与回退', async () => {
    fetchMock.mockResolvedValueOnce(errResp(500, 'down'));
    await expect(runAiTask({ ...task(''), model: 'mimo-v2.5' })).rejects.toThrow(AiTaskError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
