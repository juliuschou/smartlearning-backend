#!/bin/sh
set -eu
umask 077
src=/host-secrets
out=/run/gate3-secrets
for name in database_url cookie_secret login_rate_limit_key_secret; do
  test -s "$src/$name"
done
rm -f "$out"/*
chown 999:999 "$out"
chmod 0750 "$out"
for name in database_url cookie_secret login_rate_limit_key_secret; do
  cp "$src/$name" "$out/$name"
  chown 999:999 "$out/$name"
  chmod 0400 "$out/$name"
done
touch "$out/.ready"
chown 999:999 "$out/.ready"
chmod 0400 "$out/.ready"
