import type {ChapterGameplay} from './chapter-gameplay.js';
import type {Comparison} from './symbolic-graph.js';
import {symbolicAtomKey} from './playtest/symbolic-engine.js';
import {createGameplaySession,receiveGameplaySignal,requestEventEnd,requestEventStart,startEventBlocker,gameplayEnding,type GameplaySession} from './playtest/chapter-playtest-runtime.js';

export const RESULT_BRANCH_POLICY='existing-symbol-results-v1' as const;
export type BranchLinkChange={from:string;to:string;conditions:Comparison[]};
export type BranchLinkReport={changes:BranchLinkChange[];skipped:{from:string;reason:string}[]};

/** No text guessing or new facts: a value required by EVERY reachable ending,
 * and never written in the entire suffix, must already hold at suffix entry.
 * Only Boolean atoms affected by gameplay at this fork are candidates. */
export function resultBranchCandidates(chapter:ChapterGameplay,from:string):BranchLinkChange[]{
  const source=chapter.events.find(e=>e.id===from);
  if(!source||source.exits.length<2)return [];
  const byId=new Map(chapter.events.map(e=>[e.id,e]));
  const refs=new Map(source.signals.flatMap(s=>s.effects.filter(e=>e.op==='set'&&typeof e.value==='boolean').map(e=>[symbolicAtomKey(e.ref),e.ref] as const)));
  return source.exits.flatMap(exit=>{
    const visited=new Set<string>(),active=new Set<string>(),writes=new Set<string>(),endings:string[]=[];
    let unsafe=false;
    const visit=(id:string)=>{
      if(active.has(id)){unsafe=true;return;}
      if(visited.has(id))return;
      const event=byId.get(id);
      if(!event||id===from){unsafe=true;return;}
      visited.add(id);active.add(id);
      if(event.endingId)endings.push(event.endingId);
      else if(!event.exits.length)unsafe=true;
      for(const s of event.signals)for(const e of s.effects)writes.add(symbolicAtomKey(e.ref));
      for(const next of event.exits)visit(next.to);
      active.delete(id);
    };
    visit(exit.to);
    if(unsafe||!endings.length)return [];
    const conditions:Comparison[]=[];
    for(const [key,ref]of refs){
      if(writes.has(key))continue;
      const values=endings.map(id=>{
        const constraints=chapter.endings.find(e=>e.endingId===id)?.condition.all.filter(c=>symbolicAtomKey(c.ref)===key&&c.op==='eq'&&typeof c.value==='boolean')??[];
        return constraints.length===1?constraints[0]!.value:undefined;
      });
      const value=values[0];
      if(typeof value!=='boolean'||!values.every(v=>v===value))continue;
      const target=byId.get(exit.to)!;
      if([...exit.condition.all,...target.entryCondition.all].some(c=>symbolicAtomKey(c.ref)===key&&c.op==='eq'&&c.value===value))continue;
      conditions.push({ref,op:'eq',value});
    }
    return conditions.length?[{from,to:exit.to,conditions}]:[];
  });
}

export type AuthoredGameplayRoute={ids:string[];endingId:string};
function unwrap(result:ReturnType<typeof requestEventStart>):GameplaySession{
  if(!result.ok)throw new Error(result.reason);
  return result.session;
}

/** Real interactive lifecycle, not only the legacy single-edge witness player. */
export function replayResultBranchRoutes(chapter:ChapterGameplay,routes:AuthoredGameplayRoute[]):Map<string,GameplaySession[]>{
  const visits=new Map<string,GameplaySession[]>();
  for(const route of routes){
    let session=unwrap(requestEventStart(chapter,createGameplaySession(chapter),chapter.events.find(e=>e.id===route.ids[0])!.startTrigger));
    for(const targetId of route.ids.slice(1)){
      const source=chapter.events.find(e=>e.id===session.activeEventId)!;
      visits.set(source.id,[...(visits.get(source.id)??[]),session]);
      const exit=source.exits.find(e=>e.to===targetId);
      if(!exit)throw new Error('Authored route is not connected');
      session=unwrap(receiveGameplaySignal(chapter,session,exit.requiredSignal));
      session=unwrap(requestEventEnd(chapter,session,source.id));
      session=unwrap(requestEventStart(chapter,session,chapter.events.find(e=>e.id===targetId)!.startTrigger));
    }
    if(gameplayEnding(chapter,session)!==route.endingId)throw new Error('Authored ending changed');
  }
  return visits;
}

/** Explore ALL permitted action orders at the fork, including zero actions.
 * Bound work explicitly; uncertainty rolls back this fork, never generation. */
function checkActionOrders(before:ChapterGameplay,after:ChapterGameplay,from:string,starts:GameplaySession[]){
  const source=after.events.find(e=>e.id===from)!;
  const queue=[...starts],seen=new Set<string>();
  while(queue.length){
    const session=queue.shift()!;
    const key=JSON.stringify([Object.entries(session.state).sort(),session.receipts.map(r=>r.signalId).sort(),session.lockedSymbols]);
    if(seen.has(key))continue;
    seen.add(key);
    if(seen.size>256)throw new Error('Action combination budget exceeded');
    const ended=unwrap(requestEventEnd(after,session,from));
    const oldOpen=source.exits.some(e=>!startEventBlocker(before,ended,e.to));
    const newOpen=source.exits.some(e=>!startEventBlocker(after,ended,e.to));
    if(oldOpen&&!newOpen)throw new Error('No successor after a permitted action combination');
    for(const signal of source.signals){
      const result=receiveGameplaySignal(after,session,signal.id);
      if(result.ok)queue.push(result.session);
    }
  }
}

export function linkResultBranches(base:ChapterGameplay,routes:AuthoredGameplayRoute[],verify:(candidate:ChapterGameplay)=>void=()=>{}):{chapter:ChapterGameplay;report:BranchLinkReport}{
  let current=structuredClone(base);
  const report:BranchLinkReport={changes:[],skipped:[]};
  // The pass only adds guards. It never rewrites prose, topology, facts or effects.
  for(const source of base.events.filter(e=>e.exits.length>1)){
    const changes=resultBranchCandidates(base,source.id);
    if(!changes.length)continue;
    const candidate=structuredClone(current),event=candidate.events.find(e=>e.id===source.id)!;
    try{
      for(const change of changes){
        const exit=event.exits.find(e=>e.to===change.to)!;
        exit.condition={all:[...exit.condition.all,...change.conditions]};
        const signal=event.signals.find(s=>s.id===exit.requiredSignal);
        if(!signal)throw new Error('Missing gameplay signal');
        // Do not gate an action on the very result it is about to produce.
        for(const condition of change.conditions){
          if(!signal.effects.some(e=>symbolicAtomKey(e.ref)===symbolicAtomKey(condition.ref))&&!signal.condition.all.some(c=>JSON.stringify(c)===JSON.stringify(condition)))signal.condition={all:[...signal.condition.all,condition]};
        }
      }
      verify(candidate);
      const visits=replayResultBranchRoutes(candidate,routes);
      checkActionOrders(current,candidate,source.id,visits.get(source.id)??[]);
      current=candidate;report.changes.push(...changes);
    }catch(error){report.skipped.push({from:source.id,reason:String(error)});}
  }
  return {chapter:current,report};
}
