import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH, acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import { enhance, instanceDuplicates, makeSky } from './visuals.js';
import { Net } from './net.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isTouch = matchMedia('(pointer:coarse)').matches;

// ---------- Renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const FOG = 0xdbeafa;
const scene = new THREE.Scene();
scene.background = new THREE.Color(FOG);
scene.fog = new THREE.Fog(FOG, 180, 800);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 1500);
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x556644, 0.6));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 1, far: 500 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);
const SUN_OFF = new THREE.Vector3(120, 200, 80);
const sky = makeSky(scene);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- Map + collision ----------
let bvh = null, terrain = null, ready = false;
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;

new GLTFLoader().load('assets/final.glb', gltf => {
  const root = gltf.scene;
  const drop = [];
  root.traverse(o => { if (/^(Arrow|AudiName)/.test(o.name)) drop.push(o); });
  drop.forEach(o => o.parent && o.parent.remove(o));
  root.updateMatrixWorld(true);

  // merge every solid mesh (world space) into one triangle soup + BVH
  const verts = [], v = new THREE.Vector3();
  root.traverse(o => {
    if (!o.isMesh) return;
    if (o.name === 'Dharti') { terrain = o; o.geometry.computeBoundsTree(); }
    if ([].concat(o.material).some(m => m.name === 'Leaf')) return; // walk through foliage
    const pos = o.geometry.attributes.position, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      verts.push(v.x, v.y, v.z);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  bvh = new MeshBVH(g, { maxLeafTris: 3 });

  enhance(root, renderer, scene);
  instanceDuplicates(root, scene);
  scene.add(root);
  ready = true;
  $('online').disabled = $('offline').disabled = false;
  $('online').textContent = 'Play online';
}, e => { if (e.total) $('online').textContent = `Loading map ${Math.round(100 * e.loaded / e.total)}%`; },
   err => { $('online').textContent = 'Map failed to load'; console.error(err); });

function groundAt(x, z) {
  if (!terrain) return null;
  ray.set(new THREE.Vector3(x, 300, z), new THREE.Vector3(0, -1, 0));
  ray.far = 600;
  return ray.intersectObject(terrain, false)[0] || null;
}

// ---------- Player ----------
const R = 0.35, H = 1.8, GRAV = 25, JUMP = 8.5, STEPS = 5;
const P = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: false, face: 0 };
const cam = { yaw: 0, pitch: 0.35 };
let fly = false, online = false, myId = 0, mySquad = '';

function spawnAt(x, z) {
  const h = groundAt(x, z) || groundAt(-58, 95);
  P.pos.set(x, (h ? h.point.y : 30) + 0.3, z);
  P.vel.set(0, 0, 0);
}

const capsule = new THREE.CapsuleGeometry(0.35, 1.1, 4, 8);
const noseGeo = new THREE.BoxGeometry(0.2, 0.2, 0.5);
function makeAvatar(color) {
  const m = new THREE.Mesh(capsule, new THREE.MeshStandardMaterial({ color }));
  const n = new THREE.Mesh(noseGeo, new THREE.MeshStandardMaterial({ color: 0x222222 }));
  n.position.set(0, 0.5, -0.4);
  m.add(n); m.castShadow = true;
  scene.add(m);
  return m;
}
const body = makeAvatar(0xff7a00);

// capsule vs triangle soup (two-sided, so no walking through walls)
const seg = new THREE.Line3(), box = new THREE.Box3();
const tri = new THREE.Vector3(), cap = new THREE.Vector3(), dv = new THREE.Vector3(), tmp = new THREE.Vector3();
function collide(dt) {
  seg.start.set(P.pos.x, P.pos.y + R, P.pos.z);
  seg.end.set(P.pos.x, P.pos.y + H - R, P.pos.z);
  box.makeEmpty(); box.expandByPoint(seg.start); box.expandByPoint(seg.end);
  box.min.addScalar(-R); box.max.addScalar(R);
  bvh.shapecast({
    intersectsBounds: b => b.intersectsBox(box),
    intersectsTriangle: t => {
      const d = t.closestPointToSegment(seg, tri, cap);
      if (d < R) {
        dv.subVectors(cap, tri).normalize();
        const depth = R - d;
        seg.start.addScaledVector(dv, depth); seg.end.addScaledVector(dv, depth);
      }
    }
  });
  tmp.set(seg.start.x, seg.start.y - R, seg.start.z);
  dv.subVectors(tmp, P.pos);
  P.onGround = dv.y > Math.abs(dt * P.vel.y * 0.25);
  const off = Math.max(0, dv.length() - 1e-5);
  dv.normalize().multiplyScalar(off);
  P.pos.add(dv);
  if (!P.onGround) { dv.normalize(); P.vel.addScaledVector(dv, -dv.dot(P.vel)); }
}

// ---------- Input ----------
const keys = {};
addEventListener('keydown', e => { keys[e.code] = true; if (e.code === 'KeyF' && !online) fly = !fly; });
addEventListener('keyup', e => { keys[e.code] = false; });
renderer.domElement.addEventListener('click', () => { if (!isTouch && ready) renderer.domElement.requestPointerLock(); });
document.addEventListener('mousemove', e => {
  if (!document.pointerLockElement) return;
  cam.yaw -= e.movementX * 0.0025;
  cam.pitch = clamp(cam.pitch + e.movementY * 0.0025, -0.3, 1.2);
});

const joy = { x: 0, y: 0 };
let joyId = null, lookId = null, jox = 0, joy0 = 0, lx = 0, ly = 0, jumpReq = false;
const onJump = e => e.target.closest && e.target.closest('#jump');
addEventListener('touchstart', e => {
  for (const t of e.changedTouches) {
    if (onJump(e)) { jumpReq = true; continue; }
    if (e.target.closest('#menu')) continue;
    if (t.clientX < innerWidth / 2 && joyId === null) { joyId = t.identifier; jox = t.clientX; joy0 = t.clientY; }
    else if (t.clientX >= innerWidth / 2 && lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
  }
}, { passive: false });
addEventListener('touchmove', e => {
  if (!e.target.closest('#menu')) e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joyId) {
      joy.x = clamp((t.clientX - jox) / 50, -1, 1); joy.y = clamp((t.clientY - joy0) / 50, -1, 1);
      $('knob').style.transform = `translate(${joy.x * 30}px,${joy.y * 30}px)`;
    } else if (t.identifier === lookId) {
      cam.yaw -= (t.clientX - lx) * 0.005;
      cam.pitch = clamp(cam.pitch + (t.clientY - ly) * 0.005, -0.3, 1.2);
      lx = t.clientX; ly = t.clientY;
    }
  }
}, { passive: false });
const endTouch = e => {
  for (const t of e.changedTouches) {
    if (t.identifier === joyId) { joyId = null; joy.x = joy.y = 0; $('knob').style.transform = ''; }
    if (t.identifier === lookId) lookId = null;
  }
};
addEventListener('touchend', endTouch);
addEventListener('touchcancel', endTouch);

// ---------- Networking ----------
const remotes = new Map();   // id -> {mesh, buf, info}
const roster = new Map();    // id -> {name, squad}
let room = { id: 0, st: '', n: 0, cd: -1 };

function tag(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px sans-serif'; g.textAlign = 'center';
  g.fillStyle = '#0008'; g.fillRect(0, 8, 256, 48);
  g.fillStyle = color; g.fillText(text, 128, 44);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(2.4, 0.6, 1); s.position.y = 1.5; s.renderOrder = 10;
  return s;
}
function addRemote(info) {
  if (info.id === myId || remotes.has(info.id)) return;
  const mate = info.squad === mySquad;
  const mesh = makeAvatar(mate ? 0x2ecc71 : 0xe74c3c);
  mesh.add(tag(info.name, mate ? '#8dffb0' : '#ff9a9a'));
  mesh.visible = false;
  remotes.set(info.id, { mesh, buf: [], info });
  roster.set(info.id, info);
}
function dropRemote(id) {
  const r = remotes.get(id);
  if (r) { scene.remove(r.mesh); remotes.delete(id); }
  roster.delete(id);
}

const net = new Net({
  welcome: m => {
    myId = m.id; mySquad = m.squad; online = true; fly = false;
    room = { id: m.room, st: m.state, n: m.players.length, cd: -1 };
    m.players.forEach(addRemote);
    roster.set(myId, { id: myId, name: $('name').value || 'Player', squad: mySquad });
    spawnAt(m.spawn.x, m.spawn.z);
  },
  join: m => addRemote(m.p),
  leave: m => dropRemote(m.id),
  state: m => { room.st = m.st; },
  fix: m => { P.pos.set(m.x, m.y, m.z); P.vel.set(0, 0, 0); },
  s: m => {
    room.st = m.st; room.n = m.n; room.cd = m.cd;
    const now = performance.now();
    for (const [id, x, y, z, yaw] of m.p) {
      const r = remotes.get(id);
      if (!r) continue;
      r.buf.push({ t: now, x, y, z, yaw });
      if (r.buf.length > 20) r.buf.shift();
    }
  },
  close: () => { online = false; $('banner').textContent = 'Disconnected'; }
});

function updateRemotes() {
  const rt = performance.now() - 100; // render 100 ms in the past
  for (const r of remotes.values()) {
    const b = r.buf;
    if (!b.length) continue;
    let a = b[0], c = b[b.length - 1];
    for (let i = b.length - 1; i > 0; i--) if (b[i - 1].t <= rt) { a = b[i - 1]; c = b[i]; break; }
    const k = c.t > a.t ? clamp((rt - a.t) / (c.t - a.t), 0, 1) : 1;
    let dy = c.yaw - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    r.mesh.position.set(a.x + (c.x - a.x) * k, a.y + (c.y - a.y) * k + 0.9, a.z + (c.z - a.z) * k);
    r.mesh.rotation.y = a.yaw + dy * k;
    r.mesh.visible = true;
  }
}

// ---------- Menu ----------
$('name').value = localStorage.getItem('br_name') || '';
$('online').onclick = () => {
  localStorage.setItem('br_name', $('name').value);
  $('menu').style.display = 'none';
  if (!isTouch) renderer.domElement.requestPointerLock();
  net.connect($('name').value.trim() || 'Player', $('squad').value.trim());
};
$('offline').onclick = () => {
  $('menu').style.display = 'none';
  if (!isTouch) renderer.domElement.requestPointerLock();
  spawnAt(-58, 95);
  $('banner').textContent = isTouch ? '' : 'Offline: F = fly';
};

// ---------- Loop ----------
const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
let fpsT = 0, fpsN = 0, fps = 0, sendT = 0, playing = false;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  playing = ready && $('menu').style.display === 'none' && (P.pos.lengthSq() > 0);
  if (playing) {
    fwd.set(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
    right.set(-fwd.z, 0, fwd.x);
    let f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) - joy.y;
    let r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + joy.x;
    const m = Math.hypot(f, r);
    if (m > 1) { f /= m; r /= m; }
    const sprint = keys.ShiftLeft || keys.ShiftRight;
    const speed = fly ? (sprint ? 100 : 40) : (sprint ? 8 : 5);
    const mx = (fwd.x * f + right.x * r) * speed, mz = (fwd.z * f + right.z * r) * speed;

    if (fly) {
      P.pos.x += mx * dt; P.pos.z += mz * dt;
      P.pos.y += ((keys.Space ? 1 : 0) - (keys.KeyC ? 1 : 0)) * speed * dt;
      P.vel.set(0, 0, 0);
    } else {
      if ((keys.Space || jumpReq) && P.onGround) { P.vel.y = JUMP; P.onGround = false; }
      const d = dt / STEPS;
      for (let s = 0; s < STEPS; s++) {
        P.pos.x += mx * d; P.pos.z += mz * d;
        if (P.onGround) P.vel.y = -GRAV * d; else P.vel.y = Math.max(P.vel.y - GRAV * d, -50);
        P.pos.y += P.vel.y * d;
        collide(d);
      }
      if (P.pos.y < -200) spawnAt(-58, 95);
    }
    jumpReq = false;
    if (Math.abs(mx) + Math.abs(mz) > 1e-4) P.face = Math.atan2(-mx, -mz);
    body.position.set(P.pos.x, P.pos.y + 0.9, P.pos.z);
    body.rotation.y = P.face;

    // third-person camera with wall avoidance
    const target = new THREE.Vector3(P.pos.x, P.pos.y + 1.5, P.pos.z);
    const dir = new THREE.Vector3(Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), Math.cos(cam.yaw) * Math.cos(cam.pitch));
    let dist = 5;
    if (!fly) {
      const h = bvh.raycastFirst(new THREE.Ray(target, dir), THREE.DoubleSide);
      if (h && h.distance < dist + 0.3) dist = Math.max(0.8, h.distance - 0.3);
    }
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);

    sun.position.copy(P.pos).add(SUN_OFF); sun.target.position.copy(P.pos);

    if (online) {
      sendT += dt;
      if (sendT >= 0.05) {
        sendT = 0;
        net.send({ t: 'in', x: +P.pos.x.toFixed(2), y: +P.pos.y.toFixed(2), z: +P.pos.z.toFixed(2), yaw: +P.face.toFixed(2) });
      }
      updateRemotes();
    }
  }
  sky.position.copy(camera.position);
  renderer.render(scene, camera);

  fpsT += dt; fpsN++;
  if (fpsT > 0.5) { fps = Math.round(fpsN / fpsT); fpsT = 0; fpsN = 0; }
  let hud = `FPS ${fps}  ${fly ? 'FLY' : 'WALK'}\nx ${P.pos.x.toFixed(0)}  y ${P.pos.y.toFixed(0)}  z ${P.pos.z.toFixed(0)}`;
  if (online) {
    hud += `\nRoom ${room.id} [${room.st}]  players ${room.n}\nSquad ${mySquad}: ` +
      [...roster.values()].filter(p => p.squad === mySquad).map(p => p.name).join(', ');
    $('banner').textContent = room.st === 'waiting'
      ? (room.cd >= 0 ? `Match starts in ${room.cd}s` : 'Waiting for players...')
      : (room.st === 'playing' ? 'Match in progress' : '');
  }
  $('hud').textContent = hud;
}
frame();
