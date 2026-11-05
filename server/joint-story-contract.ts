import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ManuscriptSchema,type Manuscript,type EventAuthoring} from '../src/story-first.js';
import {compileChapterSetup} from './chapter-setup.js';
import {parseChapterAuthoring,activeChapterApproval} from '../src/chapter-authoring.js';
import {StatefulStorylinePlanSchema} from '../src/stateful-storyline-plan.js';
import {materializeStatefulPlan,diagnoseStatefulRoute,StatefulPlanError} from '../src/stateful-storyline.js';
import {projectSymbolicStory} from '../src/symbolic-story-projection.js';
import {buildChapterGameplay} from '../src/chapter-gameplay-binding.js';
import {auditStoryFirstGameplay} from './story-first-audit.js';
import {SYMBOLIC_ASSIGNMENT_LIMIT} from '../src/symbolic-graph.js';
import type {BranchComplexity} from '../src/chapter-complexity.js';

// JSON schemas remain explicit so every provider sees the same bounded contract.
export const text=(maxLength=600)=>({type:'string',minLength:1,maxLength});
export const array=(items:unknown,minItems=0,maxItems=24)=>({type:'array',items,minItems,maxItems});
export const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const name=z.string().min(1).max(100);
export const BitSchema=z.object({fact:z.string(),value:z.boolean()}).strict();
export const bitsJson=array(object({fact:text(40),value:{type:'boolean'}}),0,SYMBOLIC_ASSIGNMENT_LIMIT);
export const JointBookSchema=ManuscriptSchema.required({causalLinks:true,opportunities:true,places:true});
export const bookJson=object({title:text(200),truth:text(1800),motives:array(object({character:text(100),goal:text(600),changeReason:text(600)}),0,8),opening:text(1800),places:array(object({name:text(100),within:{anyOf:[text(100),{type:'null'}]}}),0,12),paths:array(object({ending:text(200),story:text(3500)}),1,6),causalLinks:array(object({action:text(500),consequence:text(500),laterImpact:text(500)}),0,12),opportunities:array(object({situation:text(500),alternatives:array(text(700),2,3),commonContinuation:text(500)}),0,4)});
export const JointSetupSchema=z.object({
  player:name,characters:z.array(name).min(1).max(8),items:z.array(name).max(10),locations:z.array(name).min(1).max(8),
  facts:z.array(z.object({meaning:z.string().min(1).max(300),subject:name,initial:z.boolean(),initialStatement:z.string().min(1).max(400),scope:z.enum(['current','history']),reason:z.string().min(1).max(300)}).strict()).min(1).max(SYMBOLIC_ASSIGNMENT_LIMIT),
  endings:z.array(z.object({id:z.string(),requirements:z.array(BitSchema).min(1).max(SYMBOLIC_ASSIGNMENT_LIMIT)}).strict()).min(1).max(6),
}).strict();
export type JointSetup=z.infer<typeof JointSetupSchema>;
export const setupJson=object({player:text(100),characters:array(text(100),1,8),items:array(text(100),0,10),locations:array(text(100),1,8),facts:array(object({reason:text(300),meaning:text(300),subject:text(100),initial:{type:'boolean'},initialStatement:text(400),scope:{type:'string',enum:['current','history']}}),1,SYMBOLIC_ASSIGNMENT_LIMIT),endings:array(object({id:text(40),requirements:{...bitsJson,minItems:1}}),1,6)});
const SetupFact=JointSetupSchema.shape.facts.element;
export const DeclaredSetupSchema=JointSetupSchema.extend({facts:z.array(SetupFact.extend({id:z.string().regex(/^[a-z][a-z0-9_]*$/).max(64)})).min(1).max(SYMBOLIC_ASSIGNMENT_LIMIT)});
export function declaredSetupJson(limit:number){
 const facts=setupJson.properties.facts as {items:{properties:Record<string,unknown>}};
 return object({...setupJson.properties,facts:array(object({id:{...text(64),pattern:'^[a-z][a-z0-9_]*$'},...facts.items.properties}),1,limit)});
}
/** Model-facing explicit keys survive insertion/reordering. Exported IDs retain
 * the established fact_N format; every ending reference is remapped together. */
export function normalizeDeclaredSetup(raw:z.infer<typeof DeclaredSetupSchema>):JointSetup{
 const proposal=DeclaredSetupSchema.parse(raw),keys=proposal.facts.map(f=>f.id);
 if(new Set(keys).size!==keys.length)throw Error('중복 심볼 식별자');
 const remap=new Map(keys.map((key,i)=>[key,'fact_'+(i+1)]));
 return JointSetupSchema.parse({...proposal,facts:proposal.facts.map(({id,...fact})=>fact),endings:proposal.endings.map(e=>({...e,requirements:e.requirements.map(r=>{
  const fact=remap.get(r.fact);if(!fact)throw Error('선언되지 않은 심볼 식별자: '+r.fact);return {...r,fact};
 })}))});
}
export function declaredSetupContext(design:JointSetup){return {...design,facts:design.facts.map((f,i)=>({id:'fact_'+(i+1),...f}))};}
export const JointEventSchema=z.object({id:z.string().regex(/^beat_[a-z0-9_]+$/).max(48),title:z.string().min(1).max(200),situation:z.string().min(1).max(1200),location:name,characters:z.array(name).min(1).max(8),play:z.string().min(1).max(240),action:z.string().min(1).max(1200)}).strict();
export const eventJson=object({id:{...text(48),pattern:'^beat_[a-z0-9_]+$'},title:text(200),
  play:{...text(240),description:'Incoming gameplay performed at the PREVIOUS event to reach this event.'},
  action:{...text(1200),description:'The incoming action and its completed result. It happens BEFORE this event starts, at the predecessor. Opening only: initial situation, no action.'},
  situation:{...text(1200),description:'Destination scene when its entry state holds, BEFORE outgoing actions. The incoming play can establish that state, but another route may already have established an equivalent state. Describe the actual present situation, not necessarily the specific cause by which this actor got it. Example: the door is open; not the player can unlock it, and not necessarily the player just used this particular key. Keep the concrete incoming play/action and its effects intact in their own fields.'},
  location:{...text(100),description:'The physical location of the resulting scene, after the incoming action.'},characters:{...array(text(100),1,8),description:'Characters physically present at this scene location. A person mentioned in records, heard over a radio, or speaking remotely is NOT physically present; describe their remote participation in prose instead.'}});
export const jointEventJson=(design:JointSetup)=>object({...eventJson.properties,
  location:{...(eventJson.properties.location as Record<string,unknown>),type:'string',enum:design.locations},
  characters:{...(eventJson.properties.characters as Record<string,unknown>),...array({type:'string',enum:design.characters},1,8)},
});
export const RouteSchema=z.object({ending:z.string(),steps:z.array(z.string()).min(2).max(20)}).strict();
export const routesJson=array(object({ending:text(40),steps:array(text(48),2,20)}),1,12);
export const JointMapSchema=z.object({events:z.array(JointEventSchema).min(2).max(40),routes:z.array(RouteSchema).min(1).max(12)}).strict();
export type JointMap=z.infer<typeof JointMapSchema>;
export const mapJson=object({events:array(eventJson,2,40),routes:routesJson});
export const JointRuleSchema=z.object({id:z.string(),requires:z.array(BitSchema).max(SYMBOLIC_ASSIGNMENT_LIMIT),changes:z.array(BitSchema).max(SYMBOLIC_ASSIGNMENT_LIMIT),entry:z.array(BitSchema).max(SYMBOLIC_ASSIGNMENT_LIMIT),rationale:z.string().min(1).max(800)}).strict();
export type JointRule=z.infer<typeof JointRuleSchema>;
export const ruleJson=object({id:text(48),
  requires:{...bitsJson,description:'Necessary state BEFORE the incoming action at its predecessor.'},
  changes:{...bitsJson,description:'Completed effects of that incoming action, applied at the predecessor by gameplay.'},
  entry:{...bitsJson,description:'Necessary state AFTER the incoming action for starting this destination scene. Must agree with the event situation.'},
  rationale:text(800)});
export function jointRuleJson(design:JointSetup){
  const bits=array(object({fact:{type:'string',enum:design.facts.map((_,i)=>'fact_'+(i+1))},value:{type:'boolean'}}),0,SYMBOLIC_ASSIGNMENT_LIMIT);
  return object({...ruleJson.properties,
    requires:{...(ruleJson.properties.requires as Record<string,unknown>),...bits},
    changes:{...(ruleJson.properties.changes as Record<string,unknown>),...bits},
    entry:{...(ruleJson.properties.entry as Record<string,unknown>),...bits},
  });
}
/** Keep the action, its conditions/effects and resulting scene adjacent in the
 * model response. Exported event/rule structures remain unchanged. */
export const JointAuthoredBatchSchema=z.object({authoredEvents:z.array(JointEventSchema.merge(JointRuleSchema)).min(1).max(8)}).strict();
export function jointAuthoredBatchJson(design:JointSetup,ids:string[]){
 const e=jointEventJson(design).properties,r=jointRuleJson(design).properties;
  return object({authoredEvents:array(object({id:{type:'string',enum:ids},title:e.title,play:e.play,
  action:e.action,rationale:r.rationale,requires:r.requires,changes:r.changes,entry:r.entry,situation:e.situation,
  location:e.location,characters:e.characters}),ids.length,ids.length)});
}
export function splitJointAuthoredBatch(raw:z.infer<typeof JointAuthoredBatchSchema>){
 const parsed=JointAuthoredBatchSchema.parse(raw);
 return {events:parsed.authoredEvents.map(({requires,changes,entry,rationale,...event})=>JointEventSchema.parse(event)),
  rules:parsed.authoredEvents.map(({id,requires,changes,entry,rationale})=>JointRuleSchema.parse({id,requires,changes,entry,rationale}))};
}

export const RulesSchema=z.object({rules:z.array(JointRuleSchema).min(1).max(8)}).strict();
export const rulesJson=object({rules:array(ruleJson,1,8)});

export function checkJointMap(map:JointMap,endings:string[]){
  const ids=new Set(map.events.map(e=>e.id)),used=new Set<string>(),covered=new Set<string>();
  if(ids.size!==map.events.length)throw Error('중복 사건 ID');
  const opening=map.routes[0]!.steps[0]!;
  const edges=new Map<string,Set<string>>();
  const routeIssues=map.routes.flatMap((r,routeIndex)=>{
    const repeated=[...new Set(r.steps)].flatMap(id=>{
      const positions=r.steps.flatMap((step,index)=>step===id?[index]:[]);
      return positions.length>1?[{id,positions,title:map.events.find(e=>e.id===id)?.title}]:[];
    });
    const unknownSteps=r.steps.flatMap((id,index)=>ids.has(id)?[]:[{id,index}]);
    return !endings.includes(r.ending)||r.steps[0]!==opening||repeated.length||unknownSteps.length
      ?[{routeIndex,ending:r.ending,invalidEnding:!endings.includes(r.ending),expectedOpening:opening,actualOpening:r.steps[0],repeated,unknownSteps}]:[];
  });
  if(routeIssues.length)throw Error('잘못된 경로 참조 또는 결말: '+JSON.stringify({routeIssues,allowedEndings:endings,
    instruction:'Repair the named routes and positions. Returning to the same physical place later is a NEW scene, not re-entry to the same event ID: author the later visit and its actual incoming action/result separately, then reconcile ordering across ALL routes. Do not remove the investigation, return visit or requested outcome to hide a cycle. Reuse IDs only for a genuinely shared continuation at the same narrative stage; never reuse an earlier occurrence after its descendants. Preserve every existing event on a valid route.',
  }));
  for(const r of map.routes){
    covered.add(r.ending);r.steps.forEach(id=>used.add(id));
    r.steps.slice(1).forEach((to,i)=>{const from=r.steps[i]!;if(!edges.has(from))edges.set(from,new Set());edges.get(from)!.add(to);});
  }
  if(used.size!==ids.size||covered.size!==endings.length)throw Error('결말 또는 사건 누락: '+JSON.stringify({
    uncoveredEvents:map.events.filter(e=>!used.has(e.id)).map(e=>({id:e.id,title:e.title,action:e.action})),
    uncoveredEndings:endings.filter(id=>!covered.has(id)),
    instruction:'Every listed existing event must remain on a causally valid route. Repair the proposed route edits or add a valid alternative containing the disconnected event. Do not delete the event, duplicate an unrelated route or change a requested ending to hide the omission.',
  }));
  const active=new Set<string>(),done=new Set<string>(),stack:string[]=[];
  const visit=(id:string)=>{
    if(active.has(id)){
      const cycle=[...stack.slice(stack.indexOf(id)),id];
      const connections=cycle.slice(1).map((to,i)=>({from:cycle[i]!,to,routeIndices:map.routes.flatMap((r,index)=>r.steps.some((step,j)=>step===cycle[i]&&r.steps[j+1]===to)?[index]:[])}));
      throw Error('사건 경로 순환: '+JSON.stringify({cycle,connections,instruction:'Each route may be acyclic while their UNION cycles. Reconcile the ordering across these routes without deleting required actions or alternatives. Keep the previously valid map until a whole acyclic proposal is ready.'}));
    }
    if(done.has(id))return;active.add(id);stack.push(id);for(const to of edges.get(id)??[])visit(to);stack.pop();active.delete(id);done.add(id);
  };visit(opening);
  return {opening,edges};
}

/** Keep siblings together; whole map and upstream approved rules accompany every batch. */
export function jointRuleGroups(map:JointMap){
  const {opening,edges}=checkJointMap(map,[...new Set(map.routes.map(r=>r.ending))]);
  const assigned=new Set([opening]),groups:string[][]=[];
  const queue=[opening],visited=new Set<string>();
  while(queue.length){const id=queue.shift()!;if(visited.has(id))continue;visited.add(id);
    const children=[...(edges.get(id)??[])];queue.push(...children);
    const pending=children.filter(c=>!assigned.has(c));
    while(pending.length){const group=pending.splice(0,6);group.forEach(c=>assigned.add(c));groups.push(group);}
  }
  // Pack nearby breadth-first groups without splitting sibling alternatives.
  // Linear scenes should not each become a separate model request.
  const packed:string[][]=[];
  for(const group of groups){const last=packed.at(-1);if(last&&last.length+group.length<=6)last.push(...group);else packed.push([...group]);}
  return packed;
}

/** A shared event can terminate one route while continuing another. Ending
 * alternatives describe those exits, never universal event prerequisites. */
export function jointEventContexts(map:JointMap,endingLabels:string[],ids:string[]){
  return ids.map(id=>({id,
    performedAt:[...new Set(map.routes.flatMap(r=>{const i=r.steps.indexOf(id);return i>0?[r.steps[i-1]!]:[]}))],
    routeUses:map.routes.flatMap((r,routeIndex)=>{const i=r.steps.indexOf(id);return i<0?[]:[{routeIndex,ending:r.ending,nextEvent:r.steps[i+1]??null}];}),
    terminalAlternatives:[...new Set(map.routes.filter(r=>r.steps.at(-1)===id).map(r=>r.ending))].map(ending=>({ending,description:endingLabels[Number(ending.replace('ending_',''))-1]})),
    continuesToward:[...new Set(map.routes.filter(r=>r.steps.includes(id)&&r.steps.at(-1)!==id).map(r=>r.ending))],
  }));
}

/** Salient authoring context, not inferred guards. Show every competing action
 * at each source even when its rule belongs to another batch. The author decides
 * which consequences genuinely affect continued physical availability. */
export function jointActionContexts(map:JointMap,rules:JointRule[],ids:string[]){
  const {edges}=checkJointMap(map,[...new Set(map.routes.map(r=>r.ending))]);
  return [...edges].filter(([,children])=>[...children].some(id=>ids.includes(id))).map(([from,children])=>({
    source:map.events.find(e=>e.id===from),
    alternatives:[...children].map(id=>({event:map.events.find(e=>e.id===id),assigned:ids.includes(id),existingRule:rules.find(r=>r.id===id)})),
  }));
}

export function compileJointStory(book:Manuscript,design:JointSetup,map:JointMap,rules:JointRule[],options:{brief:string;model:string;complexity:BranchComplexity;revision?:string}){
  const labels=book.paths.map(p=>p.ending);
  const {contract,playerId,subjects}=compileChapterSetup({...design,facts:design.facts.map(({meaning,subject})=>({meaning,subject})),endings:labels});
  const {opening,edges}=checkJointMap(map,contract.endings.map(e=>e.id));
  const ref=(fact:string)=>{const s=subjects.find(s=>s.symbol===fact);if(!s)throw Error('알 수 없는 심볼: '+fact);return {symbol:s.symbol,args:s.args};};
  const bits=(xs:z.infer<typeof BitSchema>[])=>{if(new Set(xs.map(x=>x.fact)).size!==xs.length)throw Error('중복 심볼 조건');return xs.map(x=>({ref:ref(x.fact),value:x.value}));};
  if(design.endings.length!==contract.endings.length||new Set(design.endings.map(e=>e.id)).size!==contract.endings.length||design.endings.some(e=>!contract.endings.some(c=>c.id===e.id)))throw Error('결말 조건 누락 또는 중복');
  const semantics=Object.fromEntries(design.facts.map((f,i)=>['fact_'+(i+1),{scope:f.scope,reason:f.reason}]));
  // The skeleton compiler labels choices with destination TITLES, not play
  // text. Give the author the exact conflicting fields instead of repeatedly
  // repairing the wrong prose field after a generic "choice labels" error.
  for(const source of map.events){
    const destinations=new Map<string,{id:string;title:string;field:string}>([...[...(edges.get(source.id)??[])].map(id=>[id,{id,title:map.events.find(e=>e.id===id)!.title,field:'events[].title'}] as const),
      ...map.routes.filter(r=>r.steps.at(-1)===source.id).map(r=>['end_'+r.ending,{id:'end_'+r.ending,title:contract.endings.find(e=>e.id===r.ending)!.label,field:'requested ending label (preserve)'}] as const)]);
    const titles=new Map<string,Array<{id:string;title:string;field:string}>>();
    for(const destination of destinations.values())titles.set(destination.title,[...(titles.get(destination.title)??[]),destination]);
    const collisions=[...titles.values()].filter(group=>group.length>1);
    if(collisions.length)throw new StatefulPlanError('duplicate-sibling-titles',{source:source.id,collisions,instruction:'The graph choice label comes from events[].title, NOT events[].play. Give the conflicting existing scene titles distinct accurate wording; changing only play text cannot fix this. Preserve their neutral shared outcome descriptions and all real action/state rules. Do not invent method-specific scene facts merely to distinguish titles.'});
  }
  const setup=parseChapterAuthoring({brief:options.brief,sourceBrief:options.brief,branchComplexity:options.complexity,contract,playerId,revision:options.revision??randomUUID(),model:options.model,setupMode:'generated',manuscript:book,factSemantics:semantics,
    initialEvidence:Object.fromEntries(design.facts.map((f,i)=>['fact_'+(i+1),{basis:book.opening.includes(f.initialStatement)?'source':'authored_default',quote:f.initialStatement,reason:f.reason}])),
    initialState:subjects.map((s,i)=>({ref:ref(s.symbol),value:design.facts[i]!.initial})),outcomes:design.endings.map(e=>({endingId:e.id,condition:{all:bits(e.requirements).map(c=>({...c,op:'eq'}))}}))});
  const {approval,outcomes}=activeChapterApproval(setup,contract.endings.map(e=>e.id));
  const byId=new Map(rules.map(r=>[r.id,r]));
  if(byId.size!==rules.length||rules.length!==map.events.length||map.events.some(e=>!byId.has(e.id)))throw Error('사건 규칙 누락 또는 중복');
  const first=byId.get(opening)!;if(first.changes.length||first.requires.length)throw Error('시작 사건은 자동 상태 변화를 만들 수 없습니다.');
  const plan=StatefulStorylinePlanSchema.parse({format:'stateful-storylines-v2',title:book.title,
    beats:map.events.map(e=>{const r=byId.get(e.id)!;return {key:e.id,title:e.title,precondition:{all:bits(r.requires).map(c=>({...c,op:'eq'}))},effects:bits(r.changes).map(c=>({...c,op:'set'}))};}),
    storylines:map.routes.map(r=>({endingId:r.ending,steps:r.steps.map(beatKey=>({beatKey}))}))});
  const entity=(label:string,kind:'characters'|'locations')=>{const found=contract.entityLabels!.find(e=>e.label===label&&contract.entities[kind].includes(e.id));if(!found)throw Error('등록되지 않은 '+kind+': '+label);return found.id;};
  const scenes:Record<string,unknown>=Object.fromEntries(map.events.map(e=>{const presentCharacters=e.characters.map(c=>entity(c,'characters'));return [e.id,{summary:e.situation,locationId:entity(e.location,'locations'),presentCharacters,...(!presentCharacters.includes(playerId)?{perspective:'offscreen'}:{})}];}));
  scenes.start={...(scenes[opening] as object),summary:'챕터 시작을 기다립니다.'};
  // Shared terminal confirmations do not teleport actors to the first route's
  // final room. Physical scene context remains at the actual predecessor.
  // locationId is a legacy schema/layout fallback only for outcome perspective.
  for(const end of contract.endings)scenes['end_'+end.id]={summary:end.label,locationId:contract.entities.locations[0]!,presentCharacters:[],perspective:'outcome'};
  const materialized=materializeStatefulPlan(approval,outcomes,plan,{scenes});
  const eventAuthoring:EventAuthoring={version:'story-first-v1',execution:'source-owned-v1',terminalConfirmations:true,
    actions:[...edges].flatMap(([from,children])=>[...children].map(to=>{const e=map.events.find(e=>e.id===to)!,r=byId.get(to)!;return {from,to,label:e.play,description:e.action,mode:r.changes.length?'result' as const:'choice' as const};})),
    entries:rules.map(r=>({eventId:r.id,conditions:r.entry}))};
  try{
  const story=projectSymbolicStory({approval,outcomes,plan,skeleton:materialized.skeleton,details:materialized.details,eventAuthoring});
  story.chapter=setup;
  // This pipeline already authors action prerequisites and destination entry
  // separately. Legacy result-branch inference would silently add downstream
  // ending predicates back to those action prerequisites after LLM repairs.
  // Keep direct authored rules; exhaustive execution still rejects dead ends.
  // Older pipelines and exported policy flags retain their original behavior.
  story.gameplay=buildChapterGameplay(story.symbolic!);
  // Actual gameplay is the authority: the legacy single-transition verifier
  // cannot see authored destination admission and can reject impossible paths.
  // The runtime audit still replays EVERY declared route and explores ALL
  // permitted action orders with separate end/start and real entry guards.
  const audit=auditStoryFirstGameplay(story.gameplay,plan,semantics,true);
  return {story,audit,plan};
  }
  catch(error){
    if(!(error instanceof StatefulPlanError)||error.code!=='blocked-storyline')throw error;
    const allStorylineObligations=plan.storylines.map((line,index)=>({storylineIndex:index,endingId:line.endingId,...diagnoseStatefulRoute(plan,index,outcomes)}))
      .filter(d=>d.blockedEvents.length||d.missingFinalFacts.length);
    throw new StatefulPlanError(error.code,{...(error.evidence as Record<string,unknown>),allStorylineObligations,
      jointRepairScope:'These are hypothetical diagnostics for ALL authored routes, not accepted execution. Repair the shared cause across affected routes/endings together. Preserve genuine action prerequisites; a temporary resource used before an outcome is not automatically required to remain possessed at the terminal state.'});
  }

}
