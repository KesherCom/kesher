#!/bin/sh
# Builds kesher-node and packs dist/node/kesher-node_<version>_<arch>.deb
# plus a .tar.gz. Runs inside deploy/node/Dockerfile (see `make node-deb`).
#
#   build.sh [arm64|amd64]
#   KESHER_VERSION=0.8.0 build.sh arm64     # release builds (CI)
set -eu

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64) TARGET=aarch64-unknown-linux-gnu ;;
  amd64) TARGET=x86_64-unknown-linux-gnu ;;
  *) echo "unknown arch $ARCH (arm64|amd64)" >&2; exit 2 ;;
esac

CRATE_VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' crates/kesher-node/Cargo.toml | head -n 1)"
# Release builds pass the tag version; local builds sort below any release.
VERSION="${KESHER_VERSION:-${CRATE_VERSION}~dev}"
VERSION="${VERSION#v}"
export KESHER_VERSION="$VERSION"

TARGET_DIR="${CARGO_TARGET_DIR:-target}"
cargo build --release --locked -p kesher-node --target "$TARGET"
BIN="$TARGET_DIR/$TARGET/release/kesher-node"

OUT=dist/node
NAME="kesher-node_${VERSION}_${ARCH}"
PKG="$(mktemp -d)/$NAME"
mkdir -p "$OUT" \
  "$PKG/DEBIAN" "$PKG/usr/bin" "$PKG/lib/systemd/system" "$PKG/etc/kesher" \
  "$PKG/usr/lib/kesher-node" "$PKG/usr/share/doc/kesher-node"

install -m 0755 "$BIN" "$PKG/usr/bin/kesher-node"
install -m 0644 deploy/node/kesher-node.service "$PKG/lib/systemd/system/kesher-node.service"
install -m 0755 deploy/node/tune.sh "$PKG/usr/lib/kesher-node/tune.sh"
install -m 0644 deploy/node/node.toml.example "$PKG/etc/kesher/node.toml"
install -m 0644 deploy/node/node.toml.example "$PKG/usr/share/doc/kesher-node/node.toml.example"
for f in postinst prerm postrm; do
  install -m 0755 "deploy/node/debian/$f" "$PKG/DEBIAN/$f"
done
install -m 0644 deploy/node/debian/conffiles "$PKG/DEBIAN/conffiles"
SIZE_KB="$(du -sk "$PKG" | cut -f1)"
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" -e "s/@SIZE@/$SIZE_KB/" \
  deploy/node/debian/control > "$PKG/DEBIAN/control"

dpkg-deb --root-owner-group --build "$PKG" "$OUT/$NAME.deb"

# Plain archive for systems without dpkg.
TAR_DIR="$(mktemp -d)/kesher-node-linux-$ARCH"
mkdir -p "$TAR_DIR"
cp "$BIN" deploy/node/kesher-node.service deploy/node/tune.sh deploy/node/node.toml.example "$TAR_DIR/"
tar -czf "$OUT/kesher-node-linux-$ARCH.tar.gz" -C "$(dirname "$TAR_DIR")" "kesher-node-linux-$ARCH"

echo "built $OUT/$NAME.deb and $OUT/kesher-node-linux-$ARCH.tar.gz"
