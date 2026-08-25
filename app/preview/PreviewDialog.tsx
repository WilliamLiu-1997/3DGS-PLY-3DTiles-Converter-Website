"use client";

import { unzip } from "fflate";
import { useEffect, useRef, useState } from "react";

export type PreviewAsset = {
  mode: "convert" | "simplify";
  name: string;
  blob: Blob;
  splatCount?: number;
  source?: {
    name: string;
    blob: Blob;
    splatCount?: number;
    convention: "graphdeco" | "khr_native";
    scaleEncoding: "log" | "linear";
  };
};

type PreviewRuntime = {
  dispose: () => void;
  frameContent: () => boolean;
  setBackground: (value: number) => void;
  setLodErrorTarget: (value: number) => void;
};

type PreviewCallbacks = {
  onError: (message: string) => void;
  onStatus: (message: string) => void;
  onVisibleSplatCount?: (count: number) => void;
};

type PreviewDialogProps = {
  asset: PreviewAsset;
  onClose: () => void;
};

const MEMORY_ORIGIN = "https://local-preview.invalid/";
const LIGHT_PREVIEW_BACKGROUND = 0xf4f6f9;
const DARK_PREVIEW_BACKGROUND = 0x101214;
const TILES_PREVIEW_READY_STATUS = "3D Tiles preview ready";
const TRANSIENT_ERROR_DURATION_MS = 3_000;
const DEFAULT_LOD_ERROR_TARGET = 16;
const MAX_LOD_ERROR_TARGET = 64;
const MIN_LOD_ERROR_TARGET = 4;
const MIN_LOD_POSITION = 0;
const MAX_LOD_POSITION = Math.log2(MAX_LOD_ERROR_TARGET / MIN_LOD_ERROR_TARGET);
const LOD_POSITION_STEP = 0.1;
const DEFAULT_LOD_POSITION = Math.log2(
  MAX_LOD_ERROR_TARGET / DEFAULT_LOD_ERROR_TARGET,
);
const CAMERA_CENTER_MODE_DISTANCE_SQ = 3_000_000 ** 2;
const TILES_FRAME_PITCH = -Math.PI / 6;
const WGS84_ONE_OVER_RADII_SQUARED = {
  x: 1 / 6_378_137 ** 2,
  y: 1 / 6_378_137 ** 2,
  z: 1 / 6_356_752.3142451793 ** 2,
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function lodPositionToErrorTarget(position: number) {
  return MAX_LOD_ERROR_TARGET / 2 ** position;
}

function normalizeArchivePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function encodeArchivePath(path: string) {
  return normalizeArchivePath(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function unzipArchive(blob: Blob) {
  return blob.arrayBuffer().then(
    (buffer) =>
      new Promise<Map<string, Uint8Array>>((resolve, reject) => {
        unzip(new Uint8Array(buffer), (error, files) => {
          if (error) {
            reject(error);
            return;
          }
          const entries = new Map<string, Uint8Array>();
          for (const [rawPath, bytes] of Object.entries(files)) {
            const path = normalizeArchivePath(rawPath);
            if (!path || path.endsWith("/") || path.startsWith("__MACOSX/")) continue;
            entries.set(path, bytes);
          }
          resolve(entries);
        });
      }),
  );
}

function contentType(path: string) {
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.glb$/i.test(path)) return "model/gltf-binary";
  if (/\.gltf$/i.test(path)) return "model/gltf+json";
  if (/\.bin$/i.test(path)) return "application/octet-stream";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  return "application/octet-stream";
}

function createMemoryTilesPlugin(entries: Map<string, Uint8Array>) {
  return {
    name: "IN_MEMORY_3D_TILES_PREVIEW",
    priority: -1000,
    fetchData(url: string) {
      const parsed = new URL(url);
      if (parsed.origin !== new URL(MEMORY_ORIGIN).origin) return null;

      const path = normalizeArchivePath(decodeURIComponent(parsed.pathname));
      const bytes = entries.get(path);
      if (!bytes) {
        return Promise.resolve(
          new Response(`Missing preview entry: ${path}`, {
            status: 404,
            statusText: "Not found in generated ZIP",
          }),
        );
      }
      return Promise.resolve(
        new Response(bytes as unknown as BodyInit, {
          status: 200,
          headers: { "Content-Type": contentType(path) },
        }),
      );
    },
  };
}

function preparePlyForSpark(
  buffer: ArrayBuffer,
  fallback?: {
    convention: "graphdeco" | "khr_native";
    scaleEncoding: "log" | "linear";
  },
) {
  if (fallback?.convention === "graphdeco" && fallback.scaleEncoding === "log") {
    return buffer;
  }
  const bytes = new Uint8Array(buffer);
  const endHeader = new TextEncoder().encode("end_header");
  let headerBytes = -1;
  outer: for (let offset = 0; offset <= bytes.length - endHeader.length; offset += 1) {
    for (let index = 0; index < endHeader.length; index += 1) {
      if (bytes[offset + index] !== endHeader[index]) continue outer;
    }
    const lineEnd = bytes.indexOf(10, offset + endHeader.length);
    headerBytes = lineEnd < 0 ? -1 : lineEnd + 1;
    break;
  }
  if (headerBytes < 0) throw new Error("The PLY header is incomplete.");

  const header = new TextDecoder().decode(bytes.subarray(0, headerBytes));
  const convention =
    /comment simplify convention=([^\s]+)/.exec(header)?.[1] ||
    fallback?.convention ||
    "graphdeco";
  const scaleEncoding =
    /comment simplify scale_encoding=([^\s]+)/.exec(header)?.[1] ||
    fallback?.scaleEncoding ||
    "log";
  if (convention === "graphdeco" && scaleEncoding === "log") return buffer;
  if (!/^format binary_little_endian 1\.0\r?$/m.test(header)) {
    throw new Error(
      "Spark comparison can normalize non-default PLY conventions only for binary little-endian files.",
    );
  }

  const typeBytes: Record<string, number> = {
    char: 1,
    int8: 1,
    uchar: 1,
    uint8: 1,
    short: 2,
    int16: 2,
    ushort: 2,
    uint16: 2,
    int: 4,
    int32: 4,
    uint: 4,
    uint32: 4,
    float: 4,
    float32: 4,
    double: 8,
    float64: 8,
  };
  const propertyOffsets = new Map<string, number>();
  let vertexCount = 0;
  let rowBytes = 0;
  let inVertex = false;
  for (const rawLine of header.split(/\r?\n/)) {
    const line = rawLine.trim();
    const element = /^element\s+(\S+)\s+(\d+)$/.exec(line);
    if (element) {
      inVertex = element[1] === "vertex";
      if (inVertex) vertexCount = Number(element[2]);
      continue;
    }
    if (!inVertex) continue;
    const property = /^property\s+(\S+)\s+(\S+)$/.exec(line);
    if (!property) continue;
    const size = typeBytes[property[1]];
    if (!size) throw new Error(`Unsupported generated PLY property type: ${property[1]}`);
    propertyOffsets.set(property[2], rowBytes);
    rowBytes += size;
  }
  if (!vertexCount || !rowBytes || headerBytes + vertexCount * rowBytes > bytes.byteLength) {
    throw new Error("The PLY payload does not match its header.");
  }

  const required = ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  if (required.some((name) => !propertyOffsets.has(name))) {
    throw new Error("The PLY is missing Gaussian properties required by Spark.");
  }

  const view = new DataView(buffer);
  const read = (row: number, name: string) =>
    view.getFloat32(headerBytes + row * rowBytes + propertyOffsets.get(name)!, true);
  const write = (row: number, name: string, value: number) =>
    view.setFloat32(headerBytes + row * rowBytes + propertyOffsets.get(name)!, value, true);

  for (let row = 0; row < vertexCount; row += 1) {
    if (scaleEncoding === "linear") {
      for (const name of ["scale_0", "scale_1", "scale_2"]) {
        write(row, name, Math.log(Math.max(read(row, name), 1e-30)));
      }
    }
    if (convention === "khr_native") {
      const opacity = Math.max(1e-7, Math.min(1 - 1e-7, read(row, "opacity")));
      write(row, "opacity", Math.log(opacity / (1 - opacity)));
      const qx = read(row, "rot_0");
      const qy = read(row, "rot_1");
      const qz = read(row, "rot_2");
      const qw = read(row, "rot_3");
      write(row, "rot_0", qw);
      write(row, "rot_1", qx);
      write(row, "rot_2", qy);
      write(row, "rot_3", qz);
    }
  }
  return buffer;
}

function createViewport(
  THREE: typeof import("three"),
  canvas: HTMLCanvasElement,
  background = LIGHT_PREVIEW_BACKGROUND,
) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    premultipliedAlpha: true,
    reversedDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const backgroundColor = new THREE.Color(background);
  scene.background = backgroundColor;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 2e8);
  camera.position.set(0, 0, 5);

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();

  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  observer?.observe(canvas);
  window.addEventListener("resize", resize);

  return {
    renderer,
    scene,
    camera,
    resize,
    setBackground(value: number) {
      backgroundColor.setHex(value);
    },
    dispose() {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      renderer.dispose();
    },
  };
}

async function startTilesPreview(
  canvas: HTMLCanvasElement,
  blob: Blob,
  initialLodErrorTarget: number,
  initialBackground: number,
  callbacks: PreviewCallbacks,
  signal: AbortSignal,
): Promise<PreviewRuntime> {
  callbacks.onStatus("Opening generated 3D Tiles ZIP…");
  const [THREE, tilesModule, tilePlugins, gaussianModule, controllerModule, entries] =
    await Promise.all([
      import("three"),
      import("3d-tiles-renderer"),
      import("3d-tiles-renderer/plugins"),
      import("3d-tiles-rendererjs-3dgs-plugin"),
      import("./cameraController"),
      unzipArchive(blob),
    ]);

  if (signal.aborted) {
    entries.clear();
    signal.throwIfAborted();
  }

  const tilesetPath = [...entries.keys()].find((path) => /(^|\/)tileset\.json$/i.test(path));
  if (!tilesetPath) throw new Error("The generated ZIP does not contain tileset.json.");

  const viewport = createViewport(THREE, canvas, initialBackground);
  const { renderer, scene, camera } = viewport;
  const { TilesRenderer } = tilesModule;
  const { TilesFadePlugin, TileCompressionPlugin, UnloadTilesPlugin } = tilePlugins;
  const { GaussianSplatPlugin, getSparkRendererForScene } = gaussianModule;
  const { CameraController } = controllerModule;

  const rootUrl = new URL(encodeArchivePath(tilesetPath), MEMORY_ORIGIN).toString();
  const tiles = new TilesRenderer(rootUrl);
  tiles.registerPlugin(createMemoryTilesPlugin(entries));
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UnloadTilesPlugin());
  tiles.registerPlugin(new GaussianSplatPlugin({ renderer, scene }));
  const sparkRenderer = getSparkRendererForScene(scene);
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.errorTarget = initialLodErrorTarget;

  tiles.lruCache.minSize = 256;
  tiles.lruCache.maxSize = 4096;
  tiles.lruCache.minBytesSize = 0.2 * 2 ** 30;
  tiles.lruCache.maxBytesSize = 2 * 2 ** 30;
  tiles.lruCache.unloadPercent = 0.1;
  scene.add(tiles.group);

  const controls = new CameraController(renderer, scene, camera, { domElement: canvas });
  const sphere = new THREE.Sphere();
  const cameraRotation = new THREE.Matrix4();
  const cameraBack = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  const cameraRight = new THREE.Vector3();
  const cameraUp = new THREE.Vector3();
  const localNorth = new THREE.Vector3();
  const localUp = new THREE.Vector3();
  const worldNorth = new THREE.Vector3(0, 0, 1);
  let disposed = false;
  let animationFrame = 0;
  let framed = false;
  let lastVisibleSplatCount = -1;

  const reportVisibleSplatCount = () => {
    const count = Math.max(0, Math.trunc(sparkRenderer?.activeSplats ?? 0));
    if (count === lastVisibleSplatCount) return;
    lastVisibleSplatCount = count;
    callbacks.onVisibleSplatCount?.(count);
  };

  const frameContent = () => {
    if (!tiles.getBoundingSphere(sphere)) return false;
    // Match 3dtiles-inspector's Move to tiles pose: heading 0, pitch -30,
    // roll 0. Near the origin this treats +Z as up; for ECEF content it uses
    // the WGS84 east-north-up frame at the tileset center.
    const radius = Math.max(sphere.radius / 2, 1);
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const minHalfFov = Math.max(0.1, Math.min(verticalFov, horizontalFov) / 2);
    const distance = radius / Math.sin(minHalfFov) + radius * 0.75;
    const cosPitch = Math.cos(TILES_FRAME_PITCH);
    const sinPitch = Math.sin(TILES_FRAME_PITCH);

    cameraForward.set(0, cosPitch, sinPitch);
    camera.position.copy(sphere.center).addScaledVector(cameraForward, -distance);

    if (camera.position.lengthSq() <= CAMERA_CENTER_MODE_DISTANCE_SQ) {
      cameraRight.set(1, 0, 0);
    } else {
      localUp
        .set(
          sphere.center.x * WGS84_ONE_OVER_RADII_SQUARED.x,
          sphere.center.y * WGS84_ONE_OVER_RADII_SQUARED.y,
          sphere.center.z * WGS84_ONE_OVER_RADII_SQUARED.z,
        )
        .normalize();
      cameraRight.crossVectors(worldNorth, localUp).normalize();
      localNorth.crossVectors(localUp, cameraRight).normalize();
      cameraForward
        .copy(localNorth)
        .multiplyScalar(cosPitch)
        .addScaledVector(localUp, sinPitch)
        .normalize();
      camera.position.copy(sphere.center).addScaledVector(cameraForward, -distance);
    }

    camera.near = Math.max(radius * 1e-5, 0.001);
    camera.far = Math.max(1000, camera.position.length() * 2, distance * 100);
    camera.updateProjectionMatrix();
    camera.up.set(0, 1, 0);
    cameraBack.copy(cameraForward).negate();
    cameraUp.crossVectors(cameraRight, cameraForward).normalize();
    cameraRotation.makeBasis(cameraRight, cameraUp, cameraBack);
    camera.quaternion.setFromRotationMatrix(cameraRotation);
    camera.updateMatrixWorld();
    return true;
  };

  tiles.addEventListener("load-tileset", () => {
    if (!framed && frameContent()) framed = true;
    callbacks.onStatus(TILES_PREVIEW_READY_STATUS);
  });
  tiles.addEventListener("load-error", (event: { error?: Error }) => {
    callbacks.onError(event.error?.message || "A tile could not be loaded from the generated ZIP.");
  });

  const resizeTiles = () => tiles.setResolutionFromRenderer(camera, renderer);
  window.addEventListener("resize", resizeTiles);

  const render = (time: number) => {
    if (disposed) return;
    try {
      controls.update(time);
      tiles.setResolutionFromRenderer(camera, renderer);
      tiles.update();
      renderer.render(scene, camera);
      reportVisibleSplatCount();
      animationFrame = requestAnimationFrame(render);
    } catch (error) {
      callbacks.onError(errorMessage(error));
    }
  };
  animationFrame = requestAnimationFrame(render);

  return {
    setBackground(value) {
      viewport.setBackground(value);
    },
    setLodErrorTarget(value) {
      tiles.errorTarget = value;
    },
    frameContent,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resizeTiles);
      controls.dispose();
      scene.remove(tiles.group);
      tiles.dispose();
      viewport.dispose();
      entries.clear();
    },
  };
}

function createPlyView(
  THREE: typeof import("three"),
  sparkModule: typeof import("@sparkjsdev/spark"),
  canvas: HTMLCanvasElement,
  buffer: ArrayBuffer,
  fileName: string,
  background = LIGHT_PREVIEW_BACKGROUND,
) {
  const viewport = createViewport(THREE, canvas, background);
  const { renderer, scene, camera } = viewport;
  const { SparkRenderer, SplatMesh } = sparkModule;
  // Spark's automatic update path starts async worker work without retaining
  // the promise. Own that promise here so terminating a preview can settle the
  // in-flight update without producing an unhandled "Worker terminate"
  // rejection. Plain PLY previews do not use Spark's LOD worker either.
  const spark = new SparkRenderer({
    renderer,
    autoUpdate: false,
    enableLod: false,
    enableDriveLod: false,
  });
  scene.add(spark);

  const splat = new SplatMesh({
    fileBytes: new Uint8Array(buffer),
    fileName,
    minRaycastOpacity: 0.1,
    editable: false,
  });
  splat.quaternion.set(1, 0, 0, 0);
  scene.add(splat);

  let disposed = false;
  let updatePromise: Promise<void> | null = null;

  return {
    ...viewport,
    splat,
    update(onError: PreviewCallbacks["onError"]) {
      if (disposed || updatePromise) return;
      updatePromise = spark
        .update({ scene, camera })
        .catch((error: unknown) => {
          if (!disposed) onError(errorMessage(error));
        })
        .finally(() => {
          updatePromise = null;
        });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(splat);
      scene.remove(spark);
      splat.dispose();
      spark.dispose();
      viewport.dispose();
    },
  };
}

async function startPlyPreview(
  canvas: HTMLCanvasElement,
  blob: Blob,
  fileName: string,
  initialBackground: number,
  callbacks: PreviewCallbacks,
  signal: AbortSignal,
): Promise<PreviewRuntime> {
  callbacks.onStatus("Decoding simplified PLY with Spark…");
  const [THREE, sparkModule, controllerModule, buffer] = await Promise.all([
    import("three"),
    import("@sparkjsdev/spark"),
    import("./cameraController"),
    blob.arrayBuffer(),
  ]);
  signal.throwIfAborted();

  const view = createPlyView(
    THREE,
    sparkModule,
    canvas,
    preparePlyForSpark(buffer),
    fileName,
    initialBackground,
  );
  const { renderer, scene, camera, splat } = view;
  const { CameraController } = controllerModule;

  const controls = new CameraController(renderer, scene, camera, {
    domElement: canvas,
    worldUp: new THREE.Vector3(0, 1, 0),
  });
  const worldBox = new THREE.Box3();
  const sphere = new THREE.Sphere();
  let disposed = false;
  let animationFrame = 0;
  let loaded = false;

  const frameContent = () => {
    if (!loaded) return false;
    splat.updateMatrixWorld(true);
    worldBox.copy(splat.getBoundingBox()).applyMatrix4(splat.matrixWorld);
    if (worldBox.isEmpty()) return false;
    worldBox.getBoundingSphere(sphere);
    const radius = Math.max(sphere.radius, 0.001);
    const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const distance = Math.max(radius / Math.sin(halfFov), radius * 1.75);
    // Match Spark's viewer: the splat rotation above converts OpenCV to
    // OpenGL, and the initial camera views the result straight from +Z.
    const viewOffset = new THREE.Vector3(0, 0, 1);
    camera.position.copy(sphere.center).addScaledVector(viewOffset, distance);
    camera.near = Math.max(radius * 1e-5, 0.001);
    camera.far = Math.max(1000, distance * 100);
    camera.up.set(0, 1, 0);
    camera.lookAt(sphere.center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return true;
  };

  void splat.initialized
    .then(() => {
      if (disposed) return;
      loaded = true;
      frameContent();
      callbacks.onStatus("Spark PLY preview ready");
    })
    .catch((error: unknown) => {
      if (!disposed) callbacks.onError(errorMessage(error));
    });

  const render = (time: number) => {
    if (disposed) return;
    try {
      controls.update(time);
      view.update(callbacks.onError);
      renderer.render(scene, camera);
      animationFrame = requestAnimationFrame(render);
    } catch (error) {
      callbacks.onError(errorMessage(error));
    }
  };
  animationFrame = requestAnimationFrame(render);

  return {
    setBackground(value) {
      view.setBackground(value);
    },
    setLodErrorTarget() {},
    frameContent,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(animationFrame);
      controls.dispose();
      view.dispose();
    },
  };
}

async function startPlyComparisonPreview(
  originalCanvas: HTMLCanvasElement,
  simplifiedCanvas: HTMLCanvasElement,
  interactionElement: HTMLDivElement,
  source: NonNullable<PreviewAsset["source"]>,
  simplifiedBlob: Blob,
  simplifiedFileName: string,
  initialBackground: number,
  callbacks: PreviewCallbacks,
  signal: AbortSignal,
): Promise<PreviewRuntime> {
  callbacks.onStatus("Decoding original and simplified PLY files with Spark…");
  const [THREE, sparkModule, controllerModule, originalBuffer, simplifiedBuffer] =
    await Promise.all([
      import("three"),
      import("@sparkjsdev/spark"),
      import("./cameraController"),
      source.blob.arrayBuffer(),
      simplifiedBlob.arrayBuffer(),
    ]);
  signal.throwIfAborted();

  const originalView = createPlyView(
    THREE,
    sparkModule,
    originalCanvas,
    preparePlyForSpark(originalBuffer, source),
    source.name,
    initialBackground,
  );
  let simplifiedView: ReturnType<typeof createPlyView>;
  try {
    simplifiedView = createPlyView(
      THREE,
      sparkModule,
      simplifiedCanvas,
      preparePlyForSpark(simplifiedBuffer),
      simplifiedFileName,
      initialBackground,
    );
  } catch (error) {
    originalView.dispose();
    throw error;
  }

  const { CameraController } = controllerModule;
  const controls = new CameraController(
    originalView.renderer,
    originalView.scene,
    originalView.camera,
    {
      domElement: interactionElement,
      worldUp: new THREE.Vector3(0, 1, 0),
    },
  );
  // Both comparison canvases render separate scenes. CameraController owns a
  // single pivot indicator in the original scene, so mirror it into the
  // simplified scene and keep its transform/visibility in lockstep.
  const pivotIndicator = controls.indicator;
  const mirroredPivotIndicator = pivotIndicator.clone(false);
  simplifiedView.scene.add(mirroredPivotIndicator);
  const worldBox = new THREE.Box3();
  const splatBox = new THREE.Box3();
  const sphere = new THREE.Sphere();
  let disposed = false;
  let animationFrame = 0;
  let loaded = false;

  const syncCamera = () => {
    simplifiedView.camera.copy(originalView.camera, false);
    simplifiedView.camera.updateMatrixWorld(true);
    mirroredPivotIndicator.position.copy(pivotIndicator.position);
    mirroredPivotIndicator.visible = pivotIndicator.visible;
    mirroredPivotIndicator.updateMatrixWorld();
  };

  const frameContent = () => {
    if (!loaded) return false;
    worldBox.makeEmpty();
    for (const view of [originalView, simplifiedView]) {
      view.splat.updateMatrixWorld(true);
      splatBox.copy(view.splat.getBoundingBox()).applyMatrix4(view.splat.matrixWorld);
      if (!splatBox.isEmpty()) worldBox.union(splatBox);
    }
    if (worldBox.isEmpty()) return false;
    worldBox.getBoundingSphere(sphere);
    const radius = Math.max(sphere.radius, 0.001);
    const halfFov = THREE.MathUtils.degToRad(originalView.camera.fov * 0.5);
    const distance = Math.max(radius / Math.sin(halfFov), radius * 1.75);
    originalView.camera.position.copy(sphere.center).addScaledVector(
      new THREE.Vector3(0, 0, 1),
      distance,
    );
    originalView.camera.near = Math.max(radius * 1e-5, 0.001);
    originalView.camera.far = Math.max(1000, distance * 100);
    originalView.camera.up.set(0, 1, 0);
    originalView.camera.lookAt(sphere.center);
    originalView.camera.updateProjectionMatrix();
    originalView.camera.updateMatrixWorld();
    syncCamera();
    return true;
  };

  void Promise.all([originalView.splat.initialized, simplifiedView.splat.initialized])
    .then(() => {
      if (disposed) return;
      loaded = true;
      frameContent();
      callbacks.onStatus("Comparison ready · drag the center handle");
    })
    .catch((error: unknown) => {
      if (!disposed) callbacks.onError(errorMessage(error));
    });

  const render = (time: number) => {
    if (disposed) return;
    try {
      controls.update(time);
      syncCamera();
      originalView.update(callbacks.onError);
      simplifiedView.update(callbacks.onError);
      originalView.renderer.render(originalView.scene, originalView.camera);
      simplifiedView.renderer.render(simplifiedView.scene, simplifiedView.camera);
      animationFrame = requestAnimationFrame(render);
    } catch (error) {
      callbacks.onError(errorMessage(error));
    }
  };
  animationFrame = requestAnimationFrame(render);

  return {
    setBackground(value) {
      originalView.setBackground(value);
      simplifiedView.setBackground(value);
    },
    setLodErrorTarget() {},
    frameContent,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(animationFrame);
      mirroredPivotIndicator.removeFromParent();
      controls.dispose();
      originalView.dispose();
      simplifiedView.dispose();
    },
  };
}

export default function PreviewDialog({ asset, onClose }: PreviewDialogProps) {
  const isComparison = asset.mode === "simplify" && Boolean(asset.source);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const originalCanvasRef = useRef<HTMLCanvasElement>(null);
  const simplifiedCanvasRef = useRef<HTMLCanvasElement>(null);
  const comparisonStageRef = useRef<HTMLDivElement>(null);
  const comparisonInteractionRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const runtimeRef = useRef<PreviewRuntime | null>(null);
  const lodErrorTargetRef = useRef(DEFAULT_LOD_ERROR_TARGET);
  const backgroundRef = useRef(DARK_PREVIEW_BACKGROUND);
  const [lodPosition, setLodPosition] = useState(DEFAULT_LOD_POSITION);
  const [darkBackground, setDarkBackground] = useState(true);
  const [comparisonPosition, setComparisonPosition] = useState(50);
  const [comparisonDragging, setComparisonDragging] = useState(false);
  const [status, setStatus] = useState("Preparing local preview…");
  const [error, setError] = useState<string | null>(null);
  const [visibleSplatCount, setVisibleSplatCount] = useState<number | null>(null);

  const updateComparisonPosition = (clientX: number) => {
    const rect = comparisonStageRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setComparisonPosition(
      Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)),
    );
  };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let errorTimeout: ReturnType<typeof setTimeout> | undefined;

    const callbacks: PreviewCallbacks = {
      onStatus(message) {
        if (!signal.aborted) setStatus(message);
      },
      onError(message) {
        if (signal.aborted) return;
        setError(message);
        if (asset.mode === "convert") setStatus(TILES_PREVIEW_READY_STATUS);
        if (errorTimeout !== undefined) clearTimeout(errorTimeout);
        errorTimeout = setTimeout(() => {
          if (!signal.aborted) setError(null);
          errorTimeout = undefined;
        }, TRANSIENT_ERROR_DURATION_MS);
      },
      onVisibleSplatCount(count) {
        if (!signal.aborted) setVisibleSplatCount(count);
      },
    };

    let start: Promise<PreviewRuntime>;
    if (isComparison && asset.source) {
      const originalCanvas = originalCanvasRef.current;
      const simplifiedCanvas = simplifiedCanvasRef.current;
      const interactionElement = comparisonInteractionRef.current;
      if (!originalCanvas || !simplifiedCanvas || !interactionElement) return;
      start = startPlyComparisonPreview(
        originalCanvas,
        simplifiedCanvas,
        interactionElement,
        asset.source,
        asset.blob,
        asset.name,
        backgroundRef.current,
        callbacks,
        signal,
      );
    } else {
      const canvas = canvasRef.current;
      if (!canvas) return;
      start = asset.mode === "convert"
        ? startTilesPreview(
            canvas,
            asset.blob,
            lodErrorTargetRef.current,
            backgroundRef.current,
            callbacks,
            signal,
          )
        : startPlyPreview(
            canvas,
            asset.blob,
            asset.name,
            backgroundRef.current,
            callbacks,
            signal,
          );
    }

    void start
      .then((runtime) => {
        if (signal.aborted) runtime.dispose();
        else {
          runtimeRef.current = runtime;
          runtime.setBackground(backgroundRef.current);
          runtime.setLodErrorTarget(lodErrorTargetRef.current);
        }
      })
      .catch((reason: unknown) => {
        if (!signal.aborted) setError(errorMessage(reason));
      });

    return () => {
      controller.abort();
      if (errorTimeout !== undefined) clearTimeout(errorTimeout);
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, [asset, isComparison]);

  useEffect(() => {
    const background = darkBackground
      ? DARK_PREVIEW_BACKGROUND
      : LIGHT_PREVIEW_BACKGROUND;
    backgroundRef.current = background;
    runtimeRef.current?.setBackground(background);
  }, [darkBackground]);

  useEffect(() => {
    const errorTarget = lodPositionToErrorTarget(lodPosition);
    lodErrorTargetRef.current = errorTarget;
    runtimeRef.current?.setLodErrorTarget(errorTarget);
  }, [lodPosition]);

  return (
    <div
      className="preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
      >
        <header className="preview-header">
          <div className="preview-header-copy">
            <span>
              {asset.mode === "convert"
                ? "3D TILES PREVIEW"
                : isComparison
                  ? "ORIGINAL ↔ SIMPLIFIED"
                  : "SPARK PLY PREVIEW"}
            </span>
            <h2 id="preview-title">
              {isComparison && asset.source
                ? `${asset.source.name} ↔ ${asset.name}`
                : asset.name}
            </h2>
          </div>
          <div className="preview-header-actions">
            <label className="toggle preview-background-toggle">
              <input
                type="checkbox"
                checked={darkBackground}
                onChange={(event) => setDarkBackground(event.target.checked)}
                aria-label="Use dark preview background"
              />
              <span aria-hidden="true" />
              <strong>Dark background</strong>
            </label>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close preview">
              Close <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        <div
          className={`preview-viewport${isComparison ? " is-comparison" : ""}${darkBackground ? " is-dark" : ""}`}
        >
          {isComparison && asset.source ? (
            <div ref={comparisonStageRef} className="preview-comparison-stage">
              <canvas
                ref={simplifiedCanvasRef}
                className="preview-comparison-canvas preview-comparison-simplified"
                aria-label={`Simplified result: ${asset.name}`}
              />
              <canvas
                ref={originalCanvasRef}
                className="preview-comparison-canvas preview-comparison-original"
                style={{ clipPath: `inset(0 ${100 - comparisonPosition}% 0 0)` }}
                aria-label={`Original input: ${asset.source.name}`}
              />
              <div
                ref={comparisonInteractionRef}
                className="preview-comparison-interaction"
                aria-hidden="true"
              />
              <span className="preview-comparison-label is-original">
                Original
                {asset.source.splatCount !== undefined
                  ? ` · ${asset.source.splatCount.toLocaleString()} splats`
                  : ""}
              </span>
              <span className="preview-comparison-label is-simplified">
                Simplified
                {asset.splatCount !== undefined
                  ? ` · ${asset.splatCount.toLocaleString()} splats`
                  : ""}
              </span>
              <div
                className={`preview-comparison-divider${comparisonDragging ? " is-dragging" : ""}`}
                style={{ left: `${comparisonPosition}%` }}
                role="slider"
                tabIndex={0}
                aria-label="Original and simplified comparison divider"
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(comparisonPosition)}
                aria-valuetext={`${Math.round(comparisonPosition)}% original, ${Math.round(100 - comparisonPosition)}% simplified`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setComparisonDragging(true);
                  updateComparisonPosition(event.clientX);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  updateComparisonPosition(event.clientX);
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  setComparisonDragging(false);
                }}
                onPointerCancel={(event) => {
                  event.stopPropagation();
                  setComparisonDragging(false);
                }}
                onLostPointerCapture={() => setComparisonDragging(false)}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 10 : 2;
                  let next = comparisonPosition;
                  if (event.key === "ArrowLeft") next -= step;
                  else if (event.key === "ArrowRight") next += step;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = 100;
                  else return;
                  event.preventDefault();
                  setComparisonPosition(Math.max(0, Math.min(100, next)));
                }}
              >
                <span className="preview-comparison-grip" aria-hidden="true" />
              </div>
            </div>
          ) : (
            <canvas ref={canvasRef} aria-label={`Interactive preview of ${asset.name}`} />
          )}

          <div className="preview-instructions">
            Left-drag to orbit · right-drag or Shift-drag to pan · scroll to zoom
          </div>

          <div className={`preview-status${error ? " is-error" : ""}`} role="status">
            <span aria-hidden="true" />
            {error || status}
          </div>

          <div
            className={`preview-toolbar${asset.mode === "simplify" ? " is-camera-only" : ""}`}
          >
            {asset.mode === "convert" && (
              <label className="lod-control">
                <span className="lod-control-header">
                  <strong>LOD</strong>
                  <output aria-label="Splats currently displayed">
                    {visibleSplatCount === null
                      ? "Visible splats · —"
                      : `Visible splats · ${visibleSplatCount.toLocaleString()}`}
                  </output>
                </span>
                <input
                  type="range"
                  min={MIN_LOD_POSITION}
                  max={MAX_LOD_POSITION}
                  step={LOD_POSITION_STEP}
                  value={lodPosition}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    lodErrorTargetRef.current = lodPositionToErrorTarget(next);
                    setLodPosition(next);
                  }}
                  aria-label="3D Tiles level of detail"
                  aria-valuetext={`Error target ${lodPositionToErrorTarget(lodPosition)}`}
                />
                <span className="lod-control-scale" aria-hidden="true">
                  <span>Low</span>
                  <span>High</span>
                </span>
              </label>
            )}
            <button type="button" onClick={() => runtimeRef.current?.frameContent()}>
              Reset camera
            </button>
          </div>

          {asset.mode === "convert" ? (
            <aside className="inspector-notice">
              <div>
                <strong>Need to adjust, crop, or place the tileset?</strong>
                <span>Download it and continue in 3DTiles Inspector.</span>
              </div>
              <a
                href="https://github.com/WilliamLiu-1997/3DTiles-Inspector"
                target="_blank"
                rel="noreferrer"
              >
                Open Inspector <span aria-hidden="true">↗</span>
              </a>
            </aside>
          ) : (
            <aside className="spark-notice">
              {isComparison
                ? "Original on the left · simplified result on the right"
                : "Simplified PLY rendered locally with Spark and the shared CameraController."}
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
