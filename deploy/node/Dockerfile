# Build environment for kesher-node: Debian bookworm, so the binary runs on
# Raspberry Pi OS bookworm and newer (glibc 2.36). Cross-compiles for arm64
# (all 64-bit Pis: 3, 4, 5, Zero 2 W, CM) and builds amd64 natively.
#
#   make node-deb                      # arm64 .deb into dist/node/
#   make node-deb NODE_ARCH=amd64      # x86 Linux boxes
#
# Used by CI as well (.github/workflows), so local and release builds match.
FROM rust:1-bookworm

RUN dpkg --add-architecture arm64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      gcc-aarch64-linux-gnu libc6-dev-arm64-cross pkg-config dpkg-dev \
      libasound2-dev libopus-dev \
      libasound2-dev:arm64 libopus-dev:arm64 \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add aarch64-unknown-linux-gnu

ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    PKG_CONFIG_PATH_aarch64_unknown_linux_gnu=/usr/lib/aarch64-linux-gnu/pkgconfig \
    PKG_CONFIG_ALLOW_CROSS_aarch64_unknown_linux_gnu=1 \
    CARGO_TARGET_DIR=/target

WORKDIR /src
ENTRYPOINT ["/bin/sh", "deploy/node/build.sh"]
