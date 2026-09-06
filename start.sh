#!/bin/bash
# HyeHost 128MB — matikan core dump biar nggak 1GB tiap hari
ulimit -c 0 2>/dev/null
echo 0 > /proc/sys/kernel/core_uses_pid 2>/dev/null || true
rm -f core core.* 2>/dev/null
echo "[start] core dump disabled, cleanup done"
exec bun run src/index.ts
