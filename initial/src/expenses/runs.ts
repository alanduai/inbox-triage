import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writePrivateFile } from "../util/files.js";
import type { ExpenseRun } from "./types.js";

const ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export function newRunId(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${randomBytes(2).toString("hex")}`;
}

/** One JSON file per run in data/expenses/runs, readable only by you. Few runs a year, so no database. */
export class RunStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(id: string): string {
    if (!ID.test(id)) throw new Error(`Not a run id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  save(run: ExpenseRun): void {
    writePrivateFile(this.file(run.id), JSON.stringify(run, null, 2));
  }

  get(id: string): ExpenseRun | null {
    if (!ID.test(id)) return null;
    const f = this.file(id);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8")) as ExpenseRun;
  }

  /** Newest first. */
  list(limit = 50): ExpenseRun[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && ID.test(f.slice(0, -5)))
      .sort()
      .reverse()
      .slice(0, limit)
      .flatMap((f) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as ExpenseRun];
        } catch {
          return [];
        }
      });
  }

  /** The latest earlier run that answered the same email of Ivana's, to reuse its draft and folder. */
  previousFor(requestMessageId: string, beforeId: string): ExpenseRun | null {
    return this.list(200).find((r) => r.id !== beforeId && r.id < beforeId && r.request?.messageId === requestMessageId) ?? null;
  }

  /** A run left "running" by a service that stopped is marked failed when the service starts again. */
  failInterrupted(now: Date): number {
    let n = 0;
    for (const r of this.list(200)) {
      if (r.status !== "running") continue;
      r.status = "failed";
      r.finishedAt = now.toISOString();
      r.error = "The service stopped while this run was in progress. Run it again.";
      r.steps.push({ at: now.toISOString(), level: "error", text: r.error });
      this.save(r);
      n++;
    }
    return n;
  }
}
