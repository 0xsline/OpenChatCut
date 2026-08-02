export function MenuDrillHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <button type="button" className="cc-menu-drill-header" aria-label={`返回${title}`} onClick={onBack}>
      <span aria-hidden>‹</span>
      <span>{title}</span>
    </button>
  );
}
