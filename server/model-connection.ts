import {z} from 'zod';
import {parseGenerateRequest} from './request-schema.js';
import {chapterJson} from './chapter-setup.js';
import {postJsonSafe} from './safe-http.js';

/** Test the same provider adapter as chapter creation, without generating a story. */
export async function checkModelConnection(input:unknown,transport=postJsonSafe,signal?:AbortSignal){
  const request=parseGenerateRequest(input);
  if(request.mode==='mock')return {content:'Mock 준비됨'};
  z.object({connected:z.literal(true)}).strict().parse(await chapterJson(request,[
    {role:'system',content:'This is a connection check. Return the required JSON with connected=true. No explanation.'},
    {role:'user',content:'ping'},
  ],{type:'object',additionalProperties:false,required:['connected'],properties:{connected:{type:'boolean',enum:[true]}}},transport,signal,80));
  return {content:'OK'};
}
