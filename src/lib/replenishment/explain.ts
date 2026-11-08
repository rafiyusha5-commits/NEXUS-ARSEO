import { actualCostMicros, type AgentConfig } from "../agent/config.ts";
import { maskOutgoing } from "../agent/masking.ts";
import { ProviderError, type AgentLedger, type AgentModelProvider } from "../agent/types.ts";
import type { Calculation } from "./calculate.ts";
/** Numeric facts remain in the deterministic table. The model supplies optional prose only. */
export async function explainCalculation(result: Calculation, userId: string, config: Extract<AgentConfig, { enabled: true }>, provider: AgentModelProvider, ledger: AgentLedger): Promise<string> {
  const data = result.lines.map((l, index) => ({ position: index + 1, city: l.city, demand: l.demand, safety: l.safety, usable: l.usable, inbound: l.inbound, purchase: l.purchase, transfer: l.proposedTransfer, blocked: l.blockers.length > 0 }));
  // No names, client details, document text, raw reasons, prompts or prices are sent.
  const payload = maskOutgoing(JSON.stringify({ lines: data, riskCount: result.risks.length, warnings: result.warnings.length }));
  const inputLimit = Math.min(config.limits.maxInputTokensTotal, 6000);
  const outputLimit = Math.min(config.limits.maxOutputTokensPerCall, config.limits.maxOutputTokensTotal, 800);
  if (payload.length > inputLimit - 1000) throw new Error("EXPLANATION_TOO_LARGE");
  const reservedCost = actualCostMicros({ inputTokens: inputLimit, outputTokens: outputLimit }, config.pricing);
  const reservation = await ledger.reserve({ userId, channel: "web", questionExcerpt: "Пояснение автозаказа Казахстан", reserveUsdMicros: reservedCost });
  let usage = { inputTokens: inputLimit, outputTokens: outputLimit }, ok = false;
  try {
    const answer = await provider.complete({
      messages: [
        { role: "system", content: "Объясни на русском причину рекомендации автозаказа по приведённым расчётам. Не пересчитывай, не утверждай заказ. Не выводи числа, проценты, суммы, артикулы или новые факты. Укажи влияние спроса, запаса, прихода, ОСГ и неподтверждённых перемещений, только если это следует из данных. Астана и Алматы рассматриваются отдельно. Возвращай короткое пояснение простым текстом." },
        { role: "user", content: payload },
      ], tools: [], answerSchema: { type: "object", additionalProperties: false, required: ["explanation"], properties: { explanation: { type: "string" } } }, maxOutputTokens: outputLimit,
      signal: AbortSignal.timeout(Math.min(config.limits.providerTimeoutMs, 30000)),
    });
    usage = { inputTokens: answer.usageMissing?.input ? inputLimit : answer.usage.inputTokens, outputTokens: answer.usageMissing?.output ? outputLimit : answer.usage.outputTokens };
    const parsed: unknown = JSON.parse(answer.content ?? "null");
    const prose = parsed && typeof parsed === "object" && "explanation" in parsed ? parsed.explanation : null;
    if (answer.toolCalls.length || typeof prose !== "string" || !prose.trim() || prose.length > 2500 || /[\d<>]/u.test(prose)) throw new Error("EXPLANATION_INVALID");
    ok = true; return maskOutgoing(prose);
  } catch (error) {
    if (error instanceof ProviderError) usage = { inputTokens: error.usageMissing.input ? inputLimit : error.usage.inputTokens, outputTokens: error.usageMissing.output ? outputLimit : error.usage.outputTokens };
    throw new Error("EXPLANATION_UNAVAILABLE");
  } finally {
    await ledger.finish(reservation, { status: ok ? "completed" : "failed", errorCode: ok ? null : "EXPLANATION_UNAVAILABLE", refund: false, provider: provider.name, model: provider.model, steps: 1, toolCalls: 0, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, actualUsdMicros: actualCostMicros(usage, config.pricing), tools: [] });
  }
}
