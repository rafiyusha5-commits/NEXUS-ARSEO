"use client";
import { useEffect,useRef,useState } from "react";
import { RequestProgress } from "./request-progress";
export function CatalogSync({ ocrEnabled = false }: { ocrEnabled?: boolean }) {
 const [running,setRunning]=useState(false);const [message,setMessage]=useState("");const stop=useRef(false);
 useEffect(()=>()=>{stop.current=true;},[]);
 async function run(ocr = false) {
  setRunning(true);setMessage("");stop.current=false;let steps=0;
  try {for(let operation=ocr?"start_ocr":"start";!stop.current;) {
   const response=await fetch("/api/drive/catalog/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation}),signal:AbortSignal.timeout(ocr?150000:55000)});
   if(!response.ok)throw new Error();const result=await response.json();
   if(result.status==="completed"){setMessage(ocr?"Пакет OCR завершён. Обновите страницу. Следующий пакет запускается той же кнопкой.":"Каталог обновлён. Обновите страницу, чтобы увидеть результаты.");break;}
   if(["failed","unavailable","idle"].includes(result.status))throw new Error();
   setMessage(`${result.status==="busy" ? "Ожидаю завершения другого обработчика" : ocr ? "Распознаю сканы" : result.status==="extracting" ? "Читаю текст документов" : "Обновляю каталог"} · шаг ${++steps}`);
   if(result.status!=="busy" || result.runId)operation=ocr?"ocr_step":"step";
   if(result.status==="busy")await new Promise(resolve=>setTimeout(resolve,2000));
  }}catch{setMessage("Обновление прервано. Можно продолжить той же кнопкой; файлы Google Drive не изменены.");}
  finally{setRunning(false);}
 }
 return <div className="archive-actions"><button className="ghost" type="button" disabled={running} onClick={()=>run()}>Обновить каталог Nexus</button>{ocrEnabled&&<button className="ghost" type="button" disabled={running} onClick={()=>run(true)}>Распознать следующий пакет сканов</button>}{running&&<button className="ghost" type="button" onClick={()=>{stop.current=true;setMessage("После текущего шага обновление остановится. Его можно продолжить.");}}>Приостановить</button>}{running ? <RequestProgress label={message || "Начинаю обработку…"} /> : <p role="status">{message}</p>}<p>Обновление идёт, пока эта страница открыта. Google Drive используется только для чтения.</p></div>;
}
