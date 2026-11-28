"use client";

// One field for every way of scanning (202611280500): a Bluetooth or USB scanner working as a keyboard (fast keys and
// Enter), the phone camera (BarcodeDetector where the browser has it, else the bundled ZXing reader — iPhone), typing.
// A scan only opens the lookup page; nothing is written. GS1 codes are parsed here and passed as GTIN, batch, expiry.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { scanHref } from "@/lib/scan/href";
import { inputSource, type KeyStroke } from "@/lib/scan/input";

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = new (options: { formats: string[] }) => Detector;
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "data_matrix", "qr_code"];

/** `onCode` handles the code in place (a form being filled: receiving) instead of opening `target`. */
export function ScanField({ target = "/m/scan", label = "Код: отсканируйте или введите", placeholder = "Штрихкод, этикетка Nexus или код GS1", onCode }: {
  target?: string; label?: string; placeholder?: string; onCode?: (raw: string, via: "scanner" | "manual" | "camera") => void }) {
  const router = useRouter();
  const strokes = useRef<KeyStroke[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const stopCamera = useRef<() => void>(() => {});
  const [value, setValue] = useState("");
  const [camera, setCamera] = useState<"off" | "starting" | "on" | "failed">("off");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => () => stopCamera.current(), []);

  const open = (raw: string, via: "scanner" | "manual" | "camera") => {
    if (!raw.trim()) return;
    stopCamera.current();
    if (onCode) onCode(raw.trim(), via);
    else router.push(scanHref(raw, via, target));
  };

  const startCamera = async () => {
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera("failed");
      setMessage("Камера недоступна: нужен защищённый адрес (https) и разрешение браузера. Используйте сканер или ввод.");
      return;
    }
    setCamera("starting");
    try {
      const Native = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
      if (Native && video.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        let active = true;
        stopCamera.current = () => { active = false; stream.getTracks().forEach(track => track.stop()); setCamera("off"); };
        video.current.srcObject = stream;
        await video.current.play();
        setCamera("on");
        const detector = new Native({ formats: FORMATS });
        const tick = async () => {
          if (!active || !video.current) return;
          try {
            const found = await detector.detect(video.current);
            if (found[0]?.rawValue) { open(found[0].rawValue, "camera"); return; }
          } catch { /* a frame that cannot be read: try the next one */ }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } else if (video.current) {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromVideoDevice(undefined, video.current, result => {
          if (result) open(result.getText(), "camera");
        });
        stopCamera.current = () => { controls.stop(); setCamera("off"); };
        setCamera("on");
      }
    } catch {
      stopCamera.current();
      setCamera("failed");
      setMessage("Не удалось включить камеру. Разрешите доступ к камере для Nexus или используйте сканер и ввод.");
    }
  };

  return <div className="scan-field">
    <form onSubmit={event => { event.preventDefault(); open(value, inputSource([...strokes.current, { key: "Enter", at: performance.now() }])); strokes.current = []; setValue(""); }}>
      <label className="scan-label" htmlFor="scan-input">{label}</label>
      <input id="scan-input" className="scan-input" value={value} autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false}
        enterKeyHint="search" inputMode="text" placeholder={placeholder}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter") return;
          strokes.current.push({ key: event.key, at: performance.now() });
          if (strokes.current.length > 400) strokes.current = strokes.current.slice(-200);
        }}/>
      <div className="scan-actions">
        <button className="primary scan-button" type="submit">Найти</button>
        {camera === "on" || camera === "starting"
          ? <button className="ghost scan-button" type="button" onClick={() => stopCamera.current()}>Выключить камеру</button>
          : <button className="secondary scan-button" type="button" onClick={startCamera}>Камера</button>}
      </div>
    </form>
    <video ref={video} className="scan-video" playsInline muted hidden={camera !== "on" && camera !== "starting"}/>
    {message && <p className="load-warning-text scan-message" role="status">{message}</p>}
  </div>;
}
