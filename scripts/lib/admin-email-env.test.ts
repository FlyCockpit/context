import assert from "node:assert/strict";
import { test } from "node:test";

import { looksLikeEmail, readAdminEmailsValue, withAdminEmail } from "./admin-email-env.js";

test("readAdminEmailsValue is null when the line is absent, empty, or commented out", () => {
  assert.equal(readAdminEmailsValue("BETTER_AUTH_SECRET=x\n"), null);
  assert.equal(readAdminEmailsValue("ADMIN_EMAILS=\n"), null);
  assert.equal(readAdminEmailsValue("# ADMIN_EMAILS=admin@example.com\n"), null);
});

test("readAdminEmailsValue reads an existing non-empty value, trimming quotes", () => {
  assert.equal(readAdminEmailsValue("ADMIN_EMAILS=admin@example.com\n"), "admin@example.com");
  assert.equal(readAdminEmailsValue('ADMIN_EMAILS="admin@example.com"\n'), "admin@example.com");
});

test("withAdminEmail appends the line when it is missing entirely", () => {
  const result = withAdminEmail("BETTER_AUTH_SECRET=x", "owner@example.com");
  assert.equal(result, "BETTER_AUTH_SECRET=x\nADMIN_EMAILS=owner@example.com");
});

test("withAdminEmail replaces an existing empty line in place", () => {
  const result = withAdminEmail("A=1\nADMIN_EMAILS=\nB=2", "owner@example.com");
  assert.equal(result, "A=1\nADMIN_EMAILS=owner@example.com\nB=2");
});

test("withAdminEmail is a no-op when ADMIN_EMAILS is already set — idempotent re-run", () => {
  const original = "ADMIN_EMAILS=existing@example.com\n";
  assert.equal(withAdminEmail(original, "new@example.com"), original);
});

test("withAdminEmail never duplicates the line across repeated calls", () => {
  const once = withAdminEmail("A=1", "owner@example.com");
  const twice = withAdminEmail(once, "owner@example.com");
  assert.equal(twice, once);
  assert.equal(twice.match(/ADMIN_EMAILS=/g)?.length, 1);
});

test("looksLikeEmail is a loose @ check, not a full validator", () => {
  assert.equal(looksLikeEmail("owner@example.com"), true);
  assert.equal(looksLikeEmail("not-an-email"), false);
  assert.equal(looksLikeEmail(""), false);
});
