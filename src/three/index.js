import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export { THREE };

export function apertureForBlurRadius({ radiusPixels, depth, focusDistance, fov = 38, pixelHeight = 1080 }) {
  if (![radiusPixels, depth, focusDistance, fov, pixelHeight].every(Number.isFinite)
    || radiusPixels < 0 || depth <= 0 || focusDistance <= 0 || fov <= 0 || fov >= 180 || pixelHeight <= 0) throw Object.assign(new Error('Invalid blur conversion parameters.'), { code: 'shot_contract_invalid' });
  if (radiusPixels === 0) return 0;
  const defocus = Math.abs(1 / depth - 1 / focusDistance);
  if (defocus === 0) throw Object.assign(new Error('Blur radius on the focal plane is always zero.'), { code: 'shot_contract_invalid' });
  return radiusPixels * 2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)) / (pixelHeight * defocus);
}

function halton(index, base) {
  let value = 0, weight = 1;
  while (index > 0) { weight /= base; value += weight * (index % base); index = Math.floor(index / base); }
  return value;
}

function roundedGeometry(w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geometry = new THREE.ShapeGeometry(s, 16);
  const p = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  return geometry;
}

const defaultStyle = Object.freeze({ annotationFontFamily: 'sans-serif', annotationColor: '#555555',
  annotationTextColor: '#222222', textureBackground: '#eeeeee', browserFrameColor: '#666666', browserFrameFontFamily: 'sans-serif' });

async function loadTextureFont(family, weight, text) {
  try {
    if (typeof family !== 'string' || !family.trim() || !CSS.supports('font-family', family)) throw new Error('Invalid font family.');
    if (!/^(['"]).*\1$/.test(family.trim()) && family.includes(',')) throw new Error('Provide a single font family.');
    const loaded = await document.fonts.load(`${weight} 64px ${family}`, text || 'Text');
    // FontFaceSet.load succeeds with an empty list for an unknown family.
    // Probe local fonts explicitly instead of silently drawing a fallback.
    if (!loaded.length && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math)$/i.test(family.trim())) {
      const name = family.trim().replace(/^(['"])(.*)\1$/, '$2');
      await new FontFace('MultiplaneFontProbe', `local(${JSON.stringify(name)})`, { weight: String(weight) }).load();
    }
  } catch (cause) {
    throw Object.assign(new Error(`Texture font failed to load: ${family}`, { cause }), { code: 'resource_failed' });
  }
}

function annotate(ctx, annotations, width, height, style) {
  for (const a of annotations) {
    const x = a.x * width, y = a.y * height, w = (a.w ?? 0) * width, h = (a.h ?? 0) * height;
    ctx.fillStyle = ctx.strokeStyle = a.color ?? style.annotationColor;
    ctx.lineWidth = (a.lineWidth ?? 0.003) * width;
    if (a.type === 'highlight') ctx.fillRect(x, y, w, h);
    if (a.type === 'underline') { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke(); }
    if (a.type === 'circle') { ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
    if (a.text) {
      ctx.fillStyle = a.textColor ?? style.annotationTextColor;
      ctx.font = `${a.weight ?? 500} ${(a.fontSize ?? 0.03) * width}px ${style.annotationFontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(a.text, x + (a.type === 'highlight' ? 0.006 * width : 0), y + h / 2);
    }
  }
}

export function createThreeLayer({ stage = document.querySelector('#stage'), size = Shot.size,
  pixelRatio = devicePixelRatio, fov = 38, near = 0.1, far = 100,
  focusDistance = 10, aperture = 0.15, samples = 64, quality = 'final',
  adaptiveSamples = true, maxSamples = 1024, sampleSpacing = 1.5, sampleBlur = 1, rotateSamples = true,
  previewAperture = 0.008, maxBlur = 0.016, toneMapping = false, zIndex = 1, style = {} } = {}) {
  // TODO(design): Document the shared layer/card style fields and single-family font values.
  const layerStyle = { ...defaultStyle, ...style };
  const layerBackground = style.textureBackground !== undefined;
  const renderer = new THREE.WebGLRenderer({ alpha: true, premultipliedAlpha: false, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(size.w, size.h);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = toneMapping ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  Object.assign(renderer.domElement.style, { position: 'absolute', inset: '0', zIndex, pointerEvents: 'none' });
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, size.w / size.h, near, far);
  camera.position.z = 10;
  camera.layers.enable(1);
  const target = new THREE.WebGLRenderTarget(size.w * pixelRatio, size.h * pixelRatio, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(scene, camera);
  const bokeh = new BokehPass(scene, camera, { focus: focusDistance, aperture: previewAperture, maxblur: maxBlur });
  const original = bokeh.materialBokeh.fragmentShader;
  if (!original.includes('gl_FragColor.a = 1.0;')) throw Object.assign(new Error('BokehShader interface changed; check the three.js version.'), { code: 'shot_contract_invalid' });
  bokeh.materialBokeh.fragmentShader = original.replace('gl_FragColor.a = 1.0;',
    'gl_FragColor.rgb /= max(gl_FragColor.a, 0.00001);');
  const renderBokeh = bokeh.render.bind(bokeh);
  bokeh.render = (...args) => {
    const mask = camera.layers.mask;
    camera.layers.disable(1);
    try { renderBokeh(...args); } finally { camera.layers.mask = mask; }
  };
  composer.addPass(renderPass); composer.addPass(bokeh); composer.addPass(new OutputPass());
  composer.setSize(size.w, size.h);
  const width = renderer.domElement.width, height = renderer.domElement.height;
  const sampleTarget = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType });
  sampleTarget.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
  if (!renderer.extensions.has('EXT_float_blend')) throw Object.assign(new Error('Accumulated depth of field requires EXT_float_blend.'), { code: 'shot_contract_invalid' });
  const accumulationTarget = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, depthBuffer: false });
  const sumMaterial = new THREE.ShaderMaterial({
    uniforms: { image: { value: sampleTarget.texture }, weight: { value: 1 / samples },
      depthImage: { value: sampleTarget.depthTexture }, resolution: { value: new THREE.Vector2(width, height) },
      cameraNear: { value: near }, cameraFar: { value: far }, focus: { value: focusDistance },
      blurScale: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: `
      uniform sampler2D image, depthImage;
      uniform float weight, cameraNear, cameraFar, focus, blurScale;
      uniform vec2 resolution;
      varying vec2 vUv;
      float depthAt(vec2 uv) {
        float d = texture2D(depthImage, uv).x;
        return cameraNear * cameraFar / (cameraFar - d * (cameraFar - cameraNear));
      }
      void main() {
        vec4 center = texture2D(image, vUv);
        float z = depthAt(vUv);
        float radius = blurScale * abs(1.0 / z - 1.0 / focus);
        if (radius < 0.001 || z > cameraFar * 0.999) {
          gl_FragColor = center * weight; return;
        }
        vec4 color = center;
        float total = 1.0;
        float slope = min(length(vec2(dFdx(z), dFdy(z))), z * 0.002);
        for (int i = 0; i < 16; i++) {
          float r = sqrt((float(i) + 0.5) / 16.0);
          float a = float(i) * 2.39996323;
          vec2 delta = vec2(cos(a), sin(a)) * r * radius * 2.0;
          vec2 uv = vUv + delta / resolution;
          float other = depthAt(uv);
          float tolerance = max(z * 0.0002, slope * (length(delta) + 1.0) * 1.5);
          float w = exp(-2.0 * r * r) * (1.0 - smoothstep(tolerance, tolerance * 2.0, abs(other - z)));
          vec2 pixelUv = (floor(uv * resolution) + 0.5) / resolution;
          color += texture2D(image, pixelUv) * w; total += w;
        }
        gl_FragColor = color / total * weight;
      }`,
    depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const sumQuad = new FullScreenQuad(sumMaterial);
  const output = new OutputPass();
  output.material.fragmentShader = output.material.fragmentShader.replace(
    'gl_FragColor = texture2D( tDiffuse, vUv );',
    'gl_FragColor = texture2D( tDiffuse, vUv ); gl_FragColor.rgb /= max(gl_FragColor.a, 0.00001);');
  output.renderToScreen = true;
  const sampling = { quality, samples, adaptiveSamples, maxSamples, sampleSpacing, sampleBlur, rotateSamples };
  const stats = { samples: 0, maxBlurRadius: 0, rotation: 0 };
  const patterns = new Map();
  function pattern(count) {
    if (!patterns.has(count)) {
      const points = Array.from({ length: count }, (_, i) => {
        const r = Math.sqrt((i + 0.5) / count), theta = i * Math.PI * (3 - Math.sqrt(5));
        return [r * Math.cos(theta), r * Math.sin(theta), halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5];
      });
      const mean = [0, 1, 2, 3].map(j => points.reduce((v, p) => v + p[j], 0) / count);
      const lensScale = Math.max(1, ...points.map(p => Math.hypot(p[0] - mean[0], p[1] - mean[1])));
      if (patterns.size >= 8) patterns.delete(patterns.keys().next().value);
      patterns.set(count, points.map(p => p.map((v, j) => (v - mean[j]) / (j < 2 ? lensScale : 1))));
    }
    return patterns.get(count);
  }
  function renderAccumulation(focus, radius, count, blur, rotation) {
    const position = camera.position.clone(), projection = camera.projectionMatrix.clone();
    const projectionInverse = camera.projectionMatrixInverse.clone();
    const autoClear = renderer.autoClear, oldTarget = renderer.getRenderTarget();
    camera.updateMatrixWorld(true);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    if (camera.parent) {
      const inverse = camera.parent.matrixWorld.clone().invert();
      const origin = new THREE.Vector3().applyMatrix4(inverse);
      right.applyMatrix4(inverse).sub(origin); up.applyMatrix4(inverse).sub(origin);
    }
    try {
      renderer.setRenderTarget(accumulationTarget); renderer.clear();
      sumMaterial.uniforms.weight.value = 1 / count;
      sumMaterial.uniforms.focus.value = focus;
      sumMaterial.uniforms.cameraNear.value = camera.near;
      sumMaterial.uniforms.cameraFar.value = camera.far;
      sumMaterial.uniforms.blurScale.value = radius * height * projection.elements[5] * 0.5 * blur / Math.sqrt(count);
      for (const [x, y, jx, jy] of pattern(count)) {
        const dx = (x * Math.cos(rotation) - y * Math.sin(rotation)) * radius;
        const dy = (x * Math.sin(rotation) + y * Math.cos(rotation)) * radius;
        camera.position.copy(position).addScaledVector(right, dx).addScaledVector(up, dy);
        camera.updateMatrixWorld(true);
        camera.projectionMatrix.copy(projection);
        camera.projectionMatrix.elements[8] += -projection.elements[0] * dx / focus + 2 * jx / width;
        camera.projectionMatrix.elements[9] += -projection.elements[5] * dy / focus + 2 * jy / height;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        renderer.autoClear = true; renderer.setRenderTarget(sampleTarget); renderer.render(scene, camera);
        renderer.autoClear = false; renderer.setRenderTarget(accumulationTarget); sumQuad.render(renderer);
      }
      renderer.autoClear = true;
      output.render(renderer, null, accumulationTarget);
    } finally {
      camera.position.copy(position); camera.projectionMatrix.copy(projection);
      camera.projectionMatrixInverse.copy(projectionInverse); camera.updateMatrixWorld(true);
      renderer.autoClear = autoClear; renderer.setRenderTarget(oldTarget);
    }
  }
  const pending = [], textures = new Set(), textureCache = new Map();
  function configureTexture(texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    textures.add(texture);
    return texture;
  }
  function card({ src, width, height, radius = 0, position = [0, 0, 0], rotation = [0, 0, 0],
    border = null, shadow = false, annotations = [], browserFrame = false, textureWidth = 2048, style = {} }) {
    const textureStyle = { ...layerStyle, ...style };
    const composeBackground = layerBackground || style.textureBackground !== undefined;
    const group = new THREE.Group();
    group.position.fromArray(position); group.rotation.set(...rotation);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(roundedGeometry(width, height, radius), material);
    group.add(mesh);
    if (border) {
      const edge = new THREE.Mesh(roundedGeometry(width + 2 * border.width, height + 2 * border.width, radius + border.width),
        new THREE.MeshBasicMaterial({ color: border.color, side: THREE.DoubleSide }));
      edge.position.z = -0.002; group.add(edge);
    }
    if (shadow) {
      const c = document.createElement('canvas'); c.width = c.height = 512;
      const ctx = c.getContext('2d');
      ctx.filter = 'blur(22px)'; ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(62, 62, 388, 388);
      const texture = configureTexture(new THREE.CanvasTexture(c));
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.3, height * 1.3),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      plane.layers.set(1); plane.position.set(0.04, -0.07, -0.025); group.add(plane);
    }
    const key = JSON.stringify({ src, annotations, browserFrame, textureWidth, aspect: width / height, style: textureStyle, composeBackground });
    if (!textureCache.has(key)) textureCache.set(key, (async () => {
      const image = await new THREE.ImageLoader().loadAsync(src);
      if (!annotations.length && !browserFrame && !composeBackground) return configureTexture(new THREE.Texture(image));
      const fontLoads = annotations.filter(a => a.text).map(a => loadTextureFont(textureStyle.annotationFontFamily, a.weight ?? 500, a.text));
      const title = new URL(src, location.href).pathname.split('/').pop();
      if (browserFrame) fontLoads.push(loadTextureFont(textureStyle.browserFrameFontFamily, 400, title));
      await Promise.all(fontLoads);
      const c = document.createElement('canvas');
      c.width = Math.min(renderer.capabilities.maxTextureSize, Math.max(image.width, textureWidth));
      c.height = Math.round(c.width * height / width);
      const ctx = c.getContext('2d');
      const bar = browserFrame ? Math.round(c.height * 0.065) : 0;
      ctx.fillStyle = textureStyle.textureBackground; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(image, 0, bar, c.width, c.height - bar);
      if (browserFrame) {
        ctx.fillStyle = textureStyle.browserFrameColor;
        for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(c.width * (0.022 + i * 0.019), bar / 2, c.width * 0.004, 0, 2 * Math.PI); ctx.fill(); }
        ctx.font = `${bar * 0.45}px ${textureStyle.browserFrameFontFamily}`; ctx.textBaseline = 'middle';
        ctx.fillText(title, c.width * 0.10, bar / 2);
      }
      annotate(ctx, annotations, c.width, c.height, textureStyle);
      return configureTexture(new THREE.CanvasTexture(c));
    })());
    const loaded = textureCache.get(key).then(texture => { texture.needsUpdate = true; material.map = texture; material.needsUpdate = true; });
    loaded.catch(() => {});
    pending.push(loaded); scene.add(group);
    group.userData.material = material;
    return group;
  }
  return {
    scene, camera, renderer, composer, bokeh, card, sampling, stats, sampleTarget, accumulationTarget,
    get ready() { return Promise.all(pending); },
    render({ focusDistance: focus = focusDistance, aperture: radius = aperture,
      samples: count = sampling.samples, quality: mode = sampling.quality,
      adaptiveSamples: adaptive = sampling.adaptiveSamples, maxSamples: maximum = sampling.maxSamples,
      sampleSpacing: spacing = sampling.sampleSpacing, sampleBlur: blur = sampling.sampleBlur,
      rotateSamples: rotate = sampling.rotateSamples,
      t = window.SHOT?.sampleContext?.time ?? 0, motionBlur = window.SHOT?.sampleContext?.motionBlur ?? 1,
      previewAperture: previewRadius = previewAperture, maxBlur: previewMax = maxBlur } = {}) {
      if (!Number.isFinite(focus) || focus <= 0 || !Number.isFinite(radius) || radius < 0
        || !Number.isInteger(count) || count < 1 || !['preview', 'final'].includes(mode)
        || !Number.isInteger(maximum) || maximum < count || !Number.isFinite(spacing) || spacing <= 0
        || !Number.isFinite(blur) || blur < 0 || !Number.isFinite(t)
        || !Number.isInteger(motionBlur) || motionBlur < 1) throw Object.assign(new Error('Invalid three layer sampling parameters.'), { code: 'shot_contract_invalid' });
      if (mode === 'preview') {
        bokeh.uniforms.focus.value = focus; bokeh.uniforms.aperture.value = previewRadius; bokeh.uniforms.maxblur.value = previewMax;
        composer.render(0);
      } else {
        scene.updateMatrixWorld(true); camera.updateWorldMatrix(true, false);
        const view = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const frustum = new THREE.Frustum().setFromProjectionMatrix(view);
        let maxRadius = 0;
        const point = new THREE.Vector3(), transform = new THREE.Matrix4();
        scene.traverseVisible(object => {
          if (!object.isMesh || !object.layers.test(camera.layers) || !object.material?.depthWrite
            || !frustum.intersectsObject(object)) return;
          transform.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
          const vertices = object.geometry.attributes.position;
          let minZ = Infinity, maxZ = -Infinity;
          for (let i = 0; i < vertices.count; i++) {
            point.fromBufferAttribute(vertices, i).applyMatrix4(transform);
            minZ = Math.min(minZ, -point.z); maxZ = Math.max(maxZ, -point.z);
          }
          if (maxZ < camera.near || minZ > camera.far) return;
          for (const z of [Math.max(camera.near, minZ), Math.min(camera.far, maxZ)]) {
            maxRadius = Math.max(maxRadius, radius * height * camera.projectionMatrix.elements[5] * 0.5 * Math.abs(1 / z - 1 / focus));
          }
        });
        const actual = adaptive ? Math.min(maximum, Math.max(count, Math.ceil((2 * maxRadius / spacing) ** 2))) : count;
        const phase = t * 997 * Math.sqrt(2);
        const rotation = rotate && motionBlur > 1 ? (phase - Math.floor(phase)) * Math.PI * 2 : 0;
        Object.assign(stats, { samples: actual, maxBlurRadius: maxRadius, rotation });
        renderAccumulation(focus, radius, actual, blur, rotation);
      }
    },
    gpuInfo() {
      const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return { renderer: name, hardware: ext ? !/swiftshader|llvmpipe|software|basic render|warp/i.test(name) : null,
        width: renderer.domElement.width, height: renderer.domElement.height, anisotropy: renderer.capabilities.getMaxAnisotropy() };
    },
    dispose() {
      scene.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
      for (const texture of textures) texture.dispose();
      for (const pass of composer.passes) pass.dispose?.();
      sampleTarget.dispose(); accumulationTarget.dispose(); sumMaterial.dispose(); sumQuad.dispose(); output.dispose();
      composer.dispose(); renderer.dispose(); renderer.domElement.remove();
    },
  };
}

export function driftPosition(t, from, to, settle, velocity) {
  const time = Math.max(0, t), k = Math.min(time / settle, 1), eased = 1 - (1 - k) ** 3;
  return from.map((value, i) => value + (to[i] - value - velocity[i] * settle) * eased + velocity[i] * time);
}
