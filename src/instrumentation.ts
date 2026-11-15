import type { Instrumentation } from "next";
// No request/error fields are read. Logging failure cannot break the original request.
export const onRequestError: Instrumentation.onRequestError = async () => {
  try{
    if(process.env.NEXT_RUNTIME==="nodejs") {
      const {recordRequestFailure}=await import("./lib/monitoring/request-error");
      await recordRequestFailure();
    }
  }catch{ /* Fixed fallback is best effort; never log raw exception. */ }
};
