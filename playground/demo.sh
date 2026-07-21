#!/usr/bin/env bash

set -euo pipefail

name="kiron-light"
echo "hello\t${name}"
printf "line one\nline two\n"

if command -v node >/dev/null 2>&1; then
  echo "node is available"
fi
