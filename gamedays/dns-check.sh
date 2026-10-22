#!/usr/bin/env sh
# Does a single-label name that matches no container resolve to an address
# outside Docker? Checks on a fresh normal network and a fresh internal one.
# Prints only a classification, never the address itself.
#
#   sh gamedays/dns-check.sh
set -u
export MSYS_NO_PATHCONV=1

classify() {
  addr=$(printf '%s\n' "$1" | awk '/^Address/ && !/#53/ {print $2}' | head -1)
  if [ -z "$addr" ]; then
    echo "no answer"
  else
    case "$addr" in
      172.*|10.*|192.168.*) echo "private address" ;;
      *) echo "address outside the private ranges" ;;
    esac
  fi
}

docker network create dnscheck-normal > /dev/null
docker network create --internal dnscheck-internal > /dev/null
echo "normal network:   $(classify "$(docker run --rm --network dnscheck-normal alpine:3 nslookup postgres 2>&1)")"
echo "internal network: $(classify "$(docker run --rm --network dnscheck-internal alpine:3 nslookup postgres 2>&1)")"
docker network rm dnscheck-normal dnscheck-internal > /dev/null
