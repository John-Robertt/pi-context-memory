import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface FooterTheme {
  fg(color: "dim", text: string): string;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface EnhancedFooterSnapshot {
  cwd: string;
  gitBranch: string | null;
  provider: string | null;
  model: string | null;
  usage: UsageTotals;
  context: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  statuses: readonly string[];
}

type FooterObservation = (snapshot: EnhancedFooterSnapshot) => void;

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(totals: UsageTotals, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const value = usage as Record<string, unknown>;
  totals.input += finite(value.input);
  totals.output += finite(value.output);
  totals.cacheRead += finite(value.cacheRead);
  totals.cacheWrite += finite(value.cacheWrite);
  const cost = value.cost;
  if (cost && typeof cost === "object") totals.cost += finite((cost as Record<string, unknown>).total);
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/gu, " ").replace(/ +/gu, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1_000) return Math.round(count).toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function collectEnhancedFooterSnapshot(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
): EnhancedFooterSnapshot {
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") addUsage(usage, entry.message.usage);
    else if (entry.type === "message" && entry.message.role === "toolResult") addUsage(usage, entry.message.usage);
    else if (entry.type === "compaction" || entry.type === "branch_summary") addUsage(usage, entry.usage);
  }
  const context = ctx.getContextUsage();
  return {
    cwd: ctx.cwd,
    gitBranch: footerData.getGitBranch(),
    provider: ctx.model?.provider ?? null,
    model: ctx.model?.id ?? null,
    usage,
    context: context
      ? { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent }
      : null,
    statuses: [...footerData.getExtensionStatuses().entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, text]) => sanitizeStatus(text))
      .filter(Boolean),
  };
}

export function renderEnhancedFooter(
  snapshot: EnhancedFooterSnapshot,
  theme: FooterTheme,
  width: number,
): string[] {
  const location = snapshot.gitBranch ? `${snapshot.cwd} (${snapshot.gitBranch})` : snapshot.cwd;
  const stats = [
    snapshot.usage.input > 0 ? `↑${formatTokens(snapshot.usage.input)}` : undefined,
    snapshot.usage.output > 0 ? `↓${formatTokens(snapshot.usage.output)}` : undefined,
    snapshot.usage.cacheRead > 0 ? `R${formatTokens(snapshot.usage.cacheRead)}` : undefined,
    snapshot.usage.cacheWrite > 0 ? `W${formatTokens(snapshot.usage.cacheWrite)}` : undefined,
    snapshot.usage.cost > 0 ? `$${snapshot.usage.cost.toFixed(3)}` : undefined,
    snapshot.context
      ? `${snapshot.context.percent === null ? "?" : `${snapshot.context.percent.toFixed(1)}%`}/${formatTokens(snapshot.context.contextWindow)} (增强)`
      : "? (增强)",
  ].filter((value): value is string => Boolean(value)).join(" ");
  const model = snapshot.model
    ? `${snapshot.provider ? `(${snapshot.provider}) ` : ""}${snapshot.model}`
    : "no-model";
  const statsWidth = visibleWidth(stats);
  const modelWidth = visibleWidth(model);
  const line = statsWidth + 2 + modelWidth <= width
    ? `${stats}${" ".repeat(width - statsWidth - modelWidth)}${model}`
    : truncateToWidth(`${stats}  ${model}`, width, "...");
  return [
    truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
    theme.fg("dim", line),
    ...snapshot.statuses.map((status) => truncateToWidth(status, width, theme.fg("dim", "..."))),
  ];
}

export function installEnhancedFooter(
  ctx: ExtensionContext,
  observe: FooterObservation,
): boolean {
  if (ctx.mode !== "tui") return false;
  ctx.ui.setFooter((tui, theme, footerData) => {
    let lastSnapshot = "";
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      render(width: number): string[] {
        const snapshot = collectEnhancedFooterSnapshot(ctx, footerData);
        const serialized = JSON.stringify(snapshot);
        if (serialized !== lastSnapshot) {
          lastSnapshot = serialized;
          observe(snapshot);
        }
        return renderEnhancedFooter(snapshot, theme, width);
      },
      invalidate(): void {
        lastSnapshot = "";
      },
      dispose: unsubscribe,
    };
  });
  return true;
}
