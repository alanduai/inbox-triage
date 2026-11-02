import fs from "node:fs";
import http from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";
import { dataPath, type LoadedConfig } from "../config.js";
import { writePrivateFile } from "../util/files.js";

// Phase 1 only reads. Phase 2 adds gmail.modify (mark read, archive) and gmail.send.
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
// The expenses agent reads and saves drafts. Google has no drafts-only scope: compose also allows
// sending, so this token is kept in its own file and the agent's code never calls send.
export const EXPENSES_GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];

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

function tokenFile(cfg: LoadedConfig, name = cfg.gmail.tokenFile): string {
  return dataPath(cfg, name);
}

export function readToken(cfg: LoadedConfig, name = cfg.gmail.tokenFile): Credentials | null {
  const file = tokenFile(cfg, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Credentials;
}

function saveToken(cfg: LoadedConfig, token: Credentials, name = cfg.gmail.tokenFile): void {
  writePrivateFile(tokenFile(cfg, name), JSON.stringify(token, null, 2));
}

/** An OAuth client with the stored token; refreshed tokens are saved as they arrive. */
export function authorizedClient(cfg: LoadedConfig, opts: { tokenFile?: string; authCommand?: string } = {}): OAuth2Client {
  const name = opts.tokenFile ?? cfg.gmail.tokenFile;
  const secrets = readClientSecrets(cfg);
  const token = readToken(cfg, name);
  if (!token?.refresh_token) throw new Error(`Gmail is not authorized yet. Run: ${opts.authCommand ?? "npm run auth"}`);
  const client = new OAuth2Client({ clientId: secrets.client_id, clientSecret: secrets.client_secret });
  client.setCredentials(token);
  client.on("tokens", (fresh) => {
    const merged = { ...readToken(cfg, name), ...fresh };
    saveToken(cfg, merged, name);
  });
  return client;
}

/** The scopes a stored token was granted, as Google reported them at sign-in. */
export function tokenScopes(cfg: LoadedConfig, name = cfg.gmail.tokenFile): string[] {
  return (readToken(cfg, name)?.scope ?? "").split(" ").filter(Boolean);
}

/**
 * Desktop OAuth flow with a loopback redirect and PKCE. Run it on the Mac mini itself:
 * the browser must reach 127.0.0.1 on the machine that runs this command.
 */
export async function runAuthFlow(cfg: LoadedConfig, opts: { scopes?: string[]; tokenFile?: string; account?: string } = {}): Promise<string[]> {
  const scopes = opts.scopes ?? GMAIL_SCOPES;
  const account = opts.account ?? cfg.gmail.account;
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
    scope: scopes,
    login_hint: account,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  console.log(`Open this address in a browser on this machine and sign in as ${account}:\n\n${url}\n`);
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
  saveToken(cfg, tokens, opts.tokenFile ?? cfg.gmail.tokenFile);
  return (tokens.scope ?? "").split(" ").filter(Boolean);
}
