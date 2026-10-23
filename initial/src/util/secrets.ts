import { execFileSync } from "node:child_process";
import type { LoadedConfig } from "../config.js";

/** The Anthropic API key, from the macOS Keychain or ANTHROPIC_API_KEY. */
export function anthropicApiKey(cfg: LoadedConfig): string {
  if (cfg.claude.apiKeySource === "env") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set (claude.apiKeySource is \"env\")");
    return key;
  }
  try {
    return execFileSync("security", ["find-generic-password", "-s", cfg.claude.keychainService, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      `No Anthropic API key in the Keychain under "${cfg.claude.keychainService}". Add it with:\n` +
        `  security add-generic-password -a "$USER" -s ${cfg.claude.keychainService} -w`,
    );
  }
}
