import assert from "node:assert/strict";
import {createClient} from "@supabase/supabase-js";
import {createSupabaseAgentData} from "../../src/lib/agent/server/supabase-data.ts";
const id="11111111-1111-4111-8111-111111111111";const urls:URL[]=[];let grants=["products.view","prices.purchase.view","agent.use","tasks.view"];
const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
 const u=new URL(String(url));urls.push(u);
 if(u.pathname.endsWith("/my_permissions"))return Response.json(grants);
 if(u.pathname.endsWith("/my_product_purchase_prices")){assert.deepEqual(JSON.parse(String(init?.body)),{p_product_ids:[id]});return Response.json([{product_id:id,base_purchase_price:7}]);}
 return Response.json([{id,nutrition_facts:{basis:"100g",protein_g:6.5}}],{headers:{"Content-Range":"0-0/1"}});
}) as typeof fetch;
const data=createSupabaseAgentData(createClient("https://demo.supabase.co","public-demo",{global:{fetch:fetcher},auth:{persistSession:false,autoRefreshToken:false}}));
const signal=new AbortController().signal;
await data.readSystem({section:"products",userId:id,query:"Fazer",offset:0,limit:20},signal);
assert.ok(urls.some(u=>u.searchParams.get("select")?.includes("nutrition_facts")));assert.ok(urls.every(u=>!u.searchParams.get("select")?.includes("base_purchase_price")));
urls.length=0;await data.readSystem({section:"product_prices",userId:id,recordId:id,offset:0,limit:20},signal);assert.ok(urls.some(u=>u.pathname.endsWith("/my_product_purchase_prices")));
grants=["agent.use","products.view"];urls.length=0;await assert.rejects(data.readSystem({section:"product_prices",userId:id,recordId:id,offset:0,limit:20},signal));assert.ok(urls.every(u=>u.pathname.endsWith("/my_permissions")));
await assert.rejects(data.readSystem({section:"products",userId:id,relatedBy:"base_purchase_price",parentId:id,offset:0,limit:20},signal));
grants=["agent.use","tasks.view"];urls.length=0;await data.readSystem({section:"tasks",userId:id,date:"2026-10-09",dateTo:"2026-10-09",offset:0,limit:20},signal);
assert.ok(urls.some(u=>u.searchParams.getAll("due_at").includes("lt.2026-10-10T00:00:00+05:00")));
console.log("Archivist server checks passed");

urls.length=0;
assert.equal(await data.verifySystemAccess([{section:"products",ids:[id]}],signal),true);
assert.ok(urls.some(u=>u.searchParams.get("select")==="id" && u.searchParams.get("id")?.startsWith("in.(")));
