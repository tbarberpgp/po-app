import { useEffect, useRef, useState } from "react";

/**
 * A finger / mouse signature pad. Calls `onChange` with a PNG data-URL when the
 * stroke ends (or null when cleared). Used by the public site sign-in and the
 * delivery sign-off.
 */
export function SignaturePad({ onChange, height = 170 }: { onChange: (dataUrl: string | null) => void; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const hadInk = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  function pos(e: React.PointerEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function down(e: React.PointerEvent) {
    e.preventDefault();
    canvasRef.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  }
  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current!.x, last.current!.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!hadInk.current) { hadInk.current = true; setHasInk(true); }
  }
  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    onChange(hadInk.current ? canvasRef.current!.toDataURL("image/png") : null);
  }
  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    hadInk.current = false;
    setHasInk(false);
    onChange(null);
  }

  return (
    <div className="sigpad-wrap">
      <canvas
        ref={canvasRef}
        className="sigpad"
        style={{ height }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <div className="sigpad-foot">
        <span className="muted" style={{ fontSize: 12 }}>{hasInk ? "Signature captured" : "Sign above with your finger"}</span>
        <button type="button" className="ghost tiny" onClick={clear} disabled={!hasInk}>Clear</button>
      </div>
    </div>
  );
}
