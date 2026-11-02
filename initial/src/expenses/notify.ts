import { execFile } from "node:child_process";
import type { ExpensesConfig } from "./config.js";

export interface Notice {
  title: string;
  message: string;
}

export type Notifier = (n: Notice) => Promise<string[]>;

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
}

/**
 * Tells you a run ended: a Notification Center message on the Mac mini and, if set, a push through
 * your ntfy topic. Only counts and the month go out, never amounts or vendor names. Returns the
 * channels that worked; a failure is logged, never fatal.
 */
export function systemNotifier(cfg: ExpensesConfig["notify"], logger: (m: string) => void = () => undefined): Notifier {
  return async (n) => {
    const done: string[] = [];
    if (cfg.macos && process.platform === "darwin") {
      const ok = await new Promise<boolean>((resolve) =>
        execFile("osascript", ["-e", `display notification ${appleScriptString(n.message)} with title ${appleScriptString(n.title)}`], { timeout: 10_000 }, (err) => resolve(!err)),
      );
      if (ok) done.push("macOS");
      else logger("macOS notification failed");
    }
    if (cfg.ntfyUrl) {
      try {
        const res = await fetch(cfg.ntfyUrl, { method: "POST", body: n.message, headers: { Title: n.title.replace(/[^\x20-\x7e]/g, "") } });
        if (res.ok) done.push("ntfy");
        else logger(`ntfy answered ${res.status}`);
      } catch (err) {
        logger(`ntfy failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return done;
  };
}
