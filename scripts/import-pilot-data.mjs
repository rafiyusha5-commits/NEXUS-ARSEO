import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
}
function parseCsv(source) {
  const rows=[]; let row=[]; let cell=""; let quoted=false;
  for(let i=0;i<source.length;i++){const char=source[i];if(char==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(char===','&&!quoted){row.push(cell);cell="";}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&source[i+1]==='\n')i++;row.push(cell);if(row.some((value)=>value.trim()))rows.push(row);row=[];cell="";}else cell+=char;}
  row.push(cell); if(row.some((value)=>value.trim()))rows.push(row);
  const headers=rows.shift().map((value)=>value.replace(/^\uFEFF/,"").trim());
  return rows.map((values)=>Object.fromEntries(headers.map((header,index)=>[header,(values[index]??"").trim()])));
}
const yes=(value)=>["1","true","да","yes","y"].includes(String(value??"").trim().toLowerCase());
const root=process.cwd();
const env=parseEnv(await fs.readFile(path.join(root,".env.local"),"utf8"));
if(!env.NEXT_PUBLIC_SUPABASE_URL||!env.SUPABASE_SECRET_KEY) throw new Error("В .env.local не настроены Supabase URL и secret key.");
const supabase=createClient(env.NEXT_PUBLIC_SUPABASE_URL,env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});

const counterparties=parseCsv(await fs.readFile(path.join(root,"local-imports","01-counterparties-pilot.csv"),"utf8"));
const {data:currencies,error:currencyError}=await supabase.from("currencies").select("id,code");
if(currencyError)throw currencyError;
const currencyByCode=new Map(currencies.map((item)=>[item.code,item.id]));
const {data:existingParties,error:partyReadError}=await supabase.from("counterparties").select("id,legal_name,country,tax_id");
if(partyReadError)throw partyReadError;
const partyByName=new Map(existingParties.map((item)=>[item.legal_name.trim().toLowerCase(),item]));
let createdCounterparties=0;
for(const row of counterparties){const key=row.legal_name.toLowerCase();if(partyByName.has(key))continue;const {data,error}=await supabase.from("counterparties").insert({
  legal_name:row.legal_name,short_name:row.short_name||null,roles:row.roles.split("|").map((value)=>value.trim()).filter(Boolean),country:row.country.toUpperCase(),tax_id:row.tax_id||null,
  registration_number:row.registration_number||null,website:row.website||null,default_currency_id:currencyByCode.get(row.default_currency)||null,preferred_locale:row.preferred_locale||"ru",
  min_remaining_shelf_life_pct:row.min_shelf_life_pct?Number(row.min_shelf_life_pct):null,notes:row.notes||null,status:"active",
}).select("id,legal_name,country,tax_id").single();if(error)throw error;partyByName.set(key,data);createdCounterparties++;}

const products=parseCsv(await fs.readFile(path.join(root,"local-imports","02-products-pilot.csv"),"utf8"));
const {data:existingProducts,error:productReadError}=await supabase.from("products").select("id,internal_sku");
if(productReadError)throw productReadError;
const productBySku=new Map(existingProducts.map((item)=>[item.internal_sku,item.id]));
let createdProducts=0; let createdIdentifiers=0;
for(const row of products){let productId=productBySku.get(row.internal_sku);if(!productId){const manufacturer=partyByName.get(row.manufacturer.toLowerCase());if(!manufacturer)throw new Error(`Не найден производитель: ${row.manufacturer}`);const {data,error}=await supabase.from("products").insert({
  internal_sku:row.internal_sku,name:{ru:row.name_ru,...(row.name_en?{en:row.name_en}:{}),...(row.name_kk?{kk:row.name_kk}:{})},manufacturer_id:manufacturer.id,brand:row.brand||null,
  country_of_origin:row.country_of_origin||null,hs_code:row.hs_code||null,shelf_life_days:row.shelf_life_days?Number(row.shelf_life_days):null,base_uom:"piece",
  requires_sticker:yes(row.requires_sticker),requires_marking:yes(row.requires_marking),status:"active",
}).select("id").single();if(error)throw error;productId=data.id;productBySku.set(row.internal_sku,productId);createdProducts++;}
  const supplier=partyByName.get(row.supplier.toLowerCase());
  const candidates=[
    ["supplier_sku",row.supplier_sku,supplier?.id??null,true],["gtin",row.gtin,null,true],["unit_barcode",row.unit_barcode,null,false],["box_barcode",row.box_barcode,null,false],
  ].filter(([,value])=>value);
  for(const [identifierType,value,counterpartyId,isPrimary] of candidates){let query=supabase.from("product_identifiers").select("id").eq("identifier_type",identifierType).eq("value",value);if(identifierType==="supplier_sku"&&counterpartyId)query=query.eq("counterparty_id",counterpartyId);const {data:found,error:findError}=await query.maybeSingle();if(findError)throw findError;if(found)continue;const {error}=await supabase.from("product_identifiers").insert({product_id:productId,identifier_type:identifierType,value,counterparty_id:counterpartyId,is_primary:isPrimary});if(error)throw error;createdIdentifiers++;}
}
console.log(JSON.stringify({createdCounterparties,createdProducts,createdIdentifiers,totalCounterparties:counterparties.length,totalProducts:products.length}));
