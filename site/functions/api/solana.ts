// Cloudflare Pages Function: the read-only Solana JSON-RPC proxy the collect page uses on mainnet.
// The upstream is the SOLANA_RPC_URL secret, or else Solana's public mainnet endpoint, which is
// rate-limited and "not intended for production applications"
// (https://solana.com/docs/references/clusters); see site/README.md.
//
// ALLOWED is exactly the read-only methods `site/collect/` calls (transactions go out through the
// wallet's own RPC), so nothing wider spends the provider budget. It is exported so
// `scripts/check-site.ts` can assert it equals the page's methods; Cloudflare routes only
// `onRequest*` exports, so the export adds no endpoint. Beyond the plain reads and simulation:
// `getRecentPrioritizationFees` prices compute (`prepareTransaction`), `getGenesisHash` confirms
// the upstream is mainnet before a Genesis Token check (`assertMainnet`), and the methods in SHAPES
// serve the Genesis Token and device rows. The SGT exists on mainnet only, so devnet editions use
// this proxy for that check too.
//
// `_headers` does NOT apply to Functions responses
// (https://developers.cloudflare.com/pages/configuration/headers/), so every response here,
// refusals included, sets its own security headers.
//
// The Cloudflare rate-limit rule is what bounds spend. It lives in the dashboard; the rule to apply
// is in site/README.md and mirrored in site/cloudflare/rate-limit-rule.json.
export const ALLOWED=new Set(['getAccountInfo','getLatestBlockhash','simulateTransaction','getFeeForMessage','getBalance','getSignatureStatuses','getBlockHeight','getRecentPrioritizationFees','getTokenAccountsByOwner','getMultipleAccounts','getGenesisHash','getSignaturesForAddress','getTransaction']);
const MAX_BODY=16000;      // bytes, not UTF-16 code units: 16 000 astral characters is 64 000 bytes.
export const MAX_UPSTREAM=1000000;// bytes of provider response this Function will buffer and re-serialise.
const MAX_PARAMS=8;        // the widest call the collector makes passes two.
const MAX_DEPTH=6;         // `simulateTransaction` nests params → options → accounts → addresses.
const MAX_SLICE=262144;    // one ELF chunk (`CHUNK_BYTES`, `publications/programImage.ts`), the widest slice asked.
const MAX_ACCOUNT=10485760;// Solana's largest account (10 MiB); no slice starts past it.
const MAX_KEYS=100;        // `getMultipleAccounts`' own limit, and `MINT_BATCH` in `genesisToken.ts`.
const MINT_SLICE=4096;     // `MINT_SLICE_BYTES` in `publications/core/genesisToken.ts`.
const SECURITY={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const size=(value:string)=>new TextEncoder().encode(value).byteLength;
const refuse=(message:string,status:number,extra:Record<string,string>)=>new Response(message,{status,headers:{...SECURITY,...extra,'Content-Type':'text/plain; charset=utf-8'}});
/** Bounded shape check: no deeper than MAX_DEPTH, no array longer than MAX_PARAMS. */
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
const pubkeys=(max:number):Check=>(value)=>Array.isArray(value)&&value.length>=1&&value.length<=max&&value.every(pubkey);
const int=(min:number,max:number):Check=>(value)=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
/** An object of these keys only, `required` ones present, each passing its check. Own keys only. */
const object=(fields:Record<string,Check>,required:readonly string[]):Check=>(value)=>
  !!value&&typeof value==='object'&&!Array.isArray(value)&&required.every((key)=>Object.hasOwn(value,key))&&
  Object.entries(value).every(([key,item])=>Object.hasOwn(fields,key)&&fields[key](item));
const either=(...checks:Check[]):Check=>(value)=>checks.some((check)=>check(value));
const TOKEN_2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/**
 * The methods whose params could widen what the provider does, held to exactly what the page sends
 * (`scripts/check-site.ts` replays the page's own requests through this Function):
 *   getAccountInfo           `account` in `publications/core/protocol.ts`; sliced by
 *                            `publications/programImage.ts` and `publications/core/genesisToken.ts`.
 *   getTokenAccountsByOwner  `genesisHolding` in `genesisToken.ts`: one wallet, one mint, parsed;
 *                            or `findHeldGenesisToken` there: one wallet, Token-2022 only, parsed.
 *   getMultipleAccounts      `findHeldGenesisToken`'s candidate mints: 1 to 100, each sliced to
 *                            the first `MINT_SLICE` bytes (about 560 KB of base64, under MAX_UPSTREAM).
 *   getSignaturesForAddress  `publicationTime` in `publications/core/attestationCheck.ts`: the
 *                            history of one claim receipt.
 *   getTransaction           the same, for the transaction that created the claim receipt.
 * The others take a fixed few scalars and keep the generic `shallow` bound.
 */
const SHAPES:Record<string,readonly Check[]>={
  getAccountInfo:[pubkey,object({encoding:is('base64'),commitment:is('confirmed'),dataSlice:object({offset:int(0,MAX_ACCOUNT),length:int(0,MAX_SLICE)},['offset','length'])},['encoding','commitment'])],
  getTokenAccountsByOwner:[pubkey,either(object({mint:pubkey},['mint']),object({programId:is(TOKEN_2022)},['programId'])),object({encoding:is('jsonParsed'),commitment:is('confirmed')},['encoding','commitment'])],
  getMultipleAccounts:[pubkeys(MAX_KEYS),object({encoding:is('base64'),commitment:is('confirmed'),dataSlice:object({offset:is(0),length:is(MINT_SLICE)},['offset','length'])},['encoding','commitment','dataSlice'])],
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
  // A missing Origin is refused too: the same-origin page always sends one. The header is
  // forgeable, so this only stops the trivial `curl` path; the rate-limit rule bounds cost.
  if(request.headers.get('Origin')!==new URL(request.url).origin)return refuse('Forbidden',403,visible);
  // Refuse on the declared size before reading anything, then on the decoded bytes, because
  // Content-Length may be absent (chunked) or untrue.
  const declared=Number(request.headers.get('Content-Length'));
  if(Number.isFinite(declared)&&declared>MAX_BODY)return refuse('Request too large',413,visible);
  const text=await request.text();if(size(text)>MAX_BODY)return refuse('Request too large',413,visible);
  let body: {method?:string;params?:unknown;jsonrpc?:string};try{body=JSON.parse(text);}catch{return refuse('Invalid JSON',400,visible);}
  if(!body||Array.isArray(body)||body.jsonrpc!=='2.0'||!ALLOWED.has(body.method??'')||!Array.isArray(body.params))return refuse('Unsupported request',400,visible);
  // `getMultipleAccounts`' key list is the one array wider than MAX_PARAMS; its shape bounds it.
  const nested=body.method==='getMultipleAccounts'?body.params.slice(1):body.params;
  if(!shallow(nested,1)||!shaped(body.method!,body.params))return refuse('Unsupported request',400,visible);
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
