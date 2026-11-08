"use client";
import { useState } from "react";
export function ReplenishmentShare({ run, date, enabled }: { run: string; date: string; enabled: boolean }) {
  const [prose, setProse] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const download = `/replenishment/export?run=${run}`;
  const text = `Nexus: предложение заказа для Казахстана на ${date}. Требует проверки и согласования. Excel прикладывается отдельно.`;
  async function explain() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/replenishment/explain?run=${run}`, { method: "POST" });
      if (!response.ok) { setMessage(await response.text()); return; }
      const body = await response.json(); setProse(String(body.explanation));
    } catch { setMessage("Не удалось получить пояснение. Расчёт доступен в таблице."); } finally { setBusy(false); }
  }
  async function shareFile() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(download);
      if (!response.ok) { setMessage(await response.text()); return; }
      const file = new File([await response.blob()], `Nexus-KZ-${date}.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: "Предложение автозаказа", text, files: [file] });
      else setMessage("Скачайте Excel, откройте WhatsApp или Telegram, выберите получателя и прикрепите файл. Отправка выполняется вами.");
    } catch { setMessage("Отправка не подтверждена. Можно скачать Excel и приложить его вручную."); } finally { setBusy(false); }
  }
  return <section className="admin-panel replenishment-share">
    <h2>Объяснение и передача предложения</h2>
    <button type="button" disabled={!enabled || busy} onClick={explain}>Объяснить результат с помощью ИИ</button>
    {prose && <div className="setup-notice"><strong>Пояснение модели — проверьте по таблице</strong><p>{prose}</p></div>}
    {enabled && <p><a className="document-download-link" href={download}>Скачать Excel с расчётом и основаниями</a></p>}
    <label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} disabled={!enabled}/> Я проверю файл и получателя перед отправкой</label>
    <div className="replenishment-actions">
      <button type="button" disabled={!enabled || !reviewed || busy} onClick={shareFile}>Выбрать приложение и получателя</button>
      {enabled && reviewed && <><a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">Подготовить сообщение WhatsApp</a><a href={`https://t.me/share/url?url=&text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">Подготовить сообщение Telegram</a></>}
    </div>
    <p className="muted">Ссылки открывают сообщение. Excel нужно прикрепить перед отправкой. Получателя и отправку выбираете вы.</p>
    {message && <p role="status">{message}</p>}
  </section>;
}
