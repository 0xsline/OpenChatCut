export interface PropSpec {
  key: string;
  type: string;
  defaultValue: unknown;
}

export interface Tpl {
  id: string;
  name: string;
  category: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props: Record<string, unknown>;
  propSchema: PropSpec[];
  code: string;
}
