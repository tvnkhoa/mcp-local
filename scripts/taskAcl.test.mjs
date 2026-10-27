/**
 * mcp:doctor's task ACL check, against a stubbed machine: a task created elevated (the user holds read
 * only) is flagged with the one-time elevated delete; a task the user can write, a missing task and a
 * non-Windows host pass. The user's own SID and groups come from `whoami`, never from the real token.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { allowAces, checkTaskWritable } from "./lib/taskAcl.mjs";

const USER = "S-1-5-21-1-2-3-1001";
const TASK = "mcp-local\\codebase-index-http";

// Elevated-created: SYSTEM + Administrators full, the user read/execute only.
const READ_ONLY = `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;${USER})`;
const OWN = `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${USER})`;
const VIA_GROUP = `D:(A;;FA;;;SY)(A;;0x1f01ff;;;S-1-5-32-545)`;

function machine(sddl, { denyOnlyAdmins = true } = {}) {
  return (cmd, args) => {
    if (cmd === "powershell") return sddl === null ? "" : `${sddl}\r\n`;
    if (args[0] === "/user") return `"host\me","${USER}"\r\n`;
    return [
      `"BUILTIN\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"`,
      `"BUILTIN\Administrators","Alias","S-1-5-32-544","${denyOnlyAdmins ? "Group used for deny only" : "Enabled group"}"`
    ].join("\r\n");
  };
}

test("allowAces resolves aliases and ignores deny entries", () => {
  assert.deepEqual(allowAces("D:(D;;FA;;;WD)(A;;FR;;;BA)"), [{ sid: "S-1-5-32-544", rights: "FR" }]);
});

test("a task created elevated (user read only) warns with the one-time elevated delete", () => {
  const r = checkTaskWritable(TASK, { exec: machine(READ_ONLY), platform: "win32" });
  assert.equal(r.status, "warn");
  assert.match(r.fix, /ELEVATED prompt: schtasks \/Delete \/TN "mcp-local\\codebase-index-http" \/F/);
});

test("Administrators held deny-only does not count as write access", () => {
  const sddl = `D:(A;;FA;;;SY)(A;;FA;;;BA)`;
  assert.equal(checkTaskWritable(TASK, { exec: machine(sddl), platform: "win32" }).status, "warn");
  assert.equal(checkTaskWritable(TASK, { exec: machine(sddl, { denyOnlyAdmins: false }), platform: "win32" }).status, "pass");
});

test("a task the user owns, or writes through a group, passes", () => {
  assert.equal(checkTaskWritable(TASK, { exec: machine(OWN), platform: "win32" }).status, "pass");
  assert.equal(checkTaskWritable(TASK, { exec: machine(VIA_GROUP), platform: "win32" }).status, "pass");
});

test("no task, or not Windows, passes without a fix", () => {
  const none = checkTaskWritable(TASK, { exec: machine(null), platform: "win32" });
  assert.equal(none.status, "pass");
  assert.equal(none.fix, undefined);
  assert.equal(checkTaskWritable(TASK, { exec: machine(READ_ONLY), platform: "linux" }).status, "pass");
});
