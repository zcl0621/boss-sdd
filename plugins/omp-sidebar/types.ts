import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";

export interface SidebarRow {
  id: string;
  text: string;
  action?: string;
  tone?: ThemeColor;
  running?: boolean;
  detail?: string;
  emphasis?: boolean;
  tail?: boolean;
  prefix?: string;
}

export interface SidebarSection {
  id: string;
  title: string;
  rows: readonly SidebarRow[];
  summary?: string;
}

export interface SidebarUsagePart {
  id: string;
  label: string;
  tokens: number;
  color: "accent" | "error" | "success" | "warning" | "muted" | "dim";
  /** Not consumed: the auto-compact reserve and the free space. */
  reserved?: boolean;
}

export interface SidebarUsage {
  tokens?: number;
  contextWindow?: number;
  compactAt?: number;
  estimated?: boolean;
  /** Per-category estimate, when omp's breakdown helpers are available. */
  parts?: SidebarUsagePart[];
}

export interface SidebarInspection {
  title: string;
  content: string;
  live?: boolean;
}

export interface SidebarSnapshot {
  sections: readonly SidebarSection[];
  usage: SidebarUsage;
}
