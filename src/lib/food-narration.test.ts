// 口述解析纯逻辑单测：校验、换算、映射、合并
import { describe, it, expect } from 'vitest';
import { validateNarration, toDrafts, scaleByAmount, scaleByGrams, draftToFoodLog, mergeFoodLogs, normalizeText, hashText, isFoodQuery } from './food-narration';

// strictValidate 已删（兼容包装，生产 0 引用）：测试保留原语义，本地简写（返回数组或 null）
const strict = (raw: unknown) => {
  const v = validateNarration(raw);
  return v.ok ? v.items : null;
};

const VALID_7: Array<Record<string, unknown>> = [
  { meal: '早餐', name: '水煮蛋', amount: 2, unit: '个', grams: 110, kcal: 154, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
  { meal: '早餐', name: '牛奶', amount: 1, unit: '杯', grams: 250, kcal: 150, protein_g: 7.5, carbs_g: 12.5, fat_g: 8 },
  { meal: '午餐', name: '黄焖鸡米饭', amount: 1, unit: '份', grams: 400, kcal: 650, protein_g: 30, carbs_g: 80, fat_g: 25 },
  { meal: '午餐', name: '苹果', amount: 1, unit: '个', grams: 150, kcal: 80, protein_g: 0.3, carbs_g: 20, fat_g: 0.2 },
  { meal: '加餐', name: '珍珠奶茶（三分糖）', amount: 1, unit: '杯', grams: 500, kcal: 300, protein_g: 2, carbs_g: 60, fat_g: 5 },
  { meal: '晚餐', name: '米饭', amount: 1, unit: '碗', grams: 200, kcal: 232, protein_g: 5.2, carbs_g: 51, fat_g: 0.6 },
  { meal: '晚餐', name: '青椒炒肉', amount: 1, unit: '份', grams: 200, kcal: 250, protein_g: 15, carbs_g: 10, fat_g: 18 },
];

describe('validateNarration（strict 简写）', () => {
  it('合法 7 条全过', () => {
    const r = strict(VALID_7);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(7);
    expect(r![0].meal).toBe('早餐');
  });

  it('空数组合法（无食物场景）', () => {
    expect(strict([])).toEqual([]);
  });

  it('非数组/null 拒绝', () => {
    expect(strict(null)).toBeNull();
    expect(strict({})).toBeNull();
    expect(strict('x')).toBeNull();
  });

  it('缺字段整批拒绝', () => {
    const bad = [{ meal: '早餐', name: '鸡蛋', amount: 1, unit: '个', grams: 55, kcal: 77, protein_g: 6, carbs_g: 0, fat_g: 5, carbs_g_extra: 0 }];
    delete (bad[0] as Record<string, unknown>).carbs_g;
    expect(strict(bad)).toBeNull();
  });

  it('非法枚举拒绝（meal/unit 不在白名单）', () => {
    const badMeal = structuredClone(VALID_7) as Record<string, unknown>[];
    badMeal[0].meal = '夜宵';
    expect(strict(badMeal)).toBeNull();
    const badUnit = structuredClone(VALID_7) as Record<string, unknown>[];
    badUnit[0].unit = '把';
    expect(strict(badUnit)).toBeNull();
  });

  it('负数/零/NaN 拒绝', () => {
    const badKcal = structuredClone(VALID_7) as Record<string, unknown>[];
    badKcal[0].kcal = -1;
    expect(strict(badKcal)).toBeNull();
    const badGrams = structuredClone(VALID_7) as Record<string, unknown>[];
    badGrams[0].grams = 0;
    expect(strict(badGrams)).toBeNull();
    const badAmount = structuredClone(VALID_7) as Record<string, unknown>[];
    badAmount[0].amount = NaN;
    expect(strict(badAmount)).toBeNull();
  });

  it('空白食物名拒绝', () => {
    const bad = structuredClone(VALID_7) as Record<string, unknown>[];
    bad[0].name = '   ';
    expect(strict(bad)).toBeNull();
  });
});

describe('validateNarration（带 reason 的结构化校验）', () => {
  it('合法 7 条全过（ok=true，items 完整）', () => {
    const v = validateNarration(VALID_7);
    expect(v.ok).toBe(true);
    expect(v.items!.length).toBe(7);
  });

  it('非数组 → not-array', () => {
    expect(validateNarration(null).reason).toBe('not-array');
    expect(validateNarration({}).reason).toBe('not-array');
    expect(validateNarration('x').reason).toBe('not-array');
  });

  it('元素缺字段 → missing-field（带字段名）', () => {
    const bad = structuredClone(VALID_7) as Record<string, unknown>[];
    delete bad[0].fat_g;
    const v = validateNarration(bad);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('missing-field');
    expect(v.field).toBe('fat_g');
  });

  it('空食物名 → missing-field（name）', () => {
    const bad = structuredClone(VALID_7) as Record<string, unknown>[];
    bad[0].name = '   ';
    const v = validateNarration(bad);
    expect(v.reason).toBe('missing-field');
    expect(v.field).toBe('name');
  });

  it('非法 meal → invalid-meal（meal）', () => {
    const bad = structuredClone(VALID_7) as Record<string, unknown>[];
    bad[0].meal = '夜宵';
    const v = validateNarration(bad);
    expect(v.reason).toBe('invalid-meal');
    expect(v.field).toBe('meal');
  });

  it('非法 unit → invalid-unit（unit）', () => {
    const bad = structuredClone(VALID_7) as Record<string, unknown>[];
    bad[0].unit = '把';
    const v = validateNarration(bad);
    expect(v.reason).toBe('invalid-unit');
    expect(v.field).toBe('unit');
  });

  it('日常单位通过：包/瓶/袋/盒/罐/条（真实口述「辣条10包」「可乐1瓶」曾因此失败）', () => {
    const items = structuredClone(VALID_7) as Record<string, unknown>[];
    items[0].unit = '包';
    items[1].unit = '瓶';
    items[2].unit = '袋';
    items[3].unit = '盒';
    items[4].unit = '罐';
    items[5].unit = '条';
    const v = validateNarration(items);
    expect(v.ok).toBe(true);
  });

  it('非法数字 → invalid-number（负数/零/NaN 带字段名）', () => {
    const badKcal = structuredClone(VALID_7) as Record<string, unknown>[];
    badKcal[0].kcal = -1;
    const v1 = validateNarration(badKcal);
    expect(v1.reason).toBe('invalid-number');
    expect(v1.field).toBe('kcal');
    const badGrams = structuredClone(VALID_7) as Record<string, unknown>[];
    badGrams[0].grams = 0;
    expect(validateNarration(badGrams).reason).toBe('invalid-number');
    const badAmount = structuredClone(VALID_7) as Record<string, unknown>[];
    badAmount[0].amount = NaN;
    expect(validateNarration(badAmount).reason).toBe('invalid-number');
  });

});

describe('草稿编辑换算', () => {
  it('改数量联动克数与营养（2 个 → 3 个）', () => {
    const [d] = toDrafts(strict(VALID_7)!, () => 'id-1');
    const s = scaleByAmount(d, 3);
    expect(s.amount).toBe(3);
    expect(s.grams).toBe(165);
    expect(s.kcal).toBe(231);
    expect(s.protein_g).toBeCloseTo(18.9);
  });

  it('改克数联动营养（110g → 55g 减半）', () => {
    const [d] = toDrafts(strict(VALID_7)!, () => 'id-1');
    const s = scaleByGrams(d, 55);
    expect(s.grams).toBe(55);
    expect(s.kcal).toBe(77);
    expect(s.fat_g).toBeCloseTo(5.3);
  });

  it('非法输入不崩溃（<=0 保持原值）', () => {
    const [d] = toDrafts(strict(VALID_7)!, () => 'id-1');
    expect(scaleByAmount(d, 0).amount).toBe(d.amount);
    expect(scaleByGrams(d, -5).grams).toBe(d.grams);
  });
});

describe('映射与合并', () => {
  it('7 条草稿 → 7 条 FoodLog，字段齐全', () => {
    const drafts = toDrafts(strict(VALID_7)!);
    const logs = drafts.map((d) => draftToFoodLog(d, '2026-08-07', 1000));
    expect(logs.length).toBe(7);
    expect(logs[0]).toMatchObject({ food: '水煮蛋', kcal: 154, protein: 12.6, meal: '早餐', grams: 110, deleted: false });
    expect(logs[0].id).toBeTruthy();
  });

  it('合并按 id 去重（重复确认不追加副本）', () => {
    const logs = toDrafts(strict(VALID_7)!).map((d) => draftToFoodLog(d, '2026-08-07', 1000));
    const again = mergeFoodLogs(logs, logs.slice(0, 3));
    expect(again.length).toBe(7);
  });

  it('合并追加新条目', () => {
    const logs = toDrafts(strict(VALID_7)!).map((d) => draftToFoodLog(d, '2026-08-07', 1000));
    const [extra] = toDrafts(strict([VALID_7[0]])!);
    const next = mergeFoodLogs(logs, [draftToFoodLog(extra, '2026-08-07', 2000)]);
    expect(next.length).toBe(8);
  });
});

describe('文本归一化与 hash', () => {
  it('trim + 折叠空白', () => {
    expect(normalizeText('  早上  吃了 鸡蛋  ')).toBe('早上 吃了 鸡蛋');
  });

  it('相同文本 hash 一致，不同文本 hash 不同', () => {
    expect(hashText('珍珠奶茶三分糖')).toBe(hashText('珍珠奶茶三分糖'));
    expect(hashText('珍珠奶茶三分糖')).not.toBe(hashText('珍珠奶茶全糖'));
  });
});

describe('isFoodQuery（口述疑问句检测）', () => {
  it('典型查询疑问句命中', () => {
    expect(isFoodQuery('今天吃了哪些东西')).toBe(true);
    expect(isFoodQuery('今天吃了什么')).toBe(true);
    expect(isFoodQuery('今天吃了啥')).toBe(true);
    expect(isFoodQuery('我早上吃了什么')).toBe(true);
    expect(isFoodQuery('今天都吃了哪些')).toBe(true);
  });

  it('正常口述不命中（有量词/具体食物）', () => {
    expect(isFoodQuery('早上吃了两个水煮蛋，中午吃了一份黄焖鸡米饭')).toBe(false);
    expect(isFoodQuery('吃了什么？两个鸡蛋')).toBe(false);
    expect(isFoodQuery('吃了啥，一碗面')).toBe(false);
  });

  it('否定句不命中（陈述没吃，走正常空结果）', () => {
    expect(isFoodQuery('今天没吃什么')).toBe(false);
    expect(isFoodQuery('今天什么都没吃')).toBe(false);
    expect(isFoodQuery('今天不吃了')).toBe(false);
  });

  it('无吃/无疑问词不命中', () => {
    expect(isFoodQuery('今天天气不错')).toBe(false);
    expect(isFoodQuery('')).toBe(false);
    expect(isFoodQuery('   ')).toBe(false);
  });
});
