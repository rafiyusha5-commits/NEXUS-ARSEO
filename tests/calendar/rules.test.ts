import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { eventDay,filterCalendarEvents,monthWindow,shiftMonth,validMonth,type CalendarEvent } from "../../src/lib/calendar/rules.ts";

const event=(overrides:Partial<CalendarEvent>={}):CalendarEvent=>({source_type:"shipment",source_id:"1",shipment_id:"s1",event_kind:"arrival",title:"Прибытие",planned_at:"2026-09-30T19:30:00Z",actual_at:null,event_status:"scheduled",supplier_id:"supplier-1",customer_id:"customer-1",responsible_user_id:"user-1",supplier_name:"Factory",customer_name:"Buyer",route_name:"FI → KZ",shipment_number:"NAR-1",responsible_name:"Рафия",details:null,...overrides});

describe("shipment calendar rules",()=>{
 it("builds a six-week Monday-first grid around a month",()=>{const window=monthWindow("2026-09");assert.equal(window.days.length,42);assert.equal(window.days[0],"2026-08-31");assert.equal(window.days[41],"2026-10-11");assert.ok(window.from<window.to);});
 it("moves over year boundaries and rejects malformed months",()=>{assert.equal(shiftMonth("2026-01",-1),"2025-12");assert.equal(shiftMonth("2026-12",1),"2027-01");assert.equal(validMonth("2026-13",new Date("2026-09-01T00:00:00Z")),"2026-09");});
 it("groups timestamps by the Kazakhstan calendar day",()=>{assert.equal(eventDay("2026-09-30T20:30:00Z"),"2026-10-01");});
 it("combines all explicit filters",()=>{const rows=[event(),event({source_id:"2",supplier_id:"supplier-2",event_kind:"task"}),event({source_id:"3",event_status:"overdue"})];assert.deepEqual(filterCalendarEvents(rows,{supplier:"supplier-1",kind:"arrival",status:"scheduled"}).map(row=>row.source_id),["1"]);});
});
