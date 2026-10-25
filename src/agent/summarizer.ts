/**
 * The one model call compaction needs.
 *
 * This lives in the agent layer because it constructs a vendor client. The
 * session layer only knows the `SummaryGenerator` port, so it cannot leak an SDK
 * import or a provider-specific option into the summary boundary.
 *
 * The fast model is deliberate: a summary is a compression step, not the reply
 * the person reads, and paying the companion model's price for it would make
 * long conversations more expensive for no visible gain.
 */

import OpenAI from 'openai';
import { DEEPSEEK_BASE_URL, MODEL_IDS, resolveApiKey } from '../config.ts';
import {
  renderSummaryPrompt,
  SUMMARY_SYSTEM_PROMPT,
  type SummaryGenerator,
} from '../session/summary.ts';

export function createSummaryGenerator(
  model: string = MODEL_IDS.fast,
): SummaryGenerator {
  const client = new OpenAI({
    apiKey: resolveApiKey(),
    baseURL: DEEPSEEK_BASE_URL,
    maxRetries: 1,
    timeout: 60_000,
  });

  return async (request) => {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: renderSummaryPrompt(request) },
      ],
      max_tokens: request.maxOutputTokens,
      temperature: 0.2,
    });

    const content = completion.choices[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('summary model returned no text');
    }
    return content.trim();
  };
}
