#!/bin/bash
# Optional. Run this on the Mac that hosts Bops (Studio 3), not on another machine.
# Installs whisper.cpp and a small English model. Bops does not require it.
# Live voice stays off. The call button keeps its banner.
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required. Install it on this Mac, then run this script again." >&2
  exit 1
fi

brew install whisper-cpp

prefix="$(brew --prefix whisper-cpp)"
bin=""
for name in whisper-cli whisper-cpp main; do
  if [ -x "$prefix/bin/$name" ]; then
    bin="$prefix/bin/$name"
    break
  fi
done
if [ -z "$bin" ]; then
  echo "whisper.cpp installed, but no whisper-cli binary was found under $prefix/bin." >&2
  exit 1
fi

model_dir="${HOME}/bops/.data/whisper"
mkdir -p "$model_dir"
model="$model_dir/ggml-small.bin"
if [ ! -f "$model" ]; then
  curl -L --fail -o "$model" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
fi

server=""
if [ -x "$prefix/bin/whisper-server" ]; then
  server="$prefix/bin/whisper-server"
fi

echo
echo "Add these lines to .env.local on this Mac, then restart Bops:"
echo "BOPS_WHISPER_BIN=$bin"
echo "BOPS_WHISPER_MODEL=$model"
if [ -n "$server" ]; then
  echo
  echo "Or run a local server (leave it running) and set the URL instead:"
  echo "$server -m $model --host 127.0.0.1 --port 8178"
  echo "BOPS_LLM_TRANSCRIBE_URL=http://127.0.0.1:8178/inference"
fi
echo
echo "Audio stays on this Mac. OpenAI live voice is not used."
