import type {ChapterGameplay} from '../chapter-gameplay.js';
import type {Guard} from '../symbolic-graph.js';
import {evaluateGuard, symbolicAtomKey} from './symbolic-engine.js';
import {
  createGameplaySession as createBaseSession,
  gameplayEnding as baseEnding,
  receiveGameplaySignal as applyPermittedSignal,
  type GameplayNotification,
  type GameplaySession as BaseSession,
} from './chapter-gameplay-runtime.js';

// Interactive lifecycle. The generation witness replay remains unchanged in
// chapter-gameplay-runtime: exported chapters and generation checks stay intact.
export type GameplaySession = BaseSession & {lastCompletedEventId: string | null};
export type GameplayResult =
  | {ok: true; session: GameplaySession; notifications: GameplayNotification[]}
  | {ok: false; reason: string};

export function createGameplaySession(chapter: ChapterGameplay): GameplaySession {
  return {...createBaseSession(chapter), lastCompletedEventId: null};
}

function satisfied(session: GameplaySession, guard: Guard): boolean {
  try {return evaluateGuard(session.state, guard);} catch {return false;}
}

export function gameplayEnding(chapter: ChapterGameplay, session: GameplaySession): string | undefined {
  return baseEnding(chapter, {...session, activeEventId: session.activeEventId ?? session.lastCompletedEventId});
}

export function startEventBlocker(chapter: ChapterGameplay, session: GameplaySession, targetId: string): string | undefined {
  const target = chapter.events.find(e => e.id === targetId);
  if (!target) return '등록되지 않은 사건입니다.';
  if (session.activeEventId) return '현재 사건을 먼저 종료해 주세요.';
  if (session.lastCompletedEventId) {
    const previous = chapter.events.find(e => e.id === session.lastCompletedEventId);
    if (!previous) return '종료된 사건을 찾을 수 없습니다.';
    if (previous.endingId) return '챕터가 종료되었습니다. 처음부터 다시 플레이해 주세요.';
    const exits = previous.exits.filter(e => e.to === targetId);
    if (!exits.length) return '종료한 사건에서 연결되지 않은 사건입니다.';
    // Keep existing branch predicates, but do not require a particular action
    // receipt. Equivalent permitted actions can establish the same state.
    if (!exits.some(exit => satisfied(session, exit.condition))) return '현재 상태가 다음 사건의 진입 조건을 만족하지 않습니다.';
  } else if (target.id !== chapter.startEventId) return '챕터의 첫 사건부터 시작해 주세요.';
  if (!satisfied(session, target.entryCondition)
    || (target.entryAlternatives && !target.entryAlternatives.some(g => satisfied(session, g)))) return '사건 진입 조건을 만족하지 않습니다.';
  if (target.endingId) {
    const matches = chapter.endings.filter(e => satisfied(session, e.condition));
    if (matches.length !== 1 || matches[0].endingId !== target.endingId) return '결말 조건이 미충족이거나 다른 결말과 충돌합니다.';
  }
  return undefined;
}

export function requestEventStart(chapter: ChapterGameplay, session: GameplaySession, trigger: string): GameplayResult {
  const target = chapter.events.find(e => e.startTrigger === trigger);
  if (!target) return {ok: false, reason: '등록되지 않은 사건 시작 트리거입니다.'};
  const reason = startEventBlocker(chapter, session, target.id);
  if (reason) return {ok: false, reason};
  return {ok: true, session: {...session, activeEventId: target.id, receipts: []}, notifications: [{type: 'event-started', id: target.id}]};
}

export function requestEventEnd(chapter: ChapterGameplay, session: GameplaySession, eventId: string): GameplayResult {
  if (!session.activeEventId) return {ok: false, reason: '진행 중인 사건이 없습니다.'};
  if (session.activeEventId !== eventId || !chapter.events.some(e => e.id === eventId)) return {ok: false, reason: '현재 진행 중인 사건만 종료할 수 있습니다.'};
  // Ending an event is explicit and never gated by a successor or an effect.
  return {ok: true, session: {...session, activeEventId: null, lastCompletedEventId: eventId, receipts: [], completedEvents: [...session.completedEvents, eventId]}, notifications: [{type: 'event-ended', id: eventId}]};
}

/** Web-only convenience: preview on an immutable session, commit both or neither. */
export function requestNextEvent(chapter:ChapterGameplay,session:GameplaySession,targetId:string):GameplayResult{
 const target=chapter.events.find(e=>e.id===targetId);
 if(!target)return {ok:false,reason:'등록되지 않은 사건입니다.'};
 if(!session.activeEventId)return requestEventStart(chapter,session,target.startTrigger);
 const ended=requestEventEnd(chapter,session,session.activeEventId);
 if(!ended.ok)return ended;
 const entered=requestEventStart(chapter,ended.session,target.startTrigger);
 if(!entered.ok)return entered;
 return {...entered,notifications:[...ended.notifications,...entered.notifications]};
}

export function nextEventBlocker(chapter:ChapterGameplay,session:GameplaySession,targetId:string):string|undefined{
 const result=requestNextEvent(chapter,session,targetId);
 return result.ok?undefined:result.reason;
}

export const symbolPlayReceiptId=(signalId:string,key:string)=>`symbol-play:${JSON.stringify([signalId,key])}`;

export function receiveGameplaySignal(chapter: ChapterGameplay, session: GameplaySession, signalId: string, symbolKey?:string): GameplayResult {
  if (!session.activeEventId) return {ok: false, reason: '진행 중인 사건이 없습니다. 사건을 시작해 주세요.'};
  const source=chapter.events.find(e=>e.id===session.activeEventId)?.signals.find(s=>s.id===signalId);
  if(!source)return {ok:false,reason:'현재 사건에서 허용되지 않은 게임플레이 신호입니다.'};
  if(source.oncePerVisit&&session.receipts.some(r=>r.signalId===signalId))return {ok:false,reason:'이미 처리한 신호입니다.'};
  const keys=[...new Set(source.effects.map(e=>symbolicAtomKey(e.ref)))];
  if(symbolKey!==undefined&&!keys.includes(symbolKey))return {ok:false,reason:'이 행동에서 허용되지 않은 심볼입니다.'};
  const completed=new Set(source.oncePerVisit?keys.filter(key=>session.receipts.some(r=>r.signalId===symbolPlayReceiptId(signalId,key))):[]);
  // A partial action may have changed its own precondition. Accept that value
  // only while it still matches its recorded result; keep other guards intact.
  const condition={all:source.condition.all.filter(c=>{
    const key=symbolicAtomKey(c.ref),receipt=session.receipts.find(r=>r.signalId===symbolPlayReceiptId(signalId,key));
    return !(completed.has(key)&&receipt&&receipt.resultingValues[key]===session.state[key]);
  })};
  const id=symbolKey===undefined?signalId:symbolPlayReceiptId(signalId,symbolKey);
  const signal={...source,id,condition,effects:source.effects.filter(e=>symbolKey===undefined?!completed.has(symbolicAtomKey(e.ref)):symbolicAtomKey(e.ref)===symbolKey)};
  // Reuse permission/type/range/irreversibility checks without the legacy
  // successor-admission check. This is a transient view, never a JSON mutation.
  const actionsOnly = {...chapter, events: chapter.events.map(e => e.id === session.activeEventId ? {...e, signals:[signal], exits: []} : e)};
  const result = applyPermittedSignal(actionsOnly, session, id);
  if (!result.ok) return result;
  if(symbolKey!==undefined&&source.oncePerVisit&&keys.every(key=>key===symbolKey||completed.has(key))){
    result.session={...result.session,receipts:[...result.session.receipts,{signalId,resultingValues:Object.fromEntries(keys.map(key=>[key,result.session.state[key]]))}]};
  }
  return {...result, session: {...result.session, lastCompletedEventId: session.lastCompletedEventId}};
}
