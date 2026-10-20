#!/bin/sh
# Builds a trimmed OpenCV.js (core + imgproc, whitelisted functions, separate .wasm) into dist/. Needs Docker.
set -eu
OPENCV=4.13.0
EMSDK=4.0.20
cd "$(dirname "$0")"
mkdir -p .build dist
[ -d .build/opencv-$OPENCV ] || curl -sSL https://github.com/opencv/opencv/archive/refs/tags/$OPENCV.tar.gz | tar xz -C .build
docker run --rm -v "$PWD:/src" -w /src -u "$(id -u):$(id -g)" emscripten/emsdk:$EMSDK \
  emcmake python3 .build/opencv-$OPENCV/platforms/js/build_js.py .build/out \
  --build_wasm --disable_single_file --config /src/opencv.config.py \
  --cmake_option=-DBUILD_LIST=core,imgproc,js --cmake_option=-DCMAKE_CXX_STANDARD=17
cp .build/out/bin/opencv.js .build/out/bin/opencv_js.wasm dist/
