import {statefulRepairEvidence} from './stateful-repair-evidence.js';
import {z} from 'zod';
import type {ProgressSink} from '../src/generation-progress.js';
import { randomUUID } from 'node:crypto';
import { approveAuthorContract } from '../src/author-contract.js';
import { approveEndingOutcomes } from '../src/ending-outcomes.js';
import { StatefulStorylinePlanSchema, type StatefulStorylinePlan } from '../src/stateful-storyline-plan.js';
import { statefulAnchorMenu, planAtoms, statefulSeedSchema, createStatefulSeed, statefulExpansionSchema, appendStatefulStoryline, describeStatefulSegments, validateStatefulPlan, materializeStatefulPlan, statefulProseSchema, statefulSeedPrompt, statefulExpansionPrompt, StatefulPlanError } from '../src/stateful-storyline.js';
import { createStorylineMock } from '../src/storyline-mock.js';
import { OutlineGenerationError, type OutlineGenerationDiagnostic, type OutlineGenerationIssue } from './llm.js';
import { postJsonSafe } from './safe-http.js';
import type { GenerateRequest } from './request-schema.js';
import type {SymbolicStoryPayload} from '../src/symbolic-story-payload.js';

type Messages = Array<{role:'system'|'user'|'assistant';content:string}>;
export type IncrementalGenerationOptions={singleRoute?:boolean;branch?:{baseline:SymbolicStoryPayload;fromKey:string;endingId:string;instruction:string};signal?:AbortSignal};
export async function generateStatefulPlanOutcomes(request: GenerateRequest, transport = postJsonSafe, progress:ProgressSink = ()=>{}, recovery?:unknown, options:IncrementalGenerationOptions={}) {
  if (request.responseMode !== 'narrative-plan-outcomes' || !request.brief || !request.approvedContract || !request.playerId || !request.approvalRevision || !request.approvedOutcomeInitialState || !request.approvedEndingOutcomes) throw new Error('승인된 Contract와 결말 결과가 필요합니다.');
  const approval = approveAuthorContract(request.brief, request.approvedContract, request.playerId, request.approvalRevision);
  const outcomes = approveEndingOutcomes(approval, approval.revision, request.approvedOutcomeInitialState, request.approvedEndingOutcomes);
  const correlationId = randomUUID();
  let transportCalls = 0, schemaFallbackCalls = 0;
  let planAttempts: 1|2|3 = 1;
  let detailAttempts: 1|2 = 1;
  let first: OutlineGenerationIssue | null = null;
  const artifacts: Array<{stage:string;rawText:string;outputChannel:string}> = [];
  const diagnostic = (final: OutlineGenerationIssue | null): OutlineGenerationDiagnostic => ({correlationId,first,final,semanticGenerationAttempts:detailAttempts,repairUsed:detailAttempts===2,planAttempts,planRepairUsed:planAttempts>1,transportCalls,schemaFallbackCalls});
  const fail = (issue: OutlineGenerationIssue, raw?:string) => new OutlineGenerationError(diagnostic(issue),raw);
  const call = async (messages: Messages, schema: Record<string,unknown>, stage: string) => {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(),300_000);
    const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
    const select = (message: {content?:string;thinking?:string;reasoning?:string}) => {
      for (const outputChannel of ['content','thinking','reasoning'] as const) if (message[outputChannel]?.trim()) return {rawText:message[outputChannel]!,outputChannel};
      throw new Error('empty-output');
    };
    try {
      const endpoint = new URL(request.endpoint);
      const temperature = stage === 'narrative_prose' ? 0 : request.temperature;
      if (endpoint.port === '11434') {
        transportCalls++;
        const data = await transport(endpoint.origin+'/api/chat',{model:request.model,messages,think:false,stream:false,format:schema,options:{temperature,num_ctx:16384,num_predict:4096}},{},controller.signal) as {message?:{content?:string;thinking?:string;reasoning?:string}};
        return select(data.message??{});
      }
      const once = async (fallback:boolean) => {
        transportCalls++;
        const data = await transport((() => { const url = new URL(request.endpoint); const path = url.pathname.replace(/\/$/, ''); if (!path.endsWith('/chat/completions')) url.pathname = path + '/chat/completions'; return url.toString(); })(),{model:request.model,messages:fallback?[...messages,{role:'system',content:'Required JSON Schema: '+JSON.stringify(schema)}]:messages,temperature,max_tokens:4096,response_format:fallback?{type:'json_object'}:{type:'json_schema',json_schema:{name:stage,strict:true,schema}}},request.apiKey?{Authorization:'Bearer '+request.apiKey}:{},controller.signal) as {choices?:Array<{message?:{content?:string;thinking?:string;reasoning?:string}}>};
        return select(data.choices?.[0]?.message??{});
      };
      try { return await once(false); }
      catch (error) { if (!(error instanceof Error) || !/(json_schema.*(?:unsupported|not supported)|(?:unsupported|not supported).*json_schema)/i.test(error.message)) throw error; schemaFallbackCalls++; return once(true); }
    } finally {clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);}
  };
  const part = async <T>(messages: Messages,schema:Record<string,unknown>,stage:string,validate:(raw:unknown)=>T) => {
    const actionPart=stage==='stateful_seed'||stage==='stateful_expansion';
    if(actionPart){
      // Visible planning space for non-thinking local models; it never changes the verifier's semantics.
      schema={...schema,required:['executionAnalysis',...(schema.required as string[])],properties:{executionAnalysis:{type:'string',minLength:1,maxLength:2400},...(schema.properties as Record<string,unknown>)}};
      messages=[{role:'system',content:messages[0]!.content+' Before the other fields, include executionAnalysis: briefly simulate the actions in order from the supplied current state, explain which EARLIER action supports each non-initial requirement, and check ALL final clauses and competing endings. If a supporting action is missing, include it in beats. This is a planning explanation, never a replacement for the actual events. For an expansion, also execute the immutable suffix in this check.'},...messages.slice(1)];
    }
    let invalid: {rawText:string;evidence:string}|undefined;
    const maximum = stage==='narrative_prose' ? 2 : 3;
    for(let attempt=1;attempt<=maximum;attempt++) {
      if(attempt>1) progress({stage:stage==='narrative_prose'?'prose':'retry',message:stage==='narrative_prose'?'장면 내용을 다시 작성하고 있습니다.':'현재 경로를 다시 구성하고 있습니다.'});
      if(attempt>1) {if(stage==='narrative_prose')detailAttempts=2;else planAttempts=Math.max(planAttempts,attempt) as 1|2|3;}
      let selected:Awaited<ReturnType<typeof call>>;
      try {selected=await call(invalid?[...messages,{role:'assistant',content:invalid.rawText},{role:'user',content:'Your previous candidate part was REJECTED; none of its newly proposed events has been accepted. Rewrite that failed part to fix ALL listed errors. Keep ONLY the graph accepted before this candidate immutable, plus approved initial state and endings. Do not repeat the rejected output.\nExecution/validation evidence:\n'+invalid.evidence+'\nDo not delete approved paths or change ending conditions. '+(stage==='stateful_expansion'?'Keep the selected segment fixed. Your first NEW event starts in stateAfterPrefix; do not replay any prefix event. A failed attempt or departure may correctly have no effects.':stage==='stateful_anchor'?'Return one allowed segment ID only, without events.':'Rewrite the entire rejected part within its schema to cover every missing obligation.')}]:messages,schema,stage);}
      catch(error){throw fail({stage:stage==='narrative_prose'?'detail-provider':'plan-provider',code:error instanceof Error&&error.message==='empty-output'?'empty-output':'request-failed'});}
      artifacts.push({stage,...selected});
      try{
        const parsed:unknown=JSON.parse(selected.rawText);
        if(actionPart&&parsed&&typeof parsed==='object'&&'executionAnalysis' in parsed){
          z.string().min(1).max(2400).parse(parsed.executionAnalysis);
          const {executionAnalysis: _analysis,...candidate}=parsed;
          return {value:validate(candidate),...selected};
        }
        return {value:validate(parsed),...selected};
      }
      catch(error){
        const issue:OutlineGenerationIssue={stage:stage==='narrative_prose'?'detail-parse':error instanceof StatefulPlanError?'plan-verifier':'plan-parse',code:error instanceof StatefulPlanError?error.code:error instanceof SyntaxError?'invalid-json':stage==='narrative_prose'?'detail-parse':'plan-parse'};
        first??=issue;
        if(attempt===maximum)throw fail(issue,selected.rawText);
        invalid={rawText:selected.rawText,evidence:statefulRepairEvidence(error)};
      }
    }
    throw new Error('Unreachable retry');
  };
  if(request.mode==='mock') {
    const old=createStorylineMock(approval,outcomes);
    const plan=StatefulStorylinePlanSchema.parse({...old.plan,format:'stateful-storylines-v2',beats:old.plan.beats.map((beat)=>({ ...beat,precondition:{all:[]},effects:Object.values(old.details.scenes).flatMap((scene)=>((scene as {actions?:Array<{to:string;effects:unknown[]}>}).actions??[])).find((action)=>action.to===beat.key)?.effects??[] }))});
    const {skeleton,details}=validateStatefulPlan(approval,outcomes,plan,true);
    return {plan,skeleton,details,rawPlanText:JSON.stringify(plan),rawDetailsText:JSON.stringify(details),outputChannels:{plan:'mock',details:'mock'},approvalRevision:approval.revision,planAttempts,detailAttempts,telemetry:diagnostic(null)};
  }
  const atoms=planAtoms(outcomes).map((a)=>({...a,meaning:[...approval.contract.stateSymbols,...approval.contract.relationshipSymbols].find((s)=>s.id===a.ref.symbol)?.meaning}));
  const requestedEnding=(id:string)=>outcomes.outcomes.find((o)=>o.endingId===id)!;
  const compactEnding=(id:string)=>({endingId:id,label:approval.contract.endings.find((e)=>e.id===id)!.label,requires:requestedEnding(id).condition.all.map((c)=>({atom:atoms.find((a)=>JSON.stringify(a.ref)===JSON.stringify(c.ref))!.atom,value:c.value}))});
  const recoveryContext=recovery?'\nPrevious draft failed review. Address these concrete findings while preserving the approved contract and ending conditions. Regenerate the story paths to avoid the same defects; do not erase required choices or force states.\n'+JSON.stringify(recovery):'';
  const executionGuide = (initial: Array<{atom:string;value:boolean|number}>, endingId:string) => '\nExecution worksheet (not an instruction to assign target values):\n'+JSON.stringify({
    stateBeforeFirstNewAction:initial,
    targetFacts:compactEnding(endingId).requires,
    rules:[
      'Walk through actions in order using ONLY the current state. For every requirement, identify initial truth or a PRIOR successful action that establishes it.',
      'A result produced by the current action belongs in changes, not in requires. If it is genuinely needed to perform the action, keep the requirement and add an earlier plausible enabling action.',
      'Apply changes only AFTER requirements hold, then check the next action. Never assume the ending or a later action already occurred.',
      'Do not invent acquisition, trust, consent or rescue simply to satisfy a target. Describe the actual enabling action in its title. No necessary guard deletion.',
      'Return titles in the language of the brief. Distinct choices require distinct actions and descriptive titles.',
    ],
  });
  const context=recoveryContext+'\nBrief:\n'+approval.brief+'\nApproved entities and display names:\n'+JSON.stringify({entities:approval.contract.entities,labels:approval.contract.entityLabels})+'\nAtom table (initial values locked):\n'+JSON.stringify(atoms)+'\nApproved ending conditions (locked):\n'+JSON.stringify(outcomes.outcomes.map((o)=>compactEnding(o.endingId)));
  progress({stage:"seed",message:options.branch?"선택한 사건의 기존 경로 확인 중":"첫 경로 생성 중",reset:true});
  const seed=options.branch?{value:StatefulStorylinePlanSchema.parse(options.branch.baseline.plan),outputChannel:'preserved'}:await part([{role:'system',content:statefulSeedPrompt+(options.singleRoute?' Write 4-6 meaningful actions for this first route: encounter the obstacle, respond to it, earn the revelation or turning point, then make the final choice. Do not jump from asking a question straight to an unearned confession. Name concrete evidence or motives from the author background in titles. Author background is not initial player knowledge.':'')},{role:'user',content:context+executionGuide(atoms,approval.contract.endings[0]!.id)+'\nRequested first ending: '+JSON.stringify(compactEnding(approval.contract.endings[0]!.id))}],statefulSeedSchema(outcomes),'stateful_seed',(raw)=>{
    const plan=createStatefulSeed(raw,outcomes);validateStatefulPlan(approval,outcomes,plan);return plan;
  });
  let plan:StatefulStorylinePlan=seed.value;
  const showGraph=()=>{const {skeleton}=validateStatefulPlan(approval,outcomes,plan);return {nodes:skeleton.scenes.map(s=>({id:s.key,title:s.title})),edges:skeleton.links.map(l=>({from:l.from,to:l.to}))};};
  progress({stage:"expansion",message:"첫 경로 구성 완료",graph:showGraph()});
  const expansionEndings=options.branch?[options.branch.endingId]:options.singleRoute?[]:Array.from({length:Math.max(2,approval.contract.endings.length)-1},(_,i)=>approval.contract.endings[(i+1)%approval.contract.endings.length]!.id);
  for(const [offset,endingId] of expansionEndings.entries()) {
    const index=offset+1;
    progress({stage:"expansion",message:`다른 경로 추가 중 (${index+1}/${Math.max(2,approval.contract.endings.length)})`,graph:showGraph()});
    const menu=statefulAnchorMenu(approval,outcomes,plan,endingId);
    if(options.branch)menu.segments=menu.segments.filter(s=>s.fromKey===options.branch!.fromKey);
    if(!menu.segments.length)throw new StatefulPlanError('no-expansion-segment',{});
    const anchor=await part([{role:'system',content:'Choose ONLY one branching segment for a new storyline. Return {segment: exact segment ID}. Do not write events. prefixStateId references the actual state AFTER the listed prefix has already executed; the immutable suffix executes after the new events. Prefer a plausible unused decision point or a branch within an alternative route. Avoid undoing established knowledge, sacrifices or successful rescues merely to force an ending. Prefer a prefix compatible with the requested outcome. Reconvergence is optional; do not use a suffix that prevents the requested ending.'},{role:'user',content:context+'\nAccepted events and available anchor segments:\n'+JSON.stringify(menu)+'\nRequested new ending: '+JSON.stringify(compactEnding(endingId))}],{type:'object',additionalProperties:false,required:['segment'],properties:{segment:{type:'string',enum:menu.segments.map(s=>s.id)}}},'stateful_anchor',raw=>{
      const value=z.object({segment:z.string()}).strict().parse(raw);
      if(!menu.segments.some(s=>s.id===value.segment))throw new StatefulPlanError('invalid-segment',{allowed:menu.segments.map(s=>s.id)});
      return value.segment;
    });
    const selected=describeStatefulSegments(approval,outcomes,plan).find(s=>s.id===anchor.value)!;
    const schema=statefulExpansionSchema(plan,outcomes);
    const expansion=await part([{role:'system',content:statefulExpansionPrompt+' The segment is already selected and LOCKED. Return only new actions AFTER the supplied prefix state, never replay that prefix. An unsuccessful attempt or departure can have no state changes; do not invent successful rescue or payment. All listed accepted event titles are existing events, not events to copy.'},{role:'user',content:context+executionGuide(selected.stateAfterPrefix as Array<{atom:string;value:boolean|number}>,endingId)+'\nLocked segment (prefix is already executed):\n'+JSON.stringify(selected)+'\nExisting event titles (do not repeat): '+JSON.stringify(plan.beats.map(b=>b.title))+'\nRequested new ending: '+JSON.stringify(compactEnding(endingId))+(options.branch?'\nAuthor branch request: '+options.branch.instruction:'')}],{...schema,properties:{...schema.properties,segment:{type:'string',enum:[selected.id]}}},'stateful_expansion',(raw)=>{
      if(!raw||typeof raw!=='object'||!('segment' in raw)||raw.segment!==selected.id)throw new StatefulPlanError('locked-segment',{expected:selected.id});
      const candidate=appendStatefulStoryline(plan,raw,endingId,outcomes);validateStatefulPlan(approval,outcomes,candidate);return candidate;
    });
    plan=expansion.value;
    progress({stage:"expansion",message:`${index+1}개 경로 구성 완료`,graph:showGraph()});
  }
  const verified=validateStatefulPlan(approval,outcomes,plan,true);
  const rawPlanText=JSON.stringify(artifacts);
  if(options.singleRoute||options.branch) {
    const scenes:Record<string,{summary:string;locationId:string;presentCharacters:string[]}>={};
    for(const [key,scene] of Object.entries(options.branch?.baseline.details.scenes??{})) {
      const s=scene as {summary:string;locationId:string;presentCharacters:string[]};
      scenes[key]={summary:s.summary,locationId:s.locationId,presentCharacters:[...s.presentCharacters]};
    }
    const missing=verified.skeleton.scenes.filter(s=>!scenes[s.key]);
    for(let i=0;i<missing.length;i+=2) {
      const chunk=missing.slice(i,i+2);
      progress({stage:'prose',message:`새 장면 작성 중 (${Math.min(i+2,missing.length)}/${missing.length})`,graph:showGraph(),activeNodeIds:chunk.map(s=>s.key)});
      const sceneSchema={type:'object',additionalProperties:false,required:['summary','locationId','presentCharacters'],properties:{summary:{type:'string',minLength:1,maxLength:1200},locationId:{enum:approval.contract.entities.locations},presentCharacters:{type:'array',items:{enum:approval.contract.entities.characters},minItems:1,maxItems:8}}};
      const schema={type:'object',additionalProperties:false,required:['scenes'],properties:{scenes:{type:'object',additionalProperties:false,required:chunk.map(s=>s.key),properties:Object.fromEntries(chunk.map(s=>[s.key,sceneSchema]))}}};
      const raw=await part([{role:'system',content:'Write only the requested scene summaries in the brief language. One or two sentences each. A beat describes the result AFTER its action, not a suggestion or future action. Follow its exact preconditions/effects and concrete title. Do not invent additional discoveries, confessions, possessions or changes. Keep the player present. The start is a neutral arrival. An ending summarizes only that route outcome. Use only supplied IDs. Return {scenes:{key:{summary,locationId,presentCharacters}}}.'},{role:'user',content:context+'\nRequested scenes: '+JSON.stringify(chunk.map(s=>({...s,event:plan.beats.find(b=>b.key===s.key)})))+'\nRoute events: '+JSON.stringify(plan.storylines.map(l=>({endingId:l.endingId,titles:l.steps.map(s=>plan.beats.find(b=>b.key===s.beatKey)!.title)})))}],schema,'narrative_prose',raw=>{
        const item=z.object({summary:z.string().min(1).max(1200),locationId:z.enum(approval.contract.entities.locations as [string,...string[]]),presentCharacters:z.array(z.enum(approval.contract.entities.characters as [string,...string[]])).min(1).max(8)}).strict();
        const parsed=z.object({scenes:z.object(Object.fromEntries(chunk.map(s=>[s.key,item]))).strict()}).strict().parse(raw);
        if(Object.values(parsed.scenes).some(s=>!s.presentCharacters.includes(approval.playerId)))throw new Error('Player must be present');
        return parsed.scenes;
      });
      Object.assign(scenes,raw.value);
    }
    const result=materializeStatefulPlan(approval,outcomes,plan,{scenes});
    return {plan,skeleton:result.skeleton,details:result.details,rawPlanText,rawDetailsText:JSON.stringify(scenes),outputChannels:{plan:seed.outputChannel,details:'incremental'},approvalRevision:approval.revision,planAttempts,detailAttempts,telemetry:diagnostic(null)};
  }
  progress({stage:"prose",message:"전체 장면의 내용 작성 중",graph:showGraph()});
  const prose=await part([{role:'system',content:'Write concise scene descriptions for an ALREADY VERIFIED executable story plan. Return only {scenes:{sceneKey:{summary,locationId,presentCharacters}}}. Include exactly every supplied scene, with the approved player present. Conditions, effects and topology are locked and must NOT appear in your output. A beat describes the state AFTER its own changes. At shared scenes, do not assert route-specific knowledge or possession as universal. Do not invent extra discoveries or state changes. Use approved entities and the language of the brief. One or two sentences per scene.'},{role:'user',content:context+'\nVerified plan:\n'+JSON.stringify(plan)+'\nScene keys and links:\n'+JSON.stringify(verified.skeleton)}],statefulProseSchema(approval,outcomes,plan),'narrative_prose',(raw)=>materializeStatefulPlan(approval,outcomes,plan,raw));
  return {plan,skeleton:prose.value.skeleton,details:prose.value.details,rawPlanText,rawDetailsText:prose.rawText,outputChannels:{plan:seed.outputChannel,details:prose.outputChannel},approvalRevision:approval.revision,planAttempts,detailAttempts,telemetry:diagnostic(null)};
}
