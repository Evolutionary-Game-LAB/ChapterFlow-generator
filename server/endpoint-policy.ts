import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

type EndpointPolicyOptions = {
  allowPrivate?: boolean;
  lookup?: (hostname: string) => Promise<string[]>;
};

export type ResolvedEndpoint = {
  url: URL;
  address: string;
  family: 4 | 6;
  isLoopback: boolean;
};

type AddressKind = 'global' | 'loopback' | 'private' | 'metadata' | 'reserved';

function classifyAddress(address: string): AddressKind {
  try {
    const parsed = ipaddr.process(address);
    const range = parsed.range();
    if (range === 'unicast') return 'global';
    if (range === 'loopback') return 'loopback';
    if (range === 'linkLocal') return 'metadata';
    if (['private', 'uniqueLocal', 'carrierGradeNat', 'deprecatedSiteLocal'].includes(range)) return 'private';
    return 'reserved';
  } catch {
    return 'reserved';
  }
}

async function defaultLookup(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

export async function resolveSafeEndpoint(endpoint: string, options: EndpointPolicyOptions = {}): Promise<ResolvedEndpoint> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('LLM endpoint URL이 올바르지 않습니다.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('LLM endpoint는 http 또는 https URL이어야 합니다.');
  if (url.username || url.password) throw new Error('LLM endpoint URL에 인증 정보를 포함할 수 없습니다.');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostnameIsIp = isIP(hostname) !== 0;
  const addresses = hostnameIsIp ? [hostname] : await (options.lookup ?? defaultLookup)(hostname);
  if (addresses.length === 0) throw new Error('LLM endpoint의 주소를 확인할 수 없습니다.');

  const allowPrivate = options.allowPrivate ?? process.env.LLM_ALLOW_PRIVATE_NETWORK === 'true';
  const kinds = addresses.map(classifyAddress);
  for (const kind of kinds) {
    if (hostname === 'localhost' && kind !== 'loopback') throw new Error('차단된 endpoint 주소입니다.');
    if (kind === 'global') continue;
    if (kind === 'loopback' && (hostname === 'localhost' || hostnameIsIp)) continue;
    if (kind === 'private' && allowPrivate) continue;
    if (kind === 'private') throw new Error('사설 네트워크 endpoint는 기본적으로 차단됩니다. LLM_ALLOW_PRIVATE_NETWORK=true로 명시적으로 허용할 수 있습니다.');
    throw new Error('차단된 endpoint 주소입니다.');
  }

  const address = addresses[0];
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error('LLM endpoint의 IP 주소를 확인할 수 없습니다.');
  return { url, address, family, isLoopback: kinds.every((kind) => kind === 'loopback') };
}

export function assertCredentialsAllowed(endpoint: ResolvedEndpoint, hasCredentials: boolean): void {
  if (hasCredentials && endpoint.url.protocol !== 'https:' && !endpoint.isLoopback) {
    throw new Error('API Key가 있는 외부 LLM endpoint는 HTTPS를 사용해야 합니다.');
  }
}

export async function assertSafeEndpoint(endpoint: string, options: EndpointPolicyOptions = {}): Promise<void> {
  await resolveSafeEndpoint(endpoint, options);
}
