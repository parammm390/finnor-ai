"use client"

/*
 * WebGL structure adapted from Rare UI's Fluid Orb (Swami Malode, 2026).
 * Palette and glass direction are customized from the blueDrop configuration
 * supplied for LerSent001's MIT Liquid Orb. See THIRD_PARTY_NOTICES.md.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react"
export type OrbState = "breathing" | "searching" | "solving" | "listening" | "connecting" | "weaving" | "composing" | "working" | "shaping"

const VERTEX = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_energy;
uniform vec3 u_color_a;
uniform vec3 u_color_b;
uniform vec3 u_color_c;

#define PI 3.14159265359

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.54;
  mat2 rotation = mat2(0.84, -0.54, 0.54, 0.84);
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p);
    p = rotation * p * 2.03 + 0.17;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 point = uv - 0.5;
  point.x *= u_resolution.x / max(u_resolution.y, 1.0);
  float time = u_time;

  vec2 drift = vec2(
    sin(time * 0.37) + 0.42 * sin(time * 0.83 + 1.7),
    cos(time * 0.31) + 0.38 * cos(time * 0.71 + 2.3)
  );
  vec2 domain = point * (3.25 + u_energy * 0.45) + drift * 0.34;
  vec2 warp = vec2(
    fbm(domain + vec2(time * 0.16, -time * 0.09)),
    fbm(domain + vec2(4.2, 1.7) - vec2(time * 0.11, time * 0.14))
  );
  float field = fbm(domain + (1.35 + u_energy * 0.4) * warp);

  float angle = atan(point.y, point.x);
  float contour = 0.405
    + (field - 0.5) * (0.055 + u_energy * 0.022)
    + sin(angle * 3.0 + time * 0.45) * 0.008
    + sin(angle * 5.0 - time * 0.28) * 0.005;
  float distanceToCenter = length(point);
  float edge = smoothstep(contour + 0.012, contour - 0.008, distanceToCenter);
  float inner = clamp(1.0 - distanceToCenter / max(contour, 0.001), 0.0, 1.0);

  float swirl = fbm(domain * 1.42 + warp * 1.8 + time * 0.08);
  vec3 color = mix(u_color_a, u_color_b, smoothstep(0.12, 0.62, field));
  color = mix(color, u_color_c, smoothstep(0.46, 0.96, swirl) * (0.56 + u_energy * 0.18));
  color *= 0.72 + inner * 0.55;

  vec2 lightPosition = vec2(-0.18, 0.21);
  float specular = pow(max(0.0, 1.0 - length(point - lightPosition) * 2.2), 7.0);
  float rim = pow(1.0 - inner, 2.4) * edge;
  float caustic = pow(max(0.0, sin((field + swirl) * 11.0 + time * 0.4)), 9.0) * inner;
  color += vec3(0.80, 0.96, 1.0) * specular * (0.8 + u_energy * 0.35);
  color += vec3(0.14, 0.72, 1.0) * rim * 0.72;
  color += vec3(0.55, 0.92, 1.0) * caustic * 0.22;

  float alpha = edge * (0.76 + rim * 0.22);
  gl_FragColor = vec4(color * alpha, alpha);
}
`

const STATE_STYLE: Record<OrbState, { speed: number; energy: number; colors: [string, string, string] }> = {
  breathing: { speed: 0.33, energy: 0.12, colors: ["#020812", "#0A2C5A", "#24678A"] },
  searching: { speed: 0.78, energy: 0.48, colors: ["#020B1D", "#0756B8", "#1EC8FF"] },
  solving: { speed: 0.92, energy: 0.62, colors: ["#020B1D", "#1646A0", "#6EE9FF"] },
  listening: { speed: 0.68, energy: 0.72, colors: ["#06122B", "#1C69D8", "#80F4FF"] },
  connecting: { speed: 0.72, energy: 0.54, colors: ["#061125", "#2148B8", "#54D8FF"] },
  weaving: { speed: 0.64, energy: 0.52, colors: ["#071127", "#244C9A", "#52C9E9"] },
  composing: { speed: 0.7, energy: 0.56, colors: ["#03122A", "#0E6FBA", "#78E7FF"] },
  working: { speed: 1.02, energy: 0.82, colors: ["#020B1D", "#0756B8", "#DDFBFF"] },
  shaping: { speed: 0.54, energy: 0.36, colors: ["#170713", "#7A2146", "#FF7991"] },
}

function rgb(hex: string): [number, number, number] {
  const parsed = Number.parseInt(hex.replace("#", ""), 16)
  return [((parsed >> 16) & 255) / 255, ((parsed >> 8) & 255) / 255, (parsed & 255) / 255]
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export interface LiquidGlassOrbProps {
  state?: OrbState
  size?: number
  className?: string
  label?: string
  intensity?: number
  style?: CSSProperties
}

export function LiquidGlassOrb({
  state = "breathing",
  size = 156,
  className = "",
  label,
  intensity = 1,
  style,
}: LiquidGlassOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true })
    if (!gl) { setSupported(false); return }

    const program = gl.createProgram()
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
    if (!program || !vertex || !fragment) { setSupported(false); return }
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { setSupported(false); return }
    gl.useProgram(program)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "a_position")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const styleForState = STATE_STYLE[state]
    const resolution = gl.getUniformLocation(program, "u_resolution")
    const time = gl.getUniformLocation(program, "u_time")
    gl.uniform1f(gl.getUniformLocation(program, "u_energy"), styleForState.energy * Math.max(0, intensity))
    const [a, b, c] = styleForState.colors.map(rgb)
    gl.uniform3f(gl.getUniformLocation(program, "u_color_a"), ...a)
    gl.uniform3f(gl.getUniformLocation(program, "u_color_b"), ...b)
    gl.uniform3f(gl.getUniformLocation(program, "u_color_c"), ...c)

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pixels = Math.max(1, Math.round(size * dpr))
    canvas.width = pixels
    canvas.height = pixels
    gl.viewport(0, 0, pixels, pixels)
    gl.uniform2f(resolution, pixels, pixels)

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let inView = false
    let elapsed = 0
    let lastFrame = performance.now()
    let lastDraw = 0
    let animation = 0
    const draw = (now: number) => {
      animation = 0
      if (document.hidden || !inView || motion.matches) return
      const interval = state === "breathing" ? 50 : 25
      if (now - lastDraw >= interval) {
        elapsed += Math.min(now - lastFrame, 80)
        lastDraw = now
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.uniform1f(time, (elapsed / 1000) * styleForState.speed)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      }
      lastFrame = now
      animation = requestAnimationFrame(draw)
    }
    const drawStill = () => {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(time, (elapsed / 1000) * styleForState.speed)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    const updateActivity = () => {
      const active = inView && !document.hidden && !motion.matches
      if (!active) { cancelAnimationFrame(animation); animation = 0; if (inView) drawStill(); return }
      if (!animation) { lastFrame = performance.now(); animation = requestAnimationFrame(draw) }
    }
    const observer = new IntersectionObserver(([entry]) => { inView = Boolean(entry?.isIntersecting); updateActivity() }, { threshold: 0.05 })
    observer.observe(canvas)
    document.addEventListener("visibilitychange", updateActivity)
    motion.addEventListener("change", updateActivity)
    drawStill()

    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", updateActivity)
      motion.removeEventListener("change", updateActivity)
      cancelAnimationFrame(animation)
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    }
  }, [intensity, size, state])

  return <span
    className={`pw-liquid-orb ${className}`.trim()}
    data-state={state}
    data-supported={supported ? "true" : "false"}
    style={{ width: size, height: size, ...style }}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
  >
    <span className="pw-liquid-orb__halo" aria-hidden />
    <canvas ref={canvasRef} />
    {!supported ? <span className="pw-liquid-orb__fallback" aria-hidden /> : null}
  </span>
}
