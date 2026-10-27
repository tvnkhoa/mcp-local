/**
 * Can the current user replace or delete the server's logon task?
 *
 * A task first registered from an ELEVATED prompt keeps an ACL that gives its user read only, so a normal
 * prompt gets "Access is denied" on `schtasks /Create /F` and on `/Delete` (27 Oct). Nothing reported it
 * until the re-register failed, so `mcp:doctor` reads the task's DACL (SDDL) and flags the case.
 *
 * Every command goes through `exec(cmd, argsArray)` so the test stubs the machine. Nothing printed here
 * holds a secret: only SIDs, task names and rights.
 */

import { execFileSync } from "node:child_process";

/** By absolute path: Git Bash puts a coreutils `whoami` that takes no flags ahead of the Windows one. */
const WHOAMI = process.env.SystemRoot ? `${process.env.SystemRoot}/System32/whoami.exe` : "whoami";

const defaultExec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

/** SDDL aliases for the well-known groups every interactive token carries. */
const ALIAS_SIDS = { WD: "S-1-1-0", AU: "S-1-5-11", IU: "S-1-5-4", BU: "S-1-5-32-545", BA: "S-1-5-32-544", SY: "S-1-5-18" };

/** DELETE | WRITE_DAC | WRITE_OWNER | FILE_WRITE_DATA | GENERIC_WRITE | GENERIC_ALL. */
const WRITE_BITS = 0x10000 | 0x40000 | 0x80000 | 0x2 | 0x40000000 | 0x10000000;
const WRITE_RIGHTS = new Set(["FA", "GA", "GW", "SD", "WD", "WO", "FW", "DC"]);

/** The Allow ACEs of an SDDL string: `{ sid, rights }[]`, with an alias resolved to its SID. */
export function allowAces(sddl) {
  const dacl = sddl.split(/\)S:/)[0];  // the SACL, when present, follows the DACL
  const aces = [];
  for (const [, body] of dacl.matchAll(/\(([^)]*)\)/g)) {
    const [type, , rights, , , trustee] = body.split(";");
    if (type !== "A" || !trustee) continue;
    aces.push({ sid: ALIAS_SIDS[trustee] ?? trustee, rights });
  }
  return aces;
}

function grantsWrite(rights) {
  if (/^0x[0-9a-f]+$/i.test(rights)) return (Number(rights) & WRITE_BITS) !== 0;
  return (rights.match(/../g) ?? []).some((r) => WRITE_RIGHTS.has(r));
}

/** SIDs of the user and its enabled groups, from `whoami /user` and `/groups` CSV (deny-only groups excluded). */
export function tokenSids(exec) {
  const csv = (text) => text.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^"|"$/g, "").split('","'));
  const sids = new Set();
  for (const row of csv(exec(WHOAMI, ["/user", "/fo", "csv", "/nh"]))) if (row[1]) sids.add(row[1]);
  for (const row of csv(exec(WHOAMI, ["/groups", "/fo", "csv", "/nh"]))) {
    if (row[2] && !/deny only/i.test(row[3] ?? "")) sids.add(row[2]);
  }
  return sids;
}

/** The task's DACL as SDDL, or null when the task is not registered (or the scheduler is unreachable). */
export function taskSddl(taskName, exec = defaultExec) {
  const i = taskName.lastIndexOf("\\");
  const folder = `\\${taskName.slice(0, i)}`;
  const name = taskName.slice(i + 1);
  const script =
    "$s=New-Object -ComObject Schedule.Service;$s.Connect();" +
    `try{$s.GetFolder('${folder}').GetTask('${name}').GetSecurityDescriptor(4)}catch{}`;
  try {
    const out = exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * `{ status, message, fix }` for the task: `pass` when the user can write it or it does not exist, `warn`
 * when only a read-only ACE reaches the user. `fix` is the one-time elevated step.
 */
export function checkTaskWritable(taskName, { exec = defaultExec, platform = process.platform } = {}) {
  if (platform !== "win32") return { status: "pass", message: "not Windows: no scheduled task" };
  const sddl = taskSddl(taskName, exec);
  if (sddl === null) return { status: "pass", message: `${taskName} not registered (or scheduler unreachable)` };
  let sids;
  try {
    sids = tokenSids(exec);
  } catch {
    return { status: "pass", message: "could not read the user's token; ACL not checked" };
  }
  const writable = allowAces(sddl).some((a) => sids.has(a.sid) && grantsWrite(a.rights));
  if (writable) return { status: "pass", message: `${taskName} is writable by this user` };
  return {
    status: "warn",
    message: `${taskName} ACL gives this user no write: created elevated, so re-register is denied`,
    fix: `once, from an ELEVATED prompt: schtasks /Delete /TN "${taskName}" /F   # then re-run serve-http --task register`
  };
}
