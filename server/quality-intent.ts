export function intentSources(brief:string) {
 const sentences=(brief.match(/[^.!?\n]+(?:[.!?]+|$)/g)??[brief]).map(s=>s.trim()).filter(Boolean);
 const chunks=sentences.flatMap(sentence=>{const result:string[]=[];for(let i=0;i<sentence.length;i+=1000)result.push(sentence.slice(i,i+1000));return result;});
 return chunks.map((text,index)=>({id:'brief_'+(index+1),text}));
}
/** Review-only checks already receive the complete brief. Preserve it verbatim in
 * their audit record instead of asking a model to produce an unused summary. */
export function literalAuthorIntent(brief:string){
 const requirements:Array<{quote:string;requirement:string}>=[];
 for(let i=0;i<brief.length;i+=1000){const quote=brief.slice(i,i+1000);requirements.push({quote,requirement:quote});}
 return {requirements};
}
export function groundedIntentSchema(sources:ReturnType<typeof intentSources>) {
 return {
  type:'object',additionalProperties:false,required:['requirements'],
  properties:{
   requirements:{type:'array',minItems:1,maxItems:16,items:{
    type:'object',additionalProperties:false,required:['sourceId','requirement'],
    properties:{sourceId:{type:'string',enum:sources.map(s=>s.id)},requirement:{type:'string',minLength:1,maxLength:1500}},
   }},
  },
 };
}
/** Resolve exact source text in code. Legacy quotes remain subject to the existing exact-match validator. */
export function resolveIntentSources(raw:unknown,sources:ReturnType<typeof intentSources>):unknown {
 if(!raw||typeof raw!=='object'||!('requirements' in raw)||!Array.isArray(raw.requirements))return raw;
 return {...raw,requirements:raw.requirements.map((item:unknown)=>{
  if(!item||typeof item!=='object'||!('sourceId' in item))return item;
  if('quote' in item)throw new Error('Intent must not supply both sourceId and quote');
  const source=sources.find(s=>s.id===item.sourceId);
  if(!source)throw new Error('Unknown intent source ID');
  const {sourceId,...rest}=item;return {...rest,quote:source.text};
 })};
}
