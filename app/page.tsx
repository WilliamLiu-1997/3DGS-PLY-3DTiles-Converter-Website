"use client";

import {
  BrowserConversionError,
  convert,
  simplify,
  type BrowserConvertMetadata,
  type BrowserConvertOptions,
  type BrowserProgressEvent,
  type BrowserSimplifyMetadata,
  type BrowserSimplifyOptions,
  type InputConvention,
} from "3dgs-ply-3dtiles-converter/browser";
import {
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import PreviewDialog, { type PreviewAsset } from "./preview/PreviewDialog";

type Mode = "convert" | "simplify";
type RunState = "idle" | "reading" | "running" | "success" | "error";
type LogLevel = "info" | "success" | "warning" | "error";

type WorkerResult = Partial<BrowserConvertMetadata & BrowserSimplifyMetadata>;

type DownloadResult = PreviewAsset & {
  url: string;
  bytes: number;
  result: WorkerResult;
};

type LogEntry = {
  id: number;
  level: LogLevel;
  message: string;
};

const DEFAULTS = {
  inputConvention: "graphdeco",
  sh: 3,
  opacityFilter: 0.05,
  linearScaleInput: false,
  orientedBoundingBoxes: false,
  coverageBoostScale: 0.75,
  maxLeafLimit: 50000,
  minLeafLimit: "",
  samplingRatePerLevel: 0.5,
  maxDepth: "",
  lodMultiplier: "high",
  minGeometricError: "",
  geometricErrorLayerMultiplier: 1,
  geometricErrorScale: 1,
  colorSpace: "srgb_rec709_display",
  extSplatOpacity: false,
  coordinate: "",
  transform: "",
  targetMode: "ratio",
  ratio: 0.5,
  targetCount: 250000,
};

function formatBytes(bytes: number | null | undefined) {
  if (!Number.isFinite(bytes) || !bytes) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

type PipelineStage = {
  start: number;
  end: number;
  label: string;
};

const CONVERT_PROGRESS_STAGES: Record<string, PipelineStage> = {
  "scan 1/4": { start: 3, end: 4, label: "Parsing Gaussian data" },
  tiling: { start: 4, end: 5, label: "Building LOD tree" },
  partition: { start: 5, end: 35, label: "Partitioning" },
  build: { start: 35, end: 95, label: "Building tiles bottom-up" },
};

const SIMPLIFY_PROGRESS_STAGES: Record<string, PipelineStage> = {
  "simplify scan": { start: 3, end: 4, label: "Parsing Gaussian data" },
  "simplify kd": { start: 4, end: 5, label: "Building KD tree" },
  "simplify partition": { start: 5, end: 35, label: "Partitioning" },
  "simplify reduce": { start: 35, end: 95, label: "Merging and simplifying" },
  "simplify output": { start: 95, end: 99, label: "Writing PLY" },
};

function stageFromPipelineProgress(
  pipelineLabel: string,
  current: number,
  total: number,
  done: boolean,
  status: string,
  mode: Mode,
) {
  const key = pipelineLabel.trim().toLowerCase();
  const config = (mode === "convert" ? CONVERT_PROGRESS_STAGES : SIMPLIFY_PROGRESS_STAGES)[key];
  if (!config) return null;
  const ratio = done
    ? 1
    : Number.isFinite(current) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(1, current / total))
      : 0;
  const writingBuckets = key.includes("partition") &&
    /(?:writ|flush|finish|drain|wait)/i.test(status);
  return {
    progress: config.start + (config.end - config.start) * ratio,
    label: writingBuckets ? "Writing leaf buckets" : config.label,
  };
}

function stageFromMessage(message: string, mode: Mode) {
  const value = message.toLowerCase();
  if (value.includes("packing generated")) return { progress: 98, label: "Creating ZIP" };
  if (value.includes("simplify total done") || value.includes("total done")) {
    return { progress: mode === "convert" ? 97 : 99, label: "Finalizing output" };
  }
  if (value.includes("simplify output")) return { progress: 95, label: "Writing PLY" };
  if (value.includes("write_tileset done")) return { progress: 96, label: "Writing tileset metadata" };
  if (value.includes("build_tiles done")) return { progress: 95, label: "Finalizing tiles" };
  if (value.includes("building tiles bottom-up")) {
    return { progress: 35, label: "Building tiles bottom-up" };
  }
  if (value.includes("simplify reduce") || value.includes("reduced")) {
    return { progress: 35, label: "Merging and simplifying" };
  }
  if (value.includes("partition done") || value.includes("scan 4/4")) {
    return { progress: 35, label: mode === "convert" ? "Preparing tile content" : "Partition complete" };
  }
  if (value.includes("partition")) {
    return { progress: 5, label: "Partitioning" };
  }
  if (value.includes("tiling_tree done")) {
    return { progress: 5, label: "Preparing leaf partitions" };
  }
  if (value.includes("scan 2/4")) return { progress: 4, label: "Building LOD tree" };
  if (value.includes("simplify kd") || value.includes("building from memory")) {
    return { progress: 4, label: mode === "convert" ? "Building LOD tree" : "Building KD tree" };
  }
  if (value.includes("scan_positions done") || value.includes("[simplify scan]")) {
    return { progress: 4, label: "Preparing spatial tree" };
  }
  if (value.includes("scan 1/4") || value.includes("staging positions")) {
    return { progress: 3, label: "Parsing Gaussian data" };
  }
  if (value.includes("header done") || value.includes("scanning ply header")) {
    return { progress: 3, label: "Reading PLY header" };
  }
  return null;
}

function normalizeLogLevel(level: string): LogLevel {
  const value = level.toLowerCase();
  if (value === "error") return "error";
  if (value === "warning" || value === "warn") return "warning";
  if (value === "success" || value === "ok") return "success";
  return "info";
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("simplify");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [settings, setSettings] = useState(DEFAULTS);
  const [runState, setRunState] = useState<RunState>("idle");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("Waiting for a file");
  const [memoryBytes, setMemoryBytes] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [download, setDownload] = useState<DownloadResult | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const taskAbortRef = useRef<AbortController | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const logIdRef = useRef(0);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const logFollowRef = useRef(true);
  const logOpenedRef = useRef(false);

  const busy = runState === "reading" || runState === "running";

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      setElapsed(performance.now() - startedAtRef.current);
    }, 200);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    return () => {
      taskAbortRef.current?.abort();
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!logFollowRef.current) return;
    const element = logScrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs]);

  const addLog = (level: LogLevel, message: string) => {
    setLogs((current) => [
      ...current.slice(-79),
      { id: ++logIdRef.current, level, message },
    ]);
  };

  const resetLogs = () => {
    logFollowRef.current = true;
    logOpenedRef.current = false;
    setLogs([]);
  };

  const selectFile = (next: File | null) => {
    if (busy || !next) return;
    if (!/\.ply$/i.test(next.name)) {
      setError({ message: "Choose a Gaussian Splatting file with a .ply extension." });
      setRunState("error");
      return;
    }
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    setPreviewOpen(false);
    setDownload(null);
    setError(null);
    setFile(next);
    setRunState("idle");
    setProgress(0);
    setStage("Ready");
    resetLogs();
    setMemoryBytes(0);
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    selectFile(event.target.files?.[0] || null);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0] || null);
  };

  const update = <K extends keyof typeof DEFAULTS>(key: K, value: (typeof DEFAULTS)[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const parsedCoordinate = useMemo<[number, number, number] | null | undefined>(() => {
    if (!settings.coordinate.trim()) return null;
    const values = settings.coordinate.split(",").map((part) => Number(part.trim()));
    return values.length === 3 && values.every(Number.isFinite)
      ? [values[0], values[1], values[2]]
      : undefined;
  }, [settings.coordinate]);

  const parsedTransform = useMemo<
    NonNullable<BrowserConvertOptions["transform"]> | null | undefined
  >(() => {
    if (!settings.transform.trim()) return null;
    try {
      const value = JSON.parse(settings.transform);
      const flatMatrix =
        Array.isArray(value) &&
        value.length === 16 &&
        value.every((entry) => !Array.isArray(entry) && Number.isFinite(Number(entry)));
      const nestedMatrix =
        Array.isArray(value) &&
        value.length === 4 &&
        value.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 4 &&
            row.every((entry) => Number.isFinite(Number(entry))),
        );
      if (flatMatrix) return value.map((entry: unknown) => Number(entry));
      if (nestedMatrix) {
        return value.map((row: unknown[]) => row.map((entry) => Number(entry)));
      }
      return undefined;
    } catch {
      return undefined;
    }
  }, [settings.transform]);

  const buildCommonOptions = () => ({
    inputConvention: settings.inputConvention as InputConvention,
    sh: settings.sh as 0 | 1 | 2 | 3,
    opacityFilter: settings.opacityFilter,
    linearScaleInput: settings.linearScaleInput,
    orientedBoundingBoxes: settings.orientedBoundingBoxes,
    coverageBoostScale: settings.coverageBoostScale,
  });

  const buildSimplifyOptions = (): BrowserSimplifyOptions => ({
    ...buildCommonOptions(),
    ...(settings.targetMode === "ratio"
      ? { ratio: settings.ratio }
      : { targetCount: settings.targetCount }),
  });

  const buildConvertOptions = (): BrowserConvertOptions => ({
    ...buildCommonOptions(),
    maxLeafLimit: settings.maxLeafLimit,
    samplingRatePerLevel: settings.samplingRatePerLevel,
    lodMultiplier: settings.lodMultiplier as NonNullable<BrowserConvertOptions["lodMultiplier"]>,
    colorSpace: settings.colorSpace as NonNullable<BrowserConvertOptions["colorSpace"]>,
    extSplatOpacity: settings.extSplatOpacity,
    ...(settings.maxDepth.trim() ? { maxDepth: Number(settings.maxDepth) } : {}),
    ...(settings.minLeafLimit.trim() ? { minLeafLimit: Number(settings.minLeafLimit) } : {}),
    ...(settings.minGeometricError.trim()
      ? { minGeometricError: Number(settings.minGeometricError) }
      : {}),
    geometricErrorLayerMultiplier: settings.geometricErrorLayerMultiplier,
    geometricErrorScale: settings.geometricErrorScale,
    ...(parsedCoordinate ? { coordinate: parsedCoordinate } : {}),
    ...(parsedTransform ? { transform: parsedTransform } : {}),
  });

  const fail = (message: string, detail?: string) => {
    taskAbortRef.current?.abort();
    taskAbortRef.current = null;
    setRunState("error");
    setStage("Task failed");
    setError({ message, detail });
    addLog("error", detail || message);
  };

  const run = async () => {
    if (!file || busy) return;

    if (!Number.isFinite(settings.opacityFilter) || settings.opacityFilter < 0 || settings.opacityFilter > 1) {
      fail("Opacity filter must be between 0 and 1.");
      return;
    }
    if (!Number.isFinite(settings.coverageBoostScale) || settings.coverageBoostScale < 0) {
      fail("Coverage boost must be greater than or equal to 0.");
      return;
    }

    if (mode === "simplify") {
      if (settings.targetMode === "ratio" &&
        (!Number.isFinite(settings.ratio) || settings.ratio <= 0 || settings.ratio > 1)) {
        fail("Retained ratio must be greater than 0 and less than or equal to 1.");
        return;
      }
      if (settings.targetMode === "count" &&
        (!Number.isInteger(settings.targetCount) || settings.targetCount < 1)) {
        fail("Target splat count must be an integer greater than or equal to 1.");
        return;
      }
    }

    if (mode === "convert") {
      if (settings.coordinate.trim() && parsedCoordinate === undefined) {
        fail("Invalid coordinate format.", "Enter lat, lon, height, for example: 31.2304, 121.4737, 30");
        return;
      }
      if (settings.transform.trim() && parsedTransform === undefined) {
        fail(
          "Invalid transform matrix.",
          "Enter a JSON 4×4 matrix or a flat JSON array containing 16 numbers.",
        );
        return;
      }
      if (settings.coordinate.trim() && settings.transform.trim()) {
        fail("Choose either a WGS84 coordinate or a transform matrix, not both.");
        return;
      }
      if (settings.maxDepth.trim() && (!Number.isInteger(Number(settings.maxDepth)) || Number(settings.maxDepth) < 0)) {
        fail("Maximum depth must be an integer greater than or equal to 0, or left blank for automatic selection.");
        return;
      }
      if (settings.minLeafLimit.trim() && (!Number.isInteger(Number(settings.minLeafLimit)) || Number(settings.minLeafLimit) < 1)) {
        fail("Minimum leaf limit must be an integer greater than or equal to 1, or left blank for automatic selection.");
        return;
      }
      if (!Number.isInteger(settings.maxLeafLimit) || settings.maxLeafLimit < 1) {
        fail("Maximum leaf limit must be an integer greater than or equal to 1.");
        return;
      }
      if (!Number.isFinite(settings.samplingRatePerLevel) || settings.samplingRatePerLevel <= 0 || settings.samplingRatePerLevel > 1) {
        fail("Sampling per level must be greater than 0 and less than or equal to 1.");
        return;
      }
      if (settings.minGeometricError.trim() && (!Number.isFinite(Number(settings.minGeometricError)) || Number(settings.minGeometricError) < 0)) {
        fail("Minimum geometric error must be greater than or equal to 0, or left blank for automatic selection.");
        return;
      }
      if (!Number.isFinite(settings.geometricErrorLayerMultiplier) || settings.geometricErrorLayerMultiplier <= 0) {
        fail("Geometric-error layer multiplier must be greater than 0.");
        return;
      }
      if (!Number.isFinite(settings.geometricErrorScale) || settings.geometricErrorScale <= 0) {
        fail("Geometric-error scale must be greater than 0.");
        return;
      }
    }

    taskAbortRef.current?.abort();
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
    setPreviewOpen(false);
    setDownload(null);
    setError(null);
    resetLogs();
    setMemoryBytes(0);
    setElapsed(0);
    setProgress(1);
    setStage("Loading local file");
    setRunState("reading");
    startedAtRef.current = performance.now();
    const taskController = new AbortController();
    taskAbortRef.current = taskController;

    const onProgress = (event: BrowserProgressEvent) => {
      if (taskAbortRef.current !== taskController) return;

      if (event.type === "input") {
        const ratio = event.totalBytes > 0
          ? Math.max(0, Math.min(1, event.loadedBytes / event.totalBytes))
          : 0;
        setRunState("reading");
        setProgress(Math.max(1, 1 + ratio));
        setStage(ratio >= 1 ? "Starting browser worker" : "Loading local file");
        setMemoryBytes(event.memoryBytes);
        return;
      }

      if (event.type === "started") {
        setRunState("running");
        setProgress((current) => Math.max(current, 2));
        setStage("Processing");
        setMemoryBytes(event.memoryBytes || file.size);
        addLog("info", `loaded ${file.name} · ${formatBytes(file.size)}`);
        return;
      }

      if (event.type === "log") {
        addLog(normalizeLogLevel(event.level), event.message || "processing");
        if (Number.isFinite(event.memoryBytes)) setMemoryBytes(event.memoryBytes || 0);
        const nextStage = stageFromMessage(event.message, mode);
        if (nextStage) {
          setProgress((current) => Math.max(current, nextStage.progress));
          setStage(nextStage.label);
        }
        return;
      }

      if (event.type === "pipeline") {
        setMemoryBytes(event.memoryBytes);
        const nextStage = stageFromPipelineProgress(
          event.label,
          event.current,
          event.total,
          event.done,
          event.status,
          mode,
        );
        if (nextStage) {
          setProgress((current) => Math.max(current, nextStage.progress));
          setStage(nextStage.label);
        }
      }
    };

    try {
      const controls = {
        fileName: file.name,
        signal: taskController.signal,
        onProgress,
      };
      const output = mode === "convert"
        ? await convert(file, buildConvertOptions(), controls)
        : await simplify(file, buildSimplifyOptions(), controls);

      if (taskAbortRef.current !== taskController) return;
      taskAbortRef.current = null;
      const url = URL.createObjectURL(output.blob);
      downloadUrlRef.current = url;
      setDownload({
        mode,
        name: output.outputName,
        url,
        blob: output.blob,
        splatCount: output.result.splatCount,
        source: mode === "simplify"
          ? {
              name: file.name,
              blob: file,
              splatCount: "sourceSplatCount" in output.result
                ? output.result.sourceSplatCount
                : undefined,
              convention: settings.inputConvention === "khr_native"
                ? "khr_native"
                : "graphdeco",
              scaleEncoding: settings.linearScaleInput ? "linear" : "log",
            }
          : undefined,
        bytes: output.outputBytes,
        result: output.result,
      });
      setRunState("success");
      setProgress(100);
      setStage(mode === "convert" ? "3D Tiles complete" : "Simplified PLY complete");
      setMemoryBytes(0);
      setElapsed(performance.now() - startedAtRef.current);
      addLog("success", `completed ${output.outputName}`);
    } catch (err) {
      if (taskAbortRef.current !== taskController) return;
      taskAbortRef.current = null;
      const detail = err instanceof Error ? err.message : String(err);
      const errorName = err instanceof Error ? err.name : "";
      if (taskController.signal.aborted || errorName === "AbortError") return;

      if (err instanceof BrowserConversionError && err.code === "INPUT_READ_FAILED") {
        fail(
          "The browser could not read the selected file.",
          err.detail || "Re-select the file and make sure it has not been moved, replaced, disconnected, or locked by another application.",
        );
        return;
      }
      if (
        (err instanceof BrowserConversionError && err.code === "MEMORY_EXHAUSTED") ||
        err instanceof RangeError ||
        /(?:out of memory|allocation failed|array buffer|typed array|invalid array length)/i.test(detail)
      ) {
        fail(
          "The browser could not allocate enough memory for this file.",
          `${file.name} is ${formatBytes(file.size)}. Close other tabs or use the CLI for this job.`,
        );
        return;
      }
      if (err instanceof BrowserConversionError) {
        fail(err.message, err.detail);
        return;
      }
      fail("Browser conversion failed.", detail);
    }
  };

  const cancel = () => {
    const controller = taskAbortRef.current;
    taskAbortRef.current = null;
    controller?.abort();
    setPreviewOpen(false);
    setRunState("idle");
    setProgress(0);
    setStage("Task cancelled");
    setMemoryBytes(0);
    addLog("warning", "task cancelled by user");
  };

  const resultCount = download?.result.splatCount ?? download?.result.validSplatCount;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="3DGS Converter home">
          <span className="brand-mark" aria-hidden="true">3D</span>
          <span>
            <strong>3DGS Converter</strong>
            <small>Runs in your browser</small>
          </span>
        </a>
        <div className="privacy-badge">
          <span className="status-dot" />
          Local processing · No uploads
        </div>
      </header>

      <aside className="cli-banner" aria-label="Browser memory limit">
        <div className="cli-banner-copy">
          <strong>Browser memory limit</strong>
          <span>
            Browser file size is limited by available memory. For large
            conversion or simplification jobs, use the CLI tool.{" "}
            <a
              href="https://github.com/WilliamLiu-1997/3DGS-PLY-3DTiles-Converter"
              target="_blank"
              rel="noreferrer"
              className="cli-inline-link"
            >
              3DGS-PLY-3DTiles-Converter ↗
            </a>
          </span>
        </div>
      </aside>

      <section className="hero" id="top">
        <div className="hero-copy">
          <h1>{mode === "convert" ? "PLY to 3D Tiles" : "Simplify PLY"}</h1>
          <p className="lede">
            {mode === "convert"
              ? "Convert a Gaussian Splatting PLY into a downloadable 3D Tiles ZIP."
              : "Reduce a Gaussian Splatting PLY by retained ratio or target splat count."}
            {" "}Your file stays in this browser tab and is never uploaded.
          </p>
        </div>
      </section>

      <section className="workspace" aria-label="Converter workspace">
        <div className="mode-tabs" role="tablist" aria-label="Choose a task">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "simplify"}
            className={mode === "simplify" ? "active" : ""}
            disabled={busy}
            onClick={() => setMode("simplify")}
          >
            <span>01</span> Simplify PLY
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "convert"}
            className={mode === "convert" ? "active" : ""}
            disabled={busy}
            onClick={() => setMode("convert")}
          >
            <span>02</span> Convert to 3D Tiles
          </button>
        </div>

        <div className="workspace-grid">
          <div className="input-column">
            <div
              className={`dropzone ${dragging ? "dragging" : ""} ${file ? "has-file" : ""}`}
              onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={onDrop}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".ply"
                onChange={onFileInput}
                disabled={busy}
                aria-label="Choose a PLY file"
              />
              <div className="drop-icon" aria-hidden="true">PLY</div>
              {file ? (
                <>
                  <h2>{file.name}</h2>
                  <p>{formatBytes(file.size)} · Local file</p>
                  <button type="button" className="text-button" disabled={busy} onClick={() => inputRef.current?.click()}>
                    Choose another file
                  </button>
                </>
              ) : (
                <>
                  <h2>Drop a Gaussian Splatting PLY</h2>
                  <p>Binary little-endian and ASCII PLY are supported</p>
                  <button type="button" className="select-button" disabled={busy} onClick={() => inputRef.current?.click()}>
                    Choose file <span aria-hidden="true">↗</span>
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="settings-column">
            <div className="panel-heading">
              <div><span>Settings</span><h2>{mode === "convert" ? "Tile build settings" : "Simplify settings"}</h2></div>
              <span className="mode-pill">{mode === "convert" ? "ZIP output" : "PLY output"}</span>
            </div>

            <div className="form-grid">
              <label>
                <span>Input convention</span>
                <select value={settings.inputConvention} disabled={busy} onChange={(e) => update("inputConvention", e.target.value)}>
                  <option value="graphdeco">GraphDECO</option>
                  <option value="khr_native">KHR Native</option>
                </select>
              </label>
              <label>
                <span>Retained SH degree</span>
                <select value={settings.sh} disabled={busy} onChange={(e) => update("sh", Number(e.target.value))}>
                  <option value={0}>SH 0 · Base color only</option>
                  <option value={1}>SH 1</option>
                  <option value={2}>SH 2</option>
                  <option value={3}>SH 3 · Full</option>
                </select>
              </label>
              <label>
                <span>Opacity filter</span>
                <input type="number" min="0" max="1" step="0.01" value={settings.opacityFilter} disabled={busy} onChange={(e) => update("opacityFilter", Number(e.target.value))} />
              </label>
              <label>
                <span>Coverage boost</span>
                <input type="number" min="0" step="0.05" value={settings.coverageBoostScale} disabled={busy} onChange={(e) => update("coverageBoostScale", Number(e.target.value))} />
              </label>

              {mode === "convert" ? (
                <>
                  <label>
                    <span>Max splats per leaf</span>
                    <input type="number" min="1000" step="1000" value={settings.maxLeafLimit} disabled={busy} onChange={(e) => update("maxLeafLimit", Number(e.target.value))} />
                  </label>
                  <label>
                    <span>Min splats per leaf</span>
                    <input type="number" min="1" step="100" placeholder="Automatic" value={settings.minLeafLimit} disabled={busy} onChange={(e) => update("minLeafLimit", e.target.value)} />
                  </label>
                  <label>
                    <span>Sampling per level</span>
                    <input type="number" min="0.01" max="1" step="0.05" value={settings.samplingRatePerLevel} disabled={busy} onChange={(e) => update("samplingRatePerLevel", Number(e.target.value))} />
                  </label>
                  <label>
                    <span>Maximum depth</span>
                    <input type="number" min="0" step="1" placeholder="Automatic" value={settings.maxDepth} disabled={busy} onChange={(e) => update("maxDepth", e.target.value)} />
                  </label>
                  <label>
                    <span>LOD multiplier</span>
                    <select value={settings.lodMultiplier} disabled={busy} onChange={(e) => update("lodMultiplier", e.target.value)}>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="xhigh">Extra High</option>
                      <option value="max">Max</option>
                    </select>
                  </label>
                  <label>
                    <span>Color space</span>
                    <select value={settings.colorSpace} disabled={busy} onChange={(e) => update("colorSpace", e.target.value)}>
                      <option value="srgb_rec709_display">sRGB Rec.709 display</option>
                      <option value="lin_rec709_display">Linear Rec.709 display</option>
                    </select>
                  </label>
                  <div className="form-section-label wide-field">Geometric error</div>
                  <label>
                    <span>Minimum geometric error</span>
                    <input type="number" min="0" step="0.01" placeholder="Automatic" value={settings.minGeometricError} disabled={busy} onChange={(e) => update("minGeometricError", e.target.value)} />
                  </label>
                  <label>
                    <span>Geometric-error layer multiplier</span>
                    <input type="number" min="0.01" step="0.05" value={settings.geometricErrorLayerMultiplier} disabled={busy} onChange={(e) => update("geometricErrorLayerMultiplier", Number(e.target.value))} />
                  </label>
                  <label>
                    <span>Geometric-error scale</span>
                    <input type="number" min="0.01" step="0.05" value={settings.geometricErrorScale} disabled={busy} onChange={(e) => update("geometricErrorScale", Number(e.target.value))} />
                  </label>
                  <div className="form-section-label wide-field">Placement</div>
                  <label className="wide-field">
                    <span>WGS84 placement coordinate (optional)</span>
                    <input type="text" placeholder="lat, lon, height" value={settings.coordinate} disabled={busy || Boolean(settings.transform.trim())} onChange={(e) => update("coordinate", e.target.value)} />
                  </label>
                  <label className="wide-field">
                    <span>Root transform matrix (optional)</span>
                    <textarea
                      rows={3}
                      placeholder="[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]"
                      value={settings.transform}
                      disabled={busy || Boolean(settings.coordinate.trim())}
                      onChange={(e) => update("transform", e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    <span>Target method</span>
                    <select value={settings.targetMode} disabled={busy} onChange={(e) => update("targetMode", e.target.value)}>
                      <option value="ratio">Retained ratio</option>
                      <option value="count">Target count</option>
                    </select>
                  </label>
                  {settings.targetMode === "ratio" ? (
                    <label>
                      <span>Retained ratio</span>
                      <input type="number" min="0.01" max="1" step="0.05" value={settings.ratio} disabled={busy} onChange={(e) => update("ratio", Number(e.target.value))} />
                    </label>
                  ) : (
                    <label>
                      <span>Target splat count</span>
                      <input type="number" min="1" step="1000" value={settings.targetCount} disabled={busy} onChange={(e) => update("targetCount", Number(e.target.value))} />
                    </label>
                  )}
                </>
              )}
            </div>

            {mode === "convert" && (
              <section className={`experimental-option${settings.extSplatOpacity ? " is-enabled" : ""}`}>
                <div className="experimental-copy">
                  <div className="experimental-heading">
                    <span>Experimental</span>
                    <h3>EXT splat opacity</h3>
                  </div>
                  <p>
                    Adds <code>EXT_splat_opacity</code> data for merged splats with
                    opacity beyond the standard SPZ range.
                  </p>
                  <p className="experimental-support">
                    Currently supported only by the{" "}
                    <a
                      href="https://github.com/WilliamLiu-1997/3D-Tiles-RendererJS-3DGS-Plugin"
                      target="_blank"
                      rel="noreferrer"
                    >
                      3D Tiles RendererJS 3DGS Plugin ↗
                    </a>
                    . Other viewers ignore the extension and use the standard SPZ data.
                  </p>
                </div>
                <label className="toggle experimental-toggle">
                  <input
                    type="checkbox"
                    checked={settings.extSplatOpacity}
                    disabled={busy}
                    onChange={(e) => update("extSplatOpacity", e.target.checked)}
                  />
                  <span aria-hidden="true" />
                  <strong>{settings.extSplatOpacity ? "Enabled" : "Enable"}</strong>
                </label>
              </section>
            )}

            <div className="toggle-row">
              <label className="toggle">
                <input type="checkbox" checked={settings.linearScaleInput} disabled={busy} onChange={(e) => update("linearScaleInput", e.target.checked)} />
                <span aria-hidden="true" />
                Linear scale input
              </label>
              <label className="toggle">
                <input type="checkbox" checked={settings.orientedBoundingBoxes} disabled={busy} onChange={(e) => update("orientedBoundingBoxes", e.target.checked)} />
                <span aria-hidden="true" />
                Use OBB
              </label>
            </div>

            <div className="action-row">
              <div className="action-copy">
                <strong>{file ? formatBytes(file.size) : "No file selected"}</strong>
                <span>{mode === "convert" ? "Outputs a 3D Tiles ZIP" : "Outputs one binary PLY"}</span>
              </div>
              {busy ? (
                <button type="button" className="cancel-button" onClick={cancel}>Cancel</button>
              ) : (
                <button type="button" className="run-button" disabled={!file} onClick={run}>
                  {mode === "convert" ? "Convert" : "Simplify"} <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {(runState !== "idle" || logs.length > 0) && (
        <section className={`run-panel state-${runState}`} aria-live="polite">
          <div className="run-summary">
            <div className="progress-orbit" style={{ "--progress": `${progress * 3.6}deg` } as CSSProperties}>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="run-title">
              <span>{runState === "success" ? "COMPLETE" : runState === "error" ? "STOPPED" : "PROCESSING"}</span>
              <h2>{stage}</h2>
              <p>{file?.name}</p>
            </div>
            <dl className="run-metrics">
              <div><dt>Elapsed</dt><dd>{formatDuration(elapsed)}</dd></div>
              <div><dt>Workspace data</dt><dd>{memoryBytes ? formatBytes(memoryBytes) : "Released"}</dd></div>
              <div><dt>Runtime</dt><dd>Browser Worker</dd></div>
            </dl>
          </div>

          <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>

          {error && (
            <div className="error-box" role="alert">
              <strong>{error.message}</strong>
              {error.detail && <p>{error.detail}</p>}
              <button type="button" onClick={() => { setRunState("idle"); setError(null); setProgress(0); }}>Back to settings</button>
            </div>
          )}

          {download && (
            <div className="result-box">
              <div className="result-icon" aria-hidden="true">✓</div>
              <div>
                <strong>{download.name}</strong>
                <p>
                  {formatBytes(download.bytes)}
                  {resultCount ? ` · ${resultCount.toLocaleString()} splats` : ""}
                  {download.result.nodeCount ? ` · ${download.result.nodeCount.toLocaleString()} tiles` : ""}
                </p>
              </div>
              <div className="result-actions">
                <button type="button" className="preview-button" onClick={() => setPreviewOpen(true)}>
                  {download.mode === "simplify" ? "Compare" : "Preview"}{" "}
                  <span aria-hidden="true">↗</span>
                </button>
                <a href={download.url} download={download.name}>Download <span aria-hidden="true">↓</span></a>
              </div>
            </div>
          )}

          <details
            className="log-view"
            open={runState === "error"}
            onToggle={(event) => {
              if (!event.currentTarget.open) return;
              const firstOpen = !logOpenedRef.current;
              logOpenedRef.current = true;
              if (firstOpen) logFollowRef.current = true;
              if (!logFollowRef.current) return;
              window.requestAnimationFrame(() => {
                const element = logScrollRef.current;
                if (element) element.scrollTop = element.scrollHeight;
              });
            }}
          >
            <summary>Processing log <span>{logs.length} entries</span></summary>
            <div
              ref={logScrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const distanceFromBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight;
                logFollowRef.current = distanceFromBottom <= 8;
              }}
            >
              {logs.map((entry) => (
                <p key={entry.id} className={`log-${entry.level}`}>
                  <span>{String(entry.id).padStart(2, "0")}</span>{entry.message}
                </p>
              ))}
            </div>
          </details>
        </section>
      )}

      <footer>
        <p>3DGS PLY → 3D Tiles Converter</p>
        <span>Model data exists only for the lifetime of this page.</span>
      </footer>

      {previewOpen && download && (
        <PreviewDialog asset={download} onClose={() => setPreviewOpen(false)} />
      )}
    </main>
  );
}
