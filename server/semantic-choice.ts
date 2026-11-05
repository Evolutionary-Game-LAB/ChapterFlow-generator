import {createHash} from 'node:crypto';
import {z} from 'zod';

export const ChoiceRowSchema=z.object({
  id:z.string().min(1).max(512),
  state:z.string().min(1).max(200000),
  question:z.string().min(1).max(16000),
  options:z.array(z.object({id:z.string().min(1),description:z.string().min(1)}).strict()).min(2).max(16),
}).strict().refine(r=>new Set(r.options.map(o=>o.id)).size===r.options.length,'Duplicate option IDs');
export type ChoiceRow=z.infer<typeof ChoiceRowSchema>;
export const ChoiceResultSchema=z.object({
  id:z.string(),request_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  option_ids:z.array(z.string()).min(2).max(16),
  probabilities:z.array(z.number().finite().min(0).max(1)).min(2).max(16),
  option_logits:z.array(z.number().finite()).min(2).max(16).optional(),
  selected_id:z.string().optional(),
  input_tokens:z.number().int().positive(),
  model:z.object({source:z.string(),revision:z.string(),dtype:z.string(),device:z.string()}).passthrough(),
  probability_status:z.string(),
}).passthrough();
export type ChoiceResult=z.infer<typeof ChoiceResultSchema>;
export type ChoiceMode='direct'|'shared'|'json';
export type ChoiceTransport=(rows:ChoiceRow[],mode:ChoiceMode)=>Promise<unknown>;

export function choiceRequestHash(row:ChoiceRow){
  // Explicit ordered fields match the Python transport; no candidate labels or actual state.
  return createHash('sha256').update(JSON.stringify({id:row.id,state:row.state,question:row.question,options:row.options.map(o=>({id:o.id,description:o.description}))})).digest('hex');
}

/** Fail closed on incomplete, stale, reordered-option, or malformed batch results. */
export function validateChoiceResults(rows:ChoiceRow[],raw:unknown):ChoiceResult[]{
  rows.forEach(r=>ChoiceRowSchema.parse(r));
  if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('Duplicate question IDs');
  const results=z.array(ChoiceResultSchema).parse(raw),byId=new Map(results.map(r=>[r.id,r]));
  if(byId.size!==results.length||results.length!==rows.length)throw Error('Incomplete or duplicate choice results');
  return rows.map(row=>{
    const result=byId.get(row.id);
    if(!result||result.request_sha256!==choiceRequestHash(row))throw Error('Missing or stale choice result');
    if(JSON.stringify(result.option_ids)!==JSON.stringify(row.options.map(o=>o.id)))throw Error('Choice option order differs');
    if(result.probabilities.length!==row.options.length||Math.abs(result.probabilities.reduce((a,b)=>a+b,0)-1)>1e-5)throw Error('Invalid probability distribution');
    if(result.option_logits&&result.option_logits.length!==row.options.length)throw Error('Invalid option logits');
    if(result.selected_id&&!result.option_ids.includes(result.selected_id))throw Error('Unknown selected option');
    return result;
  });
}

/** Raw argmax is a research observation, never evidence of calibrated correctness. */
export function selectedChoice(result:ChoiceResult):string|null{
  if(result.selected_id)return result.selected_id; // generated JSON baseline, not a calibrated distribution
  const best=Math.max(...result.probabilities),indices=result.probabilities.flatMap((v,i)=>v===best?[i]:[]);
  return indices.length===1?result.option_ids[indices[0]]:null;
}

/** Exact evidence only; different histories are never merged for speed. */
export async function scoreChoices(rows:ChoiceRow[],transport:ChoiceTransport,mode:ChoiceMode='direct',batchSize=8){
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>32)throw Error('Invalid batch size');
  rows.forEach(r=>ChoiceRowSchema.parse(r));
  if(new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('Duplicate question IDs');
  const groups=new Map<string,ChoiceRow[]>();
  for(const row of rows){const key=mode==='shared'?row.state:'all';if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(row);}
  const results:ChoiceResult[]=[];
  for(const group of groups.values())for(let i=0;i<group.length;i+=batchSize){
    const batch=group.slice(i,i+batchSize);
    // Prefix caching has no benefit for one question; avoid an extra forward pass.
    const servingMode=mode==='shared'&&batch.length===1?'direct':mode;
    results.push(...validateChoiceResults(batch,await transport(batch,servingMode)));
  }
  const byId=new Map(results.map(r=>[r.id,r]));return rows.map(r=>byId.get(r.id)!);
}
