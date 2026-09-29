export type CalendarStatus = "scheduled" | "due_soon" | "overdue" | "completed" | "completed_late" | "cancelled";

export type CalendarEvent = {
  source_type: string; source_id: string; shipment_id: string; event_kind: string; title: string;
  planned_at: string; actual_at: string | null; event_status: CalendarStatus;
  supplier_id: string | null; customer_id: string | null; responsible_user_id: string | null;
  supplier_name: string | null; customer_name: string | null; route_name: string; shipment_number: string;
  responsible_name: string | null; details: string | null;
};

export const calendarStatusLabel: Record<CalendarStatus,string> = {
  scheduled:"По плану", due_soon:"Срок близко", overdue:"Просрочено",
  completed:"Выполнено", completed_late:"Выполнено с опозданием", cancelled:"Отменено",
};

export const eventKindLabel: Record<string,string> = {
  ready:"Готовность", loading:"Погрузка", arrival:"Прибытие", stage:"Этап", task:"Задача",
  document:"Документы", customs:"Таможня", payment:"Оплата", inspection:"Проверка", other:"Другое",
};

export function validMonth(value:string|undefined, now=new Date()) {
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Qyzylorda",year:"numeric",month:"2-digit"}).format(now).slice(0,7);
}

export function monthWindow(month:string) {
  const [year,number]=month.split("-").map(Number);
  const first=new Date(Date.UTC(year,number-1,1));
  const mondayOffset=(first.getUTCDay()+6)%7;
  const from=new Date(first); from.setUTCDate(first.getUTCDate()-mondayOffset);
  const to=new Date(from); to.setUTCDate(from.getUTCDate()+42);
  return {from:from.toISOString(),to:to.toISOString(),days:Array.from({length:42},(_,index)=>{const day=new Date(from);day.setUTCDate(from.getUTCDate()+index);return day.toISOString().slice(0,10);})};
}

export function shiftMonth(month:string, offset:number) {
  const [year,number]=month.split("-").map(Number);
  const date=new Date(Date.UTC(year,number-1+offset,1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}`;
}

export function eventDay(value:string) {
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Qyzylorda"}).format(new Date(value));
}

export function filterCalendarEvents(events:CalendarEvent[], filters:{supplier?:string;customer?:string;responsible?:string;kind?:string;status?:string}) {
  return events.filter((event)=>(!filters.supplier||event.supplier_id===filters.supplier)
    &&(!filters.customer||event.customer_id===filters.customer)
    &&(!filters.responsible||event.responsible_user_id===filters.responsible)
    &&(!filters.kind||event.event_kind===filters.kind)
    &&(!filters.status||event.event_status===filters.status));
}
