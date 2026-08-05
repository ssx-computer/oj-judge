# Sandbox image for C/C++ judging.
#
# Security invariants (network isolation, privileges, resources) are enforced
# by the `docker run` flags in scripts/judge.sh — NOT by this image. This image
# only needs to provide the compiler toolchain plus GNU time for per-case peak
# RSS measurement.
#
# Built once by the judge workflow (see .github/workflows/judge.yml, step
# "Load or build sandbox image") and shipped to the repo as compressed split
# archives under docker-image/ so judging never has to pull from Docker Hub.

FROM debian:bookworm-slim

# C/C++ toolchain + GNU time (/usr/bin/time, not the bash builtin).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        make \
        time \
    && rm -rf /var/lib/apt/lists/*

# Guard: fail the build early if GNU time is missing (plain `time` is a bash
# builtin and does NOT provide the -v RSS reporting flag).
RUN /usr/bin/time --version >/dev/null 2>&1 || { echo "GNU time (package 'time') missing" >&2; exit 1; }
