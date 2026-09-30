#!/usr/bin/env bash
# Acceptance 3: simulated memory pressure → the AI container is killed/restarted, MySQL untouched.
# Allocates more RAM than the speech container's limit INSIDE that container. The kernel's
# cgroup OOM killer must kill it (not MySQL/PHP), and Docker must restart it.
# Safe: the allocation is confined by the container's own mem_limit (1 GB).
set -euo pipefail
PROJECT=${COMPOSE_PROJECT_NAME:-ai-gateway}
SVC=${1:-speech}
cid=$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=${SVC}" | head -1)
[ -z "$cid" ] && { echo "$SVC not running"; exit 1; }

mysql_pid_before=$(pgrep -o -x mysqld || pgrep -o -x mariadbd || echo none)
fpm_before=$(pgrep -c -f php-fpm || echo 0)
restarts_before=$(docker inspect -f '{{.RestartCount}}' "$cid")
echo "mysqld pid=$mysql_pid_before php-fpm procs=$fpm_before $SVC restarts=$restarts_before"

echo "allocating 3 GB inside $SVC (limit 1 GB)…"
set +e
docker exec "$cid" python -c "b=[bytearray(64*1024*1024) for _ in range(48)]; print('not killed?!')"
code=$?
set -e
# 137 = SIGKILL from the cgroup OOM killer. The kernel kills the biggest process *inside the
# AI container's cgroup* (here the allocator, or the service itself → Docker restarts it).
if [ "$code" -eq 137 ]; then echo "OK: allocation OOM-killed inside $SVC (exit 137)"; else echo "FAIL: exit $code — memory limit not enforced?"; exit 1; fi

sleep 8
oom=$(docker inspect -f '{{.State.OOMKilled}}' "$cid" 2>/dev/null || echo "?")
restarts_after=$(docker inspect -f '{{.RestartCount}}' "$cid")
state=$(docker inspect -f '{{.State.Status}}' "$cid")
mysql_pid_after=$(pgrep -o -x mysqld || pgrep -o -x mariadbd || echo none)
fpm_after=$(pgrep -c -f php-fpm || echo 0)
echo "after: $SVC state=$state restarts=$restarts_after oomkilled=$oom; mysqld pid=$mysql_pid_after php-fpm procs=$fpm_after"
dmesg 2>/dev/null | grep -i "memory cgroup out of memory" | tail -2 || true

[ "$mysql_pid_before" = "$mysql_pid_after" ] && echo "OK: MySQL untouched" || { echo "FAIL: MySQL pid changed"; exit 1; }
[ "$state" = "running" ] && echo "OK: $SVC running again" || { echo "FAIL: $SVC not running"; exit 1; }
