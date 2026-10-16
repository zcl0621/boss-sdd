import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { isEnoent, sanitizeText } from "@oh-my-pi/pi-utils";
import { targetScope } from "@oh-my-pi/pi-coding-agent/cli/ps-data";
import type {
  DaemonOperation,
  DaemonRpcResult,
  DaemonWireRequest,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { isSharedBrowserDaemonName } from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import { LSP_MUX_DAEMON_NAME } from "@oh-my-pi/pi-coding-agent/lsp/mux/protocol";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import type { SidebarInspection } from "./types";

export interface SidebarService {
  runtimeDir: string;
  snapshot: DaemonSnapshot;
  spec?: DaemonSpec;
  /** Persisted metadata is explicitly distinguished from a live broker response. */
  saved: boolean;
}

export interface SidebarServicesSnapshot {
  services: readonly SidebarService[];
  error?: string;
}

type LaunchPaths = typeof import("@oh-my-pi/pi-coding-agent/launch/paths");
type LaunchProtocol = typeof import("@oh-my-pi/pi-coding-agent/launch/protocol");

let launchModules: Promise<LaunchPaths & LaunchProtocol> | undefined;

/**
 * Release binaries (seen on 18.11.1) do not serve `launch/*` to extensions, so a static import
 * would fail the whole sidebar. Load lazily; a failure only disables the Terminal section.
 */
function loadLaunch(): Promise<LaunchPaths & LaunchProtocol> {
  launchModules ??= Promise.all([
    import("@oh-my-pi/pi-coding-agent/launch/paths"),
    import("@oh-my-pi/pi-coding-agent/launch/protocol"),
  ]).then(
    ([paths, protocol]) => ({ ...paths, ...protocol }),
    (error) => {
      throw new Error(`this omp build does not expose launch modules (${message(error)})`);
    },
  );
  return launchModules;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function belongsToOwner(daemon: DaemonSnapshot, owner: string): boolean {
  return (
    daemon.owner === owner ||
    (daemon.owner === undefined &&
      (isSharedBrowserDaemonName(daemon.name) || daemon.name === LSP_MUX_DAEMON_NAME))
  );
}

/** An existing-only connection: no client, token creation, lease, reconnect or worker-spawn path. */
async function readRequest(
  runtimeDir: string,
  operation: DaemonOperation,
  signal?: AbortSignal,
): Promise<DaemonRpcResult> {
  signal?.throwIfAborted();
  const { daemonBrokerEndpoint, parseDaemonRpcResult, parseDaemonWireResponse } = await loadLaunch();
  const token = (await fs.readFile(path.join(runtimeDir, "broker.token"), "utf8")).trim();
  signal?.throwIfAborted();
  const connection = await IpcConnection.connect(daemonBrokerEndpoint(runtimeDir), {
    framing: "lines",
    timeoutMs: 250,
    maxFrameBytes: 2 * 1024 * 1024,
  });
  try {
    signal?.throwIfAborted();
    return await new Promise<DaemonRpcResult>((resolve, reject) => {
      const id = crypto.randomUUID();
      let settled = false;
      const finish = (result?: DaemonRpcResult, error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else if (result) resolve(result);
      };
      const abort = (): void =>
        finish(undefined, signal?.reason ?? new Error("Service inspection cancelled"));
      const timer = setTimeout(
        () => finish(undefined, new Error("Existing broker did not answer within 1 second")),
        1000,
      );
      connection.start(
        (line) => {
          try {
            const response = parseDaemonWireResponse(JSON.parse(line));
            if (response.id !== id) return;
            if (!response.ok) finish(undefined, new Error(response.error));
            else finish(parseDaemonRpcResult(operation, response.result));
          } catch (error) {
            finish(undefined, error);
          }
        },
        (reason) => finish(undefined, new Error(reason ?? "Existing broker disconnected")),
      );
      // Deliberately omit owners/completion fields: inspection must not claim session ownership.
      const request: DaemonWireRequest = { id, token, operation };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else connection.send(JSON.stringify(request));
    });
  } finally {
    connection.destroy();
  }
}

async function savedServices(runtimeDir: string, owner: string): Promise<SidebarService[]> {
  const result: SidebarService[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(runtimeDir, "daemons"), { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return result;
    throw error;
  }
  if (entries.length === 0) return result;
  const { readStoredDaemonRecord, parseDaemonSnapshot, parseDaemonSpec } = await loadLaunch();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stored = await readStoredDaemonRecord(path.join(runtimeDir, "daemons", entry.name));
      if (!stored) continue;
      const snapshot = parseDaemonSnapshot(stored.meta.daemon);
      if (!belongsToOwner(snapshot, owner) || snapshot.name !== entry.name) continue;
      result.push({ runtimeDir, snapshot, spec: parseDaemonSpec(stored.spec), saved: true });
    } catch {
      // Torn or malformed metadata is not evidence of a process.
    }
  }
  return result;
}

export async function readSidebarServices(
  cwd: string,
  owner: string,
  signal?: AbortSignal,
): Promise<SidebarServicesSnapshot> {
  try {
    const scope = await targetScope({ dir: cwd });
    signal?.throwIfAborted();
    const saved = await savedServices(scope.runtimeDir, owner);
    if (scope.brokerPid === undefined) return { services: saved };
    try {
      const result = await readRequest(scope.runtimeDir, { op: "list" }, signal);
      if (result.op !== "list") throw new Error("Unexpected service list response");
      return {
        services: result.daemons
          .filter((daemon) => belongsToOwner(daemon, owner))
          .map((snapshot) => ({
            runtimeDir: scope.runtimeDir,
            snapshot,
            saved: false,
            spec: saved.find((record) => record.snapshot.id === snapshot.id)?.spec,
          })),
      };
    } catch (error) {
      signal?.throwIfAborted();
      return { services: saved, error: `Live service status unavailable: ${message(error)}` };
    }
  } catch (error) {
    signal?.throwIfAborted();
    return { services: [], error: `Service discovery unavailable: ${message(error)}` };
  }
}

/** Names are not identities. Verify the UUID and owner before AND after reading live logs. */
export async function inspectSidebarService(
  service: SidebarService,
  owner: string,
  signal?: AbortSignal,
): Promise<SidebarInspection> {
  const title = `Terminal · ${service.snapshot.name}`;
  try {
    const before = await readRequest(service.runtimeDir, { op: "list" }, signal);
    if (before.op !== "list") throw new Error("Unexpected service list response");
    const current = before.daemons.find(
      (daemon) => daemon.id === service.snapshot.id && daemon.name === service.snapshot.name,
    );
    if (!current || !belongsToOwner(current, owner))
      throw new Error("Service generation or owner changed; output is unavailable");
    const logs = await readRequest(
      service.runtimeDir,
      {
        op: "logs",
        name: current.name,
        lines: 1000,
        head: false,
        follow: false,
        renderTerminalRows: false,
        timeoutMs: 0,
      },
      signal,
    );
    const after = await readRequest(service.runtimeDir, { op: "list" }, signal);
    if (
      after.op !== "list" ||
      !after.daemons.some(
        (daemon) =>
          daemon.id === current.id && daemon.name === current.name && belongsToOwner(daemon, owner),
      )
    ) {
      throw new Error("Service generation or owner changed while reading; output discarded");
    }
    if (logs.op !== "logs") throw new Error("Unexpected service output response");
    const output = logs.terminalRows?.join("\n") ?? logs.text;
    return {
      title,
      live: true,
      content: sanitizeText(
        `${current.name} · ${logs.state}\nUUID: ${current.id}\nPID: ${current.pid ?? "unavailable"}\nOwner: ${current.owner ?? "project-shared"}\n\n${output || "No output yet."}`,
      ),
    };
  } catch (error) {
    signal?.throwIfAborted();
    // OMP 18.10.4 saves logs by mutable name, not immutable UUID. Do not read those offline.
    return {
      title,
      live: true,
      content: `Output unavailable: ${message(error)}\nOffline name-addressed logs are not safe to associate with this UUID.`,
    };
  }
}
