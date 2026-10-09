import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const COMMON = `
varying vec3 vWP; varying vec3 vWN;
float gWin = 0.;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
`;

// world-space procedural detail (no UVs needed), works with instancing
function patch(mat, key, body) {
  mat.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 wp4 = vec4(transformed, 1.); vec3 wn0 = objectNormal;
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4; wn0 = mat3(instanceMatrix) * wn0;
        #endif
        vWP = (modelMatrix * wp4).xyz; vWN = normalize(mat3(modelMatrix) * wn0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON)
      .replace('#include <color_fragment>', '#include <color_fragment>\n{' + body + '}')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, .06, gWin);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, .5, gWin);');
  };
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
}

const WALL_BASIS = `
  vec3 N = normalize(vWN);
  float wall = 1. - smoothstep(.25, .5, abs(N.y));
  vec3 T = normalize(vec3(-N.z, 0., N.x) + vec3(1e-4, 0., 0.));
  float far = smoothstep(60., 180., length(vWP - cameraPosition));
`;

const FACADE = WALL_BASIS + `
  vec2 c = vec2(dot(vWP, T) / 3.4, vWP.y / 3.3);
  vec2 id = floor(c), f = fract(c);
  float win = step(.2,f.x)*step(f.x,.8)*step(.3,f.y)*step(f.y,.78);
  float fr = step(.14,f.x)*step(f.x,.86)*step(.24,f.y)*step(f.y,.84) - win;
  vec3 glassC = mix(vec3(.08,.14,.22), vec3(.28,.44,.6), hash(id + 3.7));
  float grime = vnoise(vWP.xz*.5 + vWP.y*.15)*.3 + vnoise(vWP.xy*1.7 + vWP.zy)*.12;
  vec3 base = diffuseColor.rgb * (1. - grime);
  base *= mix(1., .6, step(f.y,.07)*wall);
  base *= mix(1., .55, fr*wall);
  base *= mix(1., .82, step(f.x,.06)*wall);
  vec3 col = mix(base, glassC, win*wall);
  vec3 avg = mix(base, vec3(.2,.3,.42), .3*wall);
  diffuseColor.rgb = mix(col, avg, far);
  gWin = win*wall*(1.-far);
`;

const BRICK = WALL_BASIS + `
  float horiz = step(.6, abs(N.y));
  vec2 p = mix(vec2(dot(vWP,T), vWP.y), vWP.xz, horiz) / vec2(.6,.22);
  p.x += .5*mod(floor(p.y), 2.);
  vec2 f = fract(p), id = floor(p);
  float mortar = max(step(f.x,.05), step(f.y,.1));
  vec3 brick = mix(vec3(.55,.22,.16), vec3(.36,.13,.1), hash(id));
  vec3 col = mix(brick, vec3(.7,.66,.6), mortar);
  diffuseColor.rgb = mix(col, vec3(.5,.22,.16), far) * (1. - .2*vnoise(vWP.xz*.4));
`;

const ROOF_METAL = `
  float rib = .85 + .15*smoothstep(0., .15, abs(fract(dot(vWP.xz, vec2(.8,.6))/1.2) - .5));
  diffuseColor.rgb *= rib * (1. - .25*vnoise(vWP.xz*.3));
`;

const ROOF_TILE = `
  vec2 p = vWP.xz / vec2(1.2,.7);
  p.x += .5*mod(floor(p.y), 2.);
  vec2 f = fract(p);
  float far = smoothstep(50., 150., length(vWP - cameraPosition));
  float ln = 1. - .35*max(step(f.x,.06), step(f.y,.12));
  float v = .8 + .4*hash(floor(p));
  diffuseColor.rgb *= mix(ln*v, .85, far);
`;

const TERRAIN = `
  float d1 = vnoise(vWP.xz*.9), d2 = vnoise(vWP.xz*.12);
  float near = 1. - smoothstep(30., 120., length(vWP - cameraPosition));
  diffuseColor.rgb *= mix(1., .8 + .4*d1, near) * (.85 + .3*d2);
  diffuseColor.rgb *= vec3(.95, 1.05, .9);
`;

const LEAF = `
  diffuseColor.rgb *= .7 + .6*vnoise(vWP.xz*.35 + vWP.y*.2);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(1.25,1.1,.6), .3*hash(floor(vWP.xz*.5)));
`;

export function enhance(root, renderer, scene) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const style = (m, hex, rough, metal, key, body) => {
    if (hex !== null) m.color.set(hex);
    m.roughness = rough; m.metalness = metal; m.envMapIntensity = .35;
    if (body) patch(m, key, body);
  };
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    const m = o.material;
    if (seen.has(m)) return;
    seen.add(m);
    switch (m.name) {
      case 'White':      style(m, 0xece4d4, .85, 0, 'facade', FACADE); break;
      case 'Concrete':   style(m, 0xb98a5e, .9, 0, 'facade', FACADE); break;
      case 'Orange':     style(m, 0xd9743a, .85, 0, 'facade', FACADE); break;
      case 'Green':      style(m, 0x86b884, .85, 0, 'facade', FACADE); break;
      case 'MessBrick':  style(m, 0xffffff, .95, 0, 'brick', BRICK); break;
      case 'Blue Roof':  style(m, 0x3f6fa8, .5, .3, 'roofm', ROOF_METAL); break;
      case 'BlackRoof':  style(m, 0x4a4a52, .8, 0, 'roofa', ROOF_TILE); break;
      case 'Grey roof':  style(m, 0x8c8c94, .8, 0, 'roofb', ROOF_TILE); break;
      case 'Glass':      style(m, 0x9fc4de, .05, .9, null, null); break;
      case 'Wood':       style(m, 0x5a3b22, .95, 0, null, null); break;
      case 'Leaf':       style(m, 0x3f8f3a, .9, 0, 'leaf', LEAF); break;
      case 'Material.002':
        if (m.map) m.map.anisotropy = aniso;
        style(m, null, 1, 0, 'terrain', TERRAIN); break;
    }
  });
}

// collapse repeated (geometry, material) pairs (the ~1400 trees) into InstancedMesh
export function instanceDuplicates(root, scene) {
  const groups = new Map();
  root.traverse(o => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    const k = o.geometry.uuid + '|' + o.material.uuid;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  });
  for (const list of groups.values()) {
    if (list.length < 4) continue;
    const im = new THREE.InstancedMesh(list[0].geometry, list[0].material, list.length);
    list.forEach((o, i) => { im.setMatrixAt(i, o.matrixWorld); });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = im.receiveShadow = true;
    im.frustumCulled = false;
    scene.add(im);
    list.forEach(o => o.parent && o.parent.remove(o));
  }
}

export function makeSky(scene) {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 v; void main(){ v=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 v; void main(){ float h=clamp(v.y*1.4+.1,0.,1.); gl_FragColor=vec4(mix(vec3(.86,.92,.98),vec3(.28,.52,.86),pow(h,.6)),1.); }'
  });
  const s = new THREE.Mesh(new THREE.SphereGeometry(1200, 24, 12), m);
  s.frustumCulled = false; s.renderOrder = -1;
  scene.add(s);
  return s;
}
