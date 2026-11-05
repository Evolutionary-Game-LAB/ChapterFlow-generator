import {createHash} from 'node:crypto';
import {z} from 'zod';
import {PatchPolicySchema, type PatchPolicy} from '../src/patch-audit.js';
import {symbolicGraphJsonSchema} from '../src/symbolic-graph.js';
import type {SymbolicStoryPayload} from '../src/symbolic-story-payload.js';
import {StatefulStorylinePlanSchema} from '../src/stateful-storyline-plan.js';
import {decoderSchema} from './quality-schema.js';
import {intentSources} from './quality-intent.js';

const cited={sourceIds:z.array(z.string()).min(1).max(16)};
export const PreservationProposalSchema=z.object({
 status:z.enum(['ready','abstain']),reason:z.string().min(1).max(2000),
 obligations:z.array(PatchPolicySchema.shape.obligations.element.extend(cited)).max(40),
 routeObligations:z.array(PatchPolicySchema.shape.routeObligations.unwrap().element.extend(cited)).max(80),
 choiceObligations:z.array(PatchPolicySchema.shape.choiceObligations.unwrap().element.extend(cited)).max(40),
 coverage:z.array(z.object({sourceId:z.string(),disposition:z.enum(['enforced','context-only','unrepresentable']),reason:z.string().min(1).max(1000)}).strict()).max(128),
}).strict();
export const PolicyReviewSchema=z.object({status:z.enum(['supported','unsupported','ambiguous']),reason:z.string().min(1).max(2000)}).strict();
export function preservationSources(payload:SymbolicStoryPayload){
 return [...intentSources(payload.approval.brief).map(s=>({...s,kind:'brief'})),
 ...payload.approval.contract.endings.map(e=>({id:'ending:'+e.id,text:e.label,kind:'ending'})),
 ...[...payload.approval.contract.stateSymbols,...payload.approval.contract.relationshipSymbols].filter(s=>s.meaning).map(s=>({id:'symbol:'+s.id,text:s.meaning!,kind:'definition'}))];
}
/** A compact, candidate-independent catalog; diagnostic interpretations are not author evidence. */
export function preservationContext(payload:SymbolicStoryPayload,scope:readonly string[]){
 const plan=StatefulStorylinePlanSchema.parse(payload.plan);
 const choices=plan.beats.map(b=>({beatKey:b.key,successorBeatKeys:[...new Set(plan.storylines.flatMap(r=>r.steps.flatMap((v,i)=>v.beatKey===b.key&&r.steps[i+1]?[r.steps[i+1]!.beatKey]:[])))]})).filter(c=>c.successorBeatKeys.length>=2);
 return {sources:preservationSources(payload),contract:payload.approval.contract,initialState:payload.outcomes.initialState,endingConditions:payload.outcomes.outcomes,
 events:plan.beats.map(b=>({...b,prose:(payload.details.scenes[b.key] as {summary?:string}|undefined)?.summary})),
 routes:plan.storylines.map((r,storylineIndex)=>({storylineIndex,endingId:r.endingId,beatKeys:r.steps.map(s=>s.beatKey)})),choices,scope,
 interpretation:'Only sources express author requirements. Existing event conditions/effects may be erroneous. Route index identifies a path; endingId does not uniquely identify a path.'};
}
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const arr=(items:unknown,maxItems=80)=>({type:'array',items,maxItems});
const str={type:'string',minLength:1};
export function preservationSchema(payload:SymbolicStoryPayload){
 const sources=preservationSources(payload),keys=StatefulStorylinePlanSchema.parse(payload.plan).beats.map(b=>b.key);
 const beatKey={type:'string',enum:keys},sourceId={type:'string',enum:sources.map(s=>s.id)};
 const common={sourceIds:{...arr(sourceId,16),minItems:1},rationale:str,beatKey};
 const t=symbolicGraphJsonSchema.properties.transitions.items.properties;
 return obj({status:{type:'string',enum:['ready','abstain']},reason:str,
 obligations:arr(obj({...common,requiredConditions:t.precondition,requiredEffects:t.effects}),40),
 routeObligations:arr(obj({...common,storylineIndex:{type:'integer',minimum:0,maximum:StatefulStorylinePlanSchema.parse(payload.plan).storylines.length-1},requiredState:t.precondition})),
 choiceObligations:arr(obj({...common,successorBeatKeys:{...arr(beatKey,12),minItems:2},observeAtoms:arr(t.effects.items.properties.ref,32),observeEndings:{type:'boolean'}}),40),
 coverage:obj(Object.fromEntries(sources.map(source=>[source.id,obj({disposition:{type:'string',enum:['enforced','context-only','unrepresentable']},reason:str})])))});
}
/** Bound native output generation; an oversized policy must abstain, never lose requirements silently. */
export function preservationDecoder(stage:string,schema:unknown):unknown {
 if(['preservation_source','preservation_atomic','route_verdict','repair_attribution'].includes(stage))return structuredClone(schema);
 const result=decoderSchema(schema) as any;
 if(stage==='preservation_policy'){
  const p=result.properties;
  p.reason.maxLength=240;
  for(const [name,cap] of [['obligations',4],['routeObligations',8],['choiceObligations',2]] as const){
   p[name].maxItems=cap; const entry=p[name].items.properties;
   entry.rationale.maxLength=120; entry.sourceIds.maxItems=4;
   if(entry.requiredConditions)entry.requiredConditions.properties.all.maxItems=4;
   if(entry.requiredEffects)entry.requiredEffects.maxItems=4;
   if(entry.requiredState)entry.requiredState.properties.all.maxItems=4;
   if(entry.successorBeatKeys)entry.successorBeatKeys.maxItems=8;
   if(entry.observeAtoms)entry.observeAtoms.maxItems=4;
  }
  for(const entry of Object.values(p.coverage.properties) as any[])entry.properties.reason.maxLength=100;
 }else if(stage==='preservation_policy_review')result.properties.reason.maxLength=360;
 return result;
}
export const policyReviewSchema=obj({status:{type:'string',enum:['supported','unsupported','ambiguous']},reason:str});
export const preservationPrompt='Derive executable preservation obligations from the author contract and brief BEFORE any repair candidate is generated. The original graph may be defective: do not freeze its current conditions/effects merely because they exist. Only source-backed author requirements may constrain a repair. Scene prose locates events but is not an independent author requirement. Cite sourceIds from the supplied catalog, never invent or rewrite quotes. Separate event preconditions/effects, route-specific states AFTER an event, and author-required differences between choices. For shared events use routeObligations with storylineIndex and requiredState AFTER the event. Event obligations are unconditional requirements on the same beat in EVERY route: never require paid=true and paid=false on a shared beat. Do not add an assignment merely to assert preservation: unchanged route state can require NO effect. Use at most one event entry per beat, and one route entry per (storylineIndex,beatKey). Do not invent resource permanence, universal knowledge sources, costs, or differences not required by the author. Correct faulty original symbols against author intent. Return coverage as an object keyed by EVERY exact source ID, with disposition and reason for each key. context-only means background, a symbol definition, or an ending already enforced by the fixed ending kernel; explain why no additional obligation is needed. enforced requires at least one cited executable obligation. If a material requirement is ambiguous, contradicts fixed prose, requires prose/topology/contract changes, or cannot be represented using existing initialized atoms, use unrepresentable and status abstain. ready requires nonempty executable obligations and no unrepresentable entries. Equality facts use op eq and effects op set. Keep obligations minimal, covering author-required functions threatened by edits within scope across ALL routes, including different routes to the SAME ending. Use the supplied routes catalog for storylineIndex and choices catalog for actual split nodes; a merge or linear node is not a choice. Do not treat existing erroneous effects as instructions. Ending conditions are already checked by the fixed kernel, so mark ending sources context-only unless they establish an additional obligation. The output budget is 4 event obligations, 8 route checkpoints, 2 choice obligations, and 4 atoms/citations per entry. If complete relevant coverage does not fit, abstain with unrepresentable coverage; do not silently omit requirements. Reasons must be short final conclusions: root 240 characters, rationale 120, coverage reason 100. Do not include deliberation, alternatives or repeated self-questioning. Output only the prescribed JSON.';
export const preservationReviewPrompt='Independently audit the extracted preservation policy against author sources, meanings, scene prose, and the diagnosis. Check BOTH unsupported added obligations AND omitted material requirements marked context-only. Original symbolic assignments may be errors and must not be frozen as truth. Check polarity, consent versus refusal, attempted versus completed actions, costs and refunds, route-specific shared states, and applicability at each referenced event. A citation is not proof of entailment. Return status supported only if the policy is source-supported and covers the relevant repair risks; unsupported for definite extraction errors, ambiguous if author intent or fixed prose prevents a justified symbol-only repair. Do not rewrite the policy or generate a patch. Return {status,reason}.';

/** Validation proves grounding/references, not semantic entailment. That has a separate model review and independent evaluation. */
export function compilePreservationPolicy(raw:unknown,payload:SymbolicStoryPayload,scope:readonly string[]){
 const input=raw as any;
 // Keyed generation makes coverage omission impossible in native constrained decoding.
 // Legacy array responses remain accepted and receive the same exhaustive validation.
 const normalized=input&&input.coverage&&typeof input.coverage==='object'&&!Array.isArray(input.coverage)?{...input,coverage:Object.entries(input.coverage).map(([sourceId,entry])=>({...entry as object,sourceId}))}:input;
 const proposal=PreservationProposalSchema.parse(normalized),sources=preservationSources(payload),bySource=new Map(sources.map(s=>[s.id,s]));
 const plan=StatefulStorylinePlanSchema.parse(payload.plan),beats=new Set(plan.beats.map(b=>b.key));
 if(!scope.length||new Set(scope).size!==scope.length||scope.some(k=>!beats.has(k)))throw Error('Invalid preservation repair scope');
 const coverage=new Map(proposal.coverage.map(c=>[c.sourceId,c]));
 if(coverage.size!==sources.length||coverage.size!==proposal.coverage.length||sources.some(s=>!coverage.has(s.id)))throw Error('Coverage must include every author source exactly once');
 const atoms=new Map(payload.outcomes.initialState.map(a=>[JSON.stringify([a.ref.symbol,...a.ref.args]),a]));
 const checkRef=(ref:{symbol:string;args:string[]},value?:boolean|number,op?:string)=>{
  const atom=atoms.get(JSON.stringify([ref.symbol,...ref.args]));if(!atom)throw Error('Policy uses an unknown or uninitialized atom');
  if(value!==undefined&&(typeof value!==typeof atom.value || (typeof value==='boolean'&&op&&!['eq','ne','set'].includes(op))))throw Error('Policy atom type/operator mismatch');
 };
 const all=[...proposal.obligations,...proposal.routeObligations,...proposal.choiceObligations];
 for(const o of all){
  if(!beats.has(o.beatKey))throw Error('Policy references unknown event');
  if(new Set(o.sourceIds).size!==o.sourceIds.length||o.sourceIds.some(id=>!bySource.has(id)))throw Error('Policy references unknown or duplicate author source');
  if(!o.sourceIds.some(id=>bySource.get(id)!.kind!=='definition'))throw Error('Symbol definition alone does not establish a preservation requirement');
 }
 for(const c of proposal.coverage){
  const used=all.some(o=>o.sourceIds.includes(c.sourceId));
  if(c.disposition==='enforced'&&!used)throw Error('Enforced source has no executable obligation');
  if(used&&bySource.get(c.sourceId)?.kind!=='definition'&&c.disposition!=='enforced')throw Error('Cited author source must be marked enforced');
 }
 const checkGuard=(all:Array<{ref:{symbol:string;args:string[]};op:string;value:boolean|number}>)=>{
  const fixed=new Map<string,boolean|number>();
  for(const c of all){checkRef(c.ref,c.value,c.op);if(c.op==='eq'){const key=JSON.stringify([c.ref.symbol,...c.ref.args]);if(fixed.has(key)&&fixed.get(key)!==c.value)throw Error('Contradictory equality requirements on '+key+'; shared-route states belong in routeObligations, not universal event requirements');fixed.set(key,c.value);}}
 };
 for(const o of proposal.obligations){
  if(!o.requiredConditions.all.length&&!o.requiredEffects.length)throw Error('Empty event preservation obligation');
  checkGuard(o.requiredConditions.all);
  if(new Set(o.requiredEffects.map(e=>JSON.stringify(e.ref))).size!==o.requiredEffects.length)throw Error("Duplicate required effect atom");
  for(const e of o.requiredEffects)checkRef(e.ref,e.value,e.op);
 }
 for(const o of proposal.routeObligations){
  if(!plan.storylines[o.storylineIndex]?.steps.some(s=>s.beatKey===o.beatKey)||!o.requiredState.all.length)throw Error('Invalid route checkpoint');
  checkGuard(o.requiredState.all);
 }
 // Requirements in separate entries still apply jointly to the same event/checkpoint.
 for(const beat of beats){
  const entries=proposal.obligations.filter(o=>o.beatKey===beat);
  checkGuard(entries.flatMap(o=>o.requiredConditions.all));
  const effects=new Map<string,string>();
  for(const e of entries.flatMap(o=>o.requiredEffects)){
   const key=JSON.stringify([e.ref.symbol,...e.ref.args]),value=JSON.stringify([e.op,e.value]);
   if(effects.has(key)&&effects.get(key)!==value)throw Error('Contradictory event effect requirements');
   effects.set(key,value);
  }
  for(let i=0;i<plan.storylines.length;i++)checkGuard(proposal.routeObligations.filter(o=>o.beatKey===beat&&o.storylineIndex===i).flatMap(o=>o.requiredState.all));
 }
 for(const o of proposal.choiceObligations){
  const next=new Set(plan.storylines.flatMap(r=>r.steps.flatMap((s,i)=>s.beatKey===o.beatKey&&r.steps[i+1]?[r.steps[i+1]!.beatKey]:[])));
  if(new Set(o.successorBeatKeys).size!==o.successorBeatKeys.length||o.successorBeatKeys.some(k=>!next.has(k))||(!o.observeEndings&&!o.observeAtoms.length))throw Error('Invalid choice preservation obligation');
  o.observeAtoms.forEach(ref=>checkRef(ref));
 }
 // Necessary compatibility check only: a required Boolean checkpoint cannot
 // contradict a fixed ending through a suffix that cannot change that fact.
 for(const obligation of proposal.routeObligations){
  const route=plan.storylines[obligation.storylineIndex]!,position=route.steps.findIndex(s=>s.beatKey===obligation.beatKey);
  const known=new Map<string,boolean>(obligation.requiredState.all.filter(c=>c.op==='eq'&&typeof c.value==='boolean').map(c=>[JSON.stringify(c.ref),c.value as boolean]));
  for(const step of route.steps.slice(position+1)){
   const beat=plan.beats.find(b=>b.key===step.beatKey)!;
   // An editable future event may change any atom. Do not assume the defective original effects persist.
   const editable=scope.includes(beat.key);if(editable)known.clear();
   const effects=editable?proposal.obligations.filter(o=>o.beatKey===beat.key).flatMap(o=>o.requiredEffects):beat.effects;
   for(const e of effects){const key=JSON.stringify(e.ref);if(e.op==='set'&&typeof e.value==='boolean')known.set(key,e.value);else known.delete(key);}
  }
  for(const c of payload.outcomes.outcomes.find(o=>o.endingId===route.endingId)!.condition.all){
   const value=known.get(JSON.stringify(c.ref));
   if(value!==undefined&&typeof c.value==='boolean'&&((c.op==='eq'&&value!==c.value)||(c.op==='ne'&&value===c.value)))throw Error('Preservation checkpoint contradicts fixed ending on route '+obligation.storylineIndex+' at '+obligation.beatKey);
  }
 }
 if(proposal.status==='ready'&&(!all.length||proposal.coverage.some(c=>c.disposition==='unrepresentable')))throw Error('Ready policy needs executable, representable obligations');
 const strip=<T extends {sourceIds:string[]}>(o:T)=>{const {sourceIds,...rest}=o;return rest;};
 const policy:PatchPolicy=PatchPolicySchema.parse({editableBeatKeys:[...scope],obligations:proposal.obligations.map(strip),routeObligations:proposal.routeObligations.map(strip),choiceObligations:proposal.choiceObligations.map(strip)});
 const snapshot={proposal,policy,sources,baselineHash:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
 const hash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(snapshot);
 return Object.freeze({...snapshot,hash});
}
