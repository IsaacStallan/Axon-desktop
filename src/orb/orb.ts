// `export {}` makes this file a module, which is required for
// `declare global` augmentations to be legal in TypeScript.
export {};

declare global {
  interface Window {
    axon: {
      onStateChange:  (cb: (state: string) => void) => void;
      onMessage:      (cb: (msg: string) => void) => void;
      tapOrb:         () => void;
      ready:          () => void;
      onMicStart:     (cb: () => void) => void;
      onMicStop:      (cb: () => void) => void;
      sendMicChunk:   (chunk: Uint8Array) => void;
      sendMicError:   (msg: string) => void;
      sendMicReady:   () => void;
    };
  }
}

const core = document.getElementById('core')!;

// ── Tap handler ──────────────────────────────────────────────────────────────
core.addEventListener('click', () => {
  window.axon.tapOrb();
});

// ── State changes from main process ─────────────────────────────────────────
window.axon.onStateChange((state: string) => {
  document.body.className = state;
});

// ── Signal renderer is ready ─────────────────────────────────────────────────
window.axon.ready();

// ── Microphone capture (macOS IPC path) ──────────────────────────────────────
// The main process sends 'mic:start' when it wants PCM audio.  We capture via
// getUserMedia (which correctly triggers the macOS permission prompt), convert
// float32 samples to int16, and stream raw PCM16 LE chunks back via IPC.

let micStream:      MediaStream | null = null;
let micContext:     AudioContext | null = null;
let micProcessor:   ScriptProcessorNode | null = null;
let micChunkCount = 0;

window.axon.onMicStart(async () => {
  console.log('[Orb] mic:start received, requesting getUserMedia...');
  try {
    micStream  = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,   // remove Axon's own TTS from the mic signal
        noiseSuppression: true,   // reduce ambient noise / background audio
        autoGainControl:  false,  // keep levels consistent for our RMS gate
        channelCount:     1,
      },
      video: false,
    });
    console.log('[Orb] getUserMedia granted');
    micContext = new AudioContext({ sampleRate: 24000 });
    // Chromium suspends AudioContext when there is no prior user gesture.
    // Resume explicitly so onaudioprocess fires immediately.
    await micContext.resume();
    console.log('[Orb] AudioContext state:', micContext.state);
    const source = micContext.createMediaStreamSource(micStream);
    // 4096-sample buffer ≈ 170 ms at 24 kHz — reasonable latency/throughput trade-off
    micProcessor = micContext.createScriptProcessor(4096, 1, 1);

    micChunkCount = 0;
    micProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16   = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        // Apply 0.5 gain reduction to match SoX 'vol 0.5' used on Windows
        const s = float32[i] * 0.5;
        int16[i] = Math.max(-32768, Math.min(32767, s * 32768));
      }
      const chunk = new Uint8Array(int16.buffer);
      if (micChunkCount === 0 || micChunkCount % 50 === 0) {
        console.log('[Orb] sendMicChunk #' + micChunkCount + ', bytes:', chunk.byteLength);
      }
      micChunkCount++;
      window.axon.sendMicChunk(chunk);
    };

    source.connect(micProcessor);
    micProcessor.connect(micContext.destination);
  } catch (err) {
    console.error('[Orb] getUserMedia failed:', err);
    window.axon.sendMicError(String(err));
  }
});

window.axon.onMicStop(() => {
  micProcessor?.disconnect();
  micProcessor = null;
  micContext?.close();
  micContext = null;
  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;
});

// Signal to main that both mic handlers are registered and ready to receive
// mic:start.  Main will not send mic:start until this message arrives.
console.log('[Orb] sending mic:ready');
window.axon.sendMicReady();
