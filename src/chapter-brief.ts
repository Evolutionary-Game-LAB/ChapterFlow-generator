const headingPattern=/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:\[)?(?:결말|가능한\s*결말|요청한\s*결말|endings)(?:\])?(?:\*\*)?\s*[:：]?\s*$/i;
const itemPattern=/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
export const CHAPTER_ENDING_LABEL_LIMIT=200;

/** Future outcomes must not be offered as evidence for the starting world state. */
export function chapterInitialSource(brief:string):string {
  if(!explicitChapterEndings(brief))return brief;
  const lines=brief.split(/\r?\n/),heading=lines.findIndex(line=>headingPattern.test(line));
  let end=heading+1;
  for(;end<lines.length;end++)if(lines[end]!.trim()&&!itemPattern.test(lines[end]!)&&!/^\s{2,}\S/.test(lines[end]!))break;
  return [...lines.slice(0,heading),...lines.slice(end)].join('\n').trim();
}

/** Preserve an explicitly labelled ending list verbatim. Unstructured prose still uses model extraction. */
export function explicitChapterEndings(brief:string):string[]|undefined {
  const lines=brief.split(/\r?\n/);
  const heading=lines.findIndex(line=>headingPattern.test(line));
  if(heading<0)return undefined;
  const endings:string[]=[];
  for(const line of lines.slice(heading+1)){
    if(!line.trim())continue;
    const item=line.match(itemPattern);
    if(item){endings.push(item[1]!);continue;}
    if(endings.length&&/^\s{2,}\S/.test(line)){endings[endings.length-1]+=' '+line.trim();continue;}
    break;
  }
  if(!endings.length)return undefined;
  if(endings.length>6)throw new Error('한 챕터에 최대 6개 결말을 만들 수 있습니다. 결말을 줄이거나 챕터를 나눠 주세요.');
  if(endings.some(e=>e.length>CHAPTER_ENDING_LABEL_LIMIT))throw new Error(`각 결말은 ${CHAPTER_ENDING_LABEL_LIMIT}자 이내로 적어 주세요.`);
  if(new Set(endings).size!==endings.length)throw new Error('같은 결말이 중복되어 있습니다. 구분할 결과를 적어 주세요.');
  return endings;
}
