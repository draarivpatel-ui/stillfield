#!/bin/bash
# Builds EA IRIS (https://github.com/electronicarts/IRIS, BSD-3-Clause) locally for docs/IRIS-COMPARISON.md.
# Everything goes under the work dir (default .scratch, gitignored). Took about 9 minutes on an Apple silicon Mac.
# Usage: scripts/build-iris.sh [work dir]; then node scripts/iris-compare.ts <work>/iris/build/example/IrisApp <work>/iris-run
set -euo pipefail
W="${1:-$(cd "$(dirname "$0")/.." && pwd)/.scratch}"
mkdir -p "$W" && cd "$W"
# meson (used by the opencv and ffmpeg ports) needs Python 3.10 or newer
for p in /opt/homebrew/opt/python@3.13/libexec/bin /usr/local/opt/python@3.13/libexec/bin; do [ -d "$p" ] && export PATH="$p:$PATH"; done
export VCPKG_DISABLE_METRICS=1 VCPKG_DEFAULT_BINARY_CACHE="$W/vcpkg-cache" VCPKG_DOWNLOADS="$W/vcpkg-downloads"
export X_VCPKG_REGISTRIES_CACHE="$W/vcpkg-registries" VCPKG_MAX_CONCURRENCY=6 CMAKE_BUILD_PARALLEL_LEVEL=6
mkdir -p "$VCPKG_DEFAULT_BINARY_CACHE" "$VCPKG_DOWNLOADS" "$X_VCPKG_REGISTRIES_CACHE"
[ -d iris ] || git clone -q --depth 1 https://github.com/electronicarts/IRIS.git iris
[ -d vcpkg ] || git clone -q --depth 1 https://github.com/microsoft/vcpkg.git vcpkg
[ -x vcpkg/vcpkg ] || ./vcpkg/bootstrap-vcpkg.sh -disableMetrics
# the pinned builtin-baseline needs full vcpkg history; use the checkout's own port versions instead
python3 -I -c "import json;p='iris/vcpkg.json';d=json.load(open(p));d.pop('builtin-baseline',None);json.dump(d,open(p,'w'),indent=2)"
triplet=$( [ "$(uname -m)" = arm64 ] && echo arm64-osx-release || echo x64-osx-release )
nice -n 15 cmake -S iris -B iris/build -DCMAKE_BUILD_TYPE=Release -DBUILD_EXAMPLE_APP=ON -DBUILD_TESTS=OFF -DEXPORT_IRIS=OFF \
  -DCMAKE_TOOLCHAIN_FILE="$W/vcpkg/scripts/buildsystems/vcpkg.cmake" -DVCPKG_TARGET_TRIPLET="$triplet"
nice -n 15 cmake --build iris/build --config Release -j 6
ls -la iris/build/example/IrisApp
