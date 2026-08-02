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
      <Icon name="image" size={21} />
      <span>{label}</span>
    </button>
  );
}
