// Local extraction only. No Google/OpenAI credentials or network calls.
/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker runs directly in Node. */
const {parentPort,workerData}=require('node:worker_threads');
const nativeRequire=require('node:module').createRequire(require('node:path').join(workerData.base,'package.json'));
async function extract(){
 const bytes=Buffer.from(workerData.bytes);const mime=workerData.mime;
 if(mime==='application/pdf'){
  const result=await nativeRequire('pdf-parse/lib/pdf-parse.js')(new Uint8Array(bytes),{version:'v2.0.550'});const text=(result.text||'').trim();
  if(text.replace(/\s/g,'').length<40)throw Object.assign(new Error('NO_TEXT'),{name:'NeedsOcrError'});
  return text;
 }
 if(mime==='text/csv')return bytes.toString('utf8');
 const Zip=nativeRequire('pizzip');const zip=new Zip(bytes);const entries=Object.values(zip.files);
 if(entries.length>3000||entries.reduce((sum,file)=>sum+(file._data?.uncompressedSize||0),0)>20*1024*1024)throw new Error('ZIP_LIMIT');
 if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'){
  const xml=zip.file('word/document.xml')?.asText()||'';
  return xml.replace(/<w:tab\/?[^>]*>/g,'\t').replace(/<\/w:p>/g,'\n').replace(/<[^>]+>/g,' ')
   .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/[ \t]+/g,' ').trim();
 }
 const Excel=nativeRequire('exceljs');const book=new Excel.Workbook();await book.xlsx.load(bytes);
 const lines=[];let chars=0;
 book.eachSheet(sheet=>{if(chars>65000)return;lines.push('Лист: '+sheet.name);sheet.eachRow({includeEmpty:false},row=>{
  if(chars>65000)return;const cells=[];row.eachCell({includeEmpty:false},cell=>{if(cell.text?.trim())cells.push(cell.text.trim());});
  const line=cells.join(' | ');chars+=line.length;if(line)lines.push(line);
 });});return lines.join('\n');
}
extract().then(text=>parentPort.postMessage({text:String(text).slice(0,65000)})).catch(error=>parentPort.postMessage({error:error.name==='NeedsOcrError'?'needs_ocr':'error'}));
