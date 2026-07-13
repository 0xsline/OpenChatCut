// WebGL2 transition runtime — faithful to the source compositor's contract
// (entry.js:53843 vertex-texture-v1 + :54116 TransitionProcessor.renderPass):
// one shared fullscreen quad; fragment shaders receive v_texCoord and the
// uniforms u_outgoing / u_incoming / u_progress (+ u_resolution / u_aspect /
// u_time and per-transition extras). Framework-free; React integration lives
// beside the composition.

// source vertex shader (id "vertex-texture-v1"): positions + texcoords in, no
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

export type UniformValue = number | number[];

export interface GlRuntime {
  canvas: HTMLCanvasElement;
  /** draw one transition frame: mix outgoing→incoming at progress (0..1) */
  render: (
    frag: string,
    outgoing: TexImageSource,
    incoming: TexImageSource,
    progress: number,
    extra?: Record<string, UniformValue>,
  ) => void;
  dispose: () => void;
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
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true });
  if (!gl) throw new Error('WebGL2 not available');

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
  const programs = new Map<string, WebGLProgram>();

  const upload = (tex: WebGLTexture, unit: number, src: TexImageSource) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // DOM sources are top-down
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

  return {
    canvas,
    render(frag, outgoing, incoming, progress, extra) {
      let prog = programs.get(frag);
      if (!prog) {
        prog = link(gl, frag);
        programs.set(frag, prog);
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);

      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const aPos = gl.getAttribLocation(prog, 'a_position');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      const aTex = gl.getAttribLocation(prog, 'a_texCoord');
      gl.enableVertexAttribArray(aTex);
      gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

      upload(texOut, 0, outgoing);
      upload(texIn, 1, incoming);
      const locOut = gl.getUniformLocation(prog, 'u_outgoing');
      if (locOut) gl.uniform1i(locOut, 0);
      const locIn = gl.getUniformLocation(prog, 'u_incoming');
      if (locIn) gl.uniform1i(locIn, 1);

      // source clamps straddle progress to [.005,.995] (entry.js:165834)
      setUniform(prog, 'u_progress', Math.max(0.005, Math.min(0.995, progress)));
      setUniform(prog, 'u_resolution', [canvas.width, canvas.height]);
      setUniform(prog, 'u_aspect', canvas.width / Math.max(1, canvas.height));
      for (const [k, v] of Object.entries(extra ?? {})) setUniform(prog, k, v);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      for (const p of programs.values()) gl.deleteProgram(p);
      programs.clear();
      gl.deleteBuffer(buf);
      gl.deleteTexture(texOut);
      gl.deleteTexture(texIn);
    },
  };
}
