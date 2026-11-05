import {symbolicGraphJsonSchema} from '../src/symbolic-graph.js';
const text={type:'string',minLength:1};
const array=(items:unknown,maxItems:number,minItems=0)=>({type:'array',items,maxItems,minItems});
const object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const scene=symbolicGraphJsonSchema.properties.situations.items.properties;
const transition=symbolicGraphJsonSchema.properties.transitions.items.properties;
export const qualitySchemas:Record<string,Record<string,unknown>>={
 quality_intent:object({requirements:array(object({quote:{...text,maxLength:1000},requirement:{...text,maxLength:1500}}),16,1)}),
 quality_review:object({checks:object({proseState:{type:'boolean'},causality:{type:'boolean'},intent:{type:'boolean'},preservation:{type:'boolean'}}),findings:array(object({kind:{type:'string',enum:['prose-state','causality','intent','preservation']},sceneKeys:array(text,40,1),quote:{...text,maxLength:2000},reason:{...text,maxLength:2000},repair:{type:'string',enum:['logic','prose','both','unresolvable']}}),20)}),
 quality_patch:object({beats:array(object({key:{type:'string',pattern:'^beat_[a-z0-9_]+$',maxLength:48},title:scene.title,precondition:transition.precondition,effects:transition.effects}),40),scenes:array(object({key:text,summary:scene.summary,locationId:scene.locationId,presentCharacters:scene.presentCharacters}),64)}),
};

/** A spelling alias must never discard the associated substantive findings. */
export function normalizeReviewKind(raw:unknown):unknown {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
 const record=raw as Record<string,unknown>;
 if(!Array.isArray(record.findings))return raw;
 return {...record,findings:record.findings.map(f=>f&&typeof f==='object'&&f.kind==='proseState'?{...f,kind:'prose-state'}:f)};
}
export function hasReviewConcerns(raw:unknown):boolean {
 if(!raw||typeof raw!=='object')return false;
 const r=raw as {checks?:Record<string,unknown>;findings?:unknown[]};
 return (Array.isArray(r.findings)&&r.findings.length>0)||!!(r.checks&&Object.values(r.checks).some(v=>v===false));
}

// Some local grammar backends reject nested bounded repetitions. Enforce bounds
// in Zod after decoding; retain object shape, required fields and enums here.
export function decoderSchema(value:unknown):unknown {
 if(Array.isArray(value))return value.map(decoderSchema);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['minLength','maxLength','minItems','maxItems'].includes(key)).map(([key,item])=>[key,decoderSchema(item)]));
 return value;
}