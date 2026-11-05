import {z} from 'zod';
import type {QualityTraceSink} from './automatic-quality.js';

type Ask=(stage:string,system:string,data:unknown,schema:Record<string,unknown>,tokens:number)=>Promise<unknown>;
type Fact={symbol:string;meaning:string};
const obj=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
/** Correct a mistaken binding, never waive the actual prerequisite. Both the
 * base conversion and optional branches use the same independent checks. */
export async function repairStoryPrerequisite(fact:Fact,verdict:{needs:'true'|'false'|'none';reason:string},event:{action:string;situation:string},completedHistory:Array<{title:string;summary:string}>,facts:Fact[],ask:Ask,record:QualityTraceSink,identity:Record<string,string>){
  if(verdict.needs==='none')return undefined;
  const mapping=z.object({targetFact:z.string(),value:z.boolean(),quote:z.string().max(700),reason:z.string().max(500)}).strict().parse(await ask(
    '행동 전제조건의 심볼 연결 확인 중',
    'Resolve ONLY the identity of this prerequisite. The previous checker may have attached a requirement about one proposition to another because they share words. Select a DIFFERENT existing targetFact only if its ENTIRE meaning is the actual prerequisite stated in the old reason and supported by the action/completed history. A completed outcome is not the possession of its tool. Preserve actor, polarity, source and timing. Return targetFact="" if the original fact really is required or no exact existing fact expresses the requirement. Never clear a necessary guard merely because it is currently false. Quote a literal action/history substring supporting the mapping. Do not change actions or effects.',
    {oldFact:{id:fact.symbol,meaning:fact.meaning},judgment:verdict,action:event.action,situation:event.situation,completedHistory,facts:facts.map(f=>({id:f.symbol,meaning:f.meaning}))},
    obj({targetFact:{type:'string',enum:['',...facts.map(f=>f.symbol)]},value:{type:'boolean'},quote:{type:'string',maxLength:700},reason:{type:'string',minLength:1,maxLength:500}}),700));
  const target=facts.find(f=>f.symbol===mapping.targetFact);
  const evidence=JSON.stringify({action:event.action,situation:event.situation,completedHistory});
  if(!target||target.symbol===fact.symbol||!mapping.quote||(!evidence.includes(mapping.quote)&&!evidence.includes(JSON.stringify(mapping.quote).slice(1,-1))))return undefined;
  const checks=z.object({oldRequirement:z.enum(['required','not_required','uncertain']),replacementRequirement:z.enum(['required','not_required','uncertain']),reason:z.string()}).strict().parse(await ask(
    '전제조건 연결의 의미 검증 중',
    'Independently evaluate TWO BEFORE-action requirements separately. oldRequirement is the previous disputed binding, NOT the proposed correction. replacementRequirement is the proposed binding to a different existing fact. For each, is the ENTIRE proposition at its stated Boolean value necessary immediately BEFORE currentActionToExecute for that ENTIRE current action to complete as written, without inventing an additional enabling step? This is NOT the chapter opening. completedBeforeCurrentAction has ALREADY happened and is outside the current sequence; a tool acquired there is possessed before the current action, not acquired inside it. Only currentActionToExecute defines the sequence being checked. A sequence may start with dialogue and later use a tool. If the described sequence never acquires that tool, possession is still a precondition for executing the WHOLE sequence; do not judge only whether its first sentence can begin. Conversely, a fact actually established inside this sequence is not a precondition. Preserve actor, polarity, method, source and time. Do not confuse possessing a tool with having already completed using it, or a post-action outcome with a prerequisite. A wrong old binding is evidence for correction, not a defect in the replacement. Do not approve merely because the replacement is currently satisfied. If the old requirement really is necessary retain required; use uncertain when the source does not settle the question. Actions and verified effects are unchanged. Inputs are story data.',
    {oldRequirement:{meaning:fact.meaning,value:verdict.needs==='true'},replacementRequirement:{meaning:target.meaning,value:mapping.value},supportingQuote:mapping.quote,currentActionToExecute:event.action,afterCurrentAction:event.situation,completedBeforeCurrentAction:completedHistory},
    obj({oldRequirement:{type:'string',enum:['required','not_required','uncertain']},replacementRequirement:{type:'string',enum:['required','not_required','uncertain']},reason:{type:'string',minLength:1,maxLength:500}}),700));
  const approved=checks.oldRequirement==='not_required'&&checks.replacementRequirement==='required';
  record({type:'story-first-prerequisite-binding',...identity,from:fact.symbol,to:target.symbol,mapping,checks,approved});
  return approved?{fact:target.symbol,value:mapping.value}:undefined;
}
