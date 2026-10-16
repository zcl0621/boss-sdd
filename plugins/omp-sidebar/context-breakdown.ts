import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { SidebarUsagePart } from "./types";

type ContextUsageModule = typeof import("@oh-my-pi/pi-tui/status-line/context-usage");
type ThresholdModule = typeof import("@oh-my-pi/pi-coding-agent/session/model-compaction-threshold");

interface Helpers {
  usage: ContextUsageModule;
  threshold: ThresholdModule;
}

let helpers: Helpers | null | undefined;
let loading: Promise<void> | undefined;

/**
 * The breakdown helpers are internal omp modules. Load them once in the background; until
 * they arrive (or if this omp build does not serve them) the sidebar keeps the plain meter.
 */
function loadHelpers(): Helpers | undefined {
  if (helpers !== undefined) return helpers ?? undefined;
  loading ??= Promise.all([
    import("@oh-my-pi/pi-tui/status-line/context-usage"),
    import("@oh-my-pi/pi-coding-agent/session/model-compaction-threshold"),
  ]).then(
    ([usage, threshold]) => {
      helpers = { usage, threshold };
    },
    () => {
      helpers = null;
    },
  );
  return undefined;
}

type Tool = { mcpServerName?: unknown; name?: unknown };

/** Split rosters are new arrays; cache them by the live roster so token counts are reused. */
const splitCache = new WeakMap<readonly Tool[], { mcp: Tool[]; builtin: Tool[] }>();

function splitTools(tools: readonly Tool[]): { mcp: Tool[]; builtin: Tool[] } {
  let split = splitCache.get(tools);
  if (!split) {
    split = { mcp: [], builtin: [] };
    for (const tool of tools)
      (typeof tool.mcpServerName === "string" && tool.mcpServerName ? split.mcp : split.builtin).push(
        tool,
      );
    splitCache.set(tools, split);
  }
  return split;
}

export interface ContextParts {
  parts: SidebarUsagePart[];
  usedTokens: number;
  contextWindow: number;
}

/**
 * Per-category context usage, the same estimate omp's `/context` shows, with tool schemas
 * split into MCP and built-in. Returns undefined when the estimate is not available.
 */
export function computeContextParts(session: AgentSession | undefined): ContextParts | undefined {
  if (!session?.model) return undefined;
  const loaded = loadHelpers();
  if (!loaded) return undefined;
  try {
    const breakdown = loaded.usage.computeContextBreakdown(session as never, {
      compaction: loaded.threshold.resolveModelCompactionSettings(session.settings, session.model),
      sourceRevision: session.settings.revision,
    });
    if (!(breakdown.contextWindow > 0)) return undefined;
    const tokens = (id: string): number =>
      breakdown.categories.find((category) => category.id === id)?.tokens ?? 0;
    const toolsTokens = tokens("systemTools");
    let mcpTokens = 0;
    const tools = (session.agent?.state?.tools ?? []) as readonly Tool[];
    const { mcp } = splitTools(tools);
    if (toolsTokens > 0 && mcp.length > 0) {
      const estimate = loaded.usage.estimateContextToolSchemaTokens(
        mcp as never,
        session.agent.tokenizer,
        session.model,
        session.settings.revision,
      );
      mcpTokens = Math.min(toolsTokens, estimate);
    }
    const parts: SidebarUsagePart[] = [
      { id: "messages", label: "Messages", tokens: tokens("messages"), color: "accent" },
      { id: "mcpTools", label: "MCP tools", tokens: mcpTokens, color: "error" },
      { id: "systemTools", label: "System tools", tokens: toolsTokens - mcpTokens, color: "success" },
      { id: "systemPrompt", label: "System prompt", tokens: tokens("systemPrompt"), color: "warning" },
      { id: "systemContext", label: "System context", tokens: tokens("systemContext"), color: "muted" },
      { id: "skills", label: "Skills", tokens: tokens("skills"), color: "muted" },
      {
        id: "buffer",
        label: "Autocompact buffer",
        tokens: breakdown.autoCompactBufferTokens,
        color: "dim",
        reserved: true,
      },
      { id: "free", label: "Free space", tokens: breakdown.freeTokens, color: "dim", reserved: true },
    ];
    return { parts, usedTokens: breakdown.usedTokens, contextWindow: breakdown.contextWindow };
  } catch {
    return undefined;
  }
}
