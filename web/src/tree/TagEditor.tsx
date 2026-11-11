// <TagEditor>: the tags of one object across dimensions — one multi-select per dimension in use, plus "Tilføj tags fra"
// for another tree. The value is node ids from any dimension (your private tree included).
import { useEffect, useState } from "react";
import { metaApi, type MetaDimension } from "./api";
import { TreeSelect } from "./TreeSelect";
import "./tree.css";

export type TagEditorProps = {
  value: number[];
  onChange: (ids: number[]) => void;
  label?: string;
  allowCreate?: boolean;
  disabled?: boolean;
};

export function TagEditor({ value, onChange, label = "Tags", allowCreate = true, disabled }: TagEditorProps) {
  const [dims, setDims] = useState<MetaDimension[]>([]);
  const [dimOf, setDimOf] = useState<Map<number, string>>(new Map());
  const [extra, setExtra] = useState<string[]>([]);

  useEffect(() => {
    metaApi.dimensions().then(setDims, () => setDims([]));
  }, []);

  // Which dimension each tag belongs to (ids may come from a saved object).
  useEffect(() => {
    const missing = value.filter((i) => !dimOf.has(i));
    if (!missing.length) return;
    metaApi.resolve(missing).then((nodes) => {
      setDimOf((old) => {
        const next = new Map(old);
        for (const n of nodes) next.set(n.id, n.dimension);
        return next;
      });
    }, () => undefined);
  }, [value, dimOf]);

  const used = new Set<string>([...value.map((i) => dimOf.get(i)).filter((d): d is string => !!d), ...extra]);
  const shown = dims.filter((d) => used.has(d.slug));
  const rest = dims.filter((d) => !used.has(d.slug));

  const change = (dim: string, ids: number[]) => {
    setDimOf((old) => {
      const next = new Map(old);
      for (const i of ids) next.set(i, dim);
      return next;
    });
    onChange([...value.filter((i) => dimOf.get(i) !== dim), ...ids]);
  };

  return (
    <fieldset className="tr-tags" disabled={disabled}>
      <legend className="tr-labeltext">{label}</legend>
      {shown.map((d) => (
        <TreeSelect
          key={d.slug}
          dimension={d.slug}
          multiple
          cascade="node"
          label={d.label}
          value={value.filter((i) => dimOf.get(i) === d.slug)}
          onChange={(ids) => change(d.slug, ids)}
          allowCreate={allowCreate}
          disabled={disabled}
        />
      ))}
      {shown.length === 0 && <p className="tr-hinttext">Ingen tags endnu. Vælg et træ nedenfor.</p>}
      {rest.length > 0 && !disabled && (
        <label className="tr-create-parent" style={{ padding: 0 }}>
          <span>Tilføj tags fra</span>
          <select value="" onChange={(e) => e.target.value && setExtra((x) => [...x, e.target.value])}>
            <option value="">Vælg et træ …</option>
            {rest.map((d) => (
              <option key={d.slug} value={d.slug}>{d.label}{d.private ? " (kun dig)" : ""}</option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}

/** The tags of an object as chips: "Organisation · Drift › Support". */
export function TagChips({ nodes, onRemove }: { nodes: { id: number; label: string; dimension_label?: string; color?: string | null; trail?: { label: string }[]; private?: boolean }[]; onRemove?: (id: number) => void }) {
  return (
    <span className="tr-values" style={{ minHeight: 0 }}>
      {nodes.map((n) => (
        <span key={n.id} className="tr-chip" title={[n.dimension_label, ...(n.trail ?? []).map((t) => t.label), n.label].filter(Boolean).join(" › ")}>
          <span className="tr-dot" style={{ background: n.color ?? (n.private ? "#4b5262" : "#94a3b8") }} aria-hidden="true" />
          {n.trail?.length ? <span className="tr-chip-ctx">{n.trail[n.trail.length - 1].label} ›</span> : null}
          <b>{n.label}</b>
          {onRemove ? (
            <button type="button" className="tr-x" aria-label={`Fjern ${n.label}`} onClick={() => onRemove(n.id)}>×</button>
          ) : (
            <span style={{ width: 6 }} />
          )}
        </span>
      ))}
    </span>
  );
}
