/**
 * OpenClaw Memory Stack — v2 Plugin (thin entry)
 *
 * All logic lives in lib/ modules. This file only does:
 * 1. Import modules
 * 2. Register tool (memory_search with command dispatch)
 * 3. Register hooks (before_agent_start, agent_end)
 * 4. Background update check
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

import { HOME, MEMORY_DB, DEFAULT_CONFIG, findQmdBin } from "./lib/constants.mjs";
import { formatL0, formatL1, formatL2, parseFullSuffix } from "./lib/tiered.mjs";
import { combinedSearch } from "./lib/pipeline.mjs";
import { extractFacts, extractKeyFacts, saveRescueFacts, cleanupOldRescueFiles } from "./lib/rescue.mjs";
import { analyzeMemoryHealth, consolidateMemories, organizeMemories } from "./lib/quality.mjs";
import { loadGraph, saveGraph, extractEntities, mergeIntoGraph } from "./lib/graph/store.mjs";
import {
  multiHopQuery, getEvolutionTimeline, extractEvolutionEdges,
  detectCommunities, rankByPageRank, invalidateGraphCache,
} from "./lib/graph/algorithms.mjs";
import { configureLLM } from "./lib/llm.mjs";

// ─── Background update check ─────────────────────────────────────

function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, filePath);
}

/**
 * Fire-and-forget, never blocks startup. Checks at most once every 24 hours.
 * Silent on any error.
 */
function checkForUpdates(api) {
  (async () => {
    try {
      const stateDir = resolve(HOME, ".openclaw/memory-stack");
      const statePath = resolve(stateDir, "update-state.json");

      // Throttle: 24hr
      let state = {};
      try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
      if (Date.now() - (state.last_check || 0) < 86_400_000) return;

      // Read local version + license
      const versionFile = resolve(stateDir, "version.json");
      const licenseFile = resolve(HOME, ".openclaw/state/license.json");
      if (!existsSync(versionFile) || !existsSync(licenseFile)) return;

      const version = JSON.parse(readFileSync(versionFile, "utf8"));
      const license = JSON.parse(readFileSync(licenseFile, "utf8"));

      // Check update (5s timeout)
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `https://openclaw-license.busihoward.workers.dev/api/check-update?key=${encodeURIComponent(license.key)}&current=${encodeURIComponent(version.version)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (!res.ok) {
        atomicWrite(statePath, { last_check: Date.now(), latest: null });
        return;
      }

      const data = await res.json();

      if (data.update_available) {
        // Auto-update: run install.sh --upgrade in background
        const installSh = resolve(stateDir, "install.sh");
        if (existsSync(installSh)) {
          execFile("bash", [installSh, "--upgrade"], {
            detached: true,
            stdio: "ignore",
          }, (err) => {
            const result = {
              last_check: Date.now(),
              latest: data.latest,
              auto_updated: !err,
              updated_at: new Date().toISOString(),
              error: err ? err.message : null,
            };
            atomicWrite(statePath, result);
          }).unref();
        } else {
          atomicWrite(statePath, { last_check: Date.now(), latest: data.latest });
        }
      } else {
        atomicWrite(statePath, { last_check: Date.now(), latest: data.latest || null });
      }
    } catch {
      // Silent — never block normal startup
    }
  })();
}

// ─── Command dispatch helpers ─────────────────────────────────────

function formatHealthReport(health) {
  let report = `Memory Health Score: ${health.score}/100\nTotal entries: ${health.total}\n\n`;
  if (health.duplicates.length > 0) {
    report += `Duplicates (${health.duplicates.length}):\n`;
    health.duplicates.forEach(d => { report += `  - Line ${d.line2}: "${d.text.slice(0, 60)}"\n`; });
    report += "\n";
  }
  if (health.stale.length > 0) {
    report += `Stale entries (${health.stale.length}):\n`;
    health.stale.forEach(s => { report += `  - Line ${s.line}: "${s.text.slice(0, 60)}" (${s.reason})\n`; });
    report += "\n";
  }
  if (health.noise.length > 0) {
    report += `Noise (${health.noise.length}):\n`;
    health.noise.forEach(n => { report += `  - Line ${n.line}: "${n.text}" (${n.reason})\n`; });
    report += "\n";
  }
  report += health.score === 100 ? "All clear — memory is clean." : "Consider cleaning up the issues above.";
  return report;
}

function formatGraphSummary(graph) {
  const entityNames = Object.keys(graph.entities);
  const edgeCount = graph.edges.length;
  let report = `Knowledge Graph Summary\nEntities: ${entityNames.length}\nEdges: ${edgeCount}\n`;
  if (entityNames.length > 0) {
    const sorted = entityNames
      .map(n => ({ name: n, ...graph.entities[n] }))
      .sort((a, b) => (b.mentions || 1) - (a.mentions || 1))
      .slice(0, 15);
    report += `\nTop entities:\n`;
    sorted.forEach((e, i) => {
      report += `  ${i + 1}. ${e.name} (${e.type || "unknown"}, ${e.mentions || 1} mentions)\n`;
    });
  } else {
    report += "\nNo entities tracked yet. Entities are extracted automatically from conversations.";
  }
  return report;
}

function formatConsolidateReport(result) {
  let report = `Memory Consolidation Report\nTotal memories: ${result.totalMemories}\nClusters found: ${result.consolidatable.count}\n\n`;
  if (result.consolidatable.count > 0) {
    report += `Similar memory clusters (showing first 3):\n`;
    result.consolidatable.entries.forEach((cluster, i) => {
      report += `\nCluster ${i + 1}:\n`;
      cluster.forEach(entry => { report += `  - "${entry.slice(0, 80)}"\n`; });
    });
    report += "\n";
  }
  report += result.consolidatable.suggestion;
  return report;
}

const GRAPH_DISABLED_MSG = "Graph features are disabled.";

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

// ─── Plugin registration ─────────────────────────────────────────

export default {
  id: "openclaw-memory-stack",
  name: "OpenClaw Memory Stack",
  description: "Local semantic search + memory quality management + compaction rescue. Works out of the box — no API keys or external LLM needed.",
  kind: "memory",

  register(api) {
    const cfg = { ...DEFAULT_CONFIG, ...(api.pluginConfig || {}) };
    const autoRecall = cfg.autoRecall !== false;
    const hasQMD = !!findQmdBin();
    const hasDB = existsSync(MEMORY_DB);

    // Wire user's LLM config into provider chain
    configureLLM(cfg);

    api.logger.info(`Memory Stack v2 initializing (qmd=${hasQMD}, db=${hasDB}, recall=${autoRecall})`);

    // Cleanup old rescue files (> 30 days)
    cleanupOldRescueFiles(30);

    // Background update check (fire-and-forget)
    checkForUpdates(api);

    // Post-update notification
    try {
      const updateState = resolve(HOME, ".openclaw/memory-stack/update-state.json");
      if (existsSync(updateState)) {
        const us = JSON.parse(readFileSync(updateState, "utf8"));
        if (us.auto_updated === true) {
          api.logger.info(`\u{2705} Memory Stack auto-updated to v${us.latest}`);
          us.auto_updated = false;
          atomicWrite(updateState, us);
        }
      }
    } catch {}

    // ─── Tool: memory_search with command dispatch ──────────

    api.registerTool(
      () => {
        const memorySearchTool = {
          name: "memory_search",
          label: "Memory Search",
          description:
            "Search memories using local BM25 + semantic search. " +
            "Commands: health, graph, graph:Entity depth:N, evolution:Entity, " +
            "expertise, consolidate, organize [--apply]. " +
            "No API keys needed.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "What to search for" },
            },
            required: ["query"],
          },
          async execute(_toolCallId, params) {
            const q = (params.query || "").trim();

            // health
            if (/^health\b/i.test(q)) {
              return textResult(formatHealthReport(analyzeMemoryHealth()));
            }

            // graph (exact)
            if (/^graph$/i.test(q)) {
              if (cfg.graphEnabled === false) return textResult(GRAPH_DISABLED_MSG);
              return textResult(formatGraphSummary(loadGraph()));
            }

            // graph:Entity depth:N
            const graphMatch = q.match(/^graph:(\S+)(?:\s+depth:(\d+))?/i);
            if (graphMatch) {
              if (cfg.graphEnabled === false) return textResult(GRAPH_DISABLED_MSG);
              const entity = graphMatch[1];
              const depth = parseInt(graphMatch[2] || "2", 10);
              const graph = loadGraph();
              const result = multiHopQuery(graph, entity, depth, cfg.graphMaxNodes || DEFAULT_CONFIG.graphMaxNodes);
              return textResult(JSON.stringify(result, null, 2));
            }

            // evolution:Entity
            const evoMatch = q.match(/^evolution:(\S+)/i);
            if (evoMatch) {
              if (cfg.graphEnabled === false) return textResult(GRAPH_DISABLED_MSG);
              const graph = loadGraph();
              const timeline = getEvolutionTimeline(graph, evoMatch[1]);
              return textResult(JSON.stringify(timeline, null, 2));
            }

            // expertise
            if (/^expertise$/i.test(q)) {
              if (cfg.graphEnabled === false) return textResult(GRAPH_DISABLED_MSG);
              const graph = loadGraph();
              const communities = detectCommunities(graph);
              const pageRank = rankByPageRank(graph);
              return textResult(JSON.stringify({ communities, pageRank }, null, 2));
            }

            // consolidate
            if (/^consolidate\b/i.test(q)) {
              return textResult(formatConsolidateReport(consolidateMemories()));
            }

            // organize --apply
            if (/^organize\s+--apply\b/i.test(q)) {
              const result = organizeMemories({ apply: true });
              return textResult(JSON.stringify(result, null, 2));
            }

            // organize (dry-run)
            if (/^organize\b/i.test(q)) {
              const result = organizeMemories({ apply: false });
              return textResult(JSON.stringify(result, null, 2));
            }

            // default: combined search
            // Parse --full suffix for tier override
            const { query: searchQuery, tier } = parseFullSuffix(q, cfg.toolResponseTier || DEFAULT_CONFIG.toolResponseTier);
            const response = await combinedSearch(searchQuery, cfg);
            const results = response.results || [];
            if (results.length === 0) {
              return textResult("No relevant memories found.");
            }
            const enginesUsed = [...new Set(results.map(r => r.engine))];
            const formatter = tier === "L0" ? formatL0 : tier === "L2" ? formatL2 : formatL1;
            const text = formatter(results);
            return textResult(text + `\n\n(engines: ${enginesUsed.join(", ")})`);
          },
        };

        return [memorySearchTool];
      },
      { names: ["memory_search"] },
    );

    // ─── Auto-recall hook ─────────────────────────────────────

    if (autoRecall) {
      api.on("before_agent_start", async (event) => {
        let query = event.lastUserMessage || event.summary || "";
        if (!query && Array.isArray(event.messages)) {
          for (let i = event.messages.length - 1; i >= 0; i--) {
            const msg = event.messages[i];
            if (msg.role === "user") {
              query = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text || "");
              break;
            }
          }
        }
        if (!query || query.length < 5) return {};

        const response = await combinedSearch(query, cfg);
        const results = response.results || [];
        if (results.length === 0) return {};

        const recallTier = cfg.autoRecallTier || DEFAULT_CONFIG.autoRecallTier;
        const formatter = recallTier === "L1" ? formatL1 : recallTier === "L2" ? formatL2 : formatL0;
        const memoryText = formatter(results);
        return {
          prependContext: `<memory-stack>\n${memoryText}\n</memory-stack>`,
        };
      });
    }

    // ─── Capture hook ─────────────────────────────────────────

    api.on("agent_end", async (event) => {
      let content = "";
      if (Array.isArray(event.messages)) {
        for (const msg of event.messages) {
          if (msg.role === "assistant" && typeof msg.content === "string") {
            content += msg.content + "\n";
          } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && part.text) content += part.text + "\n";
            }
          }
        }
      }
      if (!content) content = event.turnSummary || event.agentResponse || "";
      if (content.length < 20) return;

      // Extract and save rescue facts (LLM if API key configured, regex fallback)
      const facts = await extractFacts(content);
      if (facts.length > 0) {
        saveRescueFacts(facts, event.sessionKey);
      }

      // Extract entities and merge into knowledge graph
      if (cfg.graphEnabled !== false) {
        const extracted = extractEntities(content);
        const evoEdges = extractEvolutionEdges(content);
        if (extracted.entities.size > 0 || extracted.edges.length > 0 || evoEdges.length > 0) {
          const graph = loadGraph();
          mergeIntoGraph(graph, extracted);
          // Merge evolution edges
          for (const edge of evoEdges) {
            const key = `${edge.from}|||${edge.to}`;
            if (!graph.edges.some(e => `${e.from}|||${e.to}` === key)) {
              graph.edges.push(edge);
            }
          }
          invalidateGraphCache();
          saveGraph(graph);
        }
      }
    });

    api.logger.info(
      `Memory Stack v2 registered (engines: fts5${hasQMD ? "+qmd" : ""}+memorymd+rescue+lossless+graph, ` +
      `health=on, rescue=on, graph=${cfg.graphEnabled !== false ? "on" : "off"})`
    );
  },
};
