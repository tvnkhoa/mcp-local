import assert from "node:assert/strict";
import test from "node:test";

import type { ResponseProfile } from "@mcp/core";

import { DEFAULT_PROFILE, includesDetail, resolveProfile } from "./responseFormatter.js";

const ALL: readonly ResponseProfile[] = ["nano", "compact", "standard", "verbose"];

test("includesDetail at the default threshold splits standard from compact", () => {
  assert.deepEqual(
    ALL.map((profile) => [profile, includesDetail(profile)]),
    [
      ["nano", false],
      ["compact", false],
      ["standard", true],
      ["verbose", true]
    ]
  );
});

test("a lower threshold moves the split, without a second predicate", () => {
  // What lets one tool spend the nano rung on a different cut than the standard one.
  assert.deepEqual(
    ALL.map((profile) => [profile, includesDetail(profile, undefined, "compact")]),
    [
      ["nano", false],
      ["compact", true],
      ["standard", true],
      ["verbose", true]
    ]
  );
});

test("an explicit override wins at every profile, in both directions", () => {
  for (const profile of ALL) {
    assert.equal(includesDetail(profile, true), true, `${profile}: opt-in must be honoured`);
    assert.equal(includesDetail(profile, false), false, `${profile}: opt-out must be honoured`);
  }
});

test("resolveProfile reproduces dispatch's precedence: arg, then ctx, then the default", () => {
  assert.equal(resolveProfile("verbose", { profile: "nano" }), "verbose");
  // The B-03 case: no argument, but dispatch resolved something else from deps.defaultProfile.
  // Reading only `args.profile` here would shape as compact while the response is serialized nano.
  assert.equal(resolveProfile(undefined, { profile: "nano" }), "nano");
  assert.equal(resolveProfile(undefined, {}), DEFAULT_PROFILE);
  assert.equal(resolveProfile(undefined), DEFAULT_PROFILE);
});
