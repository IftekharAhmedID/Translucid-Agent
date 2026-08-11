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
./node_modules/.bin/tsx scripts/runtime-manifest.ts --output /workspace/case/runtime-manifest.json

cd /workspace/case
exec /opt/investigator/node_modules/.bin/opencode serve --hostname 0.0.0.0 --port 4096
