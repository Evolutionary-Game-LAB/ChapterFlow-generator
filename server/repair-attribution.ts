import {z} from 'zod';
/** Assess prose without showing the possibly faulty implementation. This is not a repair verdict. */
export const RepairAttribution=z.object({prose:z.enum(['consistent','contradictory','uncertain']),reason:z.string().min(1).max(240)}).strict();
export const attributionSchema={type:'object',additionalProperties:false,required:['prose','reason'],properties:{prose:{type:'string',enum:['consistent','contradictory','uncertain']},reason:{type:'string',minLength:1,maxLength:240}}};
export const attributionPrompt='생성된 장면 서술이 작가의 명시적 요구와 모순되는지만 판단하세요. authorBrief가 기준이고 scenes는 생성된 서술입니다. 기호 구현은 제공되지 않으며 추정하지 마세요. 서술이 작가 요구와 양립하면 consistent, 명시적으로 반대되는 사실을 말하면 contradictory, 해석이 모호하거나 판단 근거가 부족하면 uncertain입니다. 요구를 모든 장면에서 반복하지 않았다는 것은 모순이 아닙니다. 여러 경로의 선택에 따른 서로 다른 결과는 양립할 수 있습니다. 서술이 일치한다는 판정은 그래프 전체가 올바르다는 뜻이 아니며 심볼의 정확성은 이후 별도로 검사됩니다. 짧은 근거 한 문장과 JSON만 출력하세요.';
