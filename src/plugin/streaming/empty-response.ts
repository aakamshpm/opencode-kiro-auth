/**
 * Thrown when Kiro closes a response stream without producing any usable
 * content — no assistant text and no tool calls.
 *
 * Without this, the transformers below would forward a clean `end_turn`
 * stop and opencode would record a phantom empty turn: thinking visible,
 * then silence on thinking models, or nothing at all on non-thinking
 * models. Failing loudly lets the caller surface the error (and retry)
 * instead of presenting an empty answer.
 *
 * Observed cause: Kiro returns HTTP 200 and ends the event stream early,
 * with no text and no tool calls. This is a provider-side fault, not
 * something caused by the request transform.
 *
 * Confirmed against kiro-cli (the official client, independent of this
 * plugin's request construction): it hits the identical failure under the
 * same conditions (long, tool-result-heavy sessions) and names it
 * `REASONING_EXTRACTION`, telling the user to switch models, start a new
 * session, or rewind to an earlier point — notably not just "retry". A
 * same-request retry can still succeed since the failure wasn't
 * deterministic in testing, but it's not reliable the way a transient
 * network blip would be.
 */
export class EmptyResponseError extends Error {
  constructor(model: string, hadReasoning: boolean) {
    super(
      `Kiro returned an empty response (model: ${model}): no text${
        hadReasoning ? ' (reasoning was streamed but no answer followed)' : ', reasoning,'
      } or tool calls. This matches Kiro's own REASONING_EXTRACTION failure` +
        ` (seen in kiro-cli too, so it's not specific to this plugin) — the` +
        ` model got stuck finalizing its response. Retrying the same request` +
        ` sometimes works, but if it keeps happening, switch models, start a` +
        ` new session, or rewind to an earlier point in the conversation.`
    )
    this.name = 'EmptyResponseError'
  }
}

export function throwIfEmptyResponse(args: {
  model: string
  /** Raw assistant text received (before thinking-tag routing). */
  text: string
  toolCalls: unknown[]
  /** Whether any reasoning (native or scraped) was streamed. */
  hadReasoning: boolean
}): void {
  // Tool-call-only turns are legitimate (the model acts without narrating),
  // so only a turn with neither text nor tool calls is a failure.
  if (args.text.length === 0 && args.toolCalls.length === 0) {
    throw new EmptyResponseError(args.model, args.hadReasoning)
  }
}
