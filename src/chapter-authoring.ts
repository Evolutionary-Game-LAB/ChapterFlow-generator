import {z} from 'zod';
import {AuthorContractSchema, approveAuthorContract} from './author-contract.js';
import {approveEndingOutcomes} from './ending-outcomes.js';
import {AtomValueSchema, GuardSchema} from './symbolic-graph.js';
import type {SymbolicStoryPayload} from './symbolic-story-payload.js';
import {ChapterFactSemanticsSchema,ChapterInitialEvidenceSchema} from './chapter-fact-semantics.js';
import {ManuscriptSchema} from './story-first.js';
import {BranchComplexitySchema} from './chapter-complexity.js';

export const ChapterDesignSchema=z.object({
  commonSituation:z.string().min(1).max(700),
  routes:z.record(z.object({
    approach:z.string().min(1).max(500),
    branchOpportunity:z.string().min(1).max(500),
    payoff:z.string().min(1).max(500),
  }).strict()),
}).strict();
export type ChapterDesign=z.infer<typeof ChapterDesignSchema>;

/** Planned outcomes remain available while the executable payload contains only built routes. */
export const ChapterAuthoringSchema=z.object({
  brief:z.string().min(1).max(20000),
  sourceBrief:z.string().max(12000).optional(),
  creativeContext:z.string().max(1400).optional(),
  contract:AuthorContractSchema,
  playerId:z.string().min(1),
  revision:z.string().min(1),
  initialState:z.array(AtomValueSchema).max(256),
  outcomes:z.array(z.object({endingId:z.string(),condition:GuardSchema}).strict()).min(1).max(6),
  model:z.string().max(200),
  setupMode:z.enum(['template','generated']).optional(),
  design:ChapterDesignSchema.optional(),
  factSemantics:z.record(ChapterFactSemanticsSchema).optional(),
  initialEvidence:z.record(ChapterInitialEvidenceSchema).optional(),
  manuscript:ManuscriptSchema.optional(),
  branchComplexity:BranchComplexitySchema.optional(),
}).strict();
export type ChapterAuthoring=z.infer<typeof ChapterAuthoringSchema>;
export function parseChapterAuthoring(raw:unknown):ChapterAuthoring {
  const setup=ChapterAuthoringSchema.parse(raw);
  const approval=approveAuthorContract(setup.brief,setup.contract,setup.playerId,setup.revision);
  approveEndingOutcomes(approval,setup.revision,setup.initialState,setup.outcomes);
  for(const metadata of [setup.factSemantics,setup.initialEvidence])if(metadata){
    const ids=setup.contract.stateSymbols.map(s=>s.id);
    if(Object.keys(metadata).length!==ids.length||ids.some(id=>!metadata[id]))throw new Error('모든 챕터 사실의 의미와 초기값 근거가 필요합니다.');
  }
  if(setup.design){
    const ids=setup.contract.endings.map(e=>e.id);
    if(Object.keys(setup.design.routes).length!==ids.length||ids.some(id=>!setup.design!.routes[id]))throw new Error('챕터 설계에 모든 결말이 포함되어야 합니다.');
  }
  return setup;
}
export function activeChapterApproval(setup:ChapterAuthoring,endingIds:readonly string[]) {
  const ids=new Set(endingIds);
  if(!ids.size||[...ids].some(id=>!setup.contract.endings.some(e=>e.id===id)))throw new Error('이야기에 없는 결말입니다.');
  const contract={...setup.contract,endings:setup.contract.endings.filter(e=>ids.has(e.id))};
  const approval=approveAuthorContract(setup.brief,contract,setup.playerId,setup.revision);
  const outcomes=approveEndingOutcomes(approval,setup.revision,setup.initialState,setup.outcomes.filter(o=>ids.has(o.endingId)));
  return {approval,outcomes};
}

/** Imported authoring metadata must describe the exact same fixed facts as the executable graph. */
export function validateChapterBinding(raw:unknown,payload:SymbolicStoryPayload|undefined) {
  const setup=parseChapterAuthoring(raw);
  if(!payload)throw new Error('챕터의 실행 가능한 서사 원본이 없습니다.');
  const {approval,outcomes}=activeChapterApproval(setup,payload.approval.contract.endings.map(e=>e.id));
  const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
  if(!same(approval.contract,payload.approval.contract)||approval.brief!==payload.approval.brief||approval.playerId!==payload.approval.playerId||approval.revision!==payload.approval.revision||outcomes.revision!==payload.outcomes.revision||!same(outcomes.initialState,payload.outcomes.initialState)||!same(outcomes.outcomes,payload.outcomes.outcomes))throw new Error('챕터 설정과 실행 원본이 일치하지 않습니다. 기존 파일을 다시 불러와 주세요.');
  return setup;
}
