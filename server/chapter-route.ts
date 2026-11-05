import {z} from 'zod';
import {approveAuthorContract} from '../src/author-contract.js';
import {approveEndingOutcomes} from '../src/ending-outcomes.js';
import {createStatefulSeed,appendStatefulStoryline,describeStatefulSegments,statefulAnchorMenu,validateStatefulPlan,materializeStatefulPlan,planAtoms,StatefulPlanError} from '../src/stateful-storyline.js';
import {StatefulStorylinePlanSchema} from '../src/stateful-storyline-plan.js';
import type {GenerateRequest} from './request-schema.js';
import type {ProgressSink} from '../src/generation-progress.js';
import type {IncrementalGenerationOptions} from './stateful-generation.js';
import {chapterJson} from './chapter-setup.js';
import {postJsonSafe} from './safe-http.js';
import {interpretEventFact,checkEventRevision} from './chapter-event.js';
import type {ChapterDesign,ChapterAuthoring} from '../src/chapter-authoring.js';
import {readChapterActions} from './chapter-semantics.js';
import {checkChapterCoherence,type CoherenceScorer,type NarrativeEvent} from './chapter-coherence.js';
import {clarifyChapterEvent} from './chapter-repair.js';
import {diagnoseChapterSetup} from './chapter-setup-diagnosis.js';
import {ChapterSetupError} from './chapter-setup-error.js';
import {planBranchPlay,assessBranchPlay} from './chapter-branch-play.js';

export type ChapterRouteOptions=IncrementalGenerationOptions & {setup?:ChapterAuthoring;design?:ChapterDesign;factSemantics?:ChapterAuthoring['factSemantics'];segmentId?:string;coherenceScorer?:CoherenceScorer;coherenceTrace?:(event:Record<string,unknown>)=>void;localBranch?:{joinState:Record<string,boolean|number>;maxEvents:number;priorCommitments?:string[]}};

/** Branch gameplay is proposed before prose; independent interpreters remain
 * the sole authority for executable effects and requirements. */
export async function generateChapterRoute(request:GenerateRequest,transport:typeof postJsonSafe,progress:ProgressSink,options:ChapterRouteOptions,recovery?:unknown) {
  const approval=approveAuthorContract(request.brief!,request.approvedContract!,request.playerId!,request.approvalRevision!);
  const outcomes=approveEndingOutcomes(approval,approval.revision,request.approvedOutcomeInitialState!,request.approvedEndingOutcomes!);
  const facts=planAtoms(outcomes).map(a=>({...a,meaning:approval.contract.stateSymbols.find(s=>s.id===a.ref.symbol)?.meaning??a.ref.symbol}));
  const endingId=options.branch?.endingId??approval.contract.endings[0]!.id;
  const ending=outcomes.outcomes.find(o=>o.endingId===endingId)!;
  const diagnosed=new Set<string>();
  const checkDesign=async(event:string,problem:string)=>{
    if(!options.setup||diagnosed.has(event))return;
    diagnosed.add(event);
    await diagnoseChapterSetup(request,options.setup,endingId,event,problem,transport,options.signal);
  };
  const baseline=options.branch?StatefulStorylinePlanSchema.parse(options.branch.baseline.plan):undefined;
  let selected:ReturnType<typeof describeStatefulSegments>[number]|undefined;
  if(baseline&&options.branch){
    const menu=statefulAnchorMenu(approval,outcomes,baseline,endingId);
    menu.segments=menu.segments.filter(s=>s.fromKey===options.branch!.fromKey);
    if(!menu.segments.length)throw new Error('이 사건 뒤에는 해당 결말로 갈래를 추가할 수 없습니다. 더 앞의 사건을 선택해 주세요.');
    progress({stage:'expansion',message:'선택한 사건 뒤의 분기 위치 확인 중'});
    const answer=options.segmentId?{segment:options.segmentId}:z.object({segment:z.string()}).strict().parse(await chapterJson(request,[{role:'system',content:'Select one allowed segment for the author requested branch. Existing prefix and suffix cannot change. Prefer an independent route (rejoinKey null) when it fits the request. Return only its exact segment ID.'},{role:'user',content:JSON.stringify({instruction:options.branch.instruction,targetEnding:approval.contract.endings.find(e=>e.id===endingId),menu})}],{type:'object',additionalProperties:false,required:['segment'],properties:{segment:{type:'string',enum:menu.segments.map(s=>s.id)}}},transport,options.signal,150));
    if(!menu.segments.some(s=>s.id===answer.segment))throw new Error('선택할 수 없는 분기 지점입니다.');
    selected=describeStatefulSegments(approval,outcomes,baseline).find(s=>s.id===answer.segment)!;
  }
  const state=Object.fromEntries((selected?.stateAfterPrefix??facts).map(f=>[f.atom,f.value]));
  let branchPlay:Awaited<ReturnType<typeof planBranchPlay>>;
  if(baseline&&selected&&options.branch){
    progress({stage:'expansion',message:'분기의 허용 플레이 · 심볼 변화 · 다음 사건 진입 조건 함께 설계 중'});
    const summary=(key:string)=>(options.branch!.baseline.details.scenes[key] as {summary:string}).summary;
    const childKeys=new Set(baseline.storylines.flatMap(line=>line.steps.flatMap((step,i)=>step.beatKey===selected!.fromKey&&line.steps[i+1]?[line.steps[i+1]!.beatKey]:[])));
    branchPlay=await planBranchPlay(request,{
      fromKey:selected.fromKey,
      completedPrefix:baseline.storylines[selected.storylineIndex]!.steps.slice(0,selected.fromIndex+1).map(s=>({title:baseline.beats.find(b=>b.key===s.beatKey)!.title,summary:summary(s.beatKey)})),
      instruction:options.branch.instruction,
      facts:facts.map(f=>({atom:f.atom,meaning:f.meaning,before:state[f.atom]!,semantics:options.factSemantics?.[f.ref.symbol]})),
      siblings:[...childKeys].map(key=>{const beat=baseline.beats.find(b=>b.key===key)!;return {title:beat.title,summary:summary(key),changes:beat.effects.filter(e=>e.op==='set').map(e=>({atom:e.ref.symbol+'('+e.ref.args.join(',')+')',value:e.value}))};}),
      target:{label:approval.contract.endings.find(e=>e.id===endingId)!.label,required:ending.condition.all.filter(c=>c.op==='eq').map(c=>({atom:c.ref.symbol+'('+c.ref.args.join(',')+')',value:c.value}))},
      continuation:selected.remainingSuffix.map(b=>({title:b.title,summary:summary(b.key)})),
      requiredBeforeContinuation:options.localBranch?.joinState,
    },transport,options.signal,options.coherenceTrace);
  }
  const maximumEvents=baseline?Math.min(options.localBranch?.maxEvents??5,40-baseline.beats.length,20-selected!.sharedPrefix.length-selected!.remainingSuffix.length):6;
  if(maximumEvents<1||baseline&&baseline.storylines.length>=12)throw new Error('이 챕터의 현재 크기 한도에 도달했습니다. 새 챕터로 이어서 제작해 주세요.');
  const sceneShape={title:z.string().min(1).max(160),summary:z.string().min(10).max(800),locationId:z.enum(approval.contract.entities.locations as [string,...string[]]),presentCharacters:z.array(z.enum(approval.contract.entities.characters as [string,...string[]])).min(1).max(8)};
  const scene=z.object(sceneShape).strict();
  const sceneSchema={type:'object',additionalProperties:false,required:['title','summary','locationId','presentCharacters'],properties:{title:{type:'string',minLength:1,maxLength:160},summary:{type:'string',minLength:10,maxLength:800},locationId:{type:'string',enum:approval.contract.entities.locations},presentCharacters:{type:'array',minItems:1,maxItems:8,items:{type:'string',enum:approval.contract.entities.characters}}}};
  const eventArray={type:'array',minItems:baseline?1:4,maxItems:maximumEvents,items:sceneSchema};
  const schema=baseline?{type:'object',additionalProperties:false,required:['events'],properties:{events:eventArray}}:{type:'object',additionalProperties:false,required:['title','opening','events'],properties:{title:{type:'string',minLength:1,maxLength:160},opening:sceneSchema,events:eventArray}};
  progress({stage:baseline?'expansion':'seed',message:baseline?'새 갈래의 사건 서술 중':'첫 경로의 사건 서술 중',reset:!baseline});
  const rawNarrative=await chapterJson(request,[{role:'system',content:options.localBranch?'기존 이야기의 짧은 대체 구간만 한국어로 쓰세요. branch.instruction에 기획된 다른 수단을 구체적으로 실행하는 새 사건 1개를 씁니다. 장애와 회복이 꼭 필요할 때만 2개로 나눕니다. localBranch.originalApproach를 이름만 바꾸거나 반복하지 마세요. branch.completedScenes는 이미 끝났습니다. localBranch.priorCommitments는 뒤 사건이 이미 일어났다고 가정하는 사실이므로 반드시 지키세요. localBranch.mustAccomplish는 이번 구간에서 반드시 실제로 완수할 목표입니다. 이 결과는 원래 구간과 같아야 하고 수단만 달라야 합니다. 획득이 목표면 획득까지, 읽기가 목표면 내용을 읽기까지 실행하세요. branch.suffixAfterNewEvents는 이 목표가 이미 완수됐다고 전제합니다. 뒤 제목이 같은 획득이나 발견을 다시 언급해도 이번 목표를 미루지 마세요. 뒤 사건에서만 새로 성립하는 사실과 결말은 미리 실행하지 마세요. 새로운 도입부를 쓰지 마세요. requiredFactsBeforeContinuation에 맞는 상태로 끝내세요. 상태를 임의로 설정하지 말고 그 결과를 낳는 행동을 서술하세요. 이후 장면에 필요한 물건, 장소, 약속은 실제로 마련해야 합니다. 새 구간에서 만든 환경 변화나 은신 때문에 뒤 사건이 불가능해지지 않도록 끝내세요. 예를 들어 조명을 껐다면 뒤에서 글을 읽을 수단을 마련하고, 혼자 숨었다면 뒤 대화 전에 상대에게 돌아와야 합니다. 이미 가진 물건이나 아는 사실을 처음 획득하는 것처럼 반복하지 마세요. 인물이 숨기려는 것을 이유 없이 제공하게 하지 마세요. title은 서로 다른 구체적 플레이어 행동이며 기존 선택지 제목을 복사하지 마세요. summary는 그 사건에서 실제 일어난 행동과 결과 1~3문장입니다. 플레이어는 항상 등장하며 선언된 장소와 인물만 사용하세요.': 'Write ONE playable story route in Korean, as concrete completed events, NOT code or state assignments. The protagonist is present throughout. Explicitly name the actual actor of each independent action sentence; do not let a relative-clause subject stand in for an omitted main actor. Describe prevented actions and deliberately unattempted actions separately from completed actions and failed attempts. Each title is a short player action; its summary describes only that event and its actual result in 1-3 sentences. Follow the chapter design and the target route approach. Develop the obstacle, a motivated response and revelation, then a meaningful final action. Shared preparation should leave plausible alternatives for the other planned endings. The first new branch action must be visibly different from existing sibling actions. Reveal concrete facts from the backstage background only when the character learns them. Distinguish obtaining a key, unlocking a door, reading evidence, hearing a confession, and choosing forgiveness; do not assert a later event early. A locked room must actually be unlocked before its records are read. The ending screen cannot perform actions or change facts. Your events must ALREADY realize every requested ending fact, including NPC or environmental consequences, before that screen. Distribute the required consequences across the route in causal order. Facts achieved in earlier events remain achieved: the final event must NOT replay them. An attempt, partial intervention or intention is not a completed outcome. Every event changes the situation once and the following event starts AFTER that change. Keep physical prerequisites plausible. When entering a closed or locked place, narrate obtaining access and opening it BEFORE searching inside; simply naming its location does not open its door. Each event adds a distinct development. Discover each specific document or secret once, then show its consequences rather than discovering it again as new. Only use declared entities; minor sensory details are allowed. Never erase known facts to force a different outcome.'+(selected?.rejoinKey?' REJOIN OVERRIDE: Write only the local alternative BEFORE the supplied continuation. That continuation will execute unchanged after your last event. Do NOT realize final ending facts early; the remaining continuation may perform them. Match the required state BEFORE continuation through concrete actions. Do not repeat any continuation event. Physically reach its starting place, and supply anything its prose explicitly assumes from earlier events. A short branch changes tactic or overcomes a setback, not merely wording.':'')+(baseline?' THIS IS A BRANCH, NOT A NEW STORY. Output ONLY events after the supplied prefix. The anchor event is already completed, not a simultaneous choice to replace. If the branch instruction sounds like replacing a completed action, preserve that history and narrate a later change of tactics with a brief causal bridge; never claim the earlier action did not happen. Do not replay the same instant at the anchor. Do not include arrival/opening again. Do not replay the already-completed prefix. Actions from other routes may be revisited with genuinely different content or consequences. Start with the different choice requested by the author.':' Opening is a neutral arrival with NO state change. events start after that arrival; do not repeat arriving in events.')},{role:'user',content:JSON.stringify({jointBranchPlay:branchPlay?{...branchPlay,changes:branchPlay.changes.map(c=>({...c,meaning:facts.find(f=>f.atom===c.atom)!.meaning,before:state[c.atom]})),entryAfterPlay:branchPlay.entryAfterPlay.map(c=>({...c,meaning:facts.find(f=>f.atom===c.atom)!.meaning})),instruction:'The FIRST new event must concretely perform play and establish its changes. Its summary records the actual action and resulting situation. Subsequent events start AFTER that result; never repeat it. The current event hosts this allowed gameplay, and entryAfterPlay gates the next event after an explicit start trigger. Do not postpone these results to a later event. If the action is physically impossible, preserve causality instead of inventing its result.'}:undefined,brief:options.localBranch?undefined:approval.brief,chapterDesign:options.design,routeDesign:options.design?.routes[endingId],entities:approval.contract.entityLabels,playerId:approval.playerId,trackedFacts:facts.map(f=>({meaning:f.meaning,current:state[f.atom]})),targetEnding:options.localBranch?undefined:approval.contract.endings.find(e=>e.id===endingId),requiredFinalFacts:selected?.rejoinKey?undefined:ending.condition.all.map(c=>({meaning:approval.contract.stateSymbols.find(s=>s.id===c.ref.symbol)?.meaning,value:c.value})),localBranch:options.localBranch?{task:'Reach the SAME local outcome by a DIFFERENT tactic. Every mustAccomplish fact must be achieved HERE, before the unchanged continuation. Write 1-2 events, not the final ending.',priorCommitments:options.localBranch.priorCommitments,mustAccomplish:facts.filter(f=>state[f.atom]!==options.localBranch!.joinState[f.atom]).map(f=>({fact:f.meaning,before:state[f.atom],required:options.localBranch!.joinState[f.atom]})),originalApproach:baseline!.storylines[selected!.storylineIndex]!.steps.slice(selected!.fromIndex+1,selected!.rejoinIndex).map(s=>({title:baseline!.beats.find(b=>b.key===s.beatKey)!.title,scene:options.branch!.baseline.details.scenes[s.beatKey]})),requiredFactsBeforeContinuation:facts.map(f=>({meaning:f.meaning,value:options.localBranch!.joinState[f.atom]}))}:undefined,branch:options.branch?{instruction:options.branch.instruction,prefixAlreadyCompleted:selected!.sharedPrefix,completedScenes:baseline!.storylines[selected!.storylineIndex]!.steps.slice(options.localBranch?Math.max(0,selected!.fromIndex-1):0,selected!.fromIndex+1).map(s=>({title:baseline!.beats.find(b=>b.key===s.beatKey)!.title,scene:options.branch!.baseline.details.scenes[s.beatKey]})),suffixAfterNewEvents:selected!.remainingSuffix.slice(0,options.localBranch?2:undefined).map(b=>({title:b.title,scene:options.branch!.baseline.details.scenes[b.key]})),existingTitles:baseline!.beats.map(b=>b.title)}:undefined,previousFailure:recovery})}],schema,transport,options.signal,options.localBranch?1600:2800);
  const branchText=baseline?z.object({events:z.array(scene).min(1).max(maximumEvents)}).strict().parse(rawNarrative):undefined;
  const narrative=branchText?{title:baseline!.title,opening:branchText.events[0]!,events:branchText.events}:z.object({title:z.string().min(1).max(160),opening:scene,events:z.array(scene).min(4).max(6)}).strict().parse(rawNarrative);
  // Different strategies can be given the same short label by a small model.
  // Fix only that label before expensive state interpretation; prose stays fixed.
  const usedTitles=new Set(baseline?baseline.beats.map(b=>b.title):[narrative.opening.title]);
  for(const event of narrative.events){
    for(let attempt=0;usedTitles.has(event.title)&&attempt<2;attempt++){
      progress({stage:'prose',message:'다른 경로와 구분되는 사건 이름 정리 중'});
      const renamed=z.object({title:z.string().trim().min(1).max(160)}).strict().parse(await chapterJson(request,[{role:'system',content:'Name ONE already written Korean story event. Its current title duplicates another graph node. Return a short, specific player-action title that distinguishes THIS event using its actual summary. Do not change the story or claim a new action. Do not reuse any supplied title. No numbering or arbitrary suffixes; describe the concrete tactic or outcome.'},{role:'user',content:JSON.stringify({event,usedTitles:[...usedTitles]})}],{type:'object',additionalProperties:false,required:['title'],properties:{title:{type:'string',minLength:1,maxLength:160}}},transport,options.signal,180));
      event.title=renamed.title;
    }
    if(usedTitles.has(event.title))throw new StatefulPlanError('duplicate-event',{title:event.title,message:'A distinct event label could not be prepared.'});
    usedTitles.add(event.title);
  }
  const playerLabel=approval.contract.entityLabels?.find(e=>e.id===approval.playerId)?.label;
  for(const item of [narrative.opening,...narrative.events])if(!item.presentCharacters.includes(approval.playerId)){
    // Repair omitted cast metadata only when the prose itself names the player.
    // This never adds an action, revives an actor, or changes a state assignment.
    if(playerLabel&&item.summary.includes(playerLabel))item.presentCharacters=[approval.playerId,...new Set(item.presentCharacters)];
    else throw new Error('플레이어가 없는 사건입니다.');
  }
  if(!baseline){
    // The seed compiler gives the opening no effects. Verify that its prose really
    // describes the initial state, rather than silently handing out objects or knowledge.
    for(let attempt=0;attempt<3;attempt++){
      progress({stage:'seed',message:'도입부의 서술과 시작 상태 확인 중'});
      const problems=[];
      // Neutral opening has no gameplay action ledger; it still receives every
      // fact check, including the completion/polarity gate for proposed changes.
      const actions=options.factSemantics?[]:undefined;
      for(const fact of facts){
        const before=state[fact.atom];
        if(typeof before!=='boolean')throw new Error('이 챕터 제작기는 참/거짓 상태만 지원합니다.');
        const decision=await interpretEventFact(request,fact.meaning,before,narrative.opening.summary,transport,options.signal,undefined,options.factSemantics?{previous:[],following:narrative.events.slice(0,2),startLocation:narrative.opening.locationId,semantics:options.factSemantics[fact.ref.symbol],actions}:undefined);
        if(decision.change==='uncertain'||decision.change!=='keep'&&(decision.change==='true')!==before||decision.needs!=='none'&&(decision.needs==='true')!==before)problems.push({fact:fact.meaning,before,decision});
      }
      if(!problems.length)break;
      if(attempt===2)throw new StatefulPlanError('opening-state-change',{problems,opening:narrative.opening});
      progress({stage:'retry',message:'도입부에서 앞당겨진 행동을 정리 중'});
      const opening=scene.parse(await chapterJson(request,[{role:'system',content:'Rewrite ONLY the opening scene as a neutral observation in Korean. The locked initial facts take priority over atmosphere and the previous draft. Delete each clause that establishes a fact listed in mustRemainFalse, even if it sounds like background rather than an action. Environmental conditions, isolation, danger, access restrictions and possession are also facts; describing them as already true still contradicts a false initial value. Do not copy the rejected premise into the new title or paraphrase it. Do not reverse a mustRemainTrue fact. Omit unsupported details instead of inventing their opposites. No handover, discovery, confession, forgiveness, death, rescue or resolved obstacle may happen here. Keep the declared location and protagonist. Do not rewrite the following events. Return the single scene shape.'+(attempt>0?' The previous local rewrite still failed. Use just ONE short sentence describing the protagonist at the declared location. Remove optional atmosphere and new claims, retaining only facts compatible with the locked state.':'')},{role:'user',content:JSON.stringify({purpose:'neutral-opening',event:narrative.opening,problems,mustRemainFalse:facts.filter(f=>state[f.atom]===false).map(f=>f.meaning),mustRemainTrue:facts.filter(f=>state[f.atom]===true).map(f=>f.meaning),initialFacts:facts.map(f=>({meaning:f.meaning,value:f.value})),followingEvents:narrative.events,entities:approval.contract.entityLabels})}],sceneSchema,transport,options.signal,700));
      if(!opening.presentCharacters.includes(approval.playerId))throw new Error('플레이어가 없는 도입부입니다.');
      narrative.opening=opening;
    }
  }
  const draftIds=narrative.events.map((_,i)=>'draft_'+i),draftEnding='end_'+endingId;
  const preview={nodes:options.branch?options.branch.baseline.skeleton.scenes.map(s=>({id:s.key,title:s.title})):[{id:'draft_opening',title:narrative.opening.title}],edges:options.branch?options.branch.baseline.skeleton.links.map(l=>({from:l.from,to:l.to})):[]};
  preview.nodes.push(...narrative.events.map((e,i)=>({id:draftIds[i]!,title:e.title})));
  if(!preview.nodes.some(n=>n.id===draftEnding))preview.nodes.push({id:draftEnding,title:approval.contract.endings.find(e=>e.id===endingId)!.label});
  preview.edges.push({from:options.branch?.fromKey??'draft_opening',to:draftIds[0]!},...draftIds.slice(1).map((id,i)=>({from:draftIds[i]!,to:id})),{from:draftIds.at(-1)!,to:selected?.rejoinKey??draftEnding});
  const mapped:Array<{title:string;requires:Array<{atom:string;value:boolean}>;changes:Array<{atom:string;value:boolean}>}>=[];
  const completedPrefix:NarrativeEvent[]=baseline?baseline.storylines[selected!.storylineIndex]!.steps.slice(0,selected!.fromIndex+1).map(s=>({title:baseline.beats.find(b=>b.key===s.beatKey)!.title,summary:(options.branch!.baseline.details.scenes[s.beatKey] as {summary:string}).summary})):[narrative.opening];
  const preceding=(index:number)=>[...completedPrefix,...narrative.events.slice(0,index)].map(({title,summary})=>({title,summary}));
  const statesBefore:Array<Record<string,boolean|number>>=[];
  const declined=new Map<string,{index:number;atom:string;proposedValue:boolean;reason:string}>();
  let attributedRepairs=0;
  eventLoop:for(let index=0;index<narrative.events.length;index++){
    const event=narrative.events[index]!;
    statesBefore[index]={...state};
    progress({stage:'prose',message:`사건의 진행 조건과 변화 해석 중 (${index+1}/${narrative.events.length})`,graph:preview,activeNodeIds:[draftIds[index]!]});
    let feedback='';
    for(let attempt=0;attempt<2;attempt++){
      for(const [key,rejection] of declined)if(rejection.index===index)declined.delete(key);
      let requiredNewResults:Array<{meaning:string;required:boolean|number}>=[];
      try{
        const coherenceStarted=Date.now();
        const continuity=await checkChapterCoherence(request,{previous:preceding(index),current:{title:event.title,summary:event.summary},following:narrative.events.slice(index+1).map(({title,summary})=>({title,summary}))},transport,options.signal,options.coherenceScorer);
        options.coherenceTrace?.({type:'chapter-coherence',index,attempt,elapsedMs:Date.now()-coherenceStarted,...continuity});
        if(continuity.issues.length)throw new Error('사건 연결의 구체적인 오류: '+JSON.stringify(continuity.issues));
        const requires:Array<{atom:string;value:boolean}>=[];
        const changes:Array<{atom:string;value:boolean}>=[];
        const actions=options.factSemantics?await readChapterActions(request,event.summary,transport,options.signal,()=>options.coherenceTrace?.({type:'chapter-action-aid-omitted',index,attempt,reason:'Ungrounded optional observations discarded; mandatory original-prose checks retained.'})):undefined;
        if(actions)options.coherenceTrace?.({type:'chapter-actions',index,attempt,summary:event.summary,actions});
        // Every tracked fact is checked, including possible omissions in the writer's proposed logic.
        for(const fact of facts){
          const before=state[fact.atom];if(typeof before!=='boolean')throw new Error('이 챕터 제작기는 참/거짓 상태만 지원합니다.');
          const location=approval.contract.entityLabels?.find(l=>l.id===event.locationId)?.label??event.locationId;
          const decision=await interpretEventFact(request,fact.meaning,before,event.summary,transport,options.signal,feedback,{previous:preceding(index),following:narrative.events.slice(index+1,index+3),startLocation:location,semantics:options.factSemantics?.[fact.ref.symbol],actions},rejection=>declined.set(index+':'+fact.atom,{index,atom:fact.atom,...rejection}));
          if(decision.change==='uncertain')throw new Error('사건 결과가 불명확합니다: '+fact.meaning+' · '+decision.reason);
          if(decision.needs!=='none'){
            const value=decision.needs==='true';
            if(before!==value)throw new Error('실행 전제 불충족: '+fact.meaning+', 현재 '+before+', 요구 '+value+'. 필수 전제가 맞다면 그대로 유지하세요. 단순히 이 사건에서 생기는 결과를 전제로 삼았다면 수정하세요.');
            requires.push({atom:fact.atom,value});
          }
          if(decision.change!=='keep'&&(decision.change==='true')!==before)changes.push({atom:fact.atom,value:decision.change==='true'});
        }
        // Repair an omitted resolution while the final event is still private.
        // Reinterpret the revised prose normally; never manufacture goal effects.
        if(index===narrative.events.length-1&&!selected?.rejoinKey){
          const after={...state,...Object.fromEntries(changes.map(c=>[c.atom,c.value]))};
          const missing=ending.condition.all.flatMap(c=>{
            const fact=facts.find(f=>f.ref.symbol===c.ref.symbol&&JSON.stringify(f.ref.args)===JSON.stringify(c.ref.args))!;
            return after[fact.atom]===c.value?[]:[{atom:fact.atom,meaning:fact.meaning,actual:after[fact.atom],required:c.value}];
          });
          if(missing.length){
            await checkDesign(event.summary,JSON.stringify({missingFinalFacts:missing}));
            // A conservative judgment may have rejected a result narrated earlier.
            // Clarify its original PRIVATE event, not replay it at the ending.
            const sources=[...declined.values()].filter(r=>r.index<index&&missing.some(m=>m.atom===r.atom&&m.required===r.proposedValue)).sort((a,b)=>b.index-a.index);
            const source=sources[0];
            if(source){
              if(attributedRepairs>=2)throw new StatefulPlanError('event-repair-attribution',{reason:'The original event remained unverified after bounded clarification.',missing});
              attributedRepairs++;
              const sourceEvent=narrative.events[source.index]!,sourceState=statesBefore[source.index]!;
              const required=missing.filter(m=>sources.some(r=>r.index===source.index&&r.atom===m.atom)).map(({meaning,required})=>({meaning,required}));
              let problem='This earlier event proposed a required outcome, but its evidence was not accepted: '+JSON.stringify(sources.filter(r=>r.index===source.index).map(r=>({fact:facts.find(f=>f.atom===r.atom)!.meaning,reason:r.reason})))+'. Clarify the exact actor, causal method or completion HERE. Do not repeat this action in a later event. These targets are not proof; your revised prose will be independently checked.';
              progress({stage:'retry',message:`결과가 서술된 원래 사건을 보완하고 이후 상태 다시 확인 중 (${source.index+1}/${narrative.events.length})`,graph:preview,activeNodeIds:[draftIds[source.index]!]});
              try{
                let accepted=false;
                for(let repairAttempt=0;repairAttempt<2;repairAttempt++){
                  const revised=await clarifyChapterEvent(request,{brief:approval.brief,event:sourceEvent,precedingEvents:preceding(source.index).slice(-2),priorFacts:facts.map(f=>({meaning:f.meaning,value:sourceState[f.atom]!})),followingEvents:narrative.events.slice(source.index+1),entities:approval.contract.entityLabels,problem,requiredNewResults:required},transport,options.signal);
                  const scope=await checkEventRevision(request,sourceEvent.summary,revised.summary,narrative.events.slice(source.index+1),transport,options.signal,preceding(source.index),required);
                  if(scope.scope==='preserved'){sourceEvent.summary=revised.summary;accepted=true;break;}
                  problem+=' Rejected clarification: '+JSON.stringify({summary:revised.summary,reason:scope.reason});
                }
                if(!accepted)throw Error('The clarification changed the original event role.');
              }catch(error){throw new StatefulPlanError('event-repair-attribution',{sourceIndex:source.index,reason:String(error),required});}
              options.coherenceTrace?.({type:'chapter-event-repair-attributed',sourceIndex:source.index,fromIndex:index,required,attempt:attributedRepairs});
              Object.assign(state,sourceState);mapped.splice(source.index);
              for(const [key,rejection] of declined)if(rejection.index>=source.index)declined.delete(key);
              index=source.index-1;
              continue eventLoop;
            }
            requiredNewResults=missing.map(({meaning,required})=>({meaning,required}));
            throw new Error('마지막 사건 후에도 요청된 결말 결과가 미완료입니다: '+JSON.stringify(missing)+'. 이미 끝난 과거 행동을 되돌리지 말고, 이번 마지막 사건의 역할 안에서 실제 결과를 명확히 완수하세요.');
          }
        }
        for(const change of changes)state[change.atom]=change.value;
        mapped.push({title:event.title,requires,changes});
        break;
      }catch(error){
        if(error instanceof ChapterSetupError)throw error;
        if(error instanceof StatefulPlanError&&error.code==='event-repair-attribution')throw error;
        feedback=String(error);
        await checkDesign(event.summary,feedback);
        if(attempt===1)throw new StatefulPlanError('event-interpretation',{event:event.summary,error:feedback});
        options.signal?.throwIfAborted();
        progress({stage:'retry',message:`이번 사건의 불명확한 부분만 보완 중 (${index+1}/${narrative.events.length})`,graph:preview,activeNodeIds:[draftIds[index]!]});
        // Reject a bad clarification while retaining the original private event.
        // A second local candidate is cheaper than discarding the entire route.
        for(let revisionAttempt=0;revisionAttempt<2;revisionAttempt++){
        const repairedText=await clarifyChapterEvent(request,{
          brief:approval.brief,event,precedingEvents:preceding(index).slice(-2),
          priorFacts:facts.map(f=>({meaning:f.meaning,value:state[f.atom]!})),
          followingEvents:narrative.events.slice(index+1),entities:approval.contract.entityLabels,
          problem:feedback,requiredNewResults,
        },transport,options.signal);
        const repaired={...event,...repairedText};
        const scope=await checkEventRevision(request,event.summary,repaired.summary,narrative.events.slice(index+1),transport,options.signal,preceding(index),requiredNewResults);
        if(scope.scope!=='preserved'){
          if(revisionAttempt===1)throw new StatefulPlanError('event-repair-role',{original:event.summary,revised:repaired.summary,reason:scope.reason,instruction:'Keep discoveries in their causal order. Rewrite only the unaccepted route; do not duplicate or advance later events to satisfy this local check.'});
          feedback+=' Rejected clarification: '+JSON.stringify({summary:repaired.summary,reason:scope.reason})+'. Revise the original event again without this violation. Refer to completed causes as past facts and narrate only their new consequences.';
          continue;
        }
        event.summary=repaired.summary;
        feedback='';
        break;
        }
      }
    }
  }
  if(options.localBranch){
    const mismatches=Object.entries(options.localBranch.joinState).filter(([atom,value])=>state[atom]!==value).map(([atom,required])=>({atom,meaning:facts.find(f=>f.atom===atom)?.meaning,required,actual:state[atom]}));
    if(mismatches.length)throw new StatefulPlanError('rejoin-state-mismatch',{mismatches,instruction:'Finish the local alternative at the same tracked state BEFORE the preserved continuation. Never force assignments or advance discoveries that still belong to the continuation.'});
  }
  const plan=baseline?appendStatefulStoryline(baseline,{segment:selected!.id,beats:mapped},endingId,outcomes):createStatefulSeed({title:narrative.title,opening:narrative.opening.title,beats:mapped},outcomes);
  const verified=validateStatefulPlan(approval,outcomes,plan,true);
  const scenes:Record<string,{summary:string;locationId:string;presentCharacters:string[]}>=Object.fromEntries(Object.entries(options.branch?.baseline.details.scenes??{}).map(([key,raw])=>{const s=raw as z.infer<typeof scene>;return [key,{summary:s.summary,locationId:s.locationId,presentCharacters:s.presentCharacters}];}));
  const strip=({summary,locationId,presentCharacters}:z.infer<typeof scene>)=>({summary,locationId,presentCharacters});
  if(!baseline){scenes.start={...strip(narrative.opening),summary:'이야기를 시작합니다.'};scenes.beat_base_1=strip(narrative.opening);}
  const added=plan.beats.filter(b=>!baseline?.beats.some(old=>old.key===b.key)).slice(baseline?0:1);
  if(branchPlay){
    const assessment=assessBranchPlay(branchPlay,mapped[0]!.changes);
    options.coherenceTrace?.({type:'chapter-branch-play-checked',fromKey:selected!.fromKey,toKey:added[0]!.key,
      ...assessment,plan:branchPlay,actualChanges:mapped[0]!.changes,summary:narrative.events[0]!.summary,
      // A proposal never supplies a missing effect. The validated old path is
      // retained if the writer or independent interpretation disagrees.
    });
  }
  for(const [i,beat] of added.entries())scenes[beat.key]=strip(narrative.events[i]!);
  const endingKey='end_'+endingId;
  // Ending labels describe only completed outcomes; all causal actions are in the route events.
  if(!scenes[endingKey])scenes[endingKey]={...strip(narrative.events.at(-1)!),summary:approval.contract.endings.find(e=>e.id===endingId)!.label};
  const result=materializeStatefulPlan(approval,outcomes,plan,{scenes});
  progress({stage:'review',message:'경로 실행 검사 완료 · 서사 일관성 검토 중',graph:{nodes:verified.skeleton.scenes.map(s=>({id:s.key,title:s.title})),edges:verified.skeleton.links.map(l=>({from:l.from,to:l.to}))}});
  return {plan,skeleton:result.skeleton,details:result.details};
}
