#!/usr/bin/env bash
# Acceptance 2: the AI stack can never exceed 3.5 CPUs / 6 GB.
# Reads the limits Docker actually applied to the running containers and checks them.
#   scripts/check-limits.sh            # static check of applied limits
#   scripts/check-limits.sh --watch    # + live `docker stats` (run during a load test)
set -euo pipefail
PROJECT=${COMPOSE_PROJECT_NAME:-ai-gateway}
MAX_CPU_NANO=3500000000
MAX_MEM=$((6 * 1024 * 1024 * 1024))
MAX_SWAP=$((7 * 1024 * 1024 * 1024))

ids=$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}")
[ -z "$ids" ] && { echo "no running containers for project ${PROJECT}"; exit 1; }

tot_cpu=0; tot_mem=0; tot_swap=0; fail=0; slice=""
printf '%-28s %6s %9s %9s %6s %s\n' CONTAINER CPUS MEM MEM+SWAP OOMADJ CGROUP_PARENT
for id in $ids; do
  read -r name cpu mem swap oom parent <<<"$(docker inspect -f '{{.Name}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.OomScoreAdj}} {{if .HostConfig.CgroupParent}}{{.HostConfig.CgroupParent}}{{else}}-{{end}}' "$id")"
  printf '%-28s %6s %8sM %8sM %6s %s\n' "${name#/}" "$(awk "BEGIN{print $cpu/1e9}")" $((mem/1048576)) $((swap/1048576)) "$oom" "$parent"
  [ "$cpu" -eq 0 ] && { echo "  !! ${name#/} has NO cpu limit"; fail=1; }
  [ "$mem" -eq 0 ] && { echo "  !! ${name#/} has NO memory limit"; fail=1; }
  [ "$oom" -lt 800 ] && { echo "  !! ${name#/} oom_score_adj < 800"; fail=1; }
  [ "$parent" != "-" ] && slice=$parent
  tot_cpu=$((tot_cpu + cpu)); tot_mem=$((tot_mem + mem)); tot_swap=$((tot_swap + swap))
done
echo "TOTAL cpus=$(awk "BEGIN{print $tot_cpu/1e9}") mem=$((tot_mem/1048576))M mem+swap=$((tot_swap/1048576))M"

if [ -n "$slice" ]; then
  # Override mode: the slice is the hard cap; per-service limits may add up to more.
  quota=$(systemctl show "$slice" -p CPUQuotaPerSecUSec --value 2>/dev/null || true)
  memmax=$(systemctl show "$slice" -p MemoryMax --value 2>/dev/null || true)
  echo "slice $slice: CPUQuotaPerSecUSec=$quota MemoryMax=$memmax"
  [ "$quota" = "3.500000s" ] || { echo "  !! slice CPU quota is not 350%"; fail=1; }
  [ "$memmax" = "$((6*1024*1024*1024))" ] || { echo "  !! slice MemoryMax is not 6G"; fail=1; }
else
  [ "$tot_cpu" -le "$MAX_CPU_NANO" ] || { echo "  !! total CPU above 3.5"; fail=1; }
  [ "$tot_mem" -le "$MAX_MEM" ] || { echo "  !! total memory above 6 GB"; fail=1; }
  [ "$tot_swap" -le "$MAX_SWAP" ] || { echo "  !! total memory+swap above 7 GB"; fail=1; }
fi

[ "$fail" -eq 0 ] && echo "OK: limits in place" || { echo "FAIL"; exit 1; }
if [ "${1:-}" = "--watch" ]; then
  docker stats $ids
fi
