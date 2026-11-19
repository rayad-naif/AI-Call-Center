/* Live listen: plays a call's audio straight from the voice service's WebSocket
   (raw 16-bit little-endian PCM). The audio never passes through our server.
   The format can be switched in the deck if an account streams a
   different rate/channel layout. */
(function () {
  'use strict';
  const FORMATS = {
    '16000x1': { rate: 16000, channels: 1, label: '16 kHz mono' },
    '16000x2': { rate: 16000, channels: 2, label: '16 kHz stereo' },
    '8000x1': { rate: 8000, channels: 1, label: '8 kHz mono' },
    '24000x1': { rate: 24000, channels: 1, label: '24 kHz mono' }
  };
  function savedFormat() { try { return localStorage.getItem('acc.listenFormat') || '16000x1'; } catch (e) { return '16000x1'; } }

  function createListener(url, opts) {
    opts = opts || {};
    let fmt = FORMATS[opts.format || savedFormat()] || FORMATS['16000x1'];
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    let next = 0;
    let closed = false;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        // Some streams announce their format first.
        try {
          const m = JSON.parse(e.data);
          const rate = Number(m.sampleRate || m.sample_rate);
          if (rate) fmt = { rate, channels: Number(m.channels) || fmt.channels };
          if (opts.onEvent) opts.onEvent(m);
        } catch (err) { /* not JSON */ }
        return;
      }
      const pcm = new Int16Array(e.data, 0, Math.floor(e.data.byteLength / 2));
      const frames = Math.floor(pcm.length / fmt.channels);
      if (!frames) return;
      const buf = ctx.createBuffer(fmt.channels, frames, fmt.rate);
      for (let c = 0; c < fmt.channels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < frames; i++) ch[i] = pcm[i * fmt.channels + c] / 32768;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      const now = ctx.currentTime;
      // Keep ~150ms of buffer; resync if we fell behind or drifted too far ahead.
      if (next < now + 0.05 || next > now + 1.0) next = now + 0.15;
      src.start(next);
      next += buf.duration;
    };
    ws.onclose = () => { if (!closed && opts.onClose) opts.onClose(); close(); };
    ws.onerror = () => { if (opts.onError) opts.onError(); };

    function close() {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      ctx.close().catch(() => {});
    }
    if (ctx.state === 'suspended') ctx.resume();
    return { close, setVolume: (v) => { gain.gain.value = v; } };
  }

  window.ACCAudio = { createListener, FORMATS, savedFormat, setFormat: (f) => { try { localStorage.setItem('acc.listenFormat', f); } catch (e) { /* ignore */ } } };
})();
