import http from "node:http";
import https from "node:https";

/**
 * Global network guard. The assessment brief forbids real API calls in tests;
 * rather than trusting every test to remember, any outbound request throws.
 * A test that accidentally reaches the live provider fails loudly and cheaply.
 */
const BLOCKED_MESSAGE =
  "Network access is blocked in tests. Use the mock LLM client or a fixture instead.";

function blocked(): never {
  throw new Error(BLOCKED_MESSAGE);
}

globalThis.fetch = (() => blocked()) as unknown as typeof fetch;

for (const module of [http, https]) {
  module.request = blocked as unknown as typeof module.request;
  module.get = blocked as unknown as typeof module.get;
}
