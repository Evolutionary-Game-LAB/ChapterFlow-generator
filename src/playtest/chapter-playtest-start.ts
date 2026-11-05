import type {ChapterGameplay} from '../chapter-gameplay.js';
import {createGameplaySession,requestEventStart,requestEventEnd,type GameplayResult} from './chapter-playtest-runtime.js';

/** The generated synthetic start is an empty entry gate, not a playable scene. */
export function hasEmptyStartGate(chapter:ChapterGameplay):boolean{
 const start=chapter.events.find(e=>e.id===chapter.startEventId);
 return start?.id==='start'&&!start.endingId&&start.exits.length===1&&start.signals.every(s=>s.effects.length===0);
}
export function beginChapterPlaytest(chapter:ChapterGameplay):GameplayResult{
 const start=chapter.events.find(e=>e.id===chapter.startEventId);
 if(!start)return {ok:false,reason:'챕터의 시작 사건이 없습니다.'};
 const opened=requestEventStart(chapter,createGameplaySession(chapter),start.startTrigger);
 if(!opened.ok||!hasEmptyStartGate(chapter))return opened;
 const ended=requestEventEnd(chapter,opened.session,start.id);
 if(!ended.ok)return ended;
 const next=chapter.events.find(e=>e.id===start.exits[0]!.to);
 if(!next)return {ok:false,reason:'첫 사건을 찾을 수 없습니다.'};
 const entered=requestEventStart(chapter,ended.session,next.startTrigger);
 if(!entered.ok)return entered;
 return {...entered,notifications:[...opened.notifications,...ended.notifications,...entered.notifications]};
}
