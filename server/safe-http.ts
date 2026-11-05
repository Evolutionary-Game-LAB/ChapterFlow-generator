import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { assertCredentialsAllowed, resolveSafeEndpoint } from './endpoint-policy.js';

const MAX_RESPONSE_BYTES = 1_000_000;
/** Provider diagnostics stay out of the public error message. Strip known
 * credentials and common key forms before retaining a small JSON error. */
export function safeProviderDiagnostic(body:string,headers:Record<string,string>):Record<string,string>|undefined{
  let payload:any;try{payload=JSON.parse(body);}catch{return undefined;}
  const error=payload?.error;if(!error||typeof error!=='object')return undefined;
  const secrets=Object.entries(headers).filter(([name])=>/authorization|api.?key|token|cookie/i.test(name))
    .flatMap(([,value])=>[value,value.replace(/^Bearer\s+/i,''),encodeURIComponent(value.replace(/^Bearer\s+/i,''))]).filter(value=>value.length>=4);
  const clean=(value:string)=>{for(const secret of secrets)value=value.split(secret).join('[REDACTED]');return value.replace(/\b(?:sk|sess)-[a-zA-Z0-9_.*-]+/g,'[REDACTED]').slice(0,1200);};
  const result=Object.fromEntries(['type','code','param','message'].flatMap(key=>typeof error[key]==='string'?[[key,clean(error[key])]]:[]));
  return Object.keys(result).length?result:undefined;
}
export class LlmHttpError extends Error {
  constructor(readonly status:number,readonly retryAfterMs?:number,readonly providerDiagnostic?:Record<string,string>){
    super(`LLM 요청 실패 (${status}). endpoint 설정과 서버 로그를 확인하세요.`);
    this.name='LlmHttpError';
  }
}

export async function postJsonSafe(
  endpoint: string,
  payload: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const resolved = await resolveSafeEndpoint(endpoint);
  const { url, address, family } = resolved;
  const hasAuthorization = Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'authorization' && Boolean(value));
  assertCredentialsAllowed(resolved, hasAuthorization);
  const body = JSON.stringify(payload);
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = requester(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
        ...headers,
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let total = 0;

      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('LLM 응답이 1MB 제한을 초과했습니다.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (statusCode >= 300 && statusCode < 400) {
          reject(new Error(`LLM endpoint redirect는 보안상 허용되지 않습니다 (${statusCode}).`));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          const retryAfter=response.headers['retry-after'];
          const seconds=typeof retryAfter==='string'?Number(retryAfter):NaN;
          const retryAfterMs=typeof retryAfter!=='string'?undefined:Number.isFinite(seconds)?Math.max(0,seconds*1000):Number.isFinite(Date.parse(retryAfter))?Math.max(0,Date.parse(retryAfter)-Date.now()):undefined;
          reject(new LlmHttpError(statusCode,retryAfterMs,safeProviderDiagnostic(Buffer.concat(chunks).toString('utf8'),headers)));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reject(new Error('LLM 서버가 올바른 JSON을 반환하지 않았습니다.'));
        }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}
