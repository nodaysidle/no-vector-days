/**
 * WebGL Multi-Pass Post-Processing Pipeline
 * Provides hardware-accelerated FBO ping-pong rendering with:
 * - Pass 1: Luminance Threshold & Separable Blur
 * - Pass 2: Bloom Composite, Film/Paper Grain, Chromatic Aberration & Vignette
 */

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Pass 1: Luminance threshold & blur
const PASS1_BLUR_FRAGMENT = `
precision mediump float;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform vec2 u_direction;
uniform float u_threshold;
varying vec2 v_uv;

void main() {
  vec2 texel = 1.0 / u_resolution;
  vec4 color = vec4(0.0);

  // 9-tap gaussian kernel
  float weights[5];
  weights[0] = 0.227027;
  weights[1] = 0.1945946;
  weights[2] = 0.1216216;
  weights[3] = 0.054054;
  weights[4] = 0.016216;

  vec4 center = texture2D(u_image, v_uv);
  float brightness = dot(center.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec4 brightColor = (brightness > u_threshold) ? center : vec4(0.0);

  color += brightColor * weights[0];

  for (int i = 1; i < 5; i++) {
    vec2 offset = u_direction * (float(i) * 1.5) * texel;
    color += texture2D(u_image, v_uv + offset) * weights[i];
    color += texture2D(u_image, v_uv - offset) * weights[i];
  }

  gl_FragColor = color;
}
`;

// Pass 2: Composite pass (Bloom + Film Grain + Chromatic Aberration + Vignette)
const PASS2_COMPOSITE_FRAGMENT = `
precision mediump float;
uniform sampler2D u_original;
uniform sampler2D u_bloom;
uniform vec2 u_resolution;
uniform float u_bloomIntensity;
uniform float u_grainIntensity;
uniform float u_aberration;
uniform float u_vignette;
uniform float u_time;
varying vec2 v_uv;

// Pseudo-random noise generator
float random(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

void main() {
  vec2 uv = v_uv;

  // Chromatic Aberration
  vec2 distFromCenter = uv - 0.5;
  vec2 caOffset = distFromCenter * (u_aberration * 0.015);
  float r = texture2D(u_original, uv - caOffset).r;
  float g = texture2D(u_original, uv).g;
  float b = texture2D(u_original, uv + caOffset).b;
  float a = texture2D(u_original, uv).a;
  vec4 baseColor = vec4(r, g, b, a);

  // Additive Bloom
  vec4 bloom = texture2D(u_bloom, uv);
  vec3 color = baseColor.rgb + (bloom.rgb * u_bloomIntensity);

  // Film / Paper Grain Texture
  float noise = (random(uv * u_resolution + vec2(u_time * 10.0, u_time * 5.0)) - 0.5) * u_grainIntensity;
  color += noise;

  // Radial Vignette
  float dist = length(distFromCenter);
  float vignette = smoothstep(0.8, 0.2, dist * (u_vignette * 1.4));
  color *= mix(1.0, vignette, u_vignette);

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), baseColor.a);
}
`;

export class WebGLShaderPipeline {
  constructor(outputCanvas) {
    this.canvas = outputCanvas;
    this.gl = outputCanvas.getContext('webgl', { premultipliedAlpha: false, alpha: true }) ||
              outputCanvas.getContext('experimental-webgl');
    this.isSupported = Boolean(this.gl);

    this.preset = 'bloom'; // 'none' | 'bloom' | 'paper' | 'cyberpunk' | 'vignette'
    this.params = {
      bloomIntensity: 0.65,
      grainIntensity: 0.04,
      aberration: 0.2,
      vignette: 0.3,
      threshold: 0.4
    };

    if (this.isSupported) {
      try {
        this.initPipeline();
      } catch (err) {
        console.warn(`[webgl-pipeline] disabled, falling back to 2D canvas: ${err.message}`);
        this.isSupported = false;
      }
    }
  }

  setPreset(name) {
    this.preset = name;
    if (name === 'none') {
      this.params.bloomIntensity = 0.0;
      this.params.grainIntensity = 0.0;
      this.params.aberration = 0.0;
      this.params.vignette = 0.0;
    } else if (name === 'bloom') {
      this.params.bloomIntensity = 0.8;
      this.params.grainIntensity = 0.02;
      this.params.aberration = 0.1;
      this.params.vignette = 0.2;
    } else if (name === 'paper') {
      this.params.bloomIntensity = 0.15;
      this.params.grainIntensity = 0.08;
      this.params.aberration = 0.0;
      this.params.vignette = 0.35;
    } else if (name === 'cyberpunk') {
      this.params.bloomIntensity = 1.2;
      this.params.grainIntensity = 0.05;
      this.params.aberration = 0.6;
      this.params.vignette = 0.45;
    } else if (name === 'vignette') {
      this.params.bloomIntensity = 0.2;
      this.params.grainIntensity = 0.02;
      this.params.aberration = 0.05;
      this.params.vignette = 0.7;
    }
  }

  createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failure: ${info}`);
    }
    return shader;
  }

  createProgram(vertSource, fragSource) {
    const gl = this.gl;
    const vs = this.createShader(gl.VERTEX_SHADER, vertSource);
    const fs = this.createShader(gl.FRAGMENT_SHADER, fragSource);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Program link failure: ${info}`);
    }
    return prog;
  }

  createFramebufferTexture(width, height) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex };
  }

  initPipeline() {
    const gl = this.gl;

    // Full-screen quad geometry
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    this.blurProgram = this.createProgram(VERTEX_SHADER_SOURCE, PASS1_BLUR_FRAGMENT);
    this.compositeProgram = this.createProgram(VERTEX_SHADER_SOURCE, PASS2_COMPOSITE_FRAGMENT);

    this.sourceTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.fboH = null;
    this.fboV = null;
  }

  resize(width, height) {
    if (!this.isSupported) return;
    const gl = this.gl;
    this.width = width;
    this.height = height;

    // Allocate half-res FBO for bloom blur performance
    const blurW = Math.max(1, Math.floor(width / 2));
    const blurH = Math.max(1, Math.floor(height / 2));

    this.fboH = this.createFramebufferTexture(blurW, blurH);
    this.fboV = this.createFramebufferTexture(blurW, blurH);
  }

  /**
   * Processes input 2D Canvas and renders through shader passes to destination WebGL canvas.
   */
  process(sourceCanvas2D) {
    if (!this.isSupported) return;
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;

    if (!this.fboH || this.width !== w || this.height !== h) {
      this.resize(w, h);
    }

    // 1. Upload 2D canvas to sourceTexture
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    // Canvas rows run top-down but GL texture v runs bottom-up; without the flip the overlay is mirrored.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas2D);

    const blurW = Math.max(1, Math.floor(w / 2));
    const blurH = Math.max(1, Math.floor(h / 2));

    // PASS 1A: Horizontal Blur into fboH
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH.fb);
    gl.viewport(0, 0, blurW, blurH);
    gl.useProgram(this.blurProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const posLoc1 = gl.getAttribLocation(this.blurProgram, 'a_position');
    gl.enableVertexAttribArray(posLoc1);
    gl.vertexAttribPointer(posLoc1, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(gl.getUniformLocation(this.blurProgram, 'u_image'), 0);
    gl.uniform2f(gl.getUniformLocation(this.blurProgram, 'u_resolution'), blurW, blurH);
    gl.uniform2f(gl.getUniformLocation(this.blurProgram, 'u_direction'), 1.0, 0.0);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, 'u_threshold'), this.params.threshold);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // PASS 1B: Vertical Blur into fboV
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboV.fb);
    gl.bindTexture(gl.TEXTURE_2D, this.fboH.tex);
    gl.uniform2f(gl.getUniformLocation(this.blurProgram, 'u_direction'), 0.0, 1.0);
    gl.uniform1f(gl.getUniformLocation(this.blurProgram, 'u_threshold'), 0.0); // Already thresholded

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // PASS 2: Composite & Tone-map onto Screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.compositeProgram);

    const posLoc2 = gl.getAttribLocation(this.compositeProgram, 'a_position');
    gl.enableVertexAttribArray(posLoc2);
    gl.vertexAttribPointer(posLoc2, 2, gl.FLOAT, false, 0, 0);

    // Texture Unit 0: Original crisp 2D render
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'u_original'), 0);

    // Texture Unit 1: Bloom blurred buffer
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fboV.tex);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'u_bloom'), 1);

    // Uniform Parameters
    gl.uniform2f(gl.getUniformLocation(this.compositeProgram, 'u_resolution'), w, h);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'u_bloomIntensity'), this.params.bloomIntensity);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'u_grainIntensity'), this.params.grainIntensity);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'u_aberration'), this.params.aberration);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'u_vignette'), this.params.vignette);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'u_time'), (performance.now() * 0.001) % 1000);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
