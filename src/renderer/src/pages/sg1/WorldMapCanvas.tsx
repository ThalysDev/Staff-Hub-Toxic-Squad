import { useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { TribeMarking, WorldVillage } from '@shared/types';

/**
 * Mapa do mundo (SG_1 — painel wars). Aldeias pintadas por marcação da tribo,
 * destaques em branco, pan (arrastar) e zoom (roda do mouse ou botões).
 * Performance: as ~40k aldeias são pré-renderizadas UMA vez num canvas offscreen
 * por nível de zoom (potência de 2, até 8 px/campo) e o frame visível é copiado
 * com drawImage — pan/zoom não redesenham aldeia por aldeia.
 */

interface WorldMapCanvasProps {
  villages: readonly WorldVillage[];
  /** allyId → marcação (cor). Aldeias sem tribo usam marrom claro sempre. */
  markings: ReadonlyMap<number, TribeMarking>;
  /** Coordenadas destacadas no formato "x|y". */
  highlights: ReadonlySet<string>;
}

export const MARKING_COLORS: Record<TribeMarking, string> = {
  Marrom: '#8a6d5a',
  Azul: '#2f6db3',
  'Azul Ally': '#57a7d4',
  Vermelho: '#c0392b',
};

export const MARKING_OPTIONS: readonly TribeMarking[] = ['Marrom', 'Azul', 'Azul Ally', 'Vermelho'];

const COLOR_NO_TRIBE = '#d3bc9c'; // marrom claro — aldeia bárbara/sem tribo
const BG = '#f0e6cf';
const GRID_LINE = '#ddccaa';
const GRID_LABEL = '#b0a17f';
const WORLD_SIZE = 1000;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 30;
/** 8 px/campo = canvas offscreen de 8000x8000 — teto aceitável de memória. */
const MAX_LEVEL = 8;

/** O WorldVillage do contrato não expõe allyId; o dump do main pode trazer. */
type WorldVillageWithAlly = WorldVillage & { allyId?: number };

function levelFor(zoom: number): number {
  let level = 1;
  while (level < zoom && level < MAX_LEVEL) level *= 2;
  return level;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function WorldMapCanvas({ villages, markings, highlights }: WorldMapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layers = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const villagesRef = useRef(villages);
  const markingsRef = useRef(markings);
  const viewRef = useRef({ x: 0, y: 0 }); // canto superior visível, em campos
  const zoomRef = useRef(1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const initialisedRef = useRef(false);
  const dragRef = useRef<{ px: number; py: number; active: boolean }>({ px: 0, py: 0, active: false });
  const redrawQueued = useRef(false);

  const [zoom, setZoom] = useState(1);

  // Re-render das camadas sempre que os dados do mundo mudam.
  useEffect(() => {
    villagesRef.current = villages;
    layers.current.clear();
  }, [villages]);
  useEffect(() => {
    markingsRef.current = markings;
    layers.current.clear();
  }, [markings]);

  const highlightsByCoord = useMemo(() => {
    const map = new Map<number, { x: number; y: number }>();
    for (const key of highlights) {
      const [xText, yText] = key.split('|');
      if (xText === undefined || yText === undefined) continue;
      const x = Number(xText);
      const y = Number(yText);
      if (Number.isInteger(x) && Number.isInteger(y)) map.set(x * 1000 + y, { x, y });
    }
    return map;
  }, [highlights]);

  /** Camada offscreen do nível atual — desenha todas as aldeias uma única vez. */
  function getLayer(level: number): HTMLCanvasElement {
    const cached = layers.current.get(level);
    if (cached !== undefined) return cached;
    const layer = document.createElement('canvas');
    layer.width = WORLD_SIZE * level;
    layer.height = WORLD_SIZE * level;
    const ctx = layer.getContext('2d');
    if (ctx !== null) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, layer.width, layer.height);
      // Tamanho alvo em tela: 1px no zoom baixo, ~2-3px no alto.
      const targetScreen = zoomRef.current >= 8 ? 2 : 1;
      const size = Math.max(1, Math.round((level * targetScreen) / zoomRef.current));
      for (const village of villagesRef.current) {
        ctx.fillStyle =
          village.playerId === 0
            ? COLOR_NO_TRIBE
            : MARKING_COLORS[markingsRef.current.get((village as WorldVillageWithAlly).allyId ?? -1) ?? 'Marrom'];
        ctx.fillRect(village.x * level, village.y * level, size, size);
      }
    }
    // Mantém só a camada atual em memória (até 8000x8000).
    layers.current.clear();
    layers.current.set(level, layer);
    return layer;
  }

  function clampView(): void {
    const { w, h } = sizeRef.current;
    const view = viewRef.current;
    const z = zoomRef.current;
    view.x = clamp(view.x, -50, WORLD_SIZE - w / z + 50);
    view.y = clamp(view.y, -50, WORLD_SIZE - h / z + 50);
  }

  function draw(): void {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.round(w * dpr);
    const pixelH = Math.round(h * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const z = zoomRef.current;
    const view = viewRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fundo pergaminho.
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    // Camada pré-renderizada do mundo — recorta a região visível (0..1000)².
    const level = levelFor(z);
    const layer = getLayer(level);
    const viewLeft = Math.max(view.x, 0);
    const viewTop = Math.max(view.y, 0);
    const viewRight = Math.min(view.x + w / z, WORLD_SIZE);
    const viewBottom = Math.min(view.y + h / z, WORLD_SIZE);
    if (viewRight > viewLeft && viewBottom > viewTop) {
      const sx = viewLeft * level;
      const sy = viewTop * level;
      const sw = (viewRight - viewLeft) * level;
      const sh = (viewBottom - viewTop) * level;
      ctx.imageSmoothingEnabled = level < z;
      ctx.drawImage(
        layer,
        sx,
        sy,
        sw,
        sh,
        (viewLeft - view.x) * z,
        (viewTop - view.y) * z,
        (viewRight - viewLeft) * z,
        (viewBottom - viewTop) * z,
      );
    }

    // Grade de continentes — linhas a cada 100 campos.
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = Math.ceil(view.x / 100) * 100; gx <= view.x + w / z; gx += 100) {
      const px = Math.round((gx - view.x) * z) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }
    for (let gy = Math.ceil(view.y / 100) * 100; gy <= view.y + h / z; gy += 100) {
      const py = Math.round((gy - view.y) * z) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
    }
    ctx.stroke();

    // Rótulos K no centro de cada quadrante visível.
    ctx.fillStyle = GRID_LABEL;
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const qx0 = Math.floor(view.x / 100);
    const qx1 = Math.floor((view.x + w / z) / 100);
    const qy0 = Math.floor(view.y / 100);
    const qy1 = Math.floor((view.y + h / z) / 100);
    for (let qy = qy0; qy <= qy1; qy++) {
      for (let qx = qx0; qx <= qx1; qx++) {
        const px = (qx * 100 + 50 - view.x) * z;
        const py = (qy * 100 + 50 - view.y) * z;
        ctx.fillText(String(qy * 10 + qx), px, py);
      }
    }

    // Destaques — branco contornado de preto, tamanho razoável em tela.
    const hlSize = Math.min(14, Math.max(5, z * 1.2));
    for (const { x, y } of highlightsByCoord.values()) {
      const px = (x - view.x) * z - hlSize / 2;
      const py = (y - view.y) * z - hlSize / 2;
      if (px + hlSize < 0 || py + hlSize < 0 || px > w || py > h) continue;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#1c1c1c';
      ctx.fillRect(px, py, hlSize, hlSize);
      ctx.strokeRect(px, py, hlSize, hlSize);
    }
  }

  function scheduleDraw(): void {
    if (redrawQueued.current) return;
    redrawQueued.current = true;
    requestAnimationFrame(() => {
      redrawQueued.current = false;
      draw();
    });
  }

  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0) return;
    const rect = canvas.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const next = clamp(zoomRef.current * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === zoomRef.current) return;
    const worldX = viewRef.current.x + cx / zoomRef.current;
    const worldY = viewRef.current.y + cy / zoomRef.current;
    zoomRef.current = next;
    viewRef.current = { x: worldX - cx / next, y: worldY - cy / next };
    clampView();
    setZoom(next);
    draw();
  }

  function zoomAtCenter(factor: number): void {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  // Medição do tamanho + view inicial centralizada.
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas === null ? null : canvas.parentElement;
    if (parent === null) return;
    const measure = (): void => {
      const rect = parent.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      sizeRef.current = { w: rect.width, h: rect.height };
      if (!initialisedRef.current) {
        initialisedRef.current = true;
        viewRef.current = {
          x: WORLD_SIZE / 2 - rect.width / 2 / zoomRef.current,
          y: WORLD_SIZE / 2 - rect.height / 2 / zoomRef.current,
        };
        clampView();
      }
      draw();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw é estável via refs
  }, []);

  // Roda do mouse — listener não-passivo para poder prevenir o scroll.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.25 : 0.8);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomAt usa apenas refs
  }, []);

  // Redesenho quando zoom/marcações/destaques mudam via estado.
  useEffect(() => {
    draw();
  });

  return (
    <div className="sg1-map-block">
      <div className="row sg1-map-tools">
        <div className="sg1-legend" role="group" aria-label="Legenda de cores do mapa">
          {MARKING_OPTIONS.map((marking) => (
            <span className="sg1-legend-item" key={marking}>
              <span
                className="sg1-legend-swatch"
                style={{ background: MARKING_COLORS[marking] }}
                aria-hidden="true"
              />
              {marking}
            </span>
          ))}
          <span className="sg1-legend-item">
            <span className="sg1-legend-swatch" style={{ background: COLOR_NO_TRIBE }} aria-hidden="true" />
            Sem tribo
          </span>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Aproximar mapa"
            onClick={() => zoomAtCenter(1.25)}
          >
            <ZoomIn size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="Afastar mapa"
            onClick={() => zoomAtCenter(0.8)}
          >
            <ZoomOut size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="sg1-map-frame">
        <canvas
          ref={canvasRef}
          className="sg1-map-canvas"
          role="img"
          aria-label="Mapa do mundo do Tribal Wars. Arraste para mover e use a roda do mouse (ou os botões) para dar zoom."
          onPointerDown={(event) => {
            if (event.button !== 0 && event.pointerType === 'mouse') return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { px: event.clientX, py: event.clientY, active: true };
          }}
          onPointerMove={(event) => {
            if (!dragRef.current.active) return;
            const dx = event.clientX - dragRef.current.px;
            const dy = event.clientY - dragRef.current.py;
            dragRef.current.px = event.clientX;
            dragRef.current.py = event.clientY;
            viewRef.current = {
              x: viewRef.current.x - dx / zoomRef.current,
              y: viewRef.current.y - dy / zoomRef.current,
            };
            clampView();
            scheduleDraw();
          }}
          onPointerUp={(event) => {
            dragRef.current.active = false;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragRef.current.active = false;
          }}
        />
      </div>
      <p className="sg1-map-hint">
        Zoom: {zoom.toFixed(1)} px/campo — arraste para navegar, role a roda do mouse para aproximar.
      </p>
    </div>
  );
}