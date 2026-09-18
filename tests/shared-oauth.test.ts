import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { cleanup, isolateStateDir, makeTmpDir, pkceVerifierAndChallenge, write } from "./helpers.js";

let root: string, a: string, b: string, state: string, bridge: Bridge, legacy: Bridge;
const redirect = "http://127.0.0.1:19999/callback";
beforeAll(async () => {
  state = isolateStateDir(); root = makeTmpDir("shared-consent");
  a = path.join(root, "a"); b = path.join(root, "b");
  write(a, "hello.txt", "a"); write(b, "hello.txt", "b");
  bridge = await startBridge({ workspaceRoot: a, allowedRoots: [root], port: 0, persistRuntime: false });
  legacy = await startBridge({ workspaceRoot: a, port: 0, persistRuntime: false });
});
afterAll(async () => { await bridge.close(); await legacy.close(); cleanup(root); cleanup(state); });

async function tokenRequest(server: Bridge, body: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.localBaseUrl()}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  return { status: response.status, body: await response.json() };
}
async function authorize(server: Bridge, resource?: string, scope?: string): Promise<{ clientId: string; verifier: string; code?: string; html: string; error?: string }> {
  const base = server.localBaseUrl();
  const response = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "shared-test", redirect_uris: [redirect] }) });
  const { client_id: clientId } = await response.json() as { client_id: string };
  const { verifier, challenge } = pkceVerifierAndChallenge();
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: scope ?? "workspace.read offline_access" });
  if (resource !== undefined) query.set("resource", resource);
  const page = await fetch(`${base}/oauth/authorize?${query}`, { redirect: "manual" });
  const html = await page.text();
  if (page.status === 302) return { clientId, verifier, html, error: new URL(page.headers.get("location")!).searchParams.get("error")! };
  expect(page.status).toBe(200);
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  expect(requestId).toBeTruthy();
  const pairing = server.pairing.create();
  const approved = await fetch(`${base}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request_id: requestId!, pairing_code: pairing.code, allowedRoots: "/" }), redirect: "manual" });
  expect(approved.status).toBe(302);
  return { clientId, verifier, html, code: new URL(approved.headers.get("location")!).searchParams.get("code")! };
}
function exchange(auth: Awaited<ReturnType<typeof authorize>>, resource?: string) {
  return tokenRequest(bridge, { grant_type: "authorization_code", client_id: auth.clientId, redirect_uri: redirect, code: auth.code!, code_verifier: auth.verifier, ...(resource ? { resource } : {}) });
}

describe("shared OAuth consent and migration", () => {
  it("captures the approved roots at consent and binds both token types to the MCP resource", async () => {
    const auth = await authorize(bridge);
    expect(auth.html).toContain(root); expect(auth.html).toContain("subdirectories");
    const token = await exchange(auth);
    expect(token.status).toBe(200);
    const checked = bridge.authStore.verifyAccessToken(token.body.access_token);
    expect(checked.ok && checked.record.allowedRoots).toEqual([root]);
    expect(checked.ok && checked.record.resource).toBe(`${bridge.localBaseUrl()}/mcp`);
    const refreshed = await tokenRequest(bridge, { grant_type: "refresh_token", client_id: auth.clientId, refresh_token: token.body.refresh_token });
    expect(refreshed.status).toBe(200);
    const rotated = bridge.authStore.verifyAccessToken(refreshed.body.access_token);
    expect(rotated.ok && rotated.record.allowedRoots).toEqual([root]);
    expect((await tokenRequest(bridge, { grant_type: "refresh_token", client_id: auth.clientId, refresh_token: token.body.refresh_token })).status).toBe(400);
  });
  it("rejects resource substitution at authorization, exchange, and refresh without broadening scopes", async () => {
    expect((await authorize(bridge, "https://wrong.example/mcp")).error).toBe("invalid_target");
    expect((await authorize(bridge, undefined, "root.superuser")).error).toBe("invalid_scope");
    const auth = await authorize(bridge);
    expect((await exchange(auth, "https://wrong.example/mcp")).status).toBe(400);
    const second = await authorize(bridge), token = await exchange(second);
    const refreshBody = { grant_type: "refresh_token", client_id: second.clientId, refresh_token: token.body.refresh_token };
    expect((await tokenRequest(bridge, { ...refreshBody, resource: "https://wrong.example/mcp" })).status).toBe(400);
    expect((await tokenRequest(bridge, refreshBody)).status).toBe(200);
  });
  it("keeps resource-less legacy refresh grants usable only in their original single-workspace mode", async () => {
    const old = legacy.authStore.issueTokens({ clientId: "old", scopes: ["workspace.read", "offline_access"] });
    const result = await tokenRequest(legacy, { grant_type: "refresh_token", client_id: "old", refresh_token: old.refreshToken! });
    expect(result.status).toBe(200);
    const verified = legacy.authStore.verifyAccessToken(result.body.access_token);
    expect(verified.ok && verified.record.allowedRoots).toBeUndefined();
    expect(verified.ok && verified.record.workspaceId).toBe(legacy.workspace.id);
    const oldShared = bridge.authStore.issueTokens({ clientId: "old", scopes: ["workspace.read", "offline_access"] });
    expect((await tokenRequest(bridge, { grant_type: "refresh_token", client_id: "old", refresh_token: oldShared.refreshToken! })).status).toBe(400);
  });
});
