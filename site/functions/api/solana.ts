// Cloudflare Pages Function. The upstream is the SOLANA_RPC_URL environment secret when it is
// set, and Solana's public mainnet endpoint otherwise, which is rate-limited and "not intended for
// production applications" (https://solana.com/docs/references/clusters); see site/README.md.
// Read-only method allowlist: wallet submission goes through the wallet's own RPC, and the list
// is exactly the twelve methods `site/collect/` calls — nothing wider gets to spend the
// operator's provider budget. It is exported so a test can assert that it
// EQUALS the set of methods the page was observed using; Cloudflare routes only `onRequest*`
// exports, so exporting a constant adds no endpoint.
//
// `_headers` does NOT apply to Functions responses
// (https://developers.cloudflare.com/pages/configuration/headers/), so every response here —
// including the refusals — sets its own security headers.
//
// Rate limiting is the control that actually bounds spend, and Cloudflare Pages keeps it in the
// dashboard rather than in this repository. The rule that must be applied is written down in
// `site/cloudflare/README.md` and mirrored in `site/cloudflare/rate-limit-rule.json`.
// `getRecentPrioritizationFees` was added in batch 3: `prepareTransaction` now derives the
// compute-budget price from it (audit B-8) and the collector page shares that code path. It is
// read-only, takes one empty-array param and answers ~150 small entries; leaving it off the list
// would make every collect send a request this Function refuses.
// `getTokenAccountsByOwner` is the Seeker Genesis Token check (`verifyGenesisToken`): one wallet,
// filtered to one mint, so it answers at most a couple of token accounts. It runs against this
// proxy for devnet editions too, because the SGT exists on mainnet only. `getGenesisHash` is how
// that check confirms the upstream is mainnet before believing it (`assertMainnet`); no params.
// `getSignaturesForAddress` and `getTransaction` are the device row's publication time
// (`publicationTime` in `publications/core/attestationCheck.ts`): the history of one claim
// receipt, normally a single entry, and the ~10 KB parsed transaction that created it.
export const ALLOWED=new Set(['getAccountInfo','getLatestBlockhash','simulateTransaction','getFeeForMessage','getBalance','getSignatureStatuses','getBlockHeight','getRecentPrioritizationFees','getTokenAccountsByOwner','getGenesisHash','getSignaturesForAddress','getTransaction']);
const MAX_BODY=16000;      // bytes, not UTF-16 code units: 16 000 astral characters is 64 000 bytes.
export const MAX_UPSTREAM=1000000;// bytes of provider response this Function will buffer and re-serialise.
const MAX_PARAMS=8;        // the widest call the collector makes passes two.
const MAX_DEPTH=6;         // `simulateTransaction` nests params → options → accounts → addresses.
const MAX_SLICE=262144;    // one ELF chunk (`CHUNK_BYTES`, `publications/programImage.ts`), the widest slice asked.
const MAX_ACCOUNT=10485760;// Solana's largest account (10 MiB); no slice starts past it.
const SECURITY={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const size=(value:string)=>new TextEncoder().encode(value).byteLength;
const refuse=(message:string,status:number,extra:Record<string,string>)=>new Response(message,{status,headers:{...SECURITY,...extra,'Content-Type':'text/plain; charset=utf-8'}});
/** Bounded shape check: an allowlisted method's params never nest deeper than four. */
function shallow(value:unknown,depth:number):boolean{
  if(depth>MAX_DEPTH)return false;
  if(Array.isArray(value))return value.length<=MAX_PARAMS&&value.every((item)=>shallow(item,depth+1));
  if(value&&typeof value==='object')return Object.values(value as Record<string,unknown>).every((item)=>shallow(item,depth+1));
  return true;
}
type Check=(value:unknown)=>boolean;
const is=(expected:unknown):Check=>(value)=>value===expected;
const base58=(min:number,max:number):Check=>(value)=>typeof value==='string'&&value.length>=min&&value.length<=max&&/^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
const pubkey=base58(32,44),signature=base58(64,88);
const int=(min:number,max:number):Check=>(value)=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
/** An object of these keys only, `required` ones present, each passing its check. Own keys only. */
const object=(fields:Record<string,Check>,required:readonly string[]):Check=>(value)=>
  !!value&&typeof value==='object'&&!Array.isArray(value)&&required.every((key)=>Object.hasOwn(value,key))&&
  Object.entries(value).every(([key,item])=>Object.hasOwn(fields,key)&&fields[key](item));
/**
 * The methods whose params could widen what the provider does, held to exactly what the page sends
 * (`scripts/check-site.ts` replays the page's own requests through this Function):
 *   getAccountInfo           `account` in `publications/core/protocol.ts`; sliced by
 *                            `publications/programImage.ts` and `publications/core/genesisToken.ts`.
 *   getTokenAccountsByOwner  `genesisHolding` in `genesisToken.ts`: one wallet, one mint, parsed.
 *   getSignaturesForAddress  `publicationTime` in `publications/core/attestationCheck.ts`.
 *   getTransaction           the same, for the transaction that created the claim receipt.
 * The others take a fixed few scalars and keep the generic `shallow` bound.
 */
const SHAPES:Record<string,readonly Check[]>={
  getAccountInfo:[pubkey,object({encoding:is('base64'),commitment:is('confirmed'),dataSlice:object({offset:int(0,MAX_ACCOUNT),length:int(0,MAX_SLICE)},['offset','length'])},['encoding','commitment'])],
  getTokenAccountsByOwner:[pubkey,object({mint:pubkey},['mint']),object({encoding:is('jsonParsed'),commitment:is('confirmed')},['encoding','commitment'])],
  getSignaturesForAddress:[pubkey,object({limit:int(1,1000),commitment:is('confirmed'),before:signature},['limit','commitment'])],
  getTransaction:[signature,object({encoding:is('jsonParsed'),maxSupportedTransactionVersion:is(0),commitment:is('confirmed')},['encoding','maxSupportedTransactionVersion','commitment'])],
};
const shaped=(method:string,params:unknown[])=>{const shape=SHAPES[method];return !shape||(params.length===shape.length&&shape.every((check,i)=>check(params[i])));};
/**
 * The upstream body, counted as it streams and cancelled past `limit`, so a response with no (or
 * an untrue) Content-Length is bounded too. `null` when it is over.
 */
async function bounded(response:Response,limit:number):Promise<string|null>{
  const reader=response.body?.getReader();if(!reader)return '';
  const chunks:Uint8Array[]=[];let length=0;
  for(;;){
    const {done,value}=await reader.read();if(done)break;
    length+=value.byteLength;
    if(length>limit){await reader.cancel().catch(()=>undefined);return null;}
    chunks.push(value);
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder().decode(bytes);
}
interface Env { SOLANA_RPC_URL?: string }
export const PUBLIC_MAINNET='https://api.mainnet.solana.com';
export async function onRequestPost({request,env}:{request:Request;env:Env}):Promise<Response> {
  // The public fallback says so on every answer, so a lost secret shows in any response's headers.
  const upstreamUrl=env.SOLANA_RPC_URL||PUBLIC_MAINNET,visible:Record<string,string>=env.SOLANA_RPC_URL?{}:{'X-Upstream':'public'};
  const headers={'Content-Type':'application/json','Cache-Control':'no-store',...SECURITY,...visible};
  const unavailable=()=>new Response(JSON.stringify({error:{message:'Solana connection unavailable. Please retry.'}}),{status:502,headers});
  // A MISSING Origin is untrusted, not trusted. The only legitimate caller is the same-origin
  // page, which always sends one; a header is forgeable, so this removes the trivial `curl`
  // path and nothing more. The bound on cost is the Cloudflare rate-limit rule, not this line.
  if(request.headers.get('Origin')!==new URL(request.url).origin)return refuse('Forbidden',403,visible);
  // Refuse on the declared size before reading anything, then on the decoded bytes, because
  // Content-Length may be absent (chunked) or untrue.
  const declared=Number(request.headers.get('Content-Length'));
  if(Number.isFinite(declared)&&declared>MAX_BODY)return refuse('Request too large',413,visible);
  const text=await request.text();if(size(text)>MAX_BODY)return refuse('Request too large',413,visible);
  let body: {method?:string;params?:unknown;jsonrpc?:string};try{body=JSON.parse(text);}catch{return refuse('Invalid JSON',400,visible);}
  if(!body||Array.isArray(body)||body.jsonrpc!=='2.0'||!ALLOWED.has(body.method??'')||!Array.isArray(body.params))return refuse('Unsupported request',400,visible);
  if(!shallow(body.params,1)||!shaped(body.method!,body.params))return refuse('Unsupported request',400,visible);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try {
    const upstream=await fetch(upstreamUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:text,signal:controller.signal});
    // Provider errors can include credentials/URLs. Never forward those details.
    if(!upstream.ok)return unavailable();
    // A declared oversize response is refused without reading it; any other is counted as it
    // streams and cut off at the cap.
    const length=Number(upstream.headers.get('Content-Length'));
    if(Number.isFinite(length)&&length>MAX_UPSTREAM)return unavailable();
    const raw=await bounded(upstream,MAX_UPSTREAM);if(raw===null)return unavailable();
    let json: {error?:unknown};try{json=JSON.parse(raw);}catch{return unavailable();}
    return new Response(JSON.stringify(json.error?{jsonrpc:'2.0',id:1,error:{message:'Solana could not complete this request. Please retry.'}}:json),{headers});
  }catch{return new Response(JSON.stringify({error:{message:'Solana connection timed out.'}}),{status:504,headers});}finally{clearTimeout(timer);}
}
