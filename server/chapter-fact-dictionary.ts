import {z} from 'zod';
import {chapterJson} from './chapter-setup.js';
import {ChapterSetupError} from './chapter-setup-error.js';
import type {GenerateRequest} from './request-schema.js';
import {postJsonSafe} from './safe-http.js';
import {SYMBOLIC_ASSIGNMENT_LIMIT} from '../src/symbolic-graph.js';

export type ChapterDictionaryFact={meaning:string;subject:string};
export type ChapterDictionaryRevision={original:string;representation:string;facts:string[];reason:string};
const Meaning=z.string().trim().min(1).max(300);
const key=(value:string)=>value.trim().replace(/[.。]+$/u,'').replace(/\s+/gu,' ');
const representationKinds=['atomic','absence','conjunction','outcome_label'] as const;

/** Only private vocabulary is changed. No published IDs, values or routes are patched.
 * Matching proposes an index; an independent exact-pair check authorizes every merge.
 */
export function chapterFactDictionary(request:GenerateRequest,subjects:readonly string[],protagonist:string,transport=postJsonSafe,signal?:AbortSignal){
  const facts:ChapterDictionaryFact[]=[];
  const revisions:ChapterDictionaryRevision[]=[];
  const deferredOutcomes=new Set<string>();
  const resolved=new Map<string,ChapterDictionaryFact[]>();
  const ask=(system:string,input:unknown,schema:Record<string,unknown>,tokens=360)=>chapterJson(request,[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}],schema,transport,signal,tokens);
  const meaningSchema={type:'object',additionalProperties:false,required:['meaning'],properties:{meaning:{type:'string',minLength:1,maxLength:300}}};

  async function review(original:string,literals:Array<{meaning:string;value:boolean}>,boundEntity?:string){
    if(literals.length===1&&literals[0]!.value===false){
      // Compare two ordinary sentences directly. Small models sometimes ignore
      // a JSON false value and compare only the names of the propositions.
      const result=z.object({polarityRelation:z.enum(['opposite','same','different','unclear']),reason:z.string().max(400)}).strict().parse(await ask(
        '두 문장 A와 B의 논리 관계만 판단하세요. opposite: 정확히 같은 주체·행동·대상·출처·시점에 대해 하나는 성립, 다른 하나는 그 부정입니다. 예: "문을 열지 않았다"와 "문을 열었다"는 opposite입니다. same: 같은 의미의 문장. different: 서로 다른 행동/출처/시간이거나 단순 함의 관계. unclear: 판정 불가. "시도했으나 실패했다"와 "성공했다"는 opposite가 아닙니다. 실패 이력은 미시도와 다릅니다. 실제로 어느 문장이 참인지는 판단하지 마세요. 짧은 한국어 이유를 쓰세요.',
        {A:original,B:literals[0]!.meaning,...(boundEntity?{boundEntity,brief:request.brief}:{})},
        {type:'object',additionalProperties:false,required:['polarityRelation','reason'],properties:{polarityRelation:{type:'string',enum:['opposite','same','different','unclear']},reason:{type:'string',maxLength:400}}},420));
      return {accepted:result.polarityRelation==='opposite',reason:result.reason};
    }
    const shape={type:'object',additionalProperties:false,required:['dictionaryRelation','reason'],properties:{dictionaryRelation:{type:'string',enum:['equivalent','different','unclear']},reason:{type:'string',maxLength:400}}};
    const result=z.object({dictionaryRelation:z.enum(['equivalent','different','unclear']),reason:z.string().max(400)}).strict().parse(await ask(
      'Compare original with the ENTIRE proposed Boolean formula. Each literal is meaning=true or meaning=false, and all literals are ANDed. equivalent: the formula, including its Boolean values, has exactly the same meaning as original. A negative original and its positive proposition=false are equivalent, NOT different. A conjunction and its exact component literals are also equivalent. Ordinary AND grouping does not impose simultaneity or a single episode unless the original explicitly requires it. For example, a device activated the red and green lamps is equivalent to red-lamp activation AND green-lamp activation; do not invent a requirement that they activated in exactly the same instant. Both literals must be true, not alternative independent choices. Explicit causal or timing links still must be preserved. different: meaning changed or only one entails the other. unclear: insufficient wording. Preserve actor, patient, information source, method, time, current state versus completed history, initiation versus completion, causal links, and the exact failed attempt. Not succeeding includes not trying; a completed failed attempt does not. A death caused by a fall is NOT equivalent to having fallen AND being dead, which could have another cause. General knowledge differs from learning at a named source. Current possession differs from a past acquisition. Do not merge using remembered fiction or invented world rules. Use the brief and boundEntity only to resolve an omitted actor/patient; never add a causal restriction to a complete sentence. A paraphrase is fine. Decide semantic equivalence, not whether the story currently makes the formula true. Give a short Korean reason.',
      {original,proposed:literals,allRequiredTogether:literals.map(l=>l.value?l.meaning:"NOT TRUE: "+l.meaning).join(" AND "),...(boundEntity?{boundEntity,brief:request.brief}:{})},shape,420));
    return {accepted:result.dictionaryRelation==='equivalent',reason:result.reason};
  }

  async function intern(fact:ChapterDictionaryFact){
    // A unary grounding may refer to actor or patient, but not an unrelated cast
    // member. Preserve the proposition and ground each decomposed atom separately.
    const mentioned=subjects.filter(label=>fact.meaning.includes(label));
    if(mentioned.length&&!mentioned.includes(fact.subject)){
      const before=fact.subject;
      const bound=mentioned.length===1?mentioned[0]!:z.object({boundSubject:z.string()}).strict().parse(await ask(
        '이 명제의 심볼을 연결할 대상을 고르세요. candidates는 실제 명제에 등장하는 선언된 대상입니다. 보통 행동 주체나 상태를 가진 대상에 연결합니다. 주체가 선언되지 않은 경우 명시된 행동 대상에 연결할 수 있습니다. 명제 문장을 바꾸거나 등장하지 않는 인물에 연결하지 마세요.',
        {proposition:fact.meaning,candidates:mentioned},{type:'object',additionalProperties:false,required:['boundSubject'],properties:{boundSubject:{type:'string',enum:mentioned}}},80)).boundSubject;
      if(!mentioned.includes(bound))throw new ChapterSetupError('unrelated-fact-subject',{fact,proposed:bound});
      fact={...fact,subject:bound};
      revisions.push({original:fact.meaning,representation:'subject_binding',facts:[fact.meaning],reason:`명제에 없는 연결 대상 ${before}를 명제에 명시된 ${bound}로 교정함. 명제 자체는 보존함.`});
    }
    const exact=facts.find(existing=>key(existing.meaning)===key(fact.meaning));
    if(exact)return exact;
    if(facts.length){
      const shape={type:'object',additionalProperties:false,required:['dictionaryMatch','reason'],properties:{dictionaryMatch:{type:'integer',minimum:0,maximum:facts.length},reason:{type:'string',maxLength:240}}};
      const match=z.object({dictionaryMatch:z.number().int().min(0).max(facts.length),reason:z.string().max(240)}).strict().parse(await ask(
        'Select at most ONE existing proposition that means exactly the same as candidate, or is its exact logical opposite at the SAME time/scope. dictionaryMatch is its 1-based index, or 0 if none. Do not select mere implications, similar topics, different sources/methods, current possession versus past acquisition, attempt versus success, or a failed attempt versus simple absence of success. A general rescue and rescue by a specific method are different. Do not infer equivalence from story-specific coincidences. Ignore subject binding differences: the complete sentence specifies the actual actor and patient. Output only a candidate index and a short Korean reason; another check will verify it.',
        {candidate:fact.meaning,existing:facts.map((entry,index)=>({index:index+1,meaning:entry.meaning}))},shape,280));
      if(match.dictionaryMatch){
        const existing=facts[match.dictionaryMatch-1]!;
        const same=await review(fact.meaning,[{meaning:existing.meaning,value:true}]);
        if(same.accepted){revisions.push({original:fact.meaning,representation:'reuse',facts:[existing.meaning],reason:same.reason});return existing;}
        // Exact opposites share one Boolean only after a separate polarity check.
        const opposite=await review(fact.meaning,[{meaning:existing.meaning,value:false}]);
        if(opposite.accepted){revisions.push({original:fact.meaning,representation:'complement',facts:[existing.meaning],reason:opposite.reason});return existing;}
      }
    }
    if(facts.length>=SYMBOLIC_ASSIGNMENT_LIMIT+6)throw new ChapterSetupError('symbol-budget',{facts,candidate:fact,instruction:'공개 전 사전 정리의 임시 한도입니다. 결말 판정용 복합 상태와 불필요한 중간 상태를 줄여 재설계하세요.'});
    facts.push(fact);return fact;
  }

  async function add(fact:ChapterDictionaryFact):Promise<ChapterDictionaryFact[]>{
    signal?.throwIfAborted();
    if(!subjects.includes(fact.subject))throw new ChapterSetupError('unknown-fact-subject',{fact});
    const rawKey=fact.subject+'\0'+key(fact.meaning);
    if(resolved.has(rawKey))return resolved.get(rawKey)!;
    const exact=facts.find(existing=>key(existing.meaning)===key(fact.meaning));
    if(exact)return [exact];
    // Do not ask a writer to rewrite an already explicit fact. That invited
    // plausible but different facts from the surrounding brief into the dictionary.
    const subjectShape={type:'object',additionalProperties:false,required:['subjectExplicit'],properties:{subjectExplicit:{type:'boolean'}}};
    const {subjectExplicit}=z.object({subjectExplicit:z.boolean()}).strict().parse(await ask(
      '이 명제만 읽었을 때 실제 행위자 또는 상태를 가진 주체가 명시되어 있습니까? 명시된 이름이나 역할이 있으면 true. 수동문은 구조받는 대상처럼 상태의 주체가 명시돼 있으면 true. 행위의 목적어나 장소만 있고 행동 주체가 생략됐으면 false. 다른 이야기에서 주체를 추측하지 말고 문장에 적혀 있는지만 답하세요.',
      {fact:fact.meaning},subjectShape,40));
    let named=fact.meaning;
    if(!subjectExplicit){
     let feedback='',accepted=false;
     for(let attempt=0;attempt<2;attempt++){
      const {subjectPrefix}=z.object({subjectPrefix:z.string().trim().min(1).max(100)}).strict().parse(await ask(
      '명제의 앞에 붙일 생략된 주체와 조사만 쓰세요. 예: "연구원은", "장치가". 기존 명제나 술어를 다시 쓰지 마세요. 코드는 subjectPrefix + 공백 + 기존 명제로 연결하므로 인과관계·시제·부정·완료 표현은 그대로 보존됩니다. 실제 행위자/상태 주체는 brief에서 파악합니다. boundEntity는 심볼의 연결 대상이며 반드시 행위자는 아닙니다. 조사 대상이 조사한 사람이 되면 안 됩니다. 피동문은 구조받거나 사살된 대상을 주체로 씁니다.',
      {fact:{meaning:fact.meaning},boundEntity:fact.subject,protagonist,brief:request.brief,feedback},{type:'object',additionalProperties:false,required:['subjectPrefix'],properties:{subjectPrefix:{type:'string',minLength:1,maxLength:100}}},120));
      named=Meaning.parse(subjectPrefix+' '+fact.meaning);
      const checked=z.object({subjectBinding:z.enum(['correct','wrong','unclear']),reason:z.string().max(300)}).strict().parse(await ask(
       '확인할 것은 생략된 주체의 복원뿐입니다. incompleteFact의 술어는 그대로 유지됩니다. source와 boundEntity를 함께 읽고 subjectPrefix가 실제 행위자 또는 상태를 가진 대상인지 판단하세요. correct: 생략된 주체를 올바르게 복원함. wrong: 조사 대상이 조사자가 됨, 구조받는 대상이 구조자가 됨, 소유자/지식 주체가 뒤바뀜 등. unclear: 복원할 정보가 부족함. 원문에 주체가 생략됐다는 사실 자체는 오류가 아닙니다. boundEntity는 연결 대상이므로 물건/장소라면 그것을 무조건 행위자로 삼지 마세요. 이 행동이 이미 실제로 일어났는지는 판단하지 않습니다.',
       {incompleteFact:fact.meaning,subjectPrefix,boundEntity:fact.subject,source:request.brief},
       {type:'object',additionalProperties:false,required:['subjectBinding','reason'],properties:{subjectBinding:{type:'string',enum:['correct','wrong','unclear']},reason:{type:'string',maxLength:300}}},350));
      if(checked.subjectBinding==='correct'){accepted=true;break;}
      feedback=checked.reason+' 실제 주체만 다시 선택하세요.';
     }
     if(!accepted)throw new ChapterSetupError('invalid-fact-normalization',{fact:fact.meaning,proposed:named,reason:feedback});
    }
    const representationSchema={type:'object',additionalProperties:false,required:['factRepresentation','reason'],properties:{factRepresentation:{type:'string',enum:representationKinds},reason:{type:'string',maxLength:300}}};
    let form:{factRepresentation:typeof representationKinds[number];reason:string}|undefined;
    let candidates:Array<{meaning:string;value:boolean}>|undefined,representationError:unknown,representationFeedback='';
    for(let attempt=0;attempt<2;attempt++){
     try{
      const selected=z.object({factRepresentation:z.enum(representationKinds),reason:z.string().max(300)}).strict().parse(await ask(
      'Classify ONE proposition, not its actual truth. atomic: one observable current state or one completed event, including a specifically failed attempt or missed opportunity. Preserve a source, method, cause or time qualifier as part of that event; causal phrases are not independent conjunctions. absence: merely NOT doing/knowing/possessing/succeeding, or not yet doing so, without a completed failed episode. Not attempting is absence of an attempt; not succeeding is absence of success: these are different underlying facts. conjunction: a Boolean combination of independently checkable facts, e.g. a person is alive AND another is rescued. outcome_label: an abstract ending/victory/failure label with no observable meaning. A concrete failed password attempt is atomic, NOT an abstract outcome label. A death specifically caused by falling is atomic, NOT falling AND dead. A person died is atomic, even though it is an adverse result. A fact like did not fall is absence. Do not imagine an attempted action solely from a negative sentence. Return a short Korean reason.',
      {fact:named,feedback:representationFeedback},representationSchema,360));
    let proposed:Array<{meaning:string;value:boolean}>;
    if(selected.factRepresentation==='outcome_label'){
      // This is private, unresolved input to mandatory source-grounded outcome
      // refinement. It may not become a published writable result flag as-is.
      deferredOutcomes.add(named);candidates=[{meaning:named,value:true}];form=selected;break;
    }
    if(selected.factRepresentation==='absence'){
      const positive=z.object({meaning:Meaning}).strict().parse(await ask(
        '부정 명제의 정확히 반대인 긍정 명제 하나를 쓰세요. 같은 주체·대상·출처·방법·시점·시도/완료 구분을 보존하세요. 아직 시도하지 않았다 -> 시도했다. 아직 성공하지 않았다 -> 성공했다. 시도와 성공을 바꾸지 마세요. 실제 실패한 회차는 단순 성공 부재가 아니므로 바꾸면 안 됩니다. 이는 심볼의 이름이며 실제 발생을 주장하는 것이 아닙니다. 이미 같은 긍정 문장이 있으면 그대로 복사하세요. 한국어 문장만 meaning에 씁니다.',
        {negative:named,existing:facts.map(f=>f.meaning)},meaningSchema,240)).meaning;
      proposed=[{meaning:positive,value:false}];
      const checked=await review(named,proposed);
      if(!checked.accepted)throw new ChapterSetupError('invalid-fact-complement',{fact:named,proposed:positive,reason:checked.reason});
    }else if(selected.factRepresentation==='conjunction'){
      const partSchema={type:'object',additionalProperties:false,required:['factParts'],properties:{factParts:{type:'array',minItems:2,maxItems:4,items:{type:'object',additionalProperties:false,required:['meaning','value'],properties:{meaning:{type:'string',minLength:1,maxLength:300},value:{type:'boolean'}}}}}};
      proposed=z.object({factParts:z.array(z.object({meaning:Meaning,value:z.boolean()}).strict()).min(2).max(4)}).strict().parse(await ask(
        '복합 명제를 원자 명제와 참/거짓 값의 AND로 분해하세요. 각 meaning은 긍정적인 현재 상태 또는 완료 사건 하나입니다. 원문의 실제 주체와 대상, 인과관계·출처·방법·시간을 지우거나 추가하지 마세요. 단순 NOT은 긍정 명제의 value:false로 씁니다. 이것은 현재값이나 결말을 확정하는 것이 아니라 원문의 의미를 동치로 표현하는 작업입니다. 기존 명제가 정확히 같으면 문장을 복사하세요.',
        {original:named,existing:facts.map(f=>f.meaning)},partSchema,700)).factParts;
      const checked=await review(named,proposed);
      if(!checked.accepted)throw new ChapterSetupError('invalid-fact-decomposition',{fact:named,proposed,reason:checked.reason});
    }else proposed=[{meaning:named,value:true}];
      candidates=proposed;form=selected;break;
     }catch(error){
      signal?.throwIfAborted();
      if(!(error instanceof ChapterSetupError)||!['invalid-fact-complement','invalid-fact-decomposition','outcome-as-writable-symbol'].includes(error.code))throw error;
      representationError=error;
      representationFeedback=error.message+' 분류와 변환을 다시 검토하세요. 다른 사실이나 개요를 상상해 단일 명제를 AND로 분해하지 마세요. 피동문 하나나 특정 원인으로 생긴 결과 하나도 atomic일 수 있습니다.';
     }
    }
    if(!candidates||!form)throw representationError??new ChapterSetupError('unresolved-fact-representation',{fact:named});
    const accepted:ChapterDictionaryFact[]=[];
    for(const candidate of candidates)accepted.push(await intern({...fact,meaning:candidate.meaning}));
    if(form.factRepresentation!=='atomic')revisions.push({original:fact.meaning,representation:form.factRepresentation,facts:accepted.map(f=>f.meaning),reason:form.reason});
    resolved.set(rawKey,accepted);return accepted;
  }
  async function replace(original:ChapterDictionaryFact,corrected:ChapterDictionaryFact,reason:string){
    const index=facts.indexOf(original);
    if(index<0)throw new ChapterSetupError('missing-private-fact',{original});
    facts.splice(index,1);resolved.clear();
    const result=await add(corrected);
    revisions.push({original:original.meaning,representation:'source_correction',facts:result.map(f=>f.meaning),reason});
    return result;
  }
  return {facts,revisions,add,replace,deferredOutcomes};
}
