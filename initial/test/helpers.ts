import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, type LoadedConfig } from "../src/config.js";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(overrides: Record<string, unknown> = {}): LoadedConfig {
  const base = {
    owner: { name: "Alan", emails: ["me@example.com"] },
    timezone: "Europe/Zagreb",
    vault: { path: "/tmp/vault", maxSyncFileMB: 1 },
    gmail: { account: "me@example.com" },
    claude: { apiKeySource: "env" },
    signOffs: { en: "Best regards,\nAlan", hr: "Lijep pozdrav,\nAlan", sv: "Med vänlig hälsning,\nAlan" },
    projects: [
      {
        id: "sweden-legal",
        name: "Sweden — legal matter",
        folder: "Projects/Sweden legal matter",
        counsel: { name: "Elin Holm", email: "elin@lawfirm.example", language: "en" },
        contacts: [
          { match: "elin@lawfirm.example", role: "own_lawyer", alwaysUrgent: true },
          { match: "@lawfirm.example", role: "own_lawyer" },
          { match: "@court.example", role: "court", reviewRequired: true },
          { match: "@otherside.example", role: "opposing_counsel", reviewRequired: true },
        ],
      },
      {
        id: "croatia-bank",
        name: "Croatia — bank & advisors",
        folder: "Projects/Croatia bank and advisors",
        contacts: [{ match: "@bank.example", role: "bank" }],
      },
    ],
    ...overrides,
  };
  return parseConfig(base, "/tmp/inbox-triage-test/config.json");
}

export function b64url(text: string | Buffer): string {
  return Buffer.from(text).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
