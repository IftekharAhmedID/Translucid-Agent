#!/bin/sh
set -eu

mkdir -p /workspace/case/.opencode /workspace/case/output /workspace/case/.config
cp -R /opt/investigator/runtime/opencode/agents /workspace/case/.opencode/
cp -R /opt/investigator/runtime/opencode/skills /workspace/case/.opencode/
cp /opt/investigator/runtime/opencode/opencode.json /workspace/case/opencode.json
cp /opt/investigator/runtime/CASE_INSTRUCTIONS.md /workspace/case/INSTRUCTIONS.md

cd /opt/investigator
./node_modules/.bin/tsx runtime/extract-input.ts
./node_modules/.bin/tsx scripts/runtime-manifest.ts --output /workspace/case/runtime-manifest.json

cd /workspace/case
exec /opt/investigator/node_modules/.bin/opencode serve --hostname 0.0.0.0 --port 4096
