#!/usr/bin/env bash
set -euo pipefail
export CUDA_VISIBLE_DEVICES=4
export VLLM_CACHE_ROOT=/data/zhaogangyi/qwen36-27b-service/cache/vllm
export VLLM_CONFIG_ROOT=/data/zhaogangyi/qwen36-27b-service/config/vllm
export VLLM_NO_USAGE_STATS=1
exec /data/zhaogangyi/qwen36-27b-service/runtime/venv/bin/vllm serve \
  /data/zhaogangyi/qwen36-27b-service/models/Qwen3.6-27B \
  --served-model-name qwen3.6-27b --host 172.16.200.114 --port 18082 \
  --dtype bfloat16 --language-model-only --max-model-len 262144 \
  --gpu-memory-utilization 0.90 --max-num-seqs 64 --max-num-batched-tokens 32768 \
  --enable-prefix-caching --enable-chunked-prefill --reasoning-parser qwen3 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --speculative-config '{"method":"qwen3_next_mtp","num_speculative_tokens":2}' \
  --generation-config vllm --no-enable-log-requests
