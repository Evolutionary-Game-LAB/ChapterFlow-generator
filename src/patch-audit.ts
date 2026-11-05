import {verifyChoiceObligations} from './symbolic-verification.js';
import {analyzeStoryExecution,affectedStorylines} from './story-execution-analysis.js';
import {evaluateGuard,symbolicAtomKey} from './playtest/symbolic-engine.js';
import type { AuthorContractApproval } from './author-contract.js';
import type { EndingOutcomeApproval } from './ending-outcomes.js';
import { StatefulStorylinePlanSchema, type StatefulStorylinePlan } from './stateful-storyline-plan.js';
import { validateStatefulPlan } from './stateful-storyline.js';
import { z } from 'zod';
import { GuardSchema, EffectSchema, AtomRefSchema } from './symbolic-graph.js';

/** Trusted caller policy; never accept preservation criteria from the repair model. */
export const PatchPolicySchema = z.object({
  editableBeatKeys: z.array(z.string()).min(1).max(40),
  choiceObligations: z.array(z.object({
    beatKey:z.string(),successorBeatKeys:z.array(z.string()).min(2).max(12),
    observeAtoms:z.array(AtomRefSchema).max(32),observeEndings:z.boolean(),rationale:z.string().min(1),
  }).strict()).max(40).optional(),
  routeObligations: z.array(z.object({
    storylineIndex: z.number().int().min(0).max(11),
    beatKey: z.string(),
    rationale: z.string().min(1),
    requiredState: GuardSchema,
  }).strict()).max(80).optional(),
  obligations: z.array(z.object({
    beatKey: z.string(),
    rationale: z.string().min(1),
    requiredConditions: GuardSchema,
    requiredEffects: z.array(EffectSchema).max(16),
  }).strict()).max(40),
}).strict();
export type PatchPolicy = z.infer<typeof PatchPolicySchema>;
export type PatchFinding = { code: string; beatKey?: string; evidence: string };
// Key-order-independent object comparison; array order remains significant.
const canonical = (v: unknown): string => JSON.stringify(v, (_k, value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

/** Preview only: no mutation, persistence, or claim of natural-language correctness. */
export function auditPlanPatch(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval,
  original: StatefulStorylinePlan, candidateRaw: unknown, policyRaw: unknown) {
  const findings: PatchFinding[] = [];
  const policyResult = PatchPolicySchema.safeParse(policyRaw);
  const result = StatefulStorylinePlanSchema.safeParse(candidateRaw);
  const baseline = StatefulStorylinePlanSchema.safeParse(original);
  if (!policyResult.success || !result.success || !baseline.success) {
    return { status: 'rejected' as const, findings: [{ code: 'invalid-input', evidence: 'Invalid plan or preservation policy schema' }], changedBeatKeys: [] };
  }
  const candidate = result.data, policy = policyResult.data;
  const before = new Map(original.beats.map(b => [b.key, b]));
  const after = new Map(candidate.beats.map(b => [b.key, b]));
  const add = (code: string, evidence: string, beatKey?: string) => findings.push({ code, evidence, beatKey });
  if (before.size !== original.beats.length || after.size !== candidate.beats.length) add('duplicate-beat', 'Duplicate event identity');
  if (policy.editableBeatKeys.some(k => !before.has(k)) || new Set(policy.editableBeatKeys).size !== policy.editableBeatKeys.length)
    add('invalid-policy', 'Unknown or duplicate editable event');
  if (canonical(original.storylines) !== canonical(candidate.storylines)) add('route-change', 'Path order, choices and ending assignments must remain unchanged');
  if (original.title !== candidate.title) add('scope-violation', 'Story title is outside the patch scope');
  for (const key of before.keys()) if (!after.has(key)) add('event-deletion', 'Original event removed', key);
  for (const key of after.keys()) if (!before.has(key)) add('event-insertion', 'New event requires a separate topology repair policy', key);
  const changedBeatKeys = [...before.keys()].filter(k => after.has(k) && canonical(before.get(k)) !== canonical(after.get(k)));
  for (const key of changedBeatKeys) if (!policy.editableBeatKeys.includes(key)) add('scope-violation', 'Event outside declared patch scope modified', key);
  for (const obligation of policy.obligations) {
    if (!before.has(obligation.beatKey)) { add('invalid-policy', 'Obligation refers to unknown event', obligation.beatKey); continue; }
    const beat = after.get(obligation.beatKey);
    if (!beat) continue;
    for (const condition of obligation.requiredConditions.all)
      if (!beat.precondition.all.some(c => canonical(c) === canonical(condition))) add('required-condition-change', obligation.rationale, beat.key);
    for (const effect of obligation.requiredEffects)
      if (!beat.effects.some(e => canonical(e) === canonical(effect))) add('required-effect-change', obligation.rationale, beat.key);
  }
  for (const obligation of policy.routeObligations ?? []) {
    const route=original.storylines[obligation.storylineIndex];
    const atoms=new Map(outcomes.initialState.map(a=>[symbolicAtomKey(a.ref),a.value]));
    if (!route?.steps.some(step=>step.beatKey===obligation.beatKey) || obligation.requiredState.all.some(c=>!atoms.has(symbolicAtomKey(c.ref)) || typeof atoms.get(symbolicAtomKey(c.ref))!==typeof c.value))
      add('invalid-policy','Unknown route checkpoint or invalid state reference',obligation.beatKey);
  }
  for(const obligation of policy.choiceObligations ?? []) {
    const successors=new Set(original.storylines.flatMap(line=>line.steps.flatMap((step,i)=>step.beatKey===obligation.beatKey&&line.steps[i+1]?[line.steps[i+1]!.beatKey]:[])));
    const atoms=new Set(outcomes.initialState.map(a=>symbolicAtomKey(a.ref)));
    if(!before.has(obligation.beatKey)||new Set(obligation.successorBeatKeys).size!==obligation.successorBeatKeys.length||obligation.successorBeatKeys.some(k=>!successors.has(k))||obligation.observeAtoms.some(a=>!atoms.has(symbolicAtomKey(a)))||(!obligation.observeEndings&&!obligation.observeAtoms.length))
      add('invalid-policy','Invalid choice alternatives or missing observables',obligation.beatKey);
  }
  if (!findings.length) {
    try {
      const {model}=validateStatefulPlan(approval, outcomes, candidate, true);
      if(policy.choiceObligations?.length) {
        const obligations=policy.choiceObligations.map((o,i)=>({id:'protected-choice-'+i,situationId:'s_'+o.beatKey,transitionIds:model.draft.transitions.filter(t=>t.from==='s_'+o.beatKey&&o.successorBeatKeys.includes(t.to.slice(2))).map(t=>t.id),observeEndings:o.observeEndings,observeAtoms:o.observeAtoms}));
        const report=verifyChoiceObligations(model,obligations);
        if(report.status==='inconclusive')add('choice-check-incomplete','Choice preservation exploration exceeded its budget');
        for(const finding of report.findings){const index=obligations.findIndex(o=>o.id===finding.obligation.id),o=policy.choiceObligations[index]!;add('required-choice-loss',o.rationale+' ('+finding.code+')',o.beatKey);}
      }
      if (policy.routeObligations?.length) {
        const execution=analyzeStoryExecution(model,candidate);
        for(const obligation of policy.routeObligations) {
          const visit=execution.routes[obligation.storylineIndex]!.visits.find(v=>v.sceneKey===obligation.beatKey)!;
          if(!evaluateGuard(visit.symbolicAfter,obligation.requiredState))add('required-route-state-change',obligation.rationale,obligation.beatKey);
        }
      }
    }
    catch (error) { add('execution-invalid', error instanceof Error ? error.message : String(error)); }
  }
  return { status: findings.length ? 'rejected' as const : 'semantic-review-required' as const, findings, changedBeatKeys, affectedRoutes:affectedStorylines(original,changedBeatKeys) };
}
