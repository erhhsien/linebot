import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { isValidSignature } from "../src/app.js";

test("accepts a valid LINE signature", () => {
  const body = '{"events":[]}';
  const secret = "test-secret";
  const signature = createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(isValidSignature(body, signature, secret), true);
});

test("rejects an invalid LINE signature", () => {
  assert.equal(isValidSignature('{"events":[]}', "invalid", "test-secret"), false);
});
