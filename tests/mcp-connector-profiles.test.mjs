import assert from "node:assert/strict";
import test from "node:test";
import { inferConnectorApplicationType, parseConnectorProfiles } from "../scripts/mcp-connector-profiles.mjs";

test("connector profile inference distinguishes loopback native clients from hosted web clients", () => {
  assert.equal(inferConnectorApplicationType(["http://localhost:43123/oauth/callback"]), "native");
  assert.equal(inferConnectorApplicationType(["http://127.0.0.1:43123/oauth/callback"]), "native");
  assert.equal(inferConnectorApplicationType(["https://client.example.test/oauth/callback"]), "web");
});

test("structured connector profiles preserve provider-specific application types and callbacks", () => {
  const profiles = parseConnectorProfiles({
    profilesJson: JSON.stringify([
      {
        client_name: "Claude",
        redirect_uris: ["https://claude.example.test/oauth/callback"],
        application_type: "web",
      },
      {
        client_name: "Gemini CLI",
        redirect_uris: ["http://localhost:43123/oauth/callback"],
        application_type: "native",
      },
      {
        client_name: "Grok",
        redirect_uris: ["https://grok.example.test/oauth/callback"],
        application_type: "web",
      },
    ]),
    legacyRedirectUris: "",
  });
  assert.deepEqual(profiles.map(({ client_name, application_type }) => ({ client_name, application_type })), [
    { client_name: "Claude", application_type: "web" },
    { client_name: "Gemini CLI", application_type: "native" },
    { client_name: "Grok", application_type: "web" },
  ]);
});

test("legacy redirect list remains supported and infers application_type per client", () => {
  const profiles = parseConnectorProfiles({
    profilesJson: "",
    legacyRedirectUris: "http://localhost:43123/oauth/callback,https://hosted.example.test/oauth/callback",
  });
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].application_type, "native");
  assert.equal(profiles[1].application_type, "web");
});

test("connector profiles reject non-loopback HTTP redirects", () => {
  assert.throws(() => parseConnectorProfiles({
    profilesJson: JSON.stringify([{
      client_name: "Invalid",
      redirect_uris: ["http://example.test/oauth/callback"],
    }]),
    legacyRedirectUris: "",
  }), /HTTPS or an HTTP loopback host/);
});
