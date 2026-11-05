/** Provider grammar subset only. The prompt and caller's Zod validation retain
 * the original limits, so accepting the HTTP request never relaxes validation. */
export function anthropicChapterSchema(schema:Record<string,unknown>):Record<string,unknown> {
  const result:Record<string,unknown>={},constraints:Record<string,unknown>={};
  for(const [key,value] of Object.entries(schema)){
    if(['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','maxItems','uniqueItems'].includes(key)||(key==='minItems'&&typeof value==='number'&&value>1)){
      constraints[key]=value;continue;
    }
    if(['properties','$defs','definitions'].includes(key)&&value&&typeof value==='object')result[key]=Object.fromEntries(Object.entries(value).map(([name,child])=>[name,anthropicChapterSchema(child as Record<string,unknown>)]));
    else if(['items','additionalProperties'].includes(key)&&value&&typeof value==='object'&&!Array.isArray(value))result[key]=anthropicChapterSchema(value as Record<string,unknown>);
    else if(['anyOf','allOf','oneOf'].includes(key)&&Array.isArray(value))result[key]=value.map(child=>anthropicChapterSchema(child));
    else result[key]=value;
  }
  if(Object.keys(constraints).length)result.description=[schema.description,'Required constraints: '+JSON.stringify(constraints)].filter(Boolean).join('\n');
  return result;
}
