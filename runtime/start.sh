#!/bin/sh
set -eu

mkdir -p /workspace/case/.opencode /workspace/case/output
cp -R /opt/investigator/runtime/headless-opencode/agents /workspace/case/.opencode/
cp -R /opt/investigator/runtime/headless-opencode/skills /workspace/case/.opencode/
cp /opt/investigator/runtime/headless-opencode/opencode.json /workspace/case/opencode.json
cp /opt/investigator/runtime/HEADLESS_INSTRUCTIONS.md /workspace/case/INSTRUCTIONS.md

cd /opt/investigator
if [ "${CASE_ALLOW_STALE_MANIFEST:-false}" = "true" ]; then
  ./node_modules/.bin/tsx scripts/runtime-manifest.ts --output /workspace/case/runtime-manifest.publisher.json
elif [ ! -f /workspace/case/runtime-manifest.json ]; then
  ./node_modules/.bin/tsx scripts/runtime-manifest.ts --output /workspace/case/runtime-manifest.json
fi

cd /workspace/case
exec /opt/investigator/node_modules/.bin/opencode serve --hostname 0.0.0.0 --port 4096
