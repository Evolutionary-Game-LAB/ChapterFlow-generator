import {SYMBOLIC_ASSIGNMENT_LIMIT} from './symbolic-graph.js';
import {suffixFeasibility} from './stateful-suffix.js';
import { z } from 'zod';
import type { AuthorContractApproval } from './author-contract.js';
import { approveEndingOutcomes, getEndingOutcome, type EndingOutcomeApproval } from './ending-outcomes.js';
import { parseOutcomeBoundNarrativePlanDetailsResult, outcomeBoundNarrativePlanDetailsJsonSchemaFor, type OutcomeBoundNarrativePlanDetails } from './narrative-details.js';
import { compileNarrativePlan } from './plan-skeleton-compiler.js';
import { compileSkeletonDetails } from './skeleton-detail-compiler.js';
import { createSymbolicState, tryTransition, symbolicAtomKey, evaluateGuard } from './playtest/symbolic-engine.js';
import { verifyPlannedStorylines } from './storyline-verification.js';
import { verifySymbolicModel } from './symbolic-verification.js';
import { StatefulStorylinePlanSchema, type StatefulStorylinePlan } from './stateful-storyline-plan.js';

const Assignment = z.object({ atom: z.string(), value: z.union([z.boolean(), z.number()]) }).strict();
const Event = z.object({ title: z.string().trim().min(1).max(200), requires: z.array(Assignment).max(SYMBOLIC_ASSIGNMENT_LIMIT), changes: z.array(Assignment).max(SYMBOLIC_ASSIGNMENT_LIMIT) }).strict();
const Seed = z.object({ title: z.string().trim().min(1).max(200), opening: z.string().trim().min(1).max(200), beats: z.array(Event).min(2).max(8) }).strict();
export class StatefulPlanError extends Error {
  constructor(readonly code: string, readonly evidence: unknown) { super(JSON.stringify({ code, evidence })); }
}
export const planAtoms = (outcomes: EndingOutcomeApproval) => outcomes.initialState.map((entry) => ({ atom: entry.ref.symbol + '(' + entry.ref.args.join(',') + ')', ...entry }));
const atomValue = (value: boolean | number) => typeof value === 'boolean' ? { type: 'boolean' } : { type: 'number', minimum: 0, maximum: 1, multipleOf: 0.01 };
function eventSchema(outcomes: EndingOutcomeApproval) {
  const assignment = { oneOf: planAtoms(outcomes).map((entry) => ({ type: 'object', additionalProperties: false, required: ['atom', 'value'], properties: { atom: { const: entry.atom }, value: atomValue(entry.value) } })) };
  return { type: 'object', additionalProperties: false, required: ['title', 'requires', 'changes'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, requires: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: assignment }, changes: { type: 'array', maxItems: SYMBOLIC_ASSIGNMENT_LIMIT, items: assignment } } };
}
export function statefulSeedSchema(outcomes: EndingOutcomeApproval) {
  return { type: 'object', additionalProperties: false, required: ['title', 'opening', 'beats'], properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, opening: { type: 'string', minLength: 1, maxLength: 200 }, beats: { type: 'array', minItems: 2, maxItems: 8, items: eventSchema(outcomes) } } };
}
function canonicalBeat(event: z.infer<typeof Event>, key: string, outcomes: EndingOutcomeApproval) {
  const atoms = planAtoms(outcomes);
  const convert = (assignments: z.infer<typeof Assignment>[]) => {
    if (new Set(assignments.map((a) => a.atom)).size !== assignments.length) throw new StatefulPlanError('duplicate-atom', { key });
    return assignments.map((a) => {
      const entry = atoms.find((candidate) => candidate.atom === a.atom);
      if (!entry || typeof entry.value !== typeof a.value) throw new StatefulPlanError('unknown-atom', { key, atom: a.atom });
      return { ref: entry.ref, value: a.value };
    });
  };
  return { key, title: event.title, precondition: { all: convert(event.requires).map((a) => ({ ...a, op: 'eq' as const })) }, effects: convert(event.changes).map((a) => ({ ...a, op: 'set' as const })) };
}
export function createStatefulSeed(raw: unknown, outcomes: EndingOutcomeApproval): StatefulStorylinePlan {
  const seed = Seed.parse(raw);
  const beats = [{ title: seed.opening, requires: [], changes: [] }, ...seed.beats].map((beat, i) => canonicalBeat(beat, 'beat_base_' + (i + 1), outcomes));
  return StatefulStorylinePlanSchema.parse({ format: 'stateful-storylines-v2', title: seed.title, beats, storylines: [{ endingId: outcomes.approval.contract.endings[0]!.id, steps: beats.map((beat) => ({ beatKey: beat.key })) }] });
}
/** Each segment carries its route provenance: the same shared node can have different prefix states. */
export function statefulSegments(plan: StatefulStorylinePlan, _outcomes?: EndingOutcomeApproval) {
  const seen = new Set<string>();
  return plan.storylines.flatMap((line, storylineIndex) => line.steps.slice(0, -1).flatMap((from, fromIndex) => {
    const targets = [null, ...line.steps.slice(fromIndex + 2).map(step => step.beatKey)];
    return targets.flatMap(rejoinKey => {
      const rejoinIndex = rejoinKey === null ? -1 : line.steps.findIndex(step => step.beatKey === rejoinKey);
      const prefix = line.steps.slice(0, fromIndex + 1);
      const suffix = rejoinIndex < 0 ? [] : line.steps.slice(rejoinIndex);
      const signature = JSON.stringify([prefix, suffix]);
      if (seen.has(signature) || prefix.length + suffix.length >= 20 || plan.beats.length >= 40) return [];
      seen.add(signature);
      return [{ id: (storylineIndex ? 'route_' + storylineIndex + '__' : '') + from.beatKey + '__' + (rejoinKey ?? 'end'),
        storylineIndex, fromIndex, rejoinIndex, fromKey: from.beatKey, rejoinKey }];
    });
  }));
}
/** Offer all accepted routes. State-changing suffixes are validated by execution, not banned by shape. */
export function generationSegments(plan: StatefulStorylinePlan, outcomes: EndingOutcomeApproval) {
  return statefulSegments(plan, outcomes);
}
export function statefulExpansionSchema(plan: StatefulStorylinePlan, outcomes: EndingOutcomeApproval) {
  return { type: 'object', additionalProperties: false, required: ['segment', 'beats'], properties: { segment: { enum: generationSegments(plan, outcomes).map((s) => s.id) }, beats: { type: 'array', minItems: 1, maxItems: 5, items: eventSchema(outcomes) } } };
}
export function appendStatefulStoryline(plan: StatefulStorylinePlan, raw: unknown, endingId: string, outcomes: EndingOutcomeApproval): StatefulStorylinePlan {
  const value = z.object({ segment: z.string(), beats: z.array(Event).min(1).max(5) }).strict().parse(raw);
  const segment = statefulSegments(plan, outcomes).find((s) => s.id === value.segment);
  if (!segment) throw new StatefulPlanError('invalid-segment', { allowed: statefulSegments(plan, outcomes) });
  const titles = new Set(plan.beats.map((beat) => JSON.stringify([beat.title.trim().toLowerCase(), beat.precondition, beat.effects])));
  for (const beat of value.beats) {
    const canonical = canonicalBeat(beat, 'beat_candidate', outcomes);
    const signature = JSON.stringify([beat.title.toLowerCase(), canonical.precondition, canonical.effects]);
    if (titles.has(signature)) throw new StatefulPlanError('duplicate-event', { title: beat.title, message: 'Return only NEW events, never copy the preserved prefix or suffix.' });
    titles.add(signature);
  }
  // Link labels are destination titles. Report the actual sibling conflict before compilation.
  const fromChildren = plan.storylines.flatMap(line => line.steps.flatMap((step, i) =>
    step.beatKey === segment.fromKey && line.steps[i + 1] ? [line.steps[i + 1]!.beatKey] : []));
  const siblingTitles = [...new Set(fromChildren.map(key => plan.beats.find(b => b.key === key)!.title))];
  if (siblingTitles.includes(value.beats[0]!.title)) throw new StatefulPlanError('duplicate-choice-title', {
    fromKey: segment.fromKey, rejectedTitle: value.beats[0]!.title, existingChoiceTitles: siblingTitles,
    instruction: 'The first new action must be a genuinely different choice with a distinct descriptive title. Do not copy an existing action and merely rename it. Existing choices are immutable.',
  });
  const base = plan.storylines[segment.storylineIndex]!.steps;
  const from = segment.fromIndex;
  const rejoin = segment.rejoinIndex;
  const beats = value.beats.map((beat, i) => canonicalBeat(beat, 'beat_alt_' + plan.storylines.length + '_' + (i + 1), outcomes));
  return StatefulStorylinePlanSchema.parse({ ...plan, beats: [...plan.beats, ...beats], storylines: [...plan.storylines, { endingId, steps: [...base.slice(0, from + 1), ...beats.map((b) => ({ beatKey: b.key })), ...(rejoin < 0 ? [] : base.slice(rejoin))] }] });
}

/** A scene describes the state AFTER its incoming event. Its requirements are checked BEFORE that event. */
export function materializeStatefulPlan(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, plan: StatefulStorylinePlan, prose?: unknown) {
  if (outcomes.approval !== approval || outcomes.revision !== approval.revision) throw new Error('Stateful plan approvals must match');
  const included = new Set(plan.storylines.map((line) => line.endingId));
  if ([...included].some((id) => !approval.contract.endings.some((ending) => ending.id === id))) throw new StatefulPlanError('unapproved-ending', {});
  const partialApproval = { ...approval, contract: { ...approval.contract, endings: approval.contract.endings.filter((e) => included.has(e.id)) } };
  const partialOutcomes = approveEndingOutcomes(partialApproval, approval.revision, outcomes.initialState, outcomes.outcomes.filter((o) => included.has(o.endingId)));
  const skeleton = compileNarrativePlan(partialApproval, plan);
  const entry = z.object({ summary: z.string().min(1).max(4000), locationId: z.enum(approval.contract.entities.locations as [string, ...string[]]), presentCharacters: z.array(z.enum(approval.contract.entities.characters as [string, ...string[]])).max(20), perspective: z.enum(['offscreen','outcome']).optional() }).strict();
  const parsedProse = prose === undefined ? undefined : z.object({ scenes: z.record(entry) }).strict().parse(prose);
  if (parsedProse && (Object.keys(parsedProse.scenes).length !== skeleton.scenes.length || skeleton.scenes.some((s) => !parsedProse.scenes[s.key]))) throw new Error('Prose must contain exactly the verified scenes');
  const details: OutcomeBoundNarrativePlanDetails = { format: 'stateful-v1', scenes: Object.fromEntries(skeleton.scenes.map((scene) => {
    const text = parsedProse?.scenes[scene.key] ?? { summary: scene.title, locationId: approval.contract.entities.locations[0]!, presentCharacters: [approval.playerId] };
    const base = { ...text, precondition: { all: [] } };
    return [scene.key, scene.endingId ? base : { ...base, actions: skeleton.links.filter((link) => link.from === scene.key).map((link) => {
      const target = plan.beats.find((beat) => beat.key === link.to);
      const endingId = skeleton.scenes.find((s) => s.key === link.to)?.endingId;
      return { to: link.to, precondition: target?.precondition ?? getEndingOutcome(outcomes, endingId!).condition, effects: target?.effects ?? [] };
    }) }];
  })) };
  const { compiled } = parseOutcomeBoundNarrativePlanDetailsResult(details, partialApproval, partialOutcomes, skeleton);
  const partialModel = compileSkeletonDetails(partialApproval, skeleton, compiled);
  // Check terminal exclusivity against ALL approved outcomes, even while only some paths exist.
  const model = { ...partialModel, draft: { ...partialModel.draft, endingRules: outcomes.outcomes.map((o) => ({ endingId: o.endingId, condition: o.condition })) } };
  return { skeleton, details, model };
}
export function diagnoseStatefulRoute(plan: StatefulStorylinePlan, index: number, outcomes: EndingOutcomeApproval) {
  const state = new Map(outcomes.initialState.map((a)=>[symbolicAtomKey(a.ref), a.value]));
  const atoms = planAtoms(outcomes);
  const name = (ref: {symbol:string;args:string[]}) => atoms.find((a)=>symbolicAtomKey(a.ref)===symbolicAtomKey(ref))!.atom;
  const blocked = [];
  let firstBlock: unknown;
  const steps = plan.storylines[index]!.steps;
  for(const [position, step] of steps.entries()) {
    const beat = plan.beats.find((b)=>b.key===step.beatKey)!;
    const conditions = beat.precondition.all.filter((c)=>c.op==='eq' && state.get(symbolicAtomKey(c.ref))!==c.value).map((c)=>({atom:name(c.ref),current:state.get(symbolicAtomKey(c.ref)),required:c.value}));
    if(conditions.length) {
      blocked.push({event:beat.key,title:beat.title,unmetRequirements:conditions});
      firstBlock ??= {
        event: beat.key, title: beat.title,
        actualStateBefore: atoms.map(a => ({atom:a.atom,value:state.get(symbolicAtomKey(a.ref))})),
        unmetRequirements: conditions.map(c => ({...c,
          sameEventEstablishes: beat.effects.some(e => name(e.ref) === c.atom && e.op === 'set' && e.value === c.required),
          laterProducers: steps.slice(position + 1).flatMap(s => {
            const later = plan.beats.find(b => b.key === s.beatKey)!;
            return later.effects.some(e => name(e.ref) === c.atom && e.op === 'set' && e.value === c.required)
              ? [{event:later.key,title:later.title}] : [];
          }),
        })),
        instruction: 'Execution stops HERE, before any effect of this event. Same-event and later effects cannot establish its requirements. Add or move a narratively justified enabling action BEFORE the blocked action within the rejected part. Preserve necessary requirements, accepted events and locked initial state. No automatic state filling.',
      };
    }
    for(const effect of beat.effects) {
      const key=symbolicAtomKey(effect.ref);
      state.set(key,effect.op==='set'?effect.value:Math.round(Math.max(0,Math.min(1,(state.get(key) as number)+(effect.value as number)))*100)/100);
    }
  }
  const ending=getEndingOutcome(outcomes,plan.storylines[index]!.endingId);
  return { firstBlock, mode: 'hypothetical diagnostic ONLY: applies planned changes even after unmet requirements; never used to accept a plan', blockedEvents:blocked, missingFinalFacts:ending.condition.all.filter((c)=>state.get(symbolicAtomKey(c.ref))!==c.value).map((c)=>({atom:name(c.ref),current:state.get(symbolicAtomKey(c.ref)),required:c.value})), instruction:'Fix ALL these unmet requirements and final facts through plausible events. Do not simply clear necessary guards or force ending values.' };
}
export function validateStatefulPlan(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, plan: StatefulStorylinePlan, complete = false, collectFindings = false) {
  if (complete && approval.contract.endings.some((e) => !plan.storylines.some((line) => line.endingId === e.id))) throw new StatefulPlanError('missing-ending', {});
  const result = materializeStatefulPlan(approval, outcomes, plan);
  const route = verifyPlannedStorylines(result.model, plan);
  if (route) {
    const requiredEnding = outcomes.outcomes.find((o) => o.endingId === plan.storylines[route.witness.storylineIndex]!.endingId)!;
    const facts = requiredEnding.condition.all.map((comparison) => {
      const actual = route.witness.configuration.state[symbolicAtomKey(comparison.ref)];
      const current = typeof comparison.value === 'number' ? (actual as number) / 100 : actual;
      return { atom: planAtoms(outcomes).find((a) => symbolicAtomKey(a.ref) === symbolicAtomKey(comparison.ref))!.atom, fact: comparison.ref, current, required: comparison.value };
    });
    throw new StatefulPlanError(route.code, { ...route.witness, allRouteObligations: diagnoseStatefulRoute(plan, route.witness.storylineIndex, outcomes), requiredEnding, competingEndings: outcomes.outcomes.filter((o) => o.endingId !== requiredEnding.endingId && evaluateGuard(route.witness.configuration.state, o.condition)).map((o) => ({ endingId: o.endingId, currentlySatisfiedFacts: o.condition.all.map((c) => ({ atom: planAtoms(outcomes).find((a) => symbolicAtomKey(a.ref) === symbolicAtomKey(c.ref))!.atom, value: c.value })) })), missingFinalFacts: facts.filter((fact) => fact.current !== fact.required), instruction: 'Establish EVERY missing final fact through a concrete event in the candidate route. Do not modify any accepted event or ending condition.' });
  }
  const report = verifySymbolicModel(result.model);
  if (report.status !== 'pass') {
    const first=report.findings[0]??{status:report.status};
    // Diagnostics only: the full verifier result remains blocking. Existing
    // callers keep their original evidence shape; joint authoring can repair
    // several concrete reachable failures in one bounded request.
    const evidence=collectFindings?{...first,relatedFindings:report.findings.slice(1,8),totalFindings:report.findings.length,
      instruction:'These are actual executed failures, not independent hypothetical bits. Repair shared causes across these witnessed states together; additional omitted findings, if any, remain blocking on full revalidation.'}:first;
    throw new StatefulPlanError(report.findings[0]?.code??'verification-incomplete',evidence);
  }
  return result;
}
export function describeStatefulSegments(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, plan: StatefulStorylinePlan) {
  const { model, skeleton } = materializeStatefulPlan(approval, outcomes, plan);
  const after = plan.storylines.map(line => {
    let configuration = { situationId: model.draft.startSituationId, state: createSymbolicState(approval.contract, model.draft) };
    return line.steps.map(step => {
      const edge = model.draft.transitions.find(t => t.from === configuration.situationId && t.to === 's_' + step.beatKey);
      const next = edge && tryTransition(model, configuration, edge.id);
      if (!next || !next.ok) throw new StatefulPlanError('blocked-prefix', next);
      configuration = next.configuration;
      return planAtoms(outcomes).map(a => ({ atom: a.atom, value: typeof a.value === 'number' ? (configuration.state[symbolicAtomKey(a.ref)] as number) / 100 : configuration.state[symbolicAtomKey(a.ref)] }));
    });
  });
  return generationSegments(plan, outcomes).map(segment => {
    const route = plan.storylines[segment.storylineIndex]!;
    return { ...segment, sourceEndingId: route.endingId,
      alreadyBranches: skeleton.links.filter(link => link.from === segment.fromKey).length > 1,
      stateAfterPrefix: after[segment.storylineIndex]![segment.fromIndex],
      existingChoiceTitles: skeleton.links.filter(link => link.from === segment.fromKey).map(link => link.label),
      sharedPrefix: route.steps.slice(0, segment.fromIndex + 1).map(s => plan.beats.find(b => b.key === s.beatKey)!.title),
      remainingSuffix: segment.rejoinIndex < 0 ? [] : route.steps.slice(segment.rejoinIndex).map(s => plan.beats.find(b => b.key === s.beatKey)!),
    };
  });
}
/** Compact anchor selection context; repeated states and suffix events are stored once. */
export function statefulAnchorMenu(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, plan: StatefulStorylinePlan, endingId: string) {
  const target=getEndingOutcome(outcomes,endingId).condition;
  const prefixStates:Record<string,unknown>={};
  const segments=describeStatefulSegments(approval,outcomes,plan).filter(segment=>{
    // Guard execution AND exclusive terminal classification must be possible from some suffix entry state.
    if(suffixFeasibility(outcomes,segment.remainingSuffix,endingId)==='impossible')return false;
    // A final set in an immutable suffix cannot be repaired by events inserted before it.
    return target.all.every(condition=>{
      const effects=segment.remainingSuffix.flatMap(beat=>beat.effects).filter(e=>symbolicAtomKey(e.ref)===symbolicAtomKey(condition.ref));
      const last=effects.at(-1);
      return !last || last.op!=='set' || condition.op!=='eq' || last.value===condition.value;
    });
  }).map(segment=>{
    const stateId='route_'+segment.storylineIndex+'_after_'+segment.fromIndex;
    prefixStates[stateId]=Object.fromEntries(segment.stateAfterPrefix.map(a=>[a.atom,a.value]));
    const route=plan.storylines[segment.storylineIndex]!;
    return {id:segment.id,fromKey:segment.fromKey,rejoinKey:segment.rejoinKey,alreadyBranches:segment.alreadyBranches,
      prefixStateId:stateId,prefixBeatKeys:route.steps.slice(0,segment.fromIndex+1).map(s=>s.beatKey),suffixBeatKeys:segment.remainingSuffix.map(b=>b.key)};
  });
  return {acceptedEvents:plan.beats,prefixStates,segments};
}
export function statefulProseSchema(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, plan: StatefulStorylinePlan) {
  return outcomeBoundNarrativePlanDetailsJsonSchemaFor(approval.contract, materializeStatefulPlan(approval, outcomes, plan).skeleton);
}
export const statefulSeedPrompt = 'Plan an executable narrative, not prose paragraphs. Return {title,opening,beats:[{title,requires:[{atom,value}],changes:[{atom,value}]}]}. opening is a neutral shared arrival TITLE ONLY; the server locks its state unchanged. Write 2-8 subsequent intermediate events, each a concrete player action. Use ONLY the supplied atom IDs and correctly typed values. requires are equality conditions checked BEFORE the event; changes are state assignments made BY that event. Include only actual requirements/changes, not the entire state. Do not repeat the opening in beats. Establish EVERY requested final fact through plausible events BEFORE the ending. Each clause is a separate obligation: learning information does not also imply forgiving someone. Before returning, check EVERY requested ending fact separately. Add an event for any missing action such as forgiveness or consent; do not stop after learning the truth. Make sure every required atom has its requested value after the last event. The ending itself is not an event and cannot change state. All other approved ending conditions must be false at this route end. No unapproved entities. Use the brief language for titles. Return JSON only.';
export const statefulExpansionPrompt = 'Add ONLY new events between selected anchors. Return {segment,beats:[{title,requires:[{atom,value}],changes:[{atom,value}]}]}. Existing events, conditions and effects are immutable. Available segments come from ALL accepted routes, with route-specific prefix states. Prefer a plausible decision at a point that does not already branch; an alternative route may itself branch. Preserve acquired facts, commitments and costs unless a concrete event genuinely changes them. Do not reset facts just to force another ending. Meaningful intermediate actions and consequences matter more than node count. The prefix through fromKey is already executed (stateAfterPrefix is provided). Your new events execute next. If rejoinKey is not null, its event AND the remaining source-route suffix execute afterward, with all their existing requirements and effects. Select a __end segment (no rejoin) if that suffix conflicts with your requested ending; reconvergence is OPTIONAL. Never copy anchors, prefix, suffix or existing titles into beats. Use only supplied atom IDs, with equality requirements and justified state changes for concrete actions. End in exactly the requested approved outcome, without changing its definition. The final ending transition changes NO state. Use 1-5 new events and JSON only.';

const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
export function assertStatefulDetails(approval: AuthorContractApproval, outcomes: EndingOutcomeApproval, plan: StatefulStorylinePlan, raw: unknown, execution:'legacy'|'source-owned-v1'='legacy') {
  // Source-owned execution is checked by the actual runtime after authoring
  // entries/actions are compiled. Here only ensure prose cannot alter the plan.
  const expected = execution==='legacy'?validateStatefulPlan(approval, outcomes, plan, true):materializeStatefulPlan(approval,outcomes,plan);
  const actual = parseOutcomeBoundNarrativePlanDetailsResult(raw, approval, outcomes, expected.skeleton);
  for (const scene of actual.compiled.scenes) {
    const planned = expected.details.scenes[scene.key] as { precondition: unknown; actions?: Array<{ to: string; precondition: unknown; effects: unknown }> };
    if (stable(scene.precondition) !== stable(planned.precondition)) throw new Error('Prose cannot change verified scene conditions');
    if ('actions' in scene) for (const action of scene.actions) {
      const target = planned.actions?.find((candidate) => candidate.to === action.to);
      if (!target || stable(action.precondition) !== stable(target.precondition) || stable(action.effects) !== stable(target.effects)) throw new Error('Details cannot change verified plan conditions or effects');
    }
  }
}
