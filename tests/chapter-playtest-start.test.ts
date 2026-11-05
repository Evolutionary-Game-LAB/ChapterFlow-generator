import {describe,it,expect} from 'vitest';
import type {ChapterGameplay} from '../src/chapter-gameplay';
import {beginChapterPlaytest} from '../src/playtest/chapter-playtest-start';
const ref={symbol:'known',args:[]};
const fixture=():ChapterGameplay=>({format:'chapter-gameplay-v1',startEventId:'start',initialState:[{ref,value:false}],endings:[],events:[
 {id:'start',startTrigger:'start:start',entryCondition:{all:[]},endingId:null,signals:[],exits:[{to:'a',requiredSignal:'entry',condition:{all:[]}}]},
 {id:'a',startTrigger:'start:a',entryCondition:{all:[]},endingId:null,signals:[],exits:[]},
]});
describe('playtest entry after preparation',()=>{
 it('passes the empty generated start gate and enters the actual first event without changing the chapter',()=>{
  const c=fixture(),before=structuredClone(c),result=beginChapterPlaytest(c);
  expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.session.activeEventId).toBe('a');expect(result.session.completedEvents).toEqual(['start']);
  expect(result.notifications.map(n=>n.type)).toEqual(['event-started','event-ended','event-started']);expect(c).toEqual(before);
 });
 it('does not bypass the first event entry condition',()=>{
  const c=fixture();c.events[1].entryCondition={all:[{ref,op:'eq',value:true}]};expect(beginChapterPlaytest(c).ok).toBe(false);
 });
 it('keeps an authored playable start with effects instead of silently executing it',()=>{
  const c=fixture();c.events[0].signals=[{id:'change',label:'변경',condition:{all:[]},effects:[{ref,op:'set',value:true}],oncePerVisit:true}];
  const result=beginChapterPlaytest(c);expect(result.ok).toBe(true);if(result.ok)expect(result.session.activeEventId).toBe('start');
 });
 it('does not choose arbitrarily between multiple start branches',()=>{
  const c=fixture();c.events[0].exits.push({to:'b',requiredSignal:'b',condition:{all:[]}});
  const result=beginChapterPlaytest(c);if(!result.ok)throw Error(result.reason);expect(result.session.activeEventId).toBe('start');
 });
});
