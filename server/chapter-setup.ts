import {SYMBOLIC_ASSIGNMENT_LIMIT} from '../src/symbolic-graph.js';
import {z} from 'zod';
import {parseAuthorContract} from '../src/author-contract.js';
import type {GenerateRequest} from './request-schema.js';
import {postJsonSafe,LlmHttpError} from './safe-http.js';
import {setTimeout as retryDelay} from 'node:timers/promises';
import {CHAPTER_ENDING_LABEL_LIMIT,explicitChapterEndings} from '../src/chapter-brief.js';
import {chapterFactDictionary} from './chapter-fact-dictionary.js';
import {ChapterSetupError} from './chapter-setup-error.js';
import {reviewChapterVocabulary} from './chapter-vocabulary-review.js';
import {anthropicChapterSchema} from './chapter-provider-schema.js';
import {chapterJsonIssues,ChapterJsonFormatError,protectedJsonFields,changedProtectedFields} from './chapter-json-validation.js';

const Name=z.string().trim().min(1).max(100);
export const CHAPTER_FACT_LIMIT=SYMBOLIC_ASSIGNMENT_LIMIT;
/** More endings need more outcome distinctions, not an unlimited inventory of incidental actions. */
export const chapterFactBudget=(endings:number)=>Math.min(CHAPTER_FACT_LIMIT,Math.max(12,6+endings*3));
export const CompactChapterSetup=z.object({
  player:Name,characters:z.array(Name).min(1).max(8),items:z.array(Name).max(10),locations:z.array(Name).min(1).max(8),
  facts:z.array(z.object({meaning:z.string().trim().min(1).max(300),subject:Name}).strict()).min(1).max(CHAPTER_FACT_LIMIT),
  endings:z.array(z.string().trim().min(1).max(CHAPTER_ENDING_LABEL_LIMIT)).min(1).max(6),
}).strict();
const nameSchema={type:'string',minLength:1,maxLength:100};
export const compactChapterSetupSchema={type:'object',additionalProperties:false,required:['player','characters','items','locations','facts','endings'],properties:{
  player:nameSchema,characters:{type:'array',minItems:1,maxItems:8,items:nameSchema},items:{type:'array',maxItems:10,items:nameSchema},locations:{type:'array',minItems:1,maxItems:8,items:nameSchema},
  facts:{type:'array',minItems:1,maxItems:CHAPTER_FACT_LIMIT,items:{type:'object',additionalProperties:false,required:['meaning','subject'],properties:{meaning:{type:'string',minLength:1,maxLength:300},subject:nameSchema}}},
  endings:{type:'array',minItems:1,maxItems:6,items:{type:'string',minLength:1,maxLength:CHAPTER_ENDING_LABEL_LIMIT}},
}};

/** IDs, arity and subject references are mechanical. Meanings and endings are never rewritten. */
export function compileChapterSetup(raw:unknown) {
  const data=CompactChapterSetup.parse(raw);
  const unique=(values:string[])=>[...new Set(values)];
  const characters=unique(data.characters),items=unique(data.items),locations=unique(data.locations);
  if(!characters.includes(data.player))throw new Error('주인공이 등장인물에 없습니다.');
  const labels=[...characters.map((label,i)=>({label,id:label===data.player?'player':`person_${i+1}`})),...items.map((label,i)=>({label,id:`item_${i+1}`})),...locations.map((label,i)=>({label,id:`place_${i+1}`}))];
  const facts=data.facts.map((fact,i)=>{
    const subjects=labels.filter(l=>l.label===fact.subject);
    if(subjects.length!==1)throw new Error(`사실의 주체가 모호하거나 없습니다: ${fact.subject}`);
    return {id:`fact_${i+1}`,meaning:fact.meaning,type:'boolean' as const,parameterCount:1 as const,subjectId:subjects[0]!.id};
  });
  if(new Set(facts.map(f=>f.meaning)).size!==facts.length)throw new Error('같은 의미의 사실이 중복되었습니다.');
  const contract=parseAuthorContract({entityLabels:labels,entities:{characters:labels.slice(0,characters.length).map(l=>l.id),items:labels.slice(characters.length,characters.length+items.length).map(l=>l.id),locations:labels.slice(characters.length+items.length).map(l=>l.id)},stateSymbols:facts.map(({subjectId,...s})=>s),relationshipSymbols:[],endings:unique(data.endings).map((label,i)=>({id:`ending_${i+1}`,label}))});
  return {contract,playerId:'player',subjects:facts.map(f=>({symbol:f.id,args:[f.subjectId],meaning:f.meaning}))};
}

export async function chapterJson(request:Pick<GenerateRequest,'endpoint'|'model'|'apiKey'>,messages:GenerateRequest['messages'],schema:Record<string,unknown>,transport=postJsonSafe,signal?:AbortSignal,maxTokens=2200,deliberate=false) {
  let next=messages,limit=maxTokens,protectedFields:ReturnType<typeof protectedJsonFields>=[],transientRetries=0;
  for(let attempt=0;attempt<3;){
    signal?.throwIfAborted();
    try{
      const result=await chapterJsonOnce(request,next,schema,transport,signal,limit,deliberate);
      const changed=changedProtectedFields(result,protectedFields);
      if(changed.length)throw new ChapterJsonFormatError(changed.join('\n'),JSON.stringify(result));
      return result;
    }
    catch(error){
      signal?.throwIfAborted();
      // Retry the same request, not the story or its verdict. Keep retries at
      // this layer so the transport journal and API budget count EVERY call.
      if(error instanceof LlmHttpError&&[429,502,503,504,520,529].includes(error.status)&&transientRetries<2&&(error.retryAfterMs??0)<=15000){
        const delay=Math.max(error.retryAfterMs??0,750*2**transientRetries++);
        await retryDelay(delay,undefined,{signal});
        continue;
      }
      if(!(error instanceof ChapterJsonFormatError)||attempt===2)throw error;
      if(attempt===0){try{protectedFields=protectedJsonFields(JSON.parse(error.content),schema);}catch{/* Incomplete JSON has no trustworthy parsed fields. */}}
      if(error.truncated)limit=Math.min(8000,Math.max(limit+512,limit*2));
      next=[...messages,{role:'user',content:'The last response violated the required JSON format. Repair only these format issues; preserve factual conclusions, uncertainty, failed judgments, actors, and state values. Never turn a failed check into a pass. Keep explanations concise (prefer Korean), and return the complete object. Issues: '+error.message+'\nValid fields that must stay unchanged: '+JSON.stringify(protectedFields)+'\nPrevious response: '+error.content.slice(0,16000)}];
      attempt++;
    }
  }
  throw new Error('모델 응답 형식을 복구하지 못했습니다.');
}

async function chapterJsonOnce(request:Pick<GenerateRequest,'endpoint'|'model'|'apiKey'>,messages:GenerateRequest['messages'],schema:Record<string,unknown>,transport=postJsonSafe,signal?:AbortSignal,maxTokens=2200,deliberate=false) {
  messages=[...messages,{role:'system',content:'Return exactly this JSON structure. All fields are described by the schema; do not rename or omit required fields. JSON Schema: '+JSON.stringify(schema)}];
  signal?.throwIfAborted();
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,180000);
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const url=new URL(request.endpoint),headers:Record<string,string>=request.apiKey?{Authorization:'Bearer '+request.apiKey}:{};
    let content:string|undefined;
    if(url.port==='11434'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
      const thinking=deliberate&&/^qwen3(?:\.5)?(?::|-)/i.test(request.model);
      const result=await transport(url.origin+'/api/chat',{model:request.model,messages:thinking?[...messages,{role:'system',content:'This is one narrow classification. Reason briefly in at most 200 tokens, then return the JSON answer. Do not enumerate unrelated alternate stories.'}]:messages,think:thinking,stream:false,format:schema,options:{temperature:0,num_ctx:16384,num_predict:thinking?Math.max(4096,maxTokens+2048):maxTokens}},headers,controller.signal) as {message?:{content?:string};done_reason?:string};
      if(result.done_reason==='length')throw new ChapterJsonFormatError('모델 출력 길이를 초과했습니다.',result.message?.content??'',true);
      content=result.message?.content;
    } else if(url.protocol==='https:'&&url.hostname==='api.anthropic.com') {
      const result=await transport('https://api.anthropic.com/v1/messages',{
        // Thinking consumes the provider's output allowance as well as JSON.
        model:request.model,max_tokens:Math.max(2048,maxTokens+2048),
        system:messages.filter(message=>message.role==='system').map(message=>message.content).join('\n\n'),
        messages:messages.filter(message=>message.role!=='system'),
        output_config:{...(request.model==='claude-haiku-5-5'?{effort:deliberate?'medium':'low'}:{}),format:{type:'json_schema',schema:anthropicChapterSchema(schema)}},
      },{'x-api-key':request.apiKey??'','anthropic-version':'2023-06-01'},controller.signal) as {content?:Array<{type:string;text?:string}>;stop_reason?:string};
      if(result.stop_reason==='max_tokens')throw new ChapterJsonFormatError('모델 출력 길이를 초과했습니다.',result.content?.filter(block=>block.type==='text').map(block=>block.text??'').join('')??'',true);
      content=result.content?.filter(block=>block.type==='text').map(block=>block.text??'').join('');
    } else {
      if(!url.pathname.endsWith('/chat/completions'))url.pathname=url.pathname.replace(/\/$/,'')+'/chat/completions';
      const options=url.hostname==='api.openai.com'&&/^gpt-6(?:\.|-|$)/.test(request.model)
        ?{max_completion_tokens:deliberate&&maxTokens>=5000?maxTokens*2+2048:Math.max(deliberate?4096:1024,maxTokens+1024),reasoning_effort:deliberate?'medium':'low'}:{temperature:0,max_tokens:maxTokens};
      const result=await transport(url.toString(),{model:request.model,messages,...options,response_format:{type:'json_schema',json_schema:{name:'chapter_part',strict:true,schema}}},headers,controller.signal) as {choices?:Array<{message?:{content?:string};finish_reason?:string}>};
      if(result.choices?.[0]?.finish_reason==='length')throw new ChapterJsonFormatError('모델 출력 길이를 초과했습니다.',result.choices?.[0]?.message?.content??'',true);
      content=result.choices?.[0]?.message?.content;
    }
    let parsed:unknown;
    try{parsed=JSON.parse(content??'');}catch{throw new ChapterJsonFormatError('Invalid JSON; return exactly one JSON object.',content??'');}
    const issues=chapterJsonIssues(parsed,schema);
    if(issues.length)throw new ChapterJsonFormatError(issues.join('\n'),content??'');
    return parsed;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

export async function prepareChapterContract(request:GenerateRequest,transport=postJsonSafe,signal?:AbortSignal,onCoverage?:(index:number,total:number)=>void,setupFeedback='',onProgress?:(message:string)=>void) {
  const explicitEndings=explicitChapterEndings(request.brief!);
  const castSchema={type:'object',additionalProperties:false,required:['player','characters','items','locations','endings'],properties:{player:nameSchema,characters:{type:'array',maxItems:7,items:nameSchema},items:compactChapterSetupSchema.properties.items,locations:compactChapterSetupSchema.properties.locations,endings:compactChapterSetupSchema.properties.endings}};
  const cast=CompactChapterSetup.omit({facts:true}).extend({characters:z.array(Name).max(7)}).parse(await chapterJson(request,[{role:'system',content:'Extract only names and endings from this brief. player: protagonist name (플레이어 if unnamed). characters: other PEOPLE only. items: PORTABLE OBJECTS only. locations: ALL named places and rooms, at least one. A room is never an item. Keep original names; do not invent a player name. endings: retain every requested result distinction, including discovery source; propose 2-3 only when none are requested. Output Korean. No state rules yet.'},{role:'user',content:request.brief!}],castSchema,transport,signal,1600));
  // The model may paraphrase or omit an ending. An author's explicit list is authoritative.
  if(explicitEndings)cast.endings=explicitEndings;
  const characters=[...new Set([cast.player,...cast.characters])];
  const {items,locations}=cast;
  const subjects=[...new Set([...characters,...items,...locations])];
  const budget=chapterFactBudget(cast.endings.length);
  // Leave space for per-ending distinctions instead of asking a small model to
  // invent a near-budget inventory before it has checked any ending.
  const seedBudget=Math.min(budget,8);
  const factShape={type:'object',additionalProperties:false,required:['meaning','subject'],properties:{meaning:{type:'string',minLength:1,maxLength:300},subject:{type:'string',enum:subjects}}};
  const factsSchema={type:'object',additionalProperties:false,required:['facts'],properties:{facts:{type:'array',minItems:1,maxItems:seedBudget,items:factShape}}};
  let feedback=setupFeedback;
  for(let attempt=0;attempt<2;attempt++) {
    try{
      const raw=await chapterJson(request,[{role:'system',content:'결말 문장 하나에서 실제로 일어난 핵심 행동과 획득한 결과만 긍정 명제로 추출하세요. 한국어로 누가 누구에게 무엇을 했는지, 지식의 출처를 명확히 씁니다. 같은 내용을 중복하지 말고 결말에 없는 행동을 발명하지 마세요. 물건/장소의 존재, 위치, 배경, 계획은 제외합니다. 미달성은 해당 긍정 명제의 false로 표현할 것이므로 별도 부정형 사실을 만들지 마세요. 실제로 시도하여 실패한 회차가 명시된 경우에만 그 회차를 구분합니다. 가능한 한 1~3개로 충분하며 개수를 채우지 마세요. 이 단계는 첫 결말 하나만 다룹니다. 다른 결말의 누락 사실과 필요한 현재 상태는 뒤 단계에서 따로 보완합니다. subject는 선언된 주체를 선택하고 ID/초기값은 만들지 마세요.'},{role:'user',content:JSON.stringify({ending:cast.endings[0],characters,feedback})}],factsSchema,transport,signal,1800);
      const proposed=z.object({facts:CompactChapterSetup.shape.facts.max(seedBudget)}).strict().parse(raw);
      const dictionary=chapterFactDictionary(request,subjects,cast.player,transport,signal);
      const data={player:cast.player,characters,items,locations,endings:cast.endings,facts:dictionary.facts};
      for(const [index,fact] of proposed.facts.entries()){
        onProgress?.(`심볼의 의미와 중복 확인 중 (${index+1}/${proposed.facts.length})`);
        await dictionary.add(fact);
      }
      const missingSchema={type:'object',additionalProperties:false,required:['missingFacts'],properties:{missingFacts:{type:'array',maxItems:4,items:factShape}}};
      for(const [index,ending] of cast.endings.entries()){
        onCoverage?.(index+1,cast.endings.length);
        const missing=z.object({missingFacts:z.array(CompactChapterSetup.shape.facts.element).max(4)}).strict().parse(await chapterJson(request,[{role:'system',content:'Check ONE requested ending against the existing Boolean fact vocabulary. Resolve omitted actors and reflexive possessors from the FULL brief: the person learning a secret is not necessarily the owner of the wrongdoing. Name the actual owner explicitly instead of leaving a reflexive pronoun. Do not invent a new wrongdoing for the protagonist. Return missingFacts: only minimal extra propositions needed to represent the ACTUAL outcome and distinguish its stated method from other endings. A decision/intention to sacrifice is NOT actually dying; possessing a gun is NOT shooting someone; entering a records room is NOT discovering the truth there. Reuse existing meanings AND their false values; if already expressible, return []. A death fact set false expresses remaining alive; do not add a separate survival fact. Do not add a failed-outcome symbol for mere nonachievement or a method not chosen. Use the existing positive action/source fact set false for that. Rescue=false alone does NOT express a completed failed attempt; it is also true before any attempt. Preserve the stated triggering event or specific failure method that distinguishes this ending. For example, failure after a bridge collapses needs the actual collapse, not only escape=false. The fact must describe an observable event, not an ending-number flag. A negative method such as not falling can use the positive falling fact set false. Do not repeat an existing fact with different wording. Each new fact is one positive, concrete proposition with an exact declared subject. Distinguish current reversible conditions (write 현재 ... 있다) from completed historical actions. A character who escapes is no longer currently trapped, even if they were trapped at the start. Avoid negated or compound duplicates. Use Korean. When an ending explicitly requires multiple named people to be rescued or escape, ensure the outcome of each person is expressible, not merely their presence together. Check every decisive action explicitly stated in the ending, including subordinate clauses such as WHEN X HAPPENS, not just the final success/failure word. If that action is absent from the vocabulary, add it. A current location or merely remaining at a place does not represent completing a stated duration, waiting period or deadline. If an ending requires such a completed milestone, retain the completion/time criterion explicitly. This step adds outcome coverage, not optional gameplay detail.'},{role:'user',content:JSON.stringify({brief:request.brief,ending,otherEndings:cast.endings.filter(e=>e!==ending),facts:data.facts,subjects})}],missingSchema,transport,signal,650));
        for(const fact of missing.missingFacts)await dictionary.add(fact);

      }
      onProgress?.('심볼의 행동 주체·대상과 현재 상태 누락 확인 중');
      await reviewChapterVocabulary(request,dictionary,subjects,transport,signal);
      if(data.facts.length>budget)throw new ChapterSetupError('symbol-budget',{budget,facts:data.facts,instruction:'모든 결말의 구분은 유지하고 중복된 표현과 결말 판정용 복합 심볼, 불필요한 중간 행동을 줄여 다시 설계하세요. 긍정 사실의 false를 별도의 부정 심볼로 만들지 마세요.'});
      return {...compileChapterSetup(data),dictionaryRevisions:dictionary.revisions,deferredOutcomes:[...dictionary.deferredOutcomes].filter(meaning=>data.facts.some(f=>f.meaning===meaning))};
    }catch(error){signal?.throwIfAborted();feedback=String(error);if(attempt===1)throw error;}
  }
  throw new Error('설정을 준비하지 못했습니다.');
}
