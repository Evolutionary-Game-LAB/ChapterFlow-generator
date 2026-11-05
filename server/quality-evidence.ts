import type {SymbolicStoryPayload} from '../src/symbolic-story-payload.js';
import {qualitySchemas} from './quality-schema.js';

export type ReviewEvidence={id:string;sceneKey?:string;text:string};
export function reviewEvidence(payload:SymbolicStoryPayload):ReviewEvidence[] {
 const result:ReviewEvidence[]=[];
 const add=(id:string,text:string,sceneKey?:string)=>{
  for(let offset=0;offset<text.length;offset+=1800)result.push({id:id+':'+offset,...(sceneKey?{sceneKey}:{}),text:text.slice(offset,offset+1800)});
 };
 add('brief',payload.approval.brief);
 for(const scene of payload.skeleton.scenes){
  add('title:'+scene.key,scene.title,scene.key);
  add('summary:'+scene.key,(payload.details.scenes[scene.key] as {summary:string}).summary,scene.key);
 }
 for(const symbol of [...payload.approval.contract.stateSymbols,...payload.approval.contract.relationshipSymbols])add('symbol:'+symbol.id,JSON.stringify(symbol));
 for(const beat of payload.plan.beats)if('key' in beat)add('logic:'+beat.key,JSON.stringify(beat),beat.key);
 for(const ending of payload.outcomes.outcomes)add('ending:'+ending.endingId,JSON.stringify(ending));
 return result;
}

export function groundedReviewSchema(evidence:ReviewEvidence[]):Record<string,unknown> {
 const schema=structuredClone(qualitySchemas.quality_review) as any;
 // Findings are the source of truth; redundant pass flags are computed by the server.
 delete schema.properties.checks;schema.required=schema.required.filter((k:string)=>k!=="checks");
 const finding=schema.properties.findings.items;
 delete finding.properties.quote;
 finding.properties.evidenceId={type:'string',enum:evidence.map(e=>e.id)};
 finding.required=finding.required.map((k:string)=>k==='quote'?'evidenceId':k);
 return schema;
}

/** Resolve exact text on the server; never fuzzy-match or invent model evidence. */
export function resolveReviewEvidence(raw:unknown,evidence:ReviewEvidence[]):unknown {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
 const record=raw as Record<string,unknown>;
 if(!Array.isArray(record.findings))return raw;
 const checks={proseState:true,causality:true,intent:true,preservation:true};
 for(const f of record.findings){if(f&&typeof f==="object"){const key=f.kind==="prose-state"||f.kind==="proseState"?"proseState":f.kind;if(key in checks)checks[key as keyof typeof checks]=false;}}
 return {...record,...(record.checks===undefined?{checks}:{}),findings:record.findings.map(f=>{
  if(!f||typeof f!=='object'||!('evidenceId' in f))return f; // Legacy exact-quote responses still require grounding validation.
  const source=evidence.find(e=>e.id===f.evidenceId);
  if(!source)throw new Error('Unknown review evidence ID: '+String(f.evidenceId));
  if(source.sceneKey&&(!Array.isArray(f.sceneKeys)||!f.sceneKeys.includes(source.sceneKey)))throw new Error('Review evidence scene is outside finding scope');
  if('quote' in f&&f.quote!==source.text)throw new Error('Review quote conflicts with referenced evidence');
  const {evidenceId,...finding}=f;
  return {...finding,quote:source.text};
 })};
}
