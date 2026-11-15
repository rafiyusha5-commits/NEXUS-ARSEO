import {randomUUID} from "node:crypto";
import {environment} from "./policy";
import {appendSafeLog} from "./local-log";
import {monitoringClient,recordObservation} from "./client";
export async function recordRequestFailure() {
  if(process.env.MONITORING_ENABLED!=="true")return;
  const env=environment(process.env.MONITORING_ENVIRONMENT);if(!env)return;
  const event={component:"app" as const,code:"FAILED" as const,observedAt:new Date().toISOString(),correlation:randomUUID()};
  await appendSafeLog(process.env.MONITORING_LOG_DIRECTORY,event);
  await recordObservation(monitoringClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.MONITORING_SERVICE_KEY),env,event);
}
