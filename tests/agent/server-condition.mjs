import { registerHooks } from "node:module";
// Next aliases this marker to its empty implementation in server bundles. Match only that
// alias, only in this isolated test process explicitly launched with react-server condition.
registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(specifier === "server-only" && context.conditions.includes("react-server") ? "next/dist/compiled/server-only/empty.js" : specifier, context);
} });
