/// <reference lib="dom" />

// WebGL2 transition runtime — the compositor contract:
// one shared fullscreen quad; fragment shaders receive v_texCoord and the
// uniforms u_outgoing / u_incoming / u_progress (+ u_resolution / u_aspect /
// u_time and per-transition extras). Framework-free; React integration lives
// beside the composition.

// vertex-texture-v1 accepts positions and texture coordinates with no
// per-transition vertex work — everything happens in the fragment shader.
const VERTEX_300 = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); v_texCoord = a_texCoord; }`;

// GLSL ES 1.0 fallback for generated/user shaders that omit #version 300 es
const VERTEX_100 = `attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); v_texCoord = a_texCoord; }`;

import { GL_COLOR_PIPELINE } from './colorPipeline.js';
import type { CubeLut } from './fx/cube.js';
import { SOURCE_OPACITY_FRAG } from './sourceOpacity.js';
import type { FxPass, GlRuntime, UniformValue } from './runtimeTypes.js';
export type { FxPass, GlRuntime, UniformValue } from './runtimeTypes.js';

let activeGlRuntimes = 0;

/** Existing WebGL runtimes only; querying this never creates a context. */
export function activeGlRuntimeCount(): number {
  return activeGlRuntimes;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? 'unknown error';
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, frag: string): WebGLProgram {
  // pair the vertex shader to the fragment's GLSL version
  const is300 = /^\s*#version\s+300\s+es/.test(frag);
  const vs = compile(gl, gl.VERTEX_SHADER, is300 ? VERTEX_300 : VERTEX_100);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? 'unknown error';
    gl.deleteProgram(prog);
    throw new Error(`program link failed: ${log}`);
  }
  return prog;
}

function makeTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

/** create a runtime bound to (and sized like) the given canvas */
export function createGlRuntime(canvas: HTMLCanvasElement): GlRuntime {
  // preserveDrawingBuffer: thumb previews copy via drawImage right after draw;
  // without it some GPUs present+clear before the 2D readback lands.
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 not available');
  const colorManagedGl = gl as WebGL2RenderingContext & {
    drawingBufferColorSpace?: PredefinedColorSpace;
    unpackColorSpace?: PredefinedColorSpace;
  };
  if ('drawingBufferColorSpace' in colorManagedGl) colorManagedGl.drawingBufferColorSpace = GL_COLOR_PIPELINE.framebuffer;
  if ('unpackColorSpace' in colorManagedGl) colorManagedGl.unpackColorSpace = GL_COLOR_PIPELINE.texture;

  // fullscreen quad as a triangle strip: interleaved [posX posY | u v]
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 0, 0,
     1, -1, 1, 0,
    -1,  1, 0, 1,
     1,  1, 1, 1,
  ]), gl.STATIC_DRAW);

  const texOut = makeTexture(gl);
  const texIn = makeTexture(gl);
  const texFx = makeTexture(gl);
  const programs = new Map<string, WebGLProgram>();

  // One retained output per intermediate pass. ASCII rain needs its sharp base
  // and blurred branch at the same time, so two ping-pong textures are not enough.
  const fbos: { fb: WebGLFramebuffer; tex: WebGLTexture }[] = [];
  const ensureFbos = (count: number) => {
    const make = () => {
      const tex = makeTexture(gl);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      if (!fb) throw new Error('createFramebuffer failed');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fb, tex };
    };
    while (fbos.length < count) fbos.push(make());
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbos;
  };

  const getProgram = (frag: string): WebGLProgram => {
    let prog = programs.get(frag);
    if (!prog) { prog = link(gl, frag); programs.set(frag, prog); }
    return prog;
  };

  const bindQuad = (prog: WebGLProgram) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const aPos = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    const aTex = gl.getAttribLocation(prog, 'a_texCoord');
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);
  };

  const upload = (tex: WebGLTexture, unit: number, src: TexImageSource) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // DOM sources are top-down
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  };

  const setUniform = (prog: WebGLProgram, name: string, v: UniformValue) => {
    const loc = gl.getUniformLocation(prog, name);
    if (!loc) return; // shader doesn't use it — fine
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
    else if (v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
  };

  // ── 3D LUT texture (source $Ne/uJ): with OES_texture_float_linear using RGB32F+FLOAT,
  // Otherwise, return to RGB8(float→u8);UNPACK_ALIGNMENT=1(33 lines of RGB are not 4 aligned),LINEAR,
  // Three-axis CLAMP_TO_EDGE. Cache according to data identity; bind 1³ black dummy when there is no data, guaranteed to be declared
  // The program of sampler3D always has independent units to point to (when intensity=0, mix does not take the black value).
  const floatLinear = !!gl.getExtension('OES_texture_float_linear');
  const lutTextures = new Map<Float32Array, WebGLTexture>();
  let dummyLut: WebGLTexture | null = null;

  const uploadLut3d = (size: number, data: Float32Array): WebGLTexture => {
    const tex = gl.createTexture();
    if (!tex) throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // FLIP_Y/PREMULTIPLY is a sticky global state (set to true for 2D source upload), and WebGL2 is
    // texImage3D with FLIP_Y directly INVALID_OPERATION → the upload fails silently and the sampling is always black.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (floatLinear) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    } else {
      const u8 = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        u8[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
      }
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, u8);
    }
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return tex;
  };

  const getLutTexture = (lut?: CubeLut): WebGLTexture => {
    if (!lut) {
      if (!dummyLut) dummyLut = uploadLut3d(2, new Float32Array(2 * 2 * 2 * 3));
      return dummyLut;
    }
    let tex = lutTextures.get(lut.data);
    if (!tex) { tex = uploadLut3d(lut.size, lut.data); lutTextures.set(lut.data, tex); }
    return tex;
  };

  /** If the program declares u_lut, bind it to `unit` and return unit+1; otherwise, return it unchanged.*/
  const bindLutIfUsed = (prog: WebGLProgram, unit: number, lut?: CubeLut): number => {
    const loc = gl.getUniformLocation(prog, 'u_lut');
    if (!loc) return unit;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_3D, getLutTexture(lut));
    gl.uniform1i(loc, unit);
    return unit + 1;
  };

  const drawTransitionFromTextures = (
    frag: string,
    outgoing: WebGLTexture,
    incoming: WebGLTexture,
    progress: number,
    extra?: Record<string, UniformValue>,
  ) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const prog = getProgram(frag);
    gl.useProgram(prog);
    bindQuad(prog);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, outgoing);
    const locOut = gl.getUniformLocation(prog, 'u_outgoing');
    if (locOut) gl.uniform1i(locOut, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, incoming);
    const locIn = gl.getUniformLocation(prog, 'u_incoming');
    if (locIn) gl.uniform1i(locIn, 1);

    // Preserve exact 0/1 endpoints so the neighboring ordinary frames cannot snap.
    setUniform(prog, 'u_progress', Math.max(0, Math.min(1, progress)));
    setUniform(prog, 'u_resolution', [canvas.width, canvas.height]);
    setUniform(prog, 'u_aspect', canvas.width / Math.max(1, canvas.height));
    for (const [key, value] of Object.entries(extra ?? {})) setUniform(prog, key, value);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const renderFxPassesToTexture = (
    passes: FxPass[],
    source: WebGLTexture,
    offset: number,
  ): WebGLTexture => {
    if (passes.length === 0) return source;
    const targets = ensureFbos(offset + passes.length);
    for (let index = 0; index < passes.length; index++) {
      const pass = passes[index];
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[offset + index].fb);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const prog = getProgram(pass.frag);
      gl.useProgram(prog);
      bindQuad(prog);

      const inputFrom = pass.inputFrom ?? index - 1;
      const inputTexture = index === 0 ? source : targets[offset + inputFrom]?.tex;
      if (!inputTexture) throw new Error(`invalid FX input pass ${inputFrom} at ${index}`);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTexture);
      const locIn = gl.getUniformLocation(prog, 'u_input');
      if (locIn) gl.uniform1i(locIn, 0);

      let unit = 1;
      for (const [name, passIndex] of Object.entries(pass.samplers ?? {})) {
        const texture = targets[offset + passIndex]?.tex;
        if (!texture || passIndex >= index) {
          throw new Error(`invalid FX sampler ${name}=${passIndex} at ${index}`);
        }
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        const location = gl.getUniformLocation(prog, name);
        if (location) gl.uniform1i(location, unit);
        unit += 1;
      }
      bindLutIfUsed(prog, unit, pass.lut3d);
      setUniform(prog, 'u_width', canvas.width);
      setUniform(prog, 'u_height', canvas.height);
      setUniform(prog, 'u_canvas_width', canvas.width);
      setUniform(prog, 'u_canvas_height', canvas.height);
      setUniform(prog, 'u_resolution', [canvas.width, canvas.height]);
      setUniform(prog, 'u_aspect', canvas.width / Math.max(1, canvas.height));
      for (const [key, value] of Object.entries(pass.uniforms ?? {})) setUniform(prog, key, value);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    return targets[offset + passes.length - 1].tex;
  };

  const applySourceOpacity = (
    source: WebGLTexture,
    targetIndex: number,
    opacity: number,
  ): WebGLTexture => {
    const target = ensureFbos(targetIndex + 1)[targetIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const prog = getProgram(SOURCE_OPACITY_FRAG);
    gl.useProgram(prog);
    bindQuad(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    const locIn = gl.getUniformLocation(prog, 'u_input');
    if (locIn) gl.uniform1i(locIn, 0);
    setUniform(prog, 'u_opacity', Math.max(0, Math.min(1, opacity)));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return target.tex;
  };

  let disposed = false;
  activeGlRuntimes += 1;
  const assertContextAvailable = () => {
    if (disposed || gl.isContextLost()) throw new Error('WebGL context lost');
  };

  return {
    canvas,
    render(frag, outgoing, incoming, progress, extra) {
      assertContextAvailable();
      upload(texOut, 0, outgoing);
      upload(texIn, 1, incoming);
      drawTransitionFromTextures(frag, texOut, texIn, progress, extra);
    },
    renderTransitionWithFx(
      frag,
      outgoing,
      incoming,
      outgoingPasses,
      incomingPasses,
      progress,
      extra,
      sourceOpacity,
    ) {
      assertContextAvailable();
      upload(texOut, 0, outgoing);
      upload(texIn, 1, incoming);
      const filteredOutgoing = renderFxPassesToTexture(outgoingPasses, texOut, 0);
      const filteredIncoming = renderFxPassesToTexture(
        incomingPasses,
        texIn,
        outgoingPasses.length,
      );
      const opacityOffset = outgoingPasses.length + incomingPasses.length;
      const compositedOutgoing = applySourceOpacity(
        filteredOutgoing,
        opacityOffset,
        sourceOpacity?.outgoing ?? 1,
      );
      const compositedIncoming = applySourceOpacity(
        filteredIncoming,
        opacityOffset + 1,
        sourceOpacity?.incoming ?? 1,
      );
      drawTransitionFromTextures(
        frag,
        compositedOutgoing,
        compositedIncoming,
        progress,
        extra,
      );
    },
    renderFx(frag, input, extra, lut3d) {
      assertContextAvailable();
      const prog = getProgram(frag);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      bindQuad(prog);

      upload(texFx, 0, input);
      const locIn = gl.getUniformLocation(prog, 'u_input');
      if (locIn) gl.uniform1i(locIn, 0);
      bindLutIfUsed(prog, 1, lut3d);

      setUniform(prog, 'u_width', canvas.width);
      setUniform(prog, 'u_height', canvas.height);
      setUniform(prog, 'u_canvas_width', canvas.width);
      setUniform(prog, 'u_canvas_height', canvas.height);
      setUniform(prog, 'u_resolution', [canvas.width, canvas.height]);
      setUniform(prog, 'u_aspect', canvas.width / Math.max(1, canvas.height));
      for (const [k, v] of Object.entries(extra ?? {})) setUniform(prog, k, v);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    renderFxChain(passes, input) {
      assertContextAvailable();
      if (passes.length === 0) return;
      const rt = ensureFbos(Math.max(0, passes.length - 1));
      // upload the source once (flip: DOM sources are top-down)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texFx);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
      for (let i = 0; i < passes.length; i++) {
        const last = i === passes.length - 1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, last ? null : rt[i].fb);
        gl.viewport(0, 0, canvas.width, canvas.height);
        const prog = getProgram(passes[i].frag);
        gl.useProgram(prog);
        bindQuad(prog);
        // Intermediate FBO textures are already GL-oriented — bind without re-upload/flip.
        const inputFrom = passes[i].inputFrom ?? i - 1;
        const inputTex = i === 0 ? texFx : rt[inputFrom]?.tex;
        if (!inputTex) throw new Error(`invalid FX input pass ${inputFrom} at ${i}`);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        const locIn = gl.getUniformLocation(prog, 'u_input');
        if (locIn) gl.uniform1i(locIn, 0);
        let unit = 1;
        for (const [name, passIndex] of Object.entries(passes[i].samplers ?? {})) {
          const tex = rt[passIndex]?.tex;
          if (!tex || passIndex >= i) throw new Error(`invalid FX sampler ${name}=${passIndex} at ${i}`);
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          const loc = gl.getUniformLocation(prog, name);
          if (loc) gl.uniform1i(loc, unit);
          unit++;
        }
        unit = bindLutIfUsed(prog, unit, passes[i].lut3d);
        setUniform(prog, 'u_width', canvas.width);
        setUniform(prog, 'u_height', canvas.height);
        setUniform(prog, 'u_canvas_width', canvas.width);
        setUniform(prog, 'u_canvas_height', canvas.height);
        setUniform(prog, 'u_resolution', [canvas.width, canvas.height]);
        setUniform(prog, 'u_aspect', canvas.width / Math.max(1, canvas.height));
        for (const [k, v] of Object.entries(passes[i].uniforms ?? {})) setUniform(prog, k, v);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); // restore for later single-pass draws
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeGlRuntimes = Math.max(0, activeGlRuntimes - 1);
      for (const p of programs.values()) gl.deleteProgram(p);
      programs.clear();
      gl.deleteBuffer(buf);
      gl.deleteTexture(texOut);
      gl.deleteTexture(texIn);
      gl.deleteTexture(texFx);
      for (const t of lutTextures.values()) gl.deleteTexture(t);
      lutTextures.clear();
      if (dummyLut) { gl.deleteTexture(dummyLut); dummyLut = null; }
      for (const { fb, tex } of fbos) { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); }
    },
  };
}
