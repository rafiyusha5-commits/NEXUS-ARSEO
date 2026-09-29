import "server-only";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";

export const DOCX_MIME="application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function renderDocxTemplate(template:Uint8Array,data:Record<string,unknown>){
 try{
  const zip=new PizZip(template);
  const document=new Docxtemplater(zip,{paragraphLoop:true,linebreaks:true,nullGetter:()=>""});
  document.render(data);
  return document.getZip().generate({type:"uint8array",compression:"DEFLATE",mimeType:DOCX_MIME}) as Uint8Array;
 }catch(error){
  const details=error as {message?:string;properties?:{errors?:Array<{properties?:{explanation?:string}}>} };
  const explanation=details.properties?.errors?.map(item=>item.properties?.explanation).filter(Boolean).join("; ");
  throw new Error(`Не удалось заполнить DOCX-шаблон: ${explanation||details.message||"проверьте метки полей"}`);
 }
}
