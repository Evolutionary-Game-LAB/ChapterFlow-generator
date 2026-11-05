import {z} from 'zod';

export const BranchComplexitySchema=z.enum(['low','medium','high']);
export type BranchComplexity=z.infer<typeof BranchComplexitySchema>;
export const branchComplexities:BranchComplexity[]=['low','medium','high'];
export const branchComplexityProfiles={
  low:{label:'적게',description:'핵심 선택과 결말 위주로 간결하게 만듭니다.',opportunities:'0-1',target:1,attempts:2,budgetMs:3*60_000,
    guidance:'Keep the story compact: focus on essential choices that distinguish the requested endings. Prefer shared preparation and avoid optional detours or extra decision layers. Author 0-1 meaningful intermediate opportunities only when they serve the story.'},
  medium:{label:'보통',description:'중간 선택과 다른 방법으로 진행하는 경로를 함께 만듭니다.',opportunities:'2-4',target:3,attempts:6,budgetMs:8*60_000,
    guidance:'Use a balanced branching story with meaningful intermediate choices and alternative approaches that rejoin shared continuations. Author 2-4 intermediate opportunities.'},
  high:{label:'많게',description:'대체 경로와 중간 선택을 늘립니다. 시간과 API 비용이 증가할 수 있습니다.',opportunities:'3-4',target:5,attempts:10,budgetMs:12*60_000,
    guidance:'Prefer a richer story with several consequential intermediate decisions, different approaches, and feasible setback/recovery paths with shared continuations. Author 3-4 intermediate opportunities spread across the story. Do not create filler or repeat discoveries.'},
} as const;
export const complexityInstruction=(level:BranchComplexity)=>branchComplexityProfiles[level].guidance+
  ' These are preferences, not quotas: never sacrifice causality or fail a valid chapter just to meet a count. Preserve EVERY requested ending and the causal actions required to reach it, regardless of complexity. Do not merge distinct requested endings or invent extra endings to meet complexity.';
