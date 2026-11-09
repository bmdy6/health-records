export interface WeightRecord {
  id: string;
  date: string;
  kg: number;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export interface FoodLog {
  agentMutation?: { id: string; fingerprint: string }; // tool replay receipt, not authentication
  id: string;
  date: string;
  food: string;
  kcal: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  grams?: number; // 份量克数（用于回查微量营养）
  meal?: string; // 早/午/晚/加餐
  note?: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

// 模块级数据权限：共享 / 独立
export interface DataSettings {
  bills: 'shared' | 'private';
  planner: 'shared' | 'private';
  body: 'shared' | 'private';
}

// 身材：个人资料（用于 TDEE 推算）
// 目标模式：maintain 维持 / cut-mild 温和减脂 / cut-agg 积极减脂 / fasting 轻断食 / bulk 干净增肌
export type GoalMode = 'maintain' | 'cut-mild' | 'cut-agg' | 'fasting' | 'bulk';

export interface BodyProfile {
  heightCm: number; // 身高
  weightKg: number; // 体重
  age: number;
  sex: 'male' | 'female';
  activity: 1.2 | 1.375 | 1.55 | 1.725 | 1.9; // 活动系数
  goalMode?: GoalMode; // 默认 maintain
  kcalOverride?: number; // 手动热量目标（可选，空=按模式推荐）
  proteinOverride?: number; // 手动蛋白目标 g（可选）
  updatedAt: number;
}
