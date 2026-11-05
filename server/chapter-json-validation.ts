/** Early checks for the JSON-schema subset used by chapter prompts. These let
 * unsupported provider grammar constraints recover before the caller's full
 * Zod and semantic validation. Never coerce, truncate, or drop returned values. */
export function chapterJsonIssues(value:unknown,schema:Record<string,unknown>,at='$'):string[] {
  const errors:string[]=[];
  const check=(v:unknown,s:unknown,p:string)=>chapterJsonIssues(v,s as Record<string,unknown>,p);
  if(Array.isArray(schema.anyOf)&&!schema.anyOf.some(s=>!check(value,s,at).length))errors.push(`${at}: does not match any allowed shape`);
  if(Array.isArray(schema.oneOf)&&schema.oneOf.filter(s=>!check(value,s,at).length).length!==1)errors.push(`${at}: must match exactly one allowed shape`);
  if(Array.isArray(schema.allOf))for(const s of schema.allOf)errors.push(...check(value,s,at));
  if('const' in schema&&JSON.stringify(value)!==JSON.stringify(schema.const))errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if(Array.isArray(schema.enum)&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))errors.push(`${at}: expected one of ${JSON.stringify(schema.enum)}`);
  const types=typeof schema.type==='string'?[schema.type]:Array.isArray(schema.type)?schema.type:[];
  const actual=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(types.length&&!types.includes(actual)&&!(actual==='number'&&Number.isInteger(value)&&types.includes('integer')))return [...errors,`${at}: expected ${types.join('|')}, received ${actual}`];
  if(typeof value==='string'){
    if(typeof schema.maxLength==='number'&&value.length>schema.maxLength)errors.push(`${at}: maxLength ${schema.maxLength}, received ${value.length}; shorten this text without changing its conclusion`);
    if(typeof schema.minLength==='number'&&value.length<schema.minLength)errors.push(`${at}: minLength ${schema.minLength}`);
    if(typeof schema.pattern==='string'&&!new RegExp(schema.pattern).test(value))errors.push(`${at}: expected pattern ${schema.pattern}`);
  }
  if(typeof value==='number'){
    if(!Number.isFinite(value))errors.push(`${at}: finite number required`);
    if(typeof schema.minimum==='number'&&value<schema.minimum)errors.push(`${at}: minimum ${schema.minimum}`);
    if(typeof schema.maximum==='number'&&value>schema.maximum)errors.push(`${at}: maximum ${schema.maximum}`);
  }
  if(Array.isArray(value)){
    if(typeof schema.minItems==='number'&&value.length<schema.minItems)errors.push(`${at}: minItems ${schema.minItems}`);
    if(typeof schema.maxItems==='number'&&value.length>schema.maxItems)errors.push(`${at}: maxItems ${schema.maxItems}`);
    if(schema.items&&typeof schema.items==='object')value.forEach((v,i)=>errors.push(...check(v,schema.items,`${at}[${i}]`)));
  }else if(value&&typeof value==='object'){
    const obj=value as Record<string,unknown>,properties=(schema.properties??{}) as Record<string,unknown>;
    if(Array.isArray(schema.required))for(const key of schema.required)if(typeof key==='string'&&!(key in obj))errors.push(`${at}.${key}: required`);
    for(const [key,v] of Object.entries(obj)){
      if(key in properties)errors.push(...check(v,properties[key],`${at}.${key}`));
      else if(schema.additionalProperties===false)errors.push(`${at}.${key}: unexpected field`);
    }
  }
  return errors.slice(0,12);
}

export class ChapterJsonFormatError extends Error {
  constructor(message:string,readonly content:string,readonly truncated=false){super(message);this.name='ChapterJsonFormatError';}
}

export function protectedJsonFields(value:unknown,schema:Record<string,unknown>,path:string[]=[]):Array<{path:string[];value:unknown}> {
  if(!value||typeof value!=='object'||Array.isArray(value))return [];
  return Object.entries((schema.properties??{}) as Record<string,Record<string,unknown>>).flatMap(([key,child])=>{
    if(!(key in value))return [];
    const v=(value as Record<string,unknown>)[key],p=[...path,key];
    return chapterJsonIssues(v,child).length?protectedJsonFields(v,child,p):[{path:p,value:v}];
  });
}

export function changedProtectedFields(value:unknown,fields:ReturnType<typeof protectedJsonFields>):string[] {
  return fields.flatMap(field=>{
    let current:any=value;for(const key of field.path)current=current?.[key];
    return JSON.stringify(current)===JSON.stringify(field.value)?[]:[`$.${field.path.join('.')}: format repair changed a valid field; restore ${JSON.stringify(field.value)}`];
  });
}
