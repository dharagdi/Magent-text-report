#!/usr/bin/env bash
# Package the extension into a distributable zip for "Load unpacked" sharing.
# Usage:  bash extension/build-zip.sh   (run from repo root or anywhere)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/../jobapplier-extension.zip}"
rm -f "$out"
cd "$here"
zip -r -q "$out" . \
  -x "build-zip.sh" -x "*.DS_Store" -x "__MACOSX/*"
echo "Wrote $out"
