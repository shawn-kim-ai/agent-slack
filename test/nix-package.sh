#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

nix_flags=(--extra-experimental-features 'nix-command flakes')
expected_version="$(nix "${nix_flags[@]}" eval --impure --raw --expr '(builtins.fromJSON (builtins.readFile ./nix/sources.json)).version')"
system="$(nix "${nix_flags[@]}" eval --impure --raw --expr 'builtins.currentSystem')"
expected_hash="$(nix "${nix_flags[@]}" eval --impure --raw --expr '(builtins.fromJSON (builtins.readFile ./nix/sources.json)).hashes.${builtins.currentSystem}')"

check_binary() {
  local binary="$1/bin/agent-slack"
  local actual_hash actual_version
  actual_hash="$(nix "${nix_flags[@]}" hash file "$binary")"
  [[ "$actual_hash" == "$expected_hash" ]] || { echo "installed binary differs from release asset" >&2; return 1; }
  actual_version="$("$binary" --version)"
  [[ "$actual_version" == "$expected_version" ]] || { echo "expected $expected_version, got $actual_version" >&2; return 1; }
  printf 'Installed binary matches %s and reports %s\n' "$actual_hash" "$actual_version"
}

output="$(nix "${nix_flags[@]}" build --no-link --print-out-paths)"
check_binary "$output"

if [[ "$system" == *-linux ]]; then
  output_with_strip_hook="$(nix "${nix_flags[@]}" build --impure --no-link --print-out-paths --expr '
    let
      flake = builtins.getFlake (toString ./.);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      (pkgs.callPackage ./nix/package.nix {}).overrideAttrs (old: {
        nativeBuildInputs = (old.nativeBuildInputs or []) ++ [ pkgs.binutils ];
      })
  ')"
  check_binary "$output_with_strip_hook"
fi
