import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLabel, projectLabels } from "../src/names";

test("modelLabel turns model ids into short names", () => {
  assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel("claude-opus-5"), "Opus 5");
  assert.equal(modelLabel("claude-sonnet-4-6"), "Sonnet 4.6");
  assert.equal(modelLabel("claude-fable-5-1"), "Fable 5.1");
  assert.equal(modelLabel("claude-opus-4-1-20250805"), "Opus 4.1");
  assert.equal(modelLabel("claude-3-5-haiku-20241022"), "Haiku 3.5");
  assert.equal(modelLabel("us.anthropic.claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelLabel("claude-opus-4-5@20251101"), "Opus 4.5");
  assert.equal(modelLabel("gpt-something"), "gpt-something");
  assert.equal(modelLabel(undefined), "—");
});

test("projectLabels uses the most common cwd's folder name", () => {
  const labels = projectLabels(
    new Map([
      ["-Users-me-code-app", ["/Users/me/code/app", "/Users/me/code/app", "/Users/me/code/app/src"]],
      ["-Users-me-notes", []],
    ])
  );
  assert.equal(labels.get("-Users-me-code-app"), "app");
  assert.equal(labels.get("-Users-me-notes"), "Users-me-notes");
});

test("projectLabels disambiguates colliding folder names with the parent", () => {
  const labels = projectLabels(
    new Map([
      ["-a-web-app", ["/a/web/app"]],
      ["-b-mobile-app", ["/b/mobile/app"]],
      ["-c-api", ["C:\\work\\api"]],
    ])
  );
  assert.equal(labels.get("-a-web-app"), "web/app");
  assert.equal(labels.get("-b-mobile-app"), "mobile/app");
  assert.equal(labels.get("-c-api"), "api");
});
