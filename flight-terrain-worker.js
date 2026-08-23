// flight-terrain-worker.js — generates strips of ground for the scrolling terrain window.
//
// A v5 point costs about 2.4 us, so the first full window (1025^2) is a couple of seconds and even
// a routine strip is a tenth of a second. On the render thread either would be a visible stall, so
// all of it happens here and arrives as a transferred Float32Array.
//
// Protocol, all messages carrying an `id` echoed back so late replies from a superseded plan can be
// dropped rather than written into a window that has since moved:
//   { id, type: 'init', project, seaLevel, heightScale }  -> { id, ok, error? }
//   { id, type: 'spans', post, spans }                    -> { id, ok, data: Float32Array[], ms }
//
// seaLevel and heightScale live in the SOURCE, not at the call site. The main thread also samples
// the generator directly for points outside the window, and if the two applied different transforms
// the ground would step wherever the window's edge happened to be.

import { createV5Source } from './terrain-source-v5.js';
import { fillSpan } from './flight-terrain-stream.js';

let source = null;
let heightAt = null;

self.onmessage = (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') {
      source = createV5Source(e.data.project);
      const sea = e.data.seaLevel || 0;
      const scale = e.data.heightScale ?? 1;
      heightAt = (x, z) => (source.heightAt(x, z) - sea) * scale;
      self.postMessage({ id, ok: true, capabilities: source.descriptor.capabilities });
      return;
    }
    if (type === 'spans') {
      if (!heightAt) throw new Error('worker has no terrain source; send init first');
      const { post, spans } = e.data;
      const t0 = performance.now();
      const data = spans.map((s) => fillSpan(s, post, heightAt));
      self.postMessage({ id, ok: true, data, ms: performance.now() - t0 }, data.map((d) => d.buffer));
      return;
    }
    throw new Error(`unknown message type ${type}`);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
