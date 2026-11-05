import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {ChapterGameplay, GameplayEvent} from '../src/chapter-gameplay';
import {parseStory, serializeStory} from '../src/import-export/story-json';
import {symbolicAtomKey} from '../src/playtest/symbolic-engine';
import {replayGameplayRoute} from '../src/playtest/chapter-gameplay-runtime';
import {createGameplaySession, gameplayEnding, receiveGameplaySignal, requestEventStart, requestEventEnd, startEventBlocker, requestNextEvent, nextEventBlocker, type GameplayResult} from '../src/playtest/chapter-playtest-runtime';

const ref={symbol:'known',args:[]}, other={symbol:'ready',args:[]}, key=symbolicAtomKey(ref);
const guard=(value:boolean)=>({all:[{ref,op:'eq' as const,value}]});
const empty={all:[]};
const event=(id:string):GameplayEvent=>({id,startTrigger:`start:${id}`,entryCondition:empty,endingId:null,signals:[],exits:[]});
function fixture():ChapterGameplay {
 return {format:'chapter-gameplay-v1',startEventId:'a',initialState:[{ref,value:false},{ref:other,value:false}],endings:[],events:[
  {...event('a'),signals:[
   {id:'learn',label:'발견',condition:guard(false),effects:[{ref,op:'set',value:true}],oncePerVisit:true},
   {id:'alternate',label:'다른 방식으로 발견',condition:guard(false),effects:[{ref,op:'set',value:true}],oncePerVisit:true},
  ],exits:[{to:'b',requiredSignal:'learn',condition:guard(true)},{to:'c',requiredSignal:'unused',condition:guard(true)}]},
  event('b'),event('c'),event('unconnected'),
 ]};
}
const ok=(result:GameplayResult)=>{expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);return result.session};
const started=(c:ChapterGameplay)=>ok(requestEventStart(c,createGameplaySession(c),'start:a'));

describe('interactive chapter lifecycle, independent of generation witness replay',()=>{
 it('executes bundled symbols independently, preserving guards and the saved chapter',()=>{
  const c=fixture(),otherKey=symbolicAtomKey(other),before=structuredClone(c);
  c.events[0].signals[0].effects.push({ref:other,op:'set',value:true});
  const original=structuredClone(c),s=started(c);
  const first=ok(receiveGameplaySignal(c,s,'learn',key));
  expect(first.state[key]).toBe(true);expect(first.state[otherKey]).toBe(false);
  expect(receiveGameplaySignal(c,first,'learn',key).ok).toBe(false);
  const second=ok(receiveGameplaySignal(c,first,'learn',otherKey));
  expect(second.state[otherKey]).toBe(true);
  expect(receiveGameplaySignal(c,second,'learn').ok).toBe(false);
  expect(c).toEqual(original);expect(s.state[key]).toBe(false);
  expect(receiveGameplaySignal(c,s,'learn','unknown').ok).toBe(false);
  expect(receiveGameplaySignal(before,s,'learn',otherKey).ok).toBe(false);
 });
 it('does not repeat a numeric increment when dialogue completes a partially executed bundle',()=>{
  const c=fixture(),otherKey=symbolicAtomKey(other);
  c.initialState[0].value=0.2;
  c.events[0].signals[0]={id:'learn',label:'복합 행동',oncePerVisit:true,condition:empty,effects:[{ref,op:'add',value:0.1},{ref:other,op:'set',value:true}]};
  const first=ok(receiveGameplaySignal(c,started(c),'learn',key));
  expect(first.state[key]).toBe(30);expect(first.state[otherKey]).toBe(false);
  const next=ok(receiveGameplaySignal(c,first,'learn'));
  expect(next.state[key]).toBe(30);expect(next.state[otherKey]).toBe(true);
 });
 it('keeps unrelated guards and irreversibility checks for per-symbol execution',()=>{
  const c=fixture();c.events[0].signals[0].condition={all:[{ref:other,op:'eq',value:true}]};
  expect(receiveGameplaySignal(c,started(c),'learn',key).ok).toBe(false);
  c.events[0].signals[0].condition=empty;
  c.addedSymbols=[{ref,name:'지식',meaning:'지식',type:'boolean',initial:false,changeMode:'irreversible'}];
  const first=ok(receiveGameplaySignal(c,started(c),'learn',key));
  c.events[0].signals.push({id:'undo',label:'취소',condition:empty,effects:[{ref,op:'set',value:false}],oncePerVisit:false});
  expect(receiveGameplaySignal(c,first,'undo',key).ok).toBe(false);
 });
 it('previews admission while active, then atomically ends and starts without changing symbols',()=>{
  const c=fixture(),s=ok(receiveGameplaySignal(c,started(c),'alternate')),before=structuredClone(s);
  expect(nextEventBlocker(c,s,'b')).toBeUndefined();
  expect(nextEventBlocker(c,s,'c')).toBeUndefined();
  expect(s).toEqual(before);
  const result=requestNextEvent(c,s,'b'),next=ok(result);
  expect(next.activeEventId).toBe('b');expect(next.completedEvents).toEqual(['a']);
  expect(next.state).toEqual(s.state);expect(next.receipts).toEqual([]);expect(s).toEqual(before);
  if(result.ok)expect(result.notifications).toEqual([{type:'event-ended',id:'a'},{type:'event-started',id:'b'}]);
 });
 it('keeps the active event and receipts on blocked or disconnected transitions',()=>{
  const c=fixture(),s=started(c),before=structuredClone(s);
  expect(nextEventBlocker(c,s,'b')).toContain('진입 조건');
  expect(requestNextEvent(c,s,'b').ok).toBe(false);
  expect(requestNextEvent(c,s,'unconnected').ok).toBe(false);
  expect(requestNextEvent(c,s,'missing').ok).toBe(false);
  expect(s).toEqual(before);
 });
 it('does not require a no-effect progress signal and still respects destination guards',()=>{
  const c=fixture();c.events[0].signals=[{id:'continue',label:'이동',condition:empty,effects:[],oncePerVisit:true}];
  c.events[0].exits=[{to:'b',requiredSignal:'continue',condition:empty}];
  const s=started(c);expect(ok(requestNextEvent(c,s,'b')).activeEventId).toBe('b');
  c.events[1].entryCondition=guard(true);
  expect(requestNextEvent(c,s,'b').ok).toBe(false);expect(s.activeEventId).toBe('a');
 });
 it('requires a first start and does not apply state effects on start',()=>{
  const c=fixture(),s=createGameplaySession(c);
  expect(receiveGameplaySignal(c,s,'learn').ok).toBe(false);
  expect(requestEventEnd(c,s,'a').ok).toBe(false);
  expect(requestEventStart(c,s,'start:b').ok).toBe(false);
  const next=ok(requestEventStart(c,s,'start:a'));
  expect(next.state).toBe(s.state);expect(next.completedEvents).toEqual([]);
 });
 it('applies a valid action even when its linked target is blocked',()=>{
  const c=fixture();c.events[1].entryCondition={all:[{ref:other,op:'eq',value:true}]};
  const s=started(c),before=structuredClone(c),next=ok(receiveGameplaySignal(c,s,'learn'));
  expect(next.state[key]).toBe(true);expect(s.state[key]).toBe(false);
  expect(next.activeEventId).toBe('a');expect(next.completedEvents).toEqual([]);
  expect(c).toEqual(before);
  const ended=ok(requestEventEnd(c,next,'a'));
  expect(requestEventStart(c,ended,'start:b').ok).toBe(false);
  expect(ended.activeEventId).toBeNull();expect(ended.state[key]).toBe(true);
 });
 it('requires explicit end, then starts without sending any end notification',()=>{
  const c=fixture(),s=ok(receiveGameplaySignal(c,started(c),'learn'));
  expect(startEventBlocker(c,s,'b')).toContain('종료');
  expect(requestEventStart(c,s,'start:b').ok).toBe(false);
  const end=requestEventEnd(c,s,'a'),ended=ok(end);
  expect(ended.state).toBe(s.state);expect(ended.activeEventId).toBeNull();
  expect(ended.lastCompletedEventId).toBe('a');expect(ended.completedEvents).toEqual(['a']);
  if(end.ok)expect(end.notifications).toEqual([{type:'event-ended',id:'a'}]);
  expect(receiveGameplaySignal(c,ended,'learn').ok).toBe(false);
  expect(requestEventEnd(c,ended,'a').ok).toBe(false);
  const start=requestEventStart(c,ended,'start:b'),next=ok(start);
  expect(next.state).toBe(s.state);expect(next.completedEvents).toEqual(['a']);
  if(start.ok)expect(start.notifications).toEqual([{type:'event-started',id:'b'}]);
 });
 it('accepts equivalent state from another action and offers multiple next events',()=>{
  const c=fixture();let s=ok(receiveGameplaySignal(c,started(c),'alternate'));
  expect(s.receipts.some(r=>r.signalId==='learn')).toBe(false);
  s=ok(requestEventEnd(c,s,'a'));
  expect(startEventBlocker(c,s,'b')).toBeUndefined();expect(startEventBlocker(c,s,'c')).toBeUndefined();
  expect(requestEventStart(c,s,'start:unconnected').ok).toBe(false);
  expect(requestEventStart(c,s,'start:unknown').ok).toBe(false);
  const next=ok(requestEventStart(c,s,'start:c'));
  expect(next.activeEventId).toBe('c');expect(requestEventStart(c,next,'start:b').ok).toBe(false);
 });
 it('permits ending with no actions or available successors, with no silent restart',()=>{
  const c=fixture(),s=started(c);
  expect(requestEventEnd(c,s,'b').ok).toBe(false);
  const ended=ok(requestEventEnd(c,s,'a'));
  expect(ended.state).toBe(s.state);
  expect(requestEventStart(c,ended,'start:b').ok).toBe(false);
  expect(requestEventStart(c,ended,'start:a').ok).toBe(false);
  expect(createGameplaySession(c).lastCompletedEventId).toBeNull();
 });
 it('rejects disallowed, duplicate and precondition-blocked actions without mutation',()=>{
  const c=fixture(),s=started(c),before=structuredClone(s);
  expect(receiveGameplaySignal(c,s,'unknown').ok).toBe(false);expect(s).toEqual(before);
  const next=ok(receiveGameplaySignal(c,s,'learn'));
  expect(receiveGameplaySignal(c,next,'learn').ok).toBe(false);
  expect(receiveGameplaySignal(c,next,'alternate').ok).toBe(false);
 });
 it('preserves numeric thresholds, OR entry groups and irreversible locks across end/start',()=>{
  const c=fixture();c.initialState[0].value=.3;
  c.addedSymbols=[{ref,name:'신뢰',meaning:'',type:'number',initial:.3,changeMode:'irreversible'}];
  c.events[0].signals=[{id:'learn',label:'신뢰 증가',condition:empty,effects:[{ref,op:'set',value:.7}],oncePerVisit:false}];
  c.events[0].exits[0].condition={all:[{ref,op:'gte',value:.6}]};
  c.events[1].entryAlternatives=[{all:[{ref,op:'eq',value:.2}]},{all:[{ref,op:'gte',value:.6}]}];
  c.events[1].signals=[{id:'reverse',label:'되돌림',condition:empty,effects:[{ref,op:'set',value:.3}],oncePerVisit:false}];
  let s=ok(receiveGameplaySignal(c,started(c),'learn'));expect(s.state[key]).toBe(70);
  s=ok(requestEventEnd(c,s,'a'));s=JSON.parse(JSON.stringify(s));
  s=ok(requestEventStart(c,s,'start:b'));
  expect(receiveGameplaySignal(c,s,'reverse').ok).toBe(false);expect(s.state[key]).toBe(70);
 });
 it('checks ending ambiguity at start rather than blocking the preceding action',()=>{
  const c=fixture();c.events[1].endingId='known';c.endings=[{endingId:'known',condition:guard(true)},{endingId:'other',condition:guard(true)}];
  let s=ok(receiveGameplaySignal(c,started(c),'learn'));s=ok(requestEventEnd(c,s,'a'));
  expect(requestEventStart(c,s,'start:b').ok).toBe(false);
  c.endings.pop();s=ok(requestEventStart(c,s,'start:b'));
  expect(gameplayEnding(c,s)).toBe('known');s=ok(requestEventEnd(c,s,'b'));
  expect(gameplayEnding(c,s)).toBe('known');expect(requestEventStart(c,s,'start:a').ok).toBe(false);
 });
 it('replays every saved station route to the same ending/state and leaves exported JSON unchanged',()=>{
  const story=parseStory(readFileSync('public/examples/chapterflow-station.json','utf8'));
  const before=serializeStory(story),c=story.gameplay!,plan=story.symbolic!.plan;
  if(!('format' in plan)||plan.format!=='stateful-storylines-v2')throw Error('fixture');
  for(const route of plan.storylines){
   const keys=[c.startEventId,...route.steps.map(s=>s.beatKey),`end_${route.endingId}`];
   let s=ok(requestEventStart(c,createGameplaySession(c),`start:${c.startEventId}`));
   for(const target of keys.slice(1)){
    const e=c.events.find(e=>e.id===s.activeEventId)!;
    const signal=e.signals.find(signal=>signal.id===e.exits.find(exit=>exit.to===target)!.requiredSignal)!;
    if(signal.effects.length)s=ok(receiveGameplaySignal(c,s,signal.id));
    expect(nextEventBlocker(c,s,target)).toBeUndefined();
    s=ok(requestNextEvent(c,s,target));
   }
   expect(gameplayEnding(c,s)).toBe(route.endingId);
   expect(s.state).toEqual(replayGameplayRoute(c,keys).state);
   const ended=ok(requestEventEnd(c,s,s.activeEventId!));
   expect(gameplayEnding(c,ended)).toBe(route.endingId);
  }
  expect(serializeStory(story)).toBe(before);
 });
});
