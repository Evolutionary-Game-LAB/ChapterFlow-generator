import type {AuthorContract} from '../src/author-contract.js';

const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Names are opaque in Boolean judgments. Keep the authored prose untouched and
 * restore names in diagnostic text; do not reveal a known fiction's names to the judge. */
export function judgmentAliases(contract?:AuthorContract){
  const labels=contract?.entities.characters.flatMap(id=>contract.entityLabels?.find(e=>e.id===id)?.label??[]).filter(label=>label.length>1)??[];
  const mappings=labels.map((label,index)=>({label,alias:'인물'+String.fromCharCode(65+index)+(labels.some(l=>/^인물[A-Z]/.test(l))?'_식별자':'')}));
  const names=mappings.map(m=>m.label).sort((a,b)=>b.length-a.length);
  // Copular/quoted-name endings matter for facts such as learning a name.
  // Masking "민수의 이름" but leaving "민수임을" intact breaks coreference.
  const copulas='임(?=$|[^\\p{L}\\p{N}_]|을|은|이|도|과|으로|에)|였|라고|라는|라며|란(?=$|[^\\p{L}\\p{N}_])|야(?=$|[^\\p{L}\\p{N}_])';
  const pattern=names.length?new RegExp('(?<![\\p{L}\\p{N}_])('+names.map(escape).join('|')+')(?=$|[^\\p{L}\\p{N}_]|은|는|이|가|을|를|의|에게|한테|와|과|도|만|로|으로|께|씨|님|'+copulas+')','gu'):undefined;
  const mask=(text:string)=>pattern?text.replace(pattern,label=>mappings.find(m=>m.label===label)!.alias):text;
  return {
    mask,
    // A phrase label can lose a qualifier still used in the claim: masking
    // "night curator" must not make "the curator's pass" impossible to verify.
    // This detects representation risk only; it never proves a narrative fact.
    hasUnmaskedLabelPart:(text:string)=>names.some(label=>/\s/.test(label)&&label.split(/\s+/).some(part=>part.length>1&&mask(text).includes(part))),
    restore:(text:string)=>mappings.length?text.replace(new RegExp(mappings.map(m=>escape(m.alias)).join('|'),'g'),alias=>mappings.find(m=>m.alias===alias)!.label):text,
  };
}
