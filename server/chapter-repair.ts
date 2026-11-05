import {z} from 'zod';
import type {GenerateRequest} from './request-schema.js';
import type {NarrativeEvent} from './chapter-coherence.js';
import {chapterJson} from './chapter-setup.js';
import {postJsonSafe} from './safe-http.js';

export type EventRepairInput={
  brief:string;
  event:NarrativeEvent & {locationId:string;presentCharacters:string[]};
  precedingEvents:NarrativeEvent[];
  priorFacts:Array<{meaning:string;value:boolean|number}>;
  followingEvents:NarrativeEvent[];
  entities:unknown;
  problem:string;
  requiredNewResults:Array<{meaning:string;required:boolean|number}>;
};

/** Repair only missing results. Completed ending conditions are not new writing tasks. */
export async function clarifyChapterEvent(request:GenerateRequest,input:EventRepairInput,transport=postJsonSafe,signal?:AbortSignal){
  const schema={type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string',minLength:10,maxLength:800}}};
  const raw=await chapterJson(request,[
    {role:'system',content:'Make the smallest concrete correction to ONE unaccepted event in Korean. Preserve its valid actions, title, place, cast and role. Address problem, not the whole chapter again. If requiredNewResults is nonempty, make ONLY those still-missing results actually happen in this event. When a required fact was not recognized, state its explicitly required method, source, location or result in clear matching terms and describe the concrete action that establishes it; do not merely add an unsupported label. Refer to earlier completed parts as past causes, never perform them again. Name the exact responsible actor; an action by other people does not satisfy that actor\'s result. Add a short observable action or state that completes the missing result, not a promise or intention. Already-true facts and precedingEvents are completed history, not tasks to repeat. Do not recap or re-enact them to fill space. If a missing preparation belongs here, perform it before using its result rather than presupposing it. Do not advance supplied followingEvents. Never erase knowledge, revive an actor or invent a miraculous reversal to satisfy a condition. Preserve method, place, information source and causality. Do not output state assignments or instructions. Return only the corrected summary, in 1-3 sentences.'},
    {role:'user',content:JSON.stringify(input)},
  ],schema,transport,signal,1000);
  return z.object({summary:z.string().min(10).max(800)}).strict().parse(raw);
}
