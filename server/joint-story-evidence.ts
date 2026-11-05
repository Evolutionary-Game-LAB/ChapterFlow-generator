import type {compileJointStory} from './joint-story-contract.js';
import type {JointMap,JointRule} from './joint-story-contract.js';
import {symbolicAtomKey} from '../src/playtest/symbolic-engine.js';
import {createGameplaySession,startEventBlocker} from '../src/playtest/chapter-playtest-runtime.js';

/** Engine-owned movement is intentionally not another mutable story fact. */
export const externalStartContract='External scene-start contract: for an incoming action with ZERO tracked effects, the game issues the destination start trigger when that authored ordinary travel/choice is carried out. Starting the scene therefore establishes its declared location and that ordinary transition; a prior no-op signal receipt or a visited-room/location Boolean is NOT required. An allowed start without that no-op receipt is not evidence of teleportation or omitted movement. This boundary does NOT grant knowledge, transfer tracked resources, rescue/kill someone, reverse history, or restore unavailable actors/access. Any such consequential change still requires its actual gameplay effect, and real contradictory prior actions or missing access prerequisites must still be reported. For STATE-CHANGING incoming plays, equivalent states may admit the result without the named play; keep checking unsupported method-specific claims in those cases.';

/** Lossless witness interning: repeated concrete states used to dominate review
 * prompts (70K+ tokens). Keep every correlation and action, but send each state
 * once. Symbol aliases are valid only for this chapter's bound initial atoms. */
export function compactJointStoryEvidence(c:ReturnType<typeof compileJointStory>,focus:string[]){
  const raw=jointStoryEvidence(c,focus);
  const stateAtoms=Object.fromEntries(c.story.chapter!.initialState.map(a=>[a.ref.symbol,symbolicAtomKey(a.ref)]));
  const alias=new Map(Object.entries(stateAtoms).map(([fact,atom])=>[atom,fact]));
  const keys=<T>(values:Record<string,T>)=>Object.fromEntries(Object.entries(values).map(([atom,value])=>[alias.get(atom)??atom,value]));
  const predicate=<T extends {ref:{symbol:string;args:string[]}}>({ref,...rest}:T)=>({...rest,fact:alias.get(symbolicAtomKey(ref))??symbolicAtomKey(ref)});
  const states:Record<string,Record<string,boolean|number>>={},seen=new Map<string,string>();
  const intern=(state:Record<string,boolean|number>)=>{
    const signature=JSON.stringify(Object.entries(state).sort(([a],[b])=>a.localeCompare(b)));
    let id=seen.get(signature);if(!id){id='state_'+(seen.size+1);seen.set(signature,id);states[id]=keys(state);}return id;
  };
  const {concreteEntryStates,concreteCrossAdmissions,actionBindings,reachableEntries,...rest}=raw;
  const result={...rest,
    eventScenes:raw.eventScenes.map(e=>({...e,entry:{...e.entry,all:e.entry.all.map(predicate)}})),
    actionBindings:actionBindings.map(({concreteBeforePlayStates,...binding})=>({...binding,
      requiresBeforePlay:{...binding.requiresBeforePlay,all:binding.requiresBeforePlay.all.map(predicate)},
      changesOnPlay:binding.changesOnPlay.map(predicate),
      admissionAfterPlay:{...binding.admissionAfterPlay,all:binding.admissionAfterPlay.all.map(predicate)},
      destinationEntry:{...binding.destinationEntry,all:binding.destinationEntry.all.map(predicate)},
      destinationEntryAlternatives:binding.destinationEntryAlternatives?.map(g=>({...g,all:g.all.map(predicate)})),
      concreteBeforePlayStateIds:concreteBeforePlayStates.map(intern)})),
    reachableEntries:Object.fromEntries(Object.entries(reachableEntries).map(([id,values])=>[id,keys(values)])),
    concreteEntryStateIds:Object.fromEntries(Object.entries(concreteEntryStates).map(([id,values])=>[id,values.map(intern)])),
    concreteCrossAdmissions:concreteCrossAdmissions.map(({state,...w})=>({...w,stateId:intern(state)})),
    stateEncoding:{note:'Every state_N is one concrete correlated state in states. Each states entry contains ALL values, not a partial patch. Fact keys in states, conditions and effects abbreviate the exact bound atoms in stateAtoms. Repeated IDs reuse the SAME state; do not combine values from different states. No witness, condition, effect or action has been omitted.',stateAtoms,states},
  };
  const game=c.story.gameplay!,sources=new Set([...focus,...actionBindings.filter(b=>focus.includes(b.nextEvent)).map(b=>b.performedAt)]);
  const meanings=new Map(c.story.chapter!.contract.stateSymbols.map(s=>[s.id,s.meaning]));
  const base=createGameplaySession(game);
  const focusRuntimeLookup=game.events.filter(e=>sources.has(e.id)&&!e.endingId).map(source=>{
    const bindings=actionBindings.filter(b=>b.performedAt===source.id);
    const examples=[...(c.audit.entryWitnesses[source.id]??[]),...bindings.flatMap(b=>b.concreteBeforePlayStates),...c.audit.crossAdmissions.filter(w=>w.from===source.id).map(w=>w.state)];
    const ids=[...new Set(examples.map(intern))].slice(0,12);
    return {source:source.id,
      outgoing:bindings.map(b=>({to:b.nextEvent,signalId:b.signalId,executionBoundary:b.changesOnPlay.length?'state-changing-play':'external-start-choice',effects:b.changesOnPlay.map(effect=>({fact:effect.ref.symbol,meaning:meanings.get(effect.ref.symbol),op:effect.op,value:effect.value}))})),
      observedStartChecks:ids.map(stateId=>{
        const state=Object.fromEntries(Object.entries(states[stateId]!).map(([fact,value])=>[stateAtoms[fact]??fact,value]));
        const ended={...base,state,activeEventId:null,lastCompletedEventId:source.id};
        return {stateId,afterExplicitEnd:source.exits.map(exit=>{const blocker=startEventBlocker(game,ended,exit.to)??null;return {to:exit.to,allowed:blocker===null,blocker};})};
      }),
    };
  });
  return {...result,focusRuntimeLookup,
    lookupPolicy:externalStartContract+' Read this source-keyed lookup before claiming a missing effect, missing connection or blocked start. outgoing lists EVERY actual outgoing action for that source; effects include their exact fact meanings. observedStartChecks are computed by the real start-condition function from bounded concrete observed states after explicitly ending that source. blocker=null means that start is permitted, even without the named signal receipt. This does NOT prove the resulting prose is truthful: a different earlier action can establish the same state. Do not infer additional unobserved state combinations or waive narrative contradictions.'};
}

/** Suggest intermediate cross-route recovery opportunities, not new guards or
 * compulsory branches. The author must justify the action in the story and the
 * normal full audit must accept it. Never propose undoing a completed history. */
export function jointExpansionHints(c:ReturnType<typeof compileJointStory>,map:JointMap,rules:JointRule[]){
  const hints:Array<{from:string;rejoin:string;ending:string;possibleCurrentChanges:Array<{fact:string;value:boolean;meaning:string}>}> = [];
  const outgoing=(id:string)=>new Set(map.routes.flatMap(r=>{const i=r.steps.indexOf(id);return i>=0&&i<r.steps.length-1?[r.steps[i+1]!]:[]}));
  const chapter=c.story.chapter!,atom=(fact:string)=>{const ref=chapter.initialState.find(a=>a.ref.symbol===fact)?.ref;return ref?JSON.stringify([ref.symbol,...ref.args]):undefined;};
  for(const route of map.routes)for(const from of route.steps.slice(1,-1)){
    if(outgoing(from).size!==1)continue;
    for(const target of map.routes.filter(r=>r.ending!==route.ending))for(const rejoin of target.steps.slice(1,-1)){
      if(outgoing(from).has(rejoin)||hints.some(h=>h.from===from&&h.rejoin===rejoin))continue;
      const combined=[...route.steps.slice(0,route.steps.indexOf(from)+1),...target.steps.slice(target.steps.indexOf(rejoin))];
      if(new Set(combined).size!==combined.length)continue;
      const rule=rules.find(r=>r.id===rejoin)!;
      for(const state of c.audit.entryWitnesses[from]??[]){
        const missing=rule.requires.filter(r=>state[atom(r.fact)??'']!==r.value);
        if(!missing.length||missing.length>2||missing.some(r=>chapter.factSemantics?.[r.fact]?.scope!=='current'))continue;
        hints.push({from,rejoin,ending:target.ending,possibleCurrentChanges:missing.map(r=>({...r,meaning:chapter.contract.stateSymbols.find(s=>s.id===r.fact)?.meaning??r.fact}))});break;
      }
    }
  }
  return hints.slice(0,6);
}

/** Review the actual source-owned gameplay, not the legacy incoming-beat
 * representation. A focused excerpt must never look like missing signals. */
export function jointStoryEvidence(c:ReturnType<typeof compileJointStory>,focus:string[]){
  const {story,audit,plan}=c,game=story.gameplay!;
  const label=(id:string)=>story.chapter!.contract.entityLabels?.find(e=>e.id===id)?.label??id;
  return {
    // Opportunities are ideas for later enrichment, not implemented core paths.
    // Accepted optional branches remain in the manuscript and are reviewed.
    book:{...story.chapter!.manuscript,opportunities:undefined,
      paths:story.chapter!.manuscript!.paths.map(p=>({requiredOutcome:p.ending,exampleRouteStory:p.story})),
      pathScope:'requiredOutcome must hold for every route to that ending. exampleRouteStory supplies a causal example, not universal assertions for all permitted combinations. Preserve its decisive method/dependencies when implementing that method; do not require incidental ignorance, possessions or exact action order in every alternate route. A player may learn a partial clue and still fail to discover the full truth. Judge present-state contradictions against actual eventScenes and requested outcomes, not solely a different exemplar ending paragraph.'},focus,
    endingDefinitions:story.chapter!.contract.endings,
    eventScenes:game.events.map(e=>{const scene=story.symbolic!.details.scenes[e.id] as {summary?:string;locationId?:string;presentCharacters?:string[];perspective?:string}|undefined;
      return {id:e.id,title:plan.beats.find(b=>b.key===e.id)?.title??e.id,situation:scene?.summary,
        location:scene?.perspective==='outcome'?undefined:scene?.locationId?label(scene.locationId):undefined,characters:scene?.perspective==='outcome'?undefined:scene?.presentCharacters?.map(label),
        context:scene?.perspective==='outcome'?'Abstract outcome confirmation only. No relocation, physical cast or new action is asserted. The actual predecessor scene retains its physical context.':undefined,
        predecessorScenes:scene?.perspective==='outcome'?game.events.filter(from=>from.exits.some(x=>x.to===e.id)).map(from=>from.id):undefined,
        entry:e.entryCondition,endingId:e.endingId};}),
    routes:plan.storylines,
    actionBindings:game.events.flatMap(source=>source.exits.map(exit=>{
      const play=source.signals.find(s=>s.id===exit.requiredSignal)!;
      const action=story.symbolic!.eventAuthoring!.actions.find(a=>a.from===source.id&&a.to===exit.to);
      const destination=game.events.find(e=>e.id===exit.to)!;
      return {performedAt:source.id,signalId:play.id,play:play.label,description:action?.description??(source.id==='start'?'챕터 시작 준비':'이미 성립한 결말 확인'),
        requiresBeforePlay:play.condition,changesOnPlay:play.effects,nextEvent:exit.to,admissionAfterPlay:exit.condition,
        destinationEntry:destination.entryCondition,destinationEntryAlternatives:destination.entryAlternatives,
        untrackedChoiceBoundary:play.effects.length?undefined:'No state-changing gameplay: the external destination-start request completes this choice/travel only after all admission and destination entry conditions pass. A no-op signal alone does not move anyone or start its scene.',
        concreteBeforePlayStates:audit.beforePlayWitnesses[source.id+':'+play.id]??[]};
    })),
    reachableEntries:audit.reachableEntries,
    concreteEntryStates:Object.fromEntries(Object.entries(audit.entryWitnesses).filter(([id])=>focus.includes(id))),
    concreteCrossAdmissions:audit.crossAdmissions.filter(w=>focus.includes(w.from)||focus.includes(w.to)),
    runtimeVerification:{allRequestedEndingsReachable:true,configurations:audit.configurations,
      note:'Code has already executed all authored routes and explored permitted play combinations. This proves mechanical reachability, NOT narrative coherence. actionBindings is the COMPLETE actual signal list for the chapter, including predecessors outside the focused group. A signal NEVER ends or starts an event. Destination start is a separate request after source end and must satisfy BOTH admissionAfterPlay AND destinationEntry (plus an alternative if listed). concreteBeforePlayStates prove only that a signal can be received, NOT that destination start is allowed. For zero-effect choices, do not infer travel occurred from a no-op signal. Check actual destination-entry witnesses for a claimed scene contradiction. A change occurs at performedAt, not at nextEvent; the latter contains its own subsequent plays. Do not infer a missing signal from looking only at the destination. Book paths are exemplar sequences, not every permitted interleaving: judge counterexamples against actual eventScenes and played actions, not an assumption that only the exemplar actions occurred. Fixed truth, motives and requested outcomes remain authoritative. Marginal value sets do not prove conjunctions: use concrete correlated states. Witnesses are bounded examples. Check semantic contradictions even across no-effect external choices.'},
  };
}
