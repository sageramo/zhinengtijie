// Select the local upgraded API during local development. No automatic text
// submission occurs; production must pass capability negotiation before use.
window.CAMPUS_AGENT_API = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  ? "http://127.0.0.1:8765"
  : "https://campus-action-agent-back.onrender.com";
