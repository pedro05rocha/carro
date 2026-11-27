import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

const API = `${window.location.protocol}//${window.location.hostname}:8000`;
const WS = API.replace(/^http/, 'ws');
const MAX_POINTS = 40000;

type Props = { token: string; robotId: string };

export const PointCloudView: React.FC<Props> = ({ token, robotId }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return undefined;
    }
    setCount(0);

    // --- cena ---
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x05080c, 1);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.touchAction = 'none';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 100);

    const grid = new THREE.GridHelper(10, 20, 0x2a6f7f, 0x16303a);
    grid.position.y = -0.3;
    scene.add(grid);
    scene.add(new THREE.AxesHelper(0.3));

    const positions = new Float32Array(MAX_POINTS * 3);
    const colors = new Float32Array(MAX_POINTS * 3);
    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    const colAttr = new THREE.BufferAttribute(colors, 3);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('color', colAttr);
    geometry.setDrawRange(0, 0);
    const material = new THREE.PointsMaterial({ size: 0.02, vertexColors: true, sizeAttenuation: true });
    const cloud = new THREE.Points(geometry, material);
    cloud.frustumCulled = false;

    // A câmara Orbbec usa x para a direita, y para baixo e z em frente.
    // Rodar 180º em x deixa o y para cima e a frente em -z (a direção do three.js).
    const group = new THREE.Group();
    group.rotation.x = Math.PI;
    group.add(cloud);
    scene.add(group);

    // --- câmara orbital (sem dependências extra) ---
    const target = new THREE.Vector3(0, 0, -1.5);
    const home = { yaw: 0, pitch: 0.25, dist: 3 };
    const view = { ...home };
    let dirty = true;

    const place = () => {
      const cp = Math.cos(view.pitch);
      camera.position.set(
        target.x + view.dist * Math.sin(view.yaw) * cp,
        target.y + view.dist * Math.sin(view.pitch),
        target.z + view.dist * Math.cos(view.yaw) * cp
      );
      camera.lookAt(target);
      dirty = true;
    };

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const canvas = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) {
        return;
      }
      view.yaw -= (e.clientX - lastX) * 0.008;
      view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch + (e.clientY - lastY) * 0.008));
      lastX = e.clientX;
      lastY = e.clientY;
      place();
    };
    const onUp = () => {
      dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      view.dist = Math.max(0.5, Math.min(15, view.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
      place();
    };
    const onReset = () => {
      Object.assign(view, home);
      place();
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onReset);

    // --- tamanho ---
    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    place();

    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      if (dirty) {
        dirty = false;
        renderer.render(scene, camera);
      }
    };
    loop();

    // --- dados do backend: Float32 little-endian, x y z intercalados (metros) ---
    const color = new THREE.Color();
    const socket = new WebSocket(
      `${WS}/ws/pointcloud?robot_id=${encodeURIComponent(robotId)}&token=${encodeURIComponent(token)}`
    );
    socket.binaryType = 'arraybuffer';
    socket.onmessage = event => {
      if (!(event.data instanceof ArrayBuffer)) {
        return;
      }
      const data = new Float32Array(event.data);
      const n = Math.min(Math.floor(data.length / 3), MAX_POINTS);
      positions.set(data.subarray(0, n * 3));
      for (let i = 0; i < n; i++) {
        const t = Math.min(1, Math.max(0, (data[i * 3 + 2] - 0.3) / 3.7));
        color.setHSL(0.66 * t, 1, 0.5);
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      geometry.setDrawRange(0, n);
      dirty = true;
      setCount(n);
    };

    return () => {
      socket.close();
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onReset);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (canvas.parentElement === mount) {
        mount.removeChild(canvas);
      }
    };
  }, [token, robotId]);

  return (
    <div ref={mountRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: 12,
          bottom: 10,
          zIndex: 1,
          pointerEvents: 'none',
          fontSize: 11,
          letterSpacing: '.08em',
          color: '#8fb3bd',
        }}
      >
        {count
          ? `POINT CLOUD · ${count} PONTOS · arrasta para rodar, roda para zoom, duplo clique repõe`
          : 'À ESPERA DO POINT CLOUD… (pode demorar até 30 s)'}
      </div>
    </div>
  );
};
