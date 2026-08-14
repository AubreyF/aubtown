#!/usr/bin/env bash
set -euo pipefail
PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

version="1.7.3"
release_base="https://github.com/restatedev/restate/releases/download/v${version}"
install_root="${FREEDWORKS_RESTATE_INSTALL_ROOT:-/opt/freedworks/restate/${version}}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer supports Linux only." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    target="x86_64-unknown-linux-musl"
    server_sha256="7446cb12197a15e2c230cc9df050e40e4cc89499edaead1ff614b55cb9b4a140"
    cli_sha256="5329fca65e1439186b94d796f2d75eeb5dcdd97fe5865cbdb8d0a942519cae09"
    ;;
  aarch64|arm64)
    target="aarch64-unknown-linux-musl"
    server_sha256="ff3ed6682ab3ee2f22431f5d491c18b24fc8f0474d7e492234cfe32cbd48017d"
    cli_sha256="cee45a4e81a8d276b13475f6377250e72c9c6dd3ff6edc95f2fe24775f7a9f6b"
    ;;
  *)
    echo "Unsupported Linux architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT

download_and_verify() {
  local component="$1"
  local expected="$2"
  local archive="${component}-${target}.tar.xz"
  /usr/bin/curl --fail --location --silent --show-error \
    --output "${scratch}/${archive}" "${release_base}/${archive}"
  printf '%s  %s\n' "${expected}" "${scratch}/${archive}" | sha256sum --check --status
  tar -xJf "${scratch}/${archive}" -C "${scratch}"
}

download_and_verify "restate-server" "${server_sha256}"
download_and_verify "restate-cli" "${cli_sha256}"

install -d -m 0755 "${install_root}"
install -m 0755 \
  "${scratch}/restate-server-${target}/restate-server" \
  "${install_root}/restate-server"
install -m 0755 \
  "${scratch}/restate-cli-${target}/restate" \
  "${install_root}/restate"

"${install_root}/restate-server" --version
"${install_root}/restate" --version
