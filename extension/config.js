// Filled in by /api/extension/download with the instance's own address.
// A user can point the extension at another instance in the options page.
export const DEFAULT_ENDPOINT = "__GAER_ENDPOINT__";
export const BRIDGE = "gaer-bridge";
export const VERSION = chrome.runtime.getManifest().version;

export async function getEndpoint() {
  const { endpoint } = await chrome.storage.sync.get("endpoint");
  return endpoint || (DEFAULT_ENDPOINT.startsWith("http") ? DEFAULT_ENDPOINT : "http://localhost:5173");
}
