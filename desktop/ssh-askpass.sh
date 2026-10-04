#!/bin/sh
# OpenSSH calls this helper directly. Never put passwords in argv or files.
case "$1" in
  *[Pp]assword*|*[Pp]assphrase*) /usr/bin/printf '%s\n' "$SPARKDASH_SSH_PASSWORD" ;;
  *) exit 1 ;;
esac
