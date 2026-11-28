"use client";

// Sound and vibration for the result of a scan, so it is clear without looking: one short signal when the code is
// known, two low ones when it is not.
import { useEffect } from "react";

export function ScanFeedback({ ok, signature }: { ok: boolean; signature: string }) {
  useEffect(() => {
    try { navigator.vibrate?.(ok ? 60 : [90, 60, 90]); } catch { /* not every browser vibrates */ }
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      const audio = new Context();
      const beep = (frequency: number, start: number) => {
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        oscillator.frequency.value = frequency;
        gain.gain.value = 0.08;
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(audio.currentTime + start);
        oscillator.stop(audio.currentTime + start + 0.12);
      };
      if (ok) beep(1046, 0); else { beep(330, 0); beep(262, 0.18); }
      setTimeout(() => audio.close(), 600);
    } catch { /* sound is a convenience */ }
  }, [ok, signature]);
  return null;
}
