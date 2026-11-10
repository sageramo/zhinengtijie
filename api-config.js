// Select the local upgraded API during local development. No automatic text
// submission occurs; production must pass capability negotiation before use.
window.CAMPUS_AGENT_API = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  ? "http://127.0.0.1:8765"
  : "https://campus-action-agent-back.onrender.com";
// The public server sleeps when idle and needs about half a minute to wake. Knock once as soon as any
// page opens (no data, no credentials), so it is awake by the time the workbench asks for a calendar.
if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  try { fetch(`${window.CAMPUS_AGENT_API}/api/health`, { credentials: "omit", referrerPolicy: "no-referrer" }).catch(() => {}); } catch { /* nothing to wake */ }
}
