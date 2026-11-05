import { assertStatefulDetails } from './stateful-storyline.js';
import { z } from 'zod';
import { approveAuthorContract, AuthorContractSchema } from './author-contract.js';
import { approveEndingOutcomes } from './ending-outcomes.js';
import { OutcomeBoundPlanDetailsSchema, parseOutcomeBoundNarrativePlanDetails } from './narrative-details.js';
import { NarrativePlanSchema, parseNarrativePlan } from './narrative-plan.js';
import { compileNarrativePlan } from './plan-skeleton-compiler.js';
import { NarrativeSkeletonSchema, parseNarrativeSkeleton } from './narrative-skeleton.js';
import { AtomValueSchema, GuardSchema } from './symbolic-graph.js';
import {EventAuthoringSchema} from './story-first.js';
import {compileAuthoredChapterGameplay} from './chapter-gameplay-compiler.js';
import {auditStoryFirstGameplay} from './chapter-execution-audit.js';

export const SymbolicStoryPayloadSchema = z.object({
  approval: z.object({
    brief: z.string(),
    contract: AuthorContractSchema,
    playerId: z.string(),
    revision: z.string(),
  }).strict(),
  outcomes: z.object({
    revision: z.string(),
    initialState: z.array(AtomValueSchema).max(256),
    outcomes: z.array(z.object({ endingId: z.string(), condition: GuardSchema }).strict()).max(6),
  }).strict(),
  plan: NarrativePlanSchema,
  skeleton: NarrativeSkeletonSchema,
  details: OutcomeBoundPlanDetailsSchema,
  eventAuthoring:EventAuthoringSchema.optional(),
}).strict();

export type SymbolicStoryPayload = z.infer<typeof SymbolicStoryPayloadSchema>;

export function parseSymbolicStoryPayload(raw: unknown): SymbolicStoryPayload {
  const parsed = SymbolicStoryPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Symbolic Story Payload 오류 (${issue.path.join('.') || 'root'}): ${issue.message}`);
  }
  const payload = parsed.data;
  const approval = approveAuthorContract(payload.approval.brief, payload.approval.contract, payload.approval.playerId, payload.approval.revision);
  const outcomes = approveEndingOutcomes(approval, payload.outcomes.revision, payload.outcomes.initialState, payload.outcomes.outcomes);
  const plan = parseNarrativePlan(payload.plan);
  const skeleton = parseNarrativeSkeleton(payload.skeleton, approval.contract);
  if ('format' in plan) {
    if (payload.details.format !== 'stateful-v1') throw new Error('Storyline plans require stateful-v1 details');
    if (JSON.stringify(compileNarrativePlan(approval, plan)) !== JSON.stringify(skeleton)) throw new Error('Storyline skeleton does not match the compiled plan');
  }
  parseOutcomeBoundNarrativePlanDetails(payload.details, approval, outcomes, skeleton);
  if ('format' in plan && plan.format === 'stateful-storylines-v2') {
    assertStatefulDetails(approval, outcomes, plan, payload.details,payload.eventAuthoring?.execution??'legacy');
    if(payload.eventAuthoring?.execution==='source-owned-v1'){
      if(approval.contract.endings.some(e=>!plan.storylines.some(line=>line.endingId===e.id)))throw new Error('실행 가능한 결말 누락');
      auditStoryFirstGameplay(compileAuthoredChapterGameplay(payload),plan,{},true);
    }
  } else if(payload.eventAuthoring?.execution)throw new Error('Source-owned execution requires a stateful storyline plan');
  return payload;
}
