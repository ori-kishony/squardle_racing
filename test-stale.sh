#!/bin/bash
# Deterministic regression: stale date pointer, timeout, and next-day join.
set -euo pipefail
cd "$(dirname "$0")"
node --test test/races.test.js
