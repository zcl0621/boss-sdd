// The CLI surface of evolve (argument parsing, exit codes) and the real process runner, without ever starting omp.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupLive, defaultTargetDir, main, parseArgs, runCommand } from "./evolve";

const made: string[] = [];
const tmp = (n: string) => {
  const d = mkdtempSync(join(tmpdir(), `omp-evolve-cli-${n}-`));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const base = ["--sessions", "/s", "--bank", "/b.json", "--model", "p/m"];

describe("parseArgs", () => {
  test("defaults and both --flag value and --flag=value forms", () => {
    const r: any = parseArgs([...base, "--target=/t", "--rounds", "4", "--samples=2", "--margin", "3", "--dialect=anthropic"]);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ sessions: "/s", bank: "/b.json", model: "p/m", target: "/t", rounds: 4, samples: 2, margin: 3, dialect: "anthropic", dryRun: false });
    const d: any = parseArgs(base);
    expect(d.value).toMatchObject({ rounds: 3, samples: 1, margin: 1, dryRun: false });
    expect(d.value.target).toBeUndefined();
  });

  test("--dry-run is boolean and never consumes the next token", () => {
    const r: any = parseArgs([...base, "--dry-run", "--target=/x"]);
    expect(r.ok).toBe(true);
    expect(r.value.dryRun).toBe(true);
    expect(r.value.target).toBe("/x");
    const s: any = parseArgs([...base, "--dry-run", "/stray"]);
    expect(s.ok).toBe(false); // the token after --dry-run is a stray argument, not its value
    expect(parseArgs([...base, "--dry-run=false"]).ok).toBe(false); // takes no value
  });

  test.each([["--samples", "NaN"], ["--samples", "0"], ["--samples", "-1"], ["--samples", "1.5"], ["--margin", "0"], ["--margin", "abc"], ["--rounds", "0"], ["--rounds", "-2"], ["--rounds", "2.5"]])(
    "%s %s is rejected with a message",
    (flag, value) => {
      const r: any = parseArgs([...base, flag, value]);
      expect(r.ok).toBe(false);
      expect(r.error).toContain(flag.slice(2));
    },
  );

  test("--flag=value validation applies too", () => expect(parseArgs([...base, "--samples=0"]).ok).toBe(false));
  test.each(["--target", "--baseline-file", "--sessions", "--bank", "--model"])("an empty value for %s is rejected (both forms)", (flag) => {
    const without = (flag === "--target" || flag === "--baseline-file") ? base : base.filter((t, i) => t !== flag && base[i - 1] !== flag);
    expect(parseArgs([...without, flag, ""]).ok).toBe(false);
    expect(parseArgs([...without, `${flag}=`]).ok).toBe(false);
  });

  test("a value that starts with - is rejected for a value flag (either form)", () => {
    expect(parseArgs([...base, "--target", "-x"]).ok).toBe(false);
    expect(parseArgs([...base, "--target=-x"]).ok).toBe(false);
    expect(parseArgs(["--sessions", "/s", "--bank", "/b.json", "--model", "-m"]).ok).toBe(false);
  });

  test("a repeated flag is rejected", () => {
    const r: any = parseArgs([...base, "--margin", "1", "--margin=2"]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/margin/);
    expect(parseArgs([...base, "--dry-run", "--dry-run"]).ok).toBe(false);
  });

  test("unknown flags and bad --dialect are rejected", () => {
    expect((parseArgs([...base, "--frobnicate"]) as any).error).toMatch(/frobnicate/);
    expect(parseArgs([...base, "--dialect", "xml"]).ok).toBe(false);
  });
  test("missing required flags are rejected", () => {
    for (const k of ["--sessions", "--bank", "--model"]) {
      const argv = [...base];
      argv.splice(argv.indexOf(k), 2);
      expect((parseArgs(argv) as any).error).toContain(k.slice(2));
    }
  });
});

describe("main", () => {
  const bankFile = () => {
    const f = join(tmp("bank"), "bank.json");
    writeFileSync(f, JSON.stringify({ holdout: [], questions: [{ id: "q", kind: "k", facts: [["a"]] }] }));
    return f;
  };
  const deps = () => {
    const calls: any[] = [];
    const out: string[] = [];
    return {
      calls,
      out,
      evolve: async (o: any) => (calls.push(o), { installed: false, reason: "r", cases: { train: 1, holdout: 1 }, skipped: {}, dropped: [] }),
      log: (l: string) => out.push(l),
      error: (l: string) => out.push(l),
    };
  };

  test("invalid arguments exit 2, print a message and do no work", async () => {
    for (const bad of [["--samples", "0"], ["--rounds", "x"], ["--nope"], ["--margin=-1"]]) {
      const d = deps();
      expect(await main([...base, ...bad], d as any)).toBe(2);
      expect(d.calls).toEqual([]);
      expect(d.out.join("\n").length).toBeGreaterThan(0);
    }
  });

  test("a malformed bank file exits 2 before any work", async () => {
    const f = join(tmp("badbank"), "bank.json");
    writeFileSync(f, JSON.stringify({ questions: [{ id: "q", kind: "k", facts: [[""]] }] }));
    const d = deps();
    expect(await main(["--sessions", "/s", "--bank", f, "--model", "p/m"], d as any)).toBe(2);
    expect(d.calls).toEqual([]);
    expect(d.out.join("\n")).toMatch(/bank/i);
  });

  describe("signals", () => {
    const hooks = () => {
      const handlers: Record<string, () => void> = {};
      const removed: string[] = [];
      return {
        handlers,
        removed,
        onSignal: (sig: string, h: () => void) => {
          handlers[sig] = h;
          return () => removed.push(sig);
        },
      };
    };
    test("SIGINT, SIGTERM and SIGHUP clean up live temp resources, say so on stderr, and exit 130 / 143 / 129", async () => {
      for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
        const h = hooks();
        const exits: number[] = [];
        let cleaned = 0;
        const errs: string[] = [];
        const d = { ...deps(), evolve: () => new Promise<never>(() => {}), onSignal: h.onSignal, exit: (c: number) => exits.push(c), cleanup: () => cleaned++, error: (l: string) => errs.push(l) };
        void main(["--sessions", "/s", "--bank", bankFile(), "--model", "p/m"], d as any);
        await new Promise((r) => setTimeout(r, 20));
        expect(Object.keys(h.handlers).sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
        h.handlers[sig]();
        expect(cleaned).toBe(1);
        expect(exits).toEqual([code]);
        expect(errs).toHaveLength(1);
        expect(errs[0]).toMatch(/interrupted, cleaned up/);
        expect(errs[0]).not.toContain("\n");
      }
    });
    test("the handlers are removed when the run finishes", async () => {
      const h = hooks();
      const d = { ...deps(), onSignal: h.onSignal, exit: () => {}, cleanup: () => {} };
      await main(["--sessions", "/s", "--bank", bankFile(), "--model", "p/m"], d as any);
      expect(h.removed.sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    });
  });

  test("--profile installs into that omp profile's agent dir; it cannot be combined with --target", async () => {
    const d = deps();
    const code = await main(["--sessions", "/s", "--bank", bankFile(), "--model", "p/m", "--profile=work", "--dry-run"], d as any);
    expect(code).toBe(0);
    expect(d.calls[0].targetDir).toBe(defaultTargetDir({ ...process.env, OMP_PROFILE: "work" }));
    expect(d.calls[0].targetDir).toContain(join("profiles", "work", "agent", "extensions", "omp-context"));
    const bad = deps();
    expect(await main(["--sessions", "/s", "--bank", bankFile(), "--model", "p/m", "--profile=../shared"], bad as any)).toBe(2);
    expect(bad.calls).toHaveLength(0);
    const both = deps();
    expect(await main(["--sessions", "/s", "--bank", bankFile(), "--model", "p/m", "--profile=work", "--target=/t"], both as any)).toBe(2);
    expect(both.calls).toHaveLength(0);
  });

  test("valid arguments run evolve once with the parsed options and exit 0", async () => {
    const d = deps();
    const dir = tmp("target");
    const code = await main(["--sessions", "/s", "--bank", bankFile(), "--model", "anthropic/claude-x", `--target=${dir}`, "--dry-run", "--margin", "2"], d as any);
    expect(code).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({ sessionsDir: "/s", model: "anthropic/claude-x", targetDir: dir, dryRun: true, margin: 2, rounds: 3, samples: 1 });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("runCommand (the real process runner)", () => {
  test("captures stdout, stderr and the exit code; honours cwd and a closed stdin", async () => {
    const cwd = tmp("cwd");
    const r = await runCommand("sh", ["-c", "pwd; cat; echo err 1>&2; exit 3"], { stdin: "ignore", cwd });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain(cwd.replace(/^\/private/, ""));
    expect(r.stderr).toBe("err\n");
  });

  test("a run that outlives timeoutMs is killed and reported as timed out", async () => {
    const t0 = Date.now();
    const err = await runCommand("sleep", ["5"], { stdin: "ignore", timeoutMs: 150 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/timed out/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("cleanupLive kills a running child", async () => {
    const t0 = Date.now();
    const p = runCommand("sleep", ["30"], { stdin: "ignore" });
    await new Promise((r) => setTimeout(r, 100));
    cleanupLive();
    const r: any = await p.catch((e: Error) => e);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r instanceof Error || r.code !== 0).toBe(true);
  });

  test("a command that cannot start is an error naming it", async () => {
    const err = await runCommand("definitely-not-a-command-xyz", [], { stdin: "ignore" }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/could not run definitely-not-a-command-xyz/);
  });
});
