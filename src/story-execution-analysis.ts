import type {StatefulStorylinePlan} from './stateful-storyline-plan.js';
import {verifySymbolicModel} from './symbolic-verification.js';
import {createSymbolicState,getEnabledTransitions,tryTransition,classifyTerminal,type SymbolicModel,type SymbolicState,type SymbolicConfiguration} from './playtest/symbolic-engine.js';

const stateKey=(state:SymbolicState)=>JSON.stringify(Object.entries(state).sort(([a],[b])=>a.localeCompare(b)));
const configurationKey=(c:SymbolicConfiguration)=>c.situationId+':'+stateKey(c.state);
export const namedState=(state:SymbolicState)=>Object.fromEntries(Object.entries(state).map(([key,value])=>{
 const [symbol,...args]=JSON.parse(key) as string[];
 return [symbol+'('+args.join(',')+')',typeof value==='number'?value/100:value];
}));
const sceneKey=(id:string)=>id.startsWith('s_')?id.slice(2):id;
export function affectedStorylines(plan:StatefulStorylinePlan,keys:readonly string[]) {
 const selected=new Set(keys);
 return plan.storylines.flatMap((line,storylineIndex)=>{
  const affectedBeatKeys=line.steps.filter(s=>selected.has(s.beatKey)).map(s=>s.beatKey);
  return affectedBeatKeys.length?[{storylineIndex,endingId:line.endingId,affectedBeatKeys}]:[];
 });
}

/** Complete reachable-state evidence, including routes recombined at shared scenes. No LLM inference. */
export function analyzeStoryExecution(model:SymbolicModel,plan:StatefulStorylinePlan) {
 const verification=verifySymbolicModel(model);
 if(verification.status!=='pass')throw new Error('Execution analysis requires complete verification: '+verification.status);
 const executionKey=(from:string,to:string,before:SymbolicState,after:SymbolicState)=>JSON.stringify([from,to,stateKey(before),stateKey(after)]);
 const authored=new Set<string>();
 const routes=plan.storylines.map((line,storylineIndex)=>{
  let configuration={situationId:model.draft.startSituationId,state:createSymbolicState(model.approval.contract,model.draft)};
  let choices=0;
  const visits=[...line.steps.map(s=>'s_'+s.beatKey),'s_end_'+line.endingId].map(target=>{
   const edge=model.draft.transitions.find(t=>t.from===configuration.situationId&&t.to===target);
   const result=edge&&tryTransition(model,configuration,edge.id);
   if(!edge||!result||!result.ok)throw new Error('Blocked authored route '+storylineIndex+' at '+target);
   if(eventOptions(configuration).length>1)choices++;
   const before=configuration;
   configuration=result.configuration;
   authored.add(executionKey(before.situationId,target,before.state,configuration.state));
   return {sceneKey:sceneKey(target),fromSceneKey:sceneKey(before.situationId),before:namedState(before.state),after:namedState(configuration.state),symbolicAfter:configuration.state};
  });
  return {storylineIndex,endingId:line.endingId,choices,visits};
 });
 const terminalIds=new Set(model.draft.situations.filter(s=>s.endingId).map(s=>s.id));
 function eventOptions(c:SymbolicConfiguration) {
  return getEnabledTransitions(model,c).filter(t=>!model.draft.situations.find(s=>s.id===t.to)?.endingId);
 }
 const choiceConfigurations=verification.configurations.flatMap(configuration=>{
  const options=eventOptions(configuration);
  if(options.length<2)return [];
  const next=options.map(t=>{const result=tryTransition(model,configuration,t.id);if(!result.ok)throw new Error(result.reason);return {sceneKey:sceneKey(t.to),state:result.configuration.state};});
  return [{sceneKey:sceneKey(configuration.situationId),state:namedState(configuration.state),optionSceneKeys:next.map(n=>n.sceneKey),distinctImmediateStates:new Set(next.map(n=>stateKey(n.state))).size}];
 });
 const additionalExecutions=verification.configurations.flatMap(configuration=>{
  if(classifyTerminal(model,configuration).status!=='nonterminal')return [];
  return getEnabledTransitions(model,configuration).flatMap(t=>{
   const result=tryTransition(model,configuration,t.id);if(!result.ok)throw new Error(result.reason);
   if(authored.has(executionKey(t.from,t.to,configuration.state,result.configuration.state)))return [];
   return [{fromSceneKey:sceneKey(t.from),sceneKey:sceneKey(t.to),before:namedState(configuration.state),after:namedState(result.configuration.state)}];
  });
 });
 const sharedSceneKeys=model.draft.situations.filter(s=>!terminalIds.has(s.id)&&new Set(model.draft.transitions.filter(t=>t.to===s.id).map(t=>t.from)).size>1).map(s=>sceneKey(s.id));
 const sharedSceneContexts=sharedSceneKeys.map(key=>({sceneKey:key,states:verification.configurations.filter(c=>sceneKey(c.situationId)===key).map(c=>namedState(c.state))}));
 const memo=new Map<string,number>(),active=new Set<string>();
 function depth(c:SymbolicConfiguration):number {
  const key=configurationKey(c);if(memo.has(key))return memo.get(key)!;
  if(active.has(key))throw new Error('Cyclic graph is outside storyline analysis');
  if(classifyTerminal(model,c).status!=='nonterminal')return 0;
  active.add(key);
  const children=getEnabledTransitions(model,c).map(t=>{const result=tryTransition(model,c,t.id);if(!result.ok)throw new Error(result.reason);return depth(result.configuration);});
  const value=(eventOptions(c).length>1?1:0)+Math.max(0,...children);
  active.delete(key);memo.set(key,value);return value;
 }
 // Count complete executable choice sequences, including combinations produced by
 // reconvergence. Authored storyline rows alone undercount these paths.
 const counts=new Map<string,Record<string,number>>(),counting=new Set<string>();let pathCountCapped=false;
 const cap=1_000_000;
 function pathCounts(c:SymbolicConfiguration):Record<string,number>{
  const key=configurationKey(c),saved=counts.get(key);if(saved)return saved;
  if(counting.has(key))throw new Error('Cyclic graph is outside storyline analysis');
  const terminal=model.draft.situations.find(s=>s.id===c.situationId)?.endingId;
  if(terminal)return {[terminal]:1};
  counting.add(key);const result:Record<string,number>=Object.create(null);
  for(const t of getEnabledTransitions(model,c)){
   const next=tryTransition(model,c,t.id);if(!next.ok)throw new Error(next.reason);
   for(const [ending,count] of Object.entries(pathCounts(next.configuration))){const total=(result[ending]??0)+count;if(total>cap)pathCountCapped=true;result[ending]=Math.min(cap,total);}
  }
  counting.delete(key);counts.set(key,result);return result;
 }
 const executablePathsPerEnding=pathCounts({situationId:model.draft.startSituationId,state:createSymbolicState(model.approval.contract,model.draft)});
 return {routes,additionalExecutions,sharedSceneContexts,choiceConfigurations,metrics:{
  approvedRoutes:plan.storylines.length,reachableConfigurations:verification.exploredConfigurations,
  enabledChoiceNodes:new Set(choiceConfigurations.map(c=>c.sceneKey)).size,
  choiceConfigurations:choiceConfigurations.length,
  immediateStateDistinctChoiceConfigurations:choiceConfigurations.filter(c=>c.distinctImmediateStates>1).length,
  sharedEventNodes:sharedSceneKeys.length,
  maxChoicesOnAuthoredRoute:Math.max(0,...routes.map(r=>r.choices)),
  maxChoicesOnExecutablePath:depth({situationId:model.draft.startSituationId,state:createSymbolicState(model.approval.contract,model.draft)}),
  additionalExecutions:additionalExecutions.length,
  executablePathsPerEnding,executablePaths:Object.values(executablePathsPerEnding).reduce((a,b)=>a+b,0),pathCountCapped,
 }};
}
