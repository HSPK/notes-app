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

rm -rf "${app_dir}"
mkdir -p "${macos_dir}" "${resources_dir}" "${module_cache}"

architecture="$(uname -m)"
xcrun swiftc \
  -swift-version 5 \
  -O \
  -target "${architecture}-apple-macosx13.0" \
  -module-cache-path "${module_cache}" \
  -framework AppKit \
  -framework Foundation \
  -framework Network \
  -framework SwiftUI \
  "${source_dir}/main.swift" \
  -o "${macos_dir}/Notes"

cp "${resource_source_dir}/Info.plist" "${contents_dir}/Info.plist"

if [[ ! -f "${icon_source}" ]]; then
  echo "Missing app icon: ${icon_source}" >&2
  exit 1
fi

python3 "${script_dir}/make_icns.py" \
  "${icon_source}" \
  "${resources_dir}/Notes.icns"

codesign --force --sign - "${app_dir}"

echo "Built ${app_dir}"
