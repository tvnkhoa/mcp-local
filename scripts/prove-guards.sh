#!/usr/bin/env bash
#
# Prove the guards guard (migration step S-41).
#
# Injects a deliberate violation of each enforcement mechanism in turn, asserts the mechanism
# REJECTS it, and reverts. A guard that has never been shown to fail is a guard on trust: flipping
# a rule from warning to error changes a severity constant, and nothing about that change proves
# the rule still fires.
#
# Every case restores itself with `git checkout` / `rm`, and the script asserts afterwards that the
# specific files it touched are clean. Run from the workspace root:
#
#     bash scripts/prove-guards.sh
#
# Exits non-zero if any mechanism accepted its violation, or if any injection leaked.
set -u

cd "$(dirname "$0")/.." || exit 1

pass=0
fail=0

# A guard passes this test when it FAILS on the violation.
expect_rejected() {
  if [ "$2" -ne 0 ]; then
    echo "  PASS  $1 — rejected (exit $2)"
    pass=$((pass + 1))
  else
    echo "  FAIL  $1 — ACCEPTED the violation <<< this guard does not guard"
    fail=$((fail + 1))
  fi
}

echo "== guard deps =="

printf '\nconst leak = process.env.SNEAKY_VALUE;\nexport const x = leak;\n' >> postgres-mcp/src/index.ts
npm run guard:deps >/dev/null 2>&1
expect_rejected "env/direct-access        (process.env outside the config module)" $?
git checkout -- postgres-mcp/src/index.ts

printf '\nimport { GraphStore } from "../../codebase-index-mcp/src/store/graphStore.js";\nexport type T = typeof GraphStore;\n' >> observe-mcp/src/index.ts
npm run guard:deps >/dev/null 2>&1
expect_rejected "servers/cross-import     (one server importing another)" $?
git checkout -- observe-mcp/src/index.ts

printf '\nimport { SERVERS } from "@mcp/manifest";\nexport const n = SERVERS.length;\n' >> bitbucket-mcp/src/index.ts
npm run guard:deps >/dev/null 2>&1
expect_rejected "servers/tooling-import   (a server importing workspace tooling)" $?
git checkout -- bitbucket-mcp/src/index.ts

echo
echo "== guard convention =="

python -c "
from pathlib import Path
Path('packages/core/src/oversized.ts').write_text(
    'export const filler: number[] = [\n' + '  0,\n' * 700 + '];\n', encoding='utf-8')
"
npm run guard:convention >/dev/null 2>&1
expect_rejected "size/hard-cap            (a 700-line file)" $?
rm -f packages/core/src/oversized.ts

printf '\nexport default function sneaky(): void {}\n' >> packages/core/src/paths.ts
npm run guard:convention >/dev/null 2>&1
expect_rejected "style/no-default-export  (a default export)" $?
git checkout -- packages/core/src/paths.ts

echo
echo "== policy and drift gates =="

printf '\nimport OpenAI from "openai";\nexport const client = OpenAI;\n' >> codebase-index-mcp/src/serverUtils.ts
( cd codebase-index-mcp && npm run guard:no-llm-runtime >/dev/null 2>&1 )
expect_rejected "guard:no-llm-runtime     (an LLM client import)" $?
git checkout -- codebase-index-mcp/src/serverUtils.ts

python -c "
import json, pathlib
p = pathlib.Path('contracts/bitbucket-mcp.json')
d = json.loads(p.read_text(encoding='utf-8'))
tools = d['tools'] if isinstance(d, dict) and 'tools' in d else d
tools[0]['name'] = 'renamed_by_prove_guards'
p.write_text(json.dumps(d, indent=2), encoding='utf-8')
"
npm run contracts:check >/dev/null 2>&1
expect_rejected "contracts:check          (a renamed tool in a snapshot)" $?
git checkout -- contracts/bitbucket-mcp.json

printf '\nHAND_EDITED_BY_PROVE_GUARDS=1\n' >> observe-mcp/.env.example
npm run generate:check >/dev/null 2>&1
expect_rejected "generate:check           (a hand-edited generated file)" $?
git checkout -- observe-mcp/.env.example

echo
echo "== cleanup =="
# Scoped to the files this script touches, so an unrelated work-in-progress edit elsewhere in the
# tree is not misreported as a leaked injection.
TOUCHED="postgres-mcp/src/index.ts observe-mcp/src/index.ts bitbucket-mcp/src/index.ts \
packages/core/src/paths.ts codebase-index-mcp/src/serverUtils.ts contracts/bitbucket-mcp.json \
observe-mcp/.env.example"
leaked=$(git status --porcelain -- $TOUCHED)
if [ -z "$leaked" ] && [ ! -f packages/core/src/oversized.ts ]; then
  echo "  PASS  every injection reverted"
  pass=$((pass + 1))
else
  echo "  FAIL  leftovers:"
  echo "$leaked"
  [ -f packages/core/src/oversized.ts ] && echo "        packages/core/src/oversized.ts"
  fail=$((fail + 1))
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
