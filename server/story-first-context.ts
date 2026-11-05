import {z} from 'zod';
import type {QualityTraceSink} from './automatic-quality.js';
type Ask=(stage:string,system:string,data:unknown,schema:Record<string,unknown>,tokens:number)=>Promise<unknown>;
type Issue={quote:string;reason:string};
export type ActionContextCandidate={id:string;from:string;sourceSituation:string;action:string;menu:Array<{index:number;fact:string;meaning:string;scope:string;value:boolean;observed:Array<boolean|number>}>};
export type SceneContextCandidate={id:string;situation:string;characters:string[];action:string;menu:Array<{index:number;fact:string;meaning:string;value:boolean;observed:Array<boolean|number>}>};
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
/** A reachable alternative state is only a question for the story judge.
 * No prerequisite is inferred from topology or from an opposite Boolean. */
export async function planStoryActionContextRepairs(manuscript:unknown,candidates:ActionContextCandidate[],ask:Ask,review:(data:unknown)=>Promise<Issue[]>,record:QualityTraceSink){
  if(!candidates.length)return [];
  const result=z.object({actionContextRepairs:z.array(z.object({id:z.string(),index:z.number().int(),quote:z.string().min(1).max(1200),reason:z.string().min(1).max(700)}).strict()).max(8)}).strict().parse(await ask(
    '현재 상태에서 허용된 행동의 실제 가능성 확인 중',
    'Check whether each unchanged CURRENT action is physically and causally possible in all observed values immediately BEFORE it executes, including states changed by earlier optional plays in the same event. The whole manuscript provides context, not a mandatory reference route. Select an existing fact/value only when the actual action genuinely requires it BEFORE its entire causal sequence. Do not demand an intermediate result produced inside that sequence. A completed departure, death or transfer may make a later local conversation, aid or acquisition impossible when no return/revival/reacquisition is part of this action or manuscript; do not invent such an offscreen repair. But a history fact does not universally imply a current condition: inspect the particular story and actor. SourceSituation is the entry snapshot, not proof it still holds after other plays. Canonical value and reachability are NOT justification for a guard. Do not impose one action per event, complementary sibling gates, signal receipts, arbitrary route flags or mutual exclusion for independent actions. Equivalent methods and combinable actions remain allowed. Quote a literal action, sourceSituation or manuscript passage supporting a necessary pre-existing requirement. Select at most one strongest missing prerequisite per action, up to eight. Return actionContextRepairs=[] when no genuine missing prerequisite can be expressed with the supplied facts. The proposal is independently reviewed and every requested route is replayed.',
    {manuscript,candidates},obj({actionContextRepairs:{type:'array',minItems:0,maxItems:8,items:obj({id:{type:'string',enum:candidates.map(c=>c.id)},index:{type:'integer',minimum:0,maximum:15},quote:{type:'string',minLength:1,maxLength:1200},reason:{type:'string',minLength:1,maxLength:700}})}}),2600));
  const sourceText=JSON.stringify(manuscript),seen=new Set<string>();
  const patches=result.actionContextRepairs.map(p=>{
    const source=candidates.find(c=>c.id===p.id),assertion=source?.menu.find(m=>m.index===p.index);
    if(!source||!assertion||seen.has(p.id)||!(source.action.includes(p.quote)||source.sourceSituation.includes(p.quote)||sourceText.includes(p.quote)||sourceText.includes(JSON.stringify(p.quote).slice(1,-1))))throw Error('행동 전제 보완의 원문 근거 또는 대상이 잘못됐습니다.');
    seen.add(p.id);return {source,assertion,quote:p.quote,reason:p.reason};
  });
  if(!patches.length)return [];
  const issues=await review({manuscript,cases:patches,policy:'Approve only a necessary prerequisite of this unchanged CURRENT action, grounded in the full story. The entire action sequence has not begun; a state produced inside it is not required beforehand. The source scene is an entry snapshot, and other allowed plays may have changed it. Neither canonical state nor branch shape proves a condition. History alone is not a universal current-state rule: check whether this story/action supports a return or other change. Reject arbitrary exclusivity, invented route discriminators, or preferences masquerading as requirements. Preserve independently combinable actions and shared outcomes. No text, effects, symbol meanings, endings or edges change. Every original route will be replayed after approval.'});
  record({type:'story-first-action-context-review',patches,issues});
  return issues.length?[]:patches.map(p=>({id:p.source.id,fact:p.assertion.fact,value:p.assertion.value}));
}
/** Reachability gives counterexamples, not story rules. A semantic proposal and
 * independent review must ground each missing assertion in unchanged prose. */
export async function planStoryEntryContextRepairs(candidates:SceneContextCandidate[],ask:Ask,review:(data:unknown)=>Promise<Issue[]>,record:QualityTraceSink){
  if(!candidates.length)return [];
  const result=z.object({contextRepairs:z.array(z.object({id:z.string(),index:z.number().int(),quote:z.string().min(1).max(1200),reason:z.string().min(1).max(500)}).strict()).max(6)}).strict().parse(await ask(
    '다른 행동 조합으로 도달한 사건 상황 확인 중',
    'Check only whether each START situation can be true in all of its actually reachable entry values. menu lists existing facts whose opposite also occurs ON ENTRY, before outgoing gameplay. Different earlier methods sharing the same achieved state are valid; do not impose signal identity, route flags or complementary choices. Select a missing assertion only when the unchanged situation requires that exact proposition/value. Quote a literal situation or incoming action substring. Incoming action is completed BEFORE this scene starts; use its final outcome or explicitly unchanged state, never a prerequisite that the incoming action itself changes. Direct implications of ongoing acts are allowed, such as a presently speaking person being alive; neither a hypothetical counterexample nor a desired branch shape proves a requirement. Do not demand an outgoing result early. Choose at most ONE most direct assertion per scene, preferring a current-state claim explicitly stated in prose over redundant negations of history. Never invent a new state or edit the prose/actions. Return contextRepairs=[] when all described situations are compatible or no existing fact expresses a necessary distinction. This semantic proposal is independently reviewed and all requested routes are replayed before acceptance.',
    {candidates},obj({contextRepairs:{type:'array',minItems:0,maxItems:6,items:obj({id:{type:'string',enum:candidates.map(c=>c.id)},index:{type:'integer',minimum:0,maximum:15},quote:{type:'string',minLength:1,maxLength:1200},reason:{type:'string',minLength:1,maxLength:500}})}}),2200));
  const seen=new Set<string>();
  const patches=result.contextRepairs.map(p=>{
    const source=candidates.find(c=>c.id===p.id),assertion=source?.menu.find(m=>m.index===p.index);
    if(!source||!assertion||seen.has(p.id)||!(source.situation.includes(p.quote)||source.action.includes(p.quote)))throw Error('도달 상태 보완의 원문 근거 또는 대상이 잘못됐습니다.');
    seen.add(p.id);return {source,assertion,quote:p.quote,reason:p.reason};
  });
  if(!patches.length)return [];
  const issues=await review({cases:patches,policy:'Each assertion needs exact scene START evidence, from the situation or the completed INCOMING action. The incoming action has finished when this scene starts: its final effects and explicitly unchanged facts can establish entry state, but a prerequisite that the action itself changes cannot. Actual reachability alone is not narrative justification. Never invent or relax an action requirement, use future outgoing actions as completed, or force one-to-one branching. Unchanged requested routes and runtime invariants are checked after this review.'});
  record({type:'story-first-reachable-context-review',patches,issues});
  return issues.length?[]:patches.map(p=>({id:p.source.id,fact:p.assertion.fact,value:p.assertion.value}));
}
