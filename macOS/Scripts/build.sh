#!/bin/zsh

set -euo pipefail

script_dir="${0:A:h}"
macos_root="${script_dir:h}"
project_root="${macos_root:h}"
source_dir="${macos_root}/Sources/NotesApp"
resource_source_dir="${macos_root}/Resources"
app_dir="${project_root}/build/Notes.app"
module_cache="${project_root}/build/ModuleCache"
contents_dir="${app_dir}/Contents"
macos_dir="${contents_dir}/MacOS"
resources_dir="${contents_dir}/Resources"
icon_source="${project_root}/Shared/Resources/NotesIcon.png"

for tool in cargo xcrun sips iconutil codesign; do
  if ! command -v "${tool}" >/dev/null; then
    echo "Missing macOS build tool: ${tool}" >&2
    exit 1
  fi
done

if [[ ! -f "${icon_source}" ]]; then
  echo "Missing app icon: ${icon_source}" >&2
  exit 1
fi

icon_width="$(sips -g pixelWidth "${icon_source}" | awk '/pixelWidth:/ { print $2 }')"
icon_height="$(sips -g pixelHeight "${icon_source}" | awk '/pixelHeight:/ { print $2 }')"
if [[ -z "${icon_width}" || "${icon_width}" != "${icon_height}" ]]; then
  echo "App icon source must be square" >&2
  exit 1
fi

architecture="$(uname -m)"
case "${architecture}" in
  arm64) rust_target="aarch64-apple-darwin" ;;
  x86_64) rust_target="x86_64-apple-darwin" ;;
  *) echo "Unsupported macOS architecture: ${architecture}" >&2; exit 1 ;;
esac

export MACOSX_DEPLOYMENT_TARGET=13.0
cargo build --locked \
  --manifest-path "${project_root}/Cargo.toml" \
  -p notes-core-ffi --release --target "${rust_target}" \
  --target-dir "${project_root}/build/rust"

rm -rf "${app_dir}"
mkdir -p "${macos_dir}" "${resources_dir}" "${module_cache}"
icon_work_dir="$(mktemp -d "${project_root}/build/icon.XXXXXX")"
trap 'rm -rf "${icon_work_dir}"' EXIT
iconset_dir="${icon_work_dir}/Notes.iconset"
mkdir -p "${iconset_dir}"

xcrun swiftc \
  -swift-version 5 \
  -O \
  -target "${architecture}-apple-macosx13.0" \
  -module-cache-path "${module_cache}" \
  -import-objc-header "${project_root}/crates/notes-core-ffi/include/notes_core.h" \
  -framework AppKit \
  -framework Foundation \
  -framework Security \
  -framework SystemConfiguration \
  -liconv \
  "${source_dir}/main.swift" \
  "${project_root}/build/rust/${rust_target}/release/libnotes_core_ffi.a" \
  -o "${macos_dir}/Notes"

cp "${resource_source_dir}/Info.plist" "${contents_dir}/Info.plist"

for size in 16 32 128 256 512; do
  sips -z "${size}" "${size}" "${icon_source}" \
    --out "${iconset_dir}/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "${icon_source}" \
    --out "${iconset_dir}/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "${iconset_dir}" -o "${resources_dir}/Notes.icns"

codesign --force --sign - "${app_dir}"

echo "Built ${app_dir}"
