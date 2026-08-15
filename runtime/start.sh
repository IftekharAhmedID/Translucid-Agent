#!/bin/sh
set -eu

mkdir -p /workspace/case/.opencode /workspace/case/output
if [ "${TRANSLUCID_RUNTIME_MODE:-legacy}" = "headless" ]; then
  cp -R /opt/investigator/runtime/headless-opencode/agents /workspace/case/.opencode/
  cp -R /opt/investigator/runtime/headless-opencode/skills /workspace/case/.opencode/
  cp /opt/investigator/runtime/headless-opencode/opencode.json /workspace/case/opencode.json
  cp /opt/investigator/runtime/HEADLESS_INSTRUCTIONS.md /workspace/case/INSTRUCTIONS.md
else
  cp -R /opt/investigator/runtime/opencode/agents /workspace/case/.opencode/
  cp -R /opt/investigator/runtime/opencode/skills /workspace/case/.opencode/
  cp /opt/investigator/runtime/opencode/opencode.json /workspace/case/opencode.json
  cp /opt/investigator/runtime/CASE_INSTRUCTIONS.md /workspace/case/INSTRUCTIONS.md
fi

cd /opt/investigator
if [ "${TRANSLUCID_RUNTIME_MODE:-legacy}" != "headless" ]; then
  ./node_modules/.bin/tsx runtime/extract-input.ts
fi
if [ "${CASE_ALLOW_STALE_MANIFEST:-false}" = "true" ]; then
  if [ -f /workspace/case/runtime-manifest.json ] && [ ! -f /workspace/case/runtime-manifest.research.json ]; then
    cp /workspace/case/runtime-manifest.json /workspace/case/runtime-manifest.research.json
  fi
  ./node_modules/.bin/tsx scripts/runtime-manifest.ts --output /workspace/case/runtime-manifest.publisher.json
elif [ ! -f /workspace/case/runtime-manifest.json ]; then
  ./node_modules/.bin/tsx scripts/runtime-manifest.ts --output /workspace/case/runtime-manifest.json
fi

cd /workspace/case
exec /opt/investigator/node_modules/.bin/opencode serve --hostname 0.0.0.0 --port 4096
