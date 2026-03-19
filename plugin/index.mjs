/**
 * OpenClaw Memory Stack — Plugin Entry Point
 *
 * Registers as OpenClaw's memory provider via plugins.slots.memory.
 * Routes queries through the rule-based router to QMD (BM25/vector)
 * and Total Recall (git-based) backends.
 *
 * Zero LLM overhead — routing is pure regex matching.
 */

import { execSync, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const INSTALL_ROOT = resolve(homedir(), ".openclaw/memory-stack");
const ROUTER_SH = resolve(INSTALL_ROOT, "skills/memory-router/router.sh");
const CLI = resolve(INSTALL_ROOT, "bin/openclaw-memory");

function runRouter(query, hint) {
  const args = ["--adapter", query];
  if (hint) args.push("--hint", hint);
  try {
    const result = execSync(`bash "${ROUTER_SH}" ${args.map(a => `"${a}"`).join(" ")}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, OPENCLAW_INSTALL_ROOT: INSTALL_ROOT },
    });
    return JSON.parse(result.trim());
  } catch (err) {
    return { status: "error", results: [], result_count: 0, error_message: err.message };
  }
}

function runCli(subcommand, ...args) {
  try {
    return execSync(`"${CLI}" ${subcommand} ${args.map(a => `"${a}"`).join(" ")}`, {
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, OPENCLAW_INSTALL_ROOT: INSTALL_ROOT },
    }).trim();
  } catch (err) {
    return null;
  }
}

function truncateToTokenBudget(results, maxTokens) {
  // Rough estimate: 1 token ≈ 4 chars
  const charBudget = maxTokens * 4;
  const selected = [];
  let used = 0;
  for (const r of results) {
    const content = r.content || "";
    if (used + content.length > charBudget) break;
    selected.push(r);
    used += content.length;
  }
  return selected;
}

export default {
  id: "openclaw-memory-stack",
  name: "OpenClaw Memory Stack",

  register(api) {
    const config = api.getConfig?.() || {};
    const autoRecall = config.autoRecall !== false;
    const autoCapture = config.autoCapture !== false;
    const maxResults = config.maxRecallResults || 5;
    const maxTokens = config.maxRecallTokens || 1500;
    const searchMode = config.searchMode || "hybrid";

    // Check installation
    if (!existsSync(CLI)) {
      api.log?.("warn", "OpenClaw Memory Stack not installed at " + INSTALL_ROOT);
      return;
    }

    // Register as memory provider (replaces default memory-core)
    api.registerProvider("memory", {
      name: "openclaw-memory-stack",

      /**
       * Recall — retrieve relevant memories for a query.
       * Called by OpenClaw before each agent turn when autoRecall is on.
       */
      async recall(query, options = {}) {
        const hint = options.hint || "";
        const envelope = runRouter(query, hint);

        if (envelope.status === "error") {
          api.log?.("error", "Memory recall failed: " + envelope.error_message);
          return [];
        }

        const results = (envelope.results || [])
          .filter(r => (r.relevance || r.normalized_relevance || 0) > 0.1)
          .slice(0, maxResults);

        return truncateToTokenBudget(results, maxTokens).map(r => ({
          content: r.content,
          source: r.source || envelope.routed_to || "memory-stack",
          relevance: r.relevance || r.normalized_relevance || 0,
          timestamp: r.timestamp || null,
        }));
      },

      /**
       * Store — persist a memory after a conversation turn.
       * Called by OpenClaw after each turn when autoCapture is on.
       */
      async store(content, metadata = {}) {
        if (!autoCapture) return;
        // Use Total Recall to store (git-based, zero dependencies)
        const trWrapper = resolve(INSTALL_ROOT, "skills/memory-totalrecall/wrapper.sh");
        if (!existsSync(trWrapper)) return;

        try {
          execSync(
            `bash "${trWrapper}" store "${content.replace(/"/g, '\\"')}"`,
            {
              encoding: "utf-8",
              timeout: 5000,
              env: {
                ...process.env,
                OPENCLAW_INSTALL_ROOT: INSTALL_ROOT,
                MEMORY_CATEGORY: metadata.category || "conversation",
              },
            }
          );
        } catch {
          // Non-fatal — don't break the agent flow
        }
      },

      /**
       * Search — explicit memory search (when agent actively queries).
       */
      async search(query, options = {}) {
        return this.recall(query, options);
      },

      /**
       * Health check.
       */
      async health() {
        const output = runCli("health");
        if (!output) return { status: "degraded", message: "CLI not responding" };
        return { status: "ready", message: output.split("\n")[0] };
      },
    });

    // Register auto-recall hook
    if (autoRecall) {
      api.on?.("beforeAgentTurn", async (ctx) => {
        const query = ctx.lastUserMessage || ctx.summary || "";
        if (!query || query.length < 5) return;

        const memories = await api.providers?.memory?.recall(query);
        if (memories && memories.length > 0) {
          ctx.injectContext?.({
            role: "memory",
            label: "Relevant memories",
            content: memories.map(m => m.content).join("\n---\n"),
            tokenEstimate: memories.reduce((sum, m) => sum + Math.ceil((m.content || "").length / 4), 0),
          });
        }
      });
    }

    // Register auto-capture hook
    if (autoCapture) {
      api.on?.("afterAgentTurn", async (ctx) => {
        const content = ctx.agentResponse || "";
        if (content.length < 50) return; // Skip trivial responses

        // Extract key facts (no LLM call — just store the turn summary)
        const summary = ctx.turnSummary || content.slice(0, 500);
        await api.providers?.memory?.store(summary, {
          category: "conversation",
          agentId: ctx.agentId,
          timestamp: new Date().toISOString(),
        });
      });
    }

    api.log?.("info", `Memory Stack registered (recall=${autoRecall}, capture=${autoCapture}, mode=${searchMode})`);
  },
};
