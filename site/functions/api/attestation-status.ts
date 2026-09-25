// Cloudflare Pages Function: Google's Android key attestation revocation list, served same-origin
// at `/api/attestation-status` for the collect page's device row (`publications/core/attestationCheck.ts`).
//
// https://android.googleapis.com/attestation/status sends no `Access-Control-Allow-Origin` header
// (checked 2026-09-24), so a browser page on another origin cannot read it. The list is public and
// identical for every caller, so this Function fetches it, checks it is the documented shape,
// re-serialises only `status` and `reason` per serial, and keeps it in Cloudflare's Cache API for
// an hour: one upstream request per hour per data centre, whatever the traffic. GET only (Pages
// routes nothing else to `onRequestGet`), no query string reaches the cache key, and the upstream
// body is bounded before it is parsed. It spends no RPC budget.
//
// `_headers` does NOT apply to Functions responses
// (https://developers.cloudflare.com/pages/configuration/headers/), so every response here sets
// its own security headers, as `solana.ts` does.
export const UPSTREAM='https://android.googleapis.com/attestation/status';
export const MAX_UPSTREAM=4000000; // bytes; 179 KB on 2026-09-24.
const TTL_SECONDS=3600;             // Google sends max-age=86400; an hour keeps new revocations close.
const SERIAL=/^[0-9a-f]+$/;        // hex, as documented, or decimal, as the live list also uses.
const SECURITY={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'};
const size=(value:string)=>new TextEncoder().encode(value).byteLength;
const unavailable=()=>new Response(JSON.stringify({error:{message:'Revocation list unavailable.'}}),{status:502,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...SECURITY}});
/**
 * The documented shape, reduced to what a reader uses; `null` for anything else. A well-formed
 * entry under a key no serial is looked up by is dropped, as `parseRevocationList` does, rather
 * than failing the whole list.
 */
function reshape(json:unknown):Record<string,{status:string;reason?:string}>|null{
  const entries=(json as {entries?:unknown}|null)?.entries;
  if(!entries||typeof entries!=='object'||Array.isArray(entries))return null;
  const out:Record<string,{status:string;reason?:string}>={};
  for(const [key,value] of Object.entries(entries as Record<string,unknown>)){
    const entry=value as {status?:unknown;reason?:unknown}|null;
    if(!entry||typeof entry!=='object'||typeof entry.status!=='string')return null;
    if(!SERIAL.test(key))continue;
    out[key]=typeof entry.reason==='string'?{status:entry.status,reason:entry.reason}:{status:entry.status};
  }
  return out;
}
/** The Workers runtime's `caches.default`, typed here so the file needs no Workers type package. */
interface EdgeCache{match(request:Request):Promise<Response|undefined>;put(request:Request,response:Response):Promise<void>}
export async function onRequestGet({request,waitUntil}:{request:Request;waitUntil(promise:Promise<unknown>):void}):Promise<Response>{
  const cache=(globalThis as unknown as {caches:{default:EdgeCache}}).caches.default;
  const key=new Request(new URL('/api/attestation-status',request.url).href);
  const hit=await cache.match(key);if(hit)return hit;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const upstream=await fetch(UPSTREAM,{signal:controller.signal});
    if(!upstream.ok)return unavailable();
    const length=Number(upstream.headers.get('Content-Length'));
    if(Number.isFinite(length)&&length>MAX_UPSTREAM)return unavailable();
    const raw=await upstream.text();if(size(raw)>MAX_UPSTREAM)return unavailable();
    let entries:ReturnType<typeof reshape>;try{entries=reshape(JSON.parse(raw));}catch{return unavailable();}
    if(!entries)return unavailable();
    const response=new Response(JSON.stringify({entries}),{headers:{'Content-Type':'application/json','Cache-Control':`public, max-age=${TTL_SECONDS}`,...SECURITY}});
    waitUntil(cache.put(key,response.clone()));
    return response;
  }catch{return unavailable();}finally{clearTimeout(timer);}
}
