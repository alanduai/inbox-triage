import fs from "node:fs";
import http from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";
import { dataPath, type LoadedConfig } from "../config.js";
import { writePrivateFile } from "../util/files.js";

// Phase 1 only reads. Phase 2 adds gmail.modify (mark read, archive) and gmail.send.
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

interface ClientSecrets {
  client_id: string;
  client_secret: string;
}

function readClientSecrets(cfg: LoadedConfig): ClientSecrets {
  const file = dataPath(cfg, cfg.gmail.oauthClientFile);
  if (!fs.existsSync(file)) {
    throw new Error(`Google OAuth client file not found at ${file}. Download it from Google Cloud Console (APIs & Services → Credentials → OAuth client ID, type "Desktop app").`);
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as { installed?: ClientSecrets; web?: ClientSecrets };
  const secrets = json.installed ?? json.web;
  if (!secrets?.client_id || !secrets.client_secret) throw new Error(`${file} has no client_id/client_secret`);
  return secrets;
}

function tokenFile(cfg: LoadedConfig): string {
  return dataPath(cfg, cfg.gmail.tokenFile);
}

export function readToken(cfg: LoadedConfig): Credentials | null {
  const file = tokenFile(cfg);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Credentials;
}

function saveToken(cfg: LoadedConfig, token: Credentials): void {
  writePrivateFile(tokenFile(cfg), JSON.stringify(token, null, 2));
}

/** An OAuth client with the stored token; refreshed tokens are saved as they arrive. */
export function authorizedClient(cfg: LoadedConfig): OAuth2Client {
  const secrets = readClientSecrets(cfg);
  const token = readToken(cfg);
  if (!token?.refresh_token) throw new Error("Gmail is not authorized yet. Run: npm run auth");
  const client = new OAuth2Client({ clientId: secrets.client_id, clientSecret: secrets.client_secret });
  client.setCredentials(token);
  client.on("tokens", (fresh) => {
    const merged = { ...readToken(cfg), ...fresh };
    saveToken(cfg, merged);
  });
  return client;
}

/**
 * Desktop OAuth flow with a loopback redirect and PKCE. Run it on the Mac mini itself:
 * the browser must reach 127.0.0.1 on the machine that runs this command.
 */
export async function runAuthFlow(cfg: LoadedConfig): Promise<string[]> {
  const secrets = readClientSecrets(cfg);
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not open a local port for the OAuth redirect");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;

  const client = new OAuth2Client({ clientId: secrets.client_id, clientSecret: secrets.client_secret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomUUID();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    login_hint: cfg.gmail.account,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  console.log(`Open this address in a browser on this machine and sign in as ${cfg.gmail.account}:\n\n${url}\n`);
  if (process.platform === "darwin") execFile("open", [url], () => undefined);

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Google sign-in (5 minutes)")), 5 * 60_000);
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get("error");
      const got = u.searchParams.get("code");
      if (err || !got || u.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/plain" }).end("Sign-in failed. You can close this tab.");
        clearTimeout(timer);
        reject(new Error(`Google sign-in failed: ${err ?? "missing code or state mismatch"}`));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("Signed in. You can close this tab and return to the terminal.");
      clearTimeout(timer);
      resolve(got);
    });
  });
  server.close();

  const { tokens } = await client.getToken({ code, codeVerifier });
  if (!tokens.refresh_token) {
    throw new Error("Google returned no refresh token. Remove the app's access at myaccount.google.com/permissions and run auth again.");
  }
  saveToken(cfg, tokens);
  return (tokens.scope ?? "").split(" ").filter(Boolean);
}
