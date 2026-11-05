import { approveAuthorContract } from './author-contract.js';
import { approveEndingOutcomes } from './ending-outcomes.js';
import { auditPlanPatch, type PatchPolicy } from './patch-audit.js';
import { parseSymbolicStoryPayload, type SymbolicStoryPayload } from './symbolic-story-payload.js';
import { StatefulStorylinePlanSchema } from './stateful-storyline-plan.js';
import { materializeStatefulPlan } from './stateful-storyline.js';
import { z } from 'zod';
import {buildChapterGameplay} from './chapter-gameplay-binding.js';
import type {ChapterGameplay} from './chapter-gameplay.js';
import type {ChapterEdits} from './chapter-edits.js';
export const patchScenes = (details: unknown) => z.object({scenes:z.record(z.object({summary:z.string(),locationId:z.string(),presentCharacters:z.array(z.string()),perspective:z.enum(['offscreen','outcome']).optional()}))}).parse(details).scenes;

/** Logic-only repair: the existing prose, topology and authoring metadata stay intact. */
export function materializeLogicPatch(rawBaseline: SymbolicStoryPayload, rawPlan: unknown, policy: PatchPolicy) {
  const baseline = parseSymbolicStoryPayload(rawBaseline);
  const original = StatefulStorylinePlanSchema.parse(baseline.plan);
  const candidate = StatefulStorylinePlanSchema.parse(rawPlan);
  const a = baseline.approval;
  const approval = approveAuthorContract(a.brief,a.contract,a.playerId,a.revision);
  const outcomes = approveEndingOutcomes(approval,baseline.outcomes.revision,baseline.outcomes.initialState,baseline.outcomes.outcomes);
  const audit = auditPlanPatch(approval,outcomes,original,candidate,policy);
  if (audit.status === 'rejected') throw new Error(JSON.stringify(audit.findings));
  if (candidate.beats.some(b => original.beats.find(o=>o.key===b.key)?.title !== b.title)) throw new Error('장면 제목은 수정 범위에 포함되지 않습니다.');
  const prose = {scenes:Object.fromEntries(Object.entries(patchScenes(baseline.details)).map(([key,s])=>[key,{summary:s.summary,locationId:s.locationId,presentCharacters:s.presentCharacters,...(s.perspective?{perspective:s.perspective}:{})}]))};
  const {skeleton,details} = materializeStatefulPlan(approval,outcomes,candidate,prose);
  return {audit,payload:parseSymbolicStoryPayload({...baseline,plan:candidate,skeleton,details})};
}

/** Compare at apply time, so an in-flight response cannot replace newer author edits. */
export function applyLogicPatch<T extends {symbolic?: SymbolicStoryPayload; gameplay?: ChapterGameplay;chapterEdits?:ChapterEdits}>(story: T, expectedRevision: number, currentRevision: number,
  baseline: SymbolicStoryPayload, candidate: unknown, policy: PatchPolicy): T {
  if (expectedRevision !== currentRevision || JSON.stringify(story.symbolic) !== JSON.stringify(baseline)) throw new Error('원본이 변경되었습니다. 후보를 다시 생성하세요.');
  const {payload} = materializeLogicPatch(baseline,candidate,policy);
  return {...structuredClone(story),symbolic:payload,...(story.gameplay?{gameplay:buildChapterGameplay(payload,undefined,story.chapterEdits,story.gameplay.branchPolicy)}:{})};
}
