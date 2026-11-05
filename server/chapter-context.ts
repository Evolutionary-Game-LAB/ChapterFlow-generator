import {z} from 'zod';
import {chapterJson} from './chapter-setup.js';
import type {GenerateRequest} from './request-schema.js';
import {postJsonSafe} from './safe-http.js';

const contextSchema={type:'object',additionalProperties:false,required:['context'],properties:{context:{type:'string',minLength:30,maxLength:1400}}};
const Context=z.object({context:z.string().min(30).max(1400)}).strict();
const Review=z.object({contextVerdict:z.enum(['compatible','changes-premise','uncertain']),reason:z.string().min(1).max(600)}).strict();
const reviewSchema={type:'object',additionalProperties:false,required:['reason','contextVerdict'],properties:{reason:{type:'string',minLength:1,maxLength:600},contextVerdict:{type:'string',enum:['compatible','changes-premise','uncertain']}}};

export async function reviewChapterContext(request:GenerateRequest,sourceBrief:string,context:string,transport=postJsonSafe,signal?:AbortSignal){
  return Review.parse(await chapterJson(request,[{role:'system',content:'Compare AUTHOR with EXPANSION. First identify any new cause, crime, secret culprit, sabotage or obligation. A new crime is a plot fact, NOT merely a deeper motive. If AUTHOR did not establish a mystery or ask for a secret, adding concealed guilt or crime is changes-premise, even if the endings remain possible. A cautious person guarding supplies is NOT evidence of a crime. Making a person responsible for a natural disaster is changes-premise unless AUTHOR said so. Also reject contradictions to explicit resources, roles, endings or discovery methods. Ordinary elaboration preserving these is compatible. A secret can be completed when AUTHOR explicitly establishes an unresolved secret. Explain the evidence briefly before choosing compatible, changes-premise or uncertain. Judge only supplied texts.'},{role:'user',content:JSON.stringify({AUTHOR:sourceBrief,EXPANSION:context})}],reviewSchema,transport,signal,550));
}

/** Background elaboration is optional. An incompatible expansion must never become the author's premise. */
export async function prepareChapterContext(request:GenerateRequest,sourceBrief:string,transport=postJsonSafe,signal?:AbortSignal){
  let feedback='';
  for(let attempt=0;attempt<2;attempt++){
    const messages:GenerateRequest['messages']=[{role:'system',content:'Write 3-5 short Korean sentences of backstage context for this author brief. Preserve its genre, central cause, character roles, resource limits and every requested ending. Elaborate the existing conflict and concrete motives only where missing; a faithful concise restatement is enough for an already complete brief. Do not invent a mystery, crime, hidden guilt, secret culprit or sabotage when the author did not establish one. Caution or conflict does not imply a secret. ONLY when the author explicitly establishes an unresolved mystery/secret, complete its missing truth imaginatively and keep it discoverable through the requested methods. Explain cooperation through ordinary credible incentives or pressure without inventing a new plot. Do not resolve an ending, grant player knowledge, or add essential objects/people/places. For existing fiction, use the supplied scenario without replacing it.'},{role:'user',content:sourceBrief}];
    if(feedback)messages.push({role:'system',content:'The previous expansion was rejected: '+feedback+' Revise only missing details. Do not assume a mystery or secret: retain the original genre, central cause and roles. If the brief is already sufficient, a concise faithful restatement is enough.'});
    const {context}=Context.parse(await chapterJson(request,messages,contextSchema,transport,signal,1000));
    const review=await reviewChapterContext(request,sourceBrief,context,transport,signal);
    if(review.contextVerdict==='compatible')return context;
    feedback=review.reason;
  }
  // Proceed from the complete original brief rather than require an author to
  // approve an invented secret. Later fact/event checks still apply normally.
  return '';
}
