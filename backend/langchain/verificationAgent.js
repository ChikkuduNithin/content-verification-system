/**
 * langchain/verificationAgent.js
 * ──────────────────────────────
 * One coordinator agent, scoped to a single job: gather evidence for one
 * claim. Policy: search → judge quality → escalate to trusted sources if
 * weak → stop.
 *
 * The agent does NOT decide the verdict — that's claimVerificationChain's
 * job, kept deterministic on purpose. This file only ever returns an
 * evidence array in the same {title, snippet, url} shape the old
 * scrapingService returned, so nothing downstream has to know whether
 * the agent or the fallback produced it.
 *
 * If the agent errors, times out, or (in mock mode) there's no real LLM
 * to reason with tool selection at all, gatherEvidenceForClaim() falls
 * back to fetchEvidenceForClaim() directly — the original deterministic
 * search→escalate→give-up chain from scrapingService.js. Same policy,
 * no LLM required.
 */

import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { getChatModel, isMockMode } from './modelProvider.js';
import { evidenceTools } from './tools.js';
import { fetchEvidenceForClaim } from '../services/scrapingService.js';

const MAX_TOOL_CALLS_PER_CLAIM = 3;

const SYSTEM_PROMPT = `You gather evidence for ONE factual claim so it can be fact-checked later.

Policy:
1. Call search_web first.
2. Only if those results are thin, off-topic, or contradictory, call retrieve_trusted_evidence to escalate to more authoritative sources.
3. You have at most ${MAX_TOOL_CALLS_PER_CLAIM} tool calls total. Stop as soon as you have 2-3 relevant evidence items — do not keep searching once you have enough.
4. Do not fabricate evidence. Do not judge the claim yourself; your only job is to collect evidence.`;

let agent = null;
async function getAgent() {
  if (!agent) {
    const model = await getChatModel({ temperature: 0 });
    agent = createReactAgent({
      llm: model,
      tools: evidenceTools,
      messageModifier: SYSTEM_PROMPT,
    });
  }
  return agent;
}

function extractEvidenceFromMessages(messages) {
  const evidence = [];
  const seenUrls = new Set();

  for (const message of messages) {
    if (!(message instanceof ToolMessage)) continue;
    let parsed;
    try {
      parsed = JSON.parse(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    for (const item of parsed) {
      if (!item || !item.title || !item.snippet) continue;
      const dedupeKey = item.url || `${item.title}::${item.snippet}`;
      if (seenUrls.has(dedupeKey)) continue;
      seenUrls.add(dedupeKey);
      evidence.push({ title: item.title, snippet: item.snippet, url: item.url || '' });
    }
  }

  return evidence.slice(0, 5);
}

const AGENT_TIMEOUT_MS = 30_000;

/**
 * gatherEvidenceForClaim
 * @param {string} claim
 * @returns {Promise<{evidence: Array<{title: string, snippet: string, url: string}>, agentic: boolean}>}
 *   `agentic: true` means the LangGraph agent actually ran the search;
 *   `agentic: false` means the deterministic fallback handled it
 *   (mock mode, or a real agent run that errored or came back empty).
 */
export async function gatherEvidenceForClaim(claim) {
  if (isMockMode()) {
    const evidence = await fetchEvidenceForClaim(claim);
    return { evidence, agentic: false };
  }

  try {
    const activeAgent = await getAgent();
    const agentPromise = activeAgent.invoke({
      messages: [new HumanMessage(`Claim to gather evidence for: "${claim}"`)],
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Agent timed out after ${AGENT_TIMEOUT_MS}ms`)), AGENT_TIMEOUT_MS)
    );
    const result = await Promise.race([agentPromise, timeoutPromise]);
    const evidence = extractEvidenceFromMessages(result.messages || []);
    if (evidence.length > 0) return { evidence, agentic: true };
    console.warn('  [verificationAgent] Agent returned no usable evidence, falling back');
  } catch (err) {
    console.warn(`  [verificationAgent] Agent run failed (${err.message}), falling back`);
  }

  const evidence = await fetchEvidenceForClaim(claim);
  return { evidence, agentic: false };
}