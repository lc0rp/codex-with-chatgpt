import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TunnelPreference = "unset" | "quick" | "named";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export const TUNNEL_CHOICE_PROMPT = `There is an optional choice before connecting to ChatGPT.
Do you have a Cloudflare account and a domain already added to Cloudflare?
- Yes: you can use a stable domain. Configure the connector once; it should usually keep working after computer restarts. You will need to log in to Cloudflare once and add a subdomain under your domain.
- No: use a temporary address. No registration is needed, and the features are the same. The address often changes after a computer restart, so the old address in ChatGPT will stop working. I will delete this project's connector and add it again with the new address. You may occasionally need to log in to ChatGPT again. The connection can be repaired, but it takes longer.
You can use this without an account. Which option do you prefer? If you have a domain, tell me its name (for example, example.com).`;

export const NAMED_LOGIN_PROMPT =
  "A browser window will open. Log in to Cloudflare, select your domain, then tell me 'done'.";

export const NAMED_FALLBACK_MESSAGE =
  "We will use a temporary address for now. The features are the same, but future connection repairs may take longer. Say when you are ready to switch to a stable domain.";

export const NAMED_REPAIR_MESSAGE =
  "The stable domain is temporarily unreachable. Log in to Cloudflare in the window that opens, select your domain, then tell me 'done'.";
