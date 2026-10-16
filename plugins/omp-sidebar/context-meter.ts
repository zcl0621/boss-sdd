import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { renderProgressBar } from "@oh-my-pi/pi-tui/components/progress-bar";
import {
  getContextUsageLevel,
  getContextUsageThemeColor,
} from "@oh-my-pi/pi-tui/chrome/context-thresholds";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { SidebarUsage, SidebarUsagePart } from "./types";

export function renderContextMeter(usage: SidebarUsage, width: number, theme: Theme): string[] {
  const tokens =
    usage.tokens !== undefined && Number.isFinite(usage.tokens) && usage.tokens >= 0
      ? usage.tokens
      : undefined;
  const capacity =
    usage.contextWindow !== undefined &&
    Number.isFinite(usage.contextWindow) &&
    usage.contextWindow > 0
      ? usage.contextWindow
      : undefined;
  const percent =
    tokens !== undefined && capacity !== undefined ? (tokens / capacity) * 100 : undefined;
  const tone =
    percent === undefined
      ? "dim"
      : getContextUsageThemeColor(getContextUsageLevel(percent, capacity!));
  const label =
    percent === undefined ? "?" : `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
  const title = theme.fg("text", theme.bold("Context"));
  const suffix = theme.fg(tone, `${usage.estimated && percent !== undefined ? "≈" : ""}${label}`);
  const titleWidth = Math.max(0, width - visibleWidth(suffix) - 1);
  const shortTitle = truncateToWidth(title, titleWidth);
  const lines = [
    truncateToWidth(
      `${shortTitle}${" ".repeat(Math.max(1, width - visibleWidth(shortTitle) - visibleWidth(suffix)))}${suffix}`,
      width,
      "",
    ),
  ];
  const barWidth = Math.max(0, width);
  const fraction = percent === undefined ? undefined : Math.max(0, Math.min(1, percent / 100));
  const filled = fraction === undefined ? 0 : Math.round(fraction * barWidth);
  const marker =
    capacity !== undefined &&
    usage.compactAt !== undefined &&
    Number.isFinite(usage.compactAt) &&
    usage.compactAt > 0 &&
    usage.compactAt <= capacity
      ? Math.min(barWidth - 1, Math.floor((usage.compactAt / capacity) * barWidth))
      : -1;
  if (marker >= filled && fraction !== undefined) {
    lines.push(
      theme.fg(tone, "█".repeat(filled)) +
        theme.fg("dim", "░".repeat(marker - filled)) +
        theme.fg("warning", "┃") +
        theme.fg("dim", "░".repeat(Math.max(0, barWidth - marker - 1))),
    );
  } else {
    lines.push(
      renderProgressBar(fraction, barWidth, {
        style: {
          filled: "█",
          empty: "░",
          indeterminate: "·",
          styleFilled: (value) => theme.fg(tone, value),
          styleEmpty: (value) => theme.fg("dim", value),
        },
      }),
    );
  }
  lines.push(
    theme.fg(
      "muted",
      `${tokens === undefined ? "?" : formatNumber(tokens)} / ${capacity === undefined ? "?" : formatNumber(capacity)} tokens`,
    ),
  );
  if (marker >= 0)
    lines.push(
      theme.fg(
        "muted",
        `${width < 20 ? "Auto" : "Auto-compact"} ${formatNumber(usage.compactAt!)}`,
      ),
    );
  const parts = usage.parts?.filter((part) => part.tokens > 0);
  if (parts?.length && capacity !== undefined && fraction !== undefined) {
    lines[1] = stackedBar(parts, capacity, barWidth, marker, theme);
    lines.push(...partRows(parts, capacity, width, theme));
  }
  return lines.map((line) => truncateToWidth(line, width, ""));
}

/** One cell run per consumed category, in list order; the remainder stays empty. */
function stackedBar(
  parts: readonly SidebarUsagePart[],
  capacity: number,
  width: number,
  marker: number,
  theme: Theme,
): string {
  const cells: string[] = [];
  let consumed = 0;
  let drawn = 0;
  for (const part of parts) {
    if (part.reserved) continue;
    consumed += part.tokens;
    // Cumulative rounding keeps the run total equal to the overall fill.
    const end = Math.min(width, Math.round((consumed / capacity) * width));
    for (; drawn < end; drawn++) cells.push(theme.fg(part.color, "█"));
  }
  for (; drawn < width; drawn++)
    cells.push(drawn === marker ? theme.fg("warning", "┃") : theme.fg("dim", "░"));
  return cells.join("");
}

/** One decimal, unlike formatNumber: 238.7K and 20.7K should not both read as whole thousands. */
function tokensLabel(tokens: number): string {
  const short = (value: number, unit: string): string =>
    `${value.toFixed(1).replace(/\.0$/, "")}${unit}`;
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 999_950) return short(tokens / 1000, "K");
  return short(tokens / 1_000_000, "M");
}

function percentOf(tokens: number, capacity: number): string {
  const percent = (tokens / capacity) * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function partRows(
  parts: readonly SidebarUsagePart[],
  capacity: number,
  width: number,
  theme: Theme,
): string[] {
  return parts.map((part) => {
    const swatch = theme.fg(part.color, part.reserved ? "░" : "■");
    const amount = tokensLabel(part.tokens);
    const percent = percentOf(part.tokens, capacity).padStart(5);
    const values = width < 26 ? percent : `${amount.padStart(6)} ${percent}`;
    const labelWidth = Math.max(0, width - 2 - visibleWidth(values) - 1);
    const label = truncateToWidth(part.label, labelWidth);
    const gap = " ".repeat(Math.max(1, width - 2 - visibleWidth(label) - visibleWidth(values)));
    const tone = part.reserved ? "dim" : "text";
    return `${swatch} ${theme.fg(tone, label)}${gap}${theme.fg("muted", values)}`;
  });
}
