"use client";
import { useEffect,useRef,useState } from "react";
export function CatalogSync() {
 const [running,setRunning]=useState(false);const [message,setMessage]=useState("");const stop=useRef(false);
 useEffect(()=>()=>{stop.current=true;},[]);
 async function run() {
  setRunning(true);stop.current=false;let steps=0;
  try {for(let operation="start";!stop.current;) {
   const response=await fetch("/api/drive/catalog/sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation}),signal:AbortSignal.timeout(55000)});
   if(!response.ok)throw new Error();const result=await response.json();
   if(result.status==="completed"){setMessage("Каталог обновлён. Обновите страницу, чтобы увидеть результаты.");break;}
   if(["failed","unavailable","idle"].includes(result.status))throw new Error();
   setMessage(`${result.status==="extracting" ? "Читаю текст документов" : "Обновляю каталог"} · шаг ${++steps}`);
   operation="step";
   if(result.status==="busy")await new Promise(resolve=>setTimeout(resolve,2000));
  }}catch{setMessage("Обновление прервано. Можно продолжить той же кнопкой; файлы Google Drive не изменены.");}
  finally{setRunning(false);}
 }
 return <div><button type="button" disabled={running} onClick={run}>Обновить каталог Nexus</button>{running&&<button type="button" onClick={()=>{stop.current=true;setMessage("После текущего шага обновление остановится. Его можно продолжить.");}}>Приостановить</button>}<p role="status">{message}</p><p>Обновление идёт, пока эта страница открыта. Google Drive используется только для чтения.</p></div>;
}
