import {ManuscriptSchema,type Manuscript} from '../src/story-first.js';

/** Only prose may change. Identity, truth, ending labels and topology of the
 * manuscript remain authored data; a local repair cannot silently replace them. */
export function manuscriptProseSlots(book:Manuscript):Record<string,string>{
  const slots:Record<string,string>={opening:book.opening};
  book.paths.forEach((p,i)=>{slots[`paths.${i}.story`]=p.story;});
  book.motives.forEach((m,i)=>{slots[`motives.${i}.changeReason`]=m.changeReason;});
  book.opportunities?.forEach((o,i)=>{
    slots[`opportunities.${i}.situation`]=o.situation;
    slots[`opportunities.${i}.commonContinuation`]=o.commonContinuation;
    o.alternatives.forEach((s,j)=>{slots[`opportunities.${i}.alternatives.${j}`]=s;});
  });
  return slots;
}
export function applyManuscriptTextRepair(book:Manuscript,edits:Array<{field:string;text:string}>):Manuscript{
  if(!edits.length||edits.length>4)throw Error('원고 문단 복구 개수 오류');
  const slots=manuscriptProseSlots(book),seen=new Set<string>(),result=structuredClone(book);
  for(const edit of edits){
    if(!Object.hasOwn(slots,edit.field)||seen.has(edit.field))throw Error('원고 문단 복구 대상 오류');
    seen.add(edit.field);
    const parts=edit.field.split('.');let target:any=result;
    for(const part of parts.slice(0,-1))target=target[part];
    target[parts.at(-1)!]=edit.text;
  }
  return ManuscriptSchema.parse(result);
}
