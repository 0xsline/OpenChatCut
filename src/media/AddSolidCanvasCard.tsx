import { Icon } from '../components/icons';

interface AddSolidCanvasCardProps {
  label: string;
  onAdd: () => void;
}

export function AddSolidCanvasCard({ label, onAdd }: AddSolidCanvasCardProps) {
  return (
    <button
      type="button"
      className="cc-add-solid-canvas-card"
      aria-label={label}
      title={label}
      onClick={onAdd}
    >
      <span className="cc-media-entry-thumb cc-add-solid-canvas-thumb">
        <Icon name="image" size={20} strokeWidth={1.4} />
      </span>
      <span className="cc-media-entry-name">{label}</span>
    </button>
  );
}
