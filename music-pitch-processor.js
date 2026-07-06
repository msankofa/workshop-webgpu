class MusicPitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'pitchRatio',
      defaultValue: 1,
      minValue: 0.5,
      maxValue: 2,
      automationRate: 'k-rate'
    }];
  }

  constructor() {
    super();
    this.bufferLength = 4096;
    this.minDelay = 192;
    this.delayRange = 1536;
    this.writeIndex = 0;
    this.phase = 0.25;
    this.buffers = [];
  }

  ensureChannels(channelCount) {
    while (this.buffers.length < channelCount) {
      this.buffers.push(new Float32Array(this.bufferLength));
    }
  }

  readInterpolated(buffer, index) {
    const wrapped = ((index % this.bufferLength) + this.bufferLength) % this.bufferLength;
    const first = Math.floor(wrapped);
    const second = (first + 1) % this.bufferLength;
    const mix = wrapped - first;
    return buffer[first] + (buffer[second] - buffer[first]) * mix;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output.length) return true;

    this.ensureChannels(output.length);
    const pitchRatio = Math.max(0.5, Math.min(2, parameters.pitchRatio[0] || 1));
    const bypass = Math.abs(pitchRatio - 1) < 0.0005;
    const frameCount = output[0].length;

    for (let frame = 0; frame < frameCount; frame++) {
      for (let channel = 0; channel < output.length; channel++) {
        const source = input[channel] || input[0];
        this.buffers[channel][this.writeIndex] = source?.[frame] || 0;
      }

      if (bypass) {
        for (let channel = 0; channel < output.length; channel++) {
          output[channel][frame] = (input[channel] || input[0])?.[frame] || 0;
        }
      } else {
        const phaseA = this.phase;
        const phaseB = (phaseA + 0.5) % 1;
        const windowA = 0.5 - 0.5 * Math.cos(Math.PI * 2 * phaseA);
        const windowB = 1 - windowA;
        const delayA = this.minDelay + phaseA * this.delayRange;
        const delayB = this.minDelay + phaseB * this.delayRange;

        for (let channel = 0; channel < output.length; channel++) {
          const buffer = this.buffers[channel];
          const sampleA = this.readInterpolated(buffer, this.writeIndex - delayA);
          const sampleB = this.readInterpolated(buffer, this.writeIndex - delayB);
          output[channel][frame] = sampleA * windowA + sampleB * windowB;
        }

        this.phase += (1 - pitchRatio) / this.delayRange;
        this.phase -= Math.floor(this.phase);
      }

      this.writeIndex = (this.writeIndex + 1) % this.bufferLength;
    }

    return true;
  }
}

registerProcessor('music-pitch-processor', MusicPitchProcessor);
