import type {ChapterGameplay} from './chapter-gameplay.js';
import type {StatefulStorylinePlan} from './stateful-storyline-plan.js';
import type {ChapterFactSemantics} from './chapter-fact-semantics.js';
import type {Story} from './schema.js';
import {StatefulPlanError} from './stateful-storyline.js';
import {symbolicAtomKey,evaluateGuard} from './playtest/symbolic-engine.js';
import type {Guard} from './symbolic-graph.js';
import type {AtomRef} from './symbolic-graph.js';
import {createGameplaySession,requestEventStart,requestEventEnd,receiveGameplaySignal,startEventBlocker,gameplayEnding,type GameplaySession,type GameplayResult} from './playtest/chapter-playtest-runtime.js';
const unwrap=(r:GameplayResult)=>{if(!r.ok)throw Error(r.reason);return r.session;};
export type CrossAdmissionWitness={from:string;to:string;expectedSignal:string;performedSignals:string[];priorEvents:string[];state:GameplaySession['state']};
type UnmetCondition={fact:string;args:string[];op:string;required:boolean|number;actual:boolean|number|undefined};
export class StoryFirstDeadEnd extends Error{
  related:StoryFirstDeadEnd[]=[];
  constructor(readonly eventId:string,readonly state:GameplaySession['state'],readonly entryState:GameplaySession['state']=state,readonly witness?:{completedEvents:string[];performedSignals:string[];blockedExits:Array<{to:string;reason:string|null;unmetSourceConditions?:UnmetCondition[];unmetEntryConditions?:UnmetCondition[]}>;blockedPlays?:Array<{id:string;label:string;unmetConditions:UnmetCondition[]}>}){
    super('허용 플레이 조합 후 진행 불가: '+eventId+' '+JSON.stringify(state));
  }
}
export class StoryFirstHistoryReversal extends Error{
  constructor(readonly eventId:string,readonly signalId:string,readonly label:string,readonly fact:AtomRef){
    super('다른 행동 조합에서 완료 이력 번복: '+JSON.stringify({eventId,signalId,label,fact,before:true,after:false}));
  }
}
/** Explore permitted action orders and separate end/start commands. No LLM judge can bypass this. */
export function auditStoryFirstGameplay(chapter:ChapterGameplay,plan:StatefulStorylinePlan,semantics:Record<string,ChapterFactSemantics>,collectFailures=false){
  const initial=unwrap(requestEventStart(chapter,createGameplaySession(chapter),chapter.events.find(e=>e.id===chapter.startEventId)!.startTrigger));
  const forks:Array<{from:string;to:string;before:boolean;after:boolean;changes:number}>=[];
  for(const [storylineIndex,line] of plan.storylines.entries()){
    let s=initial;
    for(const id of [...line.steps.map(x=>x.beatKey),'end_'+line.endingId]){
      const e=chapter.events.find(e=>e.id===s.activeEventId)!;
      const exit=e.exits.find(x=>x.to===id);if(!exit)throw Error('누락된 실행 경로');
      const before=!startEventBlocker(chapter,unwrap(requestEventEnd(chapter,s,e.id)),id);
      const accept=(result:GameplayResult,phase:string)=>{
        if(result.ok)return result.session;
        if(!collectFailures)throw Error(result.reason);
        throw new StatefulPlanError('blocked-storyline',{storylineIndex,phase,eventId:e.id,targetEventId:id,
          signalId:exit.requiredSignal,reason:result.reason,
          configuration:{situationId:'s_'+e.id,state:s.state},
          completedEvents:[...s.completedEvents],performedSignals:s.receipts.map(r=>r.signalId),
          requiredEnding:chapter.endings.find(end=>end.endingId===line.endingId),
          sourcePlay:e.signals.find(play=>play.id===exit.requiredSignal),
          destination:chapter.events.find(target=>target.id===id),
          interpretation:'This route was replayed with the REAL source-owned gameplay, explicit end and independent conditional start. Its preceding steps and plays actually succeeded. Repair this exact failing play/start; do not use the older single-transition model to infer admission.'});
      };
      s=accept(receiveGameplaySignal(chapter,s,exit.requiredSignal),'play');s=accept(requestEventEnd(chapter,s,e.id),'end');
      const after=!startEventBlocker(chapter,s,id);
      if(e.exits.length>1)forks.push({from:e.id,to:id,before,after,changes:e.signals.find(x=>x.id===exit.requiredSignal)!.effects.length});
      s=accept(requestEventStart(chapter,s,chapter.events.find(x=>x.id===id)!.startTrigger),'start');
    }
    if(gameplayEnding(chapter,s)!==line.endingId)throw Error('플레이 테스트 결말 불일치');
  }
  const beforePlays=new Map<string,Map<string,Set<boolean|number>>>();
  const entryValues=new Map<string,Map<string,Set<boolean|number>>>();
  // Concrete correlated states supplement marginal value sets for semantic
  // review. These are bounded examples, not an exhaustive proof of prose.
  const entryWitnesses:Record<string,GameplaySession['state'][]>={},beforePlayWitnesses:Record<string,GameplaySession['state'][]>={};
  const witness=(target:typeof entryWitnesses,key:string,state:GameplaySession['state'])=>{
    const states=target[key]??(target[key]=[]);
    if(states.length<6&&!states.some(s=>JSON.stringify(s)===JSON.stringify(state)))states.push(state);
  };
  const noteEntry=(s:GameplaySession)=>{
    witness(entryWitnesses,s.activeEventId!,s.state);
    let values=entryValues.get(s.activeEventId!);if(!values){values=new Map();entryValues.set(s.activeEventId!,values);}
    for(const [atom,value] of Object.entries(s.state)){let seen=values.get(atom);if(!seen){seen=new Set();values.set(atom,seen);}seen.add(value);}
  };
  noteEntry(initial);
  const crossAdmissionGroups=new Map<string,CrossAdmissionWitness[]>();
  const queue:Array<{session:GameplaySession;entryState:GameplaySession['state']}>=[{session:initial,entryState:initial.state}],seen=new Set<string>(),endings=new Set<string>();
  const deadEnds:StoryFirstDeadEnd[]=[];
  while(queue.length){
    const {session:s,entryState}=queue.shift()!;
    const key=JSON.stringify([s.activeEventId,Object.entries(s.state).sort(),s.receipts.map(r=>r.signalId).sort()]);
    if(seen.has(key))continue;seen.add(key);if(seen.size>12000)throw Error('플레이 조합 검사 한도 초과');
    const e=chapter.events.find(e=>e.id===s.activeEventId)!;
    if(e.endingId){const ending=gameplayEnding(chapter,s);if(!ending)throw Error('모순된 결말');endings.add(ending);continue;}
    let moves=0;
    for(const action of e.signals){
      const r=receiveGameplaySignal(chapter,s,action.id);if(!r.ok)continue;
      for(const effect of action.effects){const k=symbolicAtomKey(effect.ref);if(semantics[effect.ref.symbol]?.scope==='history'&&s.state[k]===true&&r.session.state[k]===false)throw new StoryFirstHistoryReversal(e.id,action.id,action.label,effect.ref);}
      const playKey=e.id+':'+action.id;
      witness(beforePlayWitnesses,playKey,s.state);
      let values=beforePlays.get(playKey);if(!values){values=new Map();beforePlays.set(playKey,values);}
      for(const [atom,value] of Object.entries(s.state)){let observed=values.get(atom);if(!observed){observed=new Set();values.set(atom,observed);}observed.add(value);}
      moves++;queue.push({session:r.session,entryState});
    }
    const ended=unwrap(requestEventEnd(chapter,s,e.id));
    for(const exit of e.exits){const r=requestEventStart(chapter,ended,chapter.events.find(x=>x.id===exit.to)!.startTrigger);if(r.ok){
      moves++;noteEntry(r.session);queue.push({session:r.session,entryState:r.session.state});
      const expected=e.signals.find(a=>a.id===exit.requiredSignal);
      // Equivalent actions are allowed to establish the same outcome. Record
      // actual counterexamples to method-specific prose, NEVER make these a
      // symbolic failure or require an artificial action receipt/route flag.
      if(expected?.effects.length&&!s.receipts.some(p=>p.signalId===expected.id)){
        // Zero-effect choices/travel are completed at their explicit external
        // start-trigger boundary, not proved by a no-op button receipt here.
        const performedSignals=s.receipts.filter(p=>e.signals.some(a=>a.id===p.signalId&&a.effects.length)).map(p=>p.signalId),groupKey=JSON.stringify([e.id,exit.to]);
        const group=crossAdmissionGroups.get(groupKey)??[];
        // Representative concrete witnesses, not an exhaustive prose proof.
        // Runtime reachability exploration itself remains exhaustive.
        if(group.length<3&&!group.some(w=>JSON.stringify(w.performedSignals)===JSON.stringify(performedSignals))){
          group.push({from:e.id,to:exit.to,expectedSignal:expected.id,performedSignals,priorEvents:[...s.completedEvents],state:s.state});
          crossAdmissionGroups.set(groupKey,group);
        }
      }
    }}
    if(!moves){
      const unmet=(guard:Guard):UnmetCondition[]=>guard.all.filter(c=>!evaluateGuard(s.state,{all:[c]})).map(c=>{
        const value=s.state[symbolicAtomKey(c.ref)];
        return {fact:c.ref.symbol,args:c.ref.args,op:c.op,required:c.value,actual:typeof value==='number'?value/100:value};
      });
      const dead=new StoryFirstDeadEnd(e.id,s.state,entryState,{completedEvents:[...s.completedEvents],performedSignals:s.receipts.map(r=>r.signalId),
        blockedPlays:e.signals.map(p=>({id:p.id,label:p.label,unmetConditions:unmet(p.condition)})),
        blockedExits:e.exits.map(exit=>({to:exit.to,reason:startEventBlocker(chapter,ended,exit.to)??null,unmetSourceConditions:unmet(exit.condition),unmetEntryConditions:unmet(chapter.events.find(target=>target.id===exit.to)!.entryCondition)}))});
      if(!collectFailures)throw dead;
      deadEnds.push(dead);
    }
  }
  if(deadEnds.length){const first=deadEnds[0]!;first.related=deadEnds.slice(1,8);throw first;}
  if(endings.size!==chapter.endings.length)throw Error('실행 가능한 결말 누락');
  const flatten=(source:typeof beforePlays)=>Object.fromEntries([...source].map(([key,values])=>[key,Object.fromEntries([...values].map(([atom,observed])=>[atom,[...observed]]))]));
  return {routes:plan.storylines.length,endings:[...endings],configurations:seen.size,forks,crossAdmissions:[...crossAdmissionGroups.values()].flat(),reachableEntries:flatten(entryValues),reachableBeforePlays:flatten(beforePlays),entryWitnesses,beforePlayWitnesses};
}

/** Human/model evidence only: do not mutate eligibility from method wording. */
export function storyAdmissionEvidence(story:Story,witnesses:CrossAdmissionWitness[],sourceIds?:readonly string[]){
  return witnesses.filter(w=>!sourceIds||sourceIds.includes(w.from)).map(w=>{
    const source=story.gameplay!.events.find(e=>e.id===w.from)!;
    const describe=(signalId:string)=>{
      const signal=source.signals.find(s=>s.id===signalId)!;
      const to=source.exits.find(e=>e.requiredSignal===signalId)?.to;
      return {label:signal.label,completedGameplay:story.symbolic!.eventAuthoring!.actions.find(a=>a.from===w.from&&a.to===to)?.description,changes:signal.effects};
    };
    return {from:w.from,to:w.to,priorEvents:w.priorEvents,actuallyPerformed:w.performedSignals.map(describe),
      unperformedAssociatedPlay:describe(w.expectedSignal),
      admittedSituation:(story.symbolic!.details.scenes[w.to] as {summary?:string}|undefined)?.summary,
      resultingState:w.state};
  });
}
