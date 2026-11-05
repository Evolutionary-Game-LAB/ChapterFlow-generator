import {z} from 'zod';
import {chapterJson} from './chapter-setup.js';
import {ChapterSetupError} from './chapter-setup-error.js';
import type {chapterFactDictionary} from './chapter-fact-dictionary.js';
import type {GenerateRequest} from './request-schema.js';
import {postJsonSafe} from './safe-http.js';
import {classifyChapterFact} from './chapter-semantics.js';

/** Review private definitions before initial values/outcomes exist. A proposal is
 * never authority for changing the story: every edit needs author evidence and
 * a separate source-only check of the corrected definition. */
export async function reviewChapterVocabulary(request:GenerateRequest,dictionary:ReturnType<typeof chapterFactDictionary>,subjects:string[],transport=postJsonSafe,signal?:AbortSignal){
 const source=request.brief!;
 const sourceLines=source.split(/(?:\r?\n)+|(?<=[.!?。])\s+/u).map(s=>s.trim()).filter(Boolean);
 const numberedSource=sourceLines.map((text,index)=>({line:index+1,text}));
 const lineShape={type:'integer',minimum:1,maximum:sourceLines.length};
 const lineParser=z.number().int().min(1).max(sourceLines.length);
 const ask=(system:string,input:unknown,schema:Record<string,unknown>,tokens=600)=>chapterJson(request,[{role:'system',content:system},{role:'user',content:JSON.stringify(input)}],schema,transport,signal,tokens);
 const text={type:'string',maxLength:500};
 const proposedFact={type:'object',additionalProperties:false,required:['meaning','subject'],properties:{meaning:{type:'string',minLength:1,maxLength:300},subject:{type:'string',enum:subjects}}};
 const factParser=z.object({meaning:z.string().min(1).max(300),subject:z.string()}).strict();
 const checkShape={type:'object',additionalProperties:false,required:['definitionVerdict','reason'],properties:{definitionVerdict:{type:'string',enum:['trackable','wrong_action','unclear']},reason:text}};
  async function check(proposed:{meaning:string;subject:string},sourceQuote:string){
  if(!subjects.includes(proposed.subject))throw new ChapterSetupError('unknown-fact-subject',{proposed});
  const checked=z.object({definitionVerdict:z.enum(['trackable','wrong_action','unclear']),reason:z.string().max(500)}).strict().parse(await ask(
   'You are defining a Boolean VARIABLE NAME, not asserting that an event occurred. Its value is UNASSIGNED and may remain false. HYPOTHETICAL QUESTION: IF the optional event described in authorPassage actually happens, can variableName correctly record its completion? trackable: if that described optional event happens, its actor, recipient, action, method, result and scope match this variable. wrong_action: the variable tracks a different actor/recipient/source/method/result or loses an explicit qualifier. unclear: wording is ambiguous. A source saying an event MAY occur is exactly why we track DID it occur with a Boolean. Do NOT reject merely because the source says may/can while the variable name uses completed past tense. There is no assertion of success, certainty, initial truth, or guaranteed injury/death. Check the identity of the tracked event only. Tracking ONE clause is sufficient; the variable need not summarize all actions in the passage. A positive variable may record the absence of that event using false. Give a brief Korean reason.',
   {authorPassage:sourceQuote,variableName:proposed.meaning,assignedValue:null},checkShape,450));
  return checked;
 }
 const originals=[...dictionary.facts];
 const issues:Array<{index:number;sourceLine:number;reason:string;sourceQuote:string}>=[];
 // Audit a few definitions at a time; a long inventory hides participant swaps.
 // Keep indices bound to the snapshot until all proposals have been collected.
 for(let offset=0;offset<originals.length;offset+=4){
 const batch=originals.slice(offset,offset+4).map((f,i)=>({index:offset+i+1,...f}));
 const indices=batch.map(f=>f.index);
 const issueShape={type:'object',additionalProperties:false,required:['vocabularyIssues'],properties:{vocabularyIssues:{type:'array',maxItems:4,items:{type:'object',additionalProperties:false,required:['index','sourceLine','reason'],properties:{index:{type:'integer',enum:indices},sourceLine:lineShape,reason:text}}}}};
 issues.push(...z.object({vocabularyIssues:z.array(z.object({index:z.number().int().refine(index=>indices.includes(index)),sourceLine:lineParser,reason:z.string().max(500)}).strict()).max(4)}).strict().parse(await ask(
  'Audit the proposed state dictionary against authorSource. Find only clear MEANING ERRORS: swapped actor/recipient, wrong owner of knowledge or wrongdoing, a different source or causal method substituted for a named author action, or a current condition substituted for a required completed history. These are possible symbol definitions, not initial truth assertions. If a definition repeats an explicitly authored action/outcome but substitutes its named participant, that IS a mismatch; do not rationalize it as another possible unmentioned branch. For example, author: a rescuer shields a child and is injured; symbol: the rescuer shields a colleague and is injured. The injury episode has the wrong recipient even though shielding a colleague would be physically possible. Creative intermediate actions not substituting an authored action remain allowed. Do not flag harmless paraphrases, different entity bindings, mere incompleteness, or the alternatives actually authored as contradictions. Quote the exact source passage with the correct named roles/method. Return [] when no clear error. Do not propose changes to valid definitions merely to shrink the dictionary.',
  {authorSource:numberedSource,instruction:'sourceLine에는 올바른 주체·대상·방법이 명시된 원문 문장 번호만 선택하세요. 원문을 새로 쓰지 마세요.',facts:batch},issueShape,1000)).vocabularyIssues.map(issue=>({...issue,sourceQuote:sourceLines[issue.sourceLine-1]!})));
 }
 for(const issue of issues){
  const original=originals[issue.index-1];
  if(!original||!dictionary.facts.includes(original)||!issue.sourceQuote.trim()||!source.includes(issue.sourceQuote))continue;
  const confirmation=z.object({definitionIssue:z.enum(['compatible','changed_participant','changed_meaning','unclear']),reason:z.string().max(500)}).strict().parse(await ask(
   'authorPassage와 variableName의 의미를 비교하세요. 참인지 묻는 것이 아니라 하나의 참/거짓 변수로 추적할 수 있는지를 묻습니다. 먼저 행위자와 대상을 확인하세요. 이름/대상이 바뀌면 반드시 changed_participant입니다. 예: 아이를 보호하다 다침 → 동료를 보호하다 다침은 대상 변경입니다. 가능형/완료형 차이가 있어도 대상 변경은 여전히 오류입니다. changed_meaning: 행동 자체, 정보 출처, 인과관계, 시간 범위가 바뀜. compatible: 같은 행동/상태의 한 부분을 추적함. 원문의 여러 행동을 전부 담거나 주된 행동만 고를 필요는 없습니다. 원문이 미달성을 말하면 긍정 변수=false로 표현할 수 있어 compatible입니다. unclear: 비교 불가. 짧은 한국어 이유를 쓰세요.',
   {authorPassage:issue.sourceQuote,variableName:original.meaning,assignedValue:null},
   {type:'object',additionalProperties:false,required:['definitionIssue','reason'],properties:{definitionIssue:{type:'string',enum:['compatible','changed_participant','changed_meaning','unclear']},reason:text}},450));
  if(confirmation.definitionIssue==='compatible')continue;
  if(confirmation.definitionIssue==='unclear')throw new ChapterSetupError('uncertain-fact-definition',{original,issue,reason:confirmation.reason});
  const words=original.meaning.split(/\s+/u),spans:string[]=[];
  for(let i=0;i<words.length;i++)for(let size=1;size<=3&&i+size<=words.length;size++){
   const phrase=words.slice(i,i+size).join(' ');
   if(original.meaning.split(phrase).length===2&&!spans.includes(phrase))spans.push(phrase);
  }
  if(!spans.includes(original.meaning))spans.push(original.meaning);
  let feedback='',accepted=false;
  for(let attempt=0;attempt<2;attempt++){
   const selection=z.object({symbolSpan:z.number().int().min(1).max(spans.length)}).strict().parse(await ask(
    '잘못된 심볼에서 교체해야 할 가장 작은 구절의 번호 하나만 고르세요. 정답 원문에서 고르는 것이 아닙니다. 대상 이름이 틀렸으면 이름과 조사 부분만 선택하고 올바른 술어나 시제는 선택하지 마세요.',
    {wrongSymbol:original.meaning,correctAuthorPassage:issue.sourceQuote,error:confirmation.reason,replaceableSymbolSpans:spans.map((text,i)=>({id:i+1,text})),feedback},
    {type:'object',additionalProperties:false,required:['symbolSpan'],properties:{symbolSpan:{type:'integer',minimum:1,maximum:spans.length}}},50));
   const oldText=spans[selection.symbolSpan-1]!;
   const patch=z.object({replacement:z.string().min(1).max(200),subject:z.string()}).strict().parse(await ask(
    '심볼에서 잘못된 구절 하나를 삭제하고 그 자리에 넣을 올바른 구절만 쓰세요. correctAuthorPassage가 정답 근거입니다. incorrectPhrase를 복사하지 말고 원문에 맞는 이름/대상/방법으로 교체하세요. 이름이면 필요한 한국어 조사까지 포함하고 문장 전체를 다시 쓰지 마세요. 나머지 완료형 술어와 시제는 그대로 유지됩니다. 새 사건이나 가능성 표현을 추가하지 마세요. subject는 연결 대상으로 선언 목록에서 선택합니다.',
    {correctAuthorPassage:issue.sourceQuote,incorrectPhrase:oldText,existingSubject:original.subject,subjects,feedback},
    {type:'object',additionalProperties:false,required:['replacement','subject'],properties:{replacement:{type:'string',minLength:1,maxLength:200},subject:{type:'string',enum:subjects}}},250));
   if(oldText===patch.replacement){feedback='잘못된 구절을 그대로 복사했습니다. 원문에 맞는 어구를 넣어야 합니다.';continue;}
   const correction=factParser.parse({meaning:original.meaning.replace(oldText,patch.replacement),subject:patch.subject});
   const scope=z.object({correctionScope:z.enum(['predicate_preserved','predicate_changed','unclear']),reason:z.string().max(300)}).strict().parse(await ask(
    '비교 대상은 행동/상태를 나타내는 술어 종류뿐입니다. 이름·대상·출처·시간 수식의 변경은 허용된 수정이므로 무시하세요. predicate_preserved: 누가 누구에게 했는지가 바뀌어도 같은 행동 술어를 유지함. 보호하다 다침 → 보호하다 다침은 보호 대상 이름이 달라도 보존입니다. predicate_changed: 사망/사살이 위협으로, 조사가 대화로, 의도가 완료 결과로 바뀌거나 행동 절이 사라짐. unclear: 판정 불가. 동일 인물이나 동일 사건인지 묻는 것이 아닙니다. 핵심 술어가 보존됐는지만 답하세요.',
    {original:original.meaning,corrected:correction.meaning},
    {type:'object',additionalProperties:false,required:['correctionScope','reason'],properties:{correctionScope:{type:'string',enum:['predicate_preserved','predicate_changed','unclear']},reason:{type:'string',maxLength:300}}},350));
   if(scope.correctionScope!=='predicate_preserved'){feedback=scope.reason+' 원래 추적하던 행동 자체는 보존하고 잘못된 주체·대상·수식만 고치세요.';continue;}
   const reviewed=await check(correction,issue.sourceQuote);
   if(reviewed.definitionVerdict==='trackable'){
    await dictionary.replace(original,correction,reviewed.reason);accepted=true;break;
   }
   feedback=reviewed.reason;
  }
  if(!accepted)throw new ChapterSetupError('uncertain-fact-definition',{fact:original.meaning,issue,feedback});
 }
 const currentShape={type:'object',additionalProperties:false,required:['missingCurrentFacts'],properties:{missingCurrentFacts:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,required:['meaning','subject','sourceLine','reason'],properties:{...proposedFact.properties,sourceLine:lineShape,reason:text}}}}};
 const current=z.object({missingCurrentFacts:z.array(factParser.extend({sourceLine:lineParser,reason:z.string().max(500)})).max(3)}).strict().parse(await ask(
  'Write Korean variable names for ONLY necessary CURRENT conditions missing from the shared dictionary. Every meaning must explicitly include 현재 and describe a condition (currently possesses / is open / has power), NOT an acquisition or other action (obtains / obtained / acquires and maintains). Do not join obtaining and possessing in a single fact. The source may allow acquiring/losing/reacquiring an item, opening/closing something, or another reversible condition on which gameplay depends. An old acquisition or disposal history cannot substitute for current possession. If the source explicitly requires maintaining such a condition for an action, propose its positive CURRENT-state fact and quote the exact relevant source passage. Do not add inventory for every mentioned object, static lore, optional moods, general alive/dead flags, current location, or duplicate current facts. Already learned irreversible knowledge can remain a history fact. Preserve completed milestones/deadlines as history. Return [] if current conditions are already represented or the source does not need them. Keep required historical events; this only adds a missing current condition, not an ending flag.',
  {authorSource:numberedSource,instruction:'sourceLine에는 해당 현재 조건을 필요로 하는 원문 문장의 번호를 선택하세요. 과거 행동 완료를 새 현재 상태로 제안하지 마세요.',existing:dictionary.facts,subjects},currentShape,1000)).missingCurrentFacts.map(fact=>({...fact,sourceQuote:sourceLines[fact.sourceLine-1]!}));
 for(const fact of current){
  if(!fact.sourceQuote.trim()||!source.includes(fact.sourceQuote))continue;
  const proposed={meaning:fact.meaning,subject:fact.subject};
  if(!subjects.includes(proposed.subject))throw new ChapterSetupError('unknown-fact-subject',{proposed});
  const evidence=z.object({conditionEvidence:z.enum(['explicit_requirement','incidental_setting','no_dependency']),reason:z.string().max(300)}).strict().parse(await ask(
   '인용문이 proposedVariable의 상태를 확보하거나 유지해야 행동할 수 있다는 필요 조건을 명시합니까? explicit_requirement: 해당 상태가 필요/필수/전제이거나 상실 시 행동이 불가능하다는 규칙이 명시됨. incidental_setting: 단지 행동 장소나 장면 배경을 말함. no_dependency: 상태 의존 규칙이 없음. "서재에서 책을 읽어 비밀을 알 수 있다"는 행동 장소 설명이며 서재 위치를 별도 심볼로 만들어야 한다는 규칙은 아닙니다. 원문에 없는 필수 조건을 상식으로 추가하지 마세요. 현재 그 상태가 참인지 묻는 것이 아닙니다.',
   {quotation:fact.sourceQuote,proposedVariable:proposed},
   {type:'object',additionalProperties:false,required:['conditionEvidence','reason'],properties:{conditionEvidence:{type:'string',enum:['explicit_requirement','incidental_setting','no_dependency']},reason:{type:'string',maxLength:300}}},350));
  if(evidence.conditionEvidence!=='explicit_requirement')continue;
  // Need for a variable and its temporal type are separate judgments. A missed
  // completed event must not enter through this current-condition-only stage.
  if((await classifyChapterFact(request,proposed.meaning,transport,signal)).scope!=='current')continue;
  const checked=z.object({currentRequirement:z.enum(['required','redundant','not_required','unclear']),reason:z.string().max(500)}).strict().parse(await ask(
   'Evaluate whether a Boolean STATE VARIABLE is needed to CHECK an explicit gameplay prerequisite. You are NOT deciding whether the proposition is true now: both true and false will be possible and initial values are decided later. A source rule "to use the device, the actor must currently possess it" is evidence that current possession is required; do not reject it for being conditional or not yet true. required: authorSource explicitly makes an action depend on this current condition, the proposed actor/object/property matches that dependency, and existing facts cannot represent it correctly after reversal and repetition. redundant: already represented. not_required: only incidental location, invented condition, or different actor/property. A scene taking place in a room alone does not require a location variable. Past acquisition/disposal/opening/closing events remain true forever, so they do not by themselves represent the current condition after repeated changes. Do not determine an initial true/false value. Give a short Korean reason.',
   {authorSource:source,quotedPrerequisite:fact.sourceQuote,proposedVariable:proposed,existing:dictionary.facts},
   {type:'object',additionalProperties:false,required:['currentRequirement','reason'],properties:{currentRequirement:{type:'string',enum:['required','redundant','not_required','unclear']},reason:text}},500));
  if(checked.currentRequirement!=='required')continue;
  const added=await dictionary.add(proposed);
  dictionary.revisions.push({original:fact.sourceQuote,representation:'current_state_coverage',facts:added.map(f=>f.meaning),reason:checked.reason});
 }
}
