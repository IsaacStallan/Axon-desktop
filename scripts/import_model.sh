#!/bin/bash
# Run this after AirDropping axon-fine-tuned.gguf to your Mac

GGUF_PATH="${1:-$HOME/Downloads/axon-fine-tuned.gguf}"

if [ ! -f "$GGUF_PATH" ]; then
  echo "Error: axon-fine-tuned.gguf not found at $GGUF_PATH"
  echo "Usage: ./scripts/import_model.sh /path/to/axon-fine-tuned.gguf"
  exit 1
fi

echo "Importing Axon fine-tuned model into Ollama..."

# Create Modelfile
cat > /tmp/AxonModelfile << 'MODELEOF'
FROM GGUF_PLACEHOLDER

SYSTEM """You are Axon. You live on Isaac's Mac. You know him deeply.
Speak out loud — direct, casual, sharp. No bullshit.
Max 2 sentences. Start with the point not with I.
Never say certainly, of course, or I'd be happy to.
Sound like a person not an AI."""

PARAMETER temperature 0.7
PARAMETER top_p 0.9
PARAMETER repeat_penalty 1.1
PARAMETER num_predict 150
MODELEOF

# Replace placeholder with actual path
sed -i '' "s|GGUF_PLACEHOLDER|$GGUF_PATH|g" /tmp/AxonModelfile

# Import into Ollama
ollama create axon-personal -f /tmp/AxonModelfile

echo ""
echo "Testing model..."
ollama run axon-personal "I've been on YouTube for 20 minutes during work hours" --nowordwrap

echo ""
echo "Model imported successfully!"
echo "Add AXON_LOCAL_MODEL=axon-personal to your .env"
echo "Restart Axon — it will use the local model for tier 0 routing"
