import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

// The production entry point (src/cluster.ts) run as a real process: with WEB_CONCURRENCY=2 it starts two server processes
// that share the port and both answer, and a worker that dies is replaced by a new one. The workers log JSON lines (pino),
// which carry their process id.

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

type Line = { msg?: string; pid?: number; worker?: number };

function start(port: number): { child: ChildProcess; lines: Line[] } {
  const child = spawn(process.execPath, [tsxCli, "src/cluster.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      WEB_CONCURRENCY: "2",
      SMALL_WORKS_ALERT_JOB_ENABLED: "false",
      LOG_LEVEL: "info",
      // The health check answers (503) even with no database behind it, which is all this test needs.
      DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/none",
      JWT_ACCESS_SECRET: "x".repeat(48),
      CORS_ORIGINS: "http://localhost:5173",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: Line[] = [];
  let buffered = "";
  const read = (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      try {
        lines.push(JSON.parse(part) as Line);
      } catch {
        // not a log line
      }
    }
  };
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  return { child, lines };
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const started = (lines: Line[]) => [
  ...new Set(lines.filter((l) => l.msg === "server started").map((l) => l.pid!)),
];

let running: ChildProcess | undefined;
afterEach(() => {
  if (running && running.exitCode === null) running.kill();
});

describe("the cluster entry point", () => {
  it("runs two server processes on one port, and replaces one that dies", async () => {
    const port = 19_000 + Math.floor(Math.random() * 1_000);
    const { child, lines } = start(port);
    running = child;

    await until(() => started(lines).length === 2, 60_000);
    expect(lines.some((l) => l.msg === "cluster started")).toBe(true);
    const first = started(lines);
    expect(first).not.toContain(child.pid);

    // Both workers serve the port: many requests all get an answer.
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`http://127.0.0.1:${port}/api/v1/health`).then((r) => r.status)),
    );
    expect(answers.every((status) => status === 200 || status === 503)).toBe(true);

    // A worker is killed: the primary starts another, and the port keeps answering.
    process.kill(first[0]!);
    await until(() => lines.some((l) => l.msg === "worker died, starting another"), 30_000);
    await until(() => started(lines).length === 3, 60_000);
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBeOneOf([200, 503]);
  }, 120_000);
});
