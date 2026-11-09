import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NutritionCard, GoalCard } from './HealthCards';
import { summarizeNutrition, summarizeProgress } from '../../lib/health-summary';
import type { FoodLog } from '../../types';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-30T08:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });
const meal: FoodLog = { id:'f', date:'2026-10-30',food:'鸡蛋',kcal:200,protein:12,createdAt:1,updatedAt:1,deleted:false };
describe('health cards', () => {
  it('retains calorie and key gap summary outside the expandable detail', () => {
    const summary = summarizeNutrition([meal], { heightCm:175,weightKg:75,age:28,sex:'male',activity:1.2,kcalOverride:2000,proteinOverride:120,updatedAt:1 }, null, '2026-10-30');
    const html = renderToStaticMarkup(createElement(NutritionCard,{summary,date:'2026-10-30',calories:[],missingCalories:1}));
    expect(html).toContain('<details');
    const visibleSummary = html.slice(html.indexOf('<summary'),html.indexOf('</summary>'));
    expect(visibleSummary).toContain('今日营养');
    expect(visibleSummary).toContain('1,800');
    expect(visibleSummary).toContain('108');
    expect(html).toContain('部分记录未提供碳水');
    expect(html).not.toContain('undefined');
    expect(html).toContain('有 1 次训练未估算消耗');
  });
  it('does not fabricate a goal or time estimate for a new user', () => {
    const html = renderToStaticMarkup(createElement(GoalCard, {progress:summarizeProgress([],null,'2026-10-30'),onEdit:()=>{}}));
    expect(html).toContain('设置我的目标');
    expect(html).not.toContain('140');
    expect(html).toContain('暂不足以预测');
  });
});

it('never displays retained calorie estimates when training reads failed', () => {
  const html = renderToStaticMarkup(createElement(NutritionCard,{summary:summarizeNutrition([meal],null,null,'2026-10-30'),date:'2026-10-30',calories:[{min:200,max:300,source:'fixture'}],missingCalories:0,workoutsAvailable:false}));
  expect(html).toContain('暂不可用');
  expect(html).not.toContain('200–300');
});
