export interface PropSpec {
  key: string;
  type: string;
  defaultValue: unknown;
  /** Optional display label (falls back to key). */
  label?: string;
  /** For type=select: option values or {label,value} rows. */
  options?: Array<string | { label: string; value: string }>;
  /** For type=number: soft range hints. */
  min?: number;
  max?: number;
  step?: number;
}

export interface Tpl {
  id: string;
  name: string;
  category: string;
  /** Optional template-level description. */
  description?: string;
  /** Optional catalog tags. */
  tags?: string[];
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props: Record<string, unknown>;
  propSchema: PropSpec[];
  thumb: string | null;
  code: string;
}
