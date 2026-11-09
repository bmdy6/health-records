import { SYNTHETIC_FOODS } from '../../tests/synthetic-foods';
// 营养库单测（方案批次 1 安全网，低风险补充）
import { describe, it, expect, beforeEach } from 'vitest';
import { replaceFoodLibrary, findFood, searchFoods, calcFromLibrary, calcDailyNeeds, findFoodExact, FOOD_LIBRARY, calibrateFoodNutrition } from './nutrition';

beforeEach(() => replaceFoodLibrary(SYNTHETIC_FOODS.map(f=>({...f}))));

describe('FOOD_LIBRARY', () => {
  it('显式导入测试库后名称不重复', () => {
    const names = FOOD_LIBRARY.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(FOOD_LIBRARY.length).toBe(SYNTHETIC_FOODS.length); // explicit test-only library
  });
});

describe('findFood', () => {
  it('精确匹配', () => {
    const hit = findFood('鸡胸肉');
    expect(hit).toBeTruthy();
    expect(hit!.name).toBe('鸡胸肉');
    expect(hit!.kcal).toBe(133);
  });

  it('括号名称去括号后匹配（"米饭" → 米饭（均值））', () => {
    const hit = findFood('米饭');
    expect(hit).toBeTruthy();
    expect(hit!.name).toContain('米饭');
  });

  it('子串匹配优先短名', () => {
    const hit = findFood('苹果');
    expect(hit).toBeTruthy();
  });

  it('输入含库名时反向匹配', () => {
    const hit = findFood('一份鸡胸肉沙拉');
    expect(hit).toBeTruthy();
    expect(hit!.name).toContain('鸡胸肉');
  });

  it('空输入/无匹配返回 null', () => {
    expect(findFood('')).toBeNull();
    expect(findFood('   ')).toBeNull();
    expect(findFood('量子纠缠能量球')).toBeNull();
  });

  it('同义词自映射不无限递归（蛋炒饭/雪碧 是别名键==值）', () => {
    // 蛋炒饭在库中：自映射跳过 → 走精确匹配命中
    const egg = findFood('蛋炒饭');
    expect(egg).toBeTruthy();
    expect(egg!.name).toContain('蛋炒饭');
    // 雪碧不在库中：自映射跳过 → 不抛 RangeError，返回 null（合理）
    expect(findFood('雪碧')).toBeNull();
  });
});

describe('searchFoods', () => {
  it('最多 5 条且短名优先', () => {
    const r = searchFoods('鸡');
    expect(r.length).toBeLessThanOrEqual(5);
    expect(r[0].name.length).toBeLessThanOrEqual(r[r.length - 1].name.length);
  });

  it('空输入返回空', () => {
    expect(searchFoods('')).toEqual([]);
  });
});

describe('calcFromLibrary', () => {
  it('100g 鸡胸肉换算', () => {
    const r = calcFromLibrary(FOOD_LIBRARY.find((f) => f.name === '鸡胸肉')!, 100, 'g');
    expect(r.kcal).toBe(133);
    expect(r.protein).toBe(24);
  });

  it('2份（每份250g）换算', () => {
    const r = calcFromLibrary(FOOD_LIBRARY.find((f) => f.name === '鸡胸肉')!, 2, '份');
    expect(r.kcal).toBe(665); // 500g/100g = 5 倍 → 133*5
    expect(r.protein).toBe(120); // 24*5
  });
});

describe('findFoodExact', () => {
  it('完全同名匹配', () => {
    expect(findFoodExact('牛奶')).toBeTruthy();
  });

  it('不做模糊匹配（"汉堡"不会命中"素食汉堡"）', () => {
    // 若库中存在素食汉堡，精确查找"汉堡"应为 null 或完全同名
    const hit = findFoodExact('汉堡');
    expect(hit === null || hit.name === '汉堡').toBe(true);
  });
});

describe('calcDailyNeeds', () => {
  it('男性 TDEE 计算（Mifflin-St Jeor）', () => {
    const r = calcDailyNeeds({ sex: 'male', weightKg: 79, heightCm: 182, age: 22, activity: 1.55 });
    const bmr = 10 * 79 + 6.25 * 182 - 5 * 22 + 5;
    expect(r.bmr).toBe(Math.round(bmr));
    expect(r.tdee).toBe(Math.round(bmr * 1.55));
    expect(r.proteinG.min).toBe(Math.round(79 * 1.2));
    expect(r.proteinG.max).toBe(Math.round(79 * 1.6)); // maintain 模式蛋白上限 1.6（缺口期才拉高）
    expect(r.targetKcal).toBe(r.tdee); // maintain 目标=消耗
  });

  it('女性公式用 -161', () => {
    const r = calcDailyNeeds({ sex: 'female', weightKg: 55, heightCm: 165, age: 25, activity: 1.375 });
    const bmr = 10 * 55 + 6.25 * 165 - 5 * 25 - 161;
    expect(r.bmr).toBe(Math.round(bmr));
  });

  it('目标模式：热量按系数、蛋白随缺口拉高', () => {
    const base = { sex: 'male' as const, weightKg: 79, heightCm: 182, age: 22, activity: 1.55 };
    const tdee = calcDailyNeeds(base).tdee;
    const cut = calcDailyNeeds({ ...base, goalMode: 'cut-agg' });
    expect(cut.targetKcal).toBe(Math.round(tdee * 0.75)); // 积极减脂 TDEE−25%
    expect(cut.proteinG.min).toBe(Math.round(79 * 1.8)); // 缺口期蛋白拉高
    const bulk = calcDailyNeeds({ ...base, goalMode: 'bulk' });
    expect(bulk.targetKcal).toBe(Math.round(tdee * 1.075)); // 干净增肌 +7.5%
    const fasting = calcDailyNeeds({ ...base, goalMode: 'fasting' });
    expect(fasting.targetKcal).toBe(Math.round(tdee * 0.8));
  });

  it('手动覆盖优先于模式推荐', () => {
    const r = calcDailyNeeds({ sex: 'female', weightKg: 55, heightCm: 165, age: 25, activity: 1.375, goalMode: 'cut-agg', kcalOverride: 1800, proteinOverride: 150 });
    expect(r.targetKcal).toBe(1800);
    expect(r.proteinG.min).toBe(150);
    expect(r.proteinG.max).toBe(Math.max(150, Math.round(55 * 2.2)));
  });
});

describe('补库外食与匹配增强', () => {
  it('高频外食补库后可命中（辣条/炸鸡/黄焖鸡米饭/珍珠奶茶）', () => {
    expect(findFood('辣条')?.kcal).toBe(470);
    expect(findFood('炸鸡')?.kcal).toBe(279);
    expect(findFood('黄焖鸡米饭')?.kcal).toBe(145);
    expect(findFood('珍珠奶茶')?.kcal).toBe(55);
    expect(findFood('螺蛳粉')?.kcal).toBe(140);
  });

  it('去烹饪修饰词：水煮蛋→鸡蛋、可乐→可口可乐', () => {
    const egg = findFood('水煮蛋');
    expect(egg?.name).toBe('鸡蛋');
    expect(findFood('可乐')?.name).toContain('可乐');
  });

  it('calibrateFoodNutrition：库命中按每100g×克数重算', () => {
    const c = calibrateFoodNutrition('水煮蛋', 55); // 鸡蛋 143kcal/100g
    expect(c).not.toBeNull();
    expect(c!.kcal).toBe(Math.round((143 * 55) / 100));
  });

  it('calibrateFoodNutrition：库无此食物返回 null', () => {
    expect(calibrateFoodNutrition('量子能量餐', 100)).toBeNull();
    expect(calibrateFoodNutrition('水煮蛋', 0)).toBeNull();
  });
});
