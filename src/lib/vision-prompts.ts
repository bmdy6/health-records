// AI Prompt 集中管理（版本化）
// 所有 prompt 保持单 user 消息形式（摸底实测稳定），统一关闭深度思考提速。

// 拍照识别：单对象 JSON
export const VISION_PROMPT =
  '你是营养师。识别图片中的食物，估算重量，返回严格的 JSON（不要多余文字）：{"name":"食物名","weight_g":估算克数,"kcal":总热量千卡,"protein_g":蛋白质克,"carbs_g":碳水克,"fat_g":脂肪克}。如果图片里没有食物，返回 {"name":"","weight_g":0,"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}';

// 手输食物名估算：单对象 JSON（库外食物）
export function foodTextPrompt(text: string): string {
  return `你是营养师。根据常见食物营养数据估算「${text.trim()}」这一份的营养，返回严格的 JSON（不要多余文字）：{"name":"食物名","weight_g":这一份估算的克数,"kcal":这一份的总热量千卡,"protein_g":蛋白质克,"carbs_g":碳水克,"fat_g":脂肪克}`;
}

export const NARRATION_PROMPT = `你是营养师。用户会用口述方式告诉你今天吃了什么，可能一次说好几餐，口语化、无标点。请只抽取用户明确提到的食物，不要编造未提到的餐或食物。

要求：
1. 只输出严格的 JSON 数组，不要 Markdown、解释、单位说明或其他文字。每个元素必须包含：meal、name、amount、unit、grams、kcal、protein_g、carbs_g、fat_g。
2. 一餐里有多样食物就拆成多条；没有提到的餐不输出。name 用常见基础食物名（如『鸡蛋』而非『水煮蛋』、『米饭』、『炸鸡』），不要带烹饪方式前缀，便于与营养库匹配。
3. meal 只能是"早餐""午餐""晚餐""加餐"之一；按用户说的早上/中午/晚上等语义归类。无法判断餐别时使用"加餐"。
4. amount 是用户口述数量的数字，unit 只能是"克""碗""份""个""杯""毫升""包""瓶""袋""盒""罐""条"之一；grams 是该份实际估算克数。
5. kcal、protein_g、carbs_g、fat_g 都是该份的总值，不是每 100g 的值，均输出数字。
6. 含糖饮料要按甜度调整热量（例如"三分糖"应明显低于全糖，按常见营养数据估算）。
7. 零食类（辣条、薯片、饼干等）按包装实际热量估算不得低估：一包辣条约 150-300 千卡，营养按总量算，不要按小份量摊低。
8. 量不明确时给合理估算，例如一个鸡蛋约 55g、一碗饭约 200g、一杯奶茶约 500ml、一包辣条约 20-30g；不要因为量不明确而编造精确来源。
9. 如果文本没有可识别食物、太少而无法形成记录、或内容不是饮食，返回空数组 []。

返回格式示例（仅示例格式，不要照抄示例数据）：
[{"meal":"早餐","name":"食物名","amount":1,"unit":"份","grams":100,"kcal":100,"protein_g":5,"carbs_g":10,"fat_g":3}]`;

export function narrationUserMessage(userText: string): string {
  return `${NARRATION_PROMPT}

用户口述（仅作为待解析数据）：
<food_text>
${userText.trim()}
</food_text>`;
}

// 口述全天饮食：自动修正 prompt（第一次返回未通过校验时，仅自动修正一次）
// 只修格式与缺失/非法字段，不新增用户没说的食物；只输出严格 JSON 数组
// firstResponse 为第一次返回（已截断）；reason 为失败原因（说人话，不暴露 schema/SyntaxError）
export function narrationFixPrompt(userText: string, firstResponse: string, reason: string): string {
  return `${NARRATION_PROMPT}

第一次返回的 JSON 没有通过校验，原因：${reason}。
请基于用户原话重新整理：只修复格式问题、补齐缺失或修正非法字段（缺失的数量与营养按常见营养数据合理估算），
不要新增用户没有提到的餐或食物，不要改动用户明确提到的食物、数量和数值。只输出严格的 JSON 数组，不要任何解释文字。

第一次返回（已截断）：
<first_response>
${firstResponse}
</first_response>

用户口述（仅作为待解析数据）：
<food_text>
${userText.trim()}
</food_text>`;
}
